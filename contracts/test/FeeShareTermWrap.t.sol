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

    constructor(MockWeth weth_) {
        weth = weth_;
    }

    function setReverts(bool r) external {
        reverts = r;
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

    // ---------------------------------------------------- finalize / redeem

    function test_finalizeCreditsLastAccrualAndOpensRedemption() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 2e18);
        vm.warp(uint256(maturity) + 1);
        wrap.finalize();

        assertEq(wrap.claimableReward(alice), 15e17);
        vm.prank(alice);
        wrap.redeemShares();
        assertEq(vault.balanceOf(alice), 30e18);
        assertEq(wrap.depositedShares(alice), 0);
        assertEq(wrap.redeemedShares(alice), 30e18);

        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.ZeroAmount.selector);
        wrap.redeemShares();
    }

    function test_redeemRevertsBeforeFinalize() public {
        _depositBoth();
        vm.prank(alice);
        vm.expectRevert(FeeShareTermWrap.NotFinalized.selector);
        wrap.redeemShares();
    }

    function test_finalizeOnlyOnce() public {
        _depositBoth();
        vm.warp(uint256(maturity) + 1);
        wrap.finalize();
        vm.expectRevert(FeeShareTermWrap.AlreadyFinalized.selector);
        wrap.finalize();
    }

    // ---------------------------------------------------------------- sweep

    function test_sweepPaysDepositorsProRataAndSurvivesRedemption() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 4e18);
        wrap.harvest();

        // Nobody claims. Alice redeems principal after finalize — redemption
        // must not forfeit her sweep slice.
        vm.warp(uint256(maturity) + 1);
        wrap.finalize();
        vm.prank(alice);
        wrap.redeemShares();

        vm.warp(uint256(claimDeadline) + 1);
        vm.prank(alice);
        wrap.sweepExpired();
        // 4e18 unclaimed, alice principal 30/40.
        assertEq(weth.balanceOf(alice), 3e18);

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

    /// @dev Reward conservation: whatever two depositors are owed never
    ///      exceeds what was harvested, and the shortfall is only dust from
    ///      integer division.
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
        // Conservation: never over-credit.
        assertLe(owedTotal, r);
        // Truncating (received * 1e18) / supply loses at most supply / 1e18
        // units before per-holder rounding; the dust stays in rewardReserve
        // and remains sweepable, so no value leaves the system.
        uint256 dustBound = (a + b) / 1e18 + 2;
        assertGe(owedTotal + dustBound, r);
        assertEq(wrap.rewardReserve(), r);
    }

    // -------------------------------------------------- audit regressions

    /// A paused/underfunded vault must NEVER trap principal by reverting
    /// finalize. The gate flips first; the harvest is defensive.
    function test_finalizeSucceedsEvenIfVaultReverts() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 2e18);
        vault.setReverts(true);
        vm.warp(uint256(maturity) + 1);

        wrap.finalize(); // must not revert
        assertTrue(wrap.finalized());

        // Principal is redeemable regardless of the broken vault.
        vm.prank(alice);
        wrap.redeemShares();
        assertEq(vault.balanceOf(alice), 30e18);
    }

    /// WETH that accrues after finalize (the wrapper keeps holding shares
    /// until redemption) must not be stranded: the first sweep folds the
    /// REAL balance, not just the in-term reserve.
    function test_sweepCapturesPostFinalizeAccrual() public {
        _depositBoth();
        vault.setClaimable(address(wrap), 2e18);
        vm.warp(uint256(maturity) + 1);
        wrap.finalize(); // credits 2e18 in-term

        // Everyone claims the in-term reward to zero the reserve.
        vm.prank(alice);
        wrap.claim();
        vm.prank(bob);
        wrap.claim();
        assertEq(wrap.rewardReserve(), 0);

        // The vault keeps paying the still-held shares after finalize.
        vault.setClaimable(address(wrap), 5e18);
        vault.claimFor(address(wrap)); // anyone can push it in

        vm.warp(uint256(claimDeadline) + 1);
        vm.prank(alice);
        wrap.sweepExpired();
        vm.prank(bob);
        wrap.sweepExpired();

        // The whole 5e18 post-finalize accrual reached depositors, 30/40 + 10/40.
        // 1.5 claimed in-term + 3.75 swept (30/40 of 5) = 5.25 WETH.
        assertEq(weth.balanceOf(alice), 15e17 + 375e16);
        assertEq(weth.balanceOf(bob), 5e17 + 125e16);
    }

    /// A late depositor must not dilute reward already owed to earlier
    /// depositors: deposit folds pending reward to current holders first.
    function test_lateDepositorCannotDilute() public {
        vm.prank(alice);
        wrap.deposit(30e18);
        vault.setClaimable(address(wrap), 3e18); // earned entirely by alice

        // Bob deposits late; the 3e18 must fold to alice before bob mints.
        vm.prank(bob);
        wrap.deposit(10e18);

        assertEq(wrap.claimableReward(alice), 3e18);
        assertEq(wrap.claimableReward(bob), 0);
    }
}
