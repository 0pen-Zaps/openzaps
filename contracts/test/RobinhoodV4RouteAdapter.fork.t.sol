// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4RouteAdapter} from "../src/adapters/RobinhoodV4RouteAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";

interface IPermit2Read {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// @dev Fork test against real Robinhood Chain state, pinned to the same block as the
///      `RobinhoodV4PoolAdapter` suite so the pool depths asserted there hold here too.
///      Unconditional on purpose: it either runs against real chain state or fails loudly.
contract RobinhoodV4RouteAdapterForkTest is Test {
    string internal constant RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
    uint256 internal constant FORK_BLOCK = 16_728_000;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // aeWETH (18dp) sorts below USDG (6dp), which sorts below ZAPS (18dp).
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    // Hop 1: static-fee HOOKLESS aeWETH/USDG pool (deepest live for the pair).
    uint24 internal constant STATIC_FEE = 450;
    int24 internal constant STATIC_TICK_SPACING = 9;
    bytes32 internal constant STATIC_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;

    // Hop 2: dynamic-fee HOOKED aeWETH/ZAPS pool — the production 0xZAPS pool.
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant DYNAMIC_TICK_SPACING = 200;
    bytes32 internal constant DYNAMIC_POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;

    uint256 internal constant AMOUNT_IN_USDG = 50_000_000; // 50 USDG (6dp)

    RobinhoodV4RouteAdapter internal adapter;
    address internal zap;

    function setUp() public {
        vm.createSelectFork(RPC_URL, FORK_BLOCK);
        adapter = new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, _forwardPath(), _forwardHops());
        zap = makeAddr("zap");
    }

    // --- wiring: the frozen route resolves to the two intended live pools ------------------------

    function test_constructorPinsBothRealPools() public view {
        assertEq(block.chainid, 4663, "not robinhood chain");
        assertEq(adapter.hopCount(), 2);
        assertEq(adapter.poolId(0), STATIC_POOL_ID, "hop 0 pool id");
        assertEq(adapter.poolId(1), DYNAMIC_POOL_ID, "hop 1 pool id");

        address[] memory path = adapter.route();
        assertEq(path.length, 3);
        assertEq(path[0], USDG);
        assertEq(path[1], AEWETH);
        assertEq(path[2], ZAPS);

        RobinhoodV4RouteAdapter.PoolKey memory h0 = adapter.hop(0);
        assertEq(h0.currency0, AEWETH);
        assertEq(h0.currency1, USDG);
        assertEq(h0.hooks, address(0), "hop 0 hookless");
        RobinhoodV4RouteAdapter.PoolKey memory h1 = adapter.hop(1);
        assertEq(h1.currency0, AEWETH);
        assertEq(h1.currency1, ZAPS);
        assertEq(h1.hooks, ZAPS_HOOK, "hop 1 hooked");
    }

    // --- the point of the contract: two pools, never directly paired, one stitched call ----------

    function test_twoHopSwap_usdgToZaps_stitchedInOneCall() public {
        deal(USDG, zap, AMOUNT_IN_USDG);
        vm.prank(zap);
        IERC20(USDG).approve(address(adapter), AMOUNT_IN_USDG);

        vm.prank(zap);
        (address tokenOut, uint256 amountOut) = adapter.execute(USDG, AMOUNT_IN_USDG, "");

        assertEq(tokenOut, ZAPS);
        assertGt(amountOut, 0, "no ZAPS output");
        assertEq(IERC20(ZAPS).balanceOf(zap), amountOut, "output must land on the caller");
        assertEq(IERC20(USDG).balanceOf(zap), 0, "input exactly consumed");
        _assertAdapterCleaned();
    }

    function test_twoHopSwap_reverseRoute_zapsToUsdg() public {
        RobinhoodV4RouteAdapter reverse =
            new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, _reversePath(), _reverseHops());
        assertEq(reverse.poolId(0), DYNAMIC_POOL_ID);
        assertEq(reverse.poolId(1), STATIC_POOL_ID);

        uint256 zapsIn = 100_000 ether; // ~small against the pool's 9.97e23 liquidity
        deal(ZAPS, zap, zapsIn);
        vm.prank(zap);
        IERC20(ZAPS).approve(address(reverse), zapsIn);

        vm.prank(zap);
        (address tokenOut, uint256 amountOut) = reverse.execute(ZAPS, zapsIn, "");

