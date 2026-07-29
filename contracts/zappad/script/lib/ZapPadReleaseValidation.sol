// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script } from "forge-std/Script.sol";
import { ZapPadLaunchpad } from "../../src/ZapPadLaunchpad.sol";
import { SafeTreasuryDeployment } from "./SafeTreasuryDeployment.sol";
import { ReviewedArtifact } from "./ReviewedArtifact.sol";

abstract contract ZapPadReleaseValidation is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
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
    address internal constant SAFE_SENTINEL = address(0x1);

    bytes32 private constant DEPLOYMENT_EVIDENCE_KIND_HASH = keccak256("zappad-deployment-verification");
    bytes32 private constant SAFE_EVIDENCE_KIND_HASH = keccak256("zappad-safe-deployment-verification");
    bytes32 private constant SAFE_VERSION_HASH = keccak256("1.4.1");

    struct ReleaseBinding {
        bytes32 safeDeploymentEvidenceHash;
        bytes32 deploymentVerificationEvidenceHash;
        string releaseCommit;
    }

    struct SafeEvidenceBinding {
        address[] owners;
        bytes32 runtimeCodeHash;
    }

    error InvalidReleaseState(bytes32 field);
    error DependencyCodeHashMismatch(address dependency, bytes32 expected, bytes32 actual);

    function _validateCanonicalReleaseState(ZapPadLaunchpad launchpad, address treasury)
        internal
        view
        returns (ReleaseBinding memory binding)
    {
        _validateCanonicalDependencies(launchpad, treasury);

        string memory deploymentEvidence = vm.readFile(vm.envString("DEPLOYMENT_VERIFICATION_EVIDENCE"));
        bytes32 deploymentEvidenceHash = ReviewedArtifact.requireExpectedHash(
            deploymentEvidence, vm.envBytes32("EXPECTED_DEPLOYMENT_VERIFICATION_EVIDENCE_HASH")
        );
        string memory safeEvidence = vm.readFile(vm.envString("SAFE_DEPLOYMENT_EVIDENCE"));
        bytes32 safeEvidenceHash = ReviewedArtifact.requireExpectedHash(
            safeEvidence, vm.envBytes32("SAFE_DEPLOYMENT_EVIDENCE_HASH")
        );
        string memory expectedReleaseCommit = vm.envString("EXPECTED_RELEASE_COMMIT");

        SafeEvidenceBinding memory safeBinding;
        (binding, safeBinding) = _validateReleaseEvidenceJson(
            deploymentEvidence,
            deploymentEvidenceHash,
            safeEvidence,
            safeEvidenceHash,
            expectedReleaseCommit,
            address(launchpad),
            treasury
        );

        _requireCodeHash(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_CODE_HASH);
        _requireCodeHash(SAFE_SINGLETON, SAFE_SINGLETON_CODE_HASH);
        _requireCodeHash(SAFE_FALLBACK_HANDLER, SAFE_FALLBACK_HANDLER_CODE_HASH);
        if (treasury.codehash != safeBinding.runtimeCodeHash) {
            revert DependencyCodeHashMismatch(treasury, safeBinding.runtimeCodeHash, treasury.codehash);
        }
        SafeTreasuryDeployment.verify(
            treasury,
            treasury,
            SAFE_SINGLETON,
            SAFE_FALLBACK_HANDLER,
            safeBinding.owners,
            2,
            ROBINHOOD_CHAIN_ID,
            true
        );
    }

    function _validateReleaseEvidenceJson(
        string memory deploymentEvidence,
        bytes32 deploymentEvidenceHash,
        string memory safeEvidence,
        bytes32 safeEvidenceHash,
        string memory expectedReleaseCommit,
        address launchpad,
        address treasury
    ) internal view returns (ReleaseBinding memory binding, SafeEvidenceBinding memory safeBinding) {
        if (!_isFullGitCommit(expectedReleaseCommit)) {
            revert InvalidReleaseState("releaseCommit");
        }
        if (
            !vm.parseJsonBool(deploymentEvidence, ".ok")
                || keccak256(bytes(vm.parseJsonString(deploymentEvidence, ".kind")))
                    != DEPLOYMENT_EVIDENCE_KIND_HASH
                || vm.parseJsonUint(deploymentEvidence, ".chainId") != ROBINHOOD_CHAIN_ID
                || vm.parseJsonAddress(deploymentEvidence, ".launchpad") != launchpad
                || vm.parseJsonAddress(deploymentEvidence, ".protocolTreasury") != treasury
                || keccak256(bytes(vm.parseJsonString(deploymentEvidence, ".releaseCommit")))
                    != keccak256(bytes(expectedReleaseCommit))
                || vm.parseJsonBytes32(deploymentEvidence, ".safeDeploymentEvidenceHash") != safeEvidenceHash
        ) revert InvalidReleaseState("deploymentEvidence");
        if (
            !vm.parseJsonBool(safeEvidence, ".ok")
                || keccak256(bytes(vm.parseJsonString(safeEvidence, ".kind"))) != SAFE_EVIDENCE_KIND_HASH
                || vm.parseJsonUint(safeEvidence, ".schemaVersion") != 1
                || vm.parseJsonUint(safeEvidence, ".chainId") != ROBINHOOD_CHAIN_ID
                || keccak256(bytes(vm.parseJsonString(safeEvidence, ".releaseCommit")))
                    != keccak256(bytes(expectedReleaseCommit))
                || vm.parseJsonAddress(safeEvidence, ".config.safe") != treasury
                || vm.parseJsonUint(safeEvidence, ".config.threshold") != 2
                || vm.parseJsonAddress(safeEvidence, ".config.proxyFactory") != SAFE_PROXY_FACTORY
                || vm.parseJsonAddress(safeEvidence, ".config.singleton") != SAFE_SINGLETON
                || vm.parseJsonAddress(safeEvidence, ".config.fallbackHandler") != SAFE_FALLBACK_HANDLER
        ) revert InvalidReleaseState("safeEvidence");

        address[] memory configOwners = vm.parseJsonAddressArray(safeEvidence, ".config.owners");
        address[] memory stateOwners = vm.parseJsonAddressArray(safeEvidence, ".safeState.owners");
        address[] memory modules = vm.parseJsonAddressArray(safeEvidence, ".safeState.modules");
        if (configOwners.length == 3) {
            SafeTreasuryDeployment.validateConfig(configOwners, 2);
        }
        if (
            configOwners.length != 3 || !_sameOwnerSet(configOwners, stateOwners)
                || vm.parseJsonAddress(safeEvidence, ".safeState.address") != treasury
                || vm.parseJsonAddress(safeEvidence, ".safeState.singleton") != SAFE_SINGLETON
                || keccak256(bytes(vm.parseJsonString(safeEvidence, ".safeState.version")))
                    != SAFE_VERSION_HASH
                || vm.parseJsonUint(safeEvidence, ".safeState.chainId") != ROBINHOOD_CHAIN_ID
                || vm.parseJsonUint(safeEvidence, ".safeState.threshold") != 2
                || vm.parseJsonUint(safeEvidence, ".safeState.nonce") != 0
                || vm.parseJsonAddress(safeEvidence, ".safeState.fallbackHandler") != SAFE_FALLBACK_HANDLER
                || vm.parseJsonAddress(safeEvidence, ".safeState.guard") != address(0) || modules.length != 0
                || vm.parseJsonAddress(safeEvidence, ".safeState.moduleCursor") != SAFE_SENTINEL
                || vm.parseJsonBytes32(safeEvidence, ".safeState.dependencies.proxyFactoryCodeHash")
                    != SAFE_PROXY_FACTORY_CODE_HASH
                || vm.parseJsonBytes32(safeEvidence, ".safeState.dependencies.singletonCodeHash")
                    != SAFE_SINGLETON_CODE_HASH
                || vm.parseJsonBytes32(safeEvidence, ".safeState.dependencies.fallbackHandlerCodeHash")
                    != SAFE_FALLBACK_HANDLER_CODE_HASH
        ) revert InvalidReleaseState("safeStateEvidence");

        bytes32 runtimeCodeHash = vm.parseJsonBytes32(safeEvidence, ".safeState.runtimeCodeHash");
        if (
            deploymentEvidenceHash == bytes32(0) || safeEvidenceHash == bytes32(0)
                || runtimeCodeHash == bytes32(0)
        ) revert InvalidReleaseState("evidenceHash");

        binding = ReleaseBinding({
            safeDeploymentEvidenceHash: safeEvidenceHash,
            deploymentVerificationEvidenceHash: deploymentEvidenceHash,
            releaseCommit: expectedReleaseCommit
        });
        safeBinding = SafeEvidenceBinding({ owners: configOwners, runtimeCodeHash: runtimeCodeHash });
    }

    function _validateCanonicalDependencies(ZapPadLaunchpad launchpad, address treasury) internal view {
        _requireCodeHash(POSITION_MANAGER, POSITION_MANAGER_CODE_HASH);
        _requireCodeHash(V3_FACTORY, V3_FACTORY_CODE_HASH);
        _requireCodeHash(SWAP_ROUTER, SWAP_ROUTER_CODE_HASH);
        _requireCodeHash(WETH, WETH_CODE_HASH);
        _requireCodeHash(USDG, USDG_CODE_HASH);
        _requireProxyImplementation(WETH, WETH_IMPLEMENTATION, WETH_IMPLEMENTATION_CODE_HASH);
        _requireProxyImplementation(USDG, USDG_IMPLEMENTATION, USDG_IMPLEMENTATION_CODE_HASH);
        if (
            address(launchpad).code.length == 0 || treasury.code.length == 0
                || launchpad.ROBINHOOD_CHAIN_ID() != ROBINHOOD_CHAIN_ID
                || launchpad.protocolTreasury() != treasury
                || address(launchpad.positionManager()) != POSITION_MANAGER
                || address(launchpad.v3Factory()) != V3_FACTORY
                || address(launchpad.swapRouter()) != SWAP_ROUTER || launchpad.weth() != WETH
                || launchpad.usdg() != USDG || launchpad.LAUNCH_CONFIG_DOMAIN() != LAUNCH_CONFIG_DOMAIN
        ) revert InvalidReleaseState("stack");
    }

    function _requireProxyImplementation(
        address proxy,
        address expectedImplementation,
        bytes32 expectedCodeHash
    ) internal view {
        address actualImplementation = address(uint160(uint256(vm.load(proxy, EIP1967_IMPLEMENTATION_SLOT))));
        if (actualImplementation != expectedImplementation) {
            revert InvalidReleaseState("proxyImplementation");
        }
        _requireCodeHash(actualImplementation, expectedCodeHash);
    }

    function _requireCodeHash(address dependency, bytes32 expected) internal view {
        bytes32 actual = dependency.codehash;
        if (dependency.code.length == 0 || actual != expected) {
            revert DependencyCodeHashMismatch(dependency, expected, actual);
        }
    }

    function _sameOwnerSet(address[] memory left, address[] memory right) private pure returns (bool) {
        if (left.length != right.length) return false;
        for (uint256 i; i < left.length; ++i) {
            bool found;
            for (uint256 j; j < right.length; ++j) {
                if (left[i] == right[j]) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    function _isFullGitCommit(string memory value) private pure returns (bool) {
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
}
