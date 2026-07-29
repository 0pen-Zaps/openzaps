// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title ZapOverdraw
/// @notice A sealed-bid strategy game played in 0xZAPS. One shared bus, many draws, limited current:
///         every player pays the same entry, secretly declares how much of the bus they intend to
///         draw, and the bus serves the modest first. Draw small and you are almost certainly paid a
///         little. Draw big and you are paid a lot — but only if enough of the table drew small
///         enough to leave the current for you. When the bus runs dry, everyone still queued gets
///         nothing and their entry stays in the pot.
///
///         There is no dealer, no house edge on the outcome, no oracle, and no randomness. The only
///         uncertainty in this game is what the other players chose. That is deliberate: an onchain
///         die is either manipulable by whoever orders the block or dependent on an oracle this
///         chain does not have, whereas a sealed commitment revealed later is verifiable by anyone
///         with nothing to trust but the hash function.
///
/// @dev THIS CONTRACT IS UNAUDITED AND HOLDS REAL USER FUNDS. It is unit-, fuzz- and
///      invariant-tested, not reviewed by a third party. It is short enough to read in full before
///      you play; do that. Play only with what you can afford to lose.
///
///      WHAT IT DOES NOT DO — read this as the specification, not as a disclaimer:
///
///      * NO ADMIN. No owner, no pauser, no upgrade path, no initializer, no `delegatecall`, no
///        `selfdestruct`. Every parameter is an immutable set once in the constructor. Nobody,
///        including the deployer, can change a rule, seize a pot, or stop a round. The symmetric
///        consequence: there is no rescue path either.
///      * NO RANDOMNESS. Nothing reads `block.prevrandao`, `blockhash`, a timestamp, or an oracle to
///        decide an outcome. Outcomes are a pure function of the revealed draws.
///      * NO HOUSE POSITION. The rake recipient cannot play with an advantage; it receives a fixed
///        bps of entry fees and has no other privilege.
///      * NO NATIVE ETH. There is no `receive()` and no `payable` function.
///      * NO FEE-ON-TRANSFER OR REBASING TOKEN SUPPORT. Every movement of the stake token is
///        measured and must match exactly; such a token simply cannot be used here (it reverts).
///        This is an explicit refusal, not silent mispricing.
///      * NO CHAIN GUARD. Deliberate, and for the same reason `ZapVault` omits one: a chain-id
///        change must never be able to permanently trap staked principal in a contract with no
///        admin rescue.
///      * NO SYBIL RESISTANCE BEYOND THE ENTRY FEE. One address is one seat, but addresses are
///        free. A player willing to pay N entries can occupy N of the {MAX_SEATS} seats and shape
///        the distribution of draws. THE ENTRY FEE IS THE ONLY COST OF DOING THAT, and it is the
///        only defence this contract has or can have. Size the entry fee accordingly, and read
///        every round's seat count before you play it.
///
///      THE ONE-SIDED RISK YOU ARE TAKING: losing is normal. A draw that the bus cannot serve pays
///      exactly zero and the entry is not returned. This is a game with negative expected value for
///      the table as a whole (the rake and the keeper reward leave the pot), and any individual
///      player's expectation depends entirely on out-guessing the others. It is not an investment,
///      it earns no yield, and it makes no promise about 0xZAPS's price.
///
///      ROUND SHAPE. A round is three consecutive windows on the wall clock:
///        1. COMMIT   — pay the entry, submit `keccak256` of your sealed draw.
///        2. REVEAL   — open your commitment. A commitment never opened forfeits its entry to the
///                      pot. Without that, a player who saw a bad outcome coming would simply stay
///                      silent, and a sealed bid would bind nobody.
///        3. SETTLE   — permissionless, no deadline, pays the caller a keeper reward. Rounds are
///                      strictly sequential: round N+1 opens the moment round N settles, so a round
///                      left unsettled stalls the game rather than corrupting it.
///
///      THE WATERFALL. `capacity` is this round's entry fees, less the rake and the keeper reward,
///      plus whatever the carry pool is allowed to release. Revealed draws are sorted ascending,
///      ties broken by a fixed hash of (round, player) rather than by who revealed first, and
///      walked in that order; each is credited `capacity * draw / BPS` while the remaining current
///      covers it in full, and the walk stops at the first draw it cannot. Stopping is not an
///      optimisation — the draws after it are by construction at least as large, so none of them
///      could be served either. See `_tiebreak` for why reveal order is the wrong rule.
///
///      THE CARRY. Current the bus does not deliver is not refunded and not swept: it returns to
///      {carryPool} and is released back into later rounds. A round may draw on that pool only up
///      to the rake it pays, which is what stops a sybil from simply taking every seat and
///      pocketing it — see {releasableCarry} for the arithmetic. The pool is therefore a slow
///      rebate, not a jackpot, and that is a deliberate trade: a carry that pays out faster than
///      the rake is a carry that pays a sybil to come and take it.
///
///      THE EQUILIBRIUM, HONESTLY. Every seat is served when the revealed draws sum to at most
///      `BPS`, so this is an N-player Nash demand game: every profile summing to exactly `BPS` is
///      an equilibrium, and there are a great many of them, unequal ones included. Nothing here
///      selects between them. The seat count is public while commits are open, so the obvious
///      focal point is `BPS / seats` — and the last player to commit knows that number better than
///      the first. If you want a game with one clean equilibrium, this is not it; the interest is
///      in reading the table, and the table can read you back.
///
///      SETTLEMENT GAS. The sort is a bounded insertion sort over at most {MAX_SEATS} entries held
///      in memory, done inside the contract rather than trusted from calldata, so no caller can
///      settle a round in an order of their choosing. That bound is why {MAX_SEATS} is small.
///
///      LONE-SEAT ROUNDS. A round with fewer than {MIN_REVEALS} revealed draws does not discharge;
///      the whole capacity returns to the pool. This is a guard against an empty round paying
///      somebody, and NOTHING MORE — two addresses defeat it, so do not read it as protection of
///      the carry. The release cap in {releasableCarry} is what protects the carry.
contract ZapOverdraw {
    // --------------------------------------------------------------------- //
    // Immutable configuration                                                //
    // --------------------------------------------------------------------- //

    /// @notice The ERC-20 staked, paid and won. On Robinhood Chain this is 0xZAPS.
    address public immutable stake;

    /// @notice Where the rake is sent at settlement. Has no other power over this contract.
    address public immutable rakeRecipient;

    /// @notice Cost of one seat, in `stake` wei. Identical for every player in every round.
    uint256 public immutable entryFee;

    /// @notice Seconds the commit window stays open after a round opens.
    uint64 public immutable commitWindow;

    /// @notice Seconds the reveal window stays open after the commit window closes.
    uint64 public immutable revealWindow;

    /// @notice Rake, in bps of the round's fresh entry fees. Never charged on released carry.
    /// @dev Doubles as the carry pool's release rate — see {releasableCarry} — so it cannot be
    ///      zero without freezing the pool permanently.
    uint16 public immutable rakeBps;

    /// @notice Settlement reward, in bps of the round's fresh entry fees, credited to the caller.
    uint16 public immutable keeperBps;

    // --------------------------------------------------------------------- //
    // Constants                                                              //
    // --------------------------------------------------------------------- //

    /// @notice Basis-point denominator. A draw of `BPS` is a claim on the entire capacity.
    uint16 public constant BPS = 10_000;

    /// @notice Seats per round. Bounds the settlement sort; see the gas note above.
    uint256 public constant MAX_SEATS = 64;

    /// @notice Revealed draws a round needs before the bus discharges at all.
    uint256 public constant MIN_REVEALS = 2;

    /// @dev Ceilings on the two fee parameters, enforced in the constructor. They exist so that a
    ///      deployment cannot be configured into one where the table can never win.
    uint16 internal constant MAX_RAKE_BPS = 500; // 5%
    /// @dev A zero rake would make {releasableCarry} always zero, trapping the pool forever in a
    ///      contract with no admin and no rescue path. One bp is enough to keep the valve open.
    uint16 internal constant MIN_RAKE_BPS = 1;
    uint16 internal constant MAX_KEEPER_BPS = 100; // 1%

    /// @dev Floors on the two windows. A window short enough that honest players cannot reveal in
    ///      time turns the forfeit rule into a confiscation rule.
    uint64 internal constant MIN_WINDOW = 5 minutes;
    uint64 internal constant MAX_WINDOW = 7 days;

    // --------------------------------------------------------------------- //
    // Types                                                                  //
    // --------------------------------------------------------------------- //

    struct Round {
        /// @dev Last timestamp at which a commit is accepted.
        uint64 commitEnd;
        /// @dev Last timestamp at which a reveal is accepted.
        uint64 revealEnd;
        /// @dev Seats taken. Also the entry-fee multiplier for this round's fresh money.
        uint32 seats;
        /// @dev Commitments opened during the reveal window.
        uint32 reveals;
        /// @dev True once `settle` has run. A round settles exactly once.
        bool settled;
    }

    struct Seat {
        /// @dev The sealed commitment. Non-zero iff this address holds a seat in the round.
        bytes32 blob;
        /// @dev The opened draw in bps, in [1, BPS]. Zero means "not revealed".
        uint16 draw;
        /// @dev 1-based position in reveal order. Records THAT a seat opened, and in what
        ///      sequence; deliberately NOT the tiebreak any more — see `_tiebreak`.
        uint32 revealSeq;
    }

    // --------------------------------------------------------------------- //
    // Storage                                                                //
    // --------------------------------------------------------------------- //

    /// @notice The round currently accepting commits or reveals. Starts at 1.
    uint256 public currentRound;

    /// @notice Per-round header.
    mapping(uint256 => Round) public rounds;

    /// @notice Per-round, per-player seat.
    mapping(uint256 => mapping(address => Seat)) public seatOf;

    /// @dev Players who revealed, in reveal order. Index `i` has `revealSeq == i + 1`.
    mapping(uint256 => address[]) internal _revealedPlayers;

    /// @notice Winnings and keeper rewards, withdrawable with `claim`. Credited, never pushed.
    mapping(address => uint256) public credit;

    /// @notice Capacity past rounds did not deliver, waiting to be released into future ones.
    /// @dev Held as its own pool rather than pushed into the next round's opening pot, because
    ///      the amount a round may draw from it is capped at settlement — see {releasableCarry}.
    uint256 public carryPool;

    /// @dev Reentrancy latch. 0 = idle, 1 = entered.
    uint256 private _entered;

    /// @dev Guards every function that moves the stake token, matching `ZapVault`'s shape.
    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    // --------------------------------------------------------------------- //
    // Events                                                                 //
    // --------------------------------------------------------------------- //

    event RoundOpened(uint256 indexed roundId, uint64 commitEnd, uint64 revealEnd, uint256 carryPool);
    event Committed(uint256 indexed roundId, address indexed player, bytes32 blob, uint32 seats);
    event Revealed(uint256 indexed roundId, address indexed player, uint16 draw, uint32 revealSeq);
    event Served(uint256 indexed roundId, address indexed player, uint16 draw, uint256 amount);
    event Cut(uint256 indexed roundId, address indexed player, uint16 draw);
    event Settled(
        uint256 indexed roundId,
        address indexed keeper,
        uint256 capacity,
        uint256 served,
        uint256 carriedOut,
        uint256 rake
    );
    event Claimed(address indexed player, uint256 amount);

    // --------------------------------------------------------------------- //
    // Errors                                                                 //
    // --------------------------------------------------------------------- //

    error ZeroAddress();
    error ZeroEntryFee();
    error RakeTooHigh();
    error RakeTooLow();
    error KeeperTooHigh();
    error WindowOutOfRange();
    error CommitWindowClosed();
    error SeatTaken();
    error RoundFull();
    error EmptyCommitment();
    error NotRevealWindow();
    error NoSeat();
    error AlreadyRevealed();
    error DrawOutOfRange();
    error BadReveal();
    error RevealWindowOpen();
    error AlreadySettled();
    error NothingToClaim();
    error TransferFailed();
    error InexactTransfer();
    error Reentrancy();

    // --------------------------------------------------------------------- //
    // Construction                                                           //
    // --------------------------------------------------------------------- //

    /// @param stake_ ERC-20 staked and won. Must not be fee-on-transfer or rebasing.
    /// @param rakeRecipient_ Where the rake lands. Immutable; choose it once, correctly.
    /// @param entryFee_ Cost of a seat in `stake_` wei. This is the entire anti-sybil budget.
    /// @param commitWindow_ Seconds the commit window stays open.
    /// @param revealWindow_ Seconds the reveal window stays open after commits close.
    /// @param rakeBps_ Rake in bps of fresh entry fees, in [{MIN_RAKE_BPS}, {MAX_RAKE_BPS}]. Also
    ///        the rate at which the carry pool is allowed to drain.
    /// @param keeperBps_ Settlement reward in bps of fresh entry fees, at most {MAX_KEEPER_BPS}.
    constructor(
        address stake_,
        address rakeRecipient_,
        uint256 entryFee_,
        uint64 commitWindow_,
        uint64 revealWindow_,
        uint16 rakeBps_,
        uint16 keeperBps_
    ) {
        if (stake_ == address(0) || rakeRecipient_ == address(0)) revert ZeroAddress();
        if (entryFee_ == 0) revert ZeroEntryFee();
        if (rakeBps_ > MAX_RAKE_BPS) revert RakeTooHigh();
        if (rakeBps_ < MIN_RAKE_BPS) revert RakeTooLow();
        if (keeperBps_ > MAX_KEEPER_BPS) revert KeeperTooHigh();
        if (commitWindow_ < MIN_WINDOW || commitWindow_ > MAX_WINDOW) revert WindowOutOfRange();
        if (revealWindow_ < MIN_WINDOW || revealWindow_ > MAX_WINDOW) revert WindowOutOfRange();

        stake = stake_;
        rakeRecipient = rakeRecipient_;
        entryFee = entryFee_;
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
        rakeBps = rakeBps_;
        keeperBps = keeperBps_;

        currentRound = 1;
        _openRound(1);
    }

    // --------------------------------------------------------------------- //
    // Playing                                                                //
    // --------------------------------------------------------------------- //

    /// @notice Take a seat in the current round by paying the entry and sealing a draw.
    /// @param blob `commitmentFor(roundId, player, draw, salt)`. Bound to this contract, this
    ///        chain, this round and this player, so it can be neither replayed into another round
    ///        nor copied from another player's transaction.
    /// @dev The entry is pulled with `transferFrom` and the received amount is measured: a token
    ///      that delivers less than it was asked for reverts here rather than silently shorting the
    ///      pot. Approve at least `entryFee` to this contract first.
    function commit(bytes32 blob) external nonReentrant {
        uint256 roundId = currentRound;
        Round storage round = rounds[roundId];

        if (block.timestamp > round.commitEnd) revert CommitWindowClosed();
        if (round.seats >= MAX_SEATS) revert RoundFull();
        if (seatOf[roundId][msg.sender].blob != bytes32(0)) revert SeatTaken();
        // A zero commitment is the sentinel for "no seat", so it can never be a real one.
        if (blob == bytes32(0)) revert EmptyCommitment();

        seatOf[roundId][msg.sender].blob = blob;
        unchecked {
            round.seats += 1;
        }

        _pullExact(msg.sender, entryFee);

        emit Committed(roundId, msg.sender, blob, round.seats);
    }

    /// @notice Open your commitment. A seat never opened forfeits its entry to the pot.
    /// @param draw How much of the capacity you claim, in bps, in [1, {BPS}].
    /// @param salt The secret that made your commitment unguessable. Reuse of a salt across rounds
    ///        is safe here (the round id is inside the hash) but is still a bad habit.
    function reveal(uint16 draw, bytes32 salt) external {
        uint256 roundId = currentRound;
        Round storage round = rounds[roundId];

        if (block.timestamp <= round.commitEnd || block.timestamp > round.revealEnd) revert NotRevealWindow();
        if (draw == 0 || draw > BPS) revert DrawOutOfRange();

        Seat storage seat = seatOf[roundId][msg.sender];
        if (seat.blob == bytes32(0)) revert NoSeat();
        if (seat.revealSeq != 0) revert AlreadyRevealed();
        if (seat.blob != commitmentFor(roundId, msg.sender, draw, salt)) revert BadReveal();

        _revealedPlayers[roundId].push(msg.sender);
        uint32 seq = uint32(_revealedPlayers[roundId].length);
        seat.draw = draw;
        seat.revealSeq = seq;
        round.reveals = seq;

        emit Revealed(roundId, msg.sender, draw, seq);
    }

    /// @notice Discharge the bus, credit the winners, open the next round.
    /// @dev Permissionless and unbounded in time: the game cannot be held hostage by the players
    ///      who lost. The caller is credited `keeperBps` of the round's fresh entry fees for the
    ///      gas. Sorting happens here, in memory, from storage this contract wrote — never from
    ///      caller-supplied ordering.
    function settle() external nonReentrant {
        uint256 roundId = currentRound;
        Round storage round = rounds[roundId];

        if (block.timestamp <= round.revealEnd) revert RevealWindowOpen();
        if (round.settled) revert AlreadySettled();

        round.settled = true;

        uint256 fees = uint256(round.seats) * entryFee;
        uint256 rake = (fees * rakeBps) / BPS;
        uint256 keeperReward = (fees * keeperBps) / BPS;

        // THE CAP THAT MAKES A TABLE SWEEP UNPROFITABLE. See {releasableCarry}.
        uint256 released = _releasable(rake);
        uint256 capacity = fees - rake - keeperReward + released;

        uint256 served = _discharge(roundId, capacity);
        uint256 undelivered = capacity - served;

        // Whatever the bus did not deliver returns to the pool, along with the part of the
        // release this round was not entitled to draw on.
        carryPool = carryPool - released + undelivered;

        if (keeperReward != 0) credit[msg.sender] += keeperReward;

        uint256 next = roundId + 1;
        currentRound = next;
        _openRound(next);

        if (rake != 0) _push(rakeRecipient, rake);

        emit Settled(roundId, msg.sender, capacity, served, undelivered, rake);
    }

    /// @notice How much of {carryPool} a round paying `rake` in rake may draw on.
    ///
    /// @dev THIS IS THE MECHANISM'S ANTI-SWEEP DEFENCE, and it is the reason the carry is a pool
    ///      rather than a balance handed straight to the next round.
    ///
    ///      Consider an attacker who occupies EVERY seat in a round. They know all the draws
    ///      because they chose all of them, so they set them to sum to `BPS`, every seat is
    ///      served, and they take the whole capacity. They also call `settle`, so the keeper
    ///      reward comes back to them too. For `s` seats:
    ///
    ///          cost      = s * entryFee                        = fees
    ///          captured  = capacity + keeperReward
    ///                    = (fees - rake - keeper + released) + keeper
    ///          profit    = captured - cost = released - rake
    ///
    ///      So the sweep is profitable EXACTLY when the carry it unlocks exceeds the rake it
    ///      pays — and nothing else about the attack matters: not the seat count, not the entry
    ///      fee, not {MIN_REVEALS}, which two addresses satisfy. Capping `released` at `rake`
    ///      makes `profit <= 0` for every `s`, so sweeping the table is never better than
    ///      break-even, whatever the pool has grown to.
    ///
    ///      The honest cost of this defence: the carry drains no faster than the rake, so it is
    ///      a slow rebate rather than a jackpot. A pot that pays out faster than that is a pot
    ///      that pays a sybil to take it. Note also that `rakeBps == 0` would freeze the pool
    ///      forever, which is why the constructor refuses it.
    function releasableCarry() external view returns (uint256) {
        Round storage round = rounds[currentRound];
        uint256 fees = uint256(round.seats) * entryFee;
        return _releasable((fees * rakeBps) / BPS);
    }

    /// @notice Withdraw everything credited to you — winnings and keeper rewards alike.
    /// @dev Pull, never push. A settlement must not be blockable by one player's token callback or
    ///      by a winner whose address cannot receive the stake token.
    function claim() external nonReentrant returns (uint256 amount) {
        amount = credit[msg.sender];
        if (amount == 0) revert NothingToClaim();
        credit[msg.sender] = 0;
        _push(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // --------------------------------------------------------------------- //
    // Views                                                                  //
    // --------------------------------------------------------------------- //

    /// @notice The commitment a player must submit to seal `draw` under `salt`.
    /// @dev Callers should compute this locally and keep `salt` secret until reveal. Computing it
    ///      by calling this function through a public RPC leaks the draw to that RPC.
    function commitmentFor(uint256 roundId, address player, uint16 draw, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, roundId, player, draw, salt));
    }

    /// @notice Players who have revealed in `roundId`, in reveal order.
    function revealedPlayers(uint256 roundId) external view returns (address[] memory) {
        return _revealedPlayers[roundId];
    }

    /// @notice Draws revealed in `roundId`, in reveal order, aligned with {revealedPlayers}.
    function revealedDraws(uint256 roundId) external view returns (uint16[] memory draws) {
        address[] storage players = _revealedPlayers[roundId];
        draws = new uint16[](players.length);
        for (uint256 i = 0; i < players.length; ++i) {
            draws[i] = seatOf[roundId][players[i]].draw;
        }
    }

    /// @notice What the current round would discharge if it settled with the reveals it has now.
    /// @dev A planning aid for the interface, not a promise: every later reveal changes it. Returns
    ///      zeroes for a round that has already settled.
    function previewCapacity() external view returns (uint256 capacity, uint256 fees) {
        Round storage round = rounds[currentRound];
        if (round.settled) return (0, 0);
        fees = uint256(round.seats) * entryFee;
        uint256 rake = (fees * rakeBps) / BPS;
        uint256 keeperReward = (fees * keeperBps) / BPS;
        capacity = fees - rake - keeperReward + _releasable(rake);
    }

    /// @notice Which window the current round is in: 0 commit, 1 reveal, 2 awaiting settlement.
    function phase() external view returns (uint8) {
        Round storage round = rounds[currentRound];
        if (block.timestamp <= round.commitEnd) return 0;
        if (block.timestamp <= round.revealEnd) return 1;
        return 2;
    }

    // --------------------------------------------------------------------- //
    // Internals                                                              //
    // --------------------------------------------------------------------- //

    /// @dev Walks the sorted draws and credits each while the current lasts. Returns the total
    ///      credited, so the caller can carry the undelivered remainder.
    function _discharge(uint256 roundId, uint256 capacity) internal returns (uint256 served) {
        address[] storage players = _revealedPlayers[roundId];
        uint256 n = players.length;
        if (n < MIN_REVEALS || capacity == 0) return 0;

        uint256[] memory keys = _sortedKeys(roundId, players, n);

        uint256 remaining = capacity;
        for (uint256 i = 0; i < n; ++i) {
            uint16 draw = uint16(keys[i] >> 240);
            address player = players[uint64(keys[i])];
            uint256 want = (capacity * draw) / BPS;

            // A draw too small to round up to one wei of the stake token is served for nothing
            // rather than treated as unservable: it must not stop the walk for the players behind
            // it, whose larger draws may still be perfectly payable.
            if (want == 0) {
                emit Served(roundId, player, draw, 0);
                continue;
            }

            if (want > remaining) {
                // Draws are non-decreasing from here, so nobody left in the queue can be served.
                for (uint256 j = i; j < n; ++j) {
                    emit Cut(roundId, players[uint64(keys[j])], uint16(keys[j] >> 240));
                }
                break;
            }

            remaining -= want;
            credit[player] += want;
            emit Served(roundId, player, draw, want);
        }

        served = capacity - remaining;
    }

    /// @dev The tiebreak between equal draws.
    ///
    ///      Emphatically NOT reveal order. Draws are 14 bits of usable range and players cluster on
    ///      round numbers, so ties are the common case, not the edge case — and a reveal-order
    ///      tiebreak turns every one of them into a race to land a transaction first. That is a
    ///      latency auction a bot wins against a human every time, and on a chain with one
    ///      sequencer it is worse than that: whoever orders the block decides who is served, by
    ///      permuting reveals that are already in the mempool. The outcome of a sealed-bid game
    ///      must not be a block producer's to choose.
    ///
    ///      Hashing (round, player) instead makes the order fixed before the round opens,
    ///      unraceable, and unaffected by any reordering. It is public — anyone can compute anyone
    ///      else's position — which is fine: knowing the tiebreak does not help you win one.
    ///
    ///      RESIDUAL, STATED PLAINLY: a player holding many addresses can pick whichever has the
    ///      best position this round, and the round id is known before commits open, so the
    ///      grinding is possible. It costs one entry fee per address, which is the same sybil
    ///      budget every other part of this contract already runs on, and unlike a latency race it
    ///      cannot be won with faster hardware alone.
    function _tiebreak(uint256 roundId, address player) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(roundId, player))) >> 80;
    }

    /// @dev Packs each revealed seat as `draw << 240 | tiebreak << 64 | index` and insertion-sorts
    ///      ascending: draw first, then the fixed tiebreak, then the index. The index occupies the
    ///      low bits purely to make every key distinct, so the sort is a total order even if two
    ///      tiebreaks collide. Insertion sort over at most {MAX_SEATS} memory words; see the
    ///      settlement-gas note.
    function _sortedKeys(uint256 roundId, address[] storage players, uint256 n)
        internal
        view
        returns (uint256[] memory keys)
    {
        keys = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            keys[i] = (uint256(seatOf[roundId][players[i]].draw) << 240) | (_tiebreak(roundId, players[i]) << 64) | i;
        }
        for (uint256 i = 1; i < n; ++i) {
            uint256 key = keys[i];
            uint256 j = i;
            while (j != 0 && keys[j - 1] > key) {
                keys[j] = keys[j - 1];
                --j;
            }
            keys[j] = key;
        }
    }

    function _releasable(uint256 rake) internal view returns (uint256) {
        uint256 pool = carryPool;
        return pool < rake ? pool : rake;
    }

    function _openRound(uint256 roundId) internal {
        uint64 commitEnd = uint64(block.timestamp) + commitWindow;
        uint64 revealEnd = commitEnd + revealWindow;
        Round storage round = rounds[roundId];
        round.commitEnd = commitEnd;
        round.revealEnd = revealEnd;
        emit RoundOpened(roundId, commitEnd, revealEnd, carryPool);
    }

    /// @dev Pulls exactly `amount` and proves it, so a fee-on-transfer token reverts instead of
    ///      quietly leaving the pot short of what every player was told it holds.
    function _pullExact(address from, uint256 amount) internal {
        uint256 before = IERC20(stake).balanceOf(address(this));
        _call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (IERC20(stake).balanceOf(address(this)) - before != amount) revert InexactTransfer();
    }

    function _push(address to, uint256 amount) internal {
        _call(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// @dev Treats a bare-`revert`, a `false` return and a non-empty non-`true` return all as
    ///      failure, while accepting the empty return of a non-compliant-but-common ERC-20.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = stake.call(data);
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && !abi.decode(ret, (bool))) revert TransferFailed();
    }
}
