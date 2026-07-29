// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { console2 } from "forge-std/Script.sol";
import { ZapFeeVault } from "../src/ZapFeeVault.sol";
import { ZapPadLaunchpad } from "../src/ZapPadLaunchpad.sol";
import { ISafe } from "../src/interfaces/ISafe.sol";
import { ZapPadCanaryValidation } from "./lib/ZapPadCanaryValidation.sol";
import { ReviewedArtifact } from "./lib/ReviewedArtifact.sol";
import { ZapPadReleaseValidation } from "./lib/ZapPadReleaseValidation.sol";

/// @notice Builds authoritative prepared-canary evidence from confirmed chain state.
contract ObservePreparedCanaries is ZapPadReleaseValidation {
    uint24 internal constant FEE_TIER = 3000;
    int24 internal constant WETH_FLOOR_TICK = -276_300;
    int24 internal constant USDG_FLOOR_TICK = -460_020;
    uint256 internal constant MAX_WETH_FIRST_BUY = 0.001 ether;
    uint256 internal constant MAX_USDG_FIRST_BUY = 10_000_000;
    bytes32 internal constant CANARY_POLICY_HASH =
        0x9062beeef85a7c54503cb506efa26e015ff6d142471b12d0aee14e2ef836735a;

    struct ObservedCanary {
        address token;
        address vault;
        address pool;
        address pair;
        uint256 positionId;
        uint256 safeClaimExpectedToken;
        uint256 safeClaimExpectedPair;
        uint256 safeTokenBalanceBefore;
        uint256 safePairBalanceBefore;
        bytes32 configHash;
        uint64 launchedAt;
        uint256 firstBuyAmountIn;
        uint256 firstBuyAmountOut;
        uint256 minFirstBuyTokensOut;
        uint256 nativeValue;
        ZapPadCanaryValidation.SafeClaimPlan safeClaim;
    }

    struct ExpectedProvenance {
        bytes32 configHash;
        uint64 launchedAt;
        uint256 firstBuyAmountIn;
        uint256 firstBuyAmountOut;
        uint256 minFirstBuyTokensOut;
        uint256 nativeValue;
    }

    struct LaunchRecord {
        address pool;
        address vault;
        address pair;
        uint256 positionId;
    }

    error WrongChain();
    error InvalidStack();
    error InvalidCanary(bytes32 field);
    error EvidenceAlreadyExists(string manifest);

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();

        ZapPadLaunchpad launchpad = ZapPadLaunchpad(vm.envAddress("ZAPPAD_LAUNCHPAD"));
        address treasury = vm.envAddress("SAFE_TREASURY");
        address creator = vm.envAddress("CANARY_CREATOR");
        string memory broadcastEvidence = vm.envString("CANARY_BROADCAST_EVIDENCE");
        string memory broadcastEvidenceJson = vm.readFile(broadcastEvidence);
        bytes32 broadcastEvidenceHash = ReviewedArtifact.requireExpectedHash(
            broadcastEvidenceJson, vm.envBytes32("EXPECTED_CANARY_BROADCAST_EVIDENCE_HASH")
        );
        ReleaseBinding memory release = _validateCanonicalReleaseState(launchpad, treasury);
        address wethCanaryToken = vm.parseJsonAddress(broadcastEvidenceJson, ".launches.weth.token");
        address usdgCanaryToken = vm.parseJsonAddress(broadcastEvidenceJson, ".launches.usdg.token");
        _validateBroadcastEvidence(
            broadcastEvidenceJson, launchpad, creator, treasury, wethCanaryToken, usdgCanaryToken, release
        );

        ISafe safe = ISafe(treasury);
        uint256 startingSafeNonce = safe.nonce();
        ObservedCanary memory wethRecord = _observe(
            launchpad,
            creator,
            treasury,
            wethCanaryToken,
            WETH,
            WETH_FLOOR_TICK,
            startingSafeNonce,
            _readExpectedProvenance(broadcastEvidenceJson, ".launches.weth")
        );
        ObservedCanary memory usdgRecord = _observe(
            launchpad,
            creator,
            treasury,
            usdgCanaryToken,
            USDG,
            USDG_FLOOR_TICK,
            startingSafeNonce + 1,
            _readExpectedProvenance(broadcastEvidenceJson, ".launches.usdg")
        );
        if (
            wethRecord.token == usdgRecord.token || wethRecord.vault == usdgRecord.vault
                || wethRecord.pool == usdgRecord.pool || wethRecord.positionId == usdgRecord.positionId
        ) revert InvalidCanary("distinctRecords");

        string memory manifest = _writeManifest(
            launchpad,
            creator,
            treasury,
            startingSafeNonce,
            broadcastEvidence,
            broadcastEvidenceHash,
            release,
            wethRecord,
            usdgRecord
        );
        console2.log("Observed prepared canaries", manifest);
    }

    function _observe(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        address token,
        address expectedPair,
        int24 expectedFloorTick,
        uint256 safeNonce,
        ExpectedProvenance memory expectedProvenance
    ) private view returns (ObservedCanary memory record) {
        LaunchRecord memory launch = _readLaunch(launchpad, creator, token, expectedPair, expectedFloorTick);
        ZapFeeVault vault = ZapFeeVault(launch.vault);
        _validateVault(launchpad, vault, creator, treasury, token, launch.pair, launch.positionId);
        (uint256 safeTokenClaim, uint256 safePairClaim) =
            _claimState(vault, creator, treasury, token, launch.pair);

        _assertConserved(vault, token);
        _assertConserved(vault, launch.pair);
        ZapPadCanaryValidation.assertCustodyAndCleanup(
            launchpad, vault, creator, token, launch.pair, launch.positionId
        );
        (bytes32 configHash, uint64 launchedAt, uint256 firstBuyAmountIn, uint256 firstBuyAmountOut) =
            launchpad.launchProvenance(token);
        if (
            configHash != expectedProvenance.configHash || launchedAt != expectedProvenance.launchedAt
                || firstBuyAmountIn != expectedProvenance.firstBuyAmountIn
                || firstBuyAmountOut != expectedProvenance.firstBuyAmountOut || configHash == bytes32(0)
                || launchedAt == 0 || firstBuyAmountIn == 0 || firstBuyAmountOut == 0
                || firstBuyAmountOut < expectedProvenance.minFirstBuyTokensOut
                || expectedProvenance.minFirstBuyTokensOut == 0
                || firstBuyAmountIn > (expectedPair == WETH ? MAX_WETH_FIRST_BUY : MAX_USDG_FIRST_BUY)
                || (expectedPair == WETH
                        ? expectedProvenance.nativeValue != firstBuyAmountIn
                        : expectedProvenance.nativeValue != 0)
        ) revert InvalidCanary("provenance");

        record.token = token;
        record.vault = launch.vault;
        record.pool = launch.pool;
        record.pair = launch.pair;
        record.positionId = launch.positionId;
        record.safeClaimExpectedToken = safeTokenClaim;
        record.safeClaimExpectedPair = safePairClaim;
        record.safeTokenBalanceBefore = IERC20(token).balanceOf(treasury);
        record.safePairBalanceBefore = IERC20(launch.pair).balanceOf(treasury);
        record.configHash = configHash;
        record.launchedAt = launchedAt;
        record.firstBuyAmountIn = firstBuyAmountIn;
        record.firstBuyAmountOut = firstBuyAmountOut;
        record.minFirstBuyTokensOut = expectedProvenance.minFirstBuyTokensOut;
        record.nativeValue = expectedProvenance.nativeValue;
        record.safeClaim =
            ZapPadCanaryValidation.buildSafeClaimPlan(ISafe(treasury), vault, treasury, safeNonce);
    }

    function _readLaunch(
        ZapPadLaunchpad launchpad,
        address creator,
        address token,
        address expectedPair,
        int24 expectedFloorTick
    ) private view returns (LaunchRecord memory record) {
        (
            bool exists,
            address recordedCreator,
            address pool,
            address vaultAddress,
            uint256 positionId,
            address pair,
            uint24 feeTier,
            int24 floorTick
        ) = launchpad.launches(token);
        if (
            token.code.length == 0 || !exists || recordedCreator != creator || pool.code.length == 0
                || vaultAddress.code.length == 0 || pair != expectedPair || feeTier != FEE_TIER
                || floorTick != expectedFloorTick || positionId == 0
        ) revert InvalidCanary("launchRecord");

        record.pool = pool;
        record.vault = vaultAddress;
        record.pair = pair;
        record.positionId = positionId;
    }

    function _validateVault(
        ZapPadLaunchpad launchpad,
        ZapFeeVault vault,
        address creator,
        address treasury,
        address token,
        address pair,
        uint256 positionId
    ) private view {
        if (
            vault.launchpad() != address(launchpad) || vault.launchToken() != token
                || vault.pairedAsset() != pair || vault.positionId() != positionId
                || vault.totalSupply() != 100e18 || vault.balanceOf(creator) != 70e18
                || vault.balanceOf(treasury) != 30e18
        ) revert InvalidCanary("vaultRecord");
    }

    function _claimState(ZapFeeVault vault, address creator, address treasury, address token, address pair)
        private
        view
        returns (uint256 safeTokenClaim, uint256 safePairClaim)
    {
        safeTokenClaim = vault.claimable(treasury, token);
        safePairClaim = vault.claimable(treasury, pair);
        if (
            safeTokenClaim == 0 || safePairClaim == 0 || vault.claimable(creator, token) != 0
                || vault.claimable(creator, pair) != 0
        ) revert InvalidCanary("claimState");
    }

    function _assertConserved(ZapFeeVault vault, address asset) private view {
        (, uint256 lastBalance, uint256 totalSynced, uint256 totalClaimed) = vault.assetState(asset);
        if (
            lastBalance != IERC20(asset).balanceOf(address(vault))
                || totalSynced != totalClaimed + lastBalance
        ) revert InvalidCanary("conservation");
    }

    function _readExpectedProvenance(string memory evidence, string memory prefix)
        private
        pure
        returns (ExpectedProvenance memory expected)
    {
        expected.configHash = vm.parseJsonBytes32(evidence, string.concat(prefix, ".configHash"));
        uint256 launchedAt = vm.parseJsonUint(evidence, string.concat(prefix, ".launchedAt"));
        if (launchedAt > type(uint64).max) revert InvalidCanary("launchedAt");
        // Safe after the explicit uint64 bound above.
        // forge-lint: disable-next-line(unsafe-typecast)
        expected.launchedAt = uint64(launchedAt);
        expected.firstBuyAmountIn = vm.parseJsonUint(evidence, string.concat(prefix, ".firstBuyAmountIn"));
        expected.firstBuyAmountOut = vm.parseJsonUint(evidence, string.concat(prefix, ".firstBuyAmountOut"));
        expected.minFirstBuyTokensOut =
            vm.parseJsonUint(evidence, string.concat(prefix, ".minFirstBuyTokensOut"));
        expected.nativeValue = vm.parseJsonUint(evidence, string.concat(prefix, ".nativeValue"));
    }

    function _validateBroadcastEvidence(
        string memory evidence,
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        address wethCanaryToken,
        address usdgCanaryToken,
        ReleaseBinding memory release
    ) private pure {
        if (
            bytes(evidence).length == 0 || !vm.parseJsonBool(evidence, ".ok")
                || keccak256(bytes(vm.parseJsonString(evidence, ".kind")))
                    != keccak256("zappad-canary-creator-broadcast")
                || vm.parseJsonUint(evidence, ".chainId") != ROBINHOOD_CHAIN_ID
                || vm.parseJsonAddress(evidence, ".creator") != creator
                || vm.parseJsonAddress(evidence, ".launchpad") != address(launchpad)
                || vm.parseJsonAddress(evidence, ".safeTreasury") != treasury
                || vm.parseJsonUint(evidence, ".transactionCount") != 30 || wethCanaryToken == address(0)
                || usdgCanaryToken == address(0) || wethCanaryToken == usdgCanaryToken
                || vm.parseJsonAddress(evidence, ".launches.weth.pair") != WETH
                || vm.parseJsonAddress(evidence, ".launches.usdg.pair") != USDG
                || vm.parseJsonUint(evidence, ".launches.weth.feeTier") != FEE_TIER
                || vm.parseJsonUint(evidence, ".launches.usdg.feeTier") != FEE_TIER
                || vm.parseJsonInt(evidence, ".launches.weth.floorTick") != WETH_FLOOR_TICK
                || vm.parseJsonInt(evidence, ".launches.usdg.floorTick") != USDG_FLOOR_TICK
                || vm.parseJsonBytes32(evidence, ".launches.weth.configHash") == bytes32(0)
                || vm.parseJsonBytes32(evidence, ".launches.usdg.configHash") == bytes32(0)
                || vm.parseJsonUint(evidence, ".launches.weth.launchedAt") == 0
                || vm.parseJsonUint(evidence, ".launches.usdg.launchedAt") == 0
                || vm.parseJsonBytes32(evidence, ".canaryPolicyHash") != CANARY_POLICY_HASH
                || vm.parseJsonBytes32(evidence, ".reviewedPlanHash") == bytes32(0)
                || vm.parseJsonBytes32(evidence, ".deploymentVerificationEvidenceHash")
                    != release.deploymentVerificationEvidenceHash
                || vm.parseJsonBytes32(evidence, ".checkedAtBlockHash") == bytes32(0)
                || vm.parseJsonBytes32(evidence, ".launches.weth.transactionHash")
                    == vm.parseJsonBytes32(evidence, ".launches.usdg.transactionHash")
                || keccak256(bytes(vm.parseJsonString(evidence, ".releaseCommit")))
                    != keccak256(bytes(release.releaseCommit))
        ) revert InvalidCanary("broadcastEvidence");
    }

    function _writeManifest(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        uint256 startingSafeNonce,
        string memory broadcastEvidence,
        bytes32 broadcastEvidenceHash,
        ReleaseBinding memory release,
        ObservedCanary memory wethRecord,
        ObservedCanary memory usdgRecord
    ) private returns (string memory manifest) {
        string memory root = "observedCanaries";
        vm.serializeString(root, "status", "prepared-safe-claims-pending");
        vm.serializeString(root, "kind", "zappad-canary-prepared-safe-claims");
        vm.serializeUint(root, "schemaVersion", 1);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "releaseCommit", release.releaseCommit);
        vm.serializeAddress(root, "launchpad", address(launchpad));
        vm.serializeAddress(root, "creator", creator);
        vm.serializeAddress(root, "safeTreasury", treasury);
        vm.serializeUint(root, "startingSafeNonce", startingSafeNonce);
        vm.serializeString(root, "broadcastEvidence", broadcastEvidence);
        vm.serializeBytes32(root, "broadcastEvidenceHash", broadcastEvidenceHash);
        vm.serializeBytes32(root, "safeDeploymentEvidenceHash", release.safeDeploymentEvidenceHash);
        vm.serializeBytes32(
            root, "deploymentVerificationEvidenceHash", release.deploymentVerificationEvidenceHash
        );
        _serializeCanary(root, "weth", wethRecord);
        _serializeCanary(root, "usdg", usdgRecord);
        string memory json = vm.serializeUint(root, "observedAtBlock", block.number);

        manifest = vm.envOr(
            "CANARY_PREPARED_MANIFEST",
            string.concat(
                "../../deployments/zappad/robinhood-canaries-prepared-",
                vm.toString(address(launchpad)),
                "-",
                vm.toString(block.number),
                ".json"
            )
        );
        if (vm.exists(manifest)) revert EvidenceAlreadyExists(manifest);
        vm.writeJson(json, manifest);
    }

    function _serializeCanary(string memory root, string memory prefix, ObservedCanary memory record)
        private
    {
        vm.serializeAddress(root, string.concat(prefix, "Token"), record.token);
        vm.serializeAddress(root, string.concat(prefix, "Vault"), record.vault);
        vm.serializeAddress(root, string.concat(prefix, "Pool"), record.pool);
        vm.serializeAddress(root, string.concat(prefix, "Pair"), record.pair);
        vm.serializeUint(root, string.concat(prefix, "PositionId"), record.positionId);
        vm.serializeUint(root, string.concat(prefix, "SafeClaimExpectedToken"), record.safeClaimExpectedToken);
        vm.serializeUint(root, string.concat(prefix, "SafeClaimExpectedPair"), record.safeClaimExpectedPair);
        vm.serializeUint(root, string.concat(prefix, "SafeTokenBalanceBefore"), record.safeTokenBalanceBefore);
        vm.serializeUint(root, string.concat(prefix, "SafePairBalanceBefore"), record.safePairBalanceBefore);
        vm.serializeBytes32(root, string.concat(prefix, "ConfigHash"), record.configHash);
        vm.serializeUint(root, string.concat(prefix, "LaunchedAt"), record.launchedAt);
        vm.serializeUint(root, string.concat(prefix, "FirstBuyAmountIn"), record.firstBuyAmountIn);
        vm.serializeUint(root, string.concat(prefix, "FirstBuyAmountOut"), record.firstBuyAmountOut);
        vm.serializeUint(root, string.concat(prefix, "MinFirstBuyTokensOut"), record.minFirstBuyTokensOut);
        vm.serializeUint(root, string.concat(prefix, "NativeValue"), record.nativeValue);
        vm.serializeAddress(root, string.concat(prefix, "SafeClaimTarget"), record.safeClaim.target);
        vm.serializeBytes(root, string.concat(prefix, "SafeClaimData"), record.safeClaim.data);
        vm.serializeUint(root, string.concat(prefix, "SafeClaimNonce"), record.safeClaim.nonce);
        vm.serializeBytes32(
            root, string.concat(prefix, "SafeTransactionHash"), record.safeClaim.safeTransactionHash
        );
    }
}
