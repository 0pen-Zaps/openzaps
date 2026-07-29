// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";
import {OpenZapFactoryV3_2} from "../src/v3_2/OpenZapFactoryV3_2.sol";
import {OpenZapV3_2} from "../src/v3_2/OpenZapV3_2.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {V4PoolPriceSourceOriented} from "../src/v3_1/V4PoolPriceSourceOriented.sol";

/// @title DeployV3_2Robinhood
/// @notice UNAUDITED CANDIDATE. Deploys the isolated v3.2 recurring-stack lineage on Robinhood
///         Chain (4663). It reuses the live v1.1 adapter/token governance surface, while deploying:
///           1. its own price-source AdapterRegistry,
///           2. an oriented source for the live aeWETH/0xZAPS v4 pool,
///           3. its own ZapLotteryPot, and
///           4. OpenZapFactoryV3_2 plus its immutable OpenZapV3_2 implementation.
///
///         Both the stack conversion and pot conversion are pinned to the same live, allowlisted
///         RobinhoodV4SwapAdapter. The v3.2 factory reads those pins back from its own pot, so a
///         mismatched protocol token or conversion adapter cannot enter the implementation.
///
///         The pot is deliberately unique to this factory: `setFactory` is one-shot, and the
///         factory is the only address allowed to register capsules that can credit tickets.
///
///         This script deploys a NEW candidate lineage. It does not replace the live v1.1, v3, or
///         v3.1 factories and it does not mutate either live v1.1 registry.
///
///         Rehearse without `--broadcast` first:
///
///           forge script script/DeployV3_2Robinhood.s.sol:DeployV3_2Robinhood \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com \
///             --sender <deployer-address>
///
///         Broadcast with a Forge signer (`--account`, hardware wallet, or external signer). No key
///         material is read by this script:
///
///           forge script script/DeployV3_2Robinhood.s.sol:DeployV3_2Robinhood \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com \
///             --account <keystore-name> --sender <deployer-address> --broadcast --slow
contract DeployV3_2Robinhood is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    string internal constant EXPECTED_VERSION = "3.2.0-candidate";

    // Live v1.1 governance surface. This deployment reads and reuses it but never mutates it.
    AdapterRegistry internal constant LIVE_ADAPTERS = AdapterRegistry(0x9E56e444f490C00A6277326A47Cb462E12dF1f17);
    TokenAllowlist internal constant LIVE_TOKENS = TokenAllowlist(0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B);
    RobinhoodV4SwapAdapter internal constant LIVE_SWAP_ADAPTER =
        RobinhoodV4SwapAdapter(0x04f62dA4b51a010eFa32aa81569169C47AEd602C);

    // Live aeWETH/0xZAPS v4 pool. Pool-key address ordering makes aeWETH currency0 and 0xZAPS
    // currency1, so priceX96 is 0xZAPS per aeWETH.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 internal constant POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;

    error WrongChain(uint256 actual);
    error ZeroDeployer();
    error MissingCode(address target);
    error LiveAdapterRegistryOwnerMismatch(address actual, address expected);
    error LiveAdapterRegistryOwnershipTransferPending(address pendingOwner);
    error LiveTokenAllowlistOwnerMismatch(address actual, address expected);
    error LiveTokenAllowlistOwnershipTransferPending(address pendingOwner);
    error LiveSwapAdapterNotAllowed(address adapter);
    error LiveSwapAdapterPinMismatch();
    error LiveTokenNotAllowed(address token);
    error CurrencyOrderMismatch(address currency0, address currency1);
    error DeploymentAssertionFailed();

    struct Deployed {
        AdapterRegistry priceSources;
        V4PoolPriceSourceOriented priceSource;
        ZapLotteryPot pot;
        OpenZapFactoryV3_2 factory;
        address implementation;
        uint256 spotPriceX96;
    }

    function run() external returns (Deployed memory d) {
        address governance = msg.sender;
        _preflight(governance);

        vm.startBroadcast();

        d.priceSources = new AdapterRegistry(governance);
        d.priceSource = new V4PoolPriceSourceOriented(POOL_MANAGER, POOL_ID, AEWETH, ZAPS);
        d.priceSources.setAdapter(address(d.priceSource), true);

        d.pot = new ZapLotteryPot(governance, ZAPS, address(LIVE_SWAP_ADAPTER));
        d.factory = new OpenZapFactoryV3_2(LIVE_ADAPTERS, LIVE_TOKENS, d.priceSources, d.pot);
        d.pot.setFactory(address(d.factory));

        vm.stopBroadcast();

        d.implementation = d.factory.implementation();
        d.spotPriceX96 = d.priceSource.priceX96();

        _assertDeployment(governance, d);
        _report(governance, d);
    }

    function _preflight(address governance) internal view {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (governance == address(0)) revert ZeroDeployer();
        if (AEWETH >= ZAPS) revert CurrencyOrderMismatch(AEWETH, ZAPS);

        _requireCode(address(LIVE_ADAPTERS));
        _requireCode(address(LIVE_TOKENS));
        _requireCode(address(LIVE_SWAP_ADAPTER));
        _requireCode(POOL_MANAGER);
        _requireCode(AEWETH);
        _requireCode(ZAPS);

        _assertLiveGovernance(governance);

        if (!LIVE_ADAPTERS.isAllowed(address(LIVE_SWAP_ADAPTER))) {
            revert LiveSwapAdapterNotAllowed(address(LIVE_SWAP_ADAPTER));
        }
        if (
            LIVE_SWAP_ADAPTER.currency0() != AEWETH || LIVE_SWAP_ADAPTER.currency1() != ZAPS
                || LIVE_SWAP_ADAPTER.poolId() != POOL_ID
        ) {
            revert LiveSwapAdapterPinMismatch();
        }
        if (!LIVE_TOKENS.isAllowed(AEWETH)) revert LiveTokenNotAllowed(AEWETH);
        if (!LIVE_TOKENS.isAllowed(ZAPS)) revert LiveTokenNotAllowed(ZAPS);
    }

    function _assertDeployment(address governance, Deployed memory d) internal view {
        _assertLiveGovernance(governance);

        if (
            address(d.priceSources).code.length == 0 || address(d.priceSource).code.length == 0
                || address(d.pot).code.length == 0 || address(d.factory).code.length == 0
                || d.implementation.code.length == 0 || d.spotPriceX96 == 0
        ) revert DeploymentAssertionFailed();

        if (
            d.priceSources.owner() != governance || d.priceSources.pendingOwner() != address(0)
                || !d.priceSources.isAllowed(address(d.priceSource))
        ) revert DeploymentAssertionFailed();

        if (
            d.priceSource.poolManager() != POOL_MANAGER || d.priceSource.poolId() != POOL_ID
                || d.priceSource.currency0() != AEWETH || d.priceSource.currency1() != ZAPS
        ) revert DeploymentAssertionFailed();

        if (
            d.pot.owner() != governance || d.pot.pendingOwner() != address(0) || d.pot.ZAPS() != ZAPS
                || d.pot.BUY_ADAPTER() != address(LIVE_SWAP_ADAPTER) || d.pot.factory() != address(d.factory)
                || d.pot.currentRound() != 1
        ) revert DeploymentAssertionFailed();

        if (
            address(d.factory.adapters()) != address(LIVE_ADAPTERS)
                || address(d.factory.tokens()) != address(LIVE_TOKENS)
                || address(d.factory.priceSources()) != address(d.priceSources)
                || address(d.factory.lotteryPot()) != address(d.pot)
                || d.factory.implCodeHash() != d.implementation.codehash
                || keccak256(bytes(d.factory.VERSION())) != keccak256(bytes(EXPECTED_VERSION))
        ) revert DeploymentAssertionFailed();

        OpenZapV3_2 implementation = OpenZapV3_2(payable(d.implementation));
        if (
            implementation.FACTORY() != address(d.factory)
                || address(implementation.ADAPTERS()) != address(LIVE_ADAPTERS)
                || address(implementation.TOKENS()) != address(LIVE_TOKENS)
                || address(implementation.PRICE_SOURCES()) != address(d.priceSources)
                || implementation.LOTTERY_POT() != address(d.pot) || implementation.ZAPS() != ZAPS
                || implementation.ZAPS_ADAPTER() != address(LIVE_SWAP_ADAPTER)
        ) revert DeploymentAssertionFailed();
    }

    function _assertLiveGovernance(address governance) internal view {
        address adapterRegistryOwner = LIVE_ADAPTERS.owner();
        if (adapterRegistryOwner != governance) {
            revert LiveAdapterRegistryOwnerMismatch(adapterRegistryOwner, governance);
        }
        address adapterRegistryPendingOwner = LIVE_ADAPTERS.pendingOwner();
        if (adapterRegistryPendingOwner != address(0)) {
            revert LiveAdapterRegistryOwnershipTransferPending(adapterRegistryPendingOwner);
        }

        address tokenAllowlistOwner = LIVE_TOKENS.owner();
        if (tokenAllowlistOwner != governance) {
            revert LiveTokenAllowlistOwnerMismatch(tokenAllowlistOwner, governance);
        }
        address tokenAllowlistPendingOwner = LIVE_TOKENS.pendingOwner();
        if (tokenAllowlistPendingOwner != address(0)) {
            revert LiveTokenAllowlistOwnershipTransferPending(tokenAllowlistPendingOwner);
        }
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _report(address governance, Deployed memory d) internal view {
        console2.log("chainId                  ", block.chainid);
        console2.log("governance               ", governance);
        console2.log("liveAdapterRegistry      ", address(LIVE_ADAPTERS));
        console2.log("liveAdapterRegistryOwner ", LIVE_ADAPTERS.owner());
        console2.log("liveAdapterPendingOwner  ", LIVE_ADAPTERS.pendingOwner());
        console2.log("liveTokenAllowlist       ", address(LIVE_TOKENS));
        console2.log("liveTokenAllowlistOwner  ", LIVE_TOKENS.owner());
        console2.log("liveTokenPendingOwner    ", LIVE_TOKENS.pendingOwner());
        console2.log("liveSwapAdapter          ", address(LIVE_SWAP_ADAPTER));
        console2.log("priceSources (v3.2)      ", address(d.priceSources));
        console2.log("orientedPriceSource      ", address(d.priceSource));
        console2.log("  poolManager            ", d.priceSource.poolManager());
        console2.logBytes32(d.priceSource.poolId());
        console2.log("  currency0 (aeWETH)     ", d.priceSource.currency0());
        console2.log("  currency1 (0xZAPS)     ", d.priceSource.currency1());
        console2.log("  live priceX96          ", d.spotPriceX96);
        console2.log("lotteryPot (v3.2)        ", address(d.pot));
        console2.log("  pot factory            ", d.pot.factory());
        console2.log("  pot ZAPS               ", d.pot.ZAPS());
        console2.log("  pot BUY_ADAPTER        ", d.pot.BUY_ADAPTER());
        console2.log("factoryV3_2              ", address(d.factory));
        console2.log("factory version          ", d.factory.VERSION());
        console2.log("implementationV3_2       ", d.implementation);
        console2.log("implementation codehash");
        console2.logBytes32(d.factory.implCodeHash());
        console2.log("deployment assertions    ", "PASS");
    }
}
