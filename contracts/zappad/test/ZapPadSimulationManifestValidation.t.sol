// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { DeployZapPad } from "../script/DeployZapPad.s.sol";

contract DeployZapPadManifestHarness is DeployZapPad {
    function validateReviewedDeploymentSimulationManifestJson(
        string memory manifestJson,
        bytes32 expectedManifestHash,
        address deployer,
        uint256 deployerNonce,
        address bootstrap,
        address tokenFactory,
        address feeVaultFactory,
        address launchpad,
        address treasury,
        bytes32 safeDeploymentEvidenceHash,
        string memory releaseCommit,
        bytes32 bootstrapInitCodeHash
    ) external view {
        StackPrediction memory predicted = StackPrediction({
            deployer: deployer,
            deployerNonce: deployerNonce,
            bootstrap: bootstrap,
            tokenFactory: tokenFactory,
            feeVaultFactory: feeVaultFactory,
            launchpad: launchpad
        });
        _validateReviewedDeploymentSimulationManifestJson(
            manifestJson,
            expectedManifestHash,
            predicted,
            treasury,
            safeDeploymentEvidenceHash,
            releaseCommit,
            bootstrapInitCodeHash
        );
    }

    function validateSimulatedDeploymentJson(
        string memory manifestJson,
        address bootstrap,
        address tokenFactory,
        address feeVaultFactory,
        address launchpad
    ) external view {
        _validateSimulatedDeploymentJson(manifestJson, bootstrap, tokenFactory, feeVaultFactory, launchpad);
    }

    function predictStack(address deployer)
        external
        view
        returns (
            uint256 deployerNonce,
            address bootstrap,
            address tokenFactory,
            address feeVaultFactory,
            address launchpad
        )
    {
        StackPrediction memory predicted = _predictStack(deployer);
        return (
            predicted.deployerNonce,
            predicted.bootstrap,
            predicted.tokenFactory,
            predicted.feeVaultFactory,
            predicted.launchpad
        );
    }
}

