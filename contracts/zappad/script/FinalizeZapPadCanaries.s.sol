// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Script, console2 } from "forge-std/Script.sol";
import { ZapFeeVault } from "../src/ZapFeeVault.sol";
import { ZapPadLaunchpad } from "../src/ZapPadLaunchpad.sol";
import { ISafe } from "../src/interfaces/ISafe.sol";
import { ZapPadCanaryValidation } from "./lib/ZapPadCanaryValidation.sol";
import { ReviewedArtifact } from "./lib/ReviewedArtifact.sol";

contract FinalizeZapPadCanaries is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint24 internal constant FEE_TIER = 3000;
    int24 internal constant WETH_FLOOR_TICK = -276_300;
    int24 internal constant USDG_FLOOR_TICK = -460_020;

    struct CanaryRecord {
        address token;
        address vault;
        address pool;
        address pair;
        uint256 positionId;
        uint256 expectedSafeToken;
        uint256 expectedSafePair;
        uint256 safeTokenBalanceBefore;
        uint256 safePairBalanceBefore;
        address safeClaimTarget;
        bytes safeClaimData;
        uint256 safeClaimNonce;
        bytes32 safeTransactionHash;
    }

    error WrongChain();
    error InvalidPreparedEvidence();
    error MissingExecutionTransactionHash();
    error EvidenceAlreadyExists(string manifest);

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();

        string memory preparedManifest = vm.envString("CANARY_PREPARED_MANIFEST");
        string memory preparedJson = vm.readFile(preparedManifest);
        bytes32 preparedHash = ReviewedArtifact.requireExpectedHash(
            preparedJson, vm.envBytes32("EXPECTED_CANARY_PREPARED_MANIFEST_HASH")
        );
        if (
            keccak256(bytes(vm.parseJsonString(preparedJson, ".kind")))
                    != keccak256("zappad-canary-prepared-safe-claims")
                || vm.parseJsonUint(preparedJson, ".schemaVersion") != 1
                || keccak256(bytes(vm.parseJsonString(preparedJson, ".status")))
                    != keccak256("prepared-safe-claims-pending")
        ) revert InvalidPreparedEvidence();
        string memory releaseCommit = vm.parseJsonString(preparedJson, ".releaseCommit");
        if (bytes(releaseCommit).length != 40) revert InvalidPreparedEvidence();

        ZapPadLaunchpad launchpad = ZapPadLaunchpad(vm.parseJsonAddress(preparedJson, ".launchpad"));
        address creator = vm.parseJsonAddress(preparedJson, ".creator");
        address treasury = vm.parseJsonAddress(preparedJson, ".safeTreasury");
        uint256 startingSafeNonce = vm.parseJsonUint(preparedJson, ".startingSafeNonce");
        CanaryRecord memory wethRecord = _parseCanary(preparedJson, "weth");
        CanaryRecord memory usdgRecord = _parseCanary(preparedJson, "usdg");
        _validatePreparedRecords(launchpad, creator, treasury, startingSafeNonce, wethRecord, usdgRecord);

        string memory receiptEvidence = vm.envString("CANARY_SAFE_RECEIPT_EVIDENCE");
        string memory receiptEvidenceJson = vm.readFile(receiptEvidence);
        bytes32 receiptEvidenceHash = ReviewedArtifact.requireExpectedHash(
            receiptEvidenceJson, vm.envBytes32("EXPECTED_CANARY_SAFE_RECEIPT_EVIDENCE_HASH")
        );
        bytes32 wethExecutionTxHash =
            vm.parseJsonBytes32(receiptEvidenceJson, ".executions.weth.outerTransactionHash");
        bytes32 usdgExecutionTxHash =
            vm.parseJsonBytes32(receiptEvidenceJson, ".executions.usdg.outerTransactionHash");
        if (
            !vm.parseJsonBool(receiptEvidenceJson, ".ok")
                || keccak256(bytes(vm.parseJsonString(receiptEvidenceJson, ".kind")))
                    != keccak256("zappad-safe-canary-receipts")
                || vm.parseJsonUint(receiptEvidenceJson, ".chainId") != ROBINHOOD_CHAIN_ID
                || keccak256(bytes(vm.parseJsonString(receiptEvidenceJson, ".releaseCommit")))
                    != keccak256(bytes(releaseCommit))
                || vm.parseJsonAddress(receiptEvidenceJson, ".safe") != treasury
                || vm.parseJsonBytes32(receiptEvidenceJson, ".preparedManifestHash") != preparedHash
                || wethExecutionTxHash == bytes32(0) || usdgExecutionTxHash == bytes32(0)
                || wethExecutionTxHash == usdgExecutionTxHash
        ) revert MissingExecutionTransactionHash();
        if (
            address(launchpad).code.length == 0 || launchpad.protocolTreasury() != treasury
                || ISafe(treasury).nonce() != startingSafeNonce + 2
        ) revert InvalidPreparedEvidence();

        _assertFinalized(launchpad, creator, treasury, wethRecord);
        _assertFinalized(launchpad, creator, treasury, usdgRecord);

        string memory manifest = _writeManifest(
            preparedManifest,
            preparedJson,
            preparedHash,
            launchpad,
            creator,
            treasury,
            wethRecord,
            usdgRecord,
            wethExecutionTxHash,
            usdgExecutionTxHash,
            receiptEvidence,
            receiptEvidenceHash
        );
        console2.log("Final canary evidence", manifest);
    }

    function _validatePreparedRecords(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        uint256 startingSafeNonce,
        CanaryRecord memory wethRecord,
        CanaryRecord memory usdgRecord
    ) private view {
        if (
            wethRecord.pair != WETH || usdgRecord.pair != USDG || wethRecord.token == usdgRecord.token
                || wethRecord.vault == usdgRecord.vault || wethRecord.pool == usdgRecord.pool
                || wethRecord.positionId == usdgRecord.positionId
                || wethRecord.safeTransactionHash == usdgRecord.safeTransactionHash
                || wethRecord.safeClaimNonce != startingSafeNonce
                || usdgRecord.safeClaimNonce != startingSafeNonce + 1
        ) revert InvalidPreparedEvidence();

        _validatePreparedRecord(launchpad, creator, treasury, wethRecord);
        _validatePreparedRecord(launchpad, creator, treasury, usdgRecord);
    }

    function _validatePreparedRecord(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        CanaryRecord memory record
    ) private view {
        if (
            record.token == address(0) || record.vault == address(0) || record.pool == address(0)
                || record.positionId == 0 || record.expectedSafeToken == 0 || record.expectedSafePair == 0
                || record.safeClaimTarget != record.vault || record.safeClaimData.length == 0
                || record.safeTransactionHash == bytes32(0)
        ) revert InvalidPreparedEvidence();

        bytes memory expectedClaimData = abi.encodeCall(ZapFeeVault.claimAll, (treasury));
        if (keccak256(record.safeClaimData) != keccak256(expectedClaimData)) {
            revert InvalidPreparedEvidence();
        }
        bytes32 expectedSafeTransactionHash = ISafe(treasury)
            .getTransactionHash(
                record.vault,
                0,
                record.safeClaimData,
                0,
                0,
                0,
                0,
                address(0),
                address(0),
                record.safeClaimNonce
            );
        if (expectedSafeTransactionHash != record.safeTransactionHash) {
            revert InvalidPreparedEvidence();
        }

        (
            bool exists,
            address recordedCreator,
            address recordedPool,
            address recordedVault,
            uint256 recordedPositionId,
            address recordedPair,
            uint24 recordedFeeTier,
            int24 recordedFloorTick
        ) = launchpad.launches(record.token);
        int24 expectedFloorTick = record.pair == WETH ? WETH_FLOOR_TICK : USDG_FLOOR_TICK;
        ZapFeeVault vault = ZapFeeVault(record.vault);
        if (
            !exists || recordedCreator != creator || recordedPool != record.pool
                || recordedVault != record.vault || recordedPositionId != record.positionId
                || recordedPair != record.pair || recordedFeeTier != FEE_TIER
                || recordedFloorTick != expectedFloorTick || address(vault).code.length == 0
                || vault.launchpad() != address(launchpad) || vault.launchToken() != record.token
                || vault.pairedAsset() != record.pair || vault.positionId() != record.positionId
        ) revert InvalidPreparedEvidence();
    }

    function _assertFinalized(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        CanaryRecord memory record
    ) private view {
        ZapPadCanaryValidation.Distribution memory expected =
            ZapPadCanaryValidation.Distribution({
                creatorToken: 0,
                creatorPair: 0,
                treasuryToken: record.expectedSafeToken,
                treasuryPair: record.expectedSafePair
            });
        ZapPadCanaryValidation.assertFinalized(
            launchpad,
            ZapFeeVault(record.vault),
            creator,
            treasury,
            record.token,
            record.pair,
            record.positionId,
            expected,
            record.safeTokenBalanceBefore,
            record.safePairBalanceBefore
        );
    }

    function _parseCanary(string memory json, string memory prefix)
        private
        pure
        returns (CanaryRecord memory record)
    {
        record = CanaryRecord({
            token: vm.parseJsonAddress(json, string.concat(".", prefix, "Token")),
            vault: vm.parseJsonAddress(json, string.concat(".", prefix, "Vault")),
            pool: vm.parseJsonAddress(json, string.concat(".", prefix, "Pool")),
            pair: vm.parseJsonAddress(json, string.concat(".", prefix, "Pair")),
            positionId: vm.parseJsonUint(json, string.concat(".", prefix, "PositionId")),
            expectedSafeToken: vm.parseJsonUint(json, string.concat(".", prefix, "SafeClaimExpectedToken")),
            expectedSafePair: vm.parseJsonUint(json, string.concat(".", prefix, "SafeClaimExpectedPair")),
            safeTokenBalanceBefore: vm.parseJsonUint(
                json, string.concat(".", prefix, "SafeTokenBalanceBefore")
            ),
            safePairBalanceBefore: vm.parseJsonUint(
                json, string.concat(".", prefix, "SafePairBalanceBefore")
            ),
            safeClaimTarget: vm.parseJsonAddress(json, string.concat(".", prefix, "SafeClaimTarget")),
            safeClaimData: vm.parseJsonBytes(json, string.concat(".", prefix, "SafeClaimData")),
            safeClaimNonce: vm.parseJsonUint(json, string.concat(".", prefix, "SafeClaimNonce")),
            safeTransactionHash: vm.parseJsonBytes32(json, string.concat(".", prefix, "SafeTransactionHash"))
        });
    }

    function _writeManifest(
        string memory preparedManifest,
        string memory preparedJson,
        bytes32 preparedHash,
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        CanaryRecord memory wethRecord,
        CanaryRecord memory usdgRecord,
        bytes32 wethExecutionTxHash,
        bytes32 usdgExecutionTxHash,
        string memory receiptEvidence,
        bytes32 receiptEvidenceHash
    ) private returns (string memory manifest) {
        string memory root = "finalCanaries";
        vm.serializeString(root, "status", "complete");
        vm.serializeString(root, "releaseCommit", vm.parseJsonString(preparedJson, ".releaseCommit"));
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "preparedManifest", preparedManifest);
        vm.serializeBytes32(root, "preparedManifestHash", preparedHash);
        vm.serializeAddress(root, "launchpad", address(launchpad));
        vm.serializeAddress(root, "creator", creator);
        vm.serializeAddress(root, "safeTreasury", treasury);
        vm.serializeUint(root, "safeNonceAfterClaims", ISafe(treasury).nonce());
        vm.serializeString(root, "safeReceiptEvidence", receiptEvidence);
        vm.serializeBytes32(root, "safeReceiptEvidenceHash", receiptEvidenceHash);
        _serializeFinalCanary(root, "weth", wethRecord, treasury, wethExecutionTxHash);
        _serializeFinalCanary(root, "usdg", usdgRecord, treasury, usdgExecutionTxHash);
        string memory json = vm.serializeUint(root, "completedAtBlock", block.number);

        manifest = vm.envOr(
            "CANARY_FINAL_MANIFEST",
            string.concat(
                "../../deployments/zappad/robinhood-canaries-final-",
                vm.toString(address(launchpad)),
                "-",
                vm.toString(block.number),
                ".json"
            )
        );
        if (vm.exists(manifest)) revert EvidenceAlreadyExists(manifest);
        vm.writeJson(json, manifest);
    }

    function _serializeFinalCanary(
        string memory root,
        string memory prefix,
        CanaryRecord memory record,
        address treasury,
        bytes32 executionTxHash
    ) private {
        vm.serializeAddress(root, string.concat(prefix, "Token"), record.token);
        vm.serializeAddress(root, string.concat(prefix, "Vault"), record.vault);
        vm.serializeAddress(root, string.concat(prefix, "Pool"), record.pool);
        vm.serializeAddress(root, string.concat(prefix, "Pair"), record.pair);
        vm.serializeUint(root, string.concat(prefix, "PositionId"), record.positionId);
        vm.serializeBytes32(root, string.concat(prefix, "SafeExecutionTransactionHash"), executionTxHash);
        vm.serializeUint(
            root, string.concat(prefix, "SafeTokenBalanceAfter"), IERC20(record.token).balanceOf(treasury)
        );
        vm.serializeUint(
            root, string.concat(prefix, "SafePairBalanceAfter"), IERC20(record.pair).balanceOf(treasury)
        );
        vm.serializeUint(
            root, string.concat(prefix, "VaultTokenDust"), IERC20(record.token).balanceOf(record.vault)
        );
        vm.serializeUint(
            root, string.concat(prefix, "VaultPairDust"), IERC20(record.pair).balanceOf(record.vault)
        );
    }
}
