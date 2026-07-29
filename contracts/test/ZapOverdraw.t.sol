// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ZapOverdraw} from "../src/game/ZapOverdraw.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice A token that delivers less than it was asked to move. Standalone rather than a subclass
///         of `MockERC20`, which is deliberately non-virtual so the shared mock stays honest for
///         every other suite. The game must refuse this outright rather than book a pot it does not
///         hold.
contract FeeOnTransferERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        uint256 net = value - (value / 100);
        balanceOf[from] -= value;
        balanceOf[to] += net;
        emit Transfer(from, to, net);
        return true;
    }
}

contract ZapOverdrawTest is Test {
    ZapOverdraw internal game;
    MockERC20 internal zaps;

    address internal constant RAKE = address(0xBEEF);
    uint256 internal constant ENTRY = 100e18;
    uint64 internal constant COMMIT_WINDOW = 1 hours;
    uint64 internal constant REVEAL_WINDOW = 30 minutes;
    uint16 internal constant RAKE_BPS = 200; // 2%
    uint16 internal constant KEEPER_BPS = 50; // 0.5%

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);
    address internal dave = address(0xDA7E);

    /// Mirror of `ZapOverdraw.MIN_REVEALS`, for bounding the sweep fuzz.
    uint256 internal constant MIN_REVEALS_T = 2;

    /// @dev Every address that could hold a credit. The solvency check sums over this, so any
    ///      helper that mints a new player MUST append to it — a missing entry understates what
    ///      the contract owes and turns a real solvency failure into a passing test.
    address[] internal _tracked;

    function setUp() public {
        // A round opens in the constructor, so start the clock somewhere sane rather than at 0.
        vm.warp(1_700_000_000);
        zaps = new MockERC20("OpenZaps", "0xZAPS", 18);
        game = new ZapOverdraw(address(zaps), RAKE, ENTRY, COMMIT_WINDOW, REVEAL_WINDOW, RAKE_BPS, KEEPER_BPS);

        address[4] memory players = [alice, bob, carol, dave];
        for (uint256 i = 0; i < players.length; ++i) {
            zaps.mint(players[i], 100_000e18);
            vm.prank(players[i]);
            zaps.approve(address(game), type(uint256).max);
            _tracked.push(players[i]);
        }
        _tracked.push(address(this));
        _tracked.push(RAKE);
    }

    // ------------------------------------------------------------------ //
    // Helpers                                                             //
    // ------------------------------------------------------------------ //

    function _commit(address player, uint16 draw, bytes32 salt) internal {
        bytes32 blob = game.commitmentFor(game.currentRound(), player, draw, salt);
        vm.prank(player);
        game.commit(blob);
    }

    function _reveal(address player, uint16 draw, bytes32 salt) internal {
        vm.prank(player);
        game.reveal(draw, salt);
    }

    function _intoReveal() internal {
        (uint64 commitEnd,,,,) = game.rounds(game.currentRound());
        vm.warp(commitEnd + 1);
    }

    function _intoSettle() internal {
        (, uint64 revealEnd,,,) = game.rounds(game.currentRound());
        vm.warp(revealEnd + 1);
    }

    /// @dev The one accounting fact everything else rests on: every token this contract holds is
    ///      either credited to somebody or sitting in the open round's pot. Never more, never less.
    function _assertSolvent() internal {
        uint256 owed;
        for (uint256 i = 0; i < _tracked.length; ++i) {
            owed += game.credit(_tracked[i]);
        }
        (,, uint32 seats,,) = game.rounds(game.currentRound());
        assertEq(zaps.balanceOf(address(game)), owed + game.carryPool() + uint256(seats) * ENTRY, "solvency");
    }

    // ------------------------------------------------------------------ //
    // The waterfall                                                       //
    // ------------------------------------------------------------------ //

    /// Four seats, hand-computed. fees 400e18, rake 8e18, keeper 2e18, capacity 390e18.
    /// 10% -> 39e18, 25% -> 97.5e18, 30% -> 117e18 all fit; 50% wants 195e18 with 136.5e18 left.
    function test_waterfallServesModestFirstAndCutsTheRest() public {
        _commit(alice, 1000, "a");
        _commit(bob, 2500, "b");
        _commit(carol, 3000, "c");
        _commit(dave, 5000, "d");

        _intoReveal();
        _reveal(dave, 5000, "d"); // reveal order is deliberately not draw order
        _reveal(alice, 1000, "a");
        _reveal(carol, 3000, "c");
        _reveal(bob, 2500, "b");

        _intoSettle();
        game.settle();

        assertEq(game.credit(alice), 39e18, "alice 10%");
        assertEq(game.credit(bob), 97.5e18, "bob 25%");
        assertEq(game.credit(carol), 117e18, "carol 30%");
        assertEq(game.credit(dave), 0, "dave cut");

        assertEq(zaps.balanceOf(RAKE), 8e18, "rake");
        assertEq(game.credit(address(this)), 2e18, "keeper reward");

        // 390e18 capacity less 253.5e18 served stays charged for round 2.
        assertEq(game.carryPool(), 136.5e18, "carry");
        assertEq(game.currentRound(), 2, "round advanced");
        _assertSolvent();
    }

    /// @dev Mirrors `ZapOverdraw._tiebreak`. Equal draws are ordered by this, not by who got their
    ///      reveal in first, so the test can predict the winner before either player moves.
    function _tiebreak(uint256 roundId, address player) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(roundId, player))) >> 80;
    }

    /// Equal draws must resolve the same way no matter what order the reveals land in. If they did
    /// not, every tie would be a latency race — and on a single-sequencer chain, the sequencer's
    /// choice — rather than a game.
    function test_equalDrawsAreBrokenByAFixedHashNotByRevealOrder() public {
        address first = _tiebreak(1, alice) < _tiebreak(1, bob) ? alice : bob;
        address second = first == alice ? bob : alice;

        _commit(alice, 10_000, "a");
        _commit(bob, 10_000, "b");

        _intoReveal();
        // Deliberately reveal the loser first: under a reveal-order tiebreak this alone would
        // hand them the entire capacity.
        _reveal(second, 10_000, second == alice ? bytes32("a") : bytes32("b"));
        _reveal(first, 10_000, first == alice ? bytes32("a") : bytes32("b"));

        _intoSettle();
        game.settle();

        assertEq(game.credit(first), 195e18, "lower tiebreak served");
        assertEq(game.credit(second), 0, "higher tiebreak cut despite revealing first");
        _assertSolvent();
    }

    /// The same table, revealed in the opposite order, must settle identically.
    function test_revealOrderCannotChangeTheOutcome() public {
        address first = _tiebreak(1, alice) < _tiebreak(1, bob) ? alice : bob;

        _commit(alice, 10_000, "a");
        _commit(bob, 10_000, "b");
        _intoReveal();
        _reveal(first, 10_000, first == alice ? bytes32("a") : bytes32("b"));
        _reveal(first == alice ? bob : alice, 10_000, first == alice ? bytes32("b") : bytes32("a"));
        _intoSettle();
        game.settle();

        assertEq(game.credit(first), 195e18, "same winner either way");
    }

    function test_unrevealedSeatForfeitsItsEntryToThePot() public {
        _commit(alice, 5000, "a");
        _commit(bob, 5000, "b");
        _commit(carol, 5000, "c"); // carol never reveals

        _intoReveal();
        _reveal(alice, 5000, "a");
        _reveal(bob, 5000, "b");

        _intoSettle();
        game.settle();

        // Carol's entry is in the pot all the same: fees 300e18, rake 6e18, keeper 1.5e18,
        // capacity 292.5e18. Alice and Bob take 50% of it each.
        assertEq(game.credit(alice), 146.25e18, "alice");
        assertEq(game.credit(bob), 146.25e18, "bob");
        assertEq(game.credit(carol), 0, "carol forfeited");
        _assertSolvent();
    }

    function test_undeliveredCurrentCarriesIntoTheNextRound() public {
        _commit(alice, 1000, "a");
        _commit(bob, 1000, "b");
        _intoReveal();
        _reveal(alice, 1000, "a");
        _reveal(bob, 1000, "b");
        _intoSettle();
        game.settle();

        // capacity 195e18, two 10% draws take 39e18, so 156e18 returns to the pool.
        assertEq(game.carryPool(), 156e18, "pooled");

        // Round 2 may draw on the pool only up to its own rake: 2% of 200e18 is 4e18. That cap is
        // the whole anti-sweep defence, so it is asserted on the capacity a player actually sees.
        _commit(carol, 10_000, "c2");
        _commit(dave, 10_000, "d2");
        (uint256 capacity2,) = game.previewCapacity();
        assertEq(capacity2, 200e18 - 4e18 - 1e18 + 4e18, "fees less friction, plus a capped release");
        assertEq(game.releasableCarry(), 4e18, "release is capped at the round's rake");
        _assertSolvent();
    }

    function test_loneRevealDoesNotDischarge() public {
        _commit(alice, 10_000, "a");
        _commit(bob, 10_000, "b");
        _intoReveal();
        _reveal(alice, 10_000, "a"); // bob stays silent, so only one draw is on the table
        _intoSettle();
        game.settle();

        assertEq(game.credit(alice), 0, "no discharge below MIN_REVEALS");
        assertEq(game.carryPool(), 195e18, "whole capacity returns to the pool");
        _assertSolvent();
    }

    function test_noRevealsAtAllStillSettlesAndCarries() public {
        _commit(alice, 5000, "a");
        _intoSettle();
        game.settle();

        assertEq(game.carryPool(), 100e18 - 2e18 - 0.5e18, "capacity returns to the pool");
        assertEq(game.currentRound(), 2);
        _assertSolvent();
    }

    /// A draw too small to round up to one wei must not stop the walk for the players behind it.
    function test_dustDrawIsServedZeroWithoutBlockingTheQueue() public {
        // Deploy a game whose capacity is small enough that 1bp rounds to zero.
        MockERC20 tiny = new MockERC20("Tiny", "TINY", 0);
        ZapOverdraw g = new ZapOverdraw(address(tiny), RAKE, 100, COMMIT_WINDOW, REVEAL_WINDOW, 1, 0);
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i = 0; i < ps.length; ++i) {
            tiny.mint(ps[i], 1000);
            vm.prank(ps[i]);
            tiny.approve(address(g), type(uint256).max);
        }

        uint16[3] memory draws = [uint16(1), 5000, 5000];
        for (uint256 i = 0; i < ps.length; ++i) {
            // `commitmentFor` is an external call, so it must not sit in the argument list of a
            // pranked call — argument evaluation happens first and would consume the prank.
            bytes32 blob = g.commitmentFor(1, ps[i], draws[i], "s");
            vm.prank(ps[i]);
            g.commit(blob);
        }
        (uint64 commitEnd,,,,) = g.rounds(1);
        vm.warp(commitEnd + 1);
        for (uint256 i = 0; i < ps.length; ++i) {
            vm.prank(ps[i]);
            g.reveal(draws[i], "s");
        }
        (, uint64 revealEnd,,,) = g.rounds(1);
        vm.warp(revealEnd + 1);
        g.settle();

        // capacity 300; alice's 1bp rounds to 0 and is skipped, the two 50% draws still get 150 each.
        assertEq(g.credit(alice), 0, "dust served nothing");
        assertEq(g.credit(bob), 150, "bob still served");
        assertEq(g.credit(carol), 150, "carol still served");
    }

    // ------------------------------------------------------------------ //
    // Claiming                                                            //
    // ------------------------------------------------------------------ //

    function test_claimPaysAndZeroesCredit() public {
        _commit(alice, 4000, "a");
        _commit(bob, 4000, "b");
        _intoReveal();
        _reveal(alice, 4000, "a");
        _reveal(bob, 4000, "b");
        _intoSettle();
        game.settle();

        uint256 owed = game.credit(alice);
        assertGt(owed, 0);
        uint256 before = zaps.balanceOf(alice);

        vm.prank(alice);
        game.claim();

        assertEq(zaps.balanceOf(alice), before + owed, "paid");
        assertEq(game.credit(alice), 0, "zeroed");

        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.NothingToClaim.selector);
        game.claim();
        _assertSolvent();
    }

    // ------------------------------------------------------------------ //
    // Windows and refusals                                                //
    // ------------------------------------------------------------------ //

    function test_commitRefusedAfterCommitWindow() public {
        _intoReveal();
        bytes32 blob = game.commitmentFor(1, alice, 100, "a");
        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.CommitWindowClosed.selector);
        game.commit(blob);
    }

    function test_revealRefusedOutsideRevealWindow() public {
        _commit(alice, 100, "a");

        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.NotRevealWindow.selector);
        game.reveal(100, "a");

        _intoSettle();
        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.NotRevealWindow.selector);
        game.reveal(100, "a");
    }

    function test_secondSeatForSameAddressRefused() public {
        _commit(alice, 100, "a");
        bytes32 blob = game.commitmentFor(1, alice, 200, "a2");
        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.SeatTaken.selector);
        game.commit(blob);
    }

    function test_emptyCommitmentRefused() public {
        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.EmptyCommitment.selector);
        game.commit(bytes32(0));
    }

    function test_revealMustMatchTheCommitment() public {
        _commit(alice, 1000, "a");
        _intoReveal();

        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.BadReveal.selector);
        game.reveal(2000, "a"); // different draw

        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.BadReveal.selector);
        game.reveal(1000, "wrong-salt");

        _reveal(alice, 1000, "a");
        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.AlreadyRevealed.selector);
        game.reveal(1000, "a");
    }

    function test_revealWithoutASeatRefused() public {
        _commit(alice, 1000, "a");
        _intoReveal();
        vm.prank(bob);
        vm.expectRevert(ZapOverdraw.NoSeat.selector);
        game.reveal(1000, "a");
    }

    function test_drawMustBeInRange() public {
        _commit(alice, 1000, "a");
        _intoReveal();

        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.DrawOutOfRange.selector);
        game.reveal(0, "a");

        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.DrawOutOfRange.selector);
        game.reveal(10_001, "a");
    }

    function test_settleRefusedWhileRevealWindowOpenAndRefusedTwice() public {
        _commit(alice, 1000, "a");
        vm.expectRevert(ZapOverdraw.RevealWindowOpen.selector);
        game.settle();

        _intoReveal();
        vm.expectRevert(ZapOverdraw.RevealWindowOpen.selector);
        game.settle();

        _intoSettle();
        game.settle();

        // Round 1 is settled and round 2 is now open, so a second settle hits the new round's
        // still-open reveal window rather than silently re-running round 1.
        vm.expectRevert(ZapOverdraw.RevealWindowOpen.selector);
        game.settle();
    }

    /// A commitment is bound to its round, so it cannot be replayed into a later one.
    function test_commitmentIsBoundToItsRound() public {
        bytes32 blob = game.commitmentFor(1, alice, 1000, "a");
        vm.prank(alice);
        game.commit(blob);
        _intoSettle();
        game.settle();

        vm.prank(alice);
        game.commit(blob); // same bytes, round 2 — accepted as a commitment...
        _intoReveal();
        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.BadReveal.selector); // ...but it can never be opened.
        game.reveal(1000, "a");
    }

    /// A commitment is bound to its player, so watching the mempool does not let you copy a draw.
    function test_commitmentIsBoundToItsPlayer() public {
        bytes32 aliceBlob = game.commitmentFor(1, alice, 1234, "secret");
        vm.prank(bob);
        game.commit(aliceBlob);
        _intoReveal();
        vm.prank(bob);
        vm.expectRevert(ZapOverdraw.BadReveal.selector);
        game.reveal(1234, "secret");
    }

    function test_roundIsCappedAtMaxSeats() public {
        uint256 seats = game.MAX_SEATS();
        for (uint256 i = 0; i < seats; ++i) {
            address p = address(uint160(0x1000 + i));
            zaps.mint(p, ENTRY);
            bytes32 blob = game.commitmentFor(1, p, 100, "s");
            vm.startPrank(p);
            zaps.approve(address(game), ENTRY);
            game.commit(blob);
            vm.stopPrank();
        }
        bytes32 late = game.commitmentFor(1, alice, 100, "s");
        vm.prank(alice);
        vm.expectRevert(ZapOverdraw.RoundFull.selector);
        game.commit(late);
    }

    /// The sort must stay correct and affordable at the seat cap.
    function test_fullRoundSettlesInBoundedGas() public {
        uint256 seats = game.MAX_SEATS();
        address[] memory ps = new address[](seats);
        for (uint256 i = 0; i < seats; ++i) {
            ps[i] = address(uint160(0x2000 + i));
            zaps.mint(ps[i], ENTRY);
            bytes32 blob = game.commitmentFor(1, ps[i], uint16(seats - i), "s");
            vm.startPrank(ps[i]);
            zaps.approve(address(game), ENTRY);
            game.commit(blob);
            vm.stopPrank();
        }
        _intoReveal();
        for (uint256 i = 0; i < seats; ++i) {
            // Revealed in descending-draw order, so the sort has maximum work to do.
            vm.prank(ps[i]);
            game.reveal(uint16(seats - i), "s");
        }
        _intoSettle();

        uint256 gasBefore = gasleft();
        game.settle();
        uint256 used = gasBefore - gasleft();
        // Measured at ~2.59M for a full 64-seat round where every seat is served: the cost is
        // dominated by 64 cold `credit` writes, which is the payout itself, not the sort. The
        // headroom here is for solc/EVM drift, not for a design change — if this starts failing,
        // the seat cap is the thing to look at, not the assertion.
        assertLt(used, 3_000_000, "settlement gas at the seat cap");

        // Every draw here is tiny, so all of them are served and the bulk carries.
        assertGt(game.carryPool(), 0, "carry");
    }

    // ------------------------------------------------------------------ //
    // Token behaviour                                                     //
    // ------------------------------------------------------------------ //

    function test_feeOnTransferTokenIsRefused() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20();
        ZapOverdraw g = new ZapOverdraw(address(fee), RAKE, ENTRY, COMMIT_WINDOW, REVEAL_WINDOW, RAKE_BPS, KEEPER_BPS);
        fee.mint(alice, 1000e18);
        bytes32 blob = g.commitmentFor(1, alice, 100, "a");
        vm.startPrank(alice);
        fee.approve(address(g), type(uint256).max);
        vm.expectRevert(ZapOverdraw.InexactTransfer.selector);
        g.commit(blob);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ //
    // Construction                                                        //
    // ------------------------------------------------------------------ //

    function test_constructorRejectsBadConfiguration() public {
        vm.expectRevert(ZapOverdraw.ZeroAddress.selector);
        new ZapOverdraw(address(0), RAKE, ENTRY, COMMIT_WINDOW, REVEAL_WINDOW, RAKE_BPS, KEEPER_BPS);

        vm.expectRevert(ZapOverdraw.ZeroAddress.selector);
        new ZapOverdraw(address(zaps), address(0), ENTRY, COMMIT_WINDOW, REVEAL_WINDOW, RAKE_BPS, KEEPER_BPS);

        vm.expectRevert(ZapOverdraw.ZeroEntryFee.selector);
        new ZapOverdraw(address(zaps), RAKE, 0, COMMIT_WINDOW, REVEAL_WINDOW, RAKE_BPS, KEEPER_BPS);

        vm.expectRevert(ZapOverdraw.RakeTooHigh.selector);
        new ZapOverdraw(address(zaps), RAKE, ENTRY, COMMIT_WINDOW, REVEAL_WINDOW, 501, KEEPER_BPS);

        // A zero rake would freeze the carry pool forever in a contract with no rescue path.
        vm.expectRevert(ZapOverdraw.RakeTooLow.selector);
        new ZapOverdraw(address(zaps), RAKE, ENTRY, COMMIT_WINDOW, REVEAL_WINDOW, 0, KEEPER_BPS);

        vm.expectRevert(ZapOverdraw.KeeperTooHigh.selector);
        new ZapOverdraw(address(zaps), RAKE, ENTRY, COMMIT_WINDOW, REVEAL_WINDOW, RAKE_BPS, 101);

        vm.expectRevert(ZapOverdraw.WindowOutOfRange.selector);
        new ZapOverdraw(address(zaps), RAKE, ENTRY, 1 minutes, REVEAL_WINDOW, RAKE_BPS, KEEPER_BPS);

        vm.expectRevert(ZapOverdraw.WindowOutOfRange.selector);
        new ZapOverdraw(address(zaps), RAKE, ENTRY, COMMIT_WINDOW, 8 days, RAKE_BPS, KEEPER_BPS);
    }

    // ------------------------------------------------------------------ //
    // Properties                                                          //
    // ------------------------------------------------------------------ //

    /// Whatever four players draw, the bus never delivers more current than it had, and the
    /// contract never books an obligation it cannot pay.
    function testFuzz_neverOverdrawsCapacity(uint16 a, uint16 b, uint16 c, uint16 d) public {
        a = uint16(bound(a, 1, 10_000));
        b = uint16(bound(b, 1, 10_000));
        c = uint16(bound(c, 1, 10_000));
        d = uint16(bound(d, 1, 10_000));

        _commit(alice, a, "a");
        _commit(bob, b, "b");
        _commit(carol, c, "c");
        _commit(dave, d, "d");
        _intoReveal();
        _reveal(alice, a, "a");
        _reveal(bob, b, "b");
        _reveal(carol, c, "c");
        _reveal(dave, d, "d");
        _intoSettle();
        game.settle();

        uint256 capacity = 400e18 - 8e18 - 2e18;
        uint256 served = game.credit(alice) + game.credit(bob) + game.credit(carol) + game.credit(dave);

        assertLe(served, capacity, "never overdrawn");
        assertEq(served + game.carryPool(), capacity, "every wei accounted for");
        _assertSolvent();
    }

    /// Serving order is monotone: nobody is cut while a strictly greedier draw is served.
    function testFuzz_greedIsNeverServedBeforeRestraint(uint16 a, uint16 b) public {
        a = uint16(bound(a, 1, 10_000));
        b = uint16(bound(b, 1, 10_000));
        vm.assume(a != b);

        _commit(alice, a, "a");
        _commit(bob, b, "b");
        _intoReveal();
        _reveal(alice, a, "a");
        _reveal(bob, b, "b");
        _intoSettle();
        game.settle();

        uint256 modest = a < b ? game.credit(alice) : game.credit(bob);
        uint256 greedy = a < b ? game.credit(bob) : game.credit(alice);
        if (greedy > 0) assertGt(modest, 0, "greedy served while modest was cut");
    }

    // ------------------------------------------------------------------ //
    // Sybil economics                                                     //
    // ------------------------------------------------------------------ //

    /// @dev Fills a round with `n` attacker-controlled seats whose draws sum to exactly BPS, so
    ///      every one of them is served, then settles from an attacker address so the keeper
    ///      reward comes back too. Returns net profit in stake wei (negative reads as a loss).
    function _sweep(uint256 n) internal returns (int256 profit) {
        uint16 each = uint16(game.BPS() / n);
        address[] memory sybils = new address[](n);
        uint256 spent;

        for (uint256 i = 0; i < n; ++i) {
            sybils[i] = address(uint160(0x5000 + i));
            _tracked.push(sybils[i]);
            zaps.mint(sybils[i], ENTRY);
            bytes32 blob = game.commitmentFor(game.currentRound(), sybils[i], each, "s");
            vm.startPrank(sybils[i]);
            zaps.approve(address(game), ENTRY);
            game.commit(blob);
            vm.stopPrank();
            spent += ENTRY;
        }
        _intoReveal();
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(sybils[i]);
            game.reveal(each, "s");
        }
        _intoSettle();

        vm.prank(sybils[0]);
        game.settle();

        uint256 recovered;
        for (uint256 i = 0; i < n; ++i) {
            recovered += game.credit(sybils[i]);
        }
        profit = int256(recovered) - int256(spent);
    }

    /// @dev Grows the carry pool by running a round in which everybody draws almost nothing.
    function _fattenCarry() internal {
        _commit(alice, 1, "fa");
        _commit(bob, 1, "fb");
        _intoReveal();
        _reveal(alice, 1, "fa");
        _reveal(bob, 1, "fb");
        _intoSettle();
        game.settle();
    }

    /// THE ATTACK THE RELEASE CAP EXISTS TO STOP. An attacker who takes every seat controls every
    /// draw, so they can always arrange to be served in full and take the entire capacity — and
    /// they settle, so the keeper reward returns to them too. Their only real cost is the rake.
    /// Uncapped, any carry above that rake would make this strictly profitable, and two addresses
    /// are enough to satisfy MIN_REVEALS. The cap must make it break-even at best, at every size.
    function testFuzz_tableSweepIsNeverProfitable(uint8 rawSeats) public {
        _fattenCarry();
        assertGt(game.carryPool(), 0, "there is a carry worth stealing");

        uint256 n = bound(uint256(rawSeats), MIN_REVEALS_T, 16);
        int256 profit = _sweep(n);

        assertLe(profit, 0, "sweeping the table must never pay");
        _assertSolvent();
    }

    /// The same claim stated as arithmetic rather than a fuzz run: profit is exactly
    /// `released - rake`, and `released` is capped at `rake`.
    function test_sweepProfitIsExactlyReleasedMinusRake() public {
        _fattenCarry();
        uint256 poolBefore = game.carryPool();

        uint256 n = 4;
        uint256 fees = n * ENTRY;
        uint256 rake = (fees * RAKE_BPS) / 10_000;
        uint256 expectedRelease = poolBefore < rake ? poolBefore : rake;

        int256 profit = _sweep(n);
        assertEq(profit, int256(expectedRelease) - int256(rake), "profit == released - rake");
        assertLe(profit, 0, "which is never positive");
    }

    /// A pool far larger than the rake still only drains at the rake, so it cannot be farmed out
    /// in one round by anybody, honest or not.
    function test_carryReleaseIsCappedAtTheRoundsRake() public {
        _fattenCarry();
        uint256 pool = game.carryPool();

        _commit(alice, 5000, "a");
        _commit(bob, 5000, "b");

        uint256 rake = (2 * ENTRY * RAKE_BPS) / 10_000;
        assertLt(rake, pool, "the pool genuinely exceeds one round's rake");
        assertEq(game.releasableCarry(), rake, "release is clamped to the rake");

        (uint256 capacity,) = game.previewCapacity();
        assertEq(capacity, 2 * ENTRY - rake - (2 * ENTRY * KEEPER_BPS) / 10_000 + rake, "capacity");
    }
}
