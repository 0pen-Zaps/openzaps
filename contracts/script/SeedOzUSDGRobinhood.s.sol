// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IOzSeedERC20, IOzSeedPermit2, IOzSeedVault, OzUSDGAtomicSeeder} from "../src/operations/OzUSDGAtomicSeeder.sol";
import {SafeApprove} from "../src/libraries/SafeApprove.sol";

interface IOzSeedV4Quoter {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct QuoteExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

/// @title SeedOzUSDGRobinhood
/// @notice Guarded operator script for the one-time ozUSDG seed on Robinhood Chain.
///
/// @dev Exactly four owner transactions are recorded:
///        1. deploy the compiled, no-admin OzUSDGAtomicSeeder;
///        2. approve exactly 110,000 0xZAPS to that helper;
///        3. approve exactly the pinned 946,460-unit USDG input to that helper; and
///        4. call helper.seed(946_460, fresh one-percent swap floor).
///
///      The fourth transaction rechecks every pin and the empty vault before pulling either token,
///      then makes swap, exact dead-address deposit, share assertion, refunds, and cleanup atomic.
///      Vault-state drift or a direct vault donation before transaction four causes a revert before
///      owner funds move. Extra owner USDG remains untouched, and helper prefunding is refunded.
///      This source reads no private key or mnemonic. A no-broadcast rehearsal is mandatory.
contract SeedOzUSDGRobinhood is Script {
    using SafeApprove for address;

    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 public constant BPS = 10_000;
    uint256 public constant SLIPPAGE_BPS = 100;
    uint256 public constant ZAPS_INPUT = 110_000 ether;
    uint256 public constant OWNER_USDG_INPUT = 946_460;
    uint256 public constant SEED_ASSETS = 1_000_000;

    address public constant OWNER = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public constant ROUTE_ADAPTER = 0x9C3F7F057aC3d2828C7271ba73538B33E32E7a59;
    address public constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address public constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address public constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address public constant OZ_USDG = 0xeAD10C998c59745a030FfAc9209b294C14C7D325;
    address public constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;
    bytes32 public constant V4_QUOTER_RUNTIME_CODEHASH =
        0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6;

    error WrongChain(uint256 actual);
    error WrongOwner(address actual, address expected);
    error MissingCode(address target);
    error CodeHashMismatch(address target, bytes32 actual, bytes32 expected);
    error InsufficientOwnerUsdG(uint256 held, uint256 required);
    error InsufficientZaps(uint256 held, uint256 required);
    error QuoteUnavailable(bytes32 hop);
    error QuoteDoesNotCoverShortfall(uint256 minimumOut, uint256 shortfall, uint256 quotedOut);
    error UnexpectedAllowance(address token, address owner, address spender, uint256 allowance);
    error UnexpectedPermit2Allowance(address owner, address token, address spender, uint160 allowance);
    error VaultNotEmpty(uint256 totalSupply, uint256 totalAssets, uint256 deadShares);
    error HelperCodeHashMismatch(bytes32 actual, bytes32 expected);
    error PostconditionFailed(bytes32 check);

    struct Result {
        OzUSDGAtomicSeeder helper;
        bytes32 helperRuntimeCodeHash;
        uint256 ownerZapsBefore;
        uint256 ownerUsdGBefore;
        uint256 ownerUsdGInput;
        uint256 shortfall;
        uint256 quotedAeweth;
        uint256 quotedUsdG;
        uint256 minimumUsdG;
        OzUSDGAtomicSeeder.Result atomic;
    }

    function run() external returns (Result memory r) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (msg.sender != OWNER) revert WrongOwner(msg.sender, OWNER);

        _requireCode(V4_QUOTER);
        _requireCode(AEWETH);
        _requireCode(ZAPS);
        _requireCode(USDG);
        _requireCode(OZ_USDG);
        _requireCode(ZAPS_HOOK);
        _requireCodeHash(V4_QUOTER, _expectedV4QuoterCodeHash());

        r.ownerZapsBefore = IOzSeedERC20(ZAPS).balanceOf(OWNER);
        if (r.ownerZapsBefore < ZAPS_INPUT) revert InsufficientZaps(r.ownerZapsBefore, ZAPS_INPUT);
        r.ownerUsdGBefore = IOzSeedERC20(USDG).balanceOf(OWNER);
        r.ownerUsdGInput = OWNER_USDG_INPUT;
        if (r.ownerUsdGBefore < r.ownerUsdGInput) {
            revert InsufficientOwnerUsdG(r.ownerUsdGBefore, r.ownerUsdGInput);
        }
        r.shortfall = SEED_ASSETS - r.ownerUsdGInput;

        _assertVaultEmpty();
        _assertLegacyAndRouteAllowancesZero();
        (r.quotedAeweth, r.quotedUsdG) = _freshQuote();
        r.minimumUsdG = (r.quotedUsdG * (BPS - SLIPPAGE_BPS)) / BPS;
        if (r.minimumUsdG < r.shortfall) {
            revert QuoteDoesNotCoverShortfall(r.minimumUsdG, r.shortfall, r.quotedUsdG);
        }

        _startOwnerBroadcast();

        r.helper = _deployHelper();
        r.helperRuntimeCodeHash = address(r.helper).codehash;
        bytes32 expectedHelperCodeHash = _expectedHelperRuntimeCodeHash();
        if (r.helperRuntimeCodeHash != expectedHelperCodeHash) {
            revert HelperCodeHashMismatch(r.helperRuntimeCodeHash, expectedHelperCodeHash);
        }
        if (r.helper.seeded()) revert PostconditionFailed("HELPER_PREVIOUSLY_SEEDED");

        ZAPS.approveExact(address(r.helper), ZAPS_INPUT);
        USDG.approveExact(address(r.helper), r.ownerUsdGInput);
        r.atomic = r.helper.seed(r.ownerUsdGInput, r.minimumUsdG);

        _stopOwnerBroadcast();

        if (!r.helper.seeded()) revert PostconditionFailed("HELPER_NOT_SEEDED");
        if (address(r.helper).codehash != expectedHelperCodeHash) {
            revert PostconditionFailed("HELPER_CODEHASH");
        }
        _requireAllowance(ZAPS, OWNER, address(r.helper), 0);
        _requireAllowance(USDG, OWNER, address(r.helper), 0);
        _requireHelperBalanceZero(r.helper, ZAPS);
        _requireHelperBalanceZero(r.helper, AEWETH);
        _requireHelperBalanceZero(r.helper, USDG);
        _requireHelperBalanceZero(r.helper, OZ_USDG);

        if (IOzSeedVault(OZ_USDG).totalAssets() != SEED_ASSETS) {
            revert PostconditionFailed("VAULT_TOTAL_ASSETS");
        }
        if (IOzSeedVault(OZ_USDG).totalSupply() != r.helper.EXPECTED_SEED_SHARES()) {
            revert PostconditionFailed("VAULT_TOTAL_SUPPLY");
        }
        if (IOzSeedVault(OZ_USDG).balanceOf(DEAD) != r.helper.EXPECTED_SEED_SHARES()) {
            revert PostconditionFailed("DEAD_SEED_SHARES");
        }
        if (r.atomic.ownerUsdGInput != r.ownerUsdGInput || r.atomic.shortfall != r.shortfall) {
            revert PostconditionFailed("ATOMIC_INPUTS");
        }
        if (r.atomic.minimumSwapOutput != r.minimumUsdG || r.atomic.measuredSwapOutput < r.minimumUsdG) {
            revert PostconditionFailed("ATOMIC_SWAP");
        }

        _report(r);
    }

