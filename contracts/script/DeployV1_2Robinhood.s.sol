// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";
import {OpenZapCreationGateway} from "../src/fee/OpenZapCreationGateway.sol";
import {OpenZapV1_2CreationGateway} from "../src/fee/OpenZapV1_2CreationGateway.sol";
import {ZapCreationFeePot} from "../src/fee/ZapCreationFeePot.sol";

/// @title DeployV1_2Robinhood
/// @notice UNAUDITED CANDIDATE. Deploys a new v1.2 halt + Permit2 factory/implementation on
///         Robinhood Chain (4663), reusing the complete live AdapterRegistry and TokenAllowlist
///         without writing either one. It also deploys a v1.2-only exact-fee creation gateway whose
///         dedicated ZapCreationFeePot is created and bound inside the gateway constructor.
///
///         The live immutable v1.1 factory remains available and unchanged. The live universal
///         creation gateway and its active prize round remain bound to their existing pot; this
///         script reads and asserts that path before and after deployment but never calls it.
///
///         Rehearse without `--broadcast` first:
///
///           forge script script/DeployV1_2Robinhood.s.sol:DeployV1_2Robinhood \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com \
///             --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2
///
///         Broadcast with a Forge CLI signer. No private key, mnemonic, Safe, timelock, or signer
///         configuration is read by this source:
///
///           forge script script/DeployV1_2Robinhood.s.sol:DeployV1_2Robinhood \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com \
///             --account <keystore-name> \
///             --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
///             --broadcast --slow
contract DeployV1_2Robinhood is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    string internal constant EXPECTED_LIVE_VERSION = "1.1.0";
    string internal constant EXPECTED_NEW_VERSION = "1.2.0-candidate";
    string internal constant EXPECTED_GATEWAY_VERSION = "1.0.0-candidate";
    uint256 internal constant CREATION_FEE = 0.00001 ether;

    address internal constant EXPECTED_GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;

    AdapterRegistry internal constant LIVE_ADAPTERS = AdapterRegistry(0x9E56e444f490C00A6277326A47Cb462E12dF1f17);
    TokenAllowlist internal constant LIVE_TOKENS = TokenAllowlist(0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B);
    OpenZapFactory internal constant LIVE_V1_1_FACTORY = OpenZapFactory(0xFC775017b25d2458623E2f3E735A4B750dD8b4E4);

    RobinhoodV4SwapAdapter internal constant LIVE_CREATION_ADAPTER =
        RobinhoodV4SwapAdapter(0x04f62dA4b51a010eFa32aa81569169C47AEd602C);
    address internal constant LIVE_POOL_ADAPTER = 0x714E48930d1d9a53149AA7B92cD88C9E172d1942;
    address internal constant LIVE_VAULT_DEPOSIT_ADAPTER = 0x1b289fD37Ff4497531a953aa922ab258F5e81164;
    address internal constant LIVE_VAULT_REDEEM_ADAPTER = 0x16eD4f04657c7a965aef333F5Cf0c9d745e0c8cE;
    address internal constant LIVE_ROUTE_USDG_TO_ZAPS = 0x132e65D4A28ec1687D3B2b2a6e2DfD75afCf4900;
    address internal constant LIVE_ROUTE_ZAPS_TO_USDG = 0x9C3F7F057aC3d2828C7271ba73538B33E32E7a59;
    address internal constant LIVE_RANGE_DEPOSIT_ADAPTER = 0xaB2e75fdb8f108c0589048c8cc0F3ce5Fb8b7896;
    address internal constant LIVE_RANGE_WITHDRAW_USDG = 0xDeaC50A0fD41e66900E8a4ab721ce8A43129aE1C;
    address internal constant LIVE_RANGE_WITHDRAW_AEWETH = 0x5a7F5e5D5Ef503300E04Ab91145CDA2F1c7289B8;

    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant OZ_USDG = 0xeAD10C998c59745a030FfAc9209b294C14C7D325;
    address internal constant OZ_RANGE = 0x9FE852CE89c5920a87F8465C91B9e691f37BeD5B;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;
    uint24 internal constant POOL_FEE = 0x800000;
    int24 internal constant TICK_SPACING = 200;
    bytes32 internal constant POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;

    OpenZapCreationGateway internal constant LIVE_CREATION_GATEWAY =
        OpenZapCreationGateway(payable(0x02A17a94A0e2B470e931E98079Bf563c94281B2b));
    ZapCreationFeePot internal constant LIVE_CREATION_POT =
        ZapCreationFeePot(0x8E0399A8fF81a5f73Bc76CAEE8a355cF9bb0d863);
    address internal constant LIVE_TRIGGER_FACTORY = 0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9;
    address internal constant LIVE_RECURRING_FACTORY = 0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1;

    error WrongChain(uint256 actual);
    error WrongDeployer(address actual, address expected);
    error MissingCode(address target);
    error LiveAdapterRegistryOwnerMismatch(address actual, address expected);
    error LiveAdapterRegistryOwnershipTransferPending(address pendingOwner);
    error LiveTokenAllowlistOwnerMismatch(address actual, address expected);
    error LiveTokenAllowlistOwnershipTransferPending(address pendingOwner);
    error UnexpectedLiveCoreVersion(string actual);
    error LiveFactoryPinMismatch();
    error LiveAdapterNotAllowed(address adapter);
    error LiveTokenNotAllowed(address token);
    error LiveCreationAdapterPinMismatch();
    error LegacyCreationPathMismatch();
    error UnexpectedNewCoreVersion(string actual);
    error DeploymentAssertionFailed();

    struct Deployed {
        OpenZapFactory factory;
        address implementation;
        OpenZapV1_2CreationGateway creationGateway;
        ZapCreationFeePot creationPot;
    }

    function run() external returns (Deployed memory d) {
        address governance = msg.sender;
        _preflight(governance);

        vm.startBroadcast();

        d.factory = new OpenZapFactory(LIVE_ADAPTERS, LIVE_TOKENS);
        d.creationGateway = new OpenZapV1_2CreationGateway(
            governance, address(d.factory), AEWETH, ZAPS, address(LIVE_CREATION_ADAPTER), CREATION_FEE
        );
        d.creationPot = d.creationGateway.CREATION_POT();

        vm.stopBroadcast();

        d.implementation = d.factory.implementation();
        _assertDeployment(governance, d);
        _report(governance, d);
    }

    function _preflight(address governance) internal view {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (governance != EXPECTED_GOVERNANCE) revert WrongDeployer(governance, EXPECTED_GOVERNANCE);

        _requireCode(address(LIVE_ADAPTERS));
        _requireCode(address(LIVE_TOKENS));
        _requireCode(address(LIVE_V1_1_FACTORY));
        _requireCode(AEWETH);
        _requireCode(ZAPS);
        _requireCode(UNIVERSAL_ROUTER);
        _requireCode(PERMIT2);
        _requireCode(HOOK);

        _assertLiveGovernance(governance);
        _assertLiveFactory();
        _assertKnownLiveSurface();
        _assertCreationAdapter();
        _assertLegacyCreationPath(governance);
    }

    function _assertDeployment(address governance, Deployed memory d) internal view {
        _assertLiveGovernance(governance);
        _assertLiveFactory();
        _assertKnownLiveSurface();
        _assertCreationAdapter();
        _assertLegacyCreationPath(governance);

        if (
            address(d.factory).code.length == 0 || d.implementation.code.length == 0
                || address(d.creationGateway).code.length == 0 || address(d.creationPot).code.length == 0
        ) revert DeploymentAssertionFailed();

        if (keccak256(bytes(d.factory.VERSION())) != keccak256(bytes(EXPECTED_NEW_VERSION))) {
            revert UnexpectedNewCoreVersion(d.factory.VERSION());
        }
        if (
            address(d.factory.adapters()) != address(LIVE_ADAPTERS)
                || address(d.factory.tokens()) != address(LIVE_TOKENS)
                || d.factory.implCodeHash() != d.implementation.codehash
        ) revert DeploymentAssertionFailed();

        OpenZap implementation = OpenZap(payable(d.implementation));
        if (
            implementation.FACTORY() != address(d.factory)
                || address(implementation.ADAPTERS()) != address(LIVE_ADAPTERS)
                || address(implementation.TOKENS()) != address(LIVE_TOKENS) || implementation.owner() != address(0)
                || implementation.policyHalted() || implementation.PERMIT2() != PERMIT2
        ) revert DeploymentAssertionFailed();

        if (
            d.creationGateway.V1_2_FACTORY() != address(d.factory) || d.creationGateway.AEWETH() != AEWETH
                || d.creationGateway.ZAPS() != ZAPS
                || d.creationGateway.CREATION_ADAPTER() != address(LIVE_CREATION_ADAPTER)
                || d.creationGateway.CREATION_FEE() != CREATION_FEE
                || address(d.creationGateway.CREATION_POT()) != address(d.creationPot)
                || keccak256(bytes(d.creationGateway.VERSION())) != keccak256(bytes(EXPECTED_GATEWAY_VERSION))
        ) revert DeploymentAssertionFailed();

        if (
            d.creationPot.owner() != governance || d.creationPot.pendingOwner() != address(0)
                || d.creationPot.ZAPS() != ZAPS || d.creationPot.gateway() != address(d.creationGateway)
                || d.creationPot.gatewayInstaller() != address(0) || d.creationPot.currentRound() != 1
                || d.creationPot.accountedZaps() != 0 || d.creationPot.totalTickets(1) != 0
                || d.creationPot.roundPrize(1) != 0
        ) revert DeploymentAssertionFailed();
    }

    function _assertLiveGovernance(address governance) internal view {
        address adapterRegistryOwner = LIVE_ADAPTERS.owner();
        if (adapterRegistryOwner != governance) {
            revert LiveAdapterRegistryOwnerMismatch(adapterRegistryOwner, governance);
        }
        address adapterRegistryPendingOwner = LIVE_ADAPTERS.pendingOwner();
        if (adapterRegistryPendingOwner != address(0)) {
            revert LiveAdapterRegistryOwnershipTransferPending(adapterRegistryPendingOwner);
        }

        address tokenAllowlistOwner = LIVE_TOKENS.owner();
        if (tokenAllowlistOwner != governance) {
            revert LiveTokenAllowlistOwnerMismatch(tokenAllowlistOwner, governance);
        }
        address tokenAllowlistPendingOwner = LIVE_TOKENS.pendingOwner();
        if (tokenAllowlistPendingOwner != address(0)) {
            revert LiveTokenAllowlistOwnershipTransferPending(tokenAllowlistPendingOwner);
        }
    }

    function _assertLiveFactory() internal view {
        if (keccak256(bytes(LIVE_V1_1_FACTORY.VERSION())) != keccak256(bytes(EXPECTED_LIVE_VERSION))) {
            revert UnexpectedLiveCoreVersion(LIVE_V1_1_FACTORY.VERSION());
        }
        address liveImplementation = LIVE_V1_1_FACTORY.implementation();
        _requireCode(liveImplementation);
        if (
            address(LIVE_V1_1_FACTORY.adapters()) != address(LIVE_ADAPTERS)
                || address(LIVE_V1_1_FACTORY.tokens()) != address(LIVE_TOKENS)
                || LIVE_V1_1_FACTORY.implCodeHash() != liveImplementation.codehash
        ) revert LiveFactoryPinMismatch();
    }

    function _assertKnownLiveSurface() internal view {
        _assertLiveAdapter(address(LIVE_CREATION_ADAPTER));
        _assertLiveAdapter(LIVE_POOL_ADAPTER);
        _assertLiveAdapter(LIVE_VAULT_DEPOSIT_ADAPTER);
        _assertLiveAdapter(LIVE_VAULT_REDEEM_ADAPTER);
        _assertLiveAdapter(LIVE_ROUTE_USDG_TO_ZAPS);
        _assertLiveAdapter(LIVE_ROUTE_ZAPS_TO_USDG);
        _assertLiveAdapter(LIVE_RANGE_DEPOSIT_ADAPTER);
        _assertLiveAdapter(LIVE_RANGE_WITHDRAW_USDG);
        _assertLiveAdapter(LIVE_RANGE_WITHDRAW_AEWETH);

        _assertLiveToken(AEWETH);
        _assertLiveToken(ZAPS);
        _assertLiveToken(USDG);
        _assertLiveToken(OZ_USDG);
        _assertLiveToken(OZ_RANGE);
    }

    function _assertLiveAdapter(address adapter) internal view {
        _requireCode(adapter);
        if (!LIVE_ADAPTERS.isAllowed(adapter)) revert LiveAdapterNotAllowed(adapter);
    }

    function _assertLiveToken(address token) internal view {
        _requireCode(token);
        if (!LIVE_TOKENS.isAllowed(token)) revert LiveTokenNotAllowed(token);
    }

    function _assertCreationAdapter() internal view {
        if (
            LIVE_CREATION_ADAPTER.universalRouter() != UNIVERSAL_ROUTER || LIVE_CREATION_ADAPTER.permit2() != PERMIT2
                || LIVE_CREATION_ADAPTER.currency0() != AEWETH || LIVE_CREATION_ADAPTER.currency1() != ZAPS
                || LIVE_CREATION_ADAPTER.fee() != POOL_FEE || LIVE_CREATION_ADAPTER.tickSpacing() != TICK_SPACING
                || LIVE_CREATION_ADAPTER.hooks() != HOOK || LIVE_CREATION_ADAPTER.poolId() != POOL_ID
        ) revert LiveCreationAdapterPinMismatch();
    }

    function _assertLegacyCreationPath(address governance) internal view {
        _requireCode(address(LIVE_CREATION_GATEWAY));
        _requireCode(address(LIVE_CREATION_POT));
        if (
            LIVE_CREATION_GATEWAY.ONE_SHOT_FACTORY() != address(LIVE_V1_1_FACTORY)
                || LIVE_CREATION_GATEWAY.TRIGGER_FACTORY() != LIVE_TRIGGER_FACTORY
                || LIVE_CREATION_GATEWAY.RECURRING_FACTORY() != LIVE_RECURRING_FACTORY
                || LIVE_CREATION_GATEWAY.AEWETH() != AEWETH || LIVE_CREATION_GATEWAY.ZAPS() != ZAPS
                || LIVE_CREATION_GATEWAY.CREATION_ADAPTER() != address(LIVE_CREATION_ADAPTER)
                || LIVE_CREATION_GATEWAY.CREATION_FEE() != CREATION_FEE
                || address(LIVE_CREATION_GATEWAY.CREATION_POT()) != address(LIVE_CREATION_POT)
                || LIVE_CREATION_POT.owner() != governance || LIVE_CREATION_POT.pendingOwner() != address(0)
                || LIVE_CREATION_POT.ZAPS() != ZAPS || LIVE_CREATION_POT.gateway() != address(LIVE_CREATION_GATEWAY)
                || LIVE_CREATION_POT.gatewayInstaller() != address(0)
        ) revert LegacyCreationPathMismatch();
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _report(address governance, Deployed memory d) internal view {
        console2.log("chainId                     ", block.chainid);
        console2.log("governance                  ", governance);
        console2.log("liveAdapterRegistry         ", address(LIVE_ADAPTERS));
        console2.log("liveAdapterRegistryOwner    ", LIVE_ADAPTERS.owner());
        console2.log("liveAdapterPendingOwner     ", LIVE_ADAPTERS.pendingOwner());
        console2.log("liveTokenAllowlist          ", address(LIVE_TOKENS));
        console2.log("liveTokenAllowlistOwner     ", LIVE_TOKENS.owner());
        console2.log("liveTokenPendingOwner       ", LIVE_TOKENS.pendingOwner());
        console2.log("legacyCreationGateway       ", address(LIVE_CREATION_GATEWAY));
        console2.log("legacyCreationFeePot        ", address(LIVE_CREATION_POT));
        console2.log("factoryV1_2                 ", address(d.factory));
        console2.log("factory version             ", d.factory.VERSION());
        console2.log("implementationV1_2          ", d.implementation);
        console2.log("implementation codehash");
        console2.logBytes32(d.factory.implCodeHash());
        console2.log("v1_2CreationGateway         ", address(d.creationGateway));
        console2.log("  version                   ", d.creationGateway.VERSION());
        console2.log("  factory                   ", d.creationGateway.V1_2_FACTORY());
        console2.log("  creation fee              ", d.creationGateway.CREATION_FEE());
        console2.log("v1_2CreationFeePot          ", address(d.creationPot));
        console2.log("  gateway                   ", d.creationPot.gateway());
        console2.log("  owner                     ", d.creationPot.owner());
        console2.log("deployment assertions       ", "PASS");
    }
}
