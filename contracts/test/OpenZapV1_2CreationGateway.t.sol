// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZapV1_2CreationGateway} from "../src/fee/OpenZapV1_2CreationGateway.sol";
import {ZapCreationFeePot} from "../src/fee/ZapCreationFeePot.sol";
import {Policy, Step} from "../src/libraries/OpenZapTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockZapsBuyAdapter} from "./mocks/MockZapsBuyAdapter.sol";

contract MockV1_2GatewayAeWETH {
    string public constant name = "Mock aeWETH";
    string public constant symbol = "maeWETH";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function deposit() external payable {
        totalSupply += msg.value;
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract MockV1_2GatewayZap {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

contract MockV1_2GatewayFactory {
    uint256 public created;
    address public lastCaller;

    function createZap(Policy calldata p, bytes32 salt) external returns (address zap) {
        zap = address(new MockV1_2GatewayZap{salt: _salt(p, salt)}(p.owner));
        created += 1;
        lastCaller = msg.sender;
    }

    function predict(Policy calldata p, bytes32 salt) external view returns (address predicted) {
        bytes32 bytecodeHash = keccak256(abi.encodePacked(type(MockV1_2GatewayZap).creationCode, abi.encode(p.owner)));
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(p, salt), bytecodeHash));
        predicted = address(uint160(uint256(hash)));
    }

    function _salt(Policy calldata p, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(p, salt));
    }
}

