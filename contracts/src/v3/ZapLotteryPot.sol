// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @title ZapLotteryPot
/// @notice The protocol lottery pot behind the v3 executor economy. Every recurring/triggered
///         execution pays a 1% protocol fee; 80% goes to the executor that submitted it and 20%
///         arrives here. Anything that arrives here is converted into 0xZAPS (via ONE pinned,
///         bounded swap adapter) and can only ever leave as a lottery prize to an address that
///         actually generated fees — there is NO owner drain, NO arbitrary transfer, and NO way to
///         redirect the pot (fail-closed by construction).
///
///         Gamification model: each fee contribution credits raw-wei tickets to the zap OWNER whose
///         execution paid the fee, bucketed into the current round. `ContributionRecorded` events
///         carry (round, player, asset, amount) so any future weighting/draw scheme can be computed
///         exactly from the log — the on-chain `tickets` counter is a coarse participation gate,
///         deliberately NOT the final fairness mechanism.
/// @dev Winner SELECTION is an explicitly deferred product decision (see v3 README). Until a
///      randomness/draw ADR lands, `awardRound` is owner-gated (protocol governance) and hard-bound
///      to two invariants that no owner action can bypass: the payout asset is 0xZAPS only, and the
///      winner MUST hold tickets in the round being paid. Ownership uses the same two-step handoff
///      as `AdapterRegistry`.
contract ZapLotteryPot {
    using SafeApprove for address;

    address public owner;
    address public pendingOwner;

    /// @notice The prize asset. The pot can accumulate arbitrary allowlisted fee assets, but value
    ///         only leaves as 0xZAPS.
    address public immutable ZAPS;
    /// @notice The single bounded adapter (same `IAdapter` surface as zap steps) used to convert
    ///         accumulated fee assets into 0xZAPS. Pinned at deployment — no routing discretion.
    address public immutable BUY_ADAPTER;

    /// @notice The one factory whose clones may record contributions. Set exactly once.
    address public factory;
    mapping(address => bool) public isZap;

    uint256 public currentRound = 1;
    /// @dev Coarse per-round participation counter: raw contributed wei summed across fee assets.
    ///      Weighting across assets is part of the deferred draw design; use the event log for that.
    mapping(uint256 => mapping(address => uint256)) public tickets;
    mapping(uint256 => uint256) public totalTickets;
    /// @dev 0xZAPS accrued to the CURRENT round's prize: direct 0xZAPS contributions plus
    ///      `buyZaps` conversions.
    mapping(uint256 => uint256) public roundPrize;

    uint256 private _entered;

    event FactorySet(address indexed factory);
    event ZapRegistered(address indexed zap);
    event ContributionRecorded(
        uint256 indexed round, address indexed player, address indexed asset, uint256 amount, address zap
    );
    event ZapsBought(uint256 indexed round, address indexed caller, address assetIn, uint256 amountIn, uint256 zapsOut);
    event RoundAwarded(uint256 indexed round, address indexed winner, uint256 prize);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error NotFactory();
    error NotZap();
    error ZeroAddress();
    error FactoryAlreadySet();
    error ZeroAmount();
    error NothingToConvert();
    error CannotConvertPrizeAsset();
    error WrongAdapterOutput(address tokenOut);
    error MinZapsNotMet(uint256 got, uint256 want);
    error EmptyPrize();
    error WinnerHasNoTickets(uint256 round, address winner);
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address owner_, address zaps_, address buyAdapter_) {
        if (owner_ == address(0) || zaps_ == address(0) || buyAdapter_ == address(0)) revert ZeroAddress();
        owner = owner_;
        ZAPS = zaps_;
        BUY_ADAPTER = buyAdapter_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // --------------------------------------------------------------------- //
    // Wiring (owner sets factory once; factory registers clones)             //
    // --------------------------------------------------------------------- //

    /// @notice Bind the ONE factory whose clones may record contributions. Irreversible.
    function setFactory(address factory_) external onlyOwner {
        if (factory_ == address(0)) revert ZeroAddress();
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function registerZap(address zap) external {
        if (msg.sender != factory || factory == address(0)) revert NotFactory();
        isZap[zap] = true;
        emit ZapRegistered(zap);
    }

    // --------------------------------------------------------------------- //
    // Contributions (called by v3 zaps at settlement)                        //
    // --------------------------------------------------------------------- //

    /// @notice Record a fee contribution. The zap has ALREADY transferred `amount` of `asset` here;
    ///         this call only credits tickets — it never moves funds, so a lying caller cannot pull
    ///         value, only inflate its own counter, which is why callers are factory-registered.
    function notifyContribution(address player, address asset, uint256 amount) external {
        if (!isZap[msg.sender]) revert NotZap();
        if (amount == 0) revert ZeroAmount();
        uint256 round = currentRound;
        tickets[round][player] += amount;
        totalTickets[round] += amount;
        if (asset == ZAPS) roundPrize[round] += amount; // already the prize asset — no conversion leg
        emit ContributionRecorded(round, player, asset, amount, msg.sender);
    }

    // --------------------------------------------------------------------- //
    // Conversion (permissionless: anyone may push fee assets into the prize) //
    // --------------------------------------------------------------------- //

    /// @notice Convert `amountIn` of an accumulated fee asset into 0xZAPS through the pinned
    ///         adapter. Permissionless — the executor daemon calls this on a cadence, but anyone
    ///         may. Output is measured by balance delta (the adapter's return values are not
    ///         trusted for accounting) and credited to the current round's prize.
    function buyZaps(address assetIn, uint256 amountIn, uint256 minZapsOut) external nonReentrant returns (uint256) {
        if (assetIn == ZAPS) revert CannotConvertPrizeAsset();
        if (amountIn == 0) revert ZeroAmount();
        uint256 have = IERC20(assetIn).balanceOf(address(this));
        if (have < amountIn) revert NothingToConvert();

        uint256 preZaps = IERC20(ZAPS).balanceOf(address(this));
        assetIn.approveExact(BUY_ADAPTER, amountIn);
        (address tokenOut,) = IAdapter(BUY_ADAPTER).execute(assetIn, amountIn, "");
        assetIn.approveExact(BUY_ADAPTER, 0);
        if (tokenOut != ZAPS) revert WrongAdapterOutput(tokenOut);

        uint256 zapsOut = IERC20(ZAPS).balanceOf(address(this)) - preZaps; // underflow-reverts on loss
        if (zapsOut < minZapsOut || zapsOut == 0) revert MinZapsNotMet(zapsOut, minZapsOut);

        uint256 round = currentRound;
        roundPrize[round] += zapsOut;
        emit ZapsBought(round, msg.sender, assetIn, amountIn, zapsOut);
        return zapsOut;
    }

    // --------------------------------------------------------------------- //
    // Awarding (winner-selection mechanism deferred; payout bounds are not)  //
    // --------------------------------------------------------------------- //

    /// @notice Pay the current round's accrued 0xZAPS prize to `winner` and open the next round.
    /// @dev HOW the winner is chosen (VRF, commit-reveal, ticket-weighted draw…) is a deferred
    ///      product decision — until that ADR lands this is governance-gated. WHAT can be paid is
    ///      not deferred: only 0xZAPS, only the round's accrued prize, and only to an address with
    ///      tickets in that round. A round with no prize or no participants cannot be closed.
    function awardRound(address winner) external onlyOwner nonReentrant {
        if (winner == address(0)) revert ZeroAddress();
        uint256 round = currentRound;
        uint256 prize = roundPrize[round];
        if (prize == 0) revert EmptyPrize();
        if (tickets[round][winner] == 0) revert WinnerHasNoTickets(round, winner);

        roundPrize[round] = 0;
        currentRound = round + 1;
        ZAPS.safeTransfer(winner, prize);
        emit RoundAwarded(round, winner, prize);
    }

    // --------------------------------------------------------------------- //
    // Two-step ownership (mirrors AdapterRegistry)                           //
    // --------------------------------------------------------------------- //

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
