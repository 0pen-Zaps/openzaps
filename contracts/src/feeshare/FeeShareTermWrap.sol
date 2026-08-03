// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";

/// @notice The minimal surface of the tokenized fee-share vault this wrapper
///         holds: an ERC-20 whose holders accrue a reward asset, with a
///         permissionless pull that pays the accrued reward to the holder.
interface IFeeShareVault {
    function claimFor(address account) external;
    function claimable(address account, address rewardAsset) external view returns (uint256);
}

/// @title FeeShareTermWrap
/// @notice A term-bound coupon strip over tokenized fee shares. Depositors
///         lock fee shares before `DEPOSIT_UNTIL` and are minted transferable
///         wrapped units 1:1. Until `MATURITY`, anyone may harvest the vault
///         reward accrued to the locked shares; wrapped holders split it
///         pro-rata and may claim until `CLAIM_DEADLINE`. After maturity the
///         original depositors redeem exactly their deposited principal.
///         The term's cash flow trades (wrapped units are ERC-20); the
///         principal does not leave its depositor.
/// @dev The reward a locked share earns lives in TWO epochs with DIFFERENT
///      rightful owners, and the wrapper keeps them strictly apart:
///
///        Bucket 1 - IN-TERM (deposit..MATURITY): harvested and accrued to the
///        WRAPPED units (the coupon). Wrapped holders claim it until
///        CLAIM_DEADLINE; whatever they never claim is forfeit and, after the
///        deadline, swept back to depositors weighted by ORIGINAL principal
///        (every deposited share generated it in-term), via `sweepExpired`.
///
///        Bucket 2 - POST-MATURITY (MATURITY..redemption): generated ONLY by
///        the shares still locked in the wrapper (a redeemed share has left and
///        earns for its owner directly). It is therefore attributed to
///        CURRENTLY-LOCKED principal via a second cumulative accumulator that
///        redemption checkpoints and exits, and paid by `claimLockedReward`. An
///        exited depositor never captures a still-locked depositor's stream.
///
///      Accounting mirrors the live fee campaign: cumulative reward per unit at
///      1e18 scale, checkpointed on every mint, burn, and transfer. No owner,
///      no pause, no upgrade: every term is an immutable constructor parameter
///      and every state transition is permissionless to advance. This contract
///      never promises a rate: rewards are whatever the vault pays for the
///      shares it holds, which may be zero.
contract FeeShareTermWrap {
    // ---------------------------------------------------------------- errors
    error DepositWindowClosed();
    error ZeroAmount();
    error TermEnded();
    error TermNotEnded();
    error ClaimsClosed();
    error ClaimsStillOpen();
    error NothingToSweep();
    error TransferFailed();
    error InsufficientBalance();
    error InsufficientAllowance();

    // ---------------------------------------------------------------- events
    event Deposited(address indexed account, uint256 shares);
    event Harvested(address indexed caller, uint256 rewardReceived);
    event RewardClaimed(address indexed account, uint256 amount);
    event SharesRedeemed(address indexed account, uint256 shares);
    event LockedRewardClaimed(address indexed account, uint256 amount);
    event ExpiredSwept(address indexed account, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ------------------------------------------------------------ immutables
    /// @notice The fee-share token, which is also the vault that pays rewards.
    address public immutable FEE_SHARES;
    /// @notice The reward asset the vault pays (WETH on Robinhood Chain).
    address public immutable REWARD;
    /// @notice Deposits are accepted strictly before this timestamp.
    uint64 public immutable DEPOSIT_UNTIL;
    /// @notice Reward accrual to wrapped holders ends at this timestamp.
    uint64 public immutable MATURITY;
    /// @notice Wrapped holders may claim accrued reward until this timestamp.
    uint64 public immutable CLAIM_DEADLINE;

    // -------------------------------------------------------------- wrapped ERC-20
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ----------------------------------------------------------- accounting
    uint256 private constant ACC_SCALE = 1e18;

    // --- Bucket 1: in-term reward, accrued to WRAPPED units (the coupon) ----
    /// @notice Cumulative in-term reward per wrapped unit, 1e18 scale.
    uint256 public cumulativeRewardPerUnit;
    /// @notice In-term reward the wrapper has accounted but not yet paid out.
    ///         Coupon holders draw it down via `claim` until CLAIM_DEADLINE;
    ///         after the deadline it is frozen and becomes the sweep basis.
    uint256 public rewardReserve;
    mapping(address => uint256) private rewardDebt;
    mapping(address => uint256) private accrued;

    // -------------------------------------------------------------- principal
    /// @notice Principal each depositor may redeem after the term ends. Also
    ///         the CURRENTLY-LOCKED principal that earns Bucket-2 reward.
    mapping(address => uint256) public depositedShares;
    /// @notice Principal already redeemed, retained so redemption never forfeits
    ///         the depositor's ORIGINAL-principal slice of the Bucket-1 sweep.
    mapping(address => uint256) public redeemedShares;
    /// @notice Original total principal ever deposited (never decremented): the
    ///         Bucket-1 sweep denominator, since all of it generated in-term.
    uint256 public totalDeposited;
    /// @notice Currently-locked principal (sum of depositedShares): the Bucket-2
    ///         denominator, since only still-locked shares generate it.
    uint256 public totalLocked;

    // --- Bucket 1 sweep: forfeited in-term reward, by ORIGINAL principal -----
    /// @notice Total Bucket-1 reward paid out through `sweepExpired`. Lets the
    ///         frozen `rewardReserve` stay the fixed distribution basis while we
    ///         still know how much of it remains for the post-maturity split.
    uint256 public forfeitPaid;
    /// @notice Bucket-1 entitlement already taken per depositor.
    mapping(address => uint256) public sweptOf;

    // --- Bucket 2: post-maturity accrual, by CURRENTLY-LOCKED principal ------
    /// @notice Cumulative post-maturity reward per locked-principal unit, 1e18.
    uint256 public cumulativePostPerLocked;
    /// @notice Post-maturity reward accounted but not yet paid via claimLockedReward.
    uint256 public postReserve;
    mapping(address => uint256) private postDebt;
    /// @notice Realized post-maturity reward each depositor may claim.
    mapping(address => uint256) public postAccrued;

    constructor(
        address feeShares,
        address reward,
        uint64 depositUntil,
        uint64 maturity,
        uint64 claimDeadline,
        string memory name_,
        string memory symbol_
    ) {
        require(feeShares != address(0) && reward != address(0), ZeroAmount());
        require(depositUntil < maturity && maturity < claimDeadline, TermEnded());
        FEE_SHARES = feeShares;
        REWARD = reward;
        DEPOSIT_UNTIL = depositUntil;
        MATURITY = maturity;
        CLAIM_DEADLINE = claimDeadline;
        name = name_;
        symbol = symbol_;
    }

    // ------------------------------------------------------------- deposits

    /// @notice Lock `shares` fee shares and mint the same amount of wrapped
    ///         units to the caller. Only before the deposit window closes.
    function deposit(uint256 shares) external {
        require(block.timestamp < DEPOSIT_UNTIL, DepositWindowClosed());
        require(shares != 0, ZeroAmount());
        // Fold any reward already owed to the CURRENT holders before minting,
        // so a late depositor cannot dilute reward that accrued before them.
        _harvestAndSync();
        _checkpoint(msg.sender);
        // Bucket-2 accumulator is still zero here (it only advances after
        // maturity, and deposits close before maturity), so this just seeds a
        // zero post-debt; keeping it explicit guards the invariant.
        _checkpointPost(msg.sender);
        depositedShares[msg.sender] += shares;
        totalDeposited += shares;
        totalLocked += shares;
        totalSupply += shares;
        balanceOf[msg.sender] += shares;
        rewardDebt[msg.sender] = (balanceOf[msg.sender] * cumulativeRewardPerUnit) / ACC_SCALE;
        postDebt[msg.sender] = (depositedShares[msg.sender] * cumulativePostPerLocked) / ACC_SCALE;
        require(IERC20(FEE_SHARES).transferFrom(msg.sender, address(this), shares), TransferFailed());
        emit Transfer(address(0), msg.sender, shares);
        emit Deposited(msg.sender, shares);
    }

    // ---------------------------------------------------- in-term rewards (B1)

    /// @notice Pull the vault reward accrued to the locked shares and account
    ///         it to wrapped holders. Permissionless; only during the term.
    function harvest() external {
        require(block.timestamp <= MATURITY, TermEnded());
        _harvestAndSync();
    }

    /// @notice Claim the caller's accrued in-term reward. Open until the deadline.
    function claim() external {
        require(block.timestamp <= CLAIM_DEADLINE, ClaimsClosed());
        _checkpoint(msg.sender);
        uint256 amount = accrued[msg.sender];
        if (amount == 0) return;
        accrued[msg.sender] = 0;
        rewardReserve -= amount;
        require(IERC20(REWARD).transfer(msg.sender, amount), TransferFailed());
        emit RewardClaimed(msg.sender, amount);
    }

    /// @notice In-term reward currently claimable by `account`.
    function claimableReward(address account) external view returns (uint256) {
        uint256 pending = (balanceOf[account] * cumulativeRewardPerUnit) / ACC_SCALE - rewardDebt[account];
        return accrued[account] + pending;
    }

    // ------------------------------------------------------------ principal

    /// @notice Return the caller's deposited fee shares after the term ends.
    ///         Gated only on the clock, never on a reward transfer, so a paused
    ///         or underfunded vault can never trap principal. Before the shares
    ///         leave, the caller's post-maturity (Bucket-2) reward accrued while
    ///         they were locked is checkpointed into `postAccrued` (collect it
    ///         with `claimLockedReward`), and the shares are removed from the
    ///         Bucket-2 base so they no longer earn a stream they no longer
    ///         generate. Wrapped units are not required or burned: the units
    ///         carry the term's coupon, the principal record carries reversion.
    function redeemShares() external {
        require(block.timestamp > MATURITY, TermNotEnded());
        uint256 shares = depositedShares[msg.sender];
        require(shares != 0, ZeroAmount());
        // Advance and checkpoint Bucket 2 WHILE the caller is still locked, so
        // every bit their shares earned up to now is realized to them. The pull
        // inside _syncPost is guarded and the math cannot revert, so principal
        // return below stays unbrickable.
        _syncPost();
        _checkpointPost(msg.sender);
        totalLocked -= shares;
        depositedShares[msg.sender] = 0;
        postDebt[msg.sender] = 0;
        redeemedShares[msg.sender] = shares;
        require(IERC20(FEE_SHARES).transfer(msg.sender, shares), TransferFailed());
        emit SharesRedeemed(msg.sender, shares);
    }

    // -------------------------------------------------- post-maturity reward (B2)

    /// @notice Claim the caller's post-maturity reward: the vault reward the
    ///         wrapper earned on the caller's shares while they stayed locked
    ///         past maturity. Still-locked depositors accrue it continuously;
    ///         a redeemed depositor collects the frozen amount their shares
    ///         earned before they left. Open once the term has ended.
    function claimLockedReward() external {
        require(block.timestamp > MATURITY, TermNotEnded());
        _syncPost();
        _checkpointPost(msg.sender);
        uint256 amount = postAccrued[msg.sender];
        if (amount == 0) return;
        postAccrued[msg.sender] = 0;
        postReserve -= amount;
        require(IERC20(REWARD).transfer(msg.sender, amount), TransferFailed());
        emit LockedRewardClaimed(msg.sender, amount);
    }

    /// @notice Post-maturity reward currently claimable by `account` (as of the
    ///         last sync; a fresh sync on claim may realize a little more).
    function claimableLockedReward(address account) external view returns (uint256) {
        uint256 pending = (depositedShares[account] * cumulativePostPerLocked) / ACC_SCALE - postDebt[account];
        return postAccrued[account] + pending;
    }

    /// @notice After the claim deadline, a depositor pulls their ORIGINAL
    ///         principal's pro-rata slice of the in-term reward wrapped holders
    ///         never claimed. `rewardReserve` is frozen once claims close, so it
    ///         is a fixed basis; redeemed principal still counts, so redeeming
    ///         never forfeits this slice. Post-maturity accrual is NOT here — it
    ///         belongs to still-locked principal via `claimLockedReward`.
    function sweepExpired() external {
        require(block.timestamp > CLAIM_DEADLINE, ClaimsStillOpen());
        // Redeemed principal still counts: this reward was earned in-term while
        // that principal was locked, so redeeming never forfeits the slice.
        uint256 principal = depositedShares[msg.sender] + redeemedShares[msg.sender];
        require(principal != 0, NothingToSweep());
        uint256 entitled = (rewardReserve * principal) / totalDeposited;
        uint256 amount = entitled - sweptOf[msg.sender];
        require(amount != 0, NothingToSweep());
        sweptOf[msg.sender] = entitled;
        forfeitPaid += amount;
        require(IERC20(REWARD).transfer(msg.sender, amount), TransferFailed());
        emit ExpiredSwept(msg.sender, amount);
    }

    // ------------------------------------------------------------- internals

    /// @dev Pull the vault's owed reward WITHOUT letting the untrusted vault
    ///      revert the caller: BOTH the claimable() view and claimFor() are
    ///      guarded, so a paused/misconfigured/self-destructed vault degrades
    ///      to "no reward pulled" and can never brick harvest, redemption, or
    ///      the sweep. Balance-delta accounting downstream is the source of
    ///      truth, not the vault's own view.
    function _pullReward() private {
        try IFeeShareVault(FEE_SHARES).claimable(address(this), REWARD) returns (uint256 c) {
            if (c != 0) {
                try IFeeShareVault(FEE_SHARES).claimFor(address(this)) {} catch {}
            }
        } catch {}
    }

    /// @dev Bucket 1. Pull and account in-term reward to WRAPPED units. Only
    ///      reachable during the term (harvest, deposit, in-term transfer).
    function _harvestAndSync() private returns (uint256 received) {
        // The vault pays claimFor to this wrapper; sync accounts anything the
        // wrapper received, including reward sent to it directly. The claim is
        // DEFENSIVE: a paused or underfunded vault must never revert a caller,
        // so its failure degrades to "no new reward this call" rather than
        // bricking principal. Balance-delta accounting below can't revert.
        _pullReward();
        uint256 balance = IERC20(REWARD).balanceOf(address(this));
        // Everything not already earmarked to a bucket is new in-term reward.
        uint256 earmarked = _earmarked();
        received = balance > earmarked ? balance - earmarked : 0;
        if (received != 0 && totalSupply != 0) {
            cumulativeRewardPerUnit += (received * ACC_SCALE) / totalSupply;
            rewardReserve += received;
            emit Harvested(msg.sender, received);
        }
    }

    /// @dev Bucket 2. Pull and account post-maturity reward to CURRENTLY-LOCKED
    ///      principal. Only reachable after maturity (redeem, claimLockedReward).
    function _syncPost() private {
        _pullReward();
        uint256 balance = IERC20(REWARD).balanceOf(address(this));
        uint256 earmarked = _earmarked();
        uint256 received = balance > earmarked ? balance - earmarked : 0;
        if (received != 0 && totalLocked != 0) {
            cumulativePostPerLocked += (received * ACC_SCALE) / totalLocked;
            postReserve += received;
        }
    }

    /// @dev Reward tokens already spoken for: the unswept remainder of the
    ///      in-term reserve plus the unpaid post-maturity reserve. The wrapper's
    ///      balance beyond this is newly-arrived, unaccounted reward. forfeitPaid
    ///      never exceeds rewardReserve by construction (claims close before any
    ///      sweep, the sweep basis is the frozen rewardReserve, and entitlements
    ///      sum to it); the guard is defense-in-depth so a broken assumption can
    ///      never underflow this and brick redemption.
    function _earmarked() private view returns (uint256) {
        uint256 b1Remaining = rewardReserve > forfeitPaid ? rewardReserve - forfeitPaid : 0;
        return b1Remaining + postReserve;
    }

    function _checkpoint(address account) private {
        uint256 pending = (balanceOf[account] * cumulativeRewardPerUnit) / ACC_SCALE - rewardDebt[account];
        if (pending != 0) accrued[account] += pending;
        rewardDebt[account] = (balanceOf[account] * cumulativeRewardPerUnit) / ACC_SCALE;
    }

    function _checkpointPost(address account) private {
        uint256 pending = (depositedShares[account] * cumulativePostPerLocked) / ACC_SCALE - postDebt[account];
        if (pending != 0) postAccrued[account] += pending;
        postDebt[account] = (depositedShares[account] * cumulativePostPerLocked) / ACC_SCALE;
    }

    // -------------------------------------------------------------- ERC-20

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, InsufficientAllowance());
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), ZeroAmount());
        require(balanceOf[from] >= value, InsufficientBalance());
        // Fold reward accrued to these units BEFORE they move, so the seller
        // keeps everything earned while they held. Gated to the term, exactly
        // like harvest(): after MATURITY in-term accrual is frozen and the
        // wrapper's reward is Bucket 2 (reserved for still-locked PRINCIPAL, not
        // wrapped units), so pulling it here would misroute it. Past maturity
        // the checkpoints below still preserve each side's in-term accrual
        // (held in `accrued`). Wrapped transfers never touch Bucket 2, which is
        // keyed on principal, not on these units.
        if (block.timestamp <= MATURITY) _harvestAndSync();
        _checkpoint(from);
        _checkpoint(to);
        balanceOf[from] -= value;
        balanceOf[to] += value;
        rewardDebt[from] = (balanceOf[from] * cumulativeRewardPerUnit) / ACC_SCALE;
        rewardDebt[to] = (balanceOf[to] * cumulativeRewardPerUnit) / ACC_SCALE;
        emit Transfer(from, to, value);
    }
}