contract OpenZapV1_2CreationGatewayTest is Test {
    uint256 internal constant CREATION_FEE = 0.00001 ether;
    uint256 internal constant FEE_RATE = 2e18;
    uint256 internal constant ZAPS_PER_CREATION = (CREATION_FEE * FEE_RATE) / 1e18;

    address internal governance = address(0xCAFE);
    address internal player = address(0xA11CE);
    address internal recipient = address(0xBEEF);
    address internal payer = address(0xFEE);
    address internal stranger = address(0xBAD);

    MockV1_2GatewayAeWETH internal aeWeth;
    MockERC20 internal zaps;
    MockZapsBuyAdapter internal feeAdapter;
    MockV1_2GatewayFactory internal factory;
    MockV1_2GatewayFactory internal decoyFactory;
    OpenZapV1_2CreationGateway internal gateway;
    ZapCreationFeePot internal pot;

    function setUp() public {
        aeWeth = new MockV1_2GatewayAeWETH();
        zaps = new MockERC20("0xZAPS", "ZAPS", 18);
        feeAdapter = new MockZapsBuyAdapter(address(zaps), FEE_RATE);
        zaps.mint(address(feeAdapter), 1_000_000 ether);

        factory = new MockV1_2GatewayFactory();
        decoyFactory = new MockV1_2GatewayFactory();
        gateway = new OpenZapV1_2CreationGateway(
            governance, address(factory), address(aeWeth), address(zaps), address(feeAdapter), CREATION_FEE
        );
        pot = gateway.CREATION_POT();

        vm.deal(payer, 100 ether);
    }

    function _policy() internal view returns (Policy memory p) {
        address[] memory tracked = new address[](2);
        tracked[0] = address(aeWeth);
        tracked[1] = address(zaps);
        Step[] memory steps = new Step[](0);
        p = Policy({
            owner: player,
            recipient: recipient,
            maxRelayerFeeCap: 0,
            optimization: false,
            trackedAssets: tracked,
            steps: steps
        });
    }

    function _create(Policy memory p, bytes32 salt, uint256 minZapsOut) internal returns (address zap) {
        vm.prank(payer);
        zap = gateway.createZap{value: CREATION_FEE}(p, salt, minZapsOut);
    }

    function test_constructorCreatesAndAtomicallyBindsDedicatedPot() public {
        assertGt(address(pot).code.length, 0);
        assertEq(pot.owner(), governance);
        assertEq(pot.pendingOwner(), address(0));
        assertEq(pot.ZAPS(), address(zaps));
        assertEq(pot.gateway(), address(gateway));
        assertEq(pot.gatewayInstaller(), address(0));
        assertEq(pot.currentRound(), 1);
        assertEq(pot.accountedZaps(), 0);

        assertEq(gateway.V1_2_FACTORY(), address(factory));
        assertEq(gateway.AEWETH(), address(aeWeth));
        assertEq(gateway.ZAPS(), address(zaps));
        assertEq(gateway.CREATION_ADAPTER(), address(feeAdapter));
        assertEq(gateway.CREATION_FEE(), CREATION_FEE);

        vm.prank(governance);
        vm.expectRevert(ZapCreationFeePot.GatewayAlreadySet.selector);
        pot.setGateway(address(decoyFactory));
    }

    function test_rejectsUnderpaymentOverpaymentAndZeroMinimumBeforeFactoryCall() public {
        Policy memory p = _policy();

        vm.startPrank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OpenZapV1_2CreationGateway.IncorrectCreationFee.selector, CREATION_FEE - 1, CREATION_FEE
            )
        );
        gateway.createZap{value: CREATION_FEE - 1}(p, bytes32("under"), 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                OpenZapV1_2CreationGateway.IncorrectCreationFee.selector, CREATION_FEE + 1, CREATION_FEE
            )
        );
        gateway.createZap{value: CREATION_FEE + 1}(p, bytes32("over"), 1);

        vm.expectRevert(OpenZapV1_2CreationGateway.ZeroMinZapsOut.selector);
        gateway.createZap{value: CREATION_FEE}(p, bytes32("zero"), 0);
        vm.stopPrank();

        assertEq(factory.created(), 0);
        assertEq(pot.accountedZaps(), 0);
        assertEq(address(gateway).balance, 0);
    }

    function test_predictMatchesDeterministicFactoryCreation() public {
        Policy memory p = _policy();
        bytes32 salt = bytes32("deterministic");
        address factoryPrediction = factory.predict(p, salt);
        address gatewayPrediction = gateway.predict(p, salt);

        assertEq(gatewayPrediction, factoryPrediction);

        address zap = _create(p, salt, ZAPS_PER_CREATION);
        assertEq(zap, gatewayPrediction);
        assertGt(zap.code.length, 0);
        assertEq(MockV1_2GatewayZap(zap).owner(), player);
        assertEq(factory.created(), 1);
        assertEq(factory.lastCaller(), address(gateway));
    }

    function test_creditsConvertedFeeTicketsToPolicyOwnerNotPayer() public {
        Policy memory p = _policy();
        address zap = _create(p, bytes32("owner-credit"), ZAPS_PER_CREATION);

        assertGt(zap.code.length, 0);
        assertEq(pot.tickets(1, player), ZAPS_PER_CREATION);
        assertEq(pot.tickets(1, payer), 0);
        assertEq(pot.totalTickets(1), ZAPS_PER_CREATION);
        assertEq(pot.roundPrize(1), ZAPS_PER_CREATION);
        assertEq(pot.accountedZaps(), ZAPS_PER_CREATION);
        assertEq(zaps.balanceOf(address(pot)), ZAPS_PER_CREATION);
    }

    function test_feeSlippageFailureRollsBackFactoryCreationAndAllFeeState() public {
        Policy memory p = _policy();
        bytes32 salt = bytes32("atomic");
        address predicted = gateway.predict(p, salt);
        uint256 payerBalanceBefore = payer.balance;
        uint256 adapterZapsBefore = zaps.balanceOf(address(feeAdapter));

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OpenZapV1_2CreationGateway.MinZapsNotMet.selector, ZAPS_PER_CREATION, ZAPS_PER_CREATION + 1
            )
        );
        gateway.createZap{value: CREATION_FEE}(p, salt, ZAPS_PER_CREATION + 1);

        assertEq(predicted.code.length, 0);
        assertEq(factory.created(), 0);
        assertEq(factory.lastCaller(), address(0));
        assertEq(payer.balance, payerBalanceBefore);
        assertEq(zaps.balanceOf(address(feeAdapter)), adapterZapsBefore);
        assertEq(pot.tickets(1, player), 0);
        assertEq(pot.roundPrize(1), 0);
        assertEq(pot.accountedZaps(), 0);
        assertEq(address(gateway).balance, 0);
        assertEq(aeWeth.balanceOf(address(gateway)), 0);
        assertEq(zaps.balanceOf(address(gateway)), 0);
        assertEq(aeWeth.allowance(address(gateway), address(feeAdapter)), 0);

        address zap = _create(p, salt, ZAPS_PER_CREATION);
        assertEq(zap, predicted);
    }

    function test_successLeavesNoNativeTokenOrApprovalResidue() public {
        _create(_policy(), bytes32("residue"), ZAPS_PER_CREATION);

        assertEq(address(gateway).balance, 0);
        assertEq(aeWeth.balanceOf(address(gateway)), 0);
        assertEq(zaps.balanceOf(address(gateway)), 0);
        assertEq(aeWeth.allowance(address(gateway), address(feeAdapter)), 0);
        assertEq(aeWeth.balanceOf(address(feeAdapter)), CREATION_FEE);
    }

    function test_onlyPinnedV1_2FactoryIsCalledAndOnlyGatewayCanCreditPot() public {
        Policy memory p = _policy();
        address zap = _create(p, bytes32("factory-only"), ZAPS_PER_CREATION);

        assertEq(gateway.V1_2_FACTORY(), address(factory));
        assertEq(factory.created(), 1);
        assertEq(factory.lastCaller(), address(gateway));
        assertEq(decoyFactory.created(), 0);

        vm.prank(address(factory));
        vm.expectRevert(ZapCreationFeePot.NotGateway.selector);
        pot.recordCreation(player, zap, 1);

        vm.prank(stranger);
        vm.expectRevert(ZapCreationFeePot.NotGateway.selector);
        pot.recordCreation(player, zap, 1);
    }
}
