// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { ZapFeeVault } from "../src/ZapFeeVault.sol";
import { ZapPadLaunchpad } from "../src/ZapPadLaunchpad.sol";
import { ISwapRouter02 } from "../src/interfaces/IUniswapV3.sol";
import { ISafe } from "../src/interfaces/ISafe.sol";
import { ZapPadCanaryValidation } from "./lib/ZapPadCanaryValidation.sol";
import { ZapPadReleaseValidation } from "./lib/ZapPadReleaseValidation.sol";

contract PrepareZapPadCanaries is ZapPadReleaseValidation {
    using SafeERC20 for IERC20;

    uint24 internal constant FEE_TIER = 3000;
    int24 internal constant WETH_FLOOR_TICK = -276_300;
    int24 internal constant USDG_FLOOR_TICK = -460_020;
    uint256 internal constant MAX_WETH_PER_LEG = 0.001 ether;
    uint256 internal constant MAX_USDG_PER_LEG = 10_000_000;
    uint256 internal constant SHARE_TRANSFER = 10e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_REVIEWED_SLIPPAGE_BPS = 500;

    struct CanaryConfig {
        string name;
        string symbol;
        string metadataURI;
        address pair;
        int24 floorTick;
        uint256 firstBuyPairIn;
        uint256 minFirstBuyTokenOut;
        uint256 minFirstSellPairOut;
        uint256 minSecondBuyTokenOut;
        uint256 minSecondSellPairOut;
        bytes32 saltSeed;
    }

    struct CanaryEvidence {
        address token;
        address vault;
        address pool;
        uint256 positionId;
        address pair;
        bytes32 salt;
        uint256 firstBuyPairIn;
        uint256 firstBuyTokenOut;
        uint256 minFirstBuyTokenOut;
        uint256 firstSellTokenIn;
        uint256 firstSellPairOut;
        uint256 minFirstSellPairOut;
        uint256 firstHarvestToken;
        uint256 firstHarvestPair;
        uint256 secondBuyPairIn;
        uint256 secondBuyTokenOut;
        uint256 minSecondBuyTokenOut;
        uint256 secondSellTokenIn;
        uint256 secondSellPairOut;
        uint256 minSecondSellPairOut;
        uint256 secondHarvestToken;
        uint256 secondHarvestPair;
        ZapPadCanaryValidation.Distribution expected;
        uint256 creatorClaimedToken;
        uint256 creatorClaimedPair;
        uint256 treasuryTokenBalanceBefore;
        uint256 treasuryPairBalanceBefore;
        bytes32 configHash;
        uint64 launchedAt;
        ZapPadCanaryValidation.SafeClaimPlan safeClaim;
    }

    struct ReviewedSimulation {
        uint256 firstBuyTokenOut;
        uint256 firstSellTokenIn;
        uint256 firstSellPairOut;
        uint256 secondBuyPairIn;
        uint256 secondBuyTokenOut;
        uint256 secondSellTokenIn;
        uint256 secondSellPairOut;
    }

    error WrongChain();
    error InvalidConfiguration(bytes32 field);
    error ReadbackMismatch(bytes32 field);
    error CanaryAmountOutMismatch(uint256 returnedAmount, uint256 balanceDelta);
    error SaltNotFound();

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();

        ZapPadLaunchpad launchpad = ZapPadLaunchpad(vm.envAddress("ZAPPAD_LAUNCHPAD"));
        address treasury = vm.envAddress("SAFE_TREASURY");
        address creator = vm.envAddress("CANARY_CREATOR");
        _validateCanonicalReleaseState(launchpad, treasury);

        CanaryConfig memory wethConfig = _wethConfig();
        CanaryConfig memory usdgConfig = _usdgConfig();
        _validateConfig(wethConfig);
        _validateConfig(usdgConfig);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _validateReviewedPlan(launchpad, creator, treasury, wethConfig, usdgConfig);
        }

        vm.startBroadcast();
        (, address activeSender,) = vm.readCallers();
        if (activeSender != creator) revert ReadbackMismatch("broadcastSender");

        CanaryEvidence memory wethEvidence = _runCanary(launchpad, creator, treasury, wethConfig);
        CanaryEvidence memory usdgEvidence = _runCanary(launchpad, creator, treasury, usdgConfig);
        vm.stopBroadcast();

        ISafe safe = ISafe(treasury);
        uint256 safeNonce = safe.nonce();
        wethEvidence.safeClaim = ZapPadCanaryValidation.buildSafeClaimPlan(
            safe, ZapFeeVault(wethEvidence.vault), treasury, safeNonce
        );
        usdgEvidence.safeClaim = ZapPadCanaryValidation.buildSafeClaimPlan(
            safe, ZapFeeVault(usdgEvidence.vault), treasury, safeNonce + 1
        );
        if (
            wethEvidence.safeClaim.safeTransactionHash == bytes32(0)
                || usdgEvidence.safeClaim.safeTransactionHash == bytes32(0)
        ) revert ReadbackMismatch("safeTransactionHash");

        string memory manifest =
            _writeManifest(launchpad, creator, treasury, safeNonce, wethEvidence, usdgEvidence);
        console2.log("WETH canary token", wethEvidence.token);
        console2.log("USDG canary token", usdgEvidence.token);
        console2.log("Prepared evidence", manifest);
    }

    function _runCanary(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        CanaryConfig memory config
    ) private returns (CanaryEvidence memory evidence) {
        (bytes32 salt, address predictedToken) = _mineSalt(launchpad, creator, config);
        ZapPadLaunchpad.LaunchParams memory params = ZapPadLaunchpad.LaunchParams({
            name: config.name,
            symbol: config.symbol,
            metadataURI: config.metadataURI,
            salt: salt,
            floorTick: config.floorTick,
            pairedAsset: config.pair,
            feeTier: FEE_TIER,
            firstBuyPairIn: config.pair == WETH ? 0 : config.firstBuyPairIn,
            minFirstBuyTokensOut: config.minFirstBuyTokenOut
        });

        if (config.pair == USDG) {
            IERC20(USDG).forceApprove(address(launchpad), config.firstBuyPairIn);
        }
        (address tokenAddress, address vaultAddress) = config.pair == WETH
            ? launchpad.launch{ value: config.firstBuyPairIn }(params)
            : launchpad.launch(params);
        if (config.pair == USDG) IERC20(USDG).forceApprove(address(launchpad), 0);
        if (tokenAddress != predictedToken) revert ReadbackMismatch("predictedToken");

        evidence.token = tokenAddress;
        evidence.vault = vaultAddress;
        evidence.pair = config.pair;
        evidence.salt = salt;
        evidence.firstBuyPairIn = config.firstBuyPairIn;
        evidence.minFirstBuyTokenOut = config.minFirstBuyTokenOut;
        evidence.minFirstSellPairOut = config.minFirstSellPairOut;
        evidence.minSecondBuyTokenOut = config.minSecondBuyTokenOut;
        evidence.minSecondSellPairOut = config.minSecondSellPairOut;
        evidence.firstBuyTokenOut = IERC20(tokenAddress).balanceOf(creator);
        if (evidence.firstBuyTokenOut < config.minFirstBuyTokenOut) {
            revert ReadbackMismatch("firstBuyTokenOut");
        }
        uint256 firstBuyAmountIn;
        uint256 firstBuyAmountOut;
        (evidence.configHash, evidence.launchedAt, firstBuyAmountIn, firstBuyAmountOut) =
            launchpad.launchProvenance(tokenAddress);
        uint256 nativeValue = config.pair == WETH ? config.firstBuyPairIn : 0;
        if (
            evidence.configHash != launchpad.launchConfigHash(creator, params, nativeValue)
                || evidence.launchedAt == 0 || firstBuyAmountIn != config.firstBuyPairIn
                || firstBuyAmountOut != evidence.firstBuyTokenOut
        ) revert ReadbackMismatch("launchProvenance");

        (
            bool exists,
            address recordedCreator,
            address pool,
            address recordedVault,
            uint256 positionId,
            address recordedPair,
            uint24 feeTier,
            int24 floorTick
        ) = launchpad.launches(tokenAddress);
        if (
            !exists || recordedCreator != creator || recordedVault != vaultAddress
                || recordedPair != config.pair || feeTier != FEE_TIER || floorTick != config.floorTick
        ) revert ReadbackMismatch("launch");
        evidence.pool = pool;
        evidence.positionId = positionId;

        evidence.firstSellTokenIn = evidence.firstBuyTokenOut / 4;
        if (evidence.firstSellTokenIn == 0) revert InvalidConfiguration("firstSellTokenIn");
        evidence.firstSellPairOut = _swap(
            launchpad,
            creator,
            tokenAddress,
            config.pair,
            evidence.firstSellTokenIn,
            config.minFirstSellPairOut
        );

        ZapFeeVault vault = ZapFeeVault(vaultAddress);
        (evidence.firstHarvestToken, evidence.firstHarvestPair) = vault.harvest();
        if (evidence.firstHarvestToken == 0 || evidence.firstHarvestPair == 0) {
            revert ReadbackMismatch("firstHarvest");
        }
        ZapPadCanaryValidation.Distribution memory initial = ZapPadCanaryValidation.assertInitialDistribution(
            vault, creator, treasury, evidence.firstHarvestToken, evidence.firstHarvestPair
        );

        if (!vault.transfer(treasury, SHARE_TRANSFER)) revert ReadbackMismatch("shareTransfer");
        ZapPadCanaryValidation.assertTransferredShares(vault, creator, treasury, initial);

        evidence.secondBuyPairIn = evidence.firstSellPairOut / 2;
        _requirePairLegWithinCap(config.pair, evidence.secondBuyPairIn);
        evidence.secondBuyTokenOut = _swap(
            launchpad,
            creator,
            config.pair,
            tokenAddress,
            evidence.secondBuyPairIn,
            config.minSecondBuyTokenOut
        );
        evidence.secondSellTokenIn = evidence.secondBuyTokenOut / 2;
        if (evidence.secondSellTokenIn == 0) revert InvalidConfiguration("secondSellTokenIn");
        evidence.secondSellPairOut = _swap(
            launchpad,
            creator,
            tokenAddress,
            config.pair,
            evidence.secondSellTokenIn,
            config.minSecondSellPairOut
        );

        (evidence.secondHarvestToken, evidence.secondHarvestPair) = vault.harvest();
        if (evidence.secondHarvestToken == 0 || evidence.secondHarvestPair == 0) {
            revert ReadbackMismatch("secondHarvest");
        }
        evidence.expected = ZapPadCanaryValidation.assertPostTransferDistribution(
            vault, creator, treasury, initial, evidence.secondHarvestToken, evidence.secondHarvestPair
        );
        if (
            evidence.expected.creatorToken == 0 || evidence.expected.creatorPair == 0
                || evidence.expected.treasuryToken == 0 || evidence.expected.treasuryPair == 0
        ) revert ReadbackMismatch("nonzeroClaims");

        (evidence.creatorClaimedToken, evidence.creatorClaimedPair) = vault.claimAll(creator);
        ZapPadCanaryValidation.assertCreatorClaimed(
            vault, creator, evidence.creatorClaimedToken, evidence.creatorClaimedPair, evidence.expected
        );
        ZapPadCanaryValidation.assertTreasuryClaimable(vault, treasury, evidence.expected);
        ZapPadCanaryValidation.assertCustodyAndCleanup(
            launchpad, vault, creator, tokenAddress, config.pair, positionId
        );

        evidence.treasuryTokenBalanceBefore = IERC20(tokenAddress).balanceOf(treasury);
        evidence.treasuryPairBalanceBefore = IERC20(config.pair).balanceOf(treasury);
    }

    function _swap(
        ZapPadLaunchpad launchpad,
        address creator,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumOut
    ) private returns (uint256 amountOut) {
        if (amountIn == 0 || minimumOut == 0) revert InvalidConfiguration("swapAmount");
        ISwapRouter02 router = launchpad.swapRouter();
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(creator);
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: FEE_TIER,
                recipient: creator,
                amountIn: amountIn,
                amountOutMinimum: minimumOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(router), 0);
        uint256 balanceDelta = IERC20(tokenOut).balanceOf(creator) - balanceBefore;
        if (amountOut != balanceDelta) revert CanaryAmountOutMismatch(amountOut, balanceDelta);
    }

    function _mineSalt(ZapPadLaunchpad launchpad, address creator, CanaryConfig memory config)
        private
        view
        returns (bytes32 salt, address predicted)
    {
        uint256 start = uint256(config.saltSeed);
        for (uint256 i; i < 100_000; ++i) {
            salt = bytes32(start + i);
            predicted = launchpad.predictTokenAddress(
                creator, salt, config.name, config.symbol, config.metadataURI
            );
            if (predicted < config.pair && predicted.code.length == 0) return (salt, predicted);
        }
        revert SaltNotFound();
    }

    function _validateConfig(CanaryConfig memory config) private pure {
        _requirePairLegWithinCap(config.pair, config.firstBuyPairIn);
        if (
            config.minFirstBuyTokenOut == 0 || config.minFirstSellPairOut == 0
                || config.minSecondBuyTokenOut == 0 || config.minSecondSellPairOut == 0
        ) revert InvalidConfiguration("minimumOut");
    }

    function _validateReviewedPlan(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        CanaryConfig memory wethConfig,
        CanaryConfig memory usdgConfig
    ) private view {
        string memory plan = vm.readFile(vm.envString("CANARY_REVIEWED_PLAN"));
        bytes32 expectedHash = vm.envBytes32("EXPECTED_CANARY_REVIEWED_PLAN_HASH");
        string memory deploymentEvidence = vm.readFile(vm.envString("DEPLOYMENT_VERIFICATION_EVIDENCE"));
        bytes32 expectedDeploymentEvidenceHash =
            vm.envBytes32("EXPECTED_DEPLOYMENT_VERIFICATION_EVIDENCE_HASH");
        bytes32 deploymentEvidenceHash = keccak256(bytes(deploymentEvidence));
        string memory expectedReleaseCommit = vm.envString("EXPECTED_RELEASE_COMMIT");
        if (
            keccak256(bytes(plan)) != expectedHash || deploymentEvidenceHash != expectedDeploymentEvidenceHash
                || vm.parseJsonBytes32(plan, ".deploymentVerification.evidenceHash") != deploymentEvidenceHash
                || keccak256(bytes(vm.parseJsonString(plan, ".schema")))
                    != keccak256("zappad-reviewed-canary-plan/v2")
                || keccak256(bytes(vm.parseJsonString(plan, ".status")))
                    != keccak256("approved-for-broadcast")
                || vm.parseJsonUint(plan, ".chainId") != ROBINHOOD_CHAIN_ID
                || vm.parseJsonAddress(plan, ".launchpad") != address(launchpad)
                || vm.parseJsonAddress(plan, ".creator") != creator
                || vm.parseJsonAddress(plan, ".safeTreasury") != treasury
                || keccak256(bytes(vm.parseJsonString(plan, ".releaseCommit")))
                    != keccak256(bytes(expectedReleaseCommit))
                || vm.parseJsonUint(plan, ".maxSlippageBps") != MAX_REVIEWED_SLIPPAGE_BPS
                || keccak256(bytes(vm.parseJsonString(plan, ".ratios.firstSellFromFirstBuy")))
                    != keccak256("1/4")
                || keccak256(bytes(vm.parseJsonString(plan, ".ratios.secondBuyFromFirstSell")))
                    != keccak256("1/2")
                || keccak256(bytes(vm.parseJsonString(plan, ".ratios.secondSellFromSecondBuy")))
                    != keccak256("1/2")
                || keccak256(bytes(vm.parseJsonString(deploymentEvidence, ".kind")))
                    != keccak256("zappad-deployment-verification")
                || vm.parseJsonBool(deploymentEvidence, ".ok") != true
                || vm.parseJsonUint(deploymentEvidence, ".chainId") != ROBINHOOD_CHAIN_ID
                || vm.parseJsonAddress(deploymentEvidence, ".launchpad") != address(launchpad)
                || vm.parseJsonAddress(deploymentEvidence, ".protocolTreasury") != treasury
                || keccak256(bytes(vm.parseJsonString(deploymentEvidence, ".releaseCommit")))
                    != keccak256(bytes(expectedReleaseCommit))
                || vm.parseJsonUint(plan, ".deploymentVerification.checkedAtBlock")
                    != vm.parseJsonUint(deploymentEvidence, ".checkedAtBlock")
                || vm.parseJsonBytes32(plan, ".deploymentVerification.checkedAtBlockHash")
                    != vm.parseJsonBytes32(deploymentEvidence, ".checkedAtBlockHash")
                || vm.parseJsonBytes32(plan, ".deploymentVerification.transactionHash")
                    != vm.parseJsonBytes32(deploymentEvidence, ".deployment.transactionHash")
                || vm.parseJsonUint(plan, ".deploymentVerification.blockNumber")
                    != vm.parseJsonUint(deploymentEvidence, ".deployment.blockNumber")
                || vm.parseJsonBytes32(plan, ".deploymentVerification.blockHash")
                    != vm.parseJsonBytes32(deploymentEvidence, ".deployment.blockHash")
                || vm.parseJsonBytes32(plan, ".deploymentVerification.launchpadCodeHash")
                    != vm.parseJsonBytes32(deploymentEvidence, ".code.launchpad.codeHash")
        ) revert InvalidConfiguration("reviewedPlan");

        _validateReviewedCanary(plan, "weth", launchpad, creator, wethConfig);
        _validateReviewedCanary(plan, "usdg", launchpad, creator, usdgConfig);
    }

    function _validateReviewedCanary(
        string memory plan,
        string memory key,
        ZapPadLaunchpad launchpad,
        address creator,
        CanaryConfig memory config
    ) private view {
        string memory prefix = string.concat(".launches.", key, ".");
        string memory simulatedPrefix = string.concat(prefix, "simulated.");
        (bytes32 salt, address predictedToken) = _mineSalt(launchpad, creator, config);
        uint256 nativeValue = config.pair == WETH ? config.firstBuyPairIn : 0;
        if (
            vm.parseJsonAddress(plan, string.concat(prefix, "token")) != predictedToken
                || vm.parseJsonAddress(plan, string.concat(prefix, "pair")) != config.pair
                || vm.parseJsonBytes32(plan, string.concat(prefix, "salt")) != salt
                || vm.parseJsonUint(plan, string.concat(prefix, "feeTier")) != FEE_TIER
                || vm.parseJsonInt(plan, string.concat(prefix, "floorTick")) != config.floorTick
                || vm.parseJsonUint(plan, string.concat(prefix, "firstBuyPairIn")) != config.firstBuyPairIn
                || vm.parseJsonUint(plan, string.concat(prefix, "nativeValue")) != nativeValue
                || vm.parseJsonUint(plan, string.concat(prefix, "minFirstBuyTokenOut"))
                    != config.minFirstBuyTokenOut
                || vm.parseJsonUint(plan, string.concat(prefix, "minFirstSellPairOut"))
                    != config.minFirstSellPairOut
                || vm.parseJsonUint(plan, string.concat(prefix, "minSecondBuyTokenOut"))
                    != config.minSecondBuyTokenOut
                || vm.parseJsonUint(plan, string.concat(prefix, "minSecondSellPairOut"))
                    != config.minSecondSellPairOut
                || keccak256(bytes(vm.parseJsonString(plan, string.concat(prefix, "name"))))
                    != keccak256(bytes(config.name))
                || keccak256(bytes(vm.parseJsonString(plan, string.concat(prefix, "symbol"))))
                    != keccak256(bytes(config.symbol))
                || keccak256(bytes(vm.parseJsonString(plan, string.concat(prefix, "metadataURI"))))
                    != keccak256(bytes(config.metadataURI))
        ) revert InvalidConfiguration("reviewedCanary");

        ReviewedSimulation memory simulated = ReviewedSimulation({
            firstBuyTokenOut: vm.parseJsonUint(plan, string.concat(simulatedPrefix, "firstBuyTokenOut")),
            firstSellTokenIn: vm.parseJsonUint(plan, string.concat(simulatedPrefix, "firstSellTokenIn")),
            firstSellPairOut: vm.parseJsonUint(plan, string.concat(simulatedPrefix, "firstSellPairOut")),
            secondBuyPairIn: vm.parseJsonUint(plan, string.concat(simulatedPrefix, "secondBuyPairIn")),
            secondBuyTokenOut: vm.parseJsonUint(plan, string.concat(simulatedPrefix, "secondBuyTokenOut")),
            secondSellTokenIn: vm.parseJsonUint(plan, string.concat(simulatedPrefix, "secondSellTokenIn")),
            secondSellPairOut: vm.parseJsonUint(plan, string.concat(simulatedPrefix, "secondSellPairOut"))
        });
        _validateReviewedSimulation(config, simulated);
    }

    function _validateReviewedSimulation(CanaryConfig memory config, ReviewedSimulation memory simulated)
        internal
        pure
    {
        if (
            simulated.firstSellTokenIn == 0 || simulated.firstSellTokenIn != simulated.firstBuyTokenOut / 4
                || simulated.secondBuyPairIn == 0
                || simulated.secondBuyPairIn != simulated.firstSellPairOut / 2
                || simulated.secondSellTokenIn == 0
                || simulated.secondSellTokenIn != simulated.secondBuyTokenOut / 2
                || !_isReviewedMinimum(config.minFirstBuyTokenOut, simulated.firstBuyTokenOut)
                || !_isReviewedMinimum(config.minFirstSellPairOut, simulated.firstSellPairOut)
                || !_isReviewedMinimum(config.minSecondBuyTokenOut, simulated.secondBuyTokenOut)
                || !_isReviewedMinimum(config.minSecondSellPairOut, simulated.secondSellPairOut)
        ) revert InvalidConfiguration("reviewedSimulation");
    }

    function _isReviewedMinimum(uint256 minimum, uint256 simulatedOutput) private pure returns (bool) {
        return minimum != 0 && minimum <= simulatedOutput
            && minimum * BPS >= simulatedOutput * (BPS - MAX_REVIEWED_SLIPPAGE_BPS);
    }

    function _requirePairLegWithinCap(address pair, uint256 amount) private pure {
        uint256 cap = pair == WETH ? MAX_WETH_PER_LEG : MAX_USDG_PER_LEG;
        if (amount == 0 || amount > cap) revert InvalidConfiguration("pairLegCap");
    }

    function _wethConfig() private view returns (CanaryConfig memory config) {
        config = CanaryConfig({
            name: "ZapPad WETH Canary",
            symbol: "ZPWC",
            metadataURI: "urn:zappad:canary:weth:v1",
            pair: WETH,
            floorTick: WETH_FLOOR_TICK,
            firstBuyPairIn: vm.envUint("WETH_CANARY_FIRST_BUY_WEI"),
            minFirstBuyTokenOut: vm.envUint("WETH_CANARY_MIN_FIRST_BUY_TOKENS_OUT"),
            minFirstSellPairOut: vm.envUint("WETH_CANARY_MIN_FIRST_SELL_WETH_OUT"),
            minSecondBuyTokenOut: vm.envUint("WETH_CANARY_MIN_SECOND_BUY_TOKENS_OUT"),
            minSecondSellPairOut: vm.envUint("WETH_CANARY_MIN_SECOND_SELL_WETH_OUT"),
            saltSeed: vm.envOr("WETH_CANARY_SALT_SEED", keccak256("ZapPad WETH Canary v1"))
        });
    }

    function _usdgConfig() private view returns (CanaryConfig memory config) {
        config = CanaryConfig({
            name: "ZapPad USDG Canary",
            symbol: "ZPUC",
            metadataURI: "urn:zappad:canary:usdg:v1",
            pair: USDG,
            floorTick: USDG_FLOOR_TICK,
            firstBuyPairIn: vm.envUint("USDG_CANARY_FIRST_BUY"),
            minFirstBuyTokenOut: vm.envUint("USDG_CANARY_MIN_FIRST_BUY_TOKENS_OUT"),
            minFirstSellPairOut: vm.envUint("USDG_CANARY_MIN_FIRST_SELL_OUT"),
            minSecondBuyTokenOut: vm.envUint("USDG_CANARY_MIN_SECOND_BUY_TOKENS_OUT"),
            minSecondSellPairOut: vm.envUint("USDG_CANARY_MIN_SECOND_SELL_OUT"),
            saltSeed: vm.envOr("USDG_CANARY_SALT_SEED", keccak256("ZapPad USDG Canary v1"))
        });
    }

    function _writeManifest(
        ZapPadLaunchpad launchpad,
        address creator,
        address treasury,
        uint256 startingSafeNonce,
        CanaryEvidence memory wethEvidence,
        CanaryEvidence memory usdgEvidence
    ) private returns (string memory manifest) {
        string memory root = "canaries";
        vm.serializeString(root, "status", "simulation-only");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "launchpad", address(launchpad));
        vm.serializeAddress(root, "creator", creator);
        vm.serializeAddress(root, "safeTreasury", treasury);
        vm.serializeUint(root, "startingSafeNonce", startingSafeNonce);
        _serializeCanary(root, "weth", wethEvidence);
        _serializeCanary(root, "usdg", usdgEvidence);
        string memory json = vm.serializeUint(root, "simulatedAtBlock", block.number);

        manifest = vm.envOr(
            "CANARY_SIMULATION_MANIFEST",
            string.concat(
                "../../deployments/zappad/robinhood-canaries-", vm.toString(address(launchpad)), ".local.json"
            )
        );
        vm.writeJson(json, manifest);
    }

    function _serializeCanary(string memory root, string memory prefix, CanaryEvidence memory evidence)
        private
    {
        vm.serializeAddress(root, string.concat(prefix, "Token"), evidence.token);
        vm.serializeAddress(root, string.concat(prefix, "Vault"), evidence.vault);
        vm.serializeAddress(root, string.concat(prefix, "Pool"), evidence.pool);
        vm.serializeAddress(root, string.concat(prefix, "Pair"), evidence.pair);
        vm.serializeUint(root, string.concat(prefix, "PositionId"), evidence.positionId);
        vm.serializeBytes32(root, string.concat(prefix, "Salt"), evidence.salt);
        vm.serializeBytes32(root, string.concat(prefix, "ConfigHash"), evidence.configHash);
        vm.serializeUint(root, string.concat(prefix, "LaunchedAt"), evidence.launchedAt);
        vm.serializeUint(root, string.concat(prefix, "FirstBuyPairIn"), evidence.firstBuyPairIn);
        vm.serializeUint(root, string.concat(prefix, "FirstBuyTokenOut"), evidence.firstBuyTokenOut);
        vm.serializeUint(root, string.concat(prefix, "MinFirstBuyTokenOut"), evidence.minFirstBuyTokenOut);
        vm.serializeUint(root, string.concat(prefix, "FirstSellTokenIn"), evidence.firstSellTokenIn);
        vm.serializeUint(root, string.concat(prefix, "FirstSellPairOut"), evidence.firstSellPairOut);
        vm.serializeUint(root, string.concat(prefix, "MinFirstSellPairOut"), evidence.minFirstSellPairOut);
        vm.serializeUint(root, string.concat(prefix, "FirstHarvestToken"), evidence.firstHarvestToken);
        vm.serializeUint(root, string.concat(prefix, "FirstHarvestPair"), evidence.firstHarvestPair);
        vm.serializeUint(root, string.concat(prefix, "SecondBuyPairIn"), evidence.secondBuyPairIn);
        vm.serializeUint(root, string.concat(prefix, "SecondBuyTokenOut"), evidence.secondBuyTokenOut);
        vm.serializeUint(root, string.concat(prefix, "MinSecondBuyTokenOut"), evidence.minSecondBuyTokenOut);
        vm.serializeUint(root, string.concat(prefix, "SecondSellTokenIn"), evidence.secondSellTokenIn);
        vm.serializeUint(root, string.concat(prefix, "SecondSellPairOut"), evidence.secondSellPairOut);
        vm.serializeUint(root, string.concat(prefix, "MinSecondSellPairOut"), evidence.minSecondSellPairOut);
        vm.serializeUint(root, string.concat(prefix, "SecondHarvestToken"), evidence.secondHarvestToken);
        vm.serializeUint(root, string.concat(prefix, "SecondHarvestPair"), evidence.secondHarvestPair);
        vm.serializeUint(root, string.concat(prefix, "CreatorClaimedToken"), evidence.creatorClaimedToken);
        vm.serializeUint(root, string.concat(prefix, "CreatorClaimedPair"), evidence.creatorClaimedPair);
        vm.serializeUint(
            root, string.concat(prefix, "SafeClaimExpectedToken"), evidence.expected.treasuryToken
        );
        vm.serializeUint(root, string.concat(prefix, "SafeClaimExpectedPair"), evidence.expected.treasuryPair);
        vm.serializeUint(
            root, string.concat(prefix, "SafeTokenBalanceBefore"), evidence.treasuryTokenBalanceBefore
        );
        vm.serializeUint(
            root, string.concat(prefix, "SafePairBalanceBefore"), evidence.treasuryPairBalanceBefore
        );
        vm.serializeAddress(root, string.concat(prefix, "SafeClaimTarget"), evidence.safeClaim.target);
        vm.serializeBytes(root, string.concat(prefix, "SafeClaimData"), evidence.safeClaim.data);
        vm.serializeUint(root, string.concat(prefix, "SafeClaimNonce"), evidence.safeClaim.nonce);
        vm.serializeBytes32(
            root, string.concat(prefix, "SafeTransactionHash"), evidence.safeClaim.safeTransactionHash
        );
    }
}
