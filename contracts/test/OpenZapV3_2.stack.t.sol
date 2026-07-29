// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZapV3_2} from "../src/v3_2/OpenZapV3_2.sol";
import {OpenZapFactoryV3_2} from "../src/v3_2/OpenZapFactoryV3_2.sol";
import {RecurringStackIntent} from "../src/v3_2/libraries/OpenZapV3_2Types.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {Step, Policy} from "../src/libraries/OpenZapTypes.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockZapsBuyAdapter} from "./mocks/MockZapsBuyAdapter.sol";
import {MockOrientedPriceSource} from "./mocks/MockOrientedPriceSource.sol";

/// @dev The v3.2 stacking path. Everything the v3.1 relative path does, plus a signed `stackBps`
///      slice of each run's POST-FEE output converted into 0xZAPS and staked to the pot as the
///      OWNER's tickets.
///
///      Two shapes are covered because they exercise different code:
///        zapFwd — outAsset IS the pot's prize asset (assetB), so there is NO conversion leg and
///                 `stackPriceSource` must be the zero address.
///        zapRev — outAsset is assetA, so the slice is converted assetA -> assetB through the PINNED
///                 adapter and floored against the stack source.
///
///      With a 1:1 mock swap producing 100e18: fee 1e18 (0.8 executor / 0.2 pot), post-fee 99e18,
///      a 500 bps slice is 4.95e18, and the recipient receives 94.05e18.
contract OpenZapV3_2StackTest is Test {
    bytes32 internal constant RECURRING_STACK_TYPEHASH = keccak256(
        "RecurringStackIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps,address stackPriceSource,uint32 stackBps)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant Q96 = 0x1000000000000000000000000;

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    address internal recipient = address(0xBEEF);
    address internal potGov = address(0x60D5);

    AdapterRegistry internal registry;
    AdapterRegistry internal priceSources;
    TokenAllowlist internal allowlist;
    ZapLotteryPot internal pot;
    OpenZapFactoryV3_2 internal factory;
    MockERC20 internal assetA; // currency0 (think aeWETH)
    MockERC20 internal assetB; // currency1 == the pot's prize asset ("0xZAPS")
    MockSwapAdapter internal adapter;
    MockZapsBuyAdapter internal buyAdapter;
    MockOrientedPriceSource internal src;

    OpenZapV3_2 internal zapFwd; // spends assetA, out = assetB (== ZAPS: no conversion leg)
    OpenZapV3_2 internal zapRev; // spends assetB, out = assetA (conversion leg required)

    uint256 internal constant AMOUNT_IN = 100e18;
    uint256 internal constant RUN_FEE = 1e18;
    uint256 internal constant EXECUTOR_CUT = 0.8e18;
    uint256 internal constant POT_CUT = 0.2e18;
    uint256 internal constant POST_FEE = 99e18;
    uint256 internal constant STACK_IN = 4.95e18; // 500 bps of 99e18
    uint256 internal constant TO_RECIPIENT = 94.05e18;
    uint32 internal constant MAX_RUNS = 3;
    uint64 internal constant INTERVAL = 1 hours;
    uint32 internal constant BAND = 200; // 2% — must exceed the 100 bps fee
    uint32 internal constant SLICE = 500; // 5%

    function setUp() public {
        owner = vm.addr(OWNER_PK);

        registry = new AdapterRegistry(address(this));
        priceSources = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));

        assetA = new MockERC20("aeWETH", "aeWETH", 18);
        assetB = new MockERC20("Zaps", "ZAPS", 18);
        allowlist.setToken(address(assetA), true);
        allowlist.setToken(address(assetB), true);

        adapter = new MockSwapAdapter();
        registry.setAdapter(address(adapter), true);
        assetA.mint(address(adapter), 1_000_000e18);
        assetB.mint(address(adapter), 1_000_000e18);

        buyAdapter = new MockZapsBuyAdapter(address(assetB), 1e18);
        registry.setAdapter(address(buyAdapter), true);
        assetB.mint(address(buyAdapter), 1_000_000e18);

        src = new MockOrientedPriceSource(address(assetA), address(assetB));
        src.setPrice(Q96); // 1:1
        priceSources.setAdapter(address(src), true);

        pot = new ZapLotteryPot(potGov, address(assetB), address(buyAdapter));
        factory = new OpenZapFactoryV3_2(registry, allowlist, priceSources, pot);
        vm.prank(potGov);
        pot.setFactory(address(factory));

        zapFwd = OpenZapV3_2(payable(factory.createZap(_policy(address(assetA), address(assetB)), bytes32("fwd"))));
        assetA.mint(address(zapFwd), AMOUNT_IN * MAX_RUNS);

        zapRev = OpenZapV3_2(payable(factory.createZap(_policy(address(assetB), address(assetA)), bytes32("rev"))));
        assetB.mint(address(zapRev), AMOUNT_IN * MAX_RUNS);
    }

    // ---- builders ----

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
            data: abi.encode(tokenOut_, uint256(1e18))
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

    function _stack(OpenZapV3_2 zap_, address outAsset_, address stackSrc_, uint32 band_, uint32 slice_)
        internal
        view
        returns (RecurringStackIntent memory it)
    {
        it = RecurringStackIntent({
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
            maxSlippageBps: band_,
            stackPriceSource: stackSrc_,
            stackBps: slice_
        });
    }

    // ---- EIP-712 (domain version "3.2") ----

    function _domain(address verifyingZap) internal view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("3.2"), block.chainid, verifyingZap));
    }

    /// @dev One place that encodes the 17 signed fields. Both the signer and the digest-equality
    ///      test go through here, so they cannot drift apart from each other — only from the capsule,
    ///      which is exactly what `test_capsuleDigestMatchesTheIndependentlyBuiltOne` checks.
    function _structHash(RecurringStackIntent memory it) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RECURRING_STACK_TYPEHASH,
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
                it.maxSlippageBps,
                it.stackPriceSource,
                it.stackBps
            )
        );
    }

    function _digest(RecurringStackIntent memory it) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domain(it.zap), _structHash(it)));
    }

    function _sign(RecurringStackIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, _digest(it));
        return abi.encodePacked(r, s, v);
    }

    // ---- the app-side mirror must agree with the capsule ----

    function test_capsuleDigestMatchesTheIndependentlyBuiltOne() public view {
        // The capsule's own hash must equal a digest assembled here from the typehash string and
        // domain literal — the same pair src/lib/executions.ts feeds to wallets. If the field order
        // or the domain version ever drifts, wallets sign something the capsule will not recognize
        // and every run of every stacking series fails `BadSignature`.
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), BAND, SLICE);
        assertEq(zapFwd.hashRecurringStackIntent(it), _digest(it), "capsule digest != independently built digest");
    }

    // ---- the happy paths ----

    function test_stacksDirectlyWhenOutputIsAlreadyTheToken() public {
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), BAND, SLICE);
        bytes memory sig = _sign(it);

        zapFwd.executeRecurringStack(it, sig);

        // The recipient receives post-fee MINUS the slice — never the unsliced amount.
        assertEq(assetB.balanceOf(recipient), TO_RECIPIENT, "recipient net");
        assertEq(assetB.balanceOf(address(this)), EXECUTOR_CUT, "executor cut");
        // The pot holds the protocol's 20% fee slice AND the owner's stacked slice.
        assertEq(assetB.balanceOf(address(pot)), POT_CUT + STACK_IN, "pot holdings");
        // Tickets are credited to the OWNER for both contributions, not to the executor.
        assertEq(pot.tickets(1, owner), POT_CUT + STACK_IN, "owner tickets");
        // Because the contributed asset IS the prize asset, both roll into the round's prize.
        assertEq(pot.roundPrize(1), POT_CUT + STACK_IN, "round prize");
    }

    function test_buysTheTokenWhenOutputIsSomethingElse() public {
        RecurringStackIntent memory it = _stack(zapRev, address(assetA), address(src), BAND, SLICE);
        bytes memory sig = _sign(it);

        zapRev.executeRecurringStack(it, sig);

        assertEq(assetA.balanceOf(recipient), TO_RECIPIENT, "recipient net");
        assertEq(assetA.balanceOf(address(this)), EXECUTOR_CUT, "executor cut");
        // The protocol fee stays in the OUTPUT asset; only the stack slice is converted.
        assertEq(assetA.balanceOf(address(pot)), POT_CUT, "pot fee in outAsset");
        // The slice arrived as real 0xZAPS, bought through the pinned adapter at 1:1.
        assertEq(assetB.balanceOf(address(pot)), STACK_IN, "pot stacked zaps");
        assertEq(pot.tickets(1, owner), POT_CUT + STACK_IN, "owner tickets across both assets");
        // Only the 0xZAPS contribution counts toward the prize; the assetA fee awaits `buyZaps`.
        assertEq(pot.roundPrize(1), STACK_IN, "round prize is zaps-only");
        // The capsule keeps no 0xZAPS of its own — everything converted was staked.
        assertEq(assetB.balanceOf(address(zapRev)), AMOUNT_IN * MAX_RUNS - AMOUNT_IN, "no zaps retained");
    }

    function test_executorAndPotFeeAreUnchangedByTheSliceSize() public {
        // Stacking must not change executor economics, or executors would cherry-pick series.
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), BAND, 9_000);
        zapFwd.executeRecurringStack(it, _sign(it));
        assertEq(assetB.balanceOf(address(this)), EXECUTOR_CUT, "executor cut invariant to slice");
    }

    function test_valueIsConservedExactly() public {
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), BAND, SLICE);
        zapFwd.executeRecurringStack(it, _sign(it));
        uint256 distributed =
            assetB.balanceOf(recipient) + assetB.balanceOf(address(this)) + assetB.balanceOf(address(pot));
        assertEq(distributed, AMOUNT_IN, "nothing created or lost");
    }

    // ---- the floors ----

    function test_recipientFloorIsScaledByTheSliceSoItCannotUnderDeliver() public {
        // Spot claims the run should have produced 25% more than the 1:1 mock actually pays. With a
        // 2% band the recipient's floor is unreachable, so the run reverts rather than under-deliver.
        src.setPrice((Q96 * 125) / 100);
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), BAND, SLICE);
        bytes memory sig = _sign(it);
        vm.expectRevert(OpenZapV3_2.MinOutNotMet.selector);
        zapFwd.executeRecurringStack(it, sig);
    }

    function test_conversionLegIsFlooredAgainstSpot() public {
        // A pinned adapter that pays only half the fair rate must fail the whole run closed, not
        // quietly hand the owner dust tickets in exchange for real output.
        MockZapsBuyAdapter badAdapter = new MockZapsBuyAdapter(address(assetB), 0.5e18);
        registry.setAdapter(address(badAdapter), true);
        assetB.mint(address(badAdapter), 1_000_000e18);
        ZapLotteryPot badPot = new ZapLotteryPot(potGov, address(assetB), address(badAdapter));
        OpenZapFactoryV3_2 badFactory = new OpenZapFactoryV3_2(registry, allowlist, priceSources, badPot);
        vm.prank(potGov);
        badPot.setFactory(address(badFactory));

        OpenZapV3_2 zap =
            OpenZapV3_2(payable(badFactory.createZap(_policy(address(assetB), address(assetA)), bytes32("bad"))));
        assetB.mint(address(zap), AMOUNT_IN * MAX_RUNS);

        RecurringStackIntent memory it = _stack(zap, address(assetA), address(src), BAND, SLICE);
        bytes memory sig = _sign(it);
        vm.expectRevert(
            abi.encodeWithSelector(OpenZapV3_2.StackFloorNotMet.selector, STACK_IN / 2, (STACK_IN * 9_800) / 10_000)
        );
        zap.executeRecurringStack(it, sig);
    }

    function test_deallowlistingThePinnedStackAdapterHaltsBothStackPaths() public {
        registry.setAdapter(address(buyAdapter), false);

        RecurringStackIntent memory direct = _stack(zapFwd, address(assetB), address(0), BAND, SLICE);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3_2.AdapterNotAllowed.selector, address(buyAdapter)));
        zapFwd.executeRecurringStack(direct, _sign(direct));

        RecurringStackIntent memory converted = _stack(zapRev, address(assetA), address(src), BAND, SLICE);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3_2.AdapterNotAllowed.selector, address(buyAdapter)));
        zapRev.executeRecurringStack(converted, _sign(converted));
    }

    // ---- the authorization bounds ----

    function test_rejectsASlippageBandInsideTheProtocolFee() public {
        // The live v3.1 trap: the floor is GROSS-derived but NET-enforced, so <=100 bps can never
        // clear. v3.2 refuses the authorization outright instead of minting a dead series.
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), 100, SLICE);
        bytes memory sig = _sign(it);
        vm.expectRevert(OpenZapV3_2.SlippageBelowFee.selector);
        zapFwd.executeRecurringStack(it, sig);
    }

    function test_rejectsASliceThatIsNotASlice() public {
        RecurringStackIntent memory zero = _stack(zapFwd, address(assetB), address(0), BAND, 0);
        bytes memory zeroSig = _sign(zero);
        vm.expectRevert(OpenZapV3_2.InvalidStackBps.selector);
        zapFwd.executeRecurringStack(zero, zeroSig);

        RecurringStackIntent memory all = _stack(zapFwd, address(assetB), address(0), BAND, 10_000);
        bytes memory allSig = _sign(all);
        vm.expectRevert(OpenZapV3_2.InvalidStackBps.selector);
        zapFwd.executeRecurringStack(all, allSig);
    }

    function test_stackSourceMustBePresentExactlyWhenAConversionLegExists() public {
        // Output IS 0xZAPS but a source was supplied — it would be carried along stale and unused.
        RecurringStackIntent memory stale = _stack(zapFwd, address(assetB), address(src), BAND, SLICE);
        bytes memory staleSig = _sign(stale);
        vm.expectRevert(OpenZapV3_2.StackSourceMismatch.selector);
        zapFwd.executeRecurringStack(stale, staleSig);

        // Output is NOT 0xZAPS and no source was supplied — the conversion would be unfloored.
        RecurringStackIntent memory missing = _stack(zapRev, address(assetA), address(0), BAND, SLICE);
        bytes memory missingSig = _sign(missing);
        vm.expectRevert(OpenZapV3_2.StackSourceMismatch.selector);
        zapRev.executeRecurringStack(missing, missingSig);
    }

    function test_rejectsANonAllowlistedStackSource() public {
        MockOrientedPriceSource rogue = new MockOrientedPriceSource(address(assetA), address(assetB));
        rogue.setPrice(Q96);
        RecurringStackIntent memory it = _stack(zapRev, address(assetA), address(rogue), BAND, SLICE);
        bytes memory sig = _sign(it);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3_2.PriceSourceNotAllowed.selector, address(rogue)));
        zapRev.executeRecurringStack(it, sig);
    }

    function test_rejectsAStackSourceThatCannotPriceThisOutputAgainstTheToken() public {
        MockOrientedPriceSource other = new MockOrientedPriceSource(address(assetB), address(0xDEAD));
        other.setPrice(Q96);
        priceSources.setAdapter(address(other), true);
        RecurringStackIntent memory it = _stack(zapRev, address(assetA), address(other), BAND, SLICE);
        bytes memory sig = _sign(it);
        vm.expectRevert();
        zapRev.executeRecurringStack(it, sig);
    }

    // ---- replay isolation across lineages ----

    function test_aV3_1RelativeSignatureCannotBeReplayedAsAStack() public {
        // Same fields, but signed under domain "3.1" with the relative typehash. It must not recover
        // to the owner here, or a signer who never agreed to divert output would be stacking.
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), BAND, SLICE);
        bytes32 relativeTypehash = keccak256(
            "RecurringRelativeIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                relativeTypehash,
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
        bytes32 v31Domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("3.1"), block.chainid, it.zap));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(OWNER_PK, keccak256(abi.encodePacked("\x19\x01", v31Domain, structHash)));
        bytes memory wrongSig = abi.encodePacked(r, s, v);

        vm.expectRevert(OpenZapV3_2.BadSignature.selector);
        zapFwd.executeRecurringStack(it, wrongSig);
    }

    // ---- cadence carries over unchanged ----

    function test_cadenceAndSeriesExhaustionBehaveLikeEveryOtherRecurringType() public {
        RecurringStackIntent memory it = _stack(zapFwd, address(assetB), address(0), BAND, SLICE);
        bytes memory sig = _sign(it);

        zapFwd.executeRecurringStack(it, sig);
        vm.expectRevert();
        zapFwd.executeRecurringStack(it, sig); // interval not elapsed

        for (uint256 i = 1; i < MAX_RUNS; i++) {
            vm.warp(block.timestamp + INTERVAL);
            zapFwd.executeRecurringStack(it, sig);
        }
        (uint32 runs,) = zapFwd.series(11);
        assertEq(runs, MAX_RUNS, "series ran to completion");

        vm.warp(block.timestamp + INTERVAL);
        vm.expectRevert(OpenZapV3_2.NonceReplay.selector);
        zapFwd.executeRecurringStack(it, sig); // exhaustion consumed the series id
    }
}
