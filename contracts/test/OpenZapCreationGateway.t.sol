// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZapCreationGateway} from "../src/fee/OpenZapCreationGateway.sol";
import {ZapCreationFeePot} from "../src/fee/ZapCreationFeePot.sol";
import {Policy, Step} from "../src/libraries/OpenZapTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockZapsBuyAdapter} from "./mocks/MockZapsBuyAdapter.sol";

contract MockGatewayAeWETH {
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

contract MockGatewayZap {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

contract MockExistingFactory {
    uint256 public created;

    function createZap(Policy calldata p, bytes32 salt) external returns (address zap) {
        zap = address(new MockGatewayZap{salt: _salt(p, salt)}(p.owner));
        created += 1;
    }

    function predict(Policy calldata p, bytes32 salt) external view returns (address predicted) {
        bytes32 bytecodeHash = keccak256(abi.encodePacked(type(MockGatewayZap).creationCode, abi.encode(p.owner)));
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(p, salt), bytecodeHash));
        predicted = address(uint160(uint256(hash)));
    }

    function _salt(Policy calldata p, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(p, salt));
    }
}

contract OpenZapCreationGatewayTest is Test {
    uint256 internal constant CREATION_FEE = 0.00001 ether;
    uint256 internal constant FEE_RATE = 2e18;
    uint256 internal constant ZAPS_PER_CREATION = (CREATION_FEE * FEE_RATE) / 1e18;

    address internal player = address(0xA11CE);
    address internal recipient = address(0xBEEF);
    address internal stranger = address(0xBAD);

    MockGatewayAeWETH internal aeWeth;
    MockERC20 internal zaps;
    MockZapsBuyAdapter internal feeAdapter;
    MockExistingFactory internal oneShotFactory;
    MockExistingFactory internal triggerFactory;
    MockExistingFactory internal recurringFactory;
    ZapCreationFeePot internal pot;
    OpenZapCreationGateway internal gateway;

    function setUp() public {
        aeWeth = new MockGatewayAeWETH();
        zaps = new MockERC20("0xZAPS", "ZAPS", 18);
        feeAdapter = new MockZapsBuyAdapter(address(zaps), FEE_RATE);
        zaps.mint(address(feeAdapter), 1_000_000 ether);

        oneShotFactory = new MockExistingFactory();
        triggerFactory = new MockExistingFactory();
        recurringFactory = new MockExistingFactory();
        pot = new ZapCreationFeePot(address(this), address(zaps));
        gateway = new OpenZapCreationGateway(
            address(oneShotFactory),
            address(triggerFactory),
            address(recurringFactory),
            address(aeWeth),
            address(zaps),
            address(feeAdapter),
            pot,
            CREATION_FEE
        );
        pot.setGateway(address(gateway));
        vm.deal(address(this), 100 ether);
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

    function test_pinsExistingFactoriesWithoutDeployingReplacementImplementations() public view {
        assertEq(gateway.ONE_SHOT_FACTORY(), address(oneShotFactory));
        assertEq(gateway.TRIGGER_FACTORY(), address(triggerFactory));
        assertEq(gateway.RECURRING_FACTORY(), address(recurringFactory));
        assertEq(gateway.lineageFactory(OpenZapCreationGateway.Lineage.OneShot), address(oneShotFactory));
        assertEq(gateway.lineageFactory(OpenZapCreationGateway.Lineage.Trigger), address(triggerFactory));
        assertEq(gateway.lineageFactory(OpenZapCreationGateway.Lineage.RecurringRelative), address(recurringFactory));
        assertEq(gateway.CREATION_FEE(), CREATION_FEE);
        assertEq(gateway.CREATION_ADAPTER(), address(feeAdapter));
    }

    function test_deployerCanBindOnceWithoutReceivingGovernance() public {
        address governance = address(0xCAFE);
        ZapCreationFeePot unboundPot = new ZapCreationFeePot(governance, address(zaps));

        assertEq(unboundPot.owner(), governance);
        assertEq(unboundPot.gatewayInstaller(), address(this));

        vm.prank(stranger);
        vm.expectRevert(ZapCreationFeePot.NotGatewayBinder.selector);
        unboundPot.setGateway(address(gateway));

        unboundPot.setGateway(address(gateway));
        assertEq(unboundPot.gateway(), address(gateway));
        assertEq(unboundPot.gatewayInstaller(), address(0));
        assertEq(unboundPot.owner(), governance);

        vm.expectRevert(ZapCreationFeePot.GatewayAlreadySet.selector);
        unboundPot.setGateway(address(0xCA11));
    }

    function test_everyLineageCreatesThroughItsExistingFactoryAndPaysFee() public {
        Policy memory p = _policy();
        for (uint256 i; i < 3; ++i) {
            OpenZapCreationGateway.Lineage lineage = OpenZapCreationGateway.Lineage(i);
            bytes32 salt = bytes32(i + 1);
            address predicted = gateway.predict(lineage, p, salt);
            address zap = gateway.createZap{value: CREATION_FEE}(lineage, p, salt, ZAPS_PER_CREATION);
            assertEq(zap, predicted);
            assertGt(zap.code.length, 0);
            assertEq(MockGatewayZap(zap).owner(), player);
        }

        assertEq(oneShotFactory.created(), 1);
        assertEq(triggerFactory.created(), 1);
        assertEq(recurringFactory.created(), 1);
        assertEq(pot.tickets(1, player), 3 * ZAPS_PER_CREATION);
        assertEq(pot.totalTickets(1), 3 * ZAPS_PER_CREATION);
        assertEq(pot.roundPrize(1), 3 * ZAPS_PER_CREATION);
        assertEq(pot.accountedZaps(), 3 * ZAPS_PER_CREATION);
        assertEq(zaps.balanceOf(address(pot)), 3 * ZAPS_PER_CREATION);
    }

    function test_rejectsUnderpaymentOverpaymentAndZeroMinimum() public {
        Policy memory p = _policy();
        vm.expectRevert(
            abi.encodeWithSelector(OpenZapCreationGateway.IncorrectCreationFee.selector, CREATION_FEE - 1, CREATION_FEE)
        );
        gateway.createZap{value: CREATION_FEE - 1}(OpenZapCreationGateway.Lineage.OneShot, p, bytes32("under"), 1);

        vm.expectRevert(
            abi.encodeWithSelector(OpenZapCreationGateway.IncorrectCreationFee.selector, CREATION_FEE + 1, CREATION_FEE)
        );
        gateway.createZap{value: CREATION_FEE + 1}(OpenZapCreationGateway.Lineage.OneShot, p, bytes32("over"), 1);

        vm.expectRevert(OpenZapCreationGateway.ZeroMinZapsOut.selector);
        gateway.createZap{value: CREATION_FEE}(OpenZapCreationGateway.Lineage.OneShot, p, bytes32("zero"), 0);
    }

    function test_feeSlippageFailureRollsBackUnderlyingFactoryCreationAtomically() public {
        Policy memory p = _policy();
        bytes32 salt = bytes32("atomic");
        address predicted = gateway.predict(OpenZapCreationGateway.Lineage.Trigger, p, salt);

        vm.expectRevert(
            abi.encodeWithSelector(
                OpenZapCreationGateway.MinZapsNotMet.selector, ZAPS_PER_CREATION, ZAPS_PER_CREATION + 1
            )
        );
        gateway.createZap{value: CREATION_FEE}(OpenZapCreationGateway.Lineage.Trigger, p, salt, ZAPS_PER_CREATION + 1);

        assertEq(predicted.code.length, 0);
        assertEq(triggerFactory.created(), 0);
        assertEq(pot.roundPrize(1), 0);
        assertEq(aeWeth.balanceOf(address(gateway)), 0);
        assertEq(zaps.balanceOf(address(gateway)), 0);
        assertEq(aeWeth.allowance(address(gateway), address(feeAdapter)), 0);
        assertEq(address(gateway).balance, 0);

        address zap =
            gateway.createZap{value: CREATION_FEE}(OpenZapCreationGateway.Lineage.Trigger, p, salt, ZAPS_PER_CREATION);
        assertEq(zap, predicted);
    }

    function test_gatewayLeavesNoFeeAssetOrApprovalResidue() public {
        gateway.createZap{value: CREATION_FEE}(
            OpenZapCreationGateway.Lineage.RecurringRelative, _policy(), bytes32("residue"), ZAPS_PER_CREATION
        );

        assertEq(address(gateway).balance, 0);
        assertEq(aeWeth.balanceOf(address(gateway)), 0);
        assertEq(zaps.balanceOf(address(gateway)), 0);
        assertEq(aeWeth.allowance(address(gateway), address(feeAdapter)), 0);
        assertEq(aeWeth.balanceOf(address(feeAdapter)), CREATION_FEE);
    }

    function test_potCreditsCannotBeSpoofedAndDirectDonationsStayUnaccounted() public {
        Policy memory p = _policy();
        address zap = gateway.createZap{value: CREATION_FEE}(
            OpenZapCreationGateway.Lineage.OneShot, p, bytes32("auth"), ZAPS_PER_CREATION
        );

        vm.prank(stranger);
        vm.expectRevert(ZapCreationFeePot.NotGateway.selector);
        pot.recordCreation(player, zap, 1);

        zaps.mint(address(pot), 7 ether);
        assertEq(zaps.balanceOf(address(pot)), ZAPS_PER_CREATION + 7 ether);
        assertEq(pot.accountedZaps(), ZAPS_PER_CREATION);
        assertEq(pot.roundPrize(1), ZAPS_PER_CREATION);
    }

    function test_awardCanOnlyPayCurrentPrizeToTicketHolder() public {
        gateway.createZap{value: CREATION_FEE}(
            OpenZapCreationGateway.Lineage.OneShot, _policy(), bytes32("winner"), ZAPS_PER_CREATION
        );

        vm.expectRevert(abi.encodeWithSelector(ZapCreationFeePot.WinnerHasNoTickets.selector, 1, stranger));
        pot.awardRound(stranger);

        uint256 before = zaps.balanceOf(player);
        pot.awardRound(player);
        assertEq(zaps.balanceOf(player) - before, ZAPS_PER_CREATION);
        assertEq(pot.currentRound(), 2);
        assertEq(pot.accountedZaps(), 0);
        assertEq(pot.roundPrize(1), 0);
    }
}