        assertEq(tokenOut, USDG);
        assertGt(amountOut, 0, "no USDG output");
        assertEq(IERC20(USDG).balanceOf(zap), amountOut);
        assertEq(IERC20(ZAPS).balanceOf(zap), 0);
    }

    // --- slippage floor on the FINAL output ------------------------------------------------------

    function test_finalMinAmountOutFloorsTheWholeRoute() public {
        deal(USDG, zap, AMOUNT_IN_USDG * 2);
        vm.prank(zap);
        IERC20(USDG).approve(address(adapter), AMOUNT_IN_USDG * 2);

        // Learn the achievable output, then rewind so pool state is identical for both runs.
        uint256 snapshot = vm.snapshotState();
        vm.prank(zap);
        (, uint256 achievable) = adapter.execute(USDG, AMOUNT_IN_USDG, "");
        assertTrue(vm.revertToState(snapshot));

        // One wei above the achievable output must revert (the router's own floor fires first, so
        // any revert is acceptable — the local InsufficientOutput is defence-in-depth behind it).
        vm.prank(zap);
        vm.expectRevert();
        adapter.execute(USDG, AMOUNT_IN_USDG, abi.encode(achievable + 1));

        // Exactly the achievable output must pass.
        vm.prank(zap);
        (, uint256 amountOut) = adapter.execute(USDG, AMOUNT_IN_USDG, abi.encode(achievable));
        assertEq(amountOut, achievable, "deterministic at a pinned block");
    }

    // --- input validation ------------------------------------------------------------------------

    function test_rejectsMalformedDataAndInputs() public {
        deal(USDG, zap, AMOUNT_IN_USDG);
        vm.prank(zap);
        IERC20(USDG).approve(address(adapter), AMOUNT_IN_USDG);

        vm.prank(zap);
        vm.expectRevert(RobinhoodV4RouteAdapter.InvalidData.selector);
        adapter.execute(USDG, AMOUNT_IN_USDG, hex"deadbeef");

        vm.prank(zap);
        vm.expectRevert(RobinhoodV4RouteAdapter.AmountTooLarge.selector);
        adapter.execute(USDG, AMOUNT_IN_USDG, abi.encode(uint256(type(uint128).max) + 1));

        vm.prank(zap);
        vm.expectRevert(RobinhoodV4RouteAdapter.ZeroAmount.selector);
        adapter.execute(USDG, 0, "");

        // The intermediate token is NOT a valid input: the route starts at path[0], full stop.
        vm.prank(zap);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4RouteAdapter.UnsupportedToken.selector, AEWETH));
        adapter.execute(AEWETH, 1 ether, "");

        vm.prank(zap);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4RouteAdapter.UnsupportedToken.selector, ZAPS));
        adapter.execute(ZAPS, 1 ether, "");
    }

    function test_constructorRefusesBrokenRoutes() public {
        // A hop that does not connect consecutive path tokens.
        RobinhoodV4RouteAdapter.PoolKey[] memory hops = _forwardHops();
        (hops[0], hops[1]) = (hops[1], hops[0]);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4RouteAdapter.HopMismatchesPath.selector, 0));
        new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, _forwardPath(), hops);

        // A route that revisits a token (circular: USDG -> aeWETH -> USDG).
        address[] memory circular = new address[](3);
        circular[0] = USDG;
        circular[1] = AEWETH;
        circular[2] = USDG;
        RobinhoodV4RouteAdapter.PoolKey[] memory circularHops = new RobinhoodV4RouteAdapter.PoolKey[](2);
        circularHops[0] = _forwardHops()[0];
        circularHops[1] = _forwardHops()[0];
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4RouteAdapter.RouteRevisitsToken.selector, USDG));
        new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, circular, circularHops);

        // One hop is RobinhoodV4PoolAdapter's job.
        address[] memory shortPath = new address[](2);
        shortPath[0] = USDG;
        shortPath[1] = AEWETH;
        RobinhoodV4RouteAdapter.PoolKey[] memory oneHop = new RobinhoodV4RouteAdapter.PoolKey[](1);
        oneHop[0] = _forwardHops()[0];
        vm.expectRevert(RobinhoodV4RouteAdapter.InvalidRouteLength.selector);
        new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, shortPath, oneHop);

        // Path length must be hops + 1.
        vm.expectRevert(RobinhoodV4RouteAdapter.InvalidRouteLength.selector);
        new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, shortPath, _forwardHops());

        // Dynamic fee without a hook.
        RobinhoodV4RouteAdapter.PoolKey[] memory noHook = _forwardHops();
        noHook[1].hooks = address(0);
        vm.expectRevert(RobinhoodV4RouteAdapter.DynamicFeeRequiresHook.selector);
        new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, _forwardPath(), noHook);

        // Unsorted hop currencies.
        RobinhoodV4RouteAdapter.PoolKey[] memory unsorted = _forwardHops();
        (unsorted[0].currency0, unsorted[0].currency1) = (unsorted[0].currency1, unsorted[0].currency0);
        vm.expectRevert(RobinhoodV4RouteAdapter.InvalidCurrencyOrder.selector);
        new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, _forwardPath(), unsorted);
    }

    // --- donations can never be spent or reported ------------------------------------------------

    function test_donationsNeverSpentNorReported() public {
        // Donate all three route tokens to the adapter before the run.
        deal(USDG, address(adapter), 7_000_000);
        deal(AEWETH, address(adapter), 0.01 ether);
        deal(ZAPS, address(adapter), 123 ether);

        deal(USDG, zap, AMOUNT_IN_USDG);
        vm.prank(zap);
        IERC20(USDG).approve(address(adapter), AMOUNT_IN_USDG);
        vm.prank(zap);
        (, uint256 amountOut) = adapter.execute(USDG, AMOUNT_IN_USDG, "");

        // The caller received exactly the measured delta; every donation is still sitting on the
        // adapter, unspent and unreported.
        assertEq(IERC20(ZAPS).balanceOf(zap), amountOut);
        assertEq(IERC20(USDG).balanceOf(address(adapter)), 7_000_000, "input donation spent");
        assertEq(IERC20(AEWETH).balanceOf(address(adapter)), 0.01 ether, "intermediate donation spent");
        assertEq(IERC20(ZAPS).balanceOf(address(adapter)), 123 ether, "output donation swept");
    }

    // --- end to end: a real OpenZap capsule executes the stitched route --------------------------

    function test_endToEnd_stitchedRouteThroughRealOpenZapClone() public {
        AdapterRegistry registry = new AdapterRegistry(address(this));
        TokenAllowlist allowlist = new TokenAllowlist(address(this));
        OpenZapFactory factory = new OpenZapFactory(registry, allowlist);
        registry.setAdapter(address(adapter), true);
        allowlist.setToken(USDG, true);
        allowlist.setToken(ZAPS, true);

        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        address relayer = makeAddr("relayer");

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(adapter), tokenIn: USDG, amountIn: AMOUNT_IN_USDG, spender: address(adapter), data: ""
        });
        address[] memory trackedAssets = new address[](2);
        trackedAssets[0] = USDG;
        trackedAssets[1] = ZAPS;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });

        address zapAddress = factory.createZap(policy, keccak256("stitched-route-fork"));
        OpenZap capsule = OpenZap(payable(zapAddress));
        deal(USDG, zapAddress, AMOUNT_IN_USDG);

        OpenZapIntent memory intent = OpenZapIntent({
            zap: zapAddress,
            chainId: block.chainid,
            nonce: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: owner,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: capsule.policyHash(),
            outAsset: ZAPS,
            minOut: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, capsule.hashIntent(intent));

        vm.prank(relayer);
        capsule.execute(intent, abi.encodePacked(r, s, v));

        assertGt(IERC20(ZAPS).balanceOf(owner), 0, "recipient got no ZAPS");
        assertEq(IERC20(USDG).balanceOf(zapAddress), 0, "capsule USDG not consumed");
        assertEq(IERC20(USDG).allowance(zapAddress, address(adapter)), 0, "residual step allowance");
        assertTrue(capsule.nonceUsed(0));
        _assertAdapterCleaned();
    }

    // --- helpers ---------------------------------------------------------------------------------

    function _forwardPath() internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = USDG;
        path[1] = AEWETH;
        path[2] = ZAPS;
    }

    function _forwardHops() internal pure returns (RobinhoodV4RouteAdapter.PoolKey[] memory hops) {
        hops = new RobinhoodV4RouteAdapter.PoolKey[](2);
        hops[0] = RobinhoodV4RouteAdapter.PoolKey({
            currency0: AEWETH, currency1: USDG, fee: STATIC_FEE, tickSpacing: STATIC_TICK_SPACING, hooks: address(0)
        });
        hops[1] = RobinhoodV4RouteAdapter.PoolKey({
            currency0: AEWETH,
            currency1: ZAPS,
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: DYNAMIC_TICK_SPACING,
            hooks: ZAPS_HOOK
        });
    }

    function _reversePath() internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = ZAPS;
        path[1] = AEWETH;
        path[2] = USDG;
    }

    function _reverseHops() internal pure returns (RobinhoodV4RouteAdapter.PoolKey[] memory hops) {
        RobinhoodV4RouteAdapter.PoolKey[] memory forward = _forwardHops();
        hops = new RobinhoodV4RouteAdapter.PoolKey[](2);
        hops[0] = forward[1];
        hops[1] = forward[0];
    }

    function _assertAdapterCleaned() internal view {
        address[3] memory tokens = [USDG, AEWETH, ZAPS];
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20(tokens[i]).allowance(address(adapter), PERMIT2), 0, "residual ERC-20 approval");
            (uint160 permitAmount,,) = IPermit2Read(PERMIT2).allowance(address(adapter), tokens[i], UNIVERSAL_ROUTER);
            assertEq(uint256(permitAmount), 0, "residual Permit2 allowance");
        }
    }
}
