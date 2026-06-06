// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockRevertingAdapter} from "./mocks/MockRevertingAdapter.sol";

/// @notice APPR + FLOW invariants: exact-approval reset on success and revert paths; net-of-fee
///         min-out; bounded relayer fee.
contract ApprovalFlowTest is BaseTest {
    function test_approvalResetAfterSuccess() public {
        OpenZapIntent memory it = _defaultIntent();
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenIn.allowance(address(zap), address(adapter)), 0);
    }

    function test_approvalResetAfterRevert() public {
        MockRevertingAdapter rev = new MockRevertingAdapter();
        registry.setAdapter(address(rev), true);

        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(rev);
        p.steps[0].spender = address(rev);
        OpenZap z2 = OpenZap(payable(factory.createZap(p, bytes32("rev"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        bytes memory sig = _signIntent(OWNER_PK, it);

        vm.expectRevert(MockRevertingAdapter.AdapterReverted.selector);
        z2.execute(it, sig);
        assertEq(tokenIn.allowance(address(z2), address(rev)), 0, "no residual approval on revert");
    }

    function test_minOutEnforced_netOfFee() public {
        OpenZapIntent memory it = _defaultIntent();
        it.minOut = 100e18; // gross is 100, net of 1 fee is 99 -> must revert
        vm.expectRevert(OpenZap.MinOutNotMet.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_feePaidBounded_recipientNet() public {
        OpenZapIntent memory it = _defaultIntent();
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(relayer), 1e18);
        assertEq(tokenOut.balanceOf(recipient), 99e18);
    }

    function test_noFeeWhenRelayerZero() public {
        OpenZapIntent memory it = _defaultIntent();
        it.relayer = address(0);
        it.maxRelayerFee = 0;
        it.minOut = 100e18;
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 100e18);
        assertEq(tokenOut.balanceOf(relayer), 0);
    }

    function test_feeAtCap_recipientNet() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxRelayerFee = FEE_CAP; // 5e18
        it.minOut = 95e18;
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(relayer), 5e18);
        assertEq(tokenOut.balanceOf(recipient), 95e18);
    }
}
