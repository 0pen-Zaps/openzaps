// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseV3Test} from "./BaseV3.t.sol";
import {OpenZapV3} from "../src/v3/OpenZapV3.sol";
import {RecurringIntent} from "../src/v3/libraries/OpenZapV3Types.sol";

/// @dev The recurring path: one signature, many runs, cadence enforced ON-CHAIN, 1% fee split
///      80/20 executor/pot, `minOutPerRun` net of fee, owner cancel via `invalidateNonce`.
contract OpenZapV3RecurringTest is BaseV3Test {
    function _submit(RecurringIntent memory it, address as_) internal {
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(as_);
        zap.executeRecurring(it, sig);
    }

    // ---- happy path ----

    function test_firstRun_paysRecipientExecutorAndPot() public {
        RecurringIntent memory it = _defaultRecurring();
        _submit(it, executor);

        assertEq(tokenOut.balanceOf(recipient), NET_PER_RUN, "recipient gets net");
        assertEq(tokenOut.balanceOf(executor), EXECUTOR_CUT, "executor gets 80% of 1%");
        assertEq(tokenOut.balanceOf(address(pot)), POT_CUT, "pot gets 20% of 1%");

        (uint32 runs, uint64 lastRun) = zap.series(it.seriesId);
        assertEq(runs, 1);
        assertEq(lastRun, uint64(block.timestamp));
        assertFalse(zap.nonceUsed(it.seriesId), "series still open");
    }

    function test_potCreditsTicketsToZapOwner() public {
        RecurringIntent memory it = _defaultRecurring();
        _submit(it, executor);

        assertEq(pot.tickets(1, owner), POT_CUT, "tickets accrue to the fee payer (zap owner)");
        assertEq(pot.totalTickets(1), POT_CUT);
        // outAsset IS the prize asset in this fixture, so the contribution feeds the prize directly.
        assertEq(pot.roundPrize(1), POT_CUT);
    }

    function test_fullSeries_thenConsumed() public {
        RecurringIntent memory it = _defaultRecurring();
        _submit(it, executor);
        vm.warp(block.timestamp + INTERVAL);
        _submit(it, executor);
        vm.warp(block.timestamp + INTERVAL);
        _submit(it, executor);

        assertEq(tokenOut.balanceOf(recipient), NET_PER_RUN * 3);
        assertTrue(zap.nonceUsed(it.seriesId), "exhaustion consumes the series id");

        vm.warp(block.timestamp + INTERVAL);
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.NonceReplay.selector);
        zap.executeRecurring(it, sig);
    }

    function test_openExecutor_anyoneMaySubmit() public {
        RecurringIntent memory it = _defaultRecurring(); // executor == address(0)
        _submit(it, address(0xD00D));
        assertEq(tokenOut.balanceOf(address(0xD00D)), EXECUTOR_CUT, "fee goes to whoever submitted");
    }

    // ---- cadence enforcement ----

    function test_secondRunBeforeInterval_reverts() public {
        RecurringIntent memory it = _defaultRecurring();
        _submit(it, executor);

        uint64 nextAt = uint64(block.timestamp) + INTERVAL;
        vm.warp(block.timestamp + INTERVAL - 1);
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3.IntervalNotElapsed.selector, nextAt));
        zap.executeRecurring(it, sig);
    }

    function test_deadlineEndsSeriesEarly() public {
        RecurringIntent memory it = _defaultRecurring();
        _submit(it, executor);
        vm.warp(uint256(it.deadline) + 1);
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.Expired.selector);
        zap.executeRecurring(it, sig);
    }

    function test_notYetValid() public {
        RecurringIntent memory it = _defaultRecurring();
        it.validAfter = uint64(block.timestamp + 1 days);
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.NotYetValid.selector);
        zap.executeRecurring(it, sig);
    }

    function test_zeroIntervalOrZeroRuns_rejected() public {
        RecurringIntent memory it = _defaultRecurring();
        it.interval = 0;
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.InvalidSchedule.selector);
        zap.executeRecurring(it, sig);

        it = _defaultRecurring();
        it.maxRuns = 0;
        sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.InvalidSchedule.selector);
        zap.executeRecurring(it, sig);
    }

    // ---- authorization ----

    function test_pinnedExecutor_rejectsOthers() public {
        RecurringIntent memory it = _defaultRecurring();
        it.executor = executor;
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(address(0xBAD));
        vm.expectRevert(OpenZapV3.ExecutorMismatch.selector);
        zap.executeRecurring(it, sig);

        _submit(it, executor); // the pinned executor still can
        assertEq(tokenOut.balanceOf(executor), EXECUTOR_CUT);
    }

    function test_ownerCancelsSeries() public {
        RecurringIntent memory it = _defaultRecurring();
        _submit(it, executor);

        vm.prank(owner);
        zap.invalidateNonce(it.seriesId);

        vm.warp(block.timestamp + INTERVAL);
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.NonceReplay.selector);
        zap.executeRecurring(it, sig);
    }

    function test_tamperedField_failsSignature() public {
        RecurringIntent memory it = _defaultRecurring();
        bytes memory sig = _signRecurring(OWNER_PK, it);
        it.interval = 1; // executor tries to compress the cadence the owner signed
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.BadSignature.selector);
        zap.executeRecurring(it, sig);
    }

    function test_nonOwnerSignature_rejected() public {
        RecurringIntent memory it = _defaultRecurring();
        bytes memory sig = _signRecurring(0xB0B, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.BadSignature.selector);
        zap.executeRecurring(it, sig);
    }

    // ---- settlement bounds ----

    function test_minOutPerRun_isNetOfFee() public {
        RecurringIntent memory it = _defaultRecurring();
        it.minOutPerRun = NET_PER_RUN + 1; // gross (100) clears it, net (99) must not
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.MinOutNotMet.selector);
        zap.executeRecurring(it, sig);

        it.minOutPerRun = NET_PER_RUN; // exactly the net floor passes
        sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        zap.executeRecurring(it, sig);
        assertEq(tokenOut.balanceOf(recipient), NET_PER_RUN);
    }

    function test_feeSplitSumsToOnePercent() public {
        RecurringIntent memory it = _defaultRecurring();
        _submit(it, executor);
        uint256 fee = tokenOut.balanceOf(executor) + tokenOut.balanceOf(address(pot));
        assertEq(fee, RUN_FEE, "executor + pot cuts == 1% of output");
        assertEq(tokenOut.balanceOf(recipient) + fee, OUT_PER_RUN, "nothing minted, nothing stranded");
    }
}
