// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { ReviewedArtifact } from "../script/lib/ReviewedArtifact.sol";
import { SafeTreasuryDeployment } from "../script/lib/SafeTreasuryDeployment.sol";
import { ZapPadReleaseValidation } from "../script/lib/ZapPadReleaseValidation.sol";

contract ZapPadReleaseValidationHarness is ZapPadReleaseValidation {
    function requireExpectedHash(string memory raw, bytes32 expected) external pure returns (bytes32) {
        return ReviewedArtifact.requireExpectedHash(raw, expected);
    }

    function validateReleaseEvidenceJson(
        string memory deploymentEvidence,
        bytes32 deploymentEvidenceHash,
        string memory safeEvidence,
        bytes32 safeEvidenceHash,
        string memory expectedReleaseCommit,
        address launchpad,
        address treasury
    ) external view {
        _validateReleaseEvidenceJson(
            deploymentEvidence,
            deploymentEvidenceHash,
            safeEvidence,
            safeEvidenceHash,
            expectedReleaseCommit,
            launchpad,
            treasury
        );
    }
}

contract ZapPadReleaseValidationTest is Test {
    string internal constant RELEASE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    address internal constant LAUNCHPAD = address(0x50);
    address internal constant TREASURY = address(0x40);
    address internal constant OWNER_ONE = address(0x10);
    address internal constant OWNER_TWO = address(0x20);
    address internal constant OWNER_THREE = address(0x30);

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODE_HASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant SAFE_SINGLETON_CODE_HASH =
        0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    bytes32 internal constant SAFE_FALLBACK_HANDLER_CODE_HASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;
    bytes32 internal constant SAFE_RUNTIME_CODE_HASH = keccak256("safe-runtime");

    ZapPadReleaseValidationHarness internal harness;

    function setUp() public {
        harness = new ZapPadReleaseValidationHarness();
    }

    function test_acceptsExactRawHashesAndFreshSafeEvidence() public view {
        string memory safeEvidence = _safeEvidence(OWNER_TWO, 0);
        bytes32 safeEvidenceHash = keccak256(bytes(safeEvidence));
        string memory deploymentEvidence = _deploymentEvidence(safeEvidenceHash);

        assertEq(harness.requireExpectedHash(safeEvidence, safeEvidenceHash), safeEvidenceHash);
        harness.validateReleaseEvidenceJson(
            deploymentEvidence,
            keccak256(bytes(deploymentEvidence)),
            safeEvidence,
            safeEvidenceHash,
            RELEASE_COMMIT,
            LAUNCHPAD,
            TREASURY
        );
    }

    function test_rejectsMissingOrDriftedRawApprovalHash() public {
        string memory evidence = '{"ok":true}';

        vm.expectRevert(ReviewedArtifact.MissingExpectedHash.selector);
        harness.requireExpectedHash(evidence, bytes32(0));

        vm.expectPartialRevert(ReviewedArtifact.RawHashMismatch.selector);
        harness.requireExpectedHash(evidence, keccak256("different-raw-file"));
    }

    function test_rejectsDeploymentEvidenceNotBoundToExactSafeEvidence() public {
        string memory safeEvidence = _safeEvidence(OWNER_TWO, 0);
        bytes32 safeEvidenceHash = keccak256(bytes(safeEvidence));
        string memory deploymentEvidence = _deploymentEvidence(keccak256("different-safe-evidence"));

        vm.expectPartialRevert(ZapPadReleaseValidation.InvalidReleaseState.selector);
        harness.validateReleaseEvidenceJson(
            deploymentEvidence,
            keccak256(bytes(deploymentEvidence)),
            safeEvidence,
            safeEvidenceHash,
            RELEASE_COMMIT,
            LAUNCHPAD,
            TREASURY
        );
    }

    function test_rejectsNonFreshSafeNonce() public {
        string memory safeEvidence = _safeEvidence(OWNER_TWO, 1);
        bytes32 safeEvidenceHash = keccak256(bytes(safeEvidence));
        string memory deploymentEvidence = _deploymentEvidence(safeEvidenceHash);

        vm.expectPartialRevert(ZapPadReleaseValidation.InvalidReleaseState.selector);
        harness.validateReleaseEvidenceJson(
            deploymentEvidence,
            keccak256(bytes(deploymentEvidence)),
            safeEvidence,
            safeEvidenceHash,
            RELEASE_COMMIT,
            LAUNCHPAD,
            TREASURY
        );
    }

    function test_rejectsDuplicateSafeOwners() public {
        string memory safeEvidence = _safeEvidence(OWNER_ONE, 0);
        bytes32 safeEvidenceHash = keccak256(bytes(safeEvidence));
        string memory deploymentEvidence = _deploymentEvidence(safeEvidenceHash);

        vm.expectPartialRevert(SafeTreasuryDeployment.DuplicateOwner.selector);
        harness.validateReleaseEvidenceJson(
            deploymentEvidence,
            keccak256(bytes(deploymentEvidence)),
            safeEvidence,
            safeEvidenceHash,
            RELEASE_COMMIT,
            LAUNCHPAD,
            TREASURY
        );
    }

    function _deploymentEvidence(bytes32 safeEvidenceHash) internal view returns (string memory) {
        return string.concat(
            '{"ok":true,"kind":"zappad-deployment-verification","chainId":4663,',
            '"releaseCommit":"',
            RELEASE_COMMIT,
            '","launchpad":"',
            vm.toString(LAUNCHPAD),
            '","protocolTreasury":"',
            vm.toString(TREASURY),
            '","safeDeploymentEvidenceHash":"',
            vm.toString(safeEvidenceHash),
            '"}'
        );
    }

    function _safeEvidence(address secondOwner, uint256 nonce) internal view returns (string memory) {
        string memory owners = string.concat(
            '["',
            vm.toString(OWNER_ONE),
            '","',
            vm.toString(secondOwner),
            '","',
            vm.toString(OWNER_THREE),
            '"]'
        );
        return string.concat(
            '{"ok":true,"kind":"zappad-safe-deployment-verification",',
            '"schemaVersion":1,"chainId":4663,"releaseCommit":"',
            RELEASE_COMMIT,
            '","config":{"safe":"',
            vm.toString(TREASURY),
            '","owners":',
            owners,
            ',"threshold":2,"proxyFactory":"',
            vm.toString(SAFE_PROXY_FACTORY),
            '","singleton":"',
            vm.toString(SAFE_SINGLETON),
            '","fallbackHandler":"',
            vm.toString(SAFE_FALLBACK_HANDLER),
            '"},"safeState":{"address":"',
            vm.toString(TREASURY),
            '","runtimeCodeHash":"',
            vm.toString(SAFE_RUNTIME_CODE_HASH),
            '","singleton":"',
            vm.toString(SAFE_SINGLETON),
            '","version":"1.4.1","chainId":4663,"owners":',
            owners,
            ',"threshold":2,"nonce":',
            vm.toString(nonce),
            ',"fallbackHandler":"',
            vm.toString(SAFE_FALLBACK_HANDLER),
            '","guard":"0x0000000000000000000000000000000000000000",',
            '"modules":[],"moduleCursor":"0x0000000000000000000000000000000000000001",',
            '"dependencies":{"proxyFactoryCodeHash":"',
            vm.toString(SAFE_PROXY_FACTORY_CODE_HASH),
            '","singletonCodeHash":"',
            vm.toString(SAFE_SINGLETON_CODE_HASH),
            '","fallbackHandlerCodeHash":"',
            vm.toString(SAFE_FALLBACK_HANDLER_CODE_HASH),
            '"}}}'
        );
    }
}
