// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {HookedRangeVault} from "../src/primitives/HookedRangeVault.sol";
import {HookedRangeVaultFactory} from "../src/primitives/HookedRangeVaultFactory.sol";
import {HookedRangeDepositAdapter} from "../src/adapters/HookedRangeDepositAdapter.sol";
import {HookedRangeWithdrawAdapter} from "../src/adapters/HookedRangeWithdrawAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";

interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @dev Dress rehearsal for the Hookr liquidity expansion against REAL Robinhood Chain state:
///        RUN_ROBINHOOD_FORK=true forge test --match-contract HookedRangeLiquidityForkTest -vv
///
///      The pools are two live HOOKR-quoted launches graduated by the Hookr launchpad (one shared
///      hook, dynamic fee, tick spacing 60). The capsule tests prank the real governance owner into
///      the real registries with the same calls the deploy script broadcasts, then run capsules
///      created by the LIVE v1.1 factory: a one-step zap in, a one-step zap out, and the two-step
///      migration (zap out of pool A settling in HOOKR → zap into pool B). Rerun before broadcasting
///      after ANY change to these contracts or the script.
contract HookedRangeLiquidityForkTest is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    /// @dev The Hookr launchpad's shared hook (documented at hookr.fun/docs, verified source on
    ///      Blockscout under the launchpad). Permission bits: BEFORE_INITIALIZE,
    ///      BEFORE_ADD_LIQUIDITY, BEFORE_SWAP, AFTER_SWAP and both swap RETURNS_DELTA flags — no
    ///      removal or liquidity-delta permissions, which is what the vault requires.
    address internal constant HOOKR_HOOK = 0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC;

    // Two live HOOKR-quoted launches (currency0 = HOOKR on both).
    address internal constant KRN = 0xBb371991468BD17d007a3Da6B400e6eD0CCd8807; // Kraken Club
    address internal constant TCL = 0x8be7f9014653588dA3429d37e1CE52757D831F74; // Tentacle
    uint24 internal constant DYNAMIC_FEE = 0x800000;
    int24 internal constant TICK_SPACING = 60;
    bytes32 internal constant KRN_POOL_ID = 0xe9901bceb8c2251ceb3d9f61c795f8d68ef95f86fb61163427db341075dbaf80;
    bytes32 internal constant TCL_POOL_ID = 0x9a3b77a63344c7a100ccccf4cf6da281ba6020160cbc2b9179085d1bbcb2e525;

    address internal constant LIVE_ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant LIVE_TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant LIVE_V1_1_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;

    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    uint256 internal constant HOOKR_IN = 20_000 ether; // 20k HOOKR ≈ 0.15 ETH at launch FDV

    HookedRangeVaultFactory internal factory;
    HookedRangeDepositAdapter internal depositAdapter;
    HookedRangeWithdrawAdapter internal withdrawAdapter;
    HookedRangeVault internal vaultKrn;
    HookedRangeVault internal vaultTcl;
    address internal alice;

    function _forkOrSkip() internal returns (bool) {
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return false;
        }
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        uint256 forkBlock = vm.envOr("ROBINHOOD_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        return true;
    }

    function _deployStack() internal {
        address[] memory hooks = new address[](1);
        hooks[0] = HOOKR_HOOK;
        factory = new HookedRangeVaultFactory(POOL_MANAGER, AEWETH, HOOKR, hooks, new address[](0));
        depositAdapter = new HookedRangeDepositAdapter(POOL_MANAGER, AEWETH, address(factory));
        withdrawAdapter = new HookedRangeWithdrawAdapter(POOL_MANAGER, AEWETH, address(factory));
        vaultKrn = HookedRangeVault(payable(factory.createVault(HOOKR, KRN, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK)));
        vaultTcl = HookedRangeVault(payable(factory.createVault(HOOKR, TCL, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK)));
        alice = makeAddr("alice");
    }

    function _poolLiquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 base = keccak256(abi.encode(poolId, POOLS_SLOT));
        return uint128(uint256(IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(base) + LIQUIDITY_OFFSET))));
    }

    // --- factory + vault wiring ------------------------------------------------------------------

    function test_factoryDeploysVaultsAtPredictedAddressesForLivePools() public {
        if (!_forkOrSkip()) return;
        _deployStack();

        assertEq(vaultKrn.poolId(), KRN_POOL_ID, "KRN pool id");
        assertEq(vaultTcl.poolId(), TCL_POOL_ID, "TCL pool id");
        assertEq(address(vaultKrn), factory.vaultFor(HOOKR, KRN, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK), "predicted KRN");
        assertEq(factory.vaultOf(KRN_POOL_ID), address(vaultKrn));
        assertTrue(factory.isVault(address(vaultKrn)));
        assertTrue(factory.isVault(address(vaultTcl)));
        assertFalse(factory.isVault(address(this)));
        assertEq(factory.vaultCount(), 2);
        assertEq(vaultKrn.hooks(), HOOKR_HOOK);
        assertEq(vaultKrn.fee(), DYNAMIC_FEE);
        assertGt(vaultKrn.currentSqrtPriceX96(), 0, "live pool has a price");
        assertGt(_poolLiquidity(KRN_POOL_ID), 0, "live pool has liquidity");
        assertEq(keccak256(bytes(vaultKrn.symbol())), keccak256("ozHR-HOOKR-KRN"));

        vm.expectRevert(abi.encodeWithSelector(HookedRangeVaultFactory.VaultExists.selector, KRN_POOL_ID, address(vaultKrn)));
        factory.createVault(HOOKR, KRN, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK);
    }

    function test_factoryRefusesPoolsWithoutTheQuoteToken() public {
        if (!_forkOrSkip()) return;
        _deployStack();
        vm.expectRevert(abi.encodeWithSelector(HookedRangeVaultFactory.QuoteNotInPool.selector, TCL, KRN));
        factory.createVault(TCL, KRN, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK);
        // An unpinned hook is refused before anything else, whatever the pair.
        vm.expectRevert(abi.encodeWithSelector(HookedRangeVaultFactory.HookNotAllowed.selector, address(this)));
        factory.createVault(HOOKR, KRN, DYNAMIC_FEE, TICK_SPACING, address(this));
    }

    function test_vaultRefusesHooksThatCanVetoOrSkimRemoval() public {
        if (!_forkOrSkip()) return;
        // A hook address whose permission bits include BEFORE_REMOVE_LIQUIDITY (bit 9).
        address vetoHook = address(uint160(0x1234000000000000000000000000000000000000) | uint160(1 << 9));
        vm.etch(vetoHook, hex"00");
        vm.expectRevert(
            abi.encodeWithSelector(HookedRangeVault.HookPermissionsRefused.selector, vetoHook, uint160(1 << 9))
        );
        new HookedRangeVault(POOL_MANAGER, AEWETH, HOOKR, KRN, DYNAMIC_FEE, TICK_SPACING, vetoHook, "x", "x");

        // The real hook's bits pass, but a pool that was never initialized is still refused.
        vm.expectRevert(HookedRangeVault.PoolNotInitialized.selector);
        new HookedRangeVault(POOL_MANAGER, AEWETH, HOOKR, KRN, 3000, TICK_SPACING, HOOKR_HOOK, "x", "x");

        vm.expectRevert(HookedRangeVault.HookRequired.selector);
        new HookedRangeVault(POOL_MANAGER, AEWETH, HOOKR, KRN, DYNAMIC_FEE, TICK_SPACING, address(0), "x", "x");
    }

    // --- vault against the live hooked pool ------------------------------------------------------

    function test_vaultDepositAndRedeemOnLiveHookedPool() public {
        if (!_forkOrSkip()) return;
        _deployStack();
        deal(HOOKR, alice, HOOKR_IN);
        deal(KRN, alice, HOOKR_IN);

        uint128 poolBefore = _poolLiquidity(KRN_POOL_ID);
        vm.startPrank(alice);
        IERC20(HOOKR).approve(address(vaultKrn), HOOKR_IN);
        IERC20(KRN).approve(address(vaultKrn), HOOKR_IN);
        (uint256 shares, uint256 used0, uint256 used1) = vaultKrn.deposit(HOOKR_IN, HOOKR_IN, 0, alice);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(vaultKrn.balanceOf(alice), shares);
        assertEq(_poolLiquidity(KRN_POOL_ID), poolBefore + vaultKrn.positionLiquidity(), "pool L grew by our L");
        assertEq(IERC20(HOOKR).balanceOf(alice), HOOKR_IN - used0, "HOOKR refund");
        assertEq(IERC20(KRN).balanceOf(alice), HOOKR_IN - used1, "KRN refund");

        vm.prank(alice);
        (uint256 out0, uint256 out1) = vaultKrn.redeem(shares, 0, 0, alice, alice);
        assertEq(vaultKrn.totalSupply(), 0);
        assertEq(vaultKrn.positionLiquidity(), 0);
        assertEq(_poolLiquidity(KRN_POOL_ID), poolBefore, "pool L restored");
        assertApproxEqRel(out0, used0, 1e14, "principal0 back within 0.01%");
        assertApproxEqRel(out1, used1, 1e14, "principal1 back within 0.01%");
    }

    // --- adapters directly ----------------------------------------------------------------------

    function test_depositAdapterZapsInFromHookrOnly() public {
        if (!_forkOrSkip()) return;
        _deployStack();
        address zap = makeAddr("zap");
        deal(HOOKR, zap, HOOKR_IN);

        vm.startPrank(zap);
        IERC20(HOOKR).approve(address(depositAdapter), HOOKR_IN);
        (address tokenOut, uint256 shares) =
            depositAdapter.execute(HOOKR, HOOKR_IN, abi.encode(address(vaultKrn), uint256(1)));
        vm.stopPrank();

        assertEq(tokenOut, address(vaultKrn));
        assertGt(shares, 0);
        assertEq(vaultKrn.balanceOf(zap), shares, "shares minted to the zap");
        assertEq(vaultKrn.balanceOf(address(depositAdapter)), 0);
        assertEq(IERC20(HOOKR).balanceOf(address(depositAdapter)), 0, "no HOOKR retained");
        assertEq(IERC20(KRN).balanceOf(address(depositAdapter)), 0, "no KRN retained");
        assertEq(IERC20(HOOKR).allowance(address(depositAdapter), address(vaultKrn)), 0);
        // Whatever the ratio could not absorb came back to the zap.
        assertLt(IERC20(HOOKR).balanceOf(zap), HOOKR_IN / 100, "HOOKR residue is dust");
    }

    function test_depositAdapterRefusesUnknownVaultAndBadData() public {
        if (!_forkOrSkip()) return;
        _deployStack();
        address zap = makeAddr("zap");
        deal(HOOKR, zap, HOOKR_IN);
        vm.startPrank(zap);
        IERC20(HOOKR).approve(address(depositAdapter), HOOKR_IN);

        vm.expectRevert(abi.encodeWithSelector(HookedRangeDepositAdapter.UnknownVault.selector, address(this)));
        depositAdapter.execute(HOOKR, HOOKR_IN, abi.encode(address(this), uint256(0)));

        vm.expectRevert(HookedRangeDepositAdapter.InvalidData.selector);
        depositAdapter.execute(HOOKR, HOOKR_IN, "");

        vm.expectRevert(abi.encodeWithSelector(HookedRangeDepositAdapter.UnsupportedToken.selector, TCL));
        depositAdapter.execute(TCL, HOOKR_IN, abi.encode(address(vaultKrn), uint256(0)));
        vm.stopPrank();
    }

    function test_withdrawAdapterZapsOutToHookr() public {
        if (!_forkOrSkip()) return;
        _deployStack();
        address zap = makeAddr("zap");
        deal(HOOKR, zap, HOOKR_IN);

        vm.startPrank(zap);
        IERC20(HOOKR).approve(address(depositAdapter), HOOKR_IN);
        (, uint256 shares) = depositAdapter.execute(HOOKR, HOOKR_IN, abi.encode(address(vaultKrn), uint256(1)));
        uint256 hookrBefore = IERC20(HOOKR).balanceOf(zap);

        vaultKrn.approve(address(withdrawAdapter), shares);
        (address tokenOut, uint256 out) = withdrawAdapter.execute(address(vaultKrn), shares, abi.encode(HOOKR, uint256(1)));
        vm.stopPrank();

        assertEq(tokenOut, HOOKR);
        assertEq(vaultKrn.balanceOf(zap), 0, "all shares burned");
        assertEq(IERC20(HOOKR).balanceOf(zap), hookrBefore + out);
        // Round trip through two dynamic-fee swaps: back within a few percent of the input.
        assertGt(out, HOOKR_IN * 90 / 100, "round trip lost more than 10%");
        assertEq(IERC20(HOOKR).balanceOf(address(withdrawAdapter)), 0);
        assertEq(IERC20(KRN).balanceOf(address(withdrawAdapter)), 0);

        vm.expectRevert(abi.encodeWithSelector(HookedRangeWithdrawAdapter.UnknownVault.selector, HOOKR));
        withdrawAdapter.execute(HOOKR, 1, abi.encode(HOOKR, uint256(0)));
    }

    // --- capsules through the LIVE v1.1 factory --------------------------------------------------

    function _governanceWires() internal {
        vm.startPrank(GOVERNANCE);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(depositAdapter), true);
        AdapterRegistry(LIVE_ADAPTER_REGISTRY).setAdapter(address(withdrawAdapter), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(HOOKR, true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(address(vaultKrn), true);
        TokenAllowlist(LIVE_TOKEN_ALLOWLIST).setToken(address(vaultTcl), true);
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

    function test_liveFactoryZapInZapOutAndMigrateEndToEnd() public {
        if (!_forkOrSkip()) return;
        _deployStack();
        _governanceWires();

        uint256 ownerPk = 0xB0B1E5A11CE;
        address owner = vm.addr(ownerPk);
        deal(HOOKR, owner, HOOKR_IN * 2);

        // 1. Zap in: HOOKR → KRN-pool shares, one step.
        Step[] memory inSteps = new Step[](1);
        inSteps[0] = Step({
            adapter: address(depositAdapter),
            tokenIn: HOOKR,
            spender: address(depositAdapter),
            amountIn: HOOKR_IN,
            data: abi.encode(address(vaultKrn), uint256(1))
        });
        address[] memory inTracked = new address[](2);
        inTracked[0] = HOOKR;
        inTracked[1] = address(vaultKrn);
        _createAndRun(ownerPk, inSteps, inTracked, HOOKR, HOOKR_IN, address(vaultKrn), keccak256("hookr-lp-in"));
        uint256 shares = vaultKrn.balanceOf(owner);
        assertGt(shares, 0, "owner holds KRN-pool shares");

        // Size the migration's second leg from a dry run of the first, exactly as the app pins an
        // intermediate min-out to the next step's frozen amount.
        uint256 snapshot = vm.snapshotState();
        vm.startPrank(owner);
        vaultKrn.approve(address(withdrawAdapter), shares);
        (, uint256 hookrOut) = withdrawAdapter.execute(address(vaultKrn), shares, abi.encode(HOOKR, uint256(1)));
        vm.stopPrank();
        vm.revertToState(snapshot);
        uint256 legTwo = hookrOut * 99 / 100;

        // 2. Migrate: KRN-pool shares → HOOKR → TCL-pool shares, two steps, HOOKR carried.
        Step[] memory migrate = new Step[](2);
        migrate[0] = Step({
            adapter: address(withdrawAdapter),
            tokenIn: address(vaultKrn),
            spender: address(withdrawAdapter),
            amountIn: shares,
            data: abi.encode(HOOKR, legTwo)
        });
        migrate[1] = Step({
            adapter: address(depositAdapter),
            tokenIn: HOOKR,
            spender: address(depositAdapter),
            amountIn: legTwo,
            data: abi.encode(address(vaultTcl), uint256(1))
        });
        address[] memory migrateTracked = new address[](3);
        migrateTracked[0] = address(vaultKrn);
        migrateTracked[1] = HOOKR;
        migrateTracked[2] = address(vaultTcl);
        uint128 tclBefore = _poolLiquidity(TCL_POOL_ID);
        address migrateZap = _createAndRun(
            ownerPk, migrate, migrateTracked, address(vaultKrn), shares, address(vaultTcl), keccak256("hookr-lp-migrate")
        );

        assertEq(vaultKrn.balanceOf(owner), 0, "left pool A");
        assertGt(vaultTcl.balanceOf(owner), 0, "entered pool B");
        assertGt(_poolLiquidity(TCL_POOL_ID), tclBefore, "pool B liquidity grew");
        assertEq(vaultKrn.balanceOf(migrateZap), 0);
        assertEq(vaultTcl.balanceOf(migrateZap), 0);
        assertEq(IERC20(HOOKR).allowance(migrateZap, address(depositAdapter)), 0);
        assertEq(vaultKrn.allowance(migrateZap, address(withdrawAdapter)), 0);
        // The 1% sizing slack strands in the capsule as HOOKR — stated, owner-recoverable.
        assertLt(IERC20(HOOKR).balanceOf(migrateZap), hookrOut / 50, "stranded HOOKR is bounded slack");

        // 3. Zap out: TCL-pool shares → HOOKR, one step.
        uint256 tclShares = vaultTcl.balanceOf(owner);
        Step[] memory outSteps = new Step[](1);
        outSteps[0] = Step({
            adapter: address(withdrawAdapter),
            tokenIn: address(vaultTcl),
            spender: address(withdrawAdapter),
            amountIn: tclShares,
            data: abi.encode(HOOKR, uint256(1))
        });
        address[] memory outTracked = new address[](2);
        outTracked[0] = address(vaultTcl);
        outTracked[1] = HOOKR;
        uint256 hookrBefore = IERC20(HOOKR).balanceOf(owner);
        _createAndRun(ownerPk, outSteps, outTracked, address(vaultTcl), tclShares, HOOKR, keccak256("hookr-lp-out"));
        assertEq(vaultTcl.balanceOf(owner), 0, "left pool B");
        assertGt(IERC20(HOOKR).balanceOf(owner), hookrBefore, "HOOKR came back");
    }
}
