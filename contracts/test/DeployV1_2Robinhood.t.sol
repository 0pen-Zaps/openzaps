// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapCreationGateway} from "../src/fee/OpenZapCreationGateway.sol";
import {DeployV1_2Robinhood} from "../script/DeployV1_2Robinhood.s.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";
import {ZapCreationFeePot} from "../src/fee/ZapCreationFeePot.sol";

contract DeployV1_2RobinhoodCaller {
    function run(DeployV1_2Robinhood deployment) external returns (DeployV1_2Robinhood.Deployed memory) {
        return deployment.run();
    }
}

contract DeployV1_2RobinhoodTest is Test {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant CREATION_FEE = 0.00001 ether;

    address internal constant GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant OTHER = address(0xBEEF);

    AdapterRegistry internal constant LIVE_ADAPTERS = AdapterRegistry(0x9E56e444f490C00A6277326A47Cb462E12dF1f17);
    TokenAllowlist internal constant LIVE_TOKENS = TokenAllowlist(0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B);
    address internal constant LIVE_V1_1_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    address internal constant LIVE_V1_1_IMPLEMENTATION = address(0x1111);

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

    DeployV1_2Robinhood internal deployment;

    function setUp() public {
        vm.chainId(ROBINHOOD_CHAIN_ID);
        deployment = new DeployV1_2Robinhood();
        DeployV1_2RobinhoodCaller caller = new DeployV1_2RobinhoodCaller();
        vm.etch(GOVERNANCE, address(caller).code);
        _etchExpectedCode();
    }

    function test_preflightRejectsWrongChain() public {
        vm.chainId(1);

        vm.expectRevert(abi.encodeWithSelector(DeployV1_2Robinhood.WrongChain.selector, 1));
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsSignerThatIsNotPinnedGovernance() public {
        vm.expectRevert(abi.encodeWithSelector(DeployV1_2Robinhood.WrongDeployer.selector, OTHER, GOVERNANCE));
        vm.prank(OTHER);
        deployment.run();
    }

    function test_preflightRejectsWrongAdapterRegistryOwner() public {
        _mockLiveState(OTHER, address(0), GOVERNANCE, address(0), address(0), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV1_2Robinhood.LiveAdapterRegistryOwnerMismatch.selector, OTHER, GOVERNANCE)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsPendingAdapterRegistryOwnershipTransfer() public {
        _mockLiveState(GOVERNANCE, OTHER, GOVERNANCE, address(0), address(0), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV1_2Robinhood.LiveAdapterRegistryOwnershipTransferPending.selector, OTHER)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsWrongTokenAllowlistOwner() public {
        _mockLiveState(GOVERNANCE, address(0), OTHER, address(0), address(0), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV1_2Robinhood.LiveTokenAllowlistOwnerMismatch.selector, OTHER, GOVERNANCE)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsPendingTokenAllowlistOwnershipTransfer() public {
        _mockLiveState(GOVERNANCE, address(0), GOVERNANCE, OTHER, address(0), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV1_2Robinhood.LiveTokenAllowlistOwnershipTransferPending.selector, OTHER)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsAnyKnownAdapterThatIsNotAllowlisted() public {
        _mockLiveState(GOVERNANCE, address(0), GOVERNANCE, address(0), LIVE_RANGE_WITHDRAW_AEWETH, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV1_2Robinhood.LiveAdapterNotAllowed.selector, LIVE_RANGE_WITHDRAW_AEWETH)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsAnyKnownTokenThatIsNotAllowlisted() public {
        _mockLiveState(GOVERNANCE, address(0), GOVERNANCE, address(0), address(0), OZ_RANGE);

        vm.expectRevert(abi.encodeWithSelector(DeployV1_2Robinhood.LiveTokenNotAllowed.selector, OZ_RANGE));
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_deploysIsolatedV1_2FactoryGatewayAndPotWithoutWritingLiveSurfaces() public {
        _mockLiveState(GOVERNANCE, address(0), GOVERNANCE, address(0), address(0), address(0));
        vm.record();

        DeployV1_2Robinhood.Deployed memory d = DeployV1_2RobinhoodCaller(GOVERNANCE).run(deployment);

        assertEq(d.factory.VERSION(), "1.2.0-candidate");
        assertEq(address(d.factory.adapters()), address(LIVE_ADAPTERS));
        assertEq(address(d.factory.tokens()), address(LIVE_TOKENS));
        assertGt(d.implementation.code.length, 0);
        assertEq(d.factory.implCodeHash(), d.implementation.codehash);

        OpenZap implementation = OpenZap(payable(d.implementation));
        assertEq(implementation.FACTORY(), address(d.factory));
        assertEq(address(implementation.ADAPTERS()), address(LIVE_ADAPTERS));
        assertEq(address(implementation.TOKENS()), address(LIVE_TOKENS));
        assertEq(implementation.PERMIT2(), PERMIT2);
        assertEq(implementation.owner(), address(0));
        assertFalse(implementation.policyHalted());

        assertEq(d.creationGateway.V1_2_FACTORY(), address(d.factory));
        assertEq(d.creationGateway.CREATION_FEE(), CREATION_FEE);
        assertEq(address(d.creationGateway.CREATION_POT()), address(d.creationPot));
        assertEq(d.creationPot.owner(), GOVERNANCE);
        assertEq(d.creationPot.gateway(), address(d.creationGateway));
        assertEq(d.creationPot.gatewayInstaller(), address(0));
        assertEq(d.creationPot.currentRound(), 1);
        assertEq(d.creationPot.accountedZaps(), 0);

        (, bytes32[] memory registryWrites) = vm.accesses(address(LIVE_ADAPTERS));
        (, bytes32[] memory allowlistWrites) = vm.accesses(address(LIVE_TOKENS));
        (, bytes32[] memory liveFactoryWrites) = vm.accesses(LIVE_V1_1_FACTORY);
        (, bytes32[] memory legacyGatewayWrites) = vm.accesses(address(LIVE_CREATION_GATEWAY));
        (, bytes32[] memory legacyPotWrites) = vm.accesses(address(LIVE_CREATION_POT));
        assertEq(registryWrites.length, 0, "must not write live adapter registry");
        assertEq(allowlistWrites.length, 0, "must not write live token allowlist");
        assertEq(liveFactoryWrites.length, 0, "must not write live v1.1 factory");
        assertEq(legacyGatewayWrites.length, 0, "must not write legacy creation gateway");
        assertEq(legacyPotWrites.length, 0, "must not write active legacy prize pot");
    }

    function _etchExpectedCode() internal {
        vm.etch(address(LIVE_ADAPTERS), hex"00");
        vm.etch(address(LIVE_TOKENS), hex"00");
        vm.etch(LIVE_V1_1_FACTORY, hex"00");
        vm.etch(LIVE_V1_1_IMPLEMENTATION, hex"00");

        vm.etch(address(LIVE_CREATION_ADAPTER), hex"00");
        vm.etch(LIVE_POOL_ADAPTER, hex"00");
        vm.etch(LIVE_VAULT_DEPOSIT_ADAPTER, hex"00");
        vm.etch(LIVE_VAULT_REDEEM_ADAPTER, hex"00");
        vm.etch(LIVE_ROUTE_USDG_TO_ZAPS, hex"00");
        vm.etch(LIVE_ROUTE_ZAPS_TO_USDG, hex"00");
        vm.etch(LIVE_RANGE_DEPOSIT_ADAPTER, hex"00");
        vm.etch(LIVE_RANGE_WITHDRAW_USDG, hex"00");
        vm.etch(LIVE_RANGE_WITHDRAW_AEWETH, hex"00");

        vm.etch(AEWETH, hex"00");
        vm.etch(ZAPS, hex"00");
        vm.etch(USDG, hex"00");
        vm.etch(OZ_USDG, hex"00");
        vm.etch(OZ_RANGE, hex"00");
        vm.etch(UNIVERSAL_ROUTER, hex"00");
        vm.etch(PERMIT2, hex"00");
        vm.etch(HOOK, hex"00");

        vm.etch(address(LIVE_CREATION_GATEWAY), hex"00");
        vm.etch(address(LIVE_CREATION_POT), hex"00");
        vm.etch(LIVE_TRIGGER_FACTORY, hex"00");
        vm.etch(LIVE_RECURRING_FACTORY, hex"00");
    }

    function _mockLiveState(
        address adapterRegistryOwner,
        address adapterRegistryPendingOwner,
        address tokenAllowlistOwner,
        address tokenAllowlistPendingOwner,
        address deniedAdapter,
        address deniedToken
    ) internal {
        vm.mockCall(address(LIVE_ADAPTERS), abi.encodeCall(LIVE_ADAPTERS.owner, ()), abi.encode(adapterRegistryOwner));
        vm.mockCall(
            address(LIVE_ADAPTERS),
            abi.encodeCall(LIVE_ADAPTERS.pendingOwner, ()),
            abi.encode(adapterRegistryPendingOwner)
        );
        vm.mockCall(address(LIVE_TOKENS), abi.encodeCall(LIVE_TOKENS.owner, ()), abi.encode(tokenAllowlistOwner));
        vm.mockCall(
            address(LIVE_TOKENS), abi.encodeCall(LIVE_TOKENS.pendingOwner, ()), abi.encode(tokenAllowlistPendingOwner)
        );

        OpenZapFactoryView liveFactory = OpenZapFactoryView(LIVE_V1_1_FACTORY);
        vm.mockCall(LIVE_V1_1_FACTORY, abi.encodeCall(liveFactory.VERSION, ()), abi.encode("1.1.0"));
        vm.mockCall(
            LIVE_V1_1_FACTORY, abi.encodeCall(liveFactory.implementation, ()), abi.encode(LIVE_V1_1_IMPLEMENTATION)
        );
        vm.mockCall(LIVE_V1_1_FACTORY, abi.encodeCall(liveFactory.adapters, ()), abi.encode(address(LIVE_ADAPTERS)));
        vm.mockCall(LIVE_V1_1_FACTORY, abi.encodeCall(liveFactory.tokens, ()), abi.encode(address(LIVE_TOKENS)));
        vm.mockCall(
            LIVE_V1_1_FACTORY,
            abi.encodeCall(liveFactory.implCodeHash, ()),
            abi.encode(LIVE_V1_1_IMPLEMENTATION.codehash)
        );

        _mockAdapterAllowed(address(LIVE_CREATION_ADAPTER), deniedAdapter);
        _mockAdapterAllowed(LIVE_POOL_ADAPTER, deniedAdapter);
        _mockAdapterAllowed(LIVE_VAULT_DEPOSIT_ADAPTER, deniedAdapter);
        _mockAdapterAllowed(LIVE_VAULT_REDEEM_ADAPTER, deniedAdapter);
        _mockAdapterAllowed(LIVE_ROUTE_USDG_TO_ZAPS, deniedAdapter);
        _mockAdapterAllowed(LIVE_ROUTE_ZAPS_TO_USDG, deniedAdapter);
        _mockAdapterAllowed(LIVE_RANGE_DEPOSIT_ADAPTER, deniedAdapter);
        _mockAdapterAllowed(LIVE_RANGE_WITHDRAW_USDG, deniedAdapter);
        _mockAdapterAllowed(LIVE_RANGE_WITHDRAW_AEWETH, deniedAdapter);

        _mockTokenAllowed(AEWETH, deniedToken);
        _mockTokenAllowed(ZAPS, deniedToken);
        _mockTokenAllowed(USDG, deniedToken);
        _mockTokenAllowed(OZ_USDG, deniedToken);
        _mockTokenAllowed(OZ_RANGE, deniedToken);

        vm.mockCall(
            address(LIVE_CREATION_ADAPTER),
            abi.encodeCall(LIVE_CREATION_ADAPTER.universalRouter, ()),
            abi.encode(UNIVERSAL_ROUTER)
        );
        vm.mockCall(
            address(LIVE_CREATION_ADAPTER), abi.encodeCall(LIVE_CREATION_ADAPTER.permit2, ()), abi.encode(PERMIT2)
        );
        vm.mockCall(
            address(LIVE_CREATION_ADAPTER), abi.encodeCall(LIVE_CREATION_ADAPTER.currency0, ()), abi.encode(AEWETH)
        );
        vm.mockCall(
            address(LIVE_CREATION_ADAPTER), abi.encodeCall(LIVE_CREATION_ADAPTER.currency1, ()), abi.encode(ZAPS)
        );
        vm.mockCall(address(LIVE_CREATION_ADAPTER), abi.encodeCall(LIVE_CREATION_ADAPTER.fee, ()), abi.encode(POOL_FEE));
        vm.mockCall(
            address(LIVE_CREATION_ADAPTER),
            abi.encodeCall(LIVE_CREATION_ADAPTER.tickSpacing, ()),
            abi.encode(TICK_SPACING)
        );
        vm.mockCall(address(LIVE_CREATION_ADAPTER), abi.encodeCall(LIVE_CREATION_ADAPTER.hooks, ()), abi.encode(HOOK));
        vm.mockCall(
            address(LIVE_CREATION_ADAPTER), abi.encodeCall(LIVE_CREATION_ADAPTER.poolId, ()), abi.encode(POOL_ID)
        );

        vm.mockCall(
            address(LIVE_CREATION_GATEWAY),
            abi.encodeCall(LIVE_CREATION_GATEWAY.ONE_SHOT_FACTORY, ()),
            abi.encode(LIVE_V1_1_FACTORY)
        );
        vm.mockCall(
            address(LIVE_CREATION_GATEWAY),
            abi.encodeCall(LIVE_CREATION_GATEWAY.TRIGGER_FACTORY, ()),
            abi.encode(LIVE_TRIGGER_FACTORY)
        );
        vm.mockCall(
            address(LIVE_CREATION_GATEWAY),
            abi.encodeCall(LIVE_CREATION_GATEWAY.RECURRING_FACTORY, ()),
            abi.encode(LIVE_RECURRING_FACTORY)
        );
        vm.mockCall(
            address(LIVE_CREATION_GATEWAY), abi.encodeCall(LIVE_CREATION_GATEWAY.AEWETH, ()), abi.encode(AEWETH)
        );
        vm.mockCall(address(LIVE_CREATION_GATEWAY), abi.encodeCall(LIVE_CREATION_GATEWAY.ZAPS, ()), abi.encode(ZAPS));
        vm.mockCall(
            address(LIVE_CREATION_GATEWAY),
            abi.encodeCall(LIVE_CREATION_GATEWAY.CREATION_ADAPTER, ()),
            abi.encode(address(LIVE_CREATION_ADAPTER))
        );
        vm.mockCall(
            address(LIVE_CREATION_GATEWAY),
            abi.encodeCall(LIVE_CREATION_GATEWAY.CREATION_FEE, ()),
            abi.encode(CREATION_FEE)
        );
        vm.mockCall(
            address(LIVE_CREATION_GATEWAY),
            abi.encodeCall(LIVE_CREATION_GATEWAY.CREATION_POT, ()),
            abi.encode(address(LIVE_CREATION_POT))
        );

        vm.mockCall(address(LIVE_CREATION_POT), abi.encodeCall(LIVE_CREATION_POT.owner, ()), abi.encode(GOVERNANCE));
        vm.mockCall(
            address(LIVE_CREATION_POT), abi.encodeCall(LIVE_CREATION_POT.pendingOwner, ()), abi.encode(address(0))
        );
        vm.mockCall(address(LIVE_CREATION_POT), abi.encodeCall(LIVE_CREATION_POT.ZAPS, ()), abi.encode(ZAPS));
        vm.mockCall(
            address(LIVE_CREATION_POT),
            abi.encodeCall(LIVE_CREATION_POT.gateway, ()),
            abi.encode(address(LIVE_CREATION_GATEWAY))
        );
        vm.mockCall(
            address(LIVE_CREATION_POT), abi.encodeCall(LIVE_CREATION_POT.gatewayInstaller, ()), abi.encode(address(0))
        );
    }

    function _mockAdapterAllowed(address adapter, address deniedAdapter) internal {
        vm.mockCall(
            address(LIVE_ADAPTERS),
            abi.encodeCall(LIVE_ADAPTERS.isAllowed, (adapter)),
            abi.encode(adapter != deniedAdapter)
        );
    }

    function _mockTokenAllowed(address token, address deniedToken) internal {
        vm.mockCall(
            address(LIVE_TOKENS), abi.encodeCall(LIVE_TOKENS.isAllowed, (token)), abi.encode(token != deniedToken)
        );
    }
}

interface OpenZapFactoryView {
    function VERSION() external view returns (string memory);
    function implementation() external view returns (address);
    function adapters() external view returns (AdapterRegistry);
    function tokens() external view returns (TokenAllowlist);
    function implCodeHash() external view returns (bytes32);
}
