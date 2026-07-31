// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SafeApprove} from "../libraries/SafeApprove.sol";

interface IOzSeedERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IOzSeedRegistry {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function isAllowed(address target) external view returns (bool);
}

interface IOzSeedPermit2 {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IOzSeedRouteAdapter {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function universalRouter() external view returns (address);
    function permit2() external view returns (address);
    function route() external view returns (address[] memory);
    function hopCount() external view returns (uint256);
    function hop(uint256 index) external view returns (PoolKey memory);
    function poolId(uint256 index) external view returns (bytes32);
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 amountOut);
}

interface IOzSeedVault {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

/// @title OzUSDGAtomicSeeder
/// @notice One-use, no-admin Robinhood Chain helper that atomically funds and seeds the pinned
///         ozUSDG vault. Configuration is compiled into the runtime: there are no constructor
///         arguments, setters, generic calls, alternate receivers, or recovery authority.
///
/// @dev The owner grants this helper exactly two bounded ERC-20 allowances before calling `seed`:
///      65,000 0xZAPS and the pinned 946,460-unit USDG input. `seed` rechecks every external pin and
///      the empty vault BEFORE either pull. Preexisting balances at this helper (including prefunding
///      of its predicted CREATE address) are snapshotted and excluded from measured deltas; they are
///      refunded only if `seed` succeeds. Never intentionally prefund this no-recovery helper. Once
///      pulls begin, swap, deposit, share assertion, refunds, and allowance cleanup are one
///      transaction: any failure unwinds the entire operation.
contract OzUSDGAtomicSeeder {
    using SafeApprove for address;

    string public constant VERSION = "ozUSDG-atomic-seeder-1";
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 public constant ZAPS_INPUT = 65_000 ether;
    uint256 public constant OWNER_USDG_INPUT = 946_460;
    uint256 public constant SEED_ASSETS = 1_000_000;
    uint256 public constant EXPECTED_SEED_SHARES = 1_000_000_000;

    address public constant OWNER = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public constant ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address public constant TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address public constant ROUTE_ADAPTER = 0x9C3F7F057aC3d2828C7271ba73538B33E32E7a59;
    address public constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address public constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address public constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address public constant OZ_USDG = 0xeAD10C998c59745a030FfAc9209b294C14C7D325;
    address public constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    bytes32 public constant ZAPS_POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;
    bytes32 public constant USDG_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;
    bytes32 public constant ROUTE_ADAPTER_RUNTIME_CODEHASH =
        0xa072ee627b548f6da96b55e2d3730273fe040cf7fa136019223b21a8c87faff4;
    bytes32 public constant OZ_USDG_RUNTIME_CODEHASH =
        0x2b0866418c3563cffc10778552b98eef1d4eb3c3a9a654c32949fb4ce7b13618;

    bool public seeded;
    uint256 private _entered;

    event Seeded(
        address indexed owner,
        uint256 ownerUsdGInput,
        uint256 minimumSwapOutput,
        uint256 measuredSwapOutput,
        uint256 seedAssets,
        uint256 seedShares,
        uint256 refundedUsdG
    );

    error WrongChain(uint256 actual);
    error WrongCaller(address actual, address expected);
    error AlreadySeeded();
    error Reentrancy();
    error MissingCode(address target);
    error CodeHashMismatch(address target, bytes32 actual, bytes32 expected);
    error RegistryOwnerMismatch(address registry, address actual, address expected);
    error RegistryOwnershipTransferPending(address registry, address pendingOwner);
    error AdapterNotAllowed(address adapter);
    error TokenNotAllowed(address token);
    error RoutePinMismatch(bytes32 check);
    error VaultPinMismatch();
    error VaultNotEmpty(uint256 totalSupply, uint256 totalAssets, uint256 deadShares);
    error OwnerBalanceInsufficient(address token, uint256 actual, uint256 required);
    error AllowanceMismatch(address token, address owner, address spender, uint256 actual, uint256 expected);
    error Permit2AllowanceNotZero(address owner, address token, address spender, uint160 amount);
    error InvalidOwnerUsdGInput(uint256 amount);
    error MinimumDoesNotCoverShortfall(uint256 minimumOut, uint256 shortfall);
    error InexactPull(address token, uint256 expected, uint256 actual);
    error SwapResultMismatch(address tokenOut, uint256 reportedOut, uint256 measuredOut);
    error DepositResultMismatch(uint256 shares);
    error ResidualMismatch(address token, uint256 actual, uint256 expected);
    error PostconditionFailed(bytes32 check);

    struct Result {
        uint256 ownerUsdGInput;
        uint256 ownerUsdGBefore;
        uint256 shortfall;
        uint256 minimumSwapOutput;
        uint256 measuredSwapOutput;
        uint256 seedShares;
        uint256 refundedZaps;
        uint256 refundedAeweth;
        uint256 refundedUsdG;
        uint256 refundedOzUsdG;
    }

    struct Snapshots {
        uint256 helperZaps;
        uint256 helperAeweth;
        uint256 helperUsdG;
        uint256 helperOzUsdG;
        uint256 ownerZaps;
        uint256 ownerAeweth;
        uint256 ownerUsdG;
        uint256 ownerOzUsdG;
        uint256 adapterZaps;
        uint256 adapterAeweth;
        uint256 adapterUsdG;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor() {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        _assertExternalPins();
        _assertVaultEmpty();
    }

    function seed(uint256 ownerUsdGInput, uint256 minimumSwapOutput) external nonReentrant returns (Result memory r) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (msg.sender != OWNER) revert WrongCaller(msg.sender, OWNER);
        if (seeded) revert AlreadySeeded();

        r.ownerUsdGInput = ownerUsdGInput;
        r.minimumSwapOutput = minimumSwapOutput;
        r.shortfall = _preflight(ownerUsdGInput, minimumSwapOutput);

        Snapshots memory s = _snapshots();
        r.ownerUsdGBefore = s.ownerUsdG;

        seeded = true;

        _pullExact(USDG, ownerUsdGInput);
        _pullExact(ZAPS, ZAPS_INPUT);
        _requireAllowance(USDG, OWNER, address(this), 0);
        _requireAllowance(ZAPS, OWNER, address(this), 0);

        uint256 usdGBeforeSwap = IOzSeedERC20(USDG).balanceOf(address(this));
        ZAPS.approveExact(ROUTE_ADAPTER, ZAPS_INPUT);
        (address tokenOut, uint256 reportedOut) =
            IOzSeedRouteAdapter(ROUTE_ADAPTER).execute(ZAPS, ZAPS_INPUT, abi.encode(minimumSwapOutput));
        uint256 usdGAfterSwap = IOzSeedERC20(USDG).balanceOf(address(this));
        r.measuredSwapOutput = usdGAfterSwap - usdGBeforeSwap;
        if (tokenOut != USDG || reportedOut != r.measuredSwapOutput || r.measuredSwapOutput < minimumSwapOutput) {
            revert SwapResultMismatch(tokenOut, reportedOut, r.measuredSwapOutput);
        }

        // Recheck at the atomic acceptance point. Even an unexpected side effect from a pinned
        // token or route call cannot turn a formerly empty vault into an accepted seed.
        _assertVaultEmpty();
        USDG.approveExact(OZ_USDG, SEED_ASSETS);
        r.seedShares = IOzSeedVault(OZ_USDG).deposit(SEED_ASSETS, DEAD);
        if (r.seedShares != EXPECTED_SEED_SHARES) revert DepositResultMismatch(r.seedShares);

        _assertSeededVault();
        _assertAdapterBalances(s.adapterZaps, s.adapterAeweth, s.adapterUsdG);
        _assertZeroDownstreamAllowances();

        uint256 expectedUsdGRefund = s.helperUsdG + ownerUsdGInput + r.measuredSwapOutput - SEED_ASSETS;
        _requireBalance(ZAPS, address(this), s.helperZaps);
        _requireBalance(AEWETH, address(this), s.helperAeweth);
        _requireBalance(USDG, address(this), expectedUsdGRefund);
        _requireBalance(OZ_USDG, address(this), s.helperOzUsdG);

        r.refundedZaps = _refundAll(ZAPS);
        r.refundedAeweth = _refundAll(AEWETH);
        r.refundedUsdG = _refundAll(USDG);
        r.refundedOzUsdG = _refundAll(OZ_USDG);

        _assertZeroHelperBalances();
        _assertZeroDownstreamAllowances();
        _assertAdapterBalances(s.adapterZaps, s.adapterAeweth, s.adapterUsdG);
        _assertSeededVault();

        if (IOzSeedERC20(ZAPS).balanceOf(OWNER) != s.ownerZaps - ZAPS_INPUT + r.refundedZaps) {
            revert PostconditionFailed("OWNER_ZAPS_DELTA");
        }
        if (IOzSeedERC20(AEWETH).balanceOf(OWNER) != s.ownerAeweth + r.refundedAeweth) {
            revert PostconditionFailed("OWNER_AEWETH_DELTA");
        }
        if (IOzSeedERC20(USDG).balanceOf(OWNER) != s.ownerUsdG - ownerUsdGInput + r.refundedUsdG) {
            revert PostconditionFailed("OWNER_USDG_REFUND");
        }
        if (IOzSeedERC20(OZ_USDG).balanceOf(OWNER) != s.ownerOzUsdG + r.refundedOzUsdG) {
            revert PostconditionFailed("OWNER_OZ_USDG_REFUND");
        }

        emit Seeded(
            OWNER, ownerUsdGInput, minimumSwapOutput, r.measuredSwapOutput, SEED_ASSETS, r.seedShares, r.refundedUsdG
        );
    }

    function _preflight(uint256 ownerUsdGInput, uint256 minimumSwapOutput) internal view returns (uint256 shortfall) {
        _assertExternalPins();
        _assertVaultEmpty();

        if (ownerUsdGInput != OWNER_USDG_INPUT) {
            revert InvalidOwnerUsdGInput(ownerUsdGInput);
        }
        uint256 ownerUsdGBalance = IOzSeedERC20(USDG).balanceOf(OWNER);
        if (ownerUsdGBalance < ownerUsdGInput) {
            revert OwnerBalanceInsufficient(USDG, ownerUsdGBalance, ownerUsdGInput);
        }
        uint256 ownerZapsBalance = IOzSeedERC20(ZAPS).balanceOf(OWNER);
        if (ownerZapsBalance < ZAPS_INPUT) {
            revert OwnerBalanceInsufficient(ZAPS, ownerZapsBalance, ZAPS_INPUT);
        }

        _requireAllowance(USDG, OWNER, address(this), ownerUsdGInput);
        _requireAllowance(ZAPS, OWNER, address(this), ZAPS_INPUT);
        _assertZeroDownstreamAllowances();

        shortfall = SEED_ASSETS - ownerUsdGInput;
        if (minimumSwapOutput < shortfall) {
            revert MinimumDoesNotCoverShortfall(minimumSwapOutput, shortfall);
        }
    }

    function _assertExternalPins() internal view {
        _assertExternalBehaviorPins();
        _requireCodeHash(ROUTE_ADAPTER, _expectedRouteAdapterCodeHash());
        _requireCodeHash(OZ_USDG, _expectedVaultCodeHash());
    }

    function _assertExternalBehaviorPins() internal view {
        _requireCode(ADAPTER_REGISTRY);
        _requireCode(TOKEN_ALLOWLIST);
        _requireCode(ROUTE_ADAPTER);
        _requireCode(UNIVERSAL_ROUTER);
        _requireCode(PERMIT2);
        _requireCode(AEWETH);
        _requireCode(ZAPS);
        _requireCode(USDG);
        _requireCode(OZ_USDG);
        _requireCode(ZAPS_HOOK);

        _assertRegistryOwner(ADAPTER_REGISTRY);
        _assertRegistryOwner(TOKEN_ALLOWLIST);
        if (!IOzSeedRegistry(ADAPTER_REGISTRY).isAllowed(ROUTE_ADAPTER)) {
            revert AdapterNotAllowed(ROUTE_ADAPTER);
        }
        _requireAllowedToken(AEWETH);
        _requireAllowedToken(ZAPS);
        _requireAllowedToken(USDG);
        _requireAllowedToken(OZ_USDG);
        _assertRoutePins();
    }

    function _assertRegistryOwner(address registry) internal view {
        address actualOwner = IOzSeedRegistry(registry).owner();
        if (actualOwner != OWNER) revert RegistryOwnerMismatch(registry, actualOwner, OWNER);
        address pendingOwner = IOzSeedRegistry(registry).pendingOwner();
        if (pendingOwner != address(0)) revert RegistryOwnershipTransferPending(registry, pendingOwner);
    }

    function _requireAllowedToken(address token) internal view {
        if (!IOzSeedRegistry(TOKEN_ALLOWLIST).isAllowed(token)) revert TokenNotAllowed(token);
    }

    function _assertRoutePins() internal view {
        IOzSeedRouteAdapter adapter = IOzSeedRouteAdapter(ROUTE_ADAPTER);
        if (adapter.universalRouter() != UNIVERSAL_ROUTER) revert RoutePinMismatch("ROUTER");
        if (adapter.permit2() != PERMIT2) revert RoutePinMismatch("PERMIT2");

        address[] memory path = adapter.route();
        if (path.length != 3 || path[0] != ZAPS || path[1] != AEWETH || path[2] != USDG) {
            revert RoutePinMismatch("PATH");
        }
        if (adapter.hopCount() != 2) revert RoutePinMismatch("HOP_COUNT");
        if (adapter.poolId(0) != ZAPS_POOL_ID) revert RoutePinMismatch("ZAPS_POOL_ID");
        if (adapter.poolId(1) != USDG_POOL_ID) revert RoutePinMismatch("USDG_POOL_ID");

        IOzSeedRouteAdapter.PoolKey memory hop0 = adapter.hop(0);
        if (
            hop0.currency0 != AEWETH || hop0.currency1 != ZAPS || hop0.fee != 0x800000 || hop0.tickSpacing != 200
                || hop0.hooks != ZAPS_HOOK
        ) revert RoutePinMismatch("ZAPS_HOP");

        IOzSeedRouteAdapter.PoolKey memory hop1 = adapter.hop(1);
        if (
            hop1.currency0 != AEWETH || hop1.currency1 != USDG || hop1.fee != 450 || hop1.tickSpacing != 9
                || hop1.hooks != address(0)
        ) revert RoutePinMismatch("USDG_HOP");
    }

    function _assertVaultEmpty() internal view {
        IOzSeedVault vault = IOzSeedVault(OZ_USDG);
        if (vault.asset() != USDG || vault.decimals() != 9) revert VaultPinMismatch();
        uint256 supply = vault.totalSupply();
        uint256 assets = vault.totalAssets();
        uint256 deadShares = vault.balanceOf(DEAD);
        if (supply != 0 || assets != 0 || deadShares != 0) {
            revert VaultNotEmpty(supply, assets, deadShares);
        }
    }

    function _assertSeededVault() internal view {
        IOzSeedVault vault = IOzSeedVault(OZ_USDG);
        if (vault.totalAssets() != SEED_ASSETS) revert PostconditionFailed("VAULT_TOTAL_ASSETS");
        if (vault.totalSupply() != EXPECTED_SEED_SHARES) {
            revert PostconditionFailed("VAULT_TOTAL_SUPPLY");
        }
        if (vault.balanceOf(DEAD) != EXPECTED_SEED_SHARES) {
            revert PostconditionFailed("DEAD_SEED_SHARES");
        }
    }

    function _assertZeroHelperBalances() internal view {
        _requireZeroBalance(ZAPS);
        _requireZeroBalance(AEWETH);
        _requireZeroBalance(USDG);
        _requireZeroBalance(OZ_USDG);
    }

    function _requireZeroBalance(address token) internal view {
        uint256 balance = IOzSeedERC20(token).balanceOf(address(this));
        if (balance != 0) revert ResidualMismatch(token, balance, 0);
    }

    function _assertZeroDownstreamAllowances() internal view {
        _requireAllowance(ZAPS, address(this), ROUTE_ADAPTER, 0);
        _requireAllowance(USDG, address(this), OZ_USDG, 0);
        _requireAllowance(ZAPS, ROUTE_ADAPTER, PERMIT2, 0);
        _requireAllowance(AEWETH, ROUTE_ADAPTER, PERMIT2, 0);
        _requireAllowance(ZAPS, address(this), PERMIT2, 0);
        _requireAllowance(AEWETH, address(this), PERMIT2, 0);

        _requirePermit2Allowance(ROUTE_ADAPTER, ZAPS, UNIVERSAL_ROUTER);
        _requirePermit2Allowance(ROUTE_ADAPTER, AEWETH, UNIVERSAL_ROUTER);
        _requirePermit2Allowance(address(this), ZAPS, UNIVERSAL_ROUTER);
        _requirePermit2Allowance(address(this), AEWETH, UNIVERSAL_ROUTER);
    }

    function _requireAllowance(address token, address allowanceOwner, address spender, uint256 expected) internal view {
        uint256 actual = IOzSeedERC20(token).allowance(allowanceOwner, spender);
        if (actual != expected) {
            revert AllowanceMismatch(token, allowanceOwner, spender, actual, expected);
        }
    }

    function _requirePermit2Allowance(address allowanceOwner, address token, address spender) internal view {
        (uint160 amount,,) = IOzSeedPermit2(PERMIT2).allowance(allowanceOwner, token, spender);
        if (amount != 0) revert Permit2AllowanceNotZero(allowanceOwner, token, spender, amount);
    }

    function _pullExact(address token, uint256 amount) internal {
        uint256 beforeBalance = IOzSeedERC20(token).balanceOf(address(this));
        token.safeTransferFrom(OWNER, address(this), amount);
        uint256 received = IOzSeedERC20(token).balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InexactPull(token, amount, received);
    }

    function _refundAll(address token) internal returns (uint256 amount) {
        amount = IOzSeedERC20(token).balanceOf(address(this));
        if (amount != 0) token.safeTransfer(OWNER, amount);
    }

    function _requireBalance(address token, address account, uint256 expected) internal view {
        uint256 actual = IOzSeedERC20(token).balanceOf(account);
        if (actual != expected) revert ResidualMismatch(token, actual, expected);
    }

    function _snapshots() internal view returns (Snapshots memory s) {
        s.helperZaps = IOzSeedERC20(ZAPS).balanceOf(address(this));
        s.helperAeweth = IOzSeedERC20(AEWETH).balanceOf(address(this));
        s.helperUsdG = IOzSeedERC20(USDG).balanceOf(address(this));
        s.helperOzUsdG = IOzSeedERC20(OZ_USDG).balanceOf(address(this));
        s.ownerZaps = IOzSeedERC20(ZAPS).balanceOf(OWNER);
        s.ownerAeweth = IOzSeedERC20(AEWETH).balanceOf(OWNER);
        s.ownerUsdG = IOzSeedERC20(USDG).balanceOf(OWNER);
        s.ownerOzUsdG = IOzSeedERC20(OZ_USDG).balanceOf(OWNER);
        s.adapterZaps = IOzSeedERC20(ZAPS).balanceOf(ROUTE_ADAPTER);
        s.adapterAeweth = IOzSeedERC20(AEWETH).balanceOf(ROUTE_ADAPTER);
        s.adapterUsdG = IOzSeedERC20(USDG).balanceOf(ROUTE_ADAPTER);
    }

    function _assertAdapterBalances(uint256 zapsBefore, uint256 aewethBefore, uint256 usdGBefore) internal view {
        if (IOzSeedERC20(ZAPS).balanceOf(ROUTE_ADAPTER) != zapsBefore) {
            revert PostconditionFailed("ADAPTER_ZAPS_BALANCE");
        }
        if (IOzSeedERC20(AEWETH).balanceOf(ROUTE_ADAPTER) != aewethBefore) {
            revert PostconditionFailed("ADAPTER_AEWETH_BALANCE");
        }
        if (IOzSeedERC20(USDG).balanceOf(ROUTE_ADAPTER) != usdGBefore) {
            revert PostconditionFailed("ADAPTER_USDG_BALANCE");
        }
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _requireCodeHash(address target, bytes32 expected) internal view {
        bytes32 actual = target.codehash;
        if (actual != expected) revert CodeHashMismatch(target, actual, expected);
    }

    function _expectedRouteAdapterCodeHash() internal view virtual returns (bytes32) {
        return ROUTE_ADAPTER_RUNTIME_CODEHASH;
    }

    function _expectedVaultCodeHash() internal view virtual returns (bytes32) {
        return OZ_USDG_RUNTIME_CODEHASH;
    }
}
