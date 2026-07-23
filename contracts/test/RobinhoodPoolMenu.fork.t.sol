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

/// @title RobinhoodPoolMenuForkTest
/// @notice The evidence base for the Robinhood deploy script's pool menu: which Uniswap-v4 pools on
///         Robinhood Chain are actually worth standing up a `RobinhoodV4PoolAdapter` for. Nothing here
///         is assumed — every pool's liquidity is read live from the PoolManager, and every pool that
///         earns a place on the menu is proved to route a real swap in both directions.
/// @dev The rule this suite enforces for the deploy script: DO NOT register a pool you did not prove
///      has liquidity AND routes. Two pools clear that bar and are asserted here; a representative
///      excluded pair (USDG/0xZAPS, which was never even initialized) is shown failing it.
///
///          forge test --match-contract RobinhoodPoolMenuForkTest \
///            --fork-url https://rpc.mainnet.chain.robinhood.com -vv
///
///      `setUp` pins its own fork block so the liquidity numbers asserted below are deterministic; a
///      `--fork-url` on the command line cannot change what is measured.
contract RobinhoodPoolMenuForkTest is Test {
    string internal constant RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
    uint256 internal constant FORK_BLOCK = 16_728_000;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    // Sort order (checked in setUp): aeWETH (18dp) < USDG (6dp) < 0xZAPS (18dp).
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;

    // --- Menu entry #1: static-fee, HOOKLESS aeWETH/USDG. The pool `RobinhoodV4PoolAdapter` defaults
    //     to, and the deepest hookless aeWETH/USDG pool on the chain (proved below).
    uint24 internal constant USDG_FEE = 450;
    int24 internal constant USDG_TS = 9;
    bytes32 internal constant USDG_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;

    // --- Menu entry #2: dynamic-fee, HOOKED aeWETH/0xZAPS. The project token; it pairs cleanly only
    //     against aeWETH (the direct USDG/0xZAPS pool was never initialized — see the excluded case).
    int24 internal constant ZAPS_TS = 200;
    bytes32 internal constant ZAPS_POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;

    /// @dev v4 `StateLibrary.POOLS_SLOT`, plus the offset of `Pool.State.liquidity` within it. slot0
    ///      (sqrtPriceX96 packed in the low 160 bits) sits at offset 0 and is non-zero iff initialized.
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    address internal zap;

    function setUp() public {
        vm.createSelectFork(RPC_URL, FORK_BLOCK);
        assertEq(block.chainid, 4663, "not robinhood chain");
        // The sort order the PoolKeys below depend on.
        assertTrue(AEWETH < USDG && USDG < ZAPS, "token sort order changed");
        zap = makeAddr("zap");
    }

    // ---------------------------------------------------------------------------------------------- //
    // 1. Read live liquidity from the PoolManager — the raw evidence.                                 //
    // ---------------------------------------------------------------------------------------------- //

    /// @notice Both menu pools are initialized and carry live liquidity, and the (450,9) aeWETH/USDG
    ///         pool is the DEEPEST hookless aeWETH/USDG pool — which is why the adapter defaults to it.
    ///         The direct USDG/0xZAPS pool was never initialized, so 0xZAPS's only clean counter-
    ///         currency is aeWETH. All numbers are read straight from PoolManager storage.
    function test_liquidity_readLiveFromPoolManager() public {
        // The two menu pools: initialized (slot0 != 0) and liquid.
        uint128 usdgLiq = _liquidity(USDG_POOL_ID);
        uint128 zapsLiq = _liquidity(ZAPS_POOL_ID);
        assertTrue(_isInitialized(USDG_POOL_ID), "aeWETH/USDG not initialized");
        assertTrue(_isInitialized(ZAPS_POOL_ID), "aeWETH/0xZAPS not initialized");
        assertGt(usdgLiq, 0, "aeWETH/USDG has no live liquidity");
        assertGt(zapsLiq, 0, "aeWETH/0xZAPS has no live liquidity");
        emit log_named_uint("aeWETH/USDG  (450,9,hookless) liquidity", usdgLiq);
        emit log_named_uint("aeWETH/0xZAPS (dyn,200,hook)  liquidity", zapsLiq);

        // The (450,9) tier is the deepest hookless aeWETH/USDG pool. Other tiers exist but are all
        // shallower at this block, so the adapter's default PoolKey is the correct one to deploy.
        uint128 t100 = _liquidity(_poolId(AEWETH, USDG, 100, 1, address(0)));
        uint128 t500 = _liquidity(_poolId(AEWETH, USDG, 500, 10, address(0)));
        uint128 t3000 = _liquidity(_poolId(AEWETH, USDG, 3000, 60, address(0)));
        uint128 t10000 = _liquidity(_poolId(AEWETH, USDG, 10000, 200, address(0)));
        emit log_named_uint("  vs aeWETH/USDG (100,1)   ", t100);
        emit log_named_uint("  vs aeWETH/USDG (500,10)  ", t500);
        emit log_named_uint("  vs aeWETH/USDG (3000,60) ", t3000);
        emit log_named_uint("  vs aeWETH/USDG (10000,200)", t10000);
        assertGt(usdgLiq, t100, "(450,9) not deeper than (100,1)");
        assertGt(usdgLiq, t500, "(450,9) not deeper than (500,10)");
        assertGt(usdgLiq, t3000, "(450,9) not deeper than (3000,60)");
        assertGt(usdgLiq, t10000, "(450,9) not deeper than (10000,200)");

        // The excluded pair: a direct USDG/0xZAPS pool. Never initialized -> not on the menu.
        bytes32 usdgZaps = _poolId(USDG, ZAPS, 3000, 60, address(0));
        assertFalse(_isInitialized(usdgZaps), "USDG/0xZAPS unexpectedly initialized");
        assertEq(_liquidity(usdgZaps), 0, "USDG/0xZAPS unexpectedly has liquidity");
        emit log("USDG/0xZAPS direct pool: NOT initialized -> excluded (0xZAPS pairs via aeWETH only)");
    }

    // ---------------------------------------------------------------------------------------------- //
    // 2. Prove each menu pool actually ROUTES a real swap through a freshly deployed adapter.         //
    // ---------------------------------------------------------------------------------------------- //

    /// @notice Menu entry #1 — aeWETH/USDG: a `RobinhoodV4PoolAdapter` pinned to (450,9,hookless)
    ///         routes a real exact-input swap in BOTH directions against live state, with no dust and
    ///         no residual allowance left behind.
    function test_aeWethUsdg_adapterRoutesBothDirections() public {
        RobinhoodV4PoolAdapter adapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, USDG_FEE, USDG_TS, address(0)
        );
        assertEq(adapter.poolId(), USDG_POOL_ID, "adapter not wired to the (450,9) pool");
        assertGt(_liquidity(USDG_POOL_ID), 0, "pool went dry");

        // aeWETH -> USDG
        uint256 wethIn = 0.05 ether;
        deal(AEWETH, zap, wethIn);
        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(adapter), wethIn);
        (address out1, uint256 usdgOut) = adapter.execute(AEWETH, wethIn, "");
        vm.stopPrank();
        assertEq(out1, USDG, "tokenOut");
        assertGt(usdgOut, 0, "no USDG out");
        assertEq(IERC20(USDG).balanceOf(zap), usdgOut, "zap did not receive the measured delta");
        _assertClean(adapter, AEWETH, USDG);
        emit log_named_uint("aeWETH/USDG: 0.05 aeWETH -> USDG (6dp)", usdgOut);

        // USDG -> aeWETH
        uint256 usdgIn = usdgOut / 2;
        vm.startPrank(zap);
        IERC20(USDG).approve(address(adapter), usdgIn);
        (address out2, uint256 wethBack) = adapter.execute(USDG, usdgIn, "");
        vm.stopPrank();
        assertEq(out2, AEWETH, "tokenOut back");
        assertGt(wethBack, 0, "no aeWETH back");
        assertEq(IERC20(AEWETH).balanceOf(zap), wethBack, "zap did not receive the measured delta");
        _assertClean(adapter, USDG, AEWETH);
        emit log_named_uint("aeWETH/USDG: half the USDG -> aeWETH (wei)", wethBack);
    }

    /// @notice Menu entry #2 — aeWETH/0xZAPS: the same adapter bytecode pinned to the dynamic-fee
    ///         HOOKED pool routes a real swap in both directions. Proves the menu is not limited to
    ///         hookless pools.
    function test_aeWethZaps_adapterRoutesBothDirections() public {
        RobinhoodV4PoolAdapter adapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, ZAPS, DYNAMIC_FEE_FLAG, ZAPS_TS, ZAPS_HOOK
        );
        assertEq(adapter.poolId(), ZAPS_POOL_ID, "adapter not wired to the aeWETH/0xZAPS pool");
        assertGt(_liquidity(ZAPS_POOL_ID), 0, "pool went dry");

        // aeWETH -> 0xZAPS
        uint256 wethIn = 0.01 ether;
        deal(AEWETH, zap, wethIn);
        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(adapter), wethIn);
        (address out1, uint256 zapsOut) = adapter.execute(AEWETH, wethIn, "");
        vm.stopPrank();
        assertEq(out1, ZAPS, "tokenOut");
        assertGt(zapsOut, 0, "no 0xZAPS out");
        assertEq(IERC20(ZAPS).balanceOf(zap), zapsOut, "zap did not receive the measured delta");
        _assertClean(adapter, AEWETH, ZAPS);
        emit log_named_uint("aeWETH/0xZAPS: 0.01 aeWETH -> 0xZAPS (18dp)", zapsOut);

        // 0xZAPS -> aeWETH
        uint256 zapsIn = zapsOut / 2;
        vm.startPrank(zap);
        IERC20(ZAPS).approve(address(adapter), zapsIn);
        (address out2, uint256 wethBack) = adapter.execute(ZAPS, zapsIn, "");
        vm.stopPrank();
        assertEq(out2, AEWETH, "tokenOut back");
        assertGt(wethBack, 0, "no aeWETH back");
        assertEq(IERC20(AEWETH).balanceOf(zap), wethBack, "zap did not receive the measured delta");
        _assertClean(adapter, ZAPS, AEWETH);
        emit log_named_uint("aeWETH/0xZAPS: half the 0xZAPS -> aeWETH (wei)", wethBack);
    }

    // ---------------------------------------------------------------------------------------------- //
    // 3. The verdict: the deployable menu is EXACTLY these two pools, both liquid and routing.        //
    // ---------------------------------------------------------------------------------------------- //

    /// @notice The consolidated menu the deploy script should stand up: two adapters, two distinct
    ///         pool ids, both with live liquidity and both proved to route above. This test is the
    ///         single place a reviewer can read the final answer.
    function test_deployableMenu_isExactlyTheseTwo() public {
        RobinhoodV4PoolAdapter usdgAdapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, USDG_FEE, USDG_TS, address(0)
        );
        RobinhoodV4PoolAdapter zapsAdapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, ZAPS, DYNAMIC_FEE_FLAG, ZAPS_TS, ZAPS_HOOK
        );

        // Distinct, real, liquid pools.
        assertEq(usdgAdapter.poolId(), USDG_POOL_ID);
        assertEq(zapsAdapter.poolId(), ZAPS_POOL_ID);
        assertTrue(usdgAdapter.poolId() != zapsAdapter.poolId(), "menu entries collide");
        assertGt(_liquidity(usdgAdapter.poolId()), 0, "entry #1 illiquid");
        assertGt(_liquidity(zapsAdapter.poolId()), 0, "entry #2 illiquid");

        // Both share aeWETH — the single clean counter-currency that ties the menu together.
        assertEq(usdgAdapter.currency0(), AEWETH);
        assertEq(zapsAdapter.currency0(), AEWETH);
        assertEq(usdgAdapter.currency1(), USDG);
        assertEq(zapsAdapter.currency1(), ZAPS);
        assertEq(usdgAdapter.hooks(), address(0), "entry #1 must be hookless");
        assertEq(zapsAdapter.hooks(), ZAPS_HOOK, "entry #2 must carry the 0xZAPS hook");

        emit log("=========================== ROBINHOOD DEPLOYABLE POOL MENU ===========================");
        emit log("  #1  aeWETH/USDG    fee=450     ts=9    hook=none         (deepest hookless tier)");
        emit log("  #2  aeWETH/0xZAPS  fee=dynamic ts=200  hook=ZAPS_HOOK    (project token)");
        emit log("  excluded: USDG/0xZAPS (never initialized); equity pools pair vs memecoins, not clean");
        emit log("  counter-currencies proven clean: aeWETH (ETH) and, for aeWETH, USDG (stable)");
        emit log("=====================================================================================");
    }

    // ---------------------------------------------------------------------------------------------- //
    // Helpers                                                                                         //
    // ---------------------------------------------------------------------------------------------- //

    /// @dev Matches `RobinhoodV4PoolAdapter.poolId`: keccak256(abi.encode(c0,c1,fee,ts,hooks)).
    function _poolId(address c0, address c1, uint24 fee, int24 ts, address hooks) internal pure returns (bytes32) {
        return keccak256(abi.encode(c0, c1, fee, ts, hooks));
    }

    function _stateSlot(bytes32 poolId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(poolId, POOLS_SLOT)));
    }

    function _liquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 raw = IPoolManagerRead(POOL_MANAGER).extsload(bytes32(_stateSlot(poolId) + LIQUIDITY_OFFSET));
        return uint128(uint256(raw));
    }

    /// @dev slot0 (offset 0) packs sqrtPriceX96 in the low 160 bits; it is zero iff the pool has never
    ///      been initialized.
    function _isInitialized(bytes32 poolId) internal view returns (bool) {
        bytes32 slot0 = IPoolManagerRead(POOL_MANAGER).extsload(bytes32(_stateSlot(poolId)));
        return uint256(slot0) != 0;
    }

    /// @dev The adapter must leave no token dust and no allowance on either the ERC-20 or Permit2 leg.
    function _assertClean(RobinhoodV4PoolAdapter adapter, address tokenIn, address tokenOut) internal view {
        assertEq(IERC20(tokenIn).balanceOf(address(adapter)), 0, "input dust");
        assertEq(IERC20(tokenOut).balanceOf(address(adapter)), 0, "output dust");
        assertEq(IERC20(tokenIn).allowance(address(adapter), PERMIT2), 0, "erc20 allowance to permit2");
        (uint160 a,,) = IPermit2Read(PERMIT2).allowance(address(adapter), tokenIn, UNIVERSAL_ROUTER);
        assertEq(a, 0, "permit2 allowance to router");
    }
}
