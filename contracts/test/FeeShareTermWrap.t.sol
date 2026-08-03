// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {FeeShareTermWrap} from "../src/feeshare/FeeShareTermWrap.sol";

/// @dev Mimics the deployed fee-share vault surface the wrapper touches: an
///      ERC-20 share token whose holders accrue WETH, paid via claimFor. The
///      mock lets tests set claimable amounts directly.
contract MockFeeShareVault {
    string public constant name = "Mock fee shares";
    string public constant symbol = "mFEE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    MockWeth public immutable weth;
    mapping(address => uint256) public pendingClaim;
    bool public reverts;
    bool public viewReverts;

    constructor(MockWeth weth_) {
        weth = weth_;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function setViewReverts(bool r) external {
        viewReverts = r;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }

    function setClaimable(address account, uint256 amount) external {
        pendingClaim[account] = amount;
    }

    function claimable(address account, address) external view returns (uint256) {
        require(!viewReverts, "view paused");
        return pendingClaim[account];
    }

    function claimFor(address account) external {
        require(!reverts, "vault paused");
        uint256 amount = pendingClaim[account];
        pendingClaim[account] = 0;
        weth.mint(account, amount);
    }
}

contract MockWeth {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) public {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "weth balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract FeeShareTermWrapTest is Test {
    MockWeth internal weth;
    MockFeeShareVault internal vault;
    FeeShareTermWrap internal wrap;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint64 internal depositUntil;
    uint64 internal maturity;
    uint64 internal claimDeadline;

    function setUp() public {
        weth = new MockWeth();
        vault = new MockFeeShareVault(weth);
        depositUntil = uint64(block.timestamp + 1 days);
        maturity = uint64(block.timestamp + 8 days);
        claimDeadline = uint64(block.timestamp + 38 days);
        wrap = new FeeShareTermWrap(
            address(vault), address(weth), depositUntil, maturity, claimDeadline, "Wrapped fee term", "wFEE-T1"
        );
        vault.mint(alice, 30e18);
        vault.mint(bob, 10e18);
        vm.prank(alice);
        vault.approve(address(wrap), type(uint256).max);
        vm.prank(bob);
        vault.approve(address(wrap), type(uint256).max);
    }

    function _depositBoth() internal {
        vm.prank(alice);
        wrap.deposit(30e18);
        vm.prank(bob);
        wrap.deposit(10e18);
    }

    // ------------------------------------------------------------- deposits

    function test_depositMintsOneToOneAndRecordsPrincipal() public {
        _depositBoth();
        assertEq(wrap.balanceOf(alice), 30e18);
        assertEq(wrap.balanceOf(bob), 10e18);
        assertEq(wrap.totalSupply(), 40e18);
        assertEq(wrap.depositedShares(alice), 30e18);
        assertEq(wrap.totalDeposited(), 40e18);
        assertEq(vault.balanceOf(address(wrap)), 40e18);
    }

    function test_depositRevertsAfterWindow() public {
        vm.warp(depositUntil);
        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.DepositWindowClosed.selector);
        wrap.deposit(1e18);
    }

    // -------------------------------------------------------------- rewards

    function test_harvestSplitsProRataAndClaimPays() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 4e18);
        wrap.harvest();

        assertEq(wrap.claimableReward(alice), 3e18);
        assertEq(wrap.claimableReward(bob), 1e18);

        vm.prank(alice);
        wrap.claim();
        assertEq(weth.balanceOf(alice), 3e18);
        assertEq(wrap.rewardReserve(), 1e18);
    }

    function test_transferMovesFutureAccrualNotPastAccrual() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 4e18);
        wrap.harvest();

        // Alice sells her wrapped units to Carol AFTER the first harvest.
        vm.prank(alice);
        wrap.transfer(carol, 30e18);

        // Past accrual stays with Alice; new accrual follows the units.
        vault.setClaimable(address(wrap), 8e18);
        wrap.harvest();

        assertEq(wrap.claimableReward(alice), 3e18);
        assertEq(wrap.claimableReward(carol), 6e18);
        assertEq(wrap.claimableReward(bob), 1e18 + 2e18);
    }

    function test_harvestRevertsAfterMaturity() public {
        _depositBoth();
        vm.warp(uint256(maturity) + 1);
        vm.expectRevert(FeeShareTermWrap.TermEnded.selector);
        wrap.harvest();
    }

    // ---------------------------------------------------- redeem after term

    function test_redeemAfterMaturityReturnsPrincipal() public {
        _depositBoth();
        // Coupon holders take their in-term reward via harvest before maturity.
        vault.setClaimable(address(wrap), 2e18);
        wrap.harvest();
        assertEq(wrap.claimableReward(alice), 15e17);

        vm.warp(uint256(maturity) + 1);
        vm.prank(alice);
        wrap.redeemShares();
        assertEq(vault.balanceOf(alice), 30e18);
        assertEq(wrap.depositedShares(alice), 0);
        assertEq(wrap.redeemedShares(alice), 30e18);

        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.ZeroAmount.selector);
        wrap.redeemShares();
    }

    function test_redeemRevertsDuringTerm() public {
        _depositBoth();
        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.TermNotEnded.selector);
        wrap.redeemShares();
    }

    // ---------------------------------------------------------------- sweep

    function test_sweepPaysDepositorsProRataAndSurvivesRedemption() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 4e18);
        wrap.harvest();

        // Nobody claims. Alice redeems principal after maturity — redemption
        // must not forfeit her sweep slice.
        vm.warp(uint256(maturity) + 1);
        vm.prank(alice);
        wrap.redeemShares();

        vm.warp(uint256(claimDeadline) + 1);
        vm.prank(alice);
        wrap.sweepExpired();
        assertEq(weth.balanceOf(alice), 3e18); // 30/40 of the 4e18 unclaimed

        vm.prank(bob);
        wrap.sweepExpired();
        assertEq(weth.balanceOf(bob), 1e18);

        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.NothingToSweep.selector);
        wrap.sweepExpired();
    }

    function test_claimClosesAtDeadline() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 4e18);
        wrap.harvest();
        vm.warp(uint256(claimDeadline) + 1);
        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.ClaimsClosed.selector);
        wrap.claim();
    }

    function test_sweepClosedWhileClaimsOpen() public {
        _depositBoth();
        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.ClaimsStillOpen.selector);
        wrap.sweepExpired();
    }

    // ----------------------------------------------------------------- fuzz

    /// @dev In-term reward conservation: whatever two holders are owed never
    ///      exceeds what was harvested; the shortfall is only division dust.
    function testFuzz_accountingConservesReward(uint96 depositA, uint96 depositB, uint96 rewardAmount) public {
        uint256 a = bound(uint256(depositA), 1, 1e24);
        uint256 b = bound(uint256(depositB), 1, 1e24);
        uint256 r = bound(uint256(rewardAmount), 0, 1e24);

        vault.mint(alice, a);
        vault.mint(bob, b);
        vm.prank(alice);
        wrap.deposit(a);
        vm.prank(bob);
        wrap.deposit(b);

        vault.setClaimable(address(wrap), r);
        wrap.harvest();

        uint256 owedTotal = wrap.claimableReward(alice) + wrap.claimableReward(bob);
        assertLe(owedTotal, r);
        uint256 dustBound = (a + b) / 1e18 + 2;
        assertGe(owedTotal + dustBound, r);
        assertEq(wrap.rewardReserve(), r);
    }

    // -------------------------------------------------- audit regressions

    /// A paused/underfunded vault must NEVER trap principal: redemption is
    /// gated only on the clock and touches no vault reward path.
    function test_redeemSucceedsEvenIfVaultReverts() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 2e18);
        vault.setReverts(true);
        vault.setViewReverts(true);
        vm.warp(uint256(maturity) + 1);
        vm.prank(alice);
        wrap.redeemShares(); // must not revert
        assertEq(vault.balanceOf(alice), 30e18);
    }

    /// WETH that accrues after maturity (the wrapper keeps holding shares until
    /// redemption) reaches DEPOSITORS by LOCKED principal via claimLockedReward,
    /// never coupon holders — in-term accrual freezes at maturity, and the
    /// forfeited-coupon sweep is a separate, empty pool here.
    function test_postMaturityRewardGoesToDepositors() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 2e18);
        wrap.harvest(); // in-term reward to coupon holders
        vm.prank(alice);
        wrap.claim();
        vm.prank(bob);
        wrap.claim();
        assertEq(weth.balanceOf(alice), 15e17);
        assertEq(weth.balanceOf(bob), 5e17);

        vm.warp(uint256(maturity) + 1);
        // Post-maturity accrual pushed into the wrapper by anyone.
        vault.setClaimable(address(wrap), 5e18);
        vault.claimFor(address(wrap));

        // A coupon holder cannot fold it into the in-term distribution: harvest
        // is gated and there is no finalize to do it.
        vm.expectRevert(FeeShareTermWrap.TermEnded.selector);
        wrap.harvest();

        // It is Bucket 2: claimable by still-locked principal, pro-rata by lock.
        vm.prank(alice);
        wrap.claimLockedReward();
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 15e17 + 375e16); // 1.5 in-term + 3.75 post
        assertEq(weth.balanceOf(bob), 5e17 + 125e16); // 0.5 in-term + 1.25 post

        // The forfeited-coupon sweep is empty: every in-term unit was claimed.
        vm.warp(uint256(claimDeadline) + 1);
        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.NothingToSweep.selector);
        wrap.sweepExpired();
    }

    /// ROUND-6 REGRESSION (med): post-maturity reward is generated ONLY by shares
    /// still locked in the wrapper. An early redeemer — whose shares have left
    /// and now earn for her directly — must NOT capture a still-locked
    /// depositor's post-maturity stream. Bucket 2 is keyed on LOCKED principal.
    function test_redeemerCannotSiphonLockedHoldersPostMaturityReward() public {
        _depositBoth(); // alice 30, bob 10; totalLocked 40
        vm.warp(uint256(maturity) + 1);

        // Alice redeems: her 30 shares leave the wrapper and earn for her directly.
        vm.prank(alice);
        wrap.redeemShares();
        assertEq(vault.balanceOf(alice), 30e18);
        assertEq(vault.balanceOf(address(wrap)), 10e18); // only bob's remain locked
        assertEq(wrap.totalLocked(), 10e18);

        // 10e18 now accrues to the wrapper, generated solely by bob's locked shares.
        vault.setClaimable(address(wrap), 10e18);
        vault.claimFor(address(wrap));

        // Bob gets ALL of it; the exited alice gets none of bob's stream.
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(bob), 10e18);
        vm.prank(alice);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 0);
        assertEq(weth.balanceOf(address(wrap)), 0);
    }

    /// The redemption checkpoint captures a redeemer's fair share of reward that
    /// accrued WHILE they were locked, and excludes them from reward that
    /// accrues AFTER they exit — the two-sided property behind the fix.
    function test_redeemerKeepsPostMaturityRewardEarnedWhileLocked() public {
        _depositBoth(); // alice 30, bob 10
        vm.warp(uint256(maturity) + 1);

        // Reward accrues while BOTH are still locked.
        vault.setClaimable(address(wrap), 8e18);
        vault.claimFor(address(wrap));

        // Alice redeems now; her 30/40 slice of the 8e18 is checkpointed and
        // stays claimable after she exits.
        vm.prank(alice);
        wrap.redeemShares();
        assertEq(wrap.totalLocked(), 10e18);

        vm.prank(alice);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 6e18); // 30/40 of the 8e18 she was locked for
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(bob), 2e18); // 10/40

        // Further reward comes only from bob's still-locked shares → all bob's.
        vault.setClaimable(address(wrap), 5e18);
        vault.claimFor(address(wrap));
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(bob), 2e18 + 5e18);
        vm.prank(alice);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 6e18); // unchanged — exited before this accrual
    }

    function test_claimLockedRewardRevertsDuringTerm() public {
        _depositBoth();
        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.TermNotEnded.selector);
        wrap.claimLockedReward();
    }

    /// Selling wrapped units in-term must not forfeit reward that accrued to
    /// the seller before the sale: transfer harvests first.
    function test_transferDoesNotForfeitUnharvestedReward() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 4e18);
        vm.prank(alice);
        wrap.transfer(carol, 30e18);
        assertEq(wrap.claimableReward(alice), 3e18);
        assertEq(wrap.claimableReward(bob), 1e18);
        assertEq(wrap.claimableReward(carol), 0);
    }

    /// ROUND-5 REGRESSION (high): post-maturity reward must NOT be reachable
    /// through the coupon (wrapped-unit) path. Bucket 2 is keyed on PRINCIPAL,
    /// so holding every coupon unit earns none of it.
    function test_postMaturityTransferCannotSiphonSweepReward() public {
        vm.prank(alice);
        wrap.deposit(30e18);
        vm.prank(bob);
        wrap.deposit(10e18);
        vm.prank(alice);
        wrap.transfer(bob, 30e18); // bob holds all 40 coupon units; principal unchanged

        vm.warp(uint256(maturity) + 1);
        vault.setClaimable(address(wrap), 10e18);
        vault.claimFor(address(wrap)); // Bucket 2

        // Bob, holding every coupon unit, shuffles one and claims coupons — the
        // post-maturity reward must not surface through the coupon path.
        vm.prank(bob);
        wrap.transfer(carol, 1e18);
        vm.prank(bob);
        wrap.claim();
        assertEq(weth.balanceOf(bob), 0); // coupons carry no post-maturity reward

        // It is distributed by PRINCIPAL via claimLockedReward: alice(30)/bob(10).
        vm.prank(alice);
        wrap.claimLockedReward();
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 75e17); // 30/40 of 10
        assertEq(weth.balanceOf(bob), 25e17); // 10/40 of 10

        // Carol, a pure coupon holder with no principal, gets nothing.
        vm.prank(carol);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(carol), 0);
    }

    /// ROUND-5 REGRESSION (high): sweeping before redemption must not brick
    /// later redemption via a reserve underflow. Redeem is clock-gated and
    /// independent of any reward path.
    function test_sweepThenRedeemStillWorks() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 4e18);
        wrap.harvest();
        vm.warp(uint256(claimDeadline) + 1);
        vm.prank(alice);
        wrap.sweepExpired();
        // Redemption still works after a sweep.
        vm.prank(alice);
        wrap.redeemShares();
        assertEq(vault.balanceOf(alice), 30e18);
    }

    /// ROUND-4 REGRESSION (med): post-maturity reward the vault pays across
    /// multiple rounds must not be stranded — claimLockedReward is repeatable
    /// and its monotonic accumulator captures each later increment.
    function test_lockedRewardCapturesAccrualArrivingLater() public {
        _depositBoth();
        vm.warp(uint256(maturity) + 1);
        vault.setClaimable(address(wrap), 4e18);
        vault.claimFor(address(wrap));

        vm.prank(alice);
        wrap.claimLockedReward();
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 3e18); // 30/40 of 4
        assertEq(weth.balanceOf(bob), 1e18);

        // More post-maturity reward arrives; the next claim captures it.
        vault.setClaimable(address(wrap), 8e18);
        vault.claimFor(address(wrap));

        vm.prank(alice);
        wrap.claimLockedReward();
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 3e18 + 6e18); // 30/40 of 12 total
        assertEq(weth.balanceOf(bob), 1e18 + 2e18);
        assertEq(weth.balanceOf(address(wrap)), 0);
    }

    /// Both epochs at once: a redeemer collects her ORIGINAL-principal slice of
    /// the forfeited in-term sweep AND her locked-principal slice of Bucket 2,
    /// and the two pools never cross-contaminate.
    function test_bothBucketsPayTheRightBasis() public {
        _depositBoth(); // alice 30, bob 10
        // In-term reward, never claimed by coupon holders → forfeited (Bucket 1).
        vault.setClaimable(address(wrap), 4e18);
        wrap.harvest();
        assertEq(wrap.rewardReserve(), 4e18);

        vm.warp(uint256(maturity) + 1);
        // Post-maturity reward while both locked (Bucket 2).
        vault.setClaimable(address(wrap), 8e18);
        vault.claimFor(address(wrap));

        // Bucket 2 by locked principal.
        vm.prank(alice);
        wrap.claimLockedReward();
        vm.prank(bob);
        wrap.claimLockedReward();
        assertEq(weth.balanceOf(alice), 6e18); // 30/40 of 8
        assertEq(weth.balanceOf(bob), 2e18); // 10/40 of 8

        // Bucket 1 by original principal, after the claim deadline.
        vm.warp(uint256(claimDeadline) + 1);
        vm.prank(alice);
        wrap.sweepExpired();
        vm.prank(bob);
        wrap.sweepExpired();
        assertEq(weth.balanceOf(alice), 6e18 + 3e18); // + 30/40 of the 4 forfeited
        assertEq(weth.balanceOf(bob), 2e18 + 1e18); // + 10/40
        assertEq(weth.balanceOf(address(wrap)), 0); // both pools fully distributed
    }

    /// A late depositor must not dilute reward already owed to earlier
    /// depositors: deposit folds pending reward to current holders first.
    function test_lateDepositorCannotDilute() public {
        vm.prank(alice);
        wrap.deposit(30e18);
        vault.setClaimable(address(wrap), 3e18);
        vm.prank(bob);
        wrap.deposit(10e18);
        assertEq(wrap.claimableReward(alice), 3e18);
        assertEq(wrap.claimableReward(bob), 0);
    }

    /// Fuzz the ROUND-6 property: post-maturity reward that arrives AFTER a
    /// depositor redeems is never paid to her, and the two-epoch split conserves
    /// every wei (exited depositor capped at her fair pre-exit share; the rest,
    /// including the entire post-exit round, goes to the still-locked holder).
    function testFuzz_postMaturitySplitExcludesExitedDepositor(uint96 r1, uint96 r2) public {
        uint256 rA = bound(uint256(r1), 0, 1e24);
        uint256 rB = bound(uint256(r2), 0, 1e24);
        _depositBoth(); // alice 30, bob 10, totalLocked 40
        vm.warp(uint256(maturity) + 1);

        // Round 1: both locked.
        vault.setClaimable(address(wrap), rA);
        vault.claimFor(address(wrap));

        // Alice redeems — her round-1 slice is checkpointed; she then exits.
        vm.prank(alice);
        wrap.redeemShares();

        // Round 2: only bob is locked, so only bob's capital generates it.
        vault.setClaimable(address(wrap), rB);
        vault.claimFor(address(wrap));

        vm.prank(alice);
        wrap.claimLockedReward();
        vm.prank(bob);
        wrap.claimLockedReward();

        // Exact conservation: every reward wei is either paid out or left as dust.
        assertEq(weth.balanceOf(alice) + weth.balanceOf(bob) + weth.balanceOf(address(wrap)), rA + rB);
        // Alice is capped at her fair round-1 share and gets NOTHING from round 2.
        assertLe(weth.balanceOf(alice), rA * 30e18 / 40e18);
    }
}
