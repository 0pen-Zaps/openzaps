// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {OpenZapV3_1} from "../src/v3_1/OpenZapV3_1.sol";
import {OpenZapFactoryV3_1} from "../src/v3_1/OpenZapFactoryV3_1.sol";
import {RecurringRelativeIntent} from "../src/v3_1/libraries/OpenZapV3_1Types.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {Step, Policy} from "../src/libraries/OpenZapTypes.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockZapsBuyAdapter} from "./mocks/MockZapsBuyAdapter.sol";
import {MockOrientedPriceSource} from "./mocks/MockOrientedPriceSource.sol";
import {MockPriceMovingSwapAdapter} from "./mocks/MockPriceMovingSwapAdapter.sol";

/// @dev The v3.1 relative-floor path: identical cadence/nonce/authorization/fee (1% split 80/20) to
///      `executeRecurring`, but the per-run floor is derived from LIVE spot each run instead of a
///      frozen absolute number. `currency0`/`currency1` come from an allowlisted oriented source;
///      `priceX96` is currency1-per-currency0 (Q96). The 1:1 mock swap outputs 100e18 (net 99e18),
///      so at a 1:1 spot (`priceX96 == Q96`) a >=100bps band clears and a spot that says the run
///      should have produced more than it did breaches the floor.
contract OpenZapV3_1RelativeTest is Test {
    bytes32 internal constant RECURRING_RELATIVE_TYPEHASH = keccak256(
        "RecurringRelativeIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant Q96 = 0x1000000000000000000000000;

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    address internal recipient = address(0xBEEF);
    address internal executor = address(0xE44C);
    address internal potGov = address(0x60D5);

    AdapterRegistry internal registry;
    AdapterRegistry internal priceSources;
    TokenAllowlist internal allowlist;
    ZapLotteryPot internal pot;
    OpenZapFactoryV3_1 internal factory;
    MockERC20 internal assetA; // currency0 (think aeWETH)
    MockERC20 internal assetB; // currency1 == pot prize asset ("0xZAPS")
    MockSwapAdapter internal adapter;
    MockZapsBuyAdapter internal buyAdapter;
    MockOrientedPriceSource internal src; // currency0 = assetA, currency1 = assetB

    OpenZapV3_1 internal zapFwd; // spends assetA (currency0), out = assetB  (outAsset == currency1)
    OpenZapV3_1 internal zapRev; // spends assetB (currency1), out = assetA  (outAsset == currency0)

    uint256 internal constant AMOUNT_IN = 100e18;
    uint256 internal constant OUT_PER_RUN = 100e18; // 1:1 mock rate
    uint256 internal constant RUN_FEE = 1e18; // 1% of 100e18
    uint256 internal constant EXECUTOR_CUT = 0.8e18; // 80% of the fee
    uint256 internal constant POT_CUT = 0.2e18; // 20% of the fee
    uint256 internal constant NET_PER_RUN = 99e18;
    uint32 internal constant MAX_RUNS = 3;
    uint64 internal constant INTERVAL = 1 hours;
    uint32 internal constant BAND = 200; // 2% slippage band => floor 98e18 <= net 99e18

    function setUp() public {
        owner = vm.addr(OWNER_PK);

        registry = new AdapterRegistry(address(this));
        priceSources = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));

        assetA = new MockERC20("aeWETH", "aeWETH", 18);
        assetB = new MockERC20("Zaps", "ZAPS", 18);
        allowlist.setToken(address(assetA), true);
        allowlist.setToken(address(assetB), true);

        // One generic swap adapter, funded to pay out in EITHER direction.
        adapter = new MockSwapAdapter();
        registry.setAdapter(address(adapter), true);
        assetA.mint(address(adapter), 1_000_000e18);
        assetB.mint(address(adapter), 1_000_000e18);

        buyAdapter = new MockZapsBuyAdapter(address(assetB), 1e18);
        assetB.mint(address(buyAdapter), 1_000_000e18);

        // Oriented source: priceX96 = currency1 (assetB) per currency0 (assetA).
        src = new MockOrientedPriceSource(address(assetA), address(assetB));
        priceSources.setAdapter(address(src), true);

        pot = new ZapLotteryPot(potGov, address(assetB), address(buyAdapter));
        factory = new OpenZapFactoryV3_1(registry, allowlist, priceSources, pot);
        vm.prank(potGov);
        pot.setFactory(address(factory));

        zapFwd = OpenZapV3_1(payable(factory.createZap(_policy(address(assetA), address(assetB)), bytes32("fwd"))));
        assetA.mint(address(zapFwd), AMOUNT_IN * MAX_RUNS);

        zapRev = OpenZapV3_1(payable(factory.createZap(_policy(address(assetB), address(assetA)), bytes32("rev"))));
        assetB.mint(address(zapRev), AMOUNT_IN * MAX_RUNS);
    }

    // ---- builders ----

    /// @dev A one-step 1:1 swap policy: spend `tokenIn_`, receive `tokenOut_`.
    function _policy(address tokenIn_, address tokenOut_) internal view returns (Policy memory p) {
        address[] memory tracked = new address[](2);
        tracked[0] = tokenIn_;
        tracked[1] = tokenOut_;

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(adapter),
            tokenIn: tokenIn_,
            spender: address(adapter),
            amountIn: AMOUNT_IN,
            data: abi.encode(tokenOut_, uint256(1e18)) // 1:1 rate
        });

        p = Policy({
            owner: owner,
            recipient: recipient,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
    }

    function _rel(OpenZapV3_1 zap_, address outAsset_, uint32 band_)
        internal
        view
        returns (RecurringRelativeIntent memory it)
    {
        it = RecurringRelativeIntent({
            zap: address(zap_),
            chainId: block.chainid,
            seriesId: 11,
            validAfter: 0,
            deadline: uint64(block.timestamp + 30 days),
            interval: INTERVAL,
            maxRuns: MAX_RUNS,
            recipient: recipient,
            executor: address(0),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap_.policyHash(),
            outAsset: outAsset_,
            priceSource: address(src),
            maxSlippageBps: band_
        });
    }

    // ---- EIP-712 (domain version "3.1") ----

    function _domain(address verifyingZap) internal view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("3.1"), block.chainid, verifyingZap));
    }

    function _digest(RecurringRelativeIntent memory it) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECURRING_RELATIVE_TYPEHASH,
                it.zap,
                it.chainId,
                it.seriesId,
                it.validAfter,
                it.deadline,
                it.interval,
                it.maxRuns,
                it.recipient,
                it.executor,
                it.maxGas,
                it.maxFeePerGas,
                it.policyHash,
                it.outAsset,
                it.priceSource,
                it.maxSlippageBps
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domain(it.zap), structHash));
    }

    function _sign(uint256 pk, RecurringRelativeIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(it));
        return abi.encodePacked(r, s, v);
    }

    function _submit(OpenZapV3_1 zap_, RecurringRelativeIntent memory it, address as_) internal {
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(as_);
        zap_.executeRecurringRelative(it, sig);
    }

    // ============================ tests ============================ //

    // ---- happy path: floor from live spot passes ----

    function test_floorFromLiveSpot_passes() public {
        src.setPrice(Q96); // 1:1 spot => expected 100e18, floor (2% band) 98e18 <= net 99e18
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);

        assertEq(assetB.balanceOf(recipient), NET_PER_RUN, "recipient gets net");
        assertEq(assetB.balanceOf(executor), EXECUTOR_CUT, "executor 80% of 1%");
        assertEq(assetB.balanceOf(address(pot)), POT_CUT, "pot 20% of 1%");

        (uint32 runs, uint64 lastRun) = zapFwd.series(it.seriesId);
        assertEq(runs, 1);
        assertEq(lastRun, uint64(block.timestamp));
    }

    /// @dev The exact scenario the design fixes: 0xZAPS appreciated so live spot is LOWER than an old
    ///      absolute floor would have demanded, yet the relative floor tracks spot and the run clears.
    function test_appreciation_dropsFloor_soRunStillClears() public {
        // 0xZAPS appreciated: fewer 0xZAPS per aeWETH => priceX96 falls to 0.98 * Q96.
        src.setPrice((Q96 * 98) / 100); // expected 98e18, floor (2% band) 96.04e18 <= net 99e18
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);
        assertEq(assetB.balanceOf(recipient), NET_PER_RUN, "run clears against the fresh, lower floor");
    }

    // ---- a spot move breaching the band reverts MinOutNotMet ----

    function test_spotMoveBreachingBand_revertsMinOutNotMet() public {
        // Spot says a fair run should yield 105e18, but the pool only produced 100e18 (net 99e18).
        src.setPrice((Q96 * 105) / 100); // expected 105e18, floor (1% band) 103.95e18 > 99e18
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), 100);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.MinOutNotMet.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    function test_floorBoundary_exactNetPasses_oneMoreReverts() public {
        // 100bps band on a 1:1 spot => floor exactly 99e18 == net. Passes at the boundary...
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), 100);
        _submit(zapFwd, it, executor);
        assertEq(assetB.balanceOf(recipient), NET_PER_RUN);

        // ...and a hair tighter (99bps => floor 99.01e18 > net 99e18) reverts.
        RecurringRelativeIntent memory it2 = _rel(zapFwd, address(assetB), 99);
        it2.seriesId = 12;
        bytes memory sig = _sign(OWNER_PK, it2);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.MinOutNotMet.selector);
        zapFwd.executeRecurringRelative(it2, sig);
    }

    // ---- BOTH directions valued correctly ----

    function test_directionA_outIsCurrency1() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);
        assertEq(assetB.balanceOf(recipient), NET_PER_RUN, "buying currency1 with currency0 values right");
    }

    function test_directionB_outIsCurrency0() public {
        // Reverse zap spends assetB (currency1) and produces assetA (currency0).
        // expected = amountIn * 2^96 / priceX96 = 100e18 at 1:1 spot; net 99e18 clears the 2% band.
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapRev, address(assetA), BAND);
        _submit(zapRev, it, executor);

        assertEq(assetA.balanceOf(recipient), NET_PER_RUN, "buying currency0 with currency1 values right");
        assertEq(assetA.balanceOf(executor), EXECUTOR_CUT);
        assertEq(assetA.balanceOf(address(pot)), POT_CUT);
    }

    function test_directionB_breachRevertsToo() public {
        // For the reverse (out == currency0), a LOWER priceX96 means currency1 is worth MORE currency0,
        // so expected currency0 out rises. priceX96 = 0.95*Q96 => expected ~105.26e18, floor(1%)>99e18.
        src.setPrice((Q96 * 95) / 100);
        RecurringRelativeIntent memory it = _rel(zapRev, address(assetA), 100);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.MinOutNotMet.selector);
        zapRev.executeRecurringRelative(it, sig);
    }

    // ---- unlisted price source rejected ----

    function test_unlistedPriceSource_rejected() public {
        MockOrientedPriceSource rogue = new MockOrientedPriceSource(address(assetA), address(assetB));
        rogue.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        it.priceSource = address(rogue);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3_1.PriceSourceNotAllowed.selector, address(rogue)));
        zapFwd.executeRecurringRelative(it, sig);
    }

    // ---- a pair the source cannot value reverts ----

    function test_unvaluablePair_reverts() public {
        // List a source whose currencies are two unrelated tokens; outAsset (assetB) is neither.
        MockOrientedPriceSource wrong = new MockOrientedPriceSource(address(0xAAA1), address(0xAAA2));
        wrong.setPrice(Q96);
        priceSources.setAdapter(address(wrong), true);

        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        it.priceSource = address(wrong);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                OpenZapV3_1.PairNotValuable.selector, address(assetB), address(0xAAA1), address(0xAAA2)
            )
        );
        zapFwd.executeRecurringRelative(it, sig);
    }

    // ---- dead source fails closed ----

    function test_deadPriceSource_failsClosed() public {
        // price never set => the source reverts => no phantom floor.
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(MockOrientedPriceSource.PoolNotInitialized.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    // ---- invalid slippage rejected (fail closed on ambiguity) ----

    function test_slippageAtOrAboveHundredPercent_rejected() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), 10_000); // == BPS
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.InvalidSlippage.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    // ---- signature tamper rejected ----

    function test_tamperedSlippage_failsSignature() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), 100);
        bytes memory sig = _sign(OWNER_PK, it);
        it.maxSlippageBps = 9_000; // executor tries to widen the band the owner signed
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.BadSignature.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    function test_tamperedPriceSource_failsSignature() public {
        MockOrientedPriceSource other = new MockOrientedPriceSource(address(assetA), address(assetB));
        other.setPrice((Q96 * 90) / 100); // a source that would lower the floor
        priceSources.setAdapter(address(other), true);

        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), 100);
        bytes memory sig = _sign(OWNER_PK, it);
        it.priceSource = address(other); // swap in a friendlier source post-signature
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.BadSignature.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    function test_nonOwnerSignature_rejected() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        bytes memory sig = _sign(0xB0B, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.BadSignature.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    // ---- cadence still enforced ----

    function test_secondRunBeforeInterval_reverts() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);

        uint64 nextAt = uint64(block.timestamp) + INTERVAL;
        vm.warp(block.timestamp + INTERVAL - 1);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3_1.IntervalNotElapsed.selector, nextAt));
        zapFwd.executeRecurringRelative(it, sig);
    }

    function test_fullSeries_thenConsumed() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);
        vm.warp(block.timestamp + INTERVAL);
        _submit(zapFwd, it, executor);
        vm.warp(block.timestamp + INTERVAL);
        _submit(zapFwd, it, executor);

        assertEq(assetB.balanceOf(recipient), NET_PER_RUN * 3);
        assertTrue(zapFwd.nonceUsed(it.seriesId), "exhaustion consumes the series id");

        vm.warp(block.timestamp + INTERVAL);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.NonceReplay.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    function test_pinnedExecutor_rejectsOthers() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        it.executor = executor;
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(address(0xBAD));
        vm.expectRevert(OpenZapV3_1.ExecutorMismatch.selector);
        zapFwd.executeRecurringRelative(it, sig);

        _submit(zapFwd, it, executor); // the pinned executor still can
        assertEq(assetB.balanceOf(executor), EXECUTOR_CUT);
    }

    function test_ownerCancelsSeries() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);

        vm.prank(owner);
        zapFwd.invalidateNonce(it.seriesId);

        vm.warp(block.timestamp + INTERVAL);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.NonceReplay.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    // ---- fee split still 80/20 and conserves ----

    function test_feeSplitSumsToOnePercent() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);
        uint256 fee = assetB.balanceOf(executor) + assetB.balanceOf(address(pot));
        assertEq(fee, RUN_FEE, "executor + pot cuts == 1% of output");
        assertEq(assetB.balanceOf(recipient) + fee, OUT_PER_RUN, "nothing minted, nothing stranded");
    }

    function test_potCreditsTicketsToZapOwner() public {
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        _submit(zapFwd, it, executor);
        assertEq(pot.tickets(1, owner), POT_CUT, "tickets accrue to the fee payer (zap owner)");
        assertEq(pot.roundPrize(1), POT_CUT, "outAsset is the prize asset => feeds the prize directly");
    }

    // ---- a floor that rounds to zero fails closed (does NOT disable protection) ----

    function test_floorRoundsToZero_failsClosed() public {
        // priceX96 = 1 wei: expected = mulDiv(100e18, 1, 2^96) = 0 (100e18 << 2^96). A zero floor
        // would pass any nonzero output; instead it must revert FloorUnderflow.
        src.setPrice(1);
        RecurringRelativeIntent memory it = _rel(zapFwd, address(assetB), BAND);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.FloorUnderflow.selector);
        zapFwd.executeRecurringRelative(it, sig);
    }

    // ---- the relative path refuses multi-step policies (unsound input measurement) ----

    function test_multiStepPolicy_rejected() public {
        address[] memory tracked = new address[](2);
        tracked[0] = address(assetA);
        tracked[1] = address(assetB);
        Step[] memory steps = new Step[](2);
        steps[0] = Step({
            adapter: address(adapter),
            tokenIn: address(assetA),
            spender: address(adapter),
            amountIn: AMOUNT_IN,
            data: abi.encode(address(assetB), uint256(1e18))
        });
        steps[1] = Step({
            adapter: address(adapter),
            tokenIn: address(assetA),
            spender: address(adapter),
            amountIn: AMOUNT_IN,
            data: abi.encode(address(assetB), uint256(1e18))
        });
        Policy memory p = Policy({
            owner: owner,
            recipient: recipient,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        OpenZapV3_1 zapMulti = OpenZapV3_1(payable(factory.createZap(p, bytes32("multi"))));
        assetA.mint(address(zapMulti), AMOUNT_IN * 2);

        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapMulti, address(assetB), BAND);
        bytes memory sig = _sign(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3_1.RelativeRequiresSingleStep.selector);
        zapMulti.executeRecurringRelative(it, sig);
    }

    // ---- spot is sampled BEFORE the swap (a post-swap read would use the moved price) ----

    function test_spotSampledBeforeSwap_usesPreSwapPrice() public {
        // A swap adapter that shoves the price source to 105% of spot AS IT SWAPS.
        MockPriceMovingSwapAdapter mover = new MockPriceMovingSwapAdapter();
        registry.setAdapter(address(mover), true);
        assetB.mint(address(mover), 1_000_000e18);

        uint256 postSwapPrice = (Q96 * 105) / 100; // if the capsule read spot AFTER the swap...

        address[] memory tracked = new address[](2);
        tracked[0] = address(assetA);
        tracked[1] = address(assetB);
        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(mover),
            tokenIn: address(assetA),
            spender: address(mover),
            amountIn: AMOUNT_IN,
            data: abi.encode(address(assetB), uint256(1e18), address(src), postSwapPrice)
        });
        Policy memory p = Policy({
            owner: owner,
            recipient: recipient,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        OpenZapV3_1 zapMove = OpenZapV3_1(payable(factory.createZap(p, bytes32("move"))));
        assetA.mint(address(zapMove), AMOUNT_IN);

        // Pre-swap spot is 1:1 (Q96). With a 100bps band the PRE-swap floor is exactly 99e18 == net,
        // so the run clears. A post-swap read (105%) would demand 103.95e18 and revert.
        src.setPrice(Q96);
        RecurringRelativeIntent memory it = _rel(zapMove, address(assetB), 100);

        vm.recordLogs();
        _submit(zapMove, it, executor);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // The run cleared, proving the pre-swap price (not the moved 105%) set the floor.
        assertEq(assetB.balanceOf(recipient), NET_PER_RUN, "cleared against the pre-swap floor");
        // Confirm the side effect actually fired: the source now reports the moved price.
        assertEq(src.priceX96(), postSwapPrice, "adapter moved spot during the swap");

        // Directly assert the emitted priceX96/floor are the PRE-swap values.
        bytes32 topic = keccak256(
            "ExecutedRecurringRelative(uint256,uint32,address,address,uint256,address,uint256,uint256,uint256,uint256)"
        );
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) {
                (
                    uint256 runOut,
                    uint256 priceOut,
                    address outAssetOut,
                    uint256 amountOutOut,
                    uint256 execFeeOut,
                    uint256 potFeeOut,
                    uint256 floorOut
                ) = abi.decode(
                    logs[i].data, (uint256, uint256, address, uint256, uint256, uint256, uint256)
                );
                runOut; // silence unused
                outAssetOut;
                amountOutOut;
                execFeeOut;
                potFeeOut;
                assertEq(priceOut, Q96, "floor used the pre-swap spot, not the moved price");
                assertEq(floorOut, NET_PER_RUN, "floor derived from pre-swap spot (100bps of 100e18)");
                found = true;
            }
        }
        assertTrue(found, "ExecutedRecurringRelative emitted");
    }

    // ---- the three inherited paths are still present (superset sanity) ----

    function test_isSupersetOfV3_hasAllEntrypoints() public view {
        // Selectors exist on the v3.1 capsule (compile-time proof it is a strict superset).
        assertTrue(zapFwd.EXEC_FEE_BPS() == 100 && zapFwd.EXECUTOR_SHARE_BPS() == 8000, "fee constants carried over");
        // hash helpers for every intent kind resolve (would not compile if a path were dropped).
        this._touchSelectors();
    }

    function _touchSelectors() external pure {
        bytes4[4] memory sels = [
            OpenZapV3_1.execute.selector,
            OpenZapV3_1.executeRecurring.selector,
            OpenZapV3_1.executeTrigger.selector,
            OpenZapV3_1.executeRecurringRelative.selector
        ];
        assert(sels[0] != sels[3]);
    }
}
