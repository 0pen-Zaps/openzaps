// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";

interface IERC20Live {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETHLive is IERC20Live {
    function deposit() external payable;
}

/// @dev Opt-in fork test. Run with RUN_ROBINHOOD_FORK=true forge test --match-contract RobinhoodV4ForkTest -vv.
contract RobinhoodV4ForkTest is Test {
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    function test_livePoolSwapsBothDirections() public {
        // Report a SKIP, never a PASS: an opt-in test that returns early looks identical to one
        // that ran, which is how a suite ends up green on coverage it never had.
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));

        RobinhoodV4SwapAdapter adapter =
            new RobinhoodV4SwapAdapter(UNIVERSAL_ROUTER, PERMIT2, WETH, ZAPS, 0x800000, 200, HOOK);
        assertEq(adapter.poolId(), 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573);

        address user = makeAddr("robinhood-fork-user");
        vm.deal(user, 1 ether);
        uint256 wethIn = 0.0001 ether;
        vm.startPrank(user);
        IWETHLive(WETH).deposit{value: wethIn}();
        IERC20Live(WETH).approve(address(adapter), wethIn);
        (, uint256 zapsOut) = adapter.execute(WETH, wethIn, "");
        assertGt(zapsOut, 0);

        uint256 zapsToSell = zapsOut / 2;
        uint256 wethBeforeSell = IERC20Live(WETH).balanceOf(user);
        IERC20Live(ZAPS).approve(address(adapter), zapsToSell);
        (, uint256 wethOut) = adapter.execute(ZAPS, zapsToSell, "");
        vm.stopPrank();

        assertGt(wethOut, 0);
        assertEq(IERC20Live(WETH).balanceOf(user), wethBeforeSell + wethOut);
        assertEq(IERC20Live(WETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20Live(ZAPS).balanceOf(address(adapter)), 0);
    }
}
