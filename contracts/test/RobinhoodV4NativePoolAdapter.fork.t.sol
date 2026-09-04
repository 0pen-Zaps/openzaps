// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {OpenZapV3} from "../src/v3/OpenZapV3.sol";
import {OpenZapFactoryV3} from "../src/v3/OpenZapFactoryV3.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4NativePoolAdapter} from "../src/adapters/RobinhoodV4NativePoolAdapter.sol";
import {V4PoolPriceSource} from "../src/v3/V4PoolPriceSource.sol";
import {V4PoolPriceSourceOriented} from "../src/v3_1/V4PoolPriceSourceOriented.sol";
import {OpenZapV3_1} from "../src/v3_1/OpenZapV3_1.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {TriggerIntent} from "../src/v3/libraries/OpenZapV3Types.sol";
import {RecurringRelativeIntent} from "../src/v3_1/libraries/OpenZapV3_1Types.sol";

interface IERC20Fork {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function deposit() external payable;
}

interface IV4QuoterFork {
    struct QuoteExactSingleParams {
        PoolKeyFork poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams calldata params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

struct PoolKeyFork {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev Dress rehearsal for the HOOKR expansion against REAL Robinhood Chain state. Run with:
///        RUN_ROBINHOOD_FORK=true forge test --match-contract RobinhoodV4NativePoolAdapterForkTest -vv
///
///      Beyond proving the adapter on the live pool, the capsule tests rehearse the EXACT
///      production runbook: they prank the real governance owner into the real, live
///      AdapterRegistry / TokenAllowlist / v3 price-source registry — the same `setAdapter` /
///      `setToken` calls the deploy script will broadcast — and then run capsules created by the
///      LIVE factories. Rerun before broadcasting after ANY change to the adapter or the script.
contract RobinhoodV4NativePoolAdapterForkTest is Test {
    // Live, verified Robinhood Chain addresses (see docs/deployments.md and src/lib/robinhood.ts).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    /// @dev The live registries every deployed lineage shares, and their governance owner.
    address internal constant LIVE_ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant LIVE_TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant LIVE_V3_PRICE_SOURCES = 0xd83a2dedb6185395A1Ac1d0abb9F98472feAd574;
    address internal constant LIVE_V3_1_PRICE_SOURCES = 0x76CB210F25D016078E10DbfCb19AFfBbB4892e33;
    address internal constant GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    /// @dev The live v1.1 one-shot factory, v3 trigger factory, and v3.1 relative-floor factory.
    address internal constant LIVE_V1_1_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    address internal constant LIVE_V3_FACTORY = 0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9;
    address internal constant LIVE_V3_1_FACTORY = 0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1;

    // The HOOKLESS native-ETH/HOOKR pool — the token's only real market.
    uint24 internal constant POOL_FEE = 2500;
    int24 internal constant POOL_TICK_SPACING = 25;
    bytes32 internal constant POOL_ID = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;

    function _forkOrSkip() internal returns (bool) {
        // Report a SKIP, never a PASS: an opt-in test that returns early looks identical to one
        // that ran, which is how a suite ends up green on coverage it never had.
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return false;
        }
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        // Optional block pin (same opt-in the v1.2 gate uses) so a review cannot silently move
        // underneath a rerun. It matters more now that Campaign 2's HookBlocks cranks trade this
        // exact pool one-directionally: an unpinned rerun measures a pool the campaign has been
        // ratcheting since the last one.
        uint256 forkBlock = vm.envOr("ROBINHOOD_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpc);
        } else {
            vm.createSelectFork(rpc, forkBlock);
        }
        return true;
    }

    function _newAdapter() internal returns (RobinhoodV4NativePoolAdapter) {
        return new RobinhoodV4NativePoolAdapter(AEWETH, POOL_MANAGER, HOOKR, POOL_FEE, POOL_TICK_SPACING, POOL_ID);
    }

