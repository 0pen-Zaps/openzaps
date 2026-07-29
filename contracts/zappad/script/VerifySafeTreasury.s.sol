// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { SafeTreasuryDeployment } from "./lib/SafeTreasuryDeployment.sol";

/// @notice Read-only post-broadcast verification for the exact ZapPad treasury Safe.
contract VerifySafeTreasury is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

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
    error EvidenceAlreadyExists(string manifest);

    function run() external returns (address safeAddress) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();
        _requireCodeHash(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_CODE_HASH);
        _requireCodeHash(SAFE_SINGLETON, SAFE_SINGLETON_CODE_HASH);
        _requireCodeHash(COMPATIBILITY_FALLBACK_HANDLER, COMPATIBILITY_FALLBACK_HANDLER_CODE_HASH);

        safeAddress = vm.envAddress("SAFE_TREASURY");
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envUint("SAFE_THRESHOLD");
        uint256 saltNonce = vm.envUint("SAFE_SALT_NONCE");
        bool requireFreshNonce = vm.envOr("REQUIRE_FRESH_SAFE_NONCE", true);
        bytes memory setupData =
            SafeTreasuryDeployment.initializer(owners, threshold, COMPATIBILITY_FALLBACK_HANDLER);
        address predicted =
            SafeTreasuryDeployment.predict(SAFE_PROXY_FACTORY, SAFE_SINGLETON, setupData, saltNonce);

        SafeTreasuryDeployment.verify(
            safeAddress,
            predicted,
            SAFE_SINGLETON,
            COMPATIBILITY_FALLBACK_HANDLER,
            owners,
            threshold,
            ROBINHOOD_CHAIN_ID,
            requireFreshNonce
        );

        string memory root = "safeVerification";
        vm.serializeString(root, "status", "verified");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "safe", safeAddress);
        vm.serializeBytes32(root, "safeRuntimeCodeHash", safeAddress.codehash);
        vm.serializeAddress(root, "owners", owners);
        vm.serializeUint(root, "threshold", threshold);
        vm.serializeUint(root, "saltNonce", saltNonce);
        vm.serializeBytes32(root, "initializerHash", keccak256(setupData));
        vm.serializeAddress(root, "proxyFactory", SAFE_PROXY_FACTORY);
        vm.serializeBytes32(root, "proxyFactoryCodeHash", SAFE_PROXY_FACTORY.codehash);
        vm.serializeAddress(root, "singleton", SAFE_SINGLETON);
        vm.serializeBytes32(root, "singletonCodeHash", SAFE_SINGLETON.codehash);
        vm.serializeAddress(root, "fallbackHandler", COMPATIBILITY_FALLBACK_HANDLER);
        vm.serializeBytes32(root, "fallbackHandlerCodeHash", COMPATIBILITY_FALLBACK_HANDLER.codehash);
        string memory json = vm.serializeUint(root, "checkedAtBlock", block.number);

        string memory manifest = vm.envOr(
            "SAFE_VERIFICATION_MANIFEST",
            string.concat(
                "../../deployments/zappad/robinhood-safe-verification-",
                vm.toString(safeAddress),
                "-",
                vm.toString(block.number),
                ".json"
            )
        );
        if (vm.exists(manifest)) revert EvidenceAlreadyExists(manifest);
        vm.writeJson(json, manifest);

        console2.log("Verified ZapPad protocol Safe", safeAddress);
        console2.log("Verification manifest", manifest);
    }

    function _requireCodeHash(address dependency, bytes32 expected) private view {
        if (dependency.code.length == 0) revert MissingDependencyCode(dependency);
        bytes32 actual = dependency.codehash;
        if (actual != expected) {
            revert DependencyCodeHashMismatch(dependency, expected, actual);
        }
    }
}
