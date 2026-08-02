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
/// @dev Accounting mirrors the live fee campaign: cumulative reward per unit
///      at 1e18 scale, checkpointed on every mint, burn, and transfer. No
///      owner, no pause, no upgrade: every term is an immutable constructor
///      parameter and every state transition is permissionless to advance.
///      This contract never promises a rate: rewards are whatever the vault
///      pays for the shares it holds, which may be zero.
contract FeeShareTermWrap {
    // ---------------------------------------------------------------- errors
    error DepositWindowClosed();
    error DepositWindowOpen();
    error ZeroAmount();
    error TermEnded();
    error TermNotEnded();
    error NotFinalized();
    error AlreadyFinalized();
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
    event Finalized(uint256 finalRewardReceived);
    event SharesRedeemed(address indexed account, uint256 shares);
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
    /// @notice Cumulative reward per wrapped unit, 1e18 scale.
    uint256 public cumulativeRewardPerUnit;
    /// @notice Reward balance the wrapper has accounted but not yet paid out.
    uint256 public rewardReserve;
    mapping(address => uint256) private rewardDebt;
    mapping(address => uint256) private accrued;

    /// @notice Principal each depositor may redeem after finalization.
    mapping(address => uint256) public depositedShares;
    /// @notice Principal already redeemed, retained so redemption never
    ///         forfeits the expired-reward sweep slice.
    mapping(address => uint256) public redeemedShares;
    uint256 public totalDeposited;

    bool public finalized;
    /// @notice Unclaimed reward snapshotted when the first sweep executes.
    uint256 public sweepSnapshot;
    uint256 public sweptPrincipal;
    mapping(address => bool) public sweepTaken;

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
        depositedShares[msg.sender] += shares;
        totalDeposited += shares;
        totalSupply += shares;
        balanceOf[msg.sender] += shares;
        rewardDebt[msg.sender] = (balanceOf[msg.sender] * cumulativeRewardPerUnit) / ACC_SCALE;
        require(IERC20(FEE_SHARES).transferFrom(msg.sender, address(this), shares), TransferFailed());
        emit Transfer(address(0), msg.sender, shares);
        emit Deposited(msg.sender, shares);
    }

    // -------------------------------------------------------------- rewards

    /// @notice Pull the vault reward accrued to the locked shares and account
    ///         it to wrapped holders. Permissionless; only during the term.
    function harvest() external {
        require(block.timestamp <= MATURITY, TermEnded());
        _harvestAndSync();
    }

    /// @notice One final permissionless harvest after maturity. Credits the
    ///         last in-term accrual to wrapped holders and opens principal
    ///         redemption. Callable exactly once.
    /// @dev The redemption gate flips FIRST and the harvest is defensive
    ///      (_harvestAndSync try/catches the vault claim), so a paused or
    ///      underfunded vault can never trap principal by reverting finalize.
    function finalize() external {
        require(block.timestamp > MATURITY, TermNotEnded());
        require(!finalized, AlreadyFinalized());
        finalized = true;
        uint256 received = _harvestAndSync();
        emit Finalized(received);
    }

    /// @notice Claim the caller's accrued reward. Open until the deadline.
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

    /// @notice Reward currently claimable by `account`.
    function claimableReward(address account) external view returns (uint256) {
        uint256 pending = (balanceOf[account] * cumulativeRewardPerUnit) / ACC_SCALE - rewardDebt[account];
        return accrued[account] + pending;
    }

    // ------------------------------------------------------------ principal

    /// @notice Return the caller's deposited fee shares after finalization.
    ///         Wrapped units are not required or burned: the units carry the
    ///         term's reward claim, the principal record carries reversion.
    function redeemShares() external {
        require(finalized, NotFinalized());
        uint256 shares = depositedShares[msg.sender];
        require(shares != 0, ZeroAmount());
        depositedShares[msg.sender] = 0;
        redeemedShares[msg.sender] = shares;
        require(IERC20(FEE_SHARES).transfer(msg.sender, shares), TransferFailed());
        emit SharesRedeemed(msg.sender, shares);
    }

    /// @notice After the claim deadline, a depositor pulls their principal's
    ///         pro-rata slice of whatever reward was never claimed. The pool
    ///         is snapshotted on the first sweep so late sweeps cannot dilute
    ///         earlier ones.
    function sweepExpired() external {
        require(block.timestamp > CLAIM_DEADLINE, ClaimsStillOpen());
        uint256 principal = depositedShares[msg.sender] + _redeemedPrincipal(msg.sender);
        require(principal != 0 && !sweepTaken[msg.sender], NothingToSweep());
        if (sweepSnapshot == 0) {
            // The wrapper kept holding the locked shares until each depositor
            // redeemed, so the vault kept paying reward to them after MATURITY.
            // Claims are closed now, so the whole REAL balance — not just the
            // in-term rewardReserve — belongs to the depositors; snapshotting
            // rewardReserve alone would strand that post-finalize accrual.
            if (IFeeShareVault(FEE_SHARES).claimable(address(this), REWARD) != 0) {
                try IFeeShareVault(FEE_SHARES).claimFor(address(this)) {} catch {}
            }
            rewardReserve = IERC20(REWARD).balanceOf(address(this));
            require(rewardReserve != 0, NothingToSweep());
            sweepSnapshot = rewardReserve;
        }
        sweepTaken[msg.sender] = true;
        uint256 amount = (sweepSnapshot * principal) / totalDeposited;
        require(amount != 0, NothingToSweep());
        sweptPrincipal += principal;
        rewardReserve -= amount;
        require(IERC20(REWARD).transfer(msg.sender, amount), TransferFailed());
        emit ExpiredSwept(msg.sender, amount);
    }

    // ------------------------------------------------------------- internals

    function _harvestAndSync() private returns (uint256 received) {
        // The vault pays claimFor to this wrapper; sync accounts anything the
        // wrapper received, including reward sent to it directly. The claim is
        // DEFENSIVE: a paused or underfunded vault must never revert a caller
        // that also advances a redemption/settlement gate (finalize), so its
        // failure degrades to "no new reward this call" rather than bricking
        // principal. Balance-delta accounting below can't revert.
        if (IFeeShareVault(FEE_SHARES).claimable(address(this), REWARD) != 0) {
            try IFeeShareVault(FEE_SHARES).claimFor(address(this)) {} catch {}
        }
        uint256 balance = IERC20(REWARD).balanceOf(address(this));
        received = balance - rewardReserve;
        if (received != 0 && totalSupply != 0) {
            cumulativeRewardPerUnit += (received * ACC_SCALE) / totalSupply;
            rewardReserve = balance;
            emit Harvested(msg.sender, received);
        }
    }

    function _checkpoint(address account) private {
        uint256 pending = (balanceOf[account] * cumulativeRewardPerUnit) / ACC_SCALE - rewardDebt[account];
        if (pending != 0) accrued[account] += pending;
        rewardDebt[account] = (balanceOf[account] * cumulativeRewardPerUnit) / ACC_SCALE;
    }

    /// @dev Principal already redeemed still counts for the expired sweep:
    ///      redeeming early must never silently forfeit the sweep slice.
    function _redeemedPrincipal(address account) private view returns (uint256) {
        return redeemedShares[account];
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
        _checkpoint(from);
        _checkpoint(to);
        balanceOf[from] -= value;
        balanceOf[to] += value;
        rewardDebt[from] = (balanceOf[from] * cumulativeRewardPerUnit) / ACC_SCALE;
        rewardDebt[to] = (balanceOf[to] * cumulativeRewardPerUnit) / ACC_SCALE;
        emit Transfer(from, to, value);
    }
}
