// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

interface IMockTransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MockPermit2 {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => PackedAllowance))) private _allowances;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        _allowances[msg.sender][token][spender] = PackedAllowance(amount, expiration);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage a = _allowances[from][token][msg.sender];
        require(a.amount >= amount, "permit allowance");
        require(a.expiration >= block.timestamp, "permit expired");
        a.amount -= amount;
        require(IMockTransferFrom(token).transferFrom(from, to, amount), "token transfer");
    }

    function allowanceAmount(address owner, address token, address spender) external view returns (uint160) {
        return _allowances[owner][token][spender].amount;
    }
}

contract MockRobinhoodRouter {
    MockPermit2 public immutable permit2;

    constructor(MockPermit2 permit2_) {
        permit2 = permit2_;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(keccak256(commands) == keccak256(hex"10"), "commands");
        require(deadline >= block.timestamp, "deadline");
        require(inputs.length == 1, "inputs");

        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(keccak256(actions) == keccak256(hex"060c0f"), "actions");
        require(params.length == 3, "params");

        (address tokenIn, uint256 amountIn) = abi.decode(params[1], (address, uint256));
        (address tokenOut, uint256 minOut) = abi.decode(params[2], (address, uint256));
        require(minOut == 0, "inner min out");
        permit2.transferFrom(msg.sender, address(this), uint160(amountIn), tokenIn);
        require(MockERC20(tokenOut).transfer(msg.sender, amountIn * 2), "output transfer");
    }
}

contract MockHook {}

contract RobinhoodV4SwapAdapterTest is Test {
    MockERC20 internal token0;
    MockERC20 internal token1;
    MockPermit2 internal permit2;
    MockRobinhoodRouter internal router;
    MockHook internal hook;
    RobinhoodV4SwapAdapter internal adapter;
    address internal user = address(0xA11CE);

    function setUp() public {
        vm.chainId(4663);
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        permit2 = new MockPermit2();
        router = new MockRobinhoodRouter(permit2);
        hook = new MockHook();
        adapter = new RobinhoodV4SwapAdapter(
            address(router), address(permit2), address(token0), address(token1), 0x800000, 60, address(hook)
        );
        token0.mint(user, 100 ether);
        token1.mint(user, 100 ether);
        token0.mint(address(router), 1_000 ether);
        token1.mint(address(router), 1_000 ether);
    }

    function test_exactInputBothDirectionsAndRevokesApprovals() public {
        _swap(token0, token1, 10 ether);
        _swap(token1, token0, 10 ether);
    }

    function test_rejectsUnexpectedData() public {
        vm.prank(user);
        token0.approve(address(adapter), 1 ether);
        vm.expectRevert(RobinhoodV4SwapAdapter.UnexpectedData.selector);
        vm.prank(user);
        adapter.execute(address(token0), 1 ether, hex"01");
    }

    function test_rejectsUnsupportedToken() public {
        MockERC20 other = new MockERC20("Other", "OTHER", 18);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4SwapAdapter.UnsupportedToken.selector, address(other)));
        adapter.execute(address(other), 1 ether, "");
    }

    function test_constructorRejectsWrongChain() public {
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4SwapAdapter.WrongChain.selector, 31337));
        new RobinhoodV4SwapAdapter(
            address(router), address(permit2), address(token0), address(token1), 0x800000, 60, address(hook)
        );
    }

    function _swap(MockERC20 input, MockERC20 output, uint256 amount) private {
        uint256 outputBefore = output.balanceOf(user);
        vm.prank(user);
        input.approve(address(adapter), amount);
        vm.prank(user);
        (address tokenOut, uint256 amountOut) = adapter.execute(address(input), amount, "");

        assertEq(tokenOut, address(output));
        assertEq(amountOut, amount * 2);
        assertEq(output.balanceOf(user), outputBefore + amountOut);
        assertEq(input.allowance(address(adapter), address(permit2)), 0);
        assertEq(permit2.allowanceAmount(address(adapter), address(input), address(router)), 0);
        assertEq(input.balanceOf(address(adapter)), 0);
        assertEq(output.balanceOf(address(adapter)), 0);
    }
}
