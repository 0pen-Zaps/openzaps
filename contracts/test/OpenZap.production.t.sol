// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapIntent, Policy, Step} from "../src/libraries/OpenZapTypes.sol";

contract InvalidResultAdapter {
    function execute(address, uint256, bytes calldata) external pure returns (address, uint256) {
        return (address(0), 0);
    }
}

contract ProductionHardeningTest is BaseTest {
    function test_registryRejectsCodeLessAdapter() public {
        address eoa = address(0xCAFE);
        vm.expectRevert(abi.encodeWithSelector(AdapterRegistry.NoCode.selector, eoa));
        registry.setAdapter(eoa, true);
    }

    function test_allowlistRejectsCodeLessToken() public {
        address eoa = address(0xCAFE);
        vm.expectRevert(abi.encodeWithSelector(TokenAllowlist.NoCode.selector, eoa));
        allowlist.setToken(eoa, true);
    }

    function test_registryRejectsZeroOwnershipTransfer() public {
        vm.expectRevert(AdapterRegistry.ZeroAddress.selector);
        registry.transferOwnership(address(0));
    }

    function test_allowlistRejectsZeroOwnershipTransfer() public {
        vm.expectRevert(TokenAllowlist.ZeroAddress.selector);
        allowlist.transferOwnership(address(0));
    }

    function test_executeRejectsInvalidAdapterResult() public {
        InvalidResultAdapter invalid = new InvalidResultAdapter();
        registry.setAdapter(address(invalid), true);

        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(invalid);
        p.steps[0].spender = address(invalid);
        OpenZap zap = OpenZap(payable(factory.createZap(p, bytes32("invalid-result"))));
        tokenIn.mint(address(zap), 1_000 ether);

        OpenZapIntent memory intent = _defaultIntent();
        intent.zap = address(zap);
        intent.policyHash = zap.policyHash();
        intent.nonce = 77;
        bytes memory sig = _signIntent(OWNER_PK, intent);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.InvalidAdapterResult.selector, 0, address(0), 0));
        zap.execute(intent, sig);
    }

    function test_initializeRejectsEmptyPolicy() public {
        Policy memory p = _defaultPolicy();
        p.steps = new Step[](0);
        vm.expectRevert(OpenZap.EmptyPolicy.selector);
        factory.createZap(p, bytes32("empty"));
    }

    function test_initializeRejectsZeroAmountStep() public {
        Policy memory p = _defaultPolicy();
        p.steps[0].amountIn = 0;
        vm.expectRevert(abi.encodeWithSelector(OpenZap.InvalidStep.selector, 0));
        factory.createZap(p, bytes32("zero-amount"));
    }

    function test_initializeRejectsExternalSpender() public {
        Policy memory p = _defaultPolicy();
        p.steps[0].spender = address(0xCAFE);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.InvalidStep.selector, 0));
        factory.createZap(p, bytes32("wrong-spender"));
    }

    function test_initializeRejectsNativeStep() public {
        Policy memory p = _defaultPolicy();
        p.steps[0].tokenIn = address(0);
        vm.expectRevert(OpenZap.NativeTokenUnsupported.selector);
        factory.createZap(p, bytes32("native"));
    }

    function test_initializeRejectsDuplicateTrackedAsset() public {
        Policy memory p = _defaultPolicy();
        p.trackedAssets[1] = p.trackedAssets[0];
        vm.expectRevert(abi.encodeWithSelector(OpenZap.DuplicateTrackedAsset.selector, p.trackedAssets[0]));
        factory.createZap(p, bytes32("duplicate"));
    }
}
