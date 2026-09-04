// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {HookedRangeVault, IHookedV4PoolManager} from "../src/primitives/HookedRangeVault.sol";
import {HookedRangeVaultFactory} from "../src/primitives/HookedRangeVaultFactory.sol";
import {HookedRangeDepositAdapter} from "../src/adapters/HookedRangeDepositAdapter.sol";
import {HookedRangeWithdrawAdapter} from "../src/adapters/HookedRangeWithdrawAdapter.sol";
import {HookrMarketSwapAdapter} from "../src/adapters/HookrMarketSwapAdapter.sol";
import {RobinhoodV4NativePoolAdapter} from "../src/adapters/RobinhoodV4NativePoolAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";

interface IWethFork {
    function deposit() external payable;
}

interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IHookrCoordinatorRead {
    function marketCount() external view returns (uint256);
    function marketOpeningPaused() external view returns (bool);
    function contractVersion() external view returns (string memory);
}

/// @dev Dress rehearsal for OpenZaps on Hookr's MODULAR generations against REAL Robinhood Chain
///      state: RUN_ROBINHOOD_FORK=true forge test --match-contract HookrModularForkTest -vv
///
///      Hookr Modular V3 (coordinator `0x7b55…`, per-market hook INSTANCES) and Modular V2
///      (coordinator `0xa7DA…`, one shared kernel) are both deployed with market opening paused,
///      and each already records live canary markets for TESTINPROD quoted in native ETH. Those
///      real markets — opened by Hookr's own tooling through the real coordinators — are the
///      targets here; nothing is pranked into existence. The suite proves:
///        * a vault is admitted for a V3 market by the coordinator's own record (its hook is a
///          factory-attested instance no static list could name), and refused for an unrecorded
///          instance;
///        * the market swap adapter buys and sells the subject on the V3 market;
///        * a native-quoted vault zaps in from aeWETH and out to aeWETH on the V3 market;
///        * capsules created by the LIVE v1.1 factory buy on V3, migrate a V5 HOOKR-quoted
///          position into the V3 market in THREE steps (zap out to HOOKR, sell HOOKR for aeWETH on
///          its native pool, zap in), and migrate between the V3 and V2 markets.
contract HookrModularForkTest is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant KRN = 0xBb371991468BD17d007a3Da6B400e6eD0CCd8807;

    // Hookr V5 (live HOOKR-quoted pools, one shared hook).
    address internal constant HOOKR_HOOK_V5 = 0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC;
    // Hookr Modular V2 canary graph: shared kernel, one live new-token market (TESTINPROD/ETH).
    address internal constant KERNEL_V2 = 0x26734cc3b9678966d881559963E5Db117f9228CC;
    address internal constant COORDINATOR_V2_CANARY = 0xa7DA0A9234197670d203Cba091a041e6Bcc297a5;
    address internal constant COORDINATOR_V2 = 0x9B824615D3836BdC668fBe80bB5A50391765787f;
    address internal constant V2_TOKEN = 0xa6D53173e890AA5914924b9173E8eB2b364BeB72; // TESTINPROD (V2 canary)
    bytes32 internal constant V2_MARKET_ID = 0xe915b587127bbde3a920360abe4552cd56fa16b7c675a64dbf24f72aa99f51dd;
    // Hookr Modular V3: per-market instances, two live TESTINPROD/ETH markets.
    address internal constant COORDINATOR_V3 = 0x7b554efa746a76A2297489B2E8C2De6f19a3b59D;
    address internal constant INSTANCE_FACTORY_V3 = 0xAf574b94065B2E5ac2e1ebD139741850d5f35DF6;
    address internal constant V3_TOKEN = 0x22F749EDB75fCA5438cD978aC0Af9b5d9f1F72d1; // TESTINPROD (V3)
    /// @dev New-token market with the locked founding position (live liquidity).
    bytes32 internal constant V3_NEW_MARKET_ID = 0x65e55937c21820f9ce53b55106b9b154b5054fb2bd6554864b8a29b2aa59c6f2;
    address internal constant V3_NEW_INSTANCE = 0x20A433A26a6Fc58902C0f74543f9faC6fEBBe8cC;
    /// @dev Existing-token market opened for the two-LP canary (zero liquidity today).
    bytes32 internal constant V3_EXISTING_MARKET_ID = 0x07bd1a49322beea87ca9df64602201487595f4b776ba33910b375025e83646d3;
    address internal constant V3_EXISTING_INSTANCE = 0xD2Ad501Fb4B46dA9Ea7E5153CB7fa87829C468CC;

    address internal constant LIVE_ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant LIVE_TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant LIVE_V1_1_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;

    uint24 internal constant DYNAMIC_FEE = 0x800000;
    int24 internal constant TICK_SPACING = 60;
    bytes32 internal constant V5_HOOKR_ETH_POOL_ID = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    HookedRangeVaultFactory internal factory;
    HookedRangeDepositAdapter internal depositAdapter;
    HookedRangeWithdrawAdapter internal withdrawAdapter;
    HookrMarketSwapAdapter internal marketAdapter;
    RobinhoodV4NativePoolAdapter internal hookrNativeAdapter;
    HookedRangeVault internal vaultV3;
    HookedRangeVault internal vaultV2;
    HookedRangeVault internal vaultV5Krn;

    function _forkOrSkip() internal returns (bool) {
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return false;
        }
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc);
        return true;
    }

    function _deployOpenZaps() internal {
        address[] memory hooks = new address[](2);
        hooks[0] = HOOKR_HOOK_V5;
        hooks[1] = KERNEL_V2;
        address[] memory coordinators = new address[](3);
        coordinators[0] = COORDINATOR_V3;
        coordinators[1] = COORDINATOR_V2;
        coordinators[2] = COORDINATOR_V2_CANARY;
        factory = new HookedRangeVaultFactory(POOL_MANAGER, AEWETH, HOOKR, hooks, coordinators);
        depositAdapter = new HookedRangeDepositAdapter(POOL_MANAGER, AEWETH, address(factory));
        withdrawAdapter = new HookedRangeWithdrawAdapter(POOL_MANAGER, AEWETH, address(factory));
        marketAdapter = new HookrMarketSwapAdapter(POOL_MANAGER, AEWETH, coordinators);
        hookrNativeAdapter = new RobinhoodV4NativePoolAdapter(AEWETH, POOL_MANAGER, HOOKR, 2500, 25, V5_HOOKR_ETH_POOL_ID);
    }

    function _poolLiquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 base = keccak256(abi.encode(poolId, POOLS_SLOT));
        return uint128(uint256(IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(base) + LIQUIDITY_OFFSET))));
    }

    function _fundWeth(address to, uint256 amount) internal {
        vm.deal(to, address(to).balance + amount);
        vm.prank(to);
        IWethFork(AEWETH).deposit{value: amount}();
    }

    /// @dev The first LP of a zero-liquidity market: one direct vault deposit of both sides at the
    ///      market's opening price (1:1 for the canaries).
    function _seedVault(HookedRangeVault vault, address token1, uint256 wethAmount, uint256 tokenAmount) internal {
        address seeder = makeAddr("seeder");
        _fundWeth(seeder, wethAmount);
        deal(token1, seeder, tokenAmount);
        vm.startPrank(seeder);
        IERC20(AEWETH).approve(address(vault), wethAmount);
        IERC20(token1).approve(address(vault), tokenAmount);
        (uint256 shares,,) = vault.deposit(wethAmount, tokenAmount, 0, seeder);
        vm.stopPrank();
        assertGt(shares, 0, "seed minted shares");
    }

    function _setUpAll() internal {
        _deployOpenZaps();
        vaultV3 = HookedRangeVault(
            payable(factory.createVault(address(0), V3_TOKEN, DYNAMIC_FEE, TICK_SPACING, V3_EXISTING_INSTANCE))
        );
        vaultV2 = HookedRangeVault(payable(factory.createVault(address(0), V2_TOKEN, DYNAMIC_FEE, TICK_SPACING, KERNEL_V2)));
        vaultV5Krn = HookedRangeVault(payable(factory.createVault(HOOKR, KRN, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK_V5)));
        _seedVault(vaultV3, V3_TOKEN, 1 ether, 1 ether);
        _seedVault(vaultV2, V2_TOKEN, 1 ether, 1 ether);
    }

    // --- admission ------------------------------------------------------------------------------

    function test_liveHookrStateIsStillDormantAndRecordsTheCanaries() public {
        if (!_forkOrSkip()) return;
        assertEq(keccak256(bytes(IHookrCoordinatorRead(COORDINATOR_V3).contractVersion())), keccak256("3.0.0"));
        assertTrue(IHookrCoordinatorRead(COORDINATOR_V3).marketOpeningPaused(), "V3 public opening still paused");
        assertEq(IHookrCoordinatorRead(COORDINATOR_V3).marketCount(), 2, "two V3 canary markets");
        assertEq(IHookrCoordinatorRead(COORDINATOR_V2_CANARY).marketCount(), 1, "one V2 canary market");
        assertEq(IHookrCoordinatorRead(COORDINATOR_V2).marketCount(), 0, "post-canary V2 graph empty");
    }

    function test_factoryAdmitsV3InstancesByCoordinatorRecordOnly() public {
        if (!_forkOrSkip()) return;
        _deployOpenZaps();
        assertFalse(factory.isAllowedHook(V3_EXISTING_INSTANCE), "no static entry for a V3 instance");
        assertTrue(factory.coordinatorAttests(V3_EXISTING_MARKET_ID, V3_EXISTING_INSTANCE), "V3 record attests its instance");
        assertTrue(factory.coordinatorAttests(V2_MARKET_ID, KERNEL_V2), "V2 canary record attests the kernel");
        // The V3 instance is bound to ITS market: the same instance on any other key is refused.
        assertFalse(factory.coordinatorAttests(V3_NEW_MARKET_ID, V3_EXISTING_INSTANCE));
        assertFalse(factory.coordinatorAttests(V5_HOOKR_ETH_POOL_ID, V3_EXISTING_INSTANCE));

        address vault = factory.createVault(address(0), V3_TOKEN, DYNAMIC_FEE, TICK_SPACING, V3_EXISTING_INSTANCE);
        assertEq(HookedRangeVault(payable(vault)).poolId(), V3_EXISTING_MARKET_ID, "vault pins the V3 market");
        assertEq(HookedRangeVault(payable(vault)).hooks(), V3_EXISTING_INSTANCE);
        assertTrue(HookedRangeVault(payable(vault)).nativeCurrency0());
        assertEq(HookedRangeVault(payable(vault)).token0(), AEWETH);

        // An instance nobody's record binds to this key is refused, however plausible its bits.
        vm.expectRevert(abi.encodeWithSelector(HookedRangeVaultFactory.HookNotAllowed.selector, V3_NEW_INSTANCE));
        factory.createVault(address(0), V3_TOKEN, DYNAMIC_FEE, TICK_SPACING + 60, V3_NEW_INSTANCE);
        // A V3 market the coordinator DOES record with a different instance resolves to its own vault.
        address vaultNew = factory.createVault(address(0), V3_TOKEN, DYNAMIC_FEE, TICK_SPACING, V3_NEW_INSTANCE);
        assertEq(HookedRangeVault(payable(vaultNew)).poolId(), V3_NEW_MARKET_ID);
    }

    // --- market swap adapter on V3 -------------------------------------------------------------

    function test_marketSwapAdapterBuysAndSellsOnTheV3Market() public {
        if (!_forkOrSkip()) return;
        _setUpAll();
        (IHookedV4PoolManager.PoolKey memory key, address subject, address quoteFace) = marketAdapter.marketFor(V3_EXISTING_MARKET_ID);
        assertEq(key.hooks, V3_EXISTING_INSTANCE, "market key carries the per-market instance");
        assertEq(key.currency0, address(0));
        assertEq(subject, V3_TOKEN);
        assertEq(quoteFace, AEWETH);
        vm.expectRevert(abi.encodeWithSelector(HookrMarketSwapAdapter.MarketNotLive.selector, V5_HOOKR_ETH_POOL_ID));
        marketAdapter.marketFor(V5_HOOKR_ETH_POOL_ID);

        address zap = makeAddr("zap");
        uint256 wethIn = 0.01 ether;
        _fundWeth(zap, wethIn);
        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(marketAdapter), wethIn);
        (address outToken, uint256 tokenOut) =
            marketAdapter.execute(AEWETH, wethIn, abi.encode(V3_EXISTING_MARKET_ID, uint256(1)));
        vm.stopPrank();
        assertEq(outToken, V3_TOKEN);
        assertGt(tokenOut, wethIn * 95 / 100, "1:1 canary market, 1% fee, small impact");
        assertEq(IERC20(V3_TOKEN).balanceOf(zap), tokenOut);
        assertEq(IERC20(AEWETH).balanceOf(zap), 0, "exact input consumed");
        assertEq(address(marketAdapter).balance, 0);
        assertEq(IERC20(AEWETH).balanceOf(address(marketAdapter)), 0);

        vm.startPrank(zap);
        IERC20(V3_TOKEN).approve(address(marketAdapter), tokenOut);
        (address backToken, uint256 wethBack) =
            marketAdapter.execute(V3_TOKEN, tokenOut, abi.encode(V3_EXISTING_MARKET_ID, uint256(1)));
        vm.stopPrank();
        assertEq(backToken, AEWETH);
        assertGt(wethBack, wethIn * 95 / 100, "round trip within two fees");
        assertLt(wethBack, wethIn, "fees were paid");
    }

    // --- native-quoted vault on V3 -------------------------------------------------------------

    function test_nativeQuotedV3VaultZapsInFromWethAndOutToWeth() public {
        if (!_forkOrSkip()) return;
        _setUpAll();
        address zap = makeAddr("zap");
        uint256 wethIn = 0.05 ether;
        _fundWeth(zap, wethIn);

        uint128 before = _poolLiquidity(V3_EXISTING_MARKET_ID);
        vm.startPrank(zap);
        IERC20(AEWETH).approve(address(depositAdapter), wethIn);
        (address tokenOut, uint256 shares) =
            depositAdapter.execute(AEWETH, wethIn, abi.encode(address(vaultV3), uint256(1)));
        vm.stopPrank();
        assertEq(tokenOut, address(vaultV3));
        assertGt(shares, 0);
        assertEq(vaultV3.balanceOf(zap), shares);
        assertGt(_poolLiquidity(V3_EXISTING_MARKET_ID), before, "V3 market liquidity grew");
        assertEq(address(depositAdapter).balance, 0, "adapter holds no native");
        assertEq(address(vaultV3).balance, vaultV3.reserve0(), "vault native equals tracked reserve0");
        assertLt(IERC20(AEWETH).balanceOf(zap), wethIn / 100, "aeWETH residue is dust");

        uint256 wethBefore = IERC20(AEWETH).balanceOf(zap);
        vm.startPrank(zap);
        vaultV3.approve(address(withdrawAdapter), shares);
        (address settleToken, uint256 out) =
            withdrawAdapter.execute(address(vaultV3), shares, abi.encode(AEWETH, uint256(1)));
        vm.stopPrank();
        assertEq(settleToken, AEWETH);
        assertEq(vaultV3.balanceOf(zap), 0);
        assertEq(IERC20(AEWETH).balanceOf(zap), wethBefore + out);
        assertGt(out, wethIn * 95 / 100, "round trip within fees and price impact");
        assertEq(address(withdrawAdapter).balance, 0);
    }

    // --- capsules through the LIVE v1.1 factory --------------------------------------------------

    function _governanceWires() internal {
        vm.startPrank(GOVERNANCE);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(depositAdapter), true);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(withdrawAdapter), true);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(marketAdapter), true);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(hookrNativeAdapter), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(HOOKR, true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(V3_TOKEN, true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(address(vaultV3), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(address(vaultV2), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(address(vaultV5Krn), true);
        vm.stopPrank();
    }

    function _createAndRun(
        uint256 ownerPk,
        Step[] memory steps,
        address[] memory trackedAssets,
        address fundToken,
        uint256 fundAmount,
        address outAsset,
        bytes32 salt
    ) internal returns (address zapAddress) {
        address owner = vm.addr(ownerPk);
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });
        zapAddress = OpenZapFactory(LIVE_V1_1_FACTORY).createZap(policy, salt);
        OpenZap zap = OpenZap(payable(zapAddress));
        vm.prank(owner);
        IERC20(fundToken).transfer(zapAddress, fundAmount);
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
            policyHash: zap.policyHash(),
            outAsset: outAsset,
            minOut: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, zap.hashIntent(intent));
        vm.prank(makeAddr("relayer"));
        zap.execute(intent, abi.encodePacked(r, s, v));
    }

    function _step(address adapter, address tokenIn, uint256 amountIn, bytes memory data) internal pure returns (Step memory) {
        return Step({adapter: adapter, tokenIn: tokenIn, spender: adapter, amountIn: amountIn, data: data});
    }

    function test_liveFactoryBuysOnV3ThenMigratesV5ToV3InThreeStepsAndV3ToV2() public {
        if (!_forkOrSkip()) return;
        _setUpAll();
        _governanceWires();

        uint256 ownerPk = 0xB0B1E5A11CE;
        address owner = vm.addr(ownerPk);
        _fundWeth(owner, 0.02 ether);
        deal(HOOKR, owner, 20_000 ether);

        // 1. Buy the V3 subject with aeWETH, one step.
        Step[] memory buy = new Step[](1);
        buy[0] = _step(address(marketAdapter), AEWETH, 0.01 ether, abi.encode(V3_EXISTING_MARKET_ID, uint256(1)));
        address[] memory buyTracked = new address[](2);
        buyTracked[0] = AEWETH;
        buyTracked[1] = V3_TOKEN;
        _createAndRun(ownerPk, buy, buyTracked, AEWETH, 0.01 ether, V3_TOKEN, keccak256("v3-buy"));
        assertGt(IERC20(V3_TOKEN).balanceOf(owner), 0, "bought on the V3 market");

        // 2. Hold a V5 HOOKR/KRN position to migrate.
        Step[] memory v5In = new Step[](1);
        v5In[0] = _step(address(depositAdapter), HOOKR, 20_000 ether, abi.encode(address(vaultV5Krn), uint256(1)));
        address[] memory v5Tracked = new address[](2);
        v5Tracked[0] = HOOKR;
        v5Tracked[1] = address(vaultV5Krn);
        _createAndRun(ownerPk, v5In, v5Tracked, HOOKR, 20_000 ether, address(vaultV5Krn), keccak256("v5-in"));
        uint256 v5Shares = vaultV5Krn.balanceOf(owner);
        assertGt(v5Shares, 0);

        // 3. Migrate V5 -> V3 in THREE steps: shares -> HOOKR -> aeWETH (HOOKR's native pool) -> V3 vault.
        //    Each intermediate amount is sized from a dry run and pinned as the prior step's floor.
        uint256 snapshot = vm.snapshotState();
        vm.startPrank(owner);
        vaultV5Krn.approve(address(withdrawAdapter), v5Shares);
        (, uint256 hookrOut) = withdrawAdapter.execute(address(vaultV5Krn), v5Shares, abi.encode(HOOKR, uint256(1)));
        uint256 hookrLeg = hookrOut * 99 / 100;
        IERC20(HOOKR).approve(address(hookrNativeAdapter), hookrLeg);
        (, uint256 wethOut) = hookrNativeAdapter.execute(HOOKR, hookrLeg, "");
        vm.stopPrank();
        vm.revertToState(snapshot);
        uint256 wethLeg = wethOut * 99 / 100;

        Step[] memory migrate = new Step[](3);
        migrate[0] = _step(address(withdrawAdapter), address(vaultV5Krn), v5Shares, abi.encode(HOOKR, hookrLeg));
        migrate[1] = _step(address(hookrNativeAdapter), HOOKR, hookrLeg, abi.encode(wethLeg));
        migrate[2] = _step(address(depositAdapter), AEWETH, wethLeg, abi.encode(address(vaultV3), uint256(1)));
        address[] memory migrateTracked = new address[](4);
        migrateTracked[0] = address(vaultV5Krn);
        migrateTracked[1] = HOOKR;
        migrateTracked[2] = AEWETH;
        migrateTracked[3] = address(vaultV3);
        uint128 v3Before = _poolLiquidity(V3_EXISTING_MARKET_ID);
        _createAndRun(ownerPk, migrate, migrateTracked, address(vaultV5Krn), v5Shares, address(vaultV3), keccak256("v5-to-v3"));
        assertEq(vaultV5Krn.balanceOf(owner), 0, "left the V5 pool");
        uint256 v3Shares = vaultV3.balanceOf(owner);
        assertGt(v3Shares, 0, "entered the V3 market");
        assertGt(_poolLiquidity(V3_EXISTING_MARKET_ID), v3Before, "V3 market liquidity grew");

        // 4. Migrate V3 -> V2 canary market: V3 shares -> aeWETH -> V2 vault.
        snapshot = vm.snapshotState();
        vm.startPrank(owner);
        vaultV3.approve(address(withdrawAdapter), v3Shares);
        (, uint256 wethFromV3) = withdrawAdapter.execute(address(vaultV3), v3Shares, abi.encode(AEWETH, uint256(1)));
        vm.stopPrank();
        vm.revertToState(snapshot);
        uint256 hopLeg = wethFromV3 * 99 / 100;

        Step[] memory hop = new Step[](2);
        hop[0] = _step(address(withdrawAdapter), address(vaultV3), v3Shares, abi.encode(AEWETH, hopLeg));
        hop[1] = _step(address(depositAdapter), AEWETH, hopLeg, abi.encode(address(vaultV2), uint256(1)));
        address[] memory hopTracked = new address[](3);
        hopTracked[0] = address(vaultV3);
        hopTracked[1] = AEWETH;
        hopTracked[2] = address(vaultV2);
        uint128 v2Before = _poolLiquidity(V2_MARKET_ID);
        address hopZap = _createAndRun(ownerPk, hop, hopTracked, address(vaultV3), v3Shares, address(vaultV2), keccak256("v3-to-v2"));
        assertEq(vaultV3.balanceOf(owner), 0, "left V3");
        assertGt(vaultV2.balanceOf(owner), 0, "entered the V2 market");
        assertGt(_poolLiquidity(V2_MARKET_ID), v2Before, "V2 market liquidity grew");
        assertEq(address(hopZap).balance, 0, "capsule never holds native");
        assertLt(IERC20(AEWETH).balanceOf(hopZap), wethFromV3 / 50, "stranded aeWETH is bounded slack");
    }
}
