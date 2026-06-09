// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {Policy} from "../src/libraries/OpenZapTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";

/// @notice ISO + TOK invariants: implementation bricked, init once + factory-only, optimization-only,
///         per-clone isolation, deterministic addresses, curated token allowlist.
contract IsolationTest is BaseTest {
    function test_implementationIsBricked() public {
        address impl = factory.implementation();
        assertEq(OpenZap(payable(impl)).owner(), address(0), "impl must never be initialized");

        Policy memory p = _defaultPolicy();
        // non-factory caller -> NotFactory (checked first)
        vm.expectRevert(OpenZap.NotFactory.selector);
        OpenZap(payable(impl)).initialize(p);

        // even the factory cannot re-init the (constructor-locked) implementation
        vm.prank(address(factory));
        vm.expectRevert(OpenZap.AlreadyInitialized.selector);
        OpenZap(payable(impl)).initialize(p);
    }

    function test_initialize_onlyFactory() public {
        Policy memory p = _defaultPolicy();
        vm.expectRevert(OpenZap.NotFactory.selector);
        zap.initialize(p);
    }

    function test_initialize_twiceReverts() public {
        Policy memory p = _defaultPolicy();
        vm.prank(address(factory));
        vm.expectRevert(OpenZap.AlreadyInitialized.selector);
        zap.initialize(p);
    }

    function test_rejects_nonOptimizationPolicy() public {
        Policy memory p = _defaultPolicy();
        p.optimization = false;
        vm.expectRevert(OpenZap.NotOptimization.selector);
        factory.createZap(p, bytes32("noopt"));
    }

    function test_predictMatchesCreate() public {
        address predicted = factory.predict(_defaultPolicy(), bytes32("predict-1"));
        address created = factory.createZap(_defaultPolicy(), bytes32("predict-1"));
        assertEq(created, predicted);
    }

    function test_perCloneStorageIsolated() public {
        Policy memory p = _defaultPolicy();
        p.recipient = address(0x1111);
        OpenZap z2 = OpenZap(payable(factory.createZap(p, bytes32("iso-2"))));
        assertEq(zap.recipient(), recipient);
        assertEq(z2.recipient(), address(0x1111));
        assertTrue(zap.policyHash() != z2.policyHash(), "distinct policies -> distinct hashes");
    }

    function test_init_rejectsNonAllowlistedTrackedAsset() public {
        MockERC20 rogue = new MockERC20("R", "R", 18);
        Policy memory p = _defaultPolicy();
        p.trackedAssets[0] = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.TokenNotAllowed.selector, address(rogue)));
        factory.createZap(p, bytes32("rogue-tracked"));
    }

    function test_init_rejectsFeeOnTransferToken() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20();
        Policy memory p = _defaultPolicy();
        p.steps[0].tokenIn = address(fot); // not on the curated allowlist
        vm.expectRevert(abi.encodeWithSelector(OpenZap.TokenNotAllowed.selector, address(fot)));
        factory.createZap(p, bytes32("fot"));
    }
}
