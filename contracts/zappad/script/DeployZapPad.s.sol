// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { ZapPadLaunchpad } from "../src/ZapPadLaunchpad.sol";
import { ZapTokenFactory } from "../src/ZapTokenFactory.sol";
import { ZapFeeVaultFactory } from "../src/ZapFeeVaultFactory.sol";
import { ZapPadBootstrap } from "../src/ZapPadBootstrap.sol";
import { SafeTreasuryDeployment } from "./lib/SafeTreasuryDeployment.sol";

contract DeployZapPad is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant DEPLOYMENT_SIMULATION_SCHEMA_VERSION = 1;
    bytes32 internal constant DEPLOYMENT_SIMULATION_KIND_HASH =
        keccak256("zappad-stack-deployment-simulation");
    bytes32 internal constant DEPLOYMENT_SIMULATION_STATUS_HASH = keccak256("simulation-only");
    bytes32 internal constant LAUNCH_CONFIG_DOMAIN = keccak256("ZapPadLaunchConfig:v1");
    bytes32 internal constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address internal constant POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    bytes32 internal constant POSITION_MANAGER_CODE_HASH =
        0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    bytes32 internal constant V3_FACTORY_CODE_HASH =
        0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739;
    address internal constant SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    bytes32 internal constant SWAP_ROUTER_CODE_HASH =
        0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    bytes32 internal constant WETH_CODE_HASH =
        0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353;
    address internal constant WETH_IMPLEMENTATION = 0xC6B81b429797E0f555440b70cD99e032D7AE947e;
    bytes32 internal constant WETH_IMPLEMENTATION_CODE_HASH =
        0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant USDG_CODE_HASH =
        0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6;
    address internal constant USDG_IMPLEMENTATION = 0x68184C449E1a8f34fA18d289737129FD27B66f8F;
    bytes32 internal constant USDG_IMPLEMENTATION_CODE_HASH =
        0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODE_HASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    bytes32 internal constant SAFE_SINGLETON_CODE_HASH =
        0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    bytes32 internal constant SAFE_FALLBACK_HANDLER_CODE_HASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;

    error WrongChain();
    error MissingDependencyCode(address dependency);
    error DependencyCodeHashMismatch(address dependency, bytes32 expected, bytes32 actual);
    error ReadbackMismatch();
    error SafePolicyMismatch();
    error MissingSafeDeploymentEvidence();
    error SafeDeploymentEvidenceHashMismatch();
    error SafeDeploymentEvidenceIdentityMismatch();
    error InvalidDeploymentDeployer();
    error InvalidDeploymentReleaseCommit();
    error PredictedDeploymentAddressNotFresh(address predicted);
    error ReviewedDeploymentSimulationMismatch(bytes32 field);

    struct StackPrediction {
        address deployer;
        uint256 deployerNonce;
        address bootstrap;
        address tokenFactory;
        address feeVaultFactory;
        address launchpad;
    }

    function run() external returns (ZapPadLaunchpad launchpad) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();
        _requireCodeHash(POSITION_MANAGER, POSITION_MANAGER_CODE_HASH);
        _requireCodeHash(V3_FACTORY, V3_FACTORY_CODE_HASH);
        _requireCodeHash(SWAP_ROUTER, SWAP_ROUTER_CODE_HASH);
        _requireCodeHash(WETH, WETH_CODE_HASH);
        _requireCodeHash(USDG, USDG_CODE_HASH);
        _requireProxyImplementation(WETH, WETH_IMPLEMENTATION, WETH_IMPLEMENTATION_CODE_HASH);
        _requireProxyImplementation(USDG, USDG_IMPLEMENTATION, USDG_IMPLEMENTATION_CODE_HASH);

        address treasury = vm.envAddress("PROTOCOL_TREASURY");
        _verifyTreasury(treasury);
        bytes32 safeDeploymentEvidenceHash = _safeDeploymentEvidenceHash(treasury);
        string memory releaseCommit = vm.envString("EXPECTED_RELEASE_COMMIT");
        if (!_isFullGitCommit(releaseCommit)) revert InvalidDeploymentReleaseCommit();

        StackPrediction memory predicted = _predictStack(vm.envAddress("DEPLOYER_ADDRESS"));
        _requireFreshPredictions(predicted);
        bytes32 bootstrapInitCodeHash = _bootstrapInitCodeHash(treasury);
        bool isBroadcast = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        string memory manifest = isBroadcast
            ? vm.envString("DEPLOYMENT_SIMULATION_MANIFEST")
            : vm.envOr(
                "DEPLOYMENT_SIMULATION_MANIFEST",
                string.concat(
                    "../../deployments/zappad/robinhood-mainnet-",
                    vm.toString(predicted.launchpad),
                    ".local.json"
                )
            );
        string memory reviewedManifestJson;
        if (isBroadcast) {
            reviewedManifestJson = vm.readFile(manifest);
            _validateReviewedDeploymentSimulationManifestJson(
                reviewedManifestJson,
                vm.envBytes32("EXPECTED_DEPLOYMENT_SIMULATION_MANIFEST_HASH"),
                predicted,
                treasury,
                safeDeploymentEvidenceHash,
                releaseCommit,
                bootstrapInitCodeHash
            );
        }

        vm.startBroadcast(predicted.deployer);
        ZapPadBootstrap bootstrap = new ZapPadBootstrap(treasury, POSITION_MANAGER, SWAP_ROUTER, WETH, USDG);
        vm.stopBroadcast();

        launchpad = ZapPadLaunchpad(bootstrap.launchpad());
        ZapTokenFactory tokenFactory = ZapTokenFactory(bootstrap.tokenFactory());
        ZapFeeVaultFactory feeVaultFactory = ZapFeeVaultFactory(bootstrap.feeVaultFactory());

        if (
            launchpad.protocolTreasury() != treasury
                || address(launchpad.positionManager()) != POSITION_MANAGER
                || address(launchpad.v3Factory()) != V3_FACTORY
                || address(launchpad.swapRouter()) != SWAP_ROUTER || launchpad.weth() != WETH
                || launchpad.usdg() != USDG || tokenFactory.launchpad() != address(launchpad)
                || feeVaultFactory.launchpad() != address(launchpad)
                || launchpad.LAUNCH_CONFIG_DOMAIN() != LAUNCH_CONFIG_DOMAIN
                || address(bootstrap) != predicted.bootstrap
                || address(tokenFactory) != predicted.tokenFactory
                || address(feeVaultFactory) != predicted.feeVaultFactory
                || address(launchpad) != predicted.launchpad
        ) revert ReadbackMismatch();

        if (isBroadcast) {
            _validateSimulatedDeploymentJson(
                reviewedManifestJson,
                address(bootstrap),
                address(tokenFactory),
                address(feeVaultFactory),
                address(launchpad)
            );
        } else {
            _writeDeploymentSimulationManifest(
                manifest,
                predicted,
                treasury,
                safeDeploymentEvidenceHash,
                releaseCommit,
                bootstrapInitCodeHash,
                address(bootstrap),
                address(tokenFactory),
                address(feeVaultFactory),
                address(launchpad)
            );
        }

        console2.log("ZapPadLaunchpad", address(launchpad));
        console2.log(isBroadcast ? "Reviewed simulation manifest" : "Simulation manifest", manifest);
    }

    function _predictStack(address deployer) internal view returns (StackPrediction memory predicted) {
        if (deployer == address(0)) revert InvalidDeploymentDeployer();
        predicted.deployer = deployer;
        predicted.deployerNonce = vm.getNonce(deployer);
        predicted.bootstrap = vm.computeCreateAddress(deployer, predicted.deployerNonce);
        predicted.tokenFactory = vm.computeCreateAddress(predicted.bootstrap, 1);
        predicted.feeVaultFactory = vm.computeCreateAddress(predicted.bootstrap, 2);
        predicted.launchpad = vm.computeCreateAddress(predicted.bootstrap, 3);
    }

    function _requireFreshPredictions(StackPrediction memory predicted) internal view {
        if (predicted.bootstrap.code.length != 0) {
            revert PredictedDeploymentAddressNotFresh(predicted.bootstrap);
        }
        if (predicted.tokenFactory.code.length != 0) {
            revert PredictedDeploymentAddressNotFresh(predicted.tokenFactory);
        }
        if (predicted.feeVaultFactory.code.length != 0) {
            revert PredictedDeploymentAddressNotFresh(predicted.feeVaultFactory);
        }
        if (predicted.launchpad.code.length != 0) {
            revert PredictedDeploymentAddressNotFresh(predicted.launchpad);
        }
    }

    function _bootstrapInitCodeHash(address treasury) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(ZapPadBootstrap).creationCode,
                abi.encode(treasury, POSITION_MANAGER, SWAP_ROUTER, WETH, USDG)
            )
        );
    }

    function _isFullGitCommit(string memory value) internal pure returns (bool) {
        bytes memory raw = bytes(value);
        if (raw.length != 40) return false;
        for (uint256 i; i < raw.length; ++i) {
            bytes1 character = raw[i];
            bool decimal = character >= 0x30 && character <= 0x39;
            bool lowercase = character >= 0x61 && character <= 0x66;
            bool uppercase = character >= 0x41 && character <= 0x46;
            if (!decimal && !lowercase && !uppercase) return false;
        }
        return true;
    }

    function _writeDeploymentSimulationManifest(
        string memory manifest,
        StackPrediction memory predicted,
        address treasury,
        bytes32 safeDeploymentEvidenceHash,
        string memory releaseCommit,
        bytes32 bootstrapInitCodeHash,
        address bootstrap,
        address tokenFactory,
        address feeVaultFactory,
        address launchpadAddress
    ) internal {
        string memory root = "deployment";
        vm.serializeString(root, "kind", "zappad-stack-deployment-simulation");
        vm.serializeUint(root, "schemaVersion", DEPLOYMENT_SIMULATION_SCHEMA_VERSION);
        vm.serializeString(root, "status", "simulation-only");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "releaseCommit", releaseCommit);
        vm.serializeAddress(root, "deployer", predicted.deployer);
        vm.serializeUint(root, "deployerNonce", predicted.deployerNonce);
        vm.serializeAddress(root, "bootstrap", bootstrap);
        vm.serializeAddress(root, "launchpad", launchpadAddress);
        vm.serializeAddress(root, "tokenFactory", tokenFactory);
        vm.serializeAddress(root, "feeVaultFactory", feeVaultFactory);
        vm.serializeAddress(root, "protocolTreasury", treasury);
        vm.serializeBytes32(root, "safeDeploymentEvidenceHash", safeDeploymentEvidenceHash);
        vm.serializeBytes32(root, "launchConfigDomain", LAUNCH_CONFIG_DOMAIN);
        vm.serializeBytes32(root, "bootstrapInitCodeHash", bootstrapInitCodeHash);
        vm.serializeBytes32(root, "bootstrapCodeHash", bootstrap.codehash);
        vm.serializeBytes32(root, "launchpadCodeHash", launchpadAddress.codehash);
        vm.serializeBytes32(root, "tokenFactoryCodeHash", tokenFactory.codehash);
        vm.serializeBytes32(root, "feeVaultFactoryCodeHash", feeVaultFactory.codehash);
        vm.serializeAddress(root, "positionManager", POSITION_MANAGER);
        vm.serializeBytes32(root, "positionManagerCodeHash", POSITION_MANAGER.codehash);
        vm.serializeAddress(root, "v3Factory", V3_FACTORY);
        vm.serializeBytes32(root, "v3FactoryCodeHash", V3_FACTORY.codehash);
        vm.serializeAddress(root, "swapRouter", SWAP_ROUTER);
        vm.serializeBytes32(root, "swapRouterCodeHash", SWAP_ROUTER.codehash);
        vm.serializeAddress(root, "weth", WETH);
        vm.serializeBytes32(root, "wethCodeHash", WETH.codehash);
        vm.serializeAddress(root, "wethImplementation", WETH_IMPLEMENTATION);
        vm.serializeBytes32(root, "wethImplementationCodeHash", WETH_IMPLEMENTATION.codehash);
        vm.serializeAddress(root, "usdg", USDG);
        vm.serializeBytes32(root, "usdgCodeHash", USDG.codehash);
        vm.serializeAddress(root, "usdgImplementation", USDG_IMPLEMENTATION);
        vm.serializeBytes32(root, "usdgImplementationCodeHash", USDG_IMPLEMENTATION.codehash);
        string memory json = vm.serializeUint(root, "simulatedAtBlock", block.number);
        vm.writeJson(json, manifest);
    }

    function _validateReviewedDeploymentSimulationManifestJson(
        string memory manifestJson,
        bytes32 expectedManifestHash,
        StackPrediction memory predicted,
        address treasury,
        bytes32 safeDeploymentEvidenceHash,
        string memory releaseCommit,
        bytes32 bootstrapInitCodeHash
    ) internal view {
        if (expectedManifestHash == bytes32(0) || keccak256(bytes(manifestJson)) != expectedManifestHash) {
            revert ReviewedDeploymentSimulationMismatch("rawHash");
        }
        if (
            keccak256(bytes(vm.parseJsonString(manifestJson, ".kind"))) != DEPLOYMENT_SIMULATION_KIND_HASH
                || vm.parseJsonUint(manifestJson, ".schemaVersion") != DEPLOYMENT_SIMULATION_SCHEMA_VERSION
                || keccak256(bytes(vm.parseJsonString(manifestJson, ".status")))
                    != DEPLOYMENT_SIMULATION_STATUS_HASH
        ) revert ReviewedDeploymentSimulationMismatch("identity");
        if (
            vm.parseJsonUint(manifestJson, ".chainId") != ROBINHOOD_CHAIN_ID
                || !_isFullGitCommit(releaseCommit)
                || keccak256(bytes(vm.parseJsonString(manifestJson, ".releaseCommit")))
                    != keccak256(bytes(releaseCommit))
        ) revert ReviewedDeploymentSimulationMismatch("chainOrRelease");
        if (
            vm.parseJsonAddress(manifestJson, ".deployer") != predicted.deployer
                || vm.parseJsonUint(manifestJson, ".deployerNonce") != predicted.deployerNonce
                || vm.parseJsonAddress(manifestJson, ".bootstrap") != predicted.bootstrap
                || vm.parseJsonAddress(manifestJson, ".tokenFactory") != predicted.tokenFactory
                || vm.parseJsonAddress(manifestJson, ".feeVaultFactory") != predicted.feeVaultFactory
                || vm.parseJsonAddress(manifestJson, ".launchpad") != predicted.launchpad
        ) revert ReviewedDeploymentSimulationMismatch("predictions");
        if (
            vm.parseJsonAddress(manifestJson, ".protocolTreasury") != treasury
                || vm.parseJsonBytes32(manifestJson, ".safeDeploymentEvidenceHash")
                    != safeDeploymentEvidenceHash
                || vm.parseJsonBytes32(manifestJson, ".launchConfigDomain") != LAUNCH_CONFIG_DOMAIN
                || vm.parseJsonBytes32(manifestJson, ".bootstrapInitCodeHash") != bootstrapInitCodeHash
        ) revert ReviewedDeploymentSimulationMismatch("stackIdentity");
        if (
            vm.parseJsonBytes32(manifestJson, ".bootstrapCodeHash") == bytes32(0)
                || vm.parseJsonBytes32(manifestJson, ".launchpadCodeHash") == bytes32(0)
                || vm.parseJsonBytes32(manifestJson, ".tokenFactoryCodeHash") == bytes32(0)
                || vm.parseJsonBytes32(manifestJson, ".feeVaultFactoryCodeHash") == bytes32(0)
        ) revert ReviewedDeploymentSimulationMismatch("runtimeCode");
        if (
            vm.parseJsonAddress(manifestJson, ".positionManager") != POSITION_MANAGER
                || vm.parseJsonBytes32(manifestJson, ".positionManagerCodeHash") != POSITION_MANAGER_CODE_HASH
                || vm.parseJsonAddress(manifestJson, ".v3Factory") != V3_FACTORY
                || vm.parseJsonBytes32(manifestJson, ".v3FactoryCodeHash") != V3_FACTORY_CODE_HASH
                || vm.parseJsonAddress(manifestJson, ".swapRouter") != SWAP_ROUTER
                || vm.parseJsonBytes32(manifestJson, ".swapRouterCodeHash") != SWAP_ROUTER_CODE_HASH
                || vm.parseJsonAddress(manifestJson, ".weth") != WETH
                || vm.parseJsonBytes32(manifestJson, ".wethCodeHash") != WETH_CODE_HASH
                || vm.parseJsonAddress(manifestJson, ".wethImplementation") != WETH_IMPLEMENTATION
                || vm.parseJsonBytes32(manifestJson, ".wethImplementationCodeHash")
                    != WETH_IMPLEMENTATION_CODE_HASH || vm.parseJsonAddress(manifestJson, ".usdg") != USDG
                || vm.parseJsonBytes32(manifestJson, ".usdgCodeHash") != USDG_CODE_HASH
                || vm.parseJsonAddress(manifestJson, ".usdgImplementation") != USDG_IMPLEMENTATION
                || vm.parseJsonBytes32(manifestJson, ".usdgImplementationCodeHash")
                    != USDG_IMPLEMENTATION_CODE_HASH
        ) revert ReviewedDeploymentSimulationMismatch("dependencies");

        uint256 simulatedAtBlock = vm.parseJsonUint(manifestJson, ".simulatedAtBlock");
        if (simulatedAtBlock == 0 || simulatedAtBlock > block.number) {
            revert ReviewedDeploymentSimulationMismatch("simulatedAtBlock");
        }
    }

    function _validateSimulatedDeploymentJson(
        string memory manifestJson,
        address bootstrap,
        address tokenFactory,
        address feeVaultFactory,
        address launchpadAddress
    ) internal view {
        if (
            bootstrap.code.length == 0 || tokenFactory.code.length == 0 || feeVaultFactory.code.length == 0
                || launchpadAddress.code.length == 0
                || vm.parseJsonAddress(manifestJson, ".bootstrap") != bootstrap
                || vm.parseJsonAddress(manifestJson, ".tokenFactory") != tokenFactory
                || vm.parseJsonAddress(manifestJson, ".feeVaultFactory") != feeVaultFactory
                || vm.parseJsonAddress(manifestJson, ".launchpad") != launchpadAddress
                || vm.parseJsonBytes32(manifestJson, ".bootstrapCodeHash") != bootstrap.codehash
                || vm.parseJsonBytes32(manifestJson, ".tokenFactoryCodeHash") != tokenFactory.codehash
                || vm.parseJsonBytes32(manifestJson, ".feeVaultFactoryCodeHash") != feeVaultFactory.codehash
                || vm.parseJsonBytes32(manifestJson, ".launchpadCodeHash") != launchpadAddress.codehash
        ) revert ReviewedDeploymentSimulationMismatch("deployedCode");
    }

    function _requireCodeHash(address dependency, bytes32 expected) private view {
        if (dependency.code.length == 0) revert MissingDependencyCode(dependency);
        bytes32 actual = dependency.codehash;
        if (actual != expected) revert DependencyCodeHashMismatch(dependency, expected, actual);
    }

    /// @dev Production deployment is deliberately inseparable from a fresh,
    /// canonical 2-of-3 Safe. A historical-fork-only test harness overrides
    /// this hook; the production script has no boolean bypass.
    function _verifyTreasury(address treasury) internal virtual {
        _requireCodeHash(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_CODE_HASH);
        _requireCodeHash(SAFE_SINGLETON, SAFE_SINGLETON_CODE_HASH);
        _requireCodeHash(SAFE_FALLBACK_HANDLER, SAFE_FALLBACK_HANDLER_CODE_HASH);

        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envUint("SAFE_THRESHOLD");
        uint256 saltNonce = vm.envUint("SAFE_SALT_NONCE");
        if (owners.length != 3 || threshold != 2) revert SafePolicyMismatch();

        bytes memory setupData = SafeTreasuryDeployment.initializer(owners, threshold, SAFE_FALLBACK_HANDLER);
        address predicted =
            SafeTreasuryDeployment.predict(SAFE_PROXY_FACTORY, SAFE_SINGLETON, setupData, saltNonce);
        SafeTreasuryDeployment.verify(
            treasury,
            predicted,
            SAFE_SINGLETON,
            SAFE_FALLBACK_HANDLER,
            owners,
            threshold,
            ROBINHOOD_CHAIN_ID,
            true
        );
    }

    function _safeDeploymentEvidenceHash(address treasury) internal virtual returns (bytes32 evidenceHash) {
        bytes32 reviewedHash = vm.envBytes32("SAFE_DEPLOYMENT_EVIDENCE_HASH");
        if (reviewedHash == bytes32(0)) revert MissingSafeDeploymentEvidence();

        string memory evidenceJson = vm.readFile(vm.envString("SAFE_DEPLOYMENT_EVIDENCE"));
        evidenceHash = keccak256(bytes(evidenceJson));
        if (evidenceHash != reviewedHash) revert SafeDeploymentEvidenceHashMismatch();
        if (
            !vm.parseJsonBool(evidenceJson, ".ok")
                || keccak256(bytes(vm.parseJsonString(evidenceJson, ".kind")))
                    != keccak256("zappad-safe-deployment-verification")
                || vm.parseJsonUint(evidenceJson, ".schemaVersion") != 1
                || vm.parseJsonUint(evidenceJson, ".chainId") != ROBINHOOD_CHAIN_ID
                || keccak256(bytes(vm.parseJsonString(evidenceJson, ".releaseCommit")))
                    != keccak256(bytes(vm.envString("EXPECTED_RELEASE_COMMIT")))
                || vm.parseJsonAddress(evidenceJson, ".config.safe") != treasury
                || !vm.parseJsonBool(evidenceJson, ".deployment.proxyCreationEventVerified")
                || !vm.parseJsonBool(evidenceJson, ".deployment.absentAtPreviousBlock")
        ) revert SafeDeploymentEvidenceIdentityMismatch();
    }

    function _requireProxyImplementation(
        address proxy,
        address expectedImplementation,
        bytes32 expectedCodeHash
    ) private view {
        address actualImplementation = address(uint160(uint256(vm.load(proxy, EIP1967_IMPLEMENTATION_SLOT))));
        if (actualImplementation != expectedImplementation) revert ReadbackMismatch();
        _requireCodeHash(actualImplementation, expectedCodeHash);
    }
}