contract ZapPadSimulationManifestValidationTest is Test {
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

    uint256 internal constant DEPLOYER_NONCE = 17;
    uint256 internal constant SIMULATED_AT_BLOCK = 22_020_000;
    string internal constant RELEASE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct ManifestValues {
        string kind;
        uint256 schemaVersion;
        string status;
        uint256 chainId;
        string releaseCommit;
        address deployer;
        uint256 deployerNonce;
        address bootstrap;
        address launchpad;
        address tokenFactory;
        address feeVaultFactory;
        address treasury;
        bytes32 safeDeploymentEvidenceHash;
        bytes32 launchConfigDomain;
        bytes32 bootstrapInitCodeHash;
        bytes32 bootstrapCodeHash;
        bytes32 launchpadCodeHash;
        bytes32 tokenFactoryCodeHash;
        bytes32 feeVaultFactoryCodeHash;
        bytes32 positionManagerCodeHash;
        uint256 simulatedAtBlock;
    }

    DeployZapPadManifestHarness internal harness;
    ManifestValues internal values;

    function setUp() public {
        vm.chainId(4663);
        vm.roll(SIMULATED_AT_BLOCK + 10);
        harness = new DeployZapPadManifestHarness();
        values = ManifestValues({
            kind: "zappad-stack-deployment-simulation",
            schemaVersion: 1,
            status: "simulation-only",
            chainId: 4663,
            releaseCommit: RELEASE_COMMIT,
            deployer: makeAddr("deployer"),
            deployerNonce: DEPLOYER_NONCE,
            bootstrap: makeAddr("bootstrap"),
            launchpad: makeAddr("launchpad"),
            tokenFactory: makeAddr("token-factory"),
            feeVaultFactory: makeAddr("fee-vault-factory"),
            treasury: makeAddr("safe-treasury"),
            safeDeploymentEvidenceHash: keccak256("safe-deployment-evidence"),
            launchConfigDomain: keccak256("ZapPadLaunchConfig:v1"),
            bootstrapInitCodeHash: keccak256("bootstrap-init-code"),
            bootstrapCodeHash: keccak256("bootstrap-runtime"),
            launchpadCodeHash: keccak256("launchpad-runtime"),
            tokenFactoryCodeHash: keccak256("token-factory-runtime"),
            feeVaultFactoryCodeHash: keccak256("fee-vault-factory-runtime"),
            positionManagerCodeHash: POSITION_MANAGER_CODE_HASH,
            simulatedAtBlock: SIMULATED_AT_BLOCK
        });
    }

    function test_acceptsExactIndependentlyHashedReviewedSimulation() public {
        string memory json = _manifest(values);
        _validate(json, keccak256(bytes(json)));
    }

    function test_rejectsMissingOrWrongReviewedRawHash() public {
        string memory json = _manifest(values);

        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(json, bytes32(0));

        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(json, keccak256("different-reviewed-file"));
    }

    function test_rejectsIndependentlyHashedPredictionDrift() public {
        values.launchpad = makeAddr("different-launchpad");
        string memory json = _manifest(values);

        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(json, keccak256(bytes(json)));
    }

    function test_rejectsIndependentlyHashedReleaseOrInitCodeDrift() public {
        values.releaseCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        string memory wrongRelease = _manifest(values);
        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(wrongRelease, keccak256(bytes(wrongRelease)));

        values.releaseCommit = RELEASE_COMMIT;
        values.bootstrapInitCodeHash = keccak256("different-bootstrap-init-code");
        string memory wrongInitCode = _manifest(values);
        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(wrongInitCode, keccak256(bytes(wrongInitCode)));
    }

    function test_rejectsIndependentlyHashedSafeDependencyOrFutureBlockDrift() public {
        values.safeDeploymentEvidenceHash = keccak256("different-safe-evidence");
        string memory wrongSafe = _manifest(values);
        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(wrongSafe, keccak256(bytes(wrongSafe)));

        values.safeDeploymentEvidenceHash = keccak256("safe-deployment-evidence");
        values.positionManagerCodeHash = bytes32(uint256(1));
        string memory wrongDependency = _manifest(values);
        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(wrongDependency, keccak256(bytes(wrongDependency)));

        values.positionManagerCodeHash = POSITION_MANAGER_CODE_HASH;
        values.simulatedAtBlock = block.number + 1;
        string memory futureSimulation = _manifest(values);
        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        _validate(futureSimulation, keccak256(bytes(futureSimulation)));
    }

    function test_acceptsExactSimulatedRuntimeHashesAndRejectsCodeDrift() public {
        vm.etch(values.bootstrap, hex"6001600055");
        vm.etch(values.tokenFactory, hex"6002600055");
        vm.etch(values.feeVaultFactory, hex"6003600055");
        vm.etch(values.launchpad, hex"6004600055");
        values.bootstrapCodeHash = values.bootstrap.codehash;
        values.tokenFactoryCodeHash = values.tokenFactory.codehash;
        values.feeVaultFactoryCodeHash = values.feeVaultFactory.codehash;
        values.launchpadCodeHash = values.launchpad.codehash;

        string memory json = _manifest(values);
        harness.validateSimulatedDeploymentJson(
            json, values.bootstrap, values.tokenFactory, values.feeVaultFactory, values.launchpad
        );

        values.launchpadCodeHash = keccak256("drifted-launchpad-runtime");
        string memory driftedJson = _manifest(values);
        vm.expectPartialRevert(DeployZapPad.ReviewedDeploymentSimulationMismatch.selector);
        harness.validateSimulatedDeploymentJson(
            driftedJson, values.bootstrap, values.tokenFactory, values.feeVaultFactory, values.launchpad
        );
    }

    function test_predictsFreshBootstrapAndInternalCreateAddresses() public {
        // DEPLOYER_NONCE is a bounded test fixture and fits uint64 exactly.
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.setNonce(values.deployer, uint64(DEPLOYER_NONCE));
        (
            uint256 deployerNonce,
            address bootstrap,
            address tokenFactory,
            address feeVaultFactory,
            address launchpad
        ) = harness.predictStack(values.deployer);

        assertEq(deployerNonce, DEPLOYER_NONCE);
        assertEq(bootstrap, vm.computeCreateAddress(values.deployer, DEPLOYER_NONCE));
        assertEq(tokenFactory, vm.computeCreateAddress(bootstrap, 1));
        assertEq(feeVaultFactory, vm.computeCreateAddress(bootstrap, 2));
        assertEq(launchpad, vm.computeCreateAddress(bootstrap, 3));
    }

    function _validate(string memory manifestJson, bytes32 expectedManifestHash) private {
        harness.validateReviewedDeploymentSimulationManifestJson(
            manifestJson,
            expectedManifestHash,
            values.deployer,
            values.deployerNonce,
            makeAddr("bootstrap"),
            makeAddr("token-factory"),
            makeAddr("fee-vault-factory"),
            makeAddr("launchpad"),
            values.treasury,
            keccak256("safe-deployment-evidence"),
            RELEASE_COMMIT,
            keccak256("bootstrap-init-code")
        );
    }

    function _manifest(ManifestValues memory manifestValues) private returns (string memory json) {
        string memory root = "zappadSimulationManifestValidation";
        vm.serializeString(root, "kind", manifestValues.kind);
        vm.serializeUint(root, "schemaVersion", manifestValues.schemaVersion);
        vm.serializeString(root, "status", manifestValues.status);
        vm.serializeUint(root, "chainId", manifestValues.chainId);
        vm.serializeString(root, "releaseCommit", manifestValues.releaseCommit);
        vm.serializeAddress(root, "deployer", manifestValues.deployer);
        vm.serializeUint(root, "deployerNonce", manifestValues.deployerNonce);
        vm.serializeAddress(root, "bootstrap", manifestValues.bootstrap);
        vm.serializeAddress(root, "launchpad", manifestValues.launchpad);
        vm.serializeAddress(root, "tokenFactory", manifestValues.tokenFactory);
        vm.serializeAddress(root, "feeVaultFactory", manifestValues.feeVaultFactory);
        vm.serializeAddress(root, "protocolTreasury", manifestValues.treasury);
        vm.serializeBytes32(root, "safeDeploymentEvidenceHash", manifestValues.safeDeploymentEvidenceHash);
        vm.serializeBytes32(root, "launchConfigDomain", manifestValues.launchConfigDomain);
        vm.serializeBytes32(root, "bootstrapInitCodeHash", manifestValues.bootstrapInitCodeHash);
        vm.serializeBytes32(root, "bootstrapCodeHash", manifestValues.bootstrapCodeHash);
        vm.serializeBytes32(root, "launchpadCodeHash", manifestValues.launchpadCodeHash);
        vm.serializeBytes32(root, "tokenFactoryCodeHash", manifestValues.tokenFactoryCodeHash);
        vm.serializeBytes32(root, "feeVaultFactoryCodeHash", manifestValues.feeVaultFactoryCodeHash);
        vm.serializeAddress(root, "positionManager", POSITION_MANAGER);
        vm.serializeBytes32(root, "positionManagerCodeHash", manifestValues.positionManagerCodeHash);
        vm.serializeAddress(root, "v3Factory", V3_FACTORY);
        vm.serializeBytes32(root, "v3FactoryCodeHash", V3_FACTORY_CODE_HASH);
        vm.serializeAddress(root, "swapRouter", SWAP_ROUTER);
        vm.serializeBytes32(root, "swapRouterCodeHash", SWAP_ROUTER_CODE_HASH);
        vm.serializeAddress(root, "weth", WETH);
        vm.serializeBytes32(root, "wethCodeHash", WETH_CODE_HASH);
        vm.serializeAddress(root, "wethImplementation", WETH_IMPLEMENTATION);
        vm.serializeBytes32(root, "wethImplementationCodeHash", WETH_IMPLEMENTATION_CODE_HASH);
        vm.serializeAddress(root, "usdg", USDG);
        vm.serializeBytes32(root, "usdgCodeHash", USDG_CODE_HASH);
        vm.serializeAddress(root, "usdgImplementation", USDG_IMPLEMENTATION);
        vm.serializeBytes32(root, "usdgImplementationCodeHash", USDG_IMPLEMENTATION_CODE_HASH);
        json = vm.serializeUint(root, "simulatedAtBlock", manifestValues.simulatedAtBlock);
    }
}
