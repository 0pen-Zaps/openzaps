// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {RobinhoodV4PoolAdapter} from "../src/adapters/RobinhoodV4PoolAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface IPermit2Read {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @dev Fork test against real Robinhood Chain state. Run with:
///      forge test --match-contract RobinhoodV4PoolAdapterForkTest \
///        --fork-url https://rpc.mainnet.chain.robinhood.com -vv
///      `setUp` pins its own fork block, so the pool state asserted below is deterministic and a
///      `--fork-url` on the command line does not change what is measured.
contract RobinhoodV4PoolAdapterForkTest is Test {
    string internal constant RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
    uint256 internal constant FORK_BLOCK = 16_728_000;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    // aeWETH (18dp) sorts below USDG (6dp), which sorts below ZAPS.
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    // Static-fee, HOOKLESS aeWETH/USDG pool. Selected by reading every Initialize log for this
    // currency pair out of the PoolManager and keeping the one with the deepest live liquidity.
    uint24 internal constant STATIC_FEE = 450;
    int24 internal constant STATIC_TICK_SPACING = 9;
    bytes32 internal constant STATIC_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;

    // Dynamic-fee, HOOKED aeWETH/ZAPS pool — the one RobinhoodV4SwapAdapter hardcodes.
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant DYNAMIC_TICK_SPACING = 200;
    bytes32 internal constant DYNAMIC_POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;

    /// @dev v4 `StateLibrary.POOLS_SLOT`, and the offset of `Pool.State.liquidity` within it.
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    RobinhoodV4PoolAdapter internal adapter;
    address internal zap;

    function setUp() public {
        vm.createSelectFork(RPC_URL, FORK_BLOCK);
        adapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, STATIC_FEE, STATIC_TICK_SPACING, address(0)
        );
        zap = makeAddr("zap");
    }

    // --- sanity: the constructor immutables resolve to a real, liquid pool ------------------------

    function test_constructorPinsRealLiquidHooklessPool() public view {
        assertEq(block.chainid, 4663, "not robinhood chain");
        assertEq(adapter.poolId(), STATIC_POOL_ID, "pool id");
        assertEq(adapter.currency0(), AEWETH);
        assertEq(adapter.currency1(), USDG);
        assertEq(adapter.fee(), STATIC_FEE);
        assertEq(adapter.tickSpacing(), STATIC_TICK_SPACING);
        assertEq(adapter.hooks(), address(0), "hookless");
        assertGt(_liquidity(STATIC_POOL_ID), 0, "static pool has no liquidity");
        assertGt(_liquidity(DYNAMIC_POOL_ID), 0, "dynamic pool has no liquidity");
    }

    // --- the point of the contract: one codebase, two different pools -----------------------------

    /// @dev A static-fee pool with `hooks == address(0)` routes through exactly the same
    ///      V4_SWAP / SWAP_EXACT_IN_SINGLE+SETTLE_ALL+TAKE_ALL encoding as the dynamic-fee pool.
    ///      This is the claim the hardcoded adapter could not test, so it is asserted here rather
    ///      than assumed.
    function test_staticFeeHooklessPoolSwapsBothDirections() public {
        uint256 wethIn = 0.05 ether;
        deal(AEWETH, zap, wethIn);

        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(adapter), wethIn);
        (address tokenOut, uint256 usdgOut) = adapter.execute(AEWETH, wethIn, "");
        vm.stopPrank();

        assertEq(tokenOut, USDG, "tokenOut");
        assertGt(usdgOut, 0, "no usdg out");
        assertEq(IERC20(USDG).balanceOf(zap), usdgOut, "zap did not receive the measured delta");
        assertEq(IERC20(AEWETH).balanceOf(zap), 0, "input not fully consumed");
        _assertNoDustAndNoAllowance(AEWETH, USDG);

        // ...and back the other way, currency1 -> currency0.
        uint256 usdgIn = usdgOut / 2;
        vm.startPrank(zap);
        IERC20(USDG).approve(address(adapter), usdgIn);
        (address tokenOutBack, uint256 wethOut) = adapter.execute(USDG, usdgIn, "");
        vm.stopPrank();

        assertEq(tokenOutBack, AEWETH, "tokenOut back");
        assertGt(wethOut, 0, "no weth out");
        assertEq(IERC20(AEWETH).balanceOf(zap), wethOut, "zap did not receive the measured delta");
        _assertNoDustAndNoAllowance(USDG, AEWETH);
    }

    /// @dev The same bytecode, deployed a second time against the dynamic-fee hooked pool that
    ///      `RobinhoodV4SwapAdapter` hardcodes. Both fee kinds must work or the adapter is not
    ///      pool-agnostic.
    function test_dynamicFeeHookedPoolSwapsThroughSameEncoding() public {
        RobinhoodV4PoolAdapter hooked = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, ZAPS, DYNAMIC_FEE_FLAG, DYNAMIC_TICK_SPACING, ZAPS_HOOK
        );
        assertEq(hooked.poolId(), DYNAMIC_POOL_ID, "dynamic pool id");

        uint256 wethIn = 0.001 ether;
        deal(AEWETH, zap, wethIn);

        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(hooked), wethIn);
        (address tokenOut, uint256 zapsOut) = hooked.execute(AEWETH, wethIn, "");
        vm.stopPrank();

        assertEq(tokenOut, ZAPS, "tokenOut");
        assertGt(zapsOut, 0, "no zaps out");
        assertEq(IERC20(ZAPS).balanceOf(zap), zapsOut);
        assertEq(IERC20(AEWETH).balanceOf(address(hooked)), 0, "input dust");
        assertEq(IERC20(ZAPS).balanceOf(address(hooked)), 0, "output dust");
        assertEq(IERC20(AEWETH).allowance(address(hooked), PERMIT2), 0, "erc20 allowance");
    }

    // --- refusals ---------------------------------------------------------------------------------

    function test_wrongTokenInReverts() public {
        deal(ZAPS, zap, 1 ether);
        vm.startPrank(zap);
        IERC20(ZAPS).approve(address(adapter), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.UnsupportedToken.selector, ZAPS));
        adapter.execute(ZAPS, 1 ether, "");
        vm.stopPrank();
    }

    function test_unmeetableMinOutReverts() public {
        uint256 wethIn = 0.05 ether;
        deal(AEWETH, zap, wethIn);

        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(adapter), wethIn);
        (bool ok,) = address(adapter)
            .call(
                abi.encodeWithSelector(
                    RobinhoodV4PoolAdapter.execute.selector, AEWETH, wethIn, abi.encode(uint256(type(uint128).max))
                )
            );
        vm.stopPrank();

        assertFalse(ok, "unmeetable min-out did not revert");
        // The revert rolls the whole step back: the caller keeps its input, the adapter holds
        // nothing, and neither allowance leg survives.
        assertEq(IERC20(AEWETH).balanceOf(zap), wethIn, "input not returned by revert");
        assertEq(IERC20(USDG).balanceOf(zap), 0, "output leaked on a reverting path");
        _assertNoDustAndNoAllowance(AEWETH, USDG);
    }

    function test_metMinOutSucceeds() public {
        uint256 wethIn = 0.05 ether;
        deal(AEWETH, zap, wethIn);

        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(adapter), wethIn);
        (, uint256 usdgOut) = adapter.execute(AEWETH, wethIn, abi.encode(uint256(1)));
        vm.stopPrank();

        assertGe(usdgOut, 1, "min-out not honoured");
        _assertNoDustAndNoAllowance(AEWETH, USDG);
    }

    function test_rejectsAnythingThatIsNotASingleMinOutWord() public {
        deal(AEWETH, zap, 1 ether);
        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(adapter), 1 ether);

        // A would-be route blob.
        vm.expectRevert(RobinhoodV4PoolAdapter.InvalidData.selector);
        adapter.execute(AEWETH, 1 ether, abi.encodePacked(UNIVERSAL_ROUTER, bytes4(0xdeadbeef)));

        // Two words, i.e. anything richer than the one bounded scalar.
        vm.expectRevert(RobinhoodV4PoolAdapter.InvalidData.selector);
        adapter.execute(AEWETH, 1 ether, abi.encode(uint256(1), uint256(2)));

        // A min-out that cannot fit the router's uint128 field.
        vm.expectRevert(RobinhoodV4PoolAdapter.AmountTooLarge.selector);
        adapter.execute(AEWETH, 1 ether, abi.encode(uint256(type(uint128).max) + 1));
        vm.stopPrank();
    }

    function test_zeroAmountReverts() public {
        vm.prank(zap);
        vm.expectRevert(RobinhoodV4PoolAdapter.ZeroAmount.selector);
        adapter.execute(AEWETH, 0, "");
    }

    // --- constructor refusals ---------------------------------------------------------------------

    function test_nativeEthPoolKeyRejectedAtDeploy() public {
        // currency0 == address(0) is how a v4 PoolKey spells native ETH. OpenZap can never settle
        // on it, so the adapter must refuse to exist rather than fail later.
        vm.expectRevert(RobinhoodV4PoolAdapter.NativeCurrencyUnsupported.selector);
        new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, address(0), USDG, STATIC_FEE, STATIC_TICK_SPACING, address(0)
        );
    }

    function test_unsortedOrDuplicateCurrenciesRejectedAtDeploy() public {
        vm.expectRevert(RobinhoodV4PoolAdapter.InvalidCurrencyOrder.selector);
        new RobinhoodV4PoolAdapter(UNIVERSAL_ROUTER, PERMIT2, USDG, AEWETH, STATIC_FEE, STATIC_TICK_SPACING, address(0));

        vm.expectRevert(RobinhoodV4PoolAdapter.InvalidCurrencyOrder.selector);
        new RobinhoodV4PoolAdapter(UNIVERSAL_ROUTER, PERMIT2, USDG, USDG, STATIC_FEE, STATIC_TICK_SPACING, address(0));
    }

    function test_dynamicFeeWithoutHookRejectedAtDeploy() public {
        vm.expectRevert(RobinhoodV4PoolAdapter.DynamicFeeRequiresHook.selector);
        new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, DYNAMIC_FEE_FLAG, DYNAMIC_TICK_SPACING, address(0)
        );
    }

    function test_outOfRangeFeeAndTickSpacingRejectedAtDeploy() public {
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.InvalidFee.selector, uint24(1_000_001)));
        new RobinhoodV4PoolAdapter(UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, 1_000_001, STATIC_TICK_SPACING, address(0));

        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.InvalidTickSpacing.selector, int24(0)));
        new RobinhoodV4PoolAdapter(UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, STATIC_FEE, 0, address(0));

        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.InvalidTickSpacing.selector, int24(32768)));
        new RobinhoodV4PoolAdapter(UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, STATIC_FEE, 32768, address(0));
    }

    function test_codelessDependenciesRejectedAtDeploy() public {
        address notAContract = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.NoCode.selector, notAContract));
        new RobinhoodV4PoolAdapter(notAContract, PERMIT2, AEWETH, USDG, STATIC_FEE, STATIC_TICK_SPACING, address(0));

        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.NoCode.selector, notAContract));
        new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, DYNAMIC_FEE_FLAG, STATIC_TICK_SPACING, notAContract
        );
    }

    function test_wrongChainRejectedAtDeploy() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.WrongChain.selector, uint256(1)));
        new RobinhoodV4PoolAdapter(UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, STATIC_FEE, STATIC_TICK_SPACING, address(0));
    }

    function test_wrongChainRejectedAtExecute() public {
        deal(AEWETH, zap, 1 ether);
        vm.chainId(1);
        vm.prank(zap);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4PoolAdapter.WrongChain.selector, uint256(1)));
        adapter.execute(AEWETH, 1 ether, "");
    }

    // --- helpers ----------------------------------------------------------------------------------

    function _assertNoDustAndNoAllowance(address tokenIn, address tokenOut) internal view {
        assertEq(IERC20(tokenIn).balanceOf(address(adapter)), 0, "input dust stranded in adapter");
        assertEq(IERC20(tokenOut).balanceOf(address(adapter)), 0, "output dust stranded in adapter");
        assertEq(IERC20(tokenIn).allowance(address(adapter), PERMIT2), 0, "erc20 allowance to permit2");
        assertEq(IERC20(tokenOut).allowance(address(adapter), PERMIT2), 0, "erc20 allowance to permit2");
        (uint160 amountIn,,) = IPermit2Read(PERMIT2).allowance(address(adapter), tokenIn, UNIVERSAL_ROUTER);
        assertEq(amountIn, 0, "permit2 allowance to router");
        (uint160 amountOut,,) = IPermit2Read(PERMIT2).allowance(address(adapter), tokenOut, UNIVERSAL_ROUTER);
        assertEq(amountOut, 0, "permit2 allowance to router");
    }

    function _liquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(poolId, POOLS_SLOT));
        bytes32 raw = IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(stateSlot) + LIQUIDITY_OFFSET));
        return uint128(uint256(raw));
    }
}
