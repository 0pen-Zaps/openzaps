// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {BaseV3SwapAdapter, IUniswapV3SwapRouter02} from "../src/adapters/BaseV3SwapAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @dev Fork test against real Base state. Run with:
///      forge test --match-contract BaseV3SwapAdapterForkTest --fork-url https://mainnet.base.org
///      The fork block is pinned so the swap outputs asserted below are deterministic.
contract BaseV3SwapAdapterForkTest is Test {
    // Verified live on Base: SwapRouter02.factory() == V3_FACTORY and SwapRouter02.WETH9() == WETH.
    address internal constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH_USDC_500_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    uint24 internal constant FEE_500 = 500;
    uint256 internal constant FORK_BLOCK = 48900000;

    BaseV3SwapAdapter internal adapter;
    address internal zap;

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org", FORK_BLOCK);
        // WETH sorts below USDC on Base, so token0 = WETH.
        adapter = new BaseV3SwapAdapter(SWAP_ROUTER_02, WETH, USDC, FEE_500);
        zap = makeAddr("zap");
    }

    // --- sanity: the immutable wiring resolves to the real, liquid pool ---------------------------

    function test_constructorPinsRealPool() public view {
        assertEq(block.chainid, 8453, "not base");
        assertEq(IUniswapV3SwapRouter02(SWAP_ROUTER_02).factory(), V3_FACTORY, "router factory");
        assertEq(adapter.pool(), WETH_USDC_500_POOL, "pool");
        assertGt(adapter.pool().code.length, 0, "pool has no code");
        assertEq(adapter.token0(), WETH);
        assertEq(adapter.token1(), USDC);
        assertEq(adapter.fee(), FEE_500);
    }

    // --- a real swap moves the expected balances -------------------------------------------------

    function test_swapWethToUsdcMovesBalances() public {
        uint256 amountIn = 1 ether;
        deal(WETH, zap, amountIn);

        uint256 zapWethBefore = IERC20(WETH).balanceOf(zap);
        uint256 zapUsdcBefore = IERC20(USDC).balanceOf(zap);
        uint256 poolWethBefore = IERC20(WETH).balanceOf(WETH_USDC_500_POOL);

        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        (address tokenOut, uint256 amountOut) = adapter.execute(WETH, amountIn, abi.encode(uint256(1)));
        vm.stopPrank();

        assertEq(tokenOut, USDC, "tokenOut");
        assertGt(amountOut, 0, "no output");
        // Sanity band on a pinned block: 1 WETH is worth well over 100 USDC and well under 100k.
        assertGt(amountOut, 100e6, "implausibly small out");
        assertLt(amountOut, 100_000e6, "implausibly large out");

        assertEq(IERC20(WETH).balanceOf(zap), zapWethBefore - amountIn, "zap weth not debited exactly");
        assertEq(IERC20(USDC).balanceOf(zap), zapUsdcBefore + amountOut, "zap usdc credit != reported out");
        assertEq(IERC20(WETH).balanceOf(WETH_USDC_500_POOL), poolWethBefore + amountIn, "pool weth not credited");

        _assertNoDustNoAllowance();
    }

    function test_swapUsdcToWethMovesBalances() public {
        uint256 amountIn = 2_000e6;
        deal(USDC, zap, amountIn);

        uint256 zapUsdcBefore = IERC20(USDC).balanceOf(zap);
        uint256 zapWethBefore = IERC20(WETH).balanceOf(zap);

        vm.startPrank(zap);
        IERC20(USDC).approve(address(adapter), amountIn);
        (address tokenOut, uint256 amountOut) = adapter.execute(USDC, amountIn, abi.encode(uint256(1)));
        vm.stopPrank();

        assertEq(tokenOut, WETH, "tokenOut");
        assertGt(amountOut, 0, "no output");
        assertEq(IERC20(USDC).balanceOf(zap), zapUsdcBefore - amountIn, "zap usdc not debited exactly");
        assertEq(IERC20(WETH).balanceOf(zap), zapWethBefore + amountOut, "zap weth credit != reported out");

        _assertNoDustNoAllowance();
    }

    /// @dev Round trip proves both directions share one pool and that fees, not accounting bugs,
    ///      account for the shortfall.
    function test_roundTripLosesOnlyFees() public {
        uint256 amountIn = 1 ether;
        deal(WETH, zap, amountIn);

        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        (, uint256 usdcOut) = adapter.execute(WETH, amountIn, abi.encode(uint256(1)));
        IERC20(USDC).approve(address(adapter), usdcOut);
        (, uint256 wethBack) = adapter.execute(USDC, usdcOut, abi.encode(uint256(1)));
        vm.stopPrank();

        assertLt(wethBack, amountIn, "round trip cannot be profitable");
        // Two 0.05% legs plus price impact; a >2% loss would mean something other than fees is leaking.
        assertGt(wethBack, (amountIn * 98) / 100, "round trip lost more than fees");
        _assertNoDustNoAllowance();
    }

    // --- the wrong tokenIn reverts ---------------------------------------------------------------

    function test_wrongTokenInReverts() public {
        address dai = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb; // Base DAI, not in this pair
        deal(dai, zap, 1e18);

        vm.startPrank(zap);
        IERC20(dai).approve(address(adapter), 1e18);
        vm.expectRevert(abi.encodeWithSelector(BaseV3SwapAdapter.UnsupportedToken.selector, dai));
        adapter.execute(dai, 1e18, abi.encode(uint256(1)));
        vm.stopPrank();

        assertEq(IERC20(dai).balanceOf(address(adapter)), 0, "adapter took the unsupported token");
        _assertNoDustNoAllowance();
    }

    // --- an unmeetable min-out reverts -----------------------------------------------------------

    function test_unmeetableMinOutReverts() public {
        uint256 amountIn = 1 ether;
        deal(WETH, zap, amountIn);

        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        // 1e18 USDC (a trillion dollars) out of 1 WETH is unreachable; SwapRouter02 reverts "Too little received".
        vm.expectRevert(bytes("Too little received"));
        adapter.execute(WETH, amountIn, abi.encode(uint256(1e18)));
        vm.stopPrank();

        assertEq(IERC20(WETH).balanceOf(zap), amountIn, "input was not returned by the revert");
        _assertNoDustNoAllowance();
    }

    function test_zeroMinOutReverts() public {
        uint256 amountIn = 1 ether;
        deal(WETH, zap, amountIn);

        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        vm.expectRevert(BaseV3SwapAdapter.ZeroMinimumOut.selector);
        adapter.execute(WETH, amountIn, abi.encode(uint256(0)));
        vm.stopPrank();

        _assertNoDustNoAllowance();
    }

    function test_malformedDataReverts() public {
        uint256 amountIn = 1 ether;
        deal(WETH, zap, amountIn);

        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        vm.expectRevert(abi.encodeWithSelector(BaseV3SwapAdapter.InvalidData.selector, uint256(0)));
        adapter.execute(WETH, amountIn, "");
        // A router-shaped calldata blob is rejected on length alone: this adapter takes no routing bytes.
        bytes memory routerish = abi.encode(uint256(1), address(this));
        vm.expectRevert(abi.encodeWithSelector(BaseV3SwapAdapter.InvalidData.selector, uint256(64)));
        adapter.execute(WETH, amountIn, routerish);
        vm.stopPrank();

        _assertNoDustNoAllowance();
    }

    function test_zeroAmountInReverts() public {
        vm.prank(zap);
        vm.expectRevert(BaseV3SwapAdapter.ZeroAmount.selector);
        adapter.execute(WETH, 0, abi.encode(uint256(1)));
    }

    // --- allowance is zero after success AND after revert ----------------------------------------

    function test_allowanceZeroAfterSuccess() public {
        uint256 amountIn = 0.5 ether;
        deal(WETH, zap, amountIn);

        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        adapter.execute(WETH, amountIn, abi.encode(uint256(1)));
        vm.stopPrank();

        assertEq(IERC20(WETH).allowance(address(adapter), SWAP_ROUTER_02), 0, "weth allowance left standing");
        assertEq(IERC20(USDC).allowance(address(adapter), SWAP_ROUTER_02), 0, "usdc allowance left standing");
        assertEq(IERC20(WETH).allowance(address(adapter), WETH_USDC_500_POOL), 0, "pool allowance left standing");
    }

    /// @dev The revert path is checked from a live outer frame: `expectRevert` rolls back the inner
    ///      call, so if the adapter ever leaked an allowance mid-call it must still read zero here.
    function test_allowanceZeroAfterRevert() public {
        uint256 amountIn = 1 ether;
        deal(WETH, zap, amountIn);

        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        vm.expectRevert(bytes("Too little received"));
        adapter.execute(WETH, amountIn, abi.encode(uint256(1e18)));
        vm.stopPrank();

        assertEq(IERC20(WETH).allowance(address(adapter), SWAP_ROUTER_02), 0, "weth allowance survived revert");
        assertEq(IERC20(USDC).allowance(address(adapter), SWAP_ROUTER_02), 0, "usdc allowance survived revert");

        // And the adapter is still usable afterwards with a sane floor.
        vm.startPrank(zap);
        (, uint256 out) = adapter.execute(WETH, amountIn, abi.encode(uint256(1)));
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(IERC20(WETH).allowance(address(adapter), SWAP_ROUTER_02), 0);
    }

    // --- the adapter holds nothing ---------------------------------------------------------------

    function test_adapterHoldsNoDustAfterManySwaps() public {
        for (uint256 i = 0; i < 3; i++) {
            uint256 amountIn = 0.1 ether;
            deal(WETH, zap, IERC20(WETH).balanceOf(zap) + amountIn);
            vm.startPrank(zap);
            IERC20(WETH).approve(address(adapter), amountIn);
            adapter.execute(WETH, amountIn, abi.encode(uint256(1)));
            vm.stopPrank();
            _assertNoDustNoAllowance();
        }
        assertEq(address(adapter).balance, 0, "adapter holds ether");
    }

    /// @dev A stray transfer to the adapter must not be swept into a later swap's output.
    function test_preexistingDustIsNotCountedAsOutput() public {
        uint256 dust = 123_456;
        deal(USDC, address(adapter), dust);

        uint256 amountIn = 0.25 ether;
        deal(WETH, zap, amountIn);
        vm.startPrank(zap);
        IERC20(WETH).approve(address(adapter), amountIn);
        (, uint256 amountOut) = adapter.execute(WETH, amountIn, abi.encode(uint256(1)));
        vm.stopPrank();

        assertEq(IERC20(USDC).balanceOf(zap), amountOut, "dust was paid out as swap proceeds");
        assertEq(IERC20(USDC).balanceOf(address(adapter)), dust, "dust accounting drifted");
    }

    function _assertNoDustNoAllowance() internal view {
        assertEq(IERC20(WETH).balanceOf(address(adapter)), 0, "adapter holds weth");
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0, "adapter holds usdc");
        assertEq(IERC20(WETH).allowance(address(adapter), SWAP_ROUTER_02), 0, "weth allowance nonzero");
        assertEq(IERC20(USDC).allowance(address(adapter), SWAP_ROUTER_02), 0, "usdc allowance nonzero");
    }
}
