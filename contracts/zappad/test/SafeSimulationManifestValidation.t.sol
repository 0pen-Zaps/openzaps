// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeploySafeTreasury } from "../script/DeploySafeTreasury.s.sol";
import { SafeTreasuryDeployment } from "../script/lib/SafeTreasuryDeployment.sol";

contract DeploySafeTreasuryManifestHarness is DeploySafeTreasury {
    function validateReviewedSimulationManifestJson(
        string memory manifestJson,
        bytes32 expectedManifestHash,
        address[] memory owners,
        uint256 threshold,
        uint256 saltNonce,
        bytes memory setupData,
        address predicted,
        bytes32 proxyDeploymentCodeHash
    ) external view {
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
}

contract SafeSimulationManifestValidationTest is Test {
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODE_HASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    bytes32 internal constant SAFE_SINGLETON_CODE_HASH =
        0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    address internal constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    bytes32 internal constant FALLBACK_HANDLER_CODE_HASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;
    bytes32 internal constant PROXY_DEPLOYMENT_CODE_HASH =
        0x76733d705f71b79841c0ee960a0ca880f779cde7ef446c989e6d23efc0a4adfb;
    uint256 internal constant SALT_NONCE = 20_260_728;
    uint256 internal constant SIMULATED_AT_BLOCK = 22_019_952;

    DeploySafeTreasuryManifestHarness internal harness;
    address[] internal owners;
    bytes internal setupData;
    address internal predicted;

    function setUp() public {
        vm.chainId(4663);
        vm.roll(SIMULATED_AT_BLOCK + 10);
        harness = new DeploySafeTreasuryManifestHarness();
        owners = new address[](3);
        owners[0] = makeAddr("safe-owner-one");
        owners[1] = makeAddr("safe-owner-two");
        owners[2] = makeAddr("safe-owner-three");
        setupData = SafeTreasuryDeployment.initializer(owners, 2, FALLBACK_HANDLER);
        predicted = _predictedSafe(setupData, SALT_NONCE, PROXY_DEPLOYMENT_CODE_HASH);
    }

    function test_acceptsExactIndependentlyHashedReviewedSimulation() public {
        string memory json = _manifest(
            "zappad-safe-treasury-simulation",
            1,
            "simulation-only",
            owners,
            predicted,
            keccak256(setupData),
            SAFE_PROXY_FACTORY_CODE_HASH,
            SIMULATED_AT_BLOCK
        );
        _validate(json, keccak256(bytes(json)));
    }

    function test_rejectsRawByteDriftEvenWhenJsonMeaningIsUnchanged() public {
        string memory json = _manifest(
            "zappad-safe-treasury-simulation",
            1,
            "simulation-only",
            owners,
            predicted,
            keccak256(setupData),
            SAFE_PROXY_FACTORY_CODE_HASH,
            SIMULATED_AT_BLOCK
        );
        vm.expectPartialRevert(DeploySafeTreasury.ReviewedSafeSimulationMismatch.selector);
        _validate(string.concat(json, "\n"), keccak256(bytes(json)));
    }

    function test_rejectsIndependentlyHashedWrongIdentity() public {
        string memory json = _manifest(
            "zappad-safe-deployment-verification",
            2,
            "approved-for-broadcast",
            owners,
            predicted,
            keccak256(setupData),
            SAFE_PROXY_FACTORY_CODE_HASH,
            SIMULATED_AT_BLOCK
        );
        vm.expectPartialRevert(DeploySafeTreasury.ReviewedSafeSimulationMismatch.selector);
        _validate(json, keccak256(bytes(json)));
    }

    function test_rejectsIndependentlyHashedOwnerOrderDrift() public {
        address[] memory reordered = new address[](3);
        reordered[0] = owners[1];
        reordered[1] = owners[0];
        reordered[2] = owners[2];
        string memory json = _manifest(
            "zappad-safe-treasury-simulation",
            1,
            "simulation-only",
            reordered,
            predicted,
            keccak256(setupData),
            SAFE_PROXY_FACTORY_CODE_HASH,
            SIMULATED_AT_BLOCK
        );
        vm.expectPartialRevert(DeploySafeTreasury.ReviewedSafeSimulationMismatch.selector);
        _validate(json, keccak256(bytes(json)));
    }

    function test_rejectsIndependentlyHashedDerivationOrDependencyDrift() public {
        string memory badInitializer = _manifest(
            "zappad-safe-treasury-simulation",
            1,
            "simulation-only",
            owners,
            predicted,
            bytes32(uint256(1)),
            SAFE_PROXY_FACTORY_CODE_HASH,
            SIMULATED_AT_BLOCK
        );
        vm.expectPartialRevert(DeploySafeTreasury.ReviewedSafeSimulationMismatch.selector);
        _validate(badInitializer, keccak256(bytes(badInitializer)));

        string memory badDependency = _manifest(
            "zappad-safe-treasury-simulation",
            1,
            "simulation-only",
            owners,
            predicted,
            keccak256(setupData),
            bytes32(uint256(1)),
            SIMULATED_AT_BLOCK
        );
        vm.expectPartialRevert(DeploySafeTreasury.ReviewedSafeSimulationMismatch.selector);
        _validate(badDependency, keccak256(bytes(badDependency)));
    }

    function test_rejectsIndependentlyHashedPredictedSafeOrFutureBlockDrift() public {
        string memory badSafe = _manifest(
            "zappad-safe-treasury-simulation",
            1,
            "simulation-only",
            owners,
            makeAddr("wrong-predicted-safe"),
            keccak256(setupData),
            SAFE_PROXY_FACTORY_CODE_HASH,
            SIMULATED_AT_BLOCK
        );
        vm.expectPartialRevert(DeploySafeTreasury.ReviewedSafeSimulationMismatch.selector);
        _validate(badSafe, keccak256(bytes(badSafe)));

        string memory futureBlock = _manifest(
            "zappad-safe-treasury-simulation",
            1,
            "simulation-only",
            owners,
            predicted,
            keccak256(setupData),
            SAFE_PROXY_FACTORY_CODE_HASH,
            block.number + 1
        );
        vm.expectPartialRevert(DeploySafeTreasury.ReviewedSafeSimulationMismatch.selector);
        _validate(futureBlock, keccak256(bytes(futureBlock)));
    }

    function _validate(string memory manifestJson, bytes32 expectedManifestHash) private view {
        harness.validateReviewedSimulationManifestJson(
            manifestJson,
            expectedManifestHash,
            owners,
            2,
            SALT_NONCE,
            setupData,
            predicted,
            PROXY_DEPLOYMENT_CODE_HASH
        );
    }

    function _manifest(
        string memory kind,
        uint256 schemaVersion,
        string memory status,
        address[] memory manifestOwners,
        address safe,
        bytes32 initializerHash,
        bytes32 proxyFactoryCodeHash,
        uint256 simulatedAtBlock
    ) private returns (string memory json) {
        string memory root = "safeSimulationManifestValidation";
        vm.serializeString(root, "kind", kind);
        vm.serializeUint(root, "schemaVersion", schemaVersion);
        vm.serializeString(root, "status", status);
        vm.serializeUint(root, "chainId", 4663);
        vm.serializeString(root, "safeVersion", "1.4.1");
        vm.serializeAddress(root, "safe", safe);
        vm.serializeAddress(root, "owners", manifestOwners);
        vm.serializeUint(root, "threshold", 2);
        vm.serializeUint(root, "saltNonce", SALT_NONCE);
        vm.serializeBytes32(root, "initializerHash", initializerHash);
        vm.serializeBytes32(root, "create2Salt", SafeTreasuryDeployment.create2Salt(setupData, SALT_NONCE));
        vm.serializeBytes32(root, "proxyDeploymentCodeHash", PROXY_DEPLOYMENT_CODE_HASH);
        vm.serializeAddress(root, "proxyFactory", SAFE_PROXY_FACTORY);
        vm.serializeBytes32(root, "proxyFactoryCodeHash", proxyFactoryCodeHash);
        vm.serializeAddress(root, "singleton", SAFE_SINGLETON);
        vm.serializeBytes32(root, "singletonCodeHash", SAFE_SINGLETON_CODE_HASH);
        vm.serializeAddress(root, "fallbackHandler", FALLBACK_HANDLER);
        vm.serializeBytes32(root, "fallbackHandlerCodeHash", FALLBACK_HANDLER_CODE_HASH);
        json = vm.serializeUint(root, "simulatedAtBlock", simulatedAtBlock);
    }

    function _predictedSafe(bytes memory initializer, uint256 saltNonce, bytes32 deploymentCodeHash)
        private
        pure
        returns (address)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                SAFE_PROXY_FACTORY,
                SafeTreasuryDeployment.create2Salt(initializer, saltNonce),
                deploymentCodeHash
            )
        );
        return address(uint160(uint256(digest)));
    }
}
