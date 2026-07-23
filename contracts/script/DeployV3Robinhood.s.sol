// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactoryV3} from "../src/v3/OpenZapFactoryV3.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {V4PoolPriceSource} from "../src/v3/V4PoolPriceSource.sol";

/// @title DeployV3Robinhood
/// @notice Deploys the v3 execution stack (recurring + trigger + executor economy) on Robinhood
///         Chain (4663), REUSING the live v1.1 AdapterRegistry and TokenAllowlist so the adapter
///         and token governance surface stays single:
///           1. `AdapterRegistry` (fresh instance) as the PRICE SOURCE allowlist,
///           2. `V4PoolPriceSource` pinned to the live aeWETH/0xZAPS v4 pool,
///           3. `ZapLotteryPot` — prize asset 0xZAPS, conversion through the live pinned
///              `RobinhoodV4SwapAdapter`,
///           4. `OpenZapFactoryV3` (which deploys the hardened `OpenZapV3` implementation in its
///              constructor), then wires `pot.setFactory(factory)`.
///
///      Run with the deployer that should hold pot/price-source governance (two-step transfer to a
///      Safe afterwards):
///
///        forge script script/DeployV3Robinhood.s.sol --rpc-url $ROBINHOOD_RPC_URL \
///          --broadcast --private-key $DEPLOYER_PRIVATE_KEY
///
///      This deploys a NEW factory/implementation lineage. It does NOT touch, replace, or orphan
///      the live v1.1 factory or any existing capsule.
contract DeployV3Robinhood is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    // Live v1.1 governance surface (src/lib/robinhood.ts / docs/deployments.md).
    AdapterRegistry internal constant LIVE_ADAPTERS = AdapterRegistry(0x9E56e444f490C00A6277326A47Cb462E12dF1f17);
    TokenAllowlist internal constant LIVE_TOKENS = TokenAllowlist(0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B);
    address internal constant LIVE_SWAP_ADAPTER = 0x04f62dA4b51a010eFa32aa81569169C47AEd602C;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;

    // The live aeWETH/0xZAPS v4 pool (poolId from src/lib/robinhood.ts, PoolManager verified by
    // the ZapRangeVault fork suite).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 internal constant POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;

    function run() external {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "wrong chain");

        vm.startBroadcast();
        address governance = msg.sender;

        AdapterRegistry priceSources = new AdapterRegistry(governance);
        V4PoolPriceSource priceSource = new V4PoolPriceSource(POOL_MANAGER, POOL_ID);
        priceSources.setAdapter(address(priceSource), true);

        ZapLotteryPot pot = new ZapLotteryPot(governance, ZAPS, LIVE_SWAP_ADAPTER);
        OpenZapFactoryV3 factory = new OpenZapFactoryV3(LIVE_ADAPTERS, LIVE_TOKENS, priceSources, pot);
        pot.setFactory(address(factory));

        vm.stopBroadcast();

        // Prove the price source reads the live pool before anyone signs a trigger against it.
        uint256 spot = priceSource.priceX96();

        console2.log("governance          ", governance);
        console2.log("priceSources        ", address(priceSources));
        console2.log("priceSource (pool)  ", address(priceSource));
        console2.log("  live priceX96     ", spot);
        console2.log("lotteryPot          ", address(pot));
        console2.log("factoryV3           ", address(factory));
        console2.log("implementationV3    ", factory.implementation());
        console2.logBytes32(factory.implCodeHash());
    }
}
