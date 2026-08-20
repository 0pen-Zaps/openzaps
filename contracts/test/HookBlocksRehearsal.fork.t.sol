// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {HookBlocks} from "../src/campaign/HookBlocks.sol";

interface IERC20Live {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWethLive is IERC20Live {
    function deposit() external payable;
}

interface IVaultLive is IERC20Live {
    function harvest() external;
    function sync() external;
    function claimable(address account, address rewardAsset) external view returns (uint256);
}

/// @dev Opt-in DRESS REHEARSAL against live Robinhood Chain state: the exact
///      production sequence of campaign 2's buy-and-burn leg, every failure mode
///      and admin safeguard, executed end to end on a fork before any real
///      broadcast. Ongoing fee flow is simulated faithfully by sending WETH
///      into the real vault and calling its permissionless `sync()`, which
///      credits all 100 shares exactly as harvested locker fees do.
///      Run with RUN_ROBINHOOD_FORK=true forge test --match-contract
///      HookBlocksRehearsalForkTest -vv.
contract HookBlocksRehearsalForkTest is Test {
    address internal constant VAULT = 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant SPONSOR = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    bytes32 internal constant POOL_ID = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;

    uint64 internal startAt;
    uint64 internal endAt;
    uint64 internal sweepAfter;
    HookBlocks internal hb;
    address internal keeper = makeAddr("rehearsal-keeper");

    function _forkAndDeploy() internal returns (bool) {
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) return false;
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));

        startAt = uint64(block.timestamp + 1 days);
        endAt = startAt + 14 days;
        sweepAfter = endAt + 30 days;
        hb = new HookBlocks(
            VAULT,
            WETH,
            HOOKR,
            POOL_MANAGER,
            2500,
            25,
            POOL_ID,
            SPONSOR,
            startAt,
            endAt,
            sweepAfter,
            9_700,
            0.05 ether,
            0.0005 ether
        );

        vm.startPrank(SPONSOR);
        IERC20Live(VAULT).approve(address(hb), 50e18);
        hb.fundFeeShares(50e18);
        vm.stopPrank();
        return true;
    }

    /// @dev Sends `amount` of WETH into the REAL vault and syncs, exactly how
    ///      harvested locker fees credit the 100 shares; our 50 accrue half.
    function _simulateFeeFlow(uint256 amount) internal {
        address source = makeAddr("rehearsal-fee-source");
        vm.deal(source, amount + 1 ether);
        vm.startPrank(source);
        IWethLive(WETH).deposit{value: amount}();
        IERC20Live(WETH).transfer(VAULT, amount);
        vm.stopPrank();
        IVaultLive(VAULT).sync();
    }

    function test_rehearsal_fullCampaignLifecycle() public {
        if (!_forkAndDeploy()) {
            vm.skip(true);
            return;
        }

        // --- window opens; first real locker fees arrive and get burned ---
        vm.warp(startAt + 1);
        IVaultLive(VAULT).harvest();
        _simulateFeeFlow(0.06 ether); // ~a day of pool fees, vault-credited

        uint256 claimableNow = IVaultLive(VAULT).claimable(address(hb), WETH);
        assertGt(claimableNow, 0.02 ether); // our 50/100 of the simulated flow

        uint256 deadBefore = IERC20Live(HOOKR).balanceOf(hb.DEAD());
        vm.prank(keeper);
        uint256 firstBurn = hb.buyAndBurn(0);
        assertGt(firstBurn, 0);
        assertEq(hb.blockCount(), 1);
        assertEq(IERC20Live(HOOKR).balanceOf(hb.DEAD()) - deadBefore, firstBurn);
        assertEq(IERC20Live(HOOKR).balanceOf(address(hb)), 0);

        // --- mid-campaign: more flow, multiple cranks across blocks ---
        vm.warp(startAt + 7 days);
        _simulateFeeFlow(0.08 ether);
        uint256 rounds;
        while (rounds < 12) {
            vm.roll(block.number + 1);
            (bool ok,) = address(hb).call(abi.encodeWithSelector(HookBlocks.buyAndBurn.selector, uint256(0)));
            if (!ok) break;
            rounds++;
        }
        assertGt(hb.blockCount(), 1);
        // Every crank respected the per-call cap.
        for (uint256 i; i < hb.blockCount(); i++) {
            assertLe(hb.hookBlock(i).ethIn, 0.05 ether);
        }

        // --- term ends: finalize returns exactly the principal ---
        vm.warp(endAt + 1);
        hb.finalize();
        assertEq(IERC20Live(VAULT).balanceOf(SPONSOR), 100e18);
        assertEq(IERC20Live(VAULT).balanceOf(address(hb)), 0);
        // With the shares gone, the vault owes this contract nothing more.
        assertEq(IVaultLive(VAULT).claimable(address(hb), WETH), 0);

        // --- residual drain, then the ledger IS the dead-address delta ---
        uint256 drainRounds;
        while (drainRounds < 12) {
            vm.roll(block.number + 1);
            (bool ok,) = address(hb).call(abi.encodeWithSelector(HookBlocks.buyAndBurn.selector, uint256(0)));
            if (!ok) break;
            drainRounds++;
        }
        assertLt(IERC20Live(WETH).balanceOf(address(hb)) + address(hb).balance, 0.0005 ether);

        uint256 sumEth;
        uint256 sumHookr;
        for (uint256 i; i < hb.blockCount(); i++) {
            HookBlocks.HookBlock memory blk = hb.hookBlock(i);
            sumEth += blk.ethIn;
            sumHookr += blk.hookrBought;
        }
        assertEq(sumEth, hb.totalEthSpent());
        assertEq(sumHookr, hb.totalHookrBought());
        // Every burned token is at DEAD and none of it is here.
        assertEq(IERC20Live(HOOKR).balanceOf(hb.DEAD()) - deadBefore, hb.totalHookrBurned());
        assertEq(IERC20Live(HOOKR).balanceOf(address(hb)), 0);
    }

    function test_rehearsal_failureModesAndSafeguards() public {
        if (!_forkAndDeploy()) {
            vm.skip(true);
            return;
        }

        vm.warp(startAt + 1);
        IVaultLive(VAULT).harvest();
        _simulateFeeFlow(0.05 ether);

        // --- failure mode: floor not met (a keeper demanding the impossible
        //     stands in for a sandwiched or broken price) — WETH is retained,
        //     nothing is burned, nothing is lost ---
        uint256 wethBefore = hb.pendingWeth();
        vm.prank(keeper);
        vm.expectRevert();
        hb.buyAndBurn(type(uint128).max);
        assertEq(hb.blockCount(), 0);
        assertEq(hb.pendingWeth(), wethBefore);

        // --- safeguard: sponsor pauses the conversion leg; the crank halts
        //     but nothing else does ---
        vm.prank(SPONSOR);
        hb.setBuybackPaused(true);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vm.expectRevert(HookBlocks.BuybackPaused.selector);
        hb.buyAndBurn(0);

        // --- safeguard: unpause restores the identical permissionless path ---
        vm.prank(SPONSOR);
        hb.setBuybackPaused(false);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        uint256 burned = hb.buyAndBurn(0);
        assertGt(burned, 0);

        // --- sweep gating: nobody mid-window, sponsor from END_AT, everyone
        //     from SWEEP_AFTER ---
        vm.prank(SPONSOR);
        vm.expectRevert(HookBlocks.SweepNotOpen.selector);
        hb.sweepUnspent();

        vm.warp(endAt + 1);
        hb.finalize();
        _drainThenLeaveResidue();

        vm.prank(keeper);
        vm.expectRevert(HookBlocks.SweepNotOpen.selector);
        hb.sweepUnspent();

        uint256 sponsorWethBefore = IERC20Live(WETH).balanceOf(SPONSOR);
        uint256 sponsorHookrBefore = IERC20Live(HOOKR).balanceOf(SPONSOR);
        uint256 burnedTotal = hb.totalHookrBurned();
        vm.prank(SPONSOR);
        hb.sweepUnspent();
        assertGt(IERC20Live(WETH).balanceOf(SPONSOR), sponsorWethBefore);
        // The safeguards recovered WETH and nothing else: burned HOOKR sits at
        // DEAD, the contract holds none, and the sponsor gained none.
        assertGt(burnedTotal, 0);
        assertEq(IERC20Live(HOOKR).balanceOf(address(hb)), 0);
        assertEq(IERC20Live(HOOKR).balanceOf(SPONSOR), sponsorHookrBefore);
        assertEq(hb.totalHookrBurned(), burnedTotal);
    }

    /// @dev Leaves a sub-minimum WETH residue in the contract so the sweep
    ///      paths have something real to recover.
    function _drainThenLeaveResidue() internal {
        uint256 rounds;
        while (rounds < 12) {
            vm.roll(block.number + 1);
            (bool ok,) = address(hb).call(abi.encodeWithSelector(HookBlocks.buyAndBurn.selector, uint256(0)));
            if (!ok) break;
            rounds++;
        }
        address source = makeAddr("residue-source");
        vm.deal(source, 1 ether);
        vm.startPrank(source);
        IWethLive(WETH).deposit{value: 0.0003 ether}();
        IERC20Live(WETH).transfer(address(hb), 0.0003 ether);
        vm.stopPrank();
    }
}
