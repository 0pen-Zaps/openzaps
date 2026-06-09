// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";

/// @notice Deploys the OpenZap v1 governance + factory stack.
/// @dev Governance ownership is set to `GOVERNANCE` (or the broadcaster). Per ADR-0002, transfer
///      ownership of the registry and allowlist to a Safe multisig behind a TimelockController
///      immediately after deployment. Adapters and tokens must be explicitly allowlisted before any
///      zap can be created against them.
contract Deploy is Script {
    function run()
        external
        returns (AdapterRegistry registry, TokenAllowlist allowlist, OpenZapFactory factory)
    {
        address governance = vm.envOr("GOVERNANCE", msg.sender);
        vm.startBroadcast();
        registry = new AdapterRegistry(governance);
        allowlist = new TokenAllowlist(governance);
        factory = new OpenZapFactory(registry, allowlist);
        vm.stopBroadcast();
    }
}
