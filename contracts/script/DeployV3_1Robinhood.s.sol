// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactoryV3_1} from "../src/v3_1/OpenZapFactoryV3_1.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {V4PoolPriceSourceOriented} from "../src/v3_1/V4PoolPriceSourceOriented.sol";

/// @title DeployV3_1Robinhood
/// @notice UNAUDITED CANDIDATE. Deploys the v3.1 relative-floor stack on Robinhood Chain (4663),
///         reusing the live v1.1 AdapterRegistry + TokenAllowlist. v3.1 adds `executeRecurringRelative`
///         (per-run floor computed from spot at execution) on top of everything v3 does.
///
///         It needs its OWN price-source registry, an ORIENTED price source (exposes currency0/1 so
///         the capsule can value either direction), and its OWN ZapLotteryPot (setFactory is
///         one-shot, so a pot cannot back both the v3 and v3.1 factories). It does NOT touch or
///         replace the live v3 factory.
///
///         forge script script/DeployV3_1Robinhood.s.sol --rpc-url $ROBINHOOD_RPC_URL \
///           --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract DeployV3_1Robinhood is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    AdapterRegistry internal constant LIVE_ADAPTERS = AdapterRegistry(0x9E56e444f490C00A6277326A47Cb462E12dF1f17);
    TokenAllowlist internal constant LIVE_TOKENS = TokenAllowlist(0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B);
    address internal constant LIVE_SWAP_ADAPTER = 0x04f62dA4b51a010eFa32aa81569169C47AEd602C;

    // The live aeWETH/0xZAPS v4 pool. currency0 < currency1 by address: aeWETH (0x0Bd7…) is
    // currency0, 0xZAPS (0xDd90…) is currency1, so priceX96 = 0xZAPS per aeWETH.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 internal constant POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // currency0
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07; // currency1

    function run() external {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "wrong chain");
        require(AEWETH < ZAPS, "currency order"); // must match the pool key ordering

        vm.startBroadcast();
        address governance = msg.sender;

        AdapterRegistry priceSources = new AdapterRegistry(governance);
        V4PoolPriceSourceOriented priceSource = new V4PoolPriceSourceOriented(POOL_MANAGER, POOL_ID, AEWETH, ZAPS);
        priceSources.setAdapter(address(priceSource), true);

        ZapLotteryPot pot = new ZapLotteryPot(governance, ZAPS, LIVE_SWAP_ADAPTER);
        OpenZapFactoryV3_1 factory = new OpenZapFactoryV3_1(LIVE_ADAPTERS, LIVE_TOKENS, priceSources, pot);
        pot.setFactory(address(factory));

        vm.stopBroadcast();

        // Prove the oriented source reads the live pool and values both directions before anyone signs.
        uint256 spot = priceSource.priceX96();

        console2.log("governance             ", governance);
        console2.log("priceSources (v3.1)    ", address(priceSources));
        console2.log("orientedPriceSource    ", address(priceSource));
        console2.log("  live priceX96        ", spot);
        console2.log("lotteryPot (v3.1)      ", address(pot));
        console2.log("factoryV3_1            ", address(factory));
        console2.log("implementationV3_1     ", factory.implementation());
        console2.logBytes32(factory.implCodeHash());
    }
}