    function _quote(bool zeroForOne, uint128 amountIn) internal returns (uint256 amountOut) {
        (amountOut,) = IV4QuoterFork(V4_QUOTER)
            .quoteExactInputSingle(
                IV4QuoterFork.QuoteExactSingleParams({
                    poolKey: PoolKeyFork({
                        currency0: address(0),
                        currency1: HOOKR,
                        fee: POOL_FEE,
                        tickSpacing: POOL_TICK_SPACING,
                        hooks: address(0)
                    }),
                    zeroForOne: zeroForOne,
                    exactAmount: amountIn,
                    hookData: ""
                })
            );
    }

    /// @notice Both adapter directions on the real pool, checked against the live quoter.
    function test_adapterRoundTripMatchesLiveQuoter() public {
        if (!_forkOrSkip()) return;
        RobinhoodV4NativePoolAdapter adapter = _newAdapter();
        assertEq(adapter.poolId(), POOL_ID);

        address zap = makeAddr("hookr-fork-zap");
        uint128 amountIn = 0.001 ether;
        vm.deal(zap, 1 ether);
        vm.startPrank(zap);
        IERC20Fork(AEWETH).deposit{value: amountIn}();
        IERC20Fork(AEWETH).approve(address(adapter), amountIn);

        uint256 quotedOut = _quote(true, amountIn);
        (address tokenOut, uint256 bought) = adapter.execute(AEWETH, amountIn, abi.encode(quotedOut));
        assertEq(tokenOut, HOOKR);
        // Same pool, same block, same exact-input mechanics: the measured output IS the quote.
        assertEq(bought, quotedOut);
        assertEq(IERC20Fork(HOOKR).balanceOf(zap), bought);

        // Round-trip: sell everything back. The quote is refreshed because the buy moved the pool.
        IERC20Fork(HOOKR).approve(address(adapter), bought);
        uint256 quotedBack = _quote(false, uint128(bought));
        (address tokenBack, uint256 sold) = adapter.execute(HOOKR, bought, abi.encode(quotedBack));
        vm.stopPrank();
        assertEq(tokenBack, AEWETH);
        assertEq(sold, quotedBack);
        // Two swaps' worth of fees (0.25% LP + the pool's protocol fee, ~0.29% per swap) plus the
        // price impact of our own buy: the round trip must come back slightly short of the input,
        // and nowhere near zero.
        assertLt(sold, amountIn);
        assertGt(sold, (uint256(amountIn) * 98) / 100);

        // Nothing rests in the adapter on any path.
        assertEq(IERC20Fork(AEWETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20Fork(HOOKR).balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
    }

    /// @notice The production one-shot path end to end: governance allowlists (pranked, exactly as
    ///         the deploy script will broadcast), the LIVE v1.1 factory creates the capsule, and an
    ///         owner-signed intent buys HOOKR on the real pool.
    function test_liveFactoryOneShotBuysHookrEndToEnd() public {
        if (!_forkOrSkip()) return;
        RobinhoodV4NativePoolAdapter adapter = _newAdapter();

        // HOOKR is NOT allowlisted today — the reason the app must fail closed until the deploy.
        assertFalse(TokenAllowlist(LIVE_TOKEN_ALLOWLIST).isAllowed(HOOKR));

        vm.startPrank(GOVERNANCE);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(adapter), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(HOOKR, true);
        vm.stopPrank();

        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        uint256 amountIn = 0.0005 ether;

        Step[] memory steps = new Step[](1);
        steps[0] =
            Step({adapter: address(adapter), tokenIn: AEWETH, amountIn: amountIn, spender: address(adapter), data: ""});
        address[] memory trackedAssets = new address[](2);
        trackedAssets[0] = AEWETH;
        trackedAssets[1] = HOOKR;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });

        address zapAddress = OpenZapFactory(LIVE_V1_1_FACTORY).createZap(policy, keccak256("hookr-fork-oneshot"));
        OpenZap zap = OpenZap(payable(zapAddress));

        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        IERC20Fork(AEWETH).deposit{value: amountIn}();
        IERC20Fork(AEWETH).transfer(zapAddress, amountIn);
        vm.stopPrank();

        OpenZapIntent memory intent = OpenZapIntent({
            zap: zapAddress,
            chainId: block.chainid,
            nonce: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: owner,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: HOOKR,
            minOut: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, zap.hashIntent(intent));

        vm.prank(makeAddr("hookr-relayer"));
        zap.execute(intent, abi.encodePacked(r, s, v));

        assertGt(IERC20Fork(HOOKR).balanceOf(owner), 0);
        assertEq(IERC20Fork(AEWETH).balanceOf(zapAddress), 0);
        assertEq(IERC20Fork(AEWETH).allowance(zapAddress, address(adapter)), 0);
        assertEq(IERC20Fork(AEWETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20Fork(HOOKR).balanceOf(address(adapter)), 0);
        assertTrue(zap.nonceUsed(0));
    }

    /// @notice Both HOOKR price-source instances read the live pool and agree with each other.
    function test_priceSourcesReadLiveHookrPool() public {
        if (!_forkOrSkip()) return;
        V4PoolPriceSource trigger = new V4PoolPriceSource(POOL_MANAGER, POOL_ID);
        // currency0 is DECLARED as aeWETH on purpose: the capsule's relative floor measures the
        // ERC-20 it actually spends, and aeWETH wraps native 1:1, so HOOKR-per-ETH is exactly
        // HOOKR-per-aeWETH. See the deploy script for the full rationale.
        V4PoolPriceSourceOriented oriented = new V4PoolPriceSourceOriented(POOL_MANAGER, POOL_ID, AEWETH, HOOKR);

        uint256 price = trigger.priceX96();
        assertGt(price, 0);
        assertEq(oriented.priceX96(), price);
        assertEq(oriented.currency0(), AEWETH);
        assertEq(oriented.currency1(), HOOKR);
    }

    /// @notice The production trigger path end to end: the HOOKR price source registered in the
    ///         LIVE v3 price-source registry (pranked), a capsule created by the LIVE v3 factory,
    ///         and an owner-signed one-sided condition armed by the real pool's spot.
    function test_liveV3TriggerBuysHookrWhenConditionMet() public {
        if (!_forkOrSkip()) return;
        RobinhoodV4NativePoolAdapter adapter = _newAdapter();
        V4PoolPriceSource source = new V4PoolPriceSource(POOL_MANAGER, POOL_ID);

        vm.startPrank(GOVERNANCE);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(adapter), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(HOOKR, true);
        AdapterRegistry(LIVE_V3_PRICE_SOURCES).setAdapter(address(source), true);
        vm.stopPrank();

        uint256 ownerPk = 0xB0B;
        address owner = vm.addr(ownerPk);
        uint256 amountIn = 0.0005 ether;

        Step[] memory steps = new Step[](1);
        steps[0] =
            Step({adapter: address(adapter), tokenIn: AEWETH, amountIn: amountIn, spender: address(adapter), data: ""});
        address[] memory trackedAssets = new address[](2);
        trackedAssets[0] = AEWETH;
        trackedAssets[1] = HOOKR;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });

        address zapAddress = OpenZapFactoryV3(LIVE_V3_FACTORY).createZap(policy, keccak256("hookr-fork-trigger"));
        OpenZapV3 zap = OpenZapV3(payable(zapAddress));

        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        IERC20Fork(AEWETH).deposit{value: amountIn}();
        IERC20Fork(AEWETH).transfer(zapAddress, amountIn);
        vm.stopPrank();

        // "Fire on a rise" with the baseline pinned far below live spot: the condition is already
        // true, so the submission exercises the full arm-check + swap + fee split on real state.
        uint256 spot = source.priceX96();
        TriggerIntent memory intent = TriggerIntent({
            zap: zapAddress,
            chainId: block.chainid,
            nonce: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            priceSource: address(source),
            baselinePriceX96: spot / 2,
            thresholdBps: 100,
            above: true,
            recipient: owner,
            executor: address(0),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: HOOKR,
            minOut: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, zap.hashTriggerIntent(intent));

        vm.prank(makeAddr("hookr-executor"));
        zap.executeTrigger(intent, abi.encodePacked(r, s, v));

        // Owner settled net of the 1% executor-economy fee; nothing rests in the adapter.
        assertGt(IERC20Fork(HOOKR).balanceOf(owner), 0);
        assertEq(IERC20Fork(AEWETH).balanceOf(zapAddress), 0);
        assertEq(IERC20Fork(AEWETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20Fork(HOOKR).balanceOf(address(adapter)), 0);
        assertTrue(zap.nonceUsed(0));
    }

    /// @notice The production DCA path end to end: the ORIENTED HOOKR source (currency0 declared
    ///         as aeWETH) registered in the LIVE v3.1 registry, a capsule created by the LIVE v3.1
    ///         factory, and one due run of an owner-signed relative-floor recurring series. This is
    ///         the test that proves the aeWETH declaration: the capsule derives its input asset
    ///         from the source's currencies and measures that ERC-20's spent balance.
    function test_liveV3_1RelativeRecurringBuysHookr() public {
        if (!_forkOrSkip()) return;
        RobinhoodV4NativePoolAdapter adapter = _newAdapter();
        V4PoolPriceSourceOriented source = new V4PoolPriceSourceOriented(POOL_MANAGER, POOL_ID, AEWETH, HOOKR);

        vm.startPrank(GOVERNANCE);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(adapter), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(HOOKR, true);
        AdapterRegistry(LIVE_V3_1_PRICE_SOURCES).setAdapter(address(source), true);
        vm.stopPrank();

        uint256 ownerPk = 0xCA11;
        address owner = vm.addr(ownerPk);
        uint256 perRun = 0.0005 ether;
        uint32 maxRuns = 2;

        Step[] memory steps = new Step[](1);
        steps[0] =
            Step({adapter: address(adapter), tokenIn: AEWETH, amountIn: perRun, spender: address(adapter), data: ""});
        address[] memory trackedAssets = new address[](2);
        trackedAssets[0] = AEWETH;
        trackedAssets[1] = HOOKR;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });

        address zapAddress = OpenZapFactoryV3(LIVE_V3_1_FACTORY).createZap(policy, keccak256("hookr-fork-dca"));
        OpenZapV3_1 zap = OpenZapV3_1(payable(zapAddress));

        // Fund the whole series up front, exactly as the Automate console requires.
        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        IERC20Fork(AEWETH).deposit{value: perRun * maxRuns}();
        IERC20Fork(AEWETH).transfer(zapAddress, perRun * maxRuns);
        vm.stopPrank();

        RecurringRelativeIntent memory intent = RecurringRelativeIntent({
            zap: zapAddress,
            chainId: block.chainid,
            seriesId: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 30 days),
            interval: 1 days,
            maxRuns: maxRuns,
            recipient: owner,
            executor: address(0),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: HOOKR,
            priceSource: address(source),
            maxSlippageBps: 500
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, zap.hashRecurringRelativeIntent(intent));

        vm.prank(makeAddr("hookr-dca-executor"));
        zap.executeRecurringRelative(intent, abi.encodePacked(r, s, v));

        // Run 1 of 2: the owner holds HOOKR, the capsule still holds run 2's instalment, and the
        // series progressed without consuming the series id.
        assertGt(IERC20Fork(HOOKR).balanceOf(owner), 0);
        assertEq(IERC20Fork(AEWETH).balanceOf(zapAddress), perRun);
        (uint32 runs,) = zap.series(0);
        assertEq(runs, 1);
        assertFalse(zap.nonceUsed(0));
        assertEq(IERC20Fork(AEWETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20Fork(HOOKR).balanceOf(address(adapter)), 0);
    }
}
