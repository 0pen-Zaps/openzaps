// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseV3Test} from "./BaseV3.t.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {RecurringIntent} from "../src/v3/libraries/OpenZapV3Types.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev The pot's own guarantees: only registered zaps record contributions, conversion is
///      permissionless but bounded to the pinned adapter and the prize asset, and a round can only
///      pay a ticket holder — there is no other way value leaves.
contract ZapLotteryPotTest is BaseV3Test {
    MockERC20 internal feeAsset; // a non-prize asset the pot must convert

    function setUp() public override {
        super.setUp();
        feeAsset = new MockERC20("Fee", "FEE", 18);
    }

    function _contributeViaZap() internal {
        RecurringIntent memory it = _defaultRecurring();
        bytes memory sig = _signRecurring(OWNER_PK, it);
        vm.prank(executor);
        zap.executeRecurring(it, sig);
    }

    // ---- wiring ----

    function test_setFactory_onceOnly() public {
        vm.prank(potGov);
        vm.expectRevert(ZapLotteryPot.FactoryAlreadySet.selector);
        pot.setFactory(address(0xF00));
    }

    function test_registerZap_onlyFactory() public {
        vm.expectRevert(ZapLotteryPot.NotFactory.selector);
        pot.registerZap(address(0xF00));
    }

    function test_notify_onlyRegisteredZap() public {
        vm.expectRevert(ZapLotteryPot.NotZap.selector);
        pot.notifyContribution(address(this), address(tokenOut), 1e18);
    }

    function test_factoryCloneIsRegistered() public view {
        assertTrue(pot.isZap(address(zap)));
    }

    // ---- conversion ----

    function test_buyZaps_convertsAccruedFeeAsset() public {
        feeAsset.mint(address(pot), 10e18);
        uint256 got = pot.buyZaps(address(feeAsset), 10e18, 10e18); // 1:1 mock rate
        assertEq(got, 10e18);
        assertEq(pot.roundPrize(1), 10e18, "converted 0xZAPS lands in the current round's prize");
        assertEq(tokenOut.balanceOf(address(pot)), 10e18);
    }

    function test_buyZaps_minOutEnforced() public {
        feeAsset.mint(address(pot), 10e18);
        vm.expectRevert(abi.encodeWithSelector(ZapLotteryPot.MinZapsNotMet.selector, 10e18, 11e18));
        pot.buyZaps(address(feeAsset), 10e18, 11e18);
    }

    function test_buyZaps_boundsInputs() public {
        vm.expectRevert(ZapLotteryPot.CannotConvertPrizeAsset.selector);
        pot.buyZaps(address(tokenOut), 1e18, 0);

        vm.expectRevert(ZapLotteryPot.ZeroAmount.selector);
        pot.buyZaps(address(feeAsset), 0, 0);

        vm.expectRevert(ZapLotteryPot.NothingToConvert.selector);
        pot.buyZaps(address(feeAsset), 1e18, 0); // pot holds none of it
    }

    // ---- awarding ----

    function test_awardRound_paysTicketHolderAndAdvances() public {
        _contributeViaZap(); // owner earns POT_CUT tickets; prize == POT_CUT (prize-asset fee)

        vm.prank(potGov);
        pot.awardRound(owner);

        assertEq(tokenOut.balanceOf(owner), POT_CUT, "winner receives the round prize");
        assertEq(pot.currentRound(), 2, "next round opens");
        assertEq(pot.roundPrize(1), 0);
    }

    function test_awardRound_requiresTickets() public {
        _contributeViaZap();
        vm.prank(potGov);
        vm.expectRevert(abi.encodeWithSelector(ZapLotteryPot.WinnerHasNoTickets.selector, 1, address(0xD00D)));
        pot.awardRound(address(0xD00D));
    }

    function test_awardRound_requiresPrize() public {
        vm.prank(potGov);
        vm.expectRevert(ZapLotteryPot.EmptyPrize.selector);
        pot.awardRound(owner);
    }

    function test_awardRound_onlyOwner() public {
        _contributeViaZap();
        vm.expectRevert(ZapLotteryPot.NotOwner.selector);
        pot.awardRound(owner);
    }

    function test_contributionsAfterAward_creditNextRound() public {
        _contributeViaZap();
        vm.prank(potGov);
        pot.awardRound(owner);

        vm.warp(block.timestamp + INTERVAL);
        _contributeViaZap();
        assertEq(pot.tickets(2, owner), POT_CUT, "round 2 tickets accrue separately");
        assertEq(pot.roundPrize(2), POT_CUT);
    }

    // ---- ownership ----

    function test_twoStepOwnership() public {
        vm.prank(potGov);
        pot.transferOwnership(address(0xA11));
        assertEq(pot.owner(), potGov, "no change until accepted");

        vm.prank(address(0xA11));
        pot.acceptOwnership();
        assertEq(pot.owner(), address(0xA11));
    }
}
