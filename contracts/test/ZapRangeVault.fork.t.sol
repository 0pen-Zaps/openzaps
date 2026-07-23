// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4PoolAdapter} from "../src/adapters/RobinhoodV4PoolAdapter.sol";
import {ZapRangeVault} from "../src/primitives/ZapRangeVault.sol";
import {ZapRangeDepositAdapter} from "../src/adapters/ZapRangeDepositAdapter.sol";
import {ZapRangeWithdrawAdapter} from "../src/adapters/ZapRangeWithdrawAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";

interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @dev Fork suite against the real Robinhood Chain PoolManager and the deepest live hookless
///      aeWETH/USDG pool, pinned to the same block as the other v4 fork suites. This is where the
///      ported liquidity math and the unlock/sync/settle/take integration are proven against real
///      pool code — an error in either fails these tests loudly, it cannot hide.
contract ZapRangeVaultForkTest is Test {
    string internal constant RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
    uint256 internal constant FORK_BLOCK = 16_728_000;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint24 internal constant STATIC_FEE = 450;
    int24 internal constant STATIC_TICK_SPACING = 9;
    bytes32 internal constant STATIC_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;

    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    uint256 internal constant WETH_IN = 1 ether;
    uint256 internal constant USDG_IN = 2_000_000_000; // 2,000 USDG (6dp)

    ZapRangeVault internal vault;
    address internal alice;
    address internal bob;

    function setUp() public {
        vm.createSelectFork(RPC_URL, FORK_BLOCK);
        vault = new ZapRangeVault(
            POOL_MANAGER, AEWETH, USDG, STATIC_FEE, STATIC_TICK_SPACING, "OpenZap Range aeWETH/USDG", "ozRANGE"
        );
        alice = makeAddr("alice");
        bob = makeAddr("bob");
    }

    // --- wiring ----------------------------------------------------------------------------------

    function test_constructorPinsRealPoolFullRange() public view {
        assertEq(block.chainid, 4663, "not robinhood chain");
        assertEq(vault.poolId(), STATIC_POOL_ID, "pool id");
        assertEq(vault.tickLower(), -887265, "full-range lower at spacing 9");
        assertEq(vault.tickUpper(), 887265, "full-range upper at spacing 9");
        uint160 current = vault.currentSqrtPriceX96();
        assertGt(current, vault.sqrtPriceLowerX96(), "current price above lower bound");
        assertLt(current, vault.sqrtPriceUpperX96(), "current price below upper bound");
        assertEq(vault.positionLiquidity(), 0);
        assertEq(vault.totalSupply(), 0);
    }

    function test_constructorRefusesDynamicFeeAndUninitializedPools() public {
        // Dynamic fee implies a hook; hooked pools are refused wholesale.
        vm.expectRevert(abi.encodeWithSelector(ZapRangeVault.InvalidFee.selector, uint24(0x800000)));
        new ZapRangeVault(POOL_MANAGER, AEWETH, USDG, 0x800000, 200, "x", "x");

        // A pool that was never initialized is a deployment mistake, refused at construction.
        vm.expectRevert(ZapRangeVault.PoolNotInitialized.selector);
        new ZapRangeVault(POOL_MANAGER, AEWETH, USDG, 451, 9, "x", "x");
    }

    // --- deposit / redeem against the real pool --------------------------------------------------

    function test_firstDepositAddsRealLiquidityAndRefundsSurplus() public {
        uint128 poolLiquidityBefore = _poolLiquidity();
        (uint256 shares, uint256 used0, uint256 used1) = _deposit(alice, WETH_IN, USDG_IN);

        assertGt(shares, 0, "no shares");
        assertEq(vault.balanceOf(alice), shares);
        uint128 position = vault.positionLiquidity();
        assertGt(position, 0, "no position");
        assertEq(_poolLiquidity(), poolLiquidityBefore + position, "pool liquidity must grow by exactly our L");

        // One leg is used in full (up to the pool's 1-wei round-up), the other is partly refunded.
        assertLe(used0, WETH_IN);
        assertLe(used1, USDG_IN);
        assertEq(IERC20(AEWETH).balanceOf(alice), WETH_IN - used0, "aeWETH refund mismatch");
        assertEq(IERC20(USDG).balanceOf(alice), USDG_IN - used1, "USDG refund mismatch");
        // At ~1926 USDG/WETH, one leg is binding: it is consumed to within rounding (the sized
        // liquidity is floored, so the pool re-derives a debt a few wei under the full amount).
        assertTrue(used0 >= WETH_IN - WETH_IN / 10_000 || used1 >= USDG_IN - USDG_IN / 10_000, "one leg must bind");
    }

    function test_secondDepositPricedFairly() public {
        (uint256 sharesAlice,,) = _deposit(alice, WETH_IN, USDG_IN);
        (uint256 sharesBob,,) = _deposit(bob, WETH_IN, USDG_IN);
        // Same amounts at the same price must mint the same shares up to rounding dust.
        assertApproxEqRel(sharesBob, sharesAlice, 1e12, "second depositor mispriced"); // 0.0001%
    }

    function test_redeemReturnsPrincipal() public {
        (uint256 shares, uint256 used0, uint256 used1) = _deposit(alice, WETH_IN, USDG_IN);
        uint128 positionBefore = vault.positionLiquidity();
        uint128 poolLiquidityBefore = _poolLiquidity();

        vm.prank(alice);
        (uint256 out0, uint256 out1) = vault.redeem(shares, 0, 0, alice, alice);

        // No swaps happened, so the payout is the principal minus bounded rounding (the virtual
        // offset keeps a dust-sized slice in the position by design).
        assertApproxEqRel(out0, used0, 1e13, "aeWETH principal"); // 0.001%
        assertApproxEqRel(out1, used1, 1e13, "USDG principal");
        assertLe(out0, used0, "redeem can never pay more than was put in without fees");
        assertLe(out1, used1, "redeem can never pay more than was put in without fees");
        assertEq(vault.balanceOf(alice), 0);
        assertEq(_poolLiquidity(), poolLiquidityBefore - (positionBefore - vault.positionLiquidity()));
    }

    function test_swapFeesAccrueToHolders() public {
        (uint256 shares,,) = _deposit(alice, WETH_IN, USDG_IN);

        // Generate real fee volume in the pool through the proven single-pool adapter.
        RobinhoodV4PoolAdapter swapAdapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, AEWETH, USDG, STATIC_FEE, STATIC_TICK_SPACING, address(0)
        );
        address trader = makeAddr("trader");
        for (uint256 i; i < 4; ++i) {
            _tradeThrough(swapAdapter, trader, AEWETH, 0.5 ether);
            uint256 usdgBal = IERC20(USDG).balanceOf(trader);
            _tradeThrough(swapAdapter, trader, USDG, usdgBal);
        }

        // A redeem after volume must pay MORE than the no-volume principal for at least one leg:
        // fees were realised by the compound poke and paid pro-rata.
        uint256 snapshot = vm.snapshotState();
        vm.prank(alice);
        (uint256 out0, uint256 out1) = vault.redeem(shares, 0, 0, alice, alice);
        assertTrue(vm.revertToState(snapshot));

        // Replay the same redeem in a fee-free world for comparison.
        // (Rewind killed the volume, so redo the redeem on untraded state.)
        // Instead of replaying, assert directly: the payout exceeds what the same shares preview
        // as pure principal at the current price minus reserves — i.e. reserves + fees are real.
        (uint256 preview0, uint256 preview1) = vault.previewRedeem(shares);
        assertGe(out0 + 1, preview0, "payout below principal preview"); // preview under-quotes
        assertGe(out1 + 1, preview1, "payout below principal preview");
        assertTrue(out0 > preview0 || out1 > preview1, "no fee uplift measured");
    }

    function test_donationsAreInertToPricing() public {
        _deposit(alice, WETH_IN, USDG_IN);

        (uint256 sharesNoDonation,) = vault.previewDeposit(WETH_IN, USDG_IN);
        uint256 snapshot = vm.snapshotState();

        // A would-be inflation attacker donates both tokens straight to the vault.
        deal(USDG, address(this), 100_000_000_000);
        deal(AEWETH, address(this), 100 ether);
        IERC20(USDG).transfer(address(vault), 100_000_000_000);
        IERC20(AEWETH).transfer(address(vault), 100 ether);

        // Pricing is completely unmoved: reserves are storage-tracked, raw balances are invisible.
        (uint256 sharesAfterDonation,) = vault.previewDeposit(WETH_IN, USDG_IN);
        assertEq(sharesAfterDonation, sharesNoDonation, "donation moved share pricing");
        (uint256 sharesMinted,,) = _deposit(bob, WETH_IN, USDG_IN);
        assertEq(sharesMinted, sharesAfterDonation, "donation moved actual mint");
        assertEq(vault.reserve0(), 0, "donation entered reserves");
        assertEq(vault.reserve1(), 0, "donation entered reserves");

        assertTrue(vm.revertToState(snapshot));
    }

    // --- the product path: real OpenZap capsules provide and withdraw liquidity -----------------

    function test_provideLiquidity_endToEnd_throughRealOpenZapClone() public {
        (OpenZapFactory factory, AdapterRegistry registry,) = _freshCore();
        ZapRangeDepositAdapter depositAdapter = new ZapRangeDepositAdapter(UNIVERSAL_ROUTER, PERMIT2, address(vault));
        _allow(registry, address(depositAdapter));

        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        uint256 amountIn = 0.2 ether;

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(depositAdapter),
            tokenIn: AEWETH,
            amountIn: amountIn,
            spender: address(depositAdapter),
            data: ""
        });
        address zapAddress = _createZap(factory, owner, AEWETH, steps);
        deal(AEWETH, zapAddress, amountIn);

        _executeZap(zapAddress, ownerPk, address(vault), 1);

        uint256 ownerShares = vault.balanceOf(owner);
        assertGt(ownerShares, 0, "recipient got no LP shares");
        assertEq(vault.balanceOf(zapAddress), 0, "shares stuck on capsule");
        assertEq(vault.balanceOf(address(depositAdapter)), 0, "shares stuck on adapter");
        assertEq(IERC20(AEWETH).balanceOf(address(depositAdapter)), 0, "input stuck on adapter");
        assertEq(IERC20(USDG).balanceOf(address(depositAdapter)), 0, "counter-leg stuck on adapter");
        assertEq(IERC20(AEWETH).allowance(zapAddress, address(depositAdapter)), 0, "residual step allowance");
        assertGt(vault.positionLiquidity(), 0, "no real liquidity added");
    }

    function test_withdrawLiquidity_endToEnd_throughRealOpenZapClone() public {
        // The capsule is funded with LP shares; the step settles on a single currency (USDG).
        (uint256 shares,,) = _deposit(alice, WETH_IN, USDG_IN);

        (OpenZapFactory factory, AdapterRegistry registry,) = _freshCore();
        ZapRangeWithdrawAdapter withdrawAdapter =
            new ZapRangeWithdrawAdapter(UNIVERSAL_ROUTER, PERMIT2, address(vault), USDG);
        _allow(registry, address(withdrawAdapter));

        uint256 ownerPk = 0xB0B;
        address owner = vm.addr(ownerPk);

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(withdrawAdapter),
            tokenIn: address(vault),
            amountIn: shares,
            spender: address(withdrawAdapter),
            data: ""
        });
        address zapAddress = _createZap(factory, owner, address(vault), steps);
        vm.prank(alice);
        vault.transfer(zapAddress, shares);

        _executeZap(zapAddress, ownerPk, USDG, 1);

        assertGt(IERC20(USDG).balanceOf(owner), 0, "recipient got no USDG");
        assertEq(vault.balanceOf(zapAddress), 0, "shares not burned from capsule");
        assertEq(vault.totalSupply(), 0, "shares survived the redeem");
        assertEq(IERC20(USDG).balanceOf(address(withdrawAdapter)), 0, "USDG stuck on adapter");
        assertEq(IERC20(AEWETH).balanceOf(address(withdrawAdapter)), 0, "aeWETH stuck on adapter");
        assertEq(vault.allowance(zapAddress, address(withdrawAdapter)), 0, "residual share allowance");
    }

    // --- adapter validation ----------------------------------------------------------------------

    function test_adaptersRejectMalformedInputs() public {
        ZapRangeDepositAdapter depositAdapter = new ZapRangeDepositAdapter(UNIVERSAL_ROUTER, PERMIT2, address(vault));
        ZapRangeWithdrawAdapter withdrawAdapter =
            new ZapRangeWithdrawAdapter(UNIVERSAL_ROUTER, PERMIT2, address(vault), USDG);

        vm.expectRevert(abi.encodeWithSelector(ZapRangeDepositAdapter.UnsupportedToken.selector, address(vault)));
        depositAdapter.execute(address(vault), 1 ether, "");

        vm.expectRevert(ZapRangeDepositAdapter.ZeroAmount.selector);
        depositAdapter.execute(AEWETH, 1, ""); // below the 2-wei minimum for a half-split

        vm.expectRevert(ZapRangeDepositAdapter.InvalidData.selector);
        depositAdapter.execute(AEWETH, 1 ether, hex"beef");

        vm.expectRevert(abi.encodeWithSelector(ZapRangeWithdrawAdapter.UnsupportedToken.selector, AEWETH));
        withdrawAdapter.execute(AEWETH, 1 ether, "");

        vm.expectRevert(ZapRangeWithdrawAdapter.ZeroAmount.selector);
        withdrawAdapter.execute(address(vault), 0, "");

        vm.expectRevert(abi.encodeWithSelector(ZapRangeWithdrawAdapter.AssetNotInPool.selector, address(0xBEEF)));
        new ZapRangeWithdrawAdapter(UNIVERSAL_ROUTER, PERMIT2, address(vault), address(0xBEEF));
    }

    function test_unlockCallbackRefusesStrangers() public {
        // Not the PoolManager.
        vm.expectRevert(abi.encodeWithSelector(ZapRangeVault.NotPoolManager.selector, address(this)));
        vault.unlockCallback(abi.encode(int256(0)));

        // The PoolManager, but outside a vault-initiated operation.
        vm.prank(POOL_MANAGER);
        vm.expectRevert(ZapRangeVault.UnexpectedCallback.selector);
        vault.unlockCallback(abi.encode(int256(0)));
    }

    // --- helpers ---------------------------------------------------------------------------------

    function _deposit(address account, uint256 amount0, uint256 amount1)
        internal
        returns (uint256 shares, uint256 used0, uint256 used1)
    {
        deal(AEWETH, account, amount0);
        deal(USDG, account, amount1);
        vm.startPrank(account);
        IERC20(AEWETH).approve(address(vault), amount0);
        IERC20(USDG).approve(address(vault), amount1);
        (shares, used0, used1) = vault.deposit(amount0, amount1, 0, account);
        vm.stopPrank();
    }

    function _tradeThrough(RobinhoodV4PoolAdapter adapter, address trader, address tokenIn, uint256 amountIn) internal {
        deal(tokenIn, trader, amountIn);
        vm.startPrank(trader);
        IERC20(tokenIn).approve(address(adapter), amountIn);
        adapter.execute(tokenIn, amountIn, "");
        vm.stopPrank();
    }

    function _freshCore()
        internal
        returns (OpenZapFactory factory, AdapterRegistry registry, TokenAllowlist allowlist)
    {
        registry = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));
        factory = new OpenZapFactory(registry, allowlist);
        allowlist.setToken(AEWETH, true);
        allowlist.setToken(USDG, true);
        allowlist.setToken(address(vault), true); // the share token IS the vault address
    }

    function _allow(AdapterRegistry registry, address adapter) internal {
        registry.setAdapter(adapter, true);
    }

    function _createZap(OpenZapFactory factory, address owner, address fundingToken, Step[] memory steps)
        internal
        returns (address)
    {
        address[] memory trackedAssets = new address[](2);
        trackedAssets[0] = fundingToken;
        trackedAssets[1] = fundingToken == address(vault) ? USDG : address(vault);
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });
        return factory.createZap(policy, keccak256(abi.encode("range-vault-fork", owner, fundingToken)));
    }

    function _executeZap(address zapAddress, uint256 ownerPk, address outAsset, uint256 minOut) internal {
        OpenZap capsule = OpenZap(payable(zapAddress));
        OpenZapIntent memory intent = OpenZapIntent({
            zap: zapAddress,
            chainId: block.chainid,
            nonce: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: capsule.recipient(),
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: capsule.policyHash(),
            outAsset: outAsset,
            minOut: minOut
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, capsule.hashIntent(intent));
        vm.prank(makeAddr("relayer"));
        capsule.execute(intent, abi.encodePacked(r, s, v));
    }

    function _poolLiquidity() internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encode(STATIC_POOL_ID, POOLS_SLOT));
        bytes32 word = IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(stateSlot) + LIQUIDITY_OFFSET));
        return uint128(uint256(word));
    }
}
