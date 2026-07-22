// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";

contract DeployRobinhood is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;
    address internal constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint24 internal constant FEE = 0x800000;
    int24 internal constant TICK_SPACING = 200;
    bytes32 internal constant EXPECTED_POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;

    error WrongChain(uint256 actual);
    error MissingCode(address target);
    error ZeroGovernance();
    error DeploymentAssertionFailed();

    function run()
        external
        returns (
            AdapterRegistry registry,
            TokenAllowlist allowlist,
            RobinhoodV4SwapAdapter adapter,
            OpenZapFactory factory
        )
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        _requireCode(WETH);
        _requireCode(ZAPS);
        _requireCode(HOOK);
        _requireCode(ROUTER);
        _requireCode(PERMIT2);

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address governance = vm.envOr("GOVERNANCE", deployer);
        if (governance == address(0)) revert ZeroGovernance();

        vm.startBroadcast(deployerPrivateKey);
        registry = new AdapterRegistry(deployer);
        allowlist = new TokenAllowlist(deployer);
        adapter = new RobinhoodV4SwapAdapter(ROUTER, PERMIT2, WETH, ZAPS, FEE, TICK_SPACING, HOOK);
        factory = new OpenZapFactory(registry, allowlist);

        registry.setAdapter(address(adapter), true);
        allowlist.setToken(WETH, true);
        allowlist.setToken(ZAPS, true);

        if (governance != deployer) {
            registry.transferOwnership(governance);
            allowlist.transferOwnership(governance);
        }
        vm.stopBroadcast();

        if (
            !registry.isAllowed(address(adapter)) || !allowlist.isAllowed(WETH) || !allowlist.isAllowed(ZAPS)
                || adapter.poolId() != EXPECTED_POOL_ID || address(factory.adapters()) != address(registry)
                || address(factory.tokens()) != address(allowlist)
        ) revert DeploymentAssertionFailed();

        console2.log("Robinhood deployer", deployer);
        console2.log("Robinhood governance", governance);
        console2.log("AdapterRegistry", address(registry));
        console2.log("TokenAllowlist", address(allowlist));
        console2.log("RobinhoodV4SwapAdapter", address(adapter));
        console2.log("OpenZapFactory", address(factory));
        if (governance != deployer) {
            console2.log("Governance acceptance required for registry and allowlist");
        }
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }
}
