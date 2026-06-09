// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockReentrantAdapter} from "./mocks/MockReentrantAdapter.sol";

/// @notice SURF invariants: only allowlisted adapters reachable; reentrancy blocked.
contract SurfaceTest is BaseTest {
    function test_deallowlistedAdapter_haltsExecution() public {
        registry.setAdapter(address(adapter), false); // governance kill-switch
        OpenZapIntent memory it = _defaultIntent();
        vm.expectRevert(abi.encodeWithSelector(OpenZap.AdapterNotAllowed.selector, address(adapter)));
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_init_rejectsNonAllowlistedAdapter() public {
        MockSwapAdapter rogue = new MockSwapAdapter();
        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.AdapterNotAllowed.selector, address(rogue)));
        factory.createZap(p, bytes32("rogue-adapter"));
    }

    function test_reentrancyBlocked() public {
        MockReentrantAdapter re = new MockReentrantAdapter();
        registry.setAdapter(address(re), true);

        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(re);
        p.steps[0].spender = address(re);
        OpenZap z2 = OpenZap(payable(factory.createZap(p, bytes32("reentrant"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        bytes memory sig = _signIntent(OWNER_PK, it);

        vm.expectRevert(OpenZap.Reentrancy.selector);
        z2.execute(it, sig);
    }
}