    function _freshQuote() internal returns (uint256 quotedAeweth, uint256 quotedUsdG) {
        IOzSeedV4Quoter.PoolKey memory zapsPool = IOzSeedV4Quoter.PoolKey({
            currency0: AEWETH, currency1: ZAPS, fee: 0x800000, tickSpacing: 200, hooks: ZAPS_HOOK
        });
        // The fixed input is far below uint128 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 exactZapsInput = uint128(ZAPS_INPUT);
        (quotedAeweth,) = IOzSeedV4Quoter(V4_QUOTER)
            .quoteExactInputSingle(
                IOzSeedV4Quoter.QuoteExactInputSingleParams({
                    poolKey: zapsPool, zeroForOne: false, exactAmount: exactZapsInput, hookData: ""
                })
            );
        if (quotedAeweth == 0 || quotedAeweth > type(uint128).max) revert QuoteUnavailable("ZAPS_AEWETH");

        IOzSeedV4Quoter.PoolKey memory usdgPool =
            IOzSeedV4Quoter.PoolKey({currency0: AEWETH, currency1: USDG, fee: 450, tickSpacing: 9, hooks: address(0)});
        // The preceding bound check proves the quote fits.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 exactAewethInput = uint128(quotedAeweth);
        (quotedUsdG,) = IOzSeedV4Quoter(V4_QUOTER)
            .quoteExactInputSingle(
                IOzSeedV4Quoter.QuoteExactInputSingleParams({
                    poolKey: usdgPool, zeroForOne: true, exactAmount: exactAewethInput, hookData: ""
                })
            );
        if (quotedUsdG == 0) revert QuoteUnavailable("AEWETH_USDG");
    }

