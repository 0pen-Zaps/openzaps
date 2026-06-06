// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";

/// @notice REC invariants: unconditional owner-only emergency exit, independent of adapter/Hermes state.
contract RecoveryTest is BaseTest {
    function _inAssets() internal view returns (address[] memory a) {
        a = new address[](1);
        a[0] = address(tokenIn);
    }

    function test_emergencyExit_drainsToOwner() public {
        vm.prank(owner);
        zap.emergencyExit(_inAssets());
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN);
        assertEq(tokenIn.balanceOf(address(zap)), 0);
    }

    function test_emergencyExit_worksWhenAdapterRemoved() public {
        registry.setAdapter(address(adapter), false); // compromised protocol / governance halt
        vm.prank(owner);
        zap.emergencyExit(_inAssets());
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN, "exit must not depend on adapter health");
    }

    function test_emergencyExit_native() public {
        vm.deal(address(zap), 1 ether);
        address[] memory none = new address[](0);
        uint256 before = owner.balance;
        vm.prank(owner);
        zap.emergencyExit(none);
        assertEq(owner.balance, before + 1 ether);
    }

    function test_emergencyExit_onlyOwner() public {
        vm.expectRevert(OpenZap.NotOwner.selector);
        zap.emergencyExit(_inAssets());
    }

    function testFuzz_emergencyExit_fromArbitraryDeposits(uint96 a, uint96 b) public {
        tokenIn.mint(address(zap), a);
        tokenOut.mint(address(zap), b);
        uint256 inBal = tokenIn.balanceOf(address(zap));
        uint256 outBal = tokenOut.balanceOf(address(zap));

        address[] memory assets = new address[](2);
        assets[0] = address(tokenIn);
        assets[1] = address(tokenOut);

        vm.prank(owner);
        zap.emergencyExit(assets);

        assertEq(tokenIn.balanceOf(owner), inBal);
        assertEq(tokenOut.balanceOf(owner), outBal);
        assertEq(tokenIn.balanceOf(address(zap)), 0);
        assertEq(tokenOut.balanceOf(address(zap)), 0);
    }
}
