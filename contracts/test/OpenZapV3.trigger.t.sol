// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseV3Test} from "./BaseV3.t.sol";
import {OpenZapV3} from "../src/v3/OpenZapV3.sol";
import {TriggerIntent} from "../src/v3/libraries/OpenZapV3Types.sol";
import {MockPriceSource} from "./mocks/MockPriceSource.sol";

/// @dev The trigger path: fires exactly once, only while the allowlisted source reports the market
///      past the signed threshold; the submitter cannot supply a price. Baseline 1000e18 with a
///      1000 bps threshold means the "+10%" bound is 1100e18 and the "-10%" bound is 900e18.
contract OpenZapV3TriggerTest is BaseV3Test {
    uint256 internal constant BASELINE = 1000e18;
    uint256 internal constant UP_BOUND = 1100e18;
    uint256 internal constant DOWN_BOUND = 900e18;

    function _submit(TriggerIntent memory it, address as_) internal {
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(as_);
        zap.executeTrigger(it, sig);
    }

    // ---- condition gating ----

    function test_aboveTrigger_firesAtOrPastBound() public {
        TriggerIntent memory it = _defaultTrigger(); // above, +10%
        priceSource.setPrice(UP_BOUND);
        _submit(it, executor);

        assertEq(tokenOut.balanceOf(recipient), NET_PER_RUN);
        assertEq(tokenOut.balanceOf(executor), EXECUTOR_CUT);
        assertEq(tokenOut.balanceOf(address(pot)), POT_CUT);
        assertTrue(zap.nonceUsed(it.nonce), "a fired trigger is consumed");
    }

    function test_aboveTrigger_refusesBelowBound() public {
        TriggerIntent memory it = _defaultTrigger();
        priceSource.setPrice(UP_BOUND - 1);
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3.TriggerNotMet.selector, UP_BOUND - 1, UP_BOUND));
        zap.executeTrigger(it, sig);
        assertFalse(zap.nonceUsed(it.nonce), "an unmet trigger stays armed");
    }

    function test_belowTrigger_firesAtOrUnderBound() public {
        TriggerIntent memory it = _defaultTrigger();
        it.above = false;
        priceSource.setPrice(DOWN_BOUND);
        _submit(it, executor);
        assertEq(tokenOut.balanceOf(recipient), NET_PER_RUN);
    }

    function test_belowTrigger_refusesAboveBound() public {
        TriggerIntent memory it = _defaultTrigger();
        it.above = false;
        priceSource.setPrice(DOWN_BOUND + 1);
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3.TriggerNotMet.selector, DOWN_BOUND + 1, DOWN_BOUND));
        zap.executeTrigger(it, sig);
    }

    function test_deadPriceSource_failsClosed() public {
        TriggerIntent memory it = _defaultTrigger();
        // price never set => the source reverts => the trigger cannot fire on a phantom price
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(MockPriceSource.PoolNotInitialized.selector);
        zap.executeTrigger(it, sig);
    }

    // ---- source and threshold validation ----

    function test_unlistedPriceSource_rejected() public {
        MockPriceSource rogue = new MockPriceSource();
        rogue.setPrice(type(uint256).max / 2e6); // "the market moved, trust me"
        TriggerIntent memory it = _defaultTrigger();
        it.priceSource = address(rogue);
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV3.PriceSourceNotAllowed.selector, address(rogue)));
        zap.executeTrigger(it, sig);
    }

    function test_invalidThresholds_rejected() public {
        priceSource.setPrice(UP_BOUND);

        TriggerIntent memory it = _defaultTrigger();
        it.thresholdBps = 0;
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.InvalidThreshold.selector);
        zap.executeTrigger(it, sig);

        it = _defaultTrigger();
        it.baselinePriceX96 = 0;
        sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.InvalidThreshold.selector);
        zap.executeTrigger(it, sig);

        // a "below" move of >= 100% would cross zero — meaningless, so rejected
        it = _defaultTrigger();
        it.above = false;
        it.thresholdBps = 10_000;
        sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.InvalidThreshold.selector);
        zap.executeTrigger(it, sig);

        // and the ceiling: > 100x is out of range in either direction
        it = _defaultTrigger();
        it.thresholdBps = 1_000_001;
        sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.InvalidThreshold.selector);
        zap.executeTrigger(it, sig);
    }

    // ---- authorization ----

    function test_replay_rejected() public {
        TriggerIntent memory it = _defaultTrigger();
        priceSource.setPrice(UP_BOUND);
        _submit(it, executor);

        tokenIn.mint(address(zap), AMOUNT_IN); // refund for a hypothetical second run
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.NonceReplay.selector);
        zap.executeTrigger(it, sig);
    }

    function test_pinnedExecutor_rejectsOthers() public {
        TriggerIntent memory it = _defaultTrigger();
        it.executor = executor;
        priceSource.setPrice(UP_BOUND);
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(address(0xBAD));
        vm.expectRevert(OpenZapV3.ExecutorMismatch.selector);
        zap.executeTrigger(it, sig);
    }

    function test_tamperedDirection_failsSignature() public {
        TriggerIntent memory it = _defaultTrigger();
        priceSource.setPrice(DOWN_BOUND); // market fell...
        bytes memory sig = _signTrigger(OWNER_PK, it);
        it.above = false; // ...and the executor flips the signed direction to fire anyway
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.BadSignature.selector);
        zap.executeTrigger(it, sig);
    }

    function test_ownerCancelsHeldTrigger() public {
        TriggerIntent memory it = _defaultTrigger();
        vm.prank(owner);
        zap.invalidateNonce(it.nonce);

        priceSource.setPrice(UP_BOUND);
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.NonceReplay.selector);
        zap.executeTrigger(it, sig);
    }

    // ---- settlement ----

    function test_minOut_isNetOfFee() public {
        TriggerIntent memory it = _defaultTrigger();
        it.minOut = NET_PER_RUN + 1;
        priceSource.setPrice(UP_BOUND);
        bytes memory sig = _signTrigger(OWNER_PK, it);
        vm.prank(executor);
        vm.expectRevert(OpenZapV3.MinOutNotMet.selector);
        zap.executeTrigger(it, sig);
    }
}