    function _assertVaultEmpty() internal view {
        uint256 supply = IOzSeedVault(OZ_USDG).totalSupply();
        uint256 assets = IOzSeedVault(OZ_USDG).totalAssets();
        uint256 deadShares = IOzSeedVault(OZ_USDG).balanceOf(DEAD);
        if (supply != 0 || assets != 0 || deadShares != 0) {
            revert VaultNotEmpty(supply, assets, deadShares);
        }
    }

    function _assertLegacyAndRouteAllowancesZero() internal view {
        _requireAllowance(ZAPS, OWNER, ROUTE_ADAPTER, 0);
        _requireAllowance(USDG, OWNER, OZ_USDG, 0);
        _requireAllowance(ZAPS, ROUTE_ADAPTER, PERMIT2, 0);
        _requireAllowance(AEWETH, ROUTE_ADAPTER, PERMIT2, 0);
        _requirePermit2Allowance(ROUTE_ADAPTER, ZAPS, UNIVERSAL_ROUTER);
        _requirePermit2Allowance(ROUTE_ADAPTER, AEWETH, UNIVERSAL_ROUTER);
    }

    function _requireAllowance(address token, address allowanceOwner, address spender, uint256 expected) internal view {
        uint256 actual = IOzSeedERC20(token).allowance(allowanceOwner, spender);
        if (actual != expected) revert UnexpectedAllowance(token, allowanceOwner, spender, actual);
    }

    function _requirePermit2Allowance(address allowanceOwner, address token, address spender) internal view {
        (uint160 amount,,) = IOzSeedPermit2(PERMIT2).allowance(allowanceOwner, token, spender);
        if (amount != 0) revert UnexpectedPermit2Allowance(allowanceOwner, token, spender, amount);
    }

    function _requireHelperBalanceZero(OzUSDGAtomicSeeder helper, address token) internal view {
        if (IOzSeedERC20(token).balanceOf(address(helper)) != 0) {
            revert PostconditionFailed("HELPER_TOKEN_BALANCE");
        }
    }

    function _deployHelper() internal virtual returns (OzUSDGAtomicSeeder helper) {
        helper = new OzUSDGAtomicSeeder();
    }

    function _expectedHelperRuntimeCodeHash() internal view virtual returns (bytes32) {
        return keccak256(type(OzUSDGAtomicSeeder).runtimeCode);
    }

    function _expectedV4QuoterCodeHash() internal view virtual returns (bytes32) {
        return V4_QUOTER_RUNTIME_CODEHASH;
    }

    function _startOwnerBroadcast() internal virtual {
        vm.startBroadcast(OWNER);
    }

    function _stopOwnerBroadcast() internal virtual {
        vm.stopBroadcast();
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _requireCodeHash(address target, bytes32 expected) internal view {
        bytes32 actual = target.codehash;
        if (actual != expected) revert CodeHashMismatch(target, actual, expected);
    }

    function _report(Result memory r) internal view {
        console2.log("ozUSDG ATOMIC ONE-TIME SEED / OWNER CONTROLLED");
        console2.log("chainId", block.chainid);
        console2.log("helper", address(r.helper));
        console2.logBytes32(r.helperRuntimeCodeHash);
        console2.log("owner USDG balance before", r.ownerUsdGBefore);
        console2.log("pinned owner USDG input", r.ownerUsdGInput);
        console2.log("fixed shortfall", r.shortfall);
        console2.log("exact 0xZAPS input", ZAPS_INPUT);
        console2.log("fresh aeWETH quote", r.quotedAeweth);
        console2.log("fresh USDG quote", r.quotedUsdG);
        console2.log("one-percent minimum USDG", r.minimumUsdG);
        console2.log("measured swap output", r.atomic.measuredSwapOutput);
        console2.log("seed shares burned to dead", r.atomic.seedShares);
        console2.log("USDG refunded to owner", r.atomic.refundedUsdG);
    }
}
