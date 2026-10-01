// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {Campaign3Terms} from "../script/Campaign3Terms.sol";

contract Campaign3TermsTest is Test {
    function testOctoberScheduleIsPinnedInUtc() public pure {
        assertEq(uint256(Campaign3Terms.START_AT), 1_790_985_600);
        assertEq(uint256(Campaign3Terms.END_AT), 1_793_491_200);
        assertEq(uint256(Campaign3Terms.CLAIM_DEADLINE), 1_796_083_200);
        assertEq(uint256(Campaign3Terms.SWEEP_AFTER), 1_796_083_200);
        assertEq(uint256(Campaign3Terms.END_AT - Campaign3Terms.START_AT), 29 days);
        assertEq(uint256(Campaign3Terms.DURATION_SECONDS), 29 days);
        assertEq(uint256(Campaign3Terms.CLAIM_DEADLINE - Campaign3Terms.END_AT), 30 days);
        assertEq(uint256(Campaign3Terms.SWEEP_AFTER - Campaign3Terms.END_AT), 30 days);
    }

    function testPerLegEconomicsMatchCampaign2() public pure {
        assertEq(Campaign3Terms.STAKER_FEE_SHARES, 50 ether);
        assertEq(Campaign3Terms.HOOK_BLOCKS_FEE_SHARES, 50 ether);
        assertEq(Campaign3Terms.STAKER_FEE_SHARES + Campaign3Terms.HOOK_BLOCKS_FEE_SHARES, 100 ether);
        assertEq(uint256(Campaign3Terms.MIN_OUT_BPS), 9_700);
        assertEq(Campaign3Terms.MAX_BUY_WEI, 0.05 ether);
        assertEq(Campaign3Terms.MIN_BUY_WEI, 0.0005 ether);
        assertEq(uint256(Campaign3Terms.SWEEP_TAIL), 30 days);
        assertEq(uint256(Campaign3Terms.MIN_FUNDING_LEAD), 24 hours);
    }
}
