// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { PrepareZapPadCanaries } from "../script/PrepareZapPadCanaries.s.sol";

contract CanaryPlanValidationHarness is PrepareZapPadCanaries {
    function parseUint(string calldata json, string calldata key) external pure returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function validate(uint256 minFirstSellPairOut, uint256 firstSellTokenIn) external pure {
        CanaryConfig memory config = CanaryConfig({
            name: "",
            symbol: "",
            metadataURI: "",
            pair: address(0),
            floorTick: 0,
            firstBuyPairIn: 1,
            minFirstBuyTokenOut: 9500,
            minFirstSellPairOut: minFirstSellPairOut,
            minSecondBuyTokenOut: 760,
            minSecondSellPairOut: 380,
            saltSeed: bytes32(0)
        });
        ReviewedSimulation memory simulated = ReviewedSimulation({
            firstBuyTokenOut: 10_000,
            firstSellTokenIn: firstSellTokenIn,
            firstSellPairOut: 1000,
            secondBuyPairIn: 500,
            secondBuyTokenOut: 800,
            secondSellTokenIn: 400,
            secondSellPairOut: 400
        });
        _validateReviewedSimulation(config, simulated);
    }
}

contract CanaryPlanValidationTest is Test {
    CanaryPlanValidationHarness internal harness;

    function setUp() public {
        harness = new CanaryPlanValidationHarness();
    }

    function test_reviewedSimulationAcceptsExactRatiosAndFivePercentMinimums() public view {
        harness.validate(950, 2500);
    }

    function test_reviewedPlanDecimalStringsParseAsUint() public view {
        assertEq(harness.parseUint('{"minimum":"950"}', ".minimum"), 950);
    }

    function test_reviewedSimulationRejectsOneUnitMinimum() public {
        vm.expectPartialRevert(PrepareZapPadCanaries.InvalidConfiguration.selector);
        harness.validate(1, 2500);
    }

    function test_reviewedSimulationRejectsArbitraryRatio() public {
        vm.expectPartialRevert(PrepareZapPadCanaries.InvalidConfiguration.selector);
        harness.validate(950, 2499);
    }
}
