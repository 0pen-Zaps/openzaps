// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { ISafeProxyFactory } from "../src/interfaces/ISafe.sol";
import { SafeTreasuryDeployment } from "./lib/SafeTreasuryDeployment.sol";

contract DeploySafeTreasury is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant SAFE_SIMULATION_SCHEMA_VERSION = 1;
    bytes32 internal constant SAFE_SIMULATION_KIND_HASH = keccak256("zappad-safe-treasury-simulation");
    bytes32 internal constant SAFE_SIMULATION_STATUS_HASH = keccak256("simulation-only");
    bytes32 internal constant SAFE_VERSION_HASH = keccak256("1.4.1");

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODE_HASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    bytes32 internal constant SAFE_SINGLETON_CODE_HASH =
        0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    address internal constant COMPATIBILITY_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    bytes32 internal constant COMPATIBILITY_FALLBACK_HANDLER_CODE_HASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;

    error WrongChain();
    error MissingDependencyCode(address dependency);
    error DependencyCodeHashMismatch(address dependency, bytes32 expected, bytes32 actual);
    error SafePolicyMismatch();
    error ReviewedSafeSimulationMismatch(bytes32 field);

    function run() external returns (address safeAddress) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();
        _requireCodeHash(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_CODE_HASH);
        _requireCodeHash(SAFE_SINGLETON, SAFE_SINGLETON_CODE_HASH);
        _requireCodeHash(COMPATIBILITY_FALLBACK_HANDLER, COMPATIBILITY_FALLBACK_HANDLER_CODE_HASH);

        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envUint("SAFE_THRESHOLD");
        uint256 saltNonce = vm.envUint("SAFE_SALT_NONCE");
        if (owners.length != 3 || threshold != 2) revert SafePolicyMismatch();
        bytes memory setupData =
            SafeTreasuryDeployment.initializer(owners, threshold, COMPATIBILITY_FALLBACK_HANDLER);
        address predicted =
            SafeTreasuryDeployment.predict(SAFE_PROXY_FACTORY, SAFE_SINGLETON, setupData, saltNonce);
        SafeTreasuryDeployment.requireFresh(predicted);
        bytes32 proxyDeploymentCodeHash =
            SafeTreasuryDeployment.deploymentCodeHash(SAFE_PROXY_FACTORY, SAFE_SINGLETON);
        bool isBroadcast = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        if (isBroadcast) {
            _validateReviewedSimulationManifest(
                owners, threshold, saltNonce, setupData, predicted, proxyDeploymentCodeHash
            );
        }

        vm.startBroadcast();
        safeAddress =
            ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, setupData, saltNonce);
        vm.stopBroadcast();

        SafeTreasuryDeployment.verify(
            safeAddress,
            predicted,
            SAFE_SINGLETON,
            COMPATIBILITY_FALLBACK_HANDLER,
            owners,
            threshold,
            ROBINHOOD_CHAIN_ID,
            true
        );

        string memory manifest = vm.envOr(
            "SAFE_SIMULATION_MANIFEST",
            string.concat("../../deployments/zappad/robinhood-safe-", vm.toString(safeAddress), ".local.json")
        );
        if (!isBroadcast) {
            _writeSimulationManifest(
                manifest, safeAddress, owners, threshold, saltNonce, setupData, proxyDeploymentCodeHash
            );
        }

        console2.log("ZapPad protocol Safe", safeAddress);
        console2.log(isBroadcast ? "Reviewed simulation manifest" : "Simulation manifest", manifest);
    }

    function _writeSimulationManifest(
        string memory manifest,
        address safeAddress,
        address[] memory owners,
        uint256 threshold,
        uint256 saltNonce,
        bytes memory setupData,
        bytes32 proxyDeploymentCodeHash
    ) private {
        string memory root = "safeTreasury";
        vm.serializeString(root, "kind", "zappad-safe-treasury-simulation");
        vm.serializeUint(root, "schemaVersion", SAFE_SIMULATION_SCHEMA_VERSION);
        vm.serializeString(root, "status", "simulation-only");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "safeVersion", "1.4.1");
        vm.serializeAddress(root, "safe", safeAddress);
        vm.serializeAddress(root, "owners", owners);
        vm.serializeUint(root, "threshold", threshold);
        vm.serializeUint(root, "saltNonce", saltNonce);
        vm.serializeBytes32(root, "initializerHash", keccak256(setupData));
        vm.serializeBytes32(root, "create2Salt", SafeTreasuryDeployment.create2Salt(setupData, saltNonce));
        vm.serializeBytes32(root, "proxyDeploymentCodeHash", proxyDeploymentCodeHash);
        vm.serializeAddress(root, "proxyFactory", SAFE_PROXY_FACTORY);
        vm.serializeBytes32(root, "proxyFactoryCodeHash", SAFE_PROXY_FACTORY.codehash);
        vm.serializeAddress(root, "singleton", SAFE_SINGLETON);
        vm.serializeBytes32(root, "singletonCodeHash", SAFE_SINGLETON.codehash);
        vm.serializeAddress(root, "fallbackHandler", COMPATIBILITY_FALLBACK_HANDLER);
        vm.serializeBytes32(root, "fallbackHandlerCodeHash", COMPATIBILITY_FALLBACK_HANDLER.codehash);
        string memory json = vm.serializeUint(root, "simulatedAtBlock", block.number);

        vm.writeJson(json, manifest);
    }

    function _validateReviewedSimulationManifest(
        address[] memory owners,
        uint256 threshold,
        uint256 saltNonce,
        bytes memory setupData,
        address predicted,
        bytes32 proxyDeploymentCodeHash
    ) internal view {
        string memory manifestJson = vm.readFile(vm.envString("SAFE_SIMULATION_MANIFEST"));
        bytes32 expectedManifestHash = vm.envBytes32("EXPECTED_SAFE_SIMULATION_MANIFEST_HASH");
        _validateReviewedSimulationManifestJson(
            manifestJson,
            expectedManifestHash,
            owners,
            threshold,
            saltNonce,
            setupData,
            predicted,
            proxyDeploymentCodeHash
        );
    }

    function _validateReviewedSimulationManifestJson(
        string memory manifestJson,
        bytes32 expectedManifestHash,
        address[] memory owners,
        uint256 threshold,
        uint256 saltNonce,
        bytes memory setupData,
        address predicted,
        bytes32 proxyDeploymentCodeHash
    ) internal view {
        if (expectedManifestHash == bytes32(0) || keccak256(bytes(manifestJson)) != expectedManifestHash) {
            revert ReviewedSafeSimulationMismatch("rawHash");
        }

        if (
            keccak256(bytes(vm.parseJsonString(manifestJson, ".kind"))) != SAFE_SIMULATION_KIND_HASH
                || vm.parseJsonUint(manifestJson, ".schemaVersion") != SAFE_SIMULATION_SCHEMA_VERSION
                || keccak256(bytes(vm.parseJsonString(manifestJson, ".status")))
                    != SAFE_SIMULATION_STATUS_HASH
        ) revert ReviewedSafeSimulationMismatch("identity");
        if (
            vm.parseJsonUint(manifestJson, ".chainId") != ROBINHOOD_CHAIN_ID
                || keccak256(bytes(vm.parseJsonString(manifestJson, ".safeVersion"))) != SAFE_VERSION_HASH
        ) revert ReviewedSafeSimulationMismatch("chainOrVersion");
        if (
            vm.parseJsonAddress(manifestJson, ".safe") != predicted
                || vm.parseJsonUint(manifestJson, ".threshold") != threshold || threshold != 2
                || vm.parseJsonUint(manifestJson, ".saltNonce") != saltNonce
        ) revert ReviewedSafeSimulationMismatch("safePolicy");

        address[] memory reviewedOwners = vm.parseJsonAddressArray(manifestJson, ".owners");
        if (reviewedOwners.length != owners.length || owners.length != 3) {
            revert ReviewedSafeSimulationMismatch("owners");
        }
        for (uint256 i; i < owners.length; ++i) {
            if (reviewedOwners[i] != owners[i]) {
                revert ReviewedSafeSimulationMismatch("owners");
            }
        }

        if (
            vm.parseJsonBytes32(manifestJson, ".initializerHash") != keccak256(setupData)
                || vm.parseJsonBytes32(manifestJson, ".create2Salt")
                    != SafeTreasuryDeployment.create2Salt(setupData, saltNonce)
                || vm.parseJsonBytes32(manifestJson, ".proxyDeploymentCodeHash") != proxyDeploymentCodeHash
        ) revert ReviewedSafeSimulationMismatch("derivation");
        if (
            vm.parseJsonAddress(manifestJson, ".proxyFactory") != SAFE_PROXY_FACTORY
                || vm.parseJsonBytes32(manifestJson, ".proxyFactoryCodeHash") != SAFE_PROXY_FACTORY_CODE_HASH
                || vm.parseJsonAddress(manifestJson, ".singleton") != SAFE_SINGLETON
                || vm.parseJsonBytes32(manifestJson, ".singletonCodeHash") != SAFE_SINGLETON_CODE_HASH
                || vm.parseJsonAddress(manifestJson, ".fallbackHandler") != COMPATIBILITY_FALLBACK_HANDLER
                || vm.parseJsonBytes32(manifestJson, ".fallbackHandlerCodeHash")
                    != COMPATIBILITY_FALLBACK_HANDLER_CODE_HASH
        ) revert ReviewedSafeSimulationMismatch("dependencies");

        uint256 simulatedAtBlock = vm.parseJsonUint(manifestJson, ".simulatedAtBlock");
        if (simulatedAtBlock == 0 || simulatedAtBlock > block.number) {
            revert ReviewedSafeSimulationMismatch("simulatedAtBlock");
        }
    }

    function _requireCodeHash(address dependency, bytes32 expected) private view {
        if (dependency.code.length == 0) revert MissingDependencyCode(dependency);
        bytes32 actual = dependency.codehash;
        if (actual != expected) {
            revert DependencyCodeHashMismatch(dependency, expected, actual);
        }
    }
}
