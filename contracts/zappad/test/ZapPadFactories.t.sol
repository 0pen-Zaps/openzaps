// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { ZapFeeVaultFactory } from "../src/ZapFeeVaultFactory.sol";
import { ZapToken } from "../src/ZapToken.sol";
import { ZapTokenFactory } from "../src/ZapTokenFactory.sol";

contract TokenFactoryLaunchpadHarness {
    function deployToken(
        ZapTokenFactory factory,
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply,
        address creator,
        bytes32 salt
    ) external returns (address) {
        return factory.deploy(name, symbol, metadataURI, supply, creator, salt);
    }
}

contract ZapPadFactoriesTest is Test {
    address internal creator = makeAddr("creator");
    address internal attacker = makeAddr("attacker");

    function test_tokenFactoryBindsExactlyOnceAndOnlyBinderCanBind() public {
        ZapTokenFactory factory = new ZapTokenFactory();
        TokenFactoryLaunchpadHarness harness = new TokenFactoryLaunchpadHarness();

        vm.prank(attacker);
        vm.expectRevert(ZapTokenFactory.NotBinder.selector);
        factory.bindLaunchpad(address(harness));

        vm.expectRevert(ZapTokenFactory.InvalidLaunchpad.selector);
        factory.bindLaunchpad(address(0));

        factory.bindLaunchpad(address(harness));
        assertEq(factory.launchpad(), address(harness));

        vm.expectRevert(ZapTokenFactory.NotBinder.selector);
        factory.bindLaunchpad(address(this));
    }

    function test_feeVaultFactoryBindsExactlyOnceAndRejectsEOA() public {
        ZapFeeVaultFactory factory = new ZapFeeVaultFactory();
        TokenFactoryLaunchpadHarness harness = new TokenFactoryLaunchpadHarness();

        vm.expectRevert(ZapFeeVaultFactory.InvalidLaunchpad.selector);
        factory.bindLaunchpad(attacker);

        factory.bindLaunchpad(address(harness));
        assertEq(factory.launchpad(), address(harness));

        vm.expectRevert(ZapFeeVaultFactory.NotBinder.selector);
        factory.bindLaunchpad(address(this));
    }

    function test_tokenFactoryDeployAccessAndCreate2Prediction() public {
        ZapTokenFactory factory = new ZapTokenFactory();
        TokenFactoryLaunchpadHarness harness = new TokenFactoryLaunchpadHarness();
        factory.bindLaunchpad(address(harness));

        string memory name = "Predicted Zap";
        string memory symbol = "PZAP";
        string memory metadataURI = "ipfs://predicted";
        uint256 supply = 1_000_000e18;
        bytes32 salt = keccak256("creator salt");

        address predicted = factory.predictTokenAddress(creator, salt, name, symbol, metadataURI, supply);

        vm.expectRevert(ZapTokenFactory.NotLaunchpad.selector);
        factory.deploy(name, symbol, metadataURI, supply, creator, salt);

        address deployed = harness.deployToken(factory, name, symbol, metadataURI, supply, creator, salt);
        assertEq(deployed, predicted);
        assertEq(ZapToken(deployed).name(), name);
        assertEq(ZapToken(deployed).symbol(), symbol);
        assertEq(ZapToken(deployed).metadataURI(), metadataURI);
        assertEq(ZapToken(deployed).creator(), creator);
        assertEq(ZapToken(deployed).launchpad(), address(harness));
        assertEq(ZapToken(deployed).balanceOf(address(harness)), supply);

        vm.expectRevert();
        harness.deployToken(factory, name, symbol, metadataURI, supply, creator, salt);
    }

    function test_tokenInitCodeHashRequiresBinding() public {
        ZapTokenFactory factory = new ZapTokenFactory();
        vm.expectRevert(ZapTokenFactory.InvalidLaunchpad.selector);
        factory.tokenInitCodeHash("Zap", "ZAP", "ipfs://zap", 1e18, creator);
    }
}
