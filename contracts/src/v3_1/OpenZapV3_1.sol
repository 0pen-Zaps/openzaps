// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {AdapterRegistry} from "../AdapterRegistry.sol";
import {TokenAllowlist} from "../TokenAllowlist.sol";
import {Step, Policy, OpenZapIntent} from "../libraries/OpenZapTypes.sol";
import {RecurringIntent, TriggerIntent} from "../v3/libraries/OpenZapV3Types.sol";
import {RecurringRelativeIntent} from "./libraries/OpenZapV3_1Types.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {IPriceSource} from "../v3/interfaces/IPriceSource.sol";
import {IOrientedPriceSource} from "./interfaces/IOrientedPriceSource.sol";
import {V4PoolMath} from "../libraries/V4PoolMath.sol";

interface ILotteryPot {
    function notifyContribution(address player, address asset, uint256 amount) external;
}

/// @title OpenZapV3_1
/// @notice UNAUDITED v3.1 CANDIDATE. A strict SUPERSET of `OpenZapV3`: the one-shot, recurring, and
///         triggered paths are carried over byte-for-byte (same checks, same nonce/series semantics,
///         same 1% fee split 80/20 executor/pot, same isolation and recovery), and ONE new execution
///         type is added:
///
///         4. RECURRING-RELATIVE — `executeRecurringRelative(RecurringRelativeIntent, sig)`: identical
///            in every way to `executeRecurring` (cadence, nonce, authorization, executor pin, fee
///            split) EXCEPT the per-run output floor is not a single absolute number frozen at
///            signing. Instead the owner signs an allowlisted `priceSource` and a `maxSlippageBps`
///            band; every run reads the pool's CURRENT spot and derives a FRESH fair floor
///            `floor = expectedAtSpot * (10_000 - maxSlippageBps) / 10_000`, enforced NET of the fee.
///
///         WHY: a `RecurringIntent` freezes `minOutPerRun` at signing and applies it to every run
///         over hours or days. When the market drifts past the owner's slippage band the runs revert
///         `MinOutNotMet` even though each run is fair at the then-current price (this happened live:
///         a signed floor of 2,459,669 0xZAPS blocked runs once the pool moved to 2,447,321 because
///         0xZAPS appreciated). Pricing the floor off live spot on EVERY run keeps the owner's
///         slippage protection intact while tracking the market.
/// @dev SECURITY TRADEOFF vs the absolute floor: a spot pool price is manipulable within a block, so
///      an adversary who moves the pool right before a run can shift the reference the floor is built
///      on. This is bounded — exactly as the trigger path is — by the fact that arming only unlocks
///      the policy the OWNER already signed (fixed route, fixed amounts, fixed recipient) AND by the
///      owner-signed `maxSlippageBps`: the worst a manipulator achieves is running the owner's own
///      trade within the owner's own tolerance band, while paying the pool fees to move it. The
///      absolute floor is not exposed to spot manipulation but IS exposed to drift; this trades one
///      for the other and bounds the new exposure with owner-signed slippage.
/// @dev Same deployment model as v3: an EIP-1167 clone of one hardened implementation, locked at
///      construction, NO selfdestruct/delegatecall/upgrade. The EIP-712 domain version is bumped to
///      "3.1" so a v3.1 clone's signatures are scoped to these semantics, exactly as "3" scoped v3.
contract OpenZapV3_1 {
    using SafeApprove for address;

    // --------------------------------------------------------------------- //
    // Shared immutables (identical for every clone)                          //
    // --------------------------------------------------------------------- //
    address public immutable FACTORY;
    AdapterRegistry public immutable ADAPTERS;
    TokenAllowlist public immutable TOKENS;
    /// @notice Allowlist of price sources (same two-step-owned registry type as ADAPTERS — a separate
    ///         instance). Both the trigger path AND the relative-floor path read only sources listed
    ///         here.
    AdapterRegistry public immutable PRICE_SOURCES;
    /// @notice The protocol lottery pot receiving 20% of every executor fee.
    address public immutable LOTTERY_POT;

    // --------------------------------------------------------------------- //
    // Per-clone storage (written once by `initialize`)                       //
    // --------------------------------------------------------------------- //
    bool private _initialized;
    uint256 private _reentry;
    address public owner;
    address public recipient;
    uint256 public maxRelayerFeeCap;
    bool public optimization;
    bytes32 public policyHash;
    address[] private _trackedAssets;
    Step[] private _steps;
    mapping(uint256 => bool) public nonceUsed;

    /// @notice Progress of a recurring series, keyed by `seriesId` (nonce namespace).
    struct Series {
        uint32 runs;
        uint64 lastRun;
    }

    mapping(uint256 => Series) private _series;

    uint256 public constant BALANCE_RELATIVE = type(uint256).max;

    /// @notice Protocol executor fee on recurring/triggered output: 1% (100 bps).
    uint256 public constant EXEC_FEE_BPS = 100;
    /// @notice Executor's share of that fee: 80%. The remaining 20% goes to `LOTTERY_POT`.
    uint256 public constant EXECUTOR_SHARE_BPS = 8000;
    uint256 private constant BPS = 10_000;
    /// @dev Threshold ceiling (100x). Also keeps `baseline * (BPS + threshold)` far from overflow.
    uint256 private constant MAX_THRESHOLD_BPS = 1_000_000;
    uint256 private constant Q96 = 0x1000000000000000000000000;

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 private constant RECURRING_TYPEHASH = keccak256(
        "RecurringIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOutPerRun)"
    );
    bytes32 private constant TRIGGER_TYPEHASH = keccak256(
        "TriggerIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address priceSource,uint256 baselinePriceX96,uint32 thresholdBps,bool above,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    /// @dev The relative-floor typehash. Field order mirrors `RecurringIntent` with the trailing
    ///      `minOutPerRun` replaced by `priceSource` + `maxSlippageBps`.
    bytes32 private constant RECURRING_RELATIVE_TYPEHASH = keccak256(
        "RecurringRelativeIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DOMAIN_NAME = keccak256("OpenZap");
    // Version "3.1": a v3.1 clone is a distinct verifying contract, but the bump scopes signatures to
    // the v3.1 semantics (relative-floor recurring) explicitly, exactly as "3" scoped v3.
    bytes32 private constant DOMAIN_VERSION = keccak256("3.1");
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 private constant MAX_STEPS = 16;
    uint256 private constant MAX_TRACKED = 16;

    event Initialized(address indexed owner, bytes32 policyHash);
    event Executed(uint256 indexed nonce, address indexed recipient, address outAsset, uint256 amountOut, uint256 fee);
    event ExecutedRecurring(
        uint256 indexed seriesId,
        uint32 run,
        address indexed executor,
        address outAsset,
        uint256 amountOut,
        uint256 executorFee,
        uint256 potFee
    );
    event ExecutedRecurringRelative(
        uint256 indexed seriesId,
        uint32 run,
        address indexed executor,
        address indexed priceSource,
        uint256 priceX96,
        address outAsset,
        uint256 amountOut,
        uint256 executorFee,
        uint256 potFee,
        uint256 floor
    );
    event ExecutedTrigger(
        uint256 indexed nonce,
        address indexed executor,
        address priceSource,
        uint256 priceX96,
        address outAsset,
        uint256 amountOut,
        uint256 executorFee,
        uint256 potFee
    );
    event SeriesFinished(uint256 indexed seriesId, uint32 runs);
    event EmergencyExit(address indexed owner, address indexed asset, uint256 amount);
    event NonceInvalidated(uint256 indexed nonce);

    error NotFactory();
    error AlreadyInitialized();
    error NotOwner();
    error NotOptimization();
    error ZeroRecipient();
    error ZeroOwner();
    error ZeroAddress();
    error PolicyTooLarge();
    error EmptyPolicy();
    error InvalidStep(uint256 index);
    error DuplicateTrackedAsset(address asset);
    error NativeTokenUnsupported();
    error InvalidAdapterResult(uint256 index, address tokenOut, uint256 amountOut);
    error ZeroBalanceRelativeStep(uint256 index);
    error GasLimitTooHigh();
    error AdapterNotAllowed(address adapter);
    error TokenNotAllowed(address token);
    error WrongZap();
    error WrongChain();
    error PolicyMismatch();
    error Expired();
    error NotYetValid();
    error GasPriceTooHigh();
    error FeeAboveCap();
    error WrongRecipient();
    error NonceReplay();
    error BadSignature();
    error MinOutNotMet();
    error Reentrancy();
    error NativeExitFailed();
    error InvalidSchedule();
    error IntervalNotElapsed(uint64 nextRunAt);
    error ExecutorMismatch();
    error PriceSourceNotAllowed(address source);
    error InvalidThreshold();
    error TriggerNotMet(uint256 priceX96, uint256 boundX96);
    /// @dev The owner's slippage band is out of range (`>= 10_000` would zero out or underflow the
    ///      floor and disable protection). Fail closed.
    error InvalidSlippage();
    /// @dev The run's `outAsset` is neither `currency0` nor `currency1` of the named price source, so
    ///      the source cannot value this pair. Fail closed rather than invent a floor.
    error PairNotValuable(address outAsset, address currency0, address currency1);
    /// @dev The run consumed zero of the pool's input currency, so there is nothing to value the
    ///      output against. Fail closed.
    error NoInputSpent();
    /// @dev The fair expected output rounded down to zero (tiny input valued against a very small
    ///      Q96 price), which would collapse the floor to zero and DISABLE the owner's slippage
    ///      protection. A floor that rounds to zero must fail closed, never pass through.
    error FloorUnderflow();
    /// @dev The relative-floor path only soundly values a SINGLE-step policy: `amountInSpent` is a
    ///      net balance delta of the pool's input currency across the loop, and a multi-step policy
    ///      that also produces/consumes that currency in intermediate steps would misvalue the run.
    ///      The live route is single-step; the general case is refused rather than mispriced.
    error RelativeRequiresSingleStep();

    modifier nonReentrant() {
        if (_reentry == 1) revert Reentrancy();
        _reentry = 1;
        _;
        _reentry = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address factory_,
        AdapterRegistry adapters_,
        TokenAllowlist tokens_,
        AdapterRegistry priceSources_,
        address lotteryPot_
    ) {
        if (
            factory_ == address(0) || address(adapters_) == address(0) || address(tokens_) == address(0)
                || address(priceSources_) == address(0) || lotteryPot_ == address(0)
        ) revert ZeroAddress();
        FACTORY = factory_;
        ADAPTERS = adapters_;
        TOKENS = tokens_;
        PRICE_SOURCES = priceSources_;
        LOTTERY_POT = lotteryPot_;
        _initialized = true; // brick the implementation; only clones get a fresh (false) slot
    }

    // --------------------------------------------------------------------- //
    // Initialization (factory-only, atomic, once)                            //
    // --------------------------------------------------------------------- //

    function initialize(Policy calldata p) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (!p.optimization) revert NotOptimization();
        if (p.owner == address(0)) revert ZeroOwner();
        if (p.recipient == address(0)) revert ZeroRecipient();
        if (p.steps.length == 0) revert EmptyPolicy();
        if (p.steps.length > MAX_STEPS || p.trackedAssets.length > MAX_TRACKED) revert PolicyTooLarge();

        owner = p.owner;
        recipient = p.recipient;
        maxRelayerFeeCap = p.maxRelayerFeeCap;
        optimization = true;

        for (uint256 i; i < p.trackedAssets.length; ++i) {
            address a = p.trackedAssets[i];
            if (!TOKENS.isAllowed(a)) revert TokenNotAllowed(a);
            for (uint256 j; j < i; ++j) {
                if (p.trackedAssets[j] == a) revert DuplicateTrackedAsset(a);
            }
            _trackedAssets.push(a);
        }
        for (uint256 i; i < p.steps.length; ++i) {
            Step calldata s = p.steps[i];
            if (s.tokenIn == address(0)) revert NativeTokenUnsupported();
            if (s.amountIn == 0) revert InvalidStep(i);
            if (!ADAPTERS.isAllowed(s.adapter)) revert AdapterNotAllowed(s.adapter);
            if (s.spender != s.adapter) revert InvalidStep(i);
            if (!TOKENS.isAllowed(s.tokenIn)) revert TokenNotAllowed(s.tokenIn);
            _steps.push();
            Step storage d = _steps[i];
            d.adapter = s.adapter;
            d.tokenIn = s.tokenIn;
            d.spender = s.spender;
            d.amountIn = s.amountIn;
            d.data = s.data;
        }

        policyHash = keccak256(abi.encode(p));
        emit Initialized(p.owner, policyHash);
    }

    // --------------------------------------------------------------------- //
    // Execution type 1: one-shot (V2 semantics, unchanged, no protocol fee)  //
    // --------------------------------------------------------------------- //

    function execute(OpenZapIntent calldata intent, bytes calldata sig) external nonReentrant {
        if (intent.zap != address(this)) revert WrongZap();
        if (intent.chainId != block.chainid) revert WrongChain();
        if (intent.policyHash != policyHash) revert PolicyMismatch();
        if (block.timestamp > intent.deadline) revert Expired();
        if (block.timestamp < intent.validAfter) revert NotYetValid();
        if (tx.gasprice > intent.maxFeePerGas) revert GasPriceTooHigh();
        if (intent.recipient != recipient) revert WrongRecipient();
        if (intent.maxRelayerFee > maxRelayerFeeCap) revert FeeAboveCap();
        if (gasleft() > intent.maxGas) revert GasLimitTooHigh();
        if (!TOKENS.isAllowed(intent.outAsset)) revert TokenNotAllowed(intent.outAsset);
        if (nonceUsed[intent.nonce]) revert NonceReplay();
        nonceUsed[intent.nonce] = true;
        _verifySignature(_hashOneShot(intent), sig);

        uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));
        _runSteps();

        uint256 out = IERC20(intent.outAsset).balanceOf(address(this)) - preOut;
        uint256 fee = 0;
        if (intent.maxRelayerFee != 0 && intent.relayer != address(0)) {
            fee = intent.maxRelayerFee;
            if (fee > out) fee = out;
            if (out - fee < intent.minOut) revert MinOutNotMet();
            out -= fee;
            intent.outAsset.safeTransfer(intent.relayer, fee);
        } else {
            if (out < intent.minOut) revert MinOutNotMet();
        }
        intent.outAsset.safeTransfer(recipient, out);
        emit Executed(intent.nonce, recipient, intent.outAsset, out, fee);
    }

    // --------------------------------------------------------------------- //
    // Execution type 2: recurring (every `interval`, up to `maxRuns`)        //
    // --------------------------------------------------------------------- //

    /// @notice Execute one due run of an owner-signed recurring series. Submission is
    ///         permissionless unless the signature pins an executor; the CADENCE is enforced here,
    ///         so no submitter can run early or overdraw the series.
    function executeRecurring(RecurringIntent calldata intent, bytes calldata sig) external nonReentrant {
        if (intent.zap != address(this)) revert WrongZap();
        if (intent.chainId != block.chainid) revert WrongChain();
        if (intent.policyHash != policyHash) revert PolicyMismatch();
        if (intent.interval == 0 || intent.maxRuns == 0) revert InvalidSchedule();
        if (block.timestamp > intent.deadline) revert Expired();
        if (block.timestamp < intent.validAfter) revert NotYetValid();
        if (tx.gasprice > intent.maxFeePerGas) revert GasPriceTooHigh();
        if (intent.recipient != recipient) revert WrongRecipient();
        if (intent.executor != address(0) && msg.sender != intent.executor) revert ExecutorMismatch();
        if (gasleft() > intent.maxGas) revert GasLimitTooHigh();
        if (!TOKENS.isAllowed(intent.outAsset)) revert TokenNotAllowed(intent.outAsset);
        if (nonceUsed[intent.seriesId]) revert NonceReplay(); // cancelled or exhausted series

        // ---- cadence gate + progress update BEFORE any external call (I-AUTH-1) ----
        Series storage s = _series[intent.seriesId];
        if (s.runs != 0) {
            uint64 nextRunAt = s.lastRun + intent.interval;
            if (block.timestamp < nextRunAt) revert IntervalNotElapsed(nextRunAt);
        }
        uint32 run = s.runs + 1;
        s.runs = run;
        s.lastRun = uint64(block.timestamp);
        if (run == intent.maxRuns) {
            nonceUsed[intent.seriesId] = true; // exhaustion consumes the series id
            emit SeriesFinished(intent.seriesId, run);
        }
        _verifySignature(_hashRecurring(intent), sig);

        uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));
        _runSteps();
        (uint256 net, uint256 executorFee, uint256 potFee) =
            _settleWithExecutorFee(intent.outAsset, preOut, intent.minOutPerRun);
        emit ExecutedRecurring(intent.seriesId, run, msg.sender, intent.outAsset, net, executorFee, potFee);
    }

    // --------------------------------------------------------------------- //
    // Execution type 4: recurring-relative (floor from live spot each run)   //
    // --------------------------------------------------------------------- //

    /// @notice Execute one due run of an owner-signed recurring series whose per-run floor is derived
    ///         from the pool's CURRENT spot instead of a frozen absolute number. Every gate is
    ///         identical to `executeRecurring` (cadence, nonce/series, authorization, executor pin,
    ///         1% fee split 80/20). The only difference is the floor: read live spot from the signed
    ///         allowlisted `priceSource`, value this run's measured input at that spot, and require
    ///         the net output to clear `spot * (1 - maxSlippageBps)`.
    function executeRecurringRelative(RecurringRelativeIntent calldata intent, bytes calldata sig)
        external
        nonReentrant
    {
        if (intent.zap != address(this)) revert WrongZap();
        if (intent.chainId != block.chainid) revert WrongChain();
        if (intent.policyHash != policyHash) revert PolicyMismatch();
        if (intent.interval == 0 || intent.maxRuns == 0) revert InvalidSchedule();
        if (block.timestamp > intent.deadline) revert Expired();
        if (block.timestamp < intent.validAfter) revert NotYetValid();
        if (tx.gasprice > intent.maxFeePerGas) revert GasPriceTooHigh();
        if (intent.recipient != recipient) revert WrongRecipient();
        if (intent.executor != address(0) && msg.sender != intent.executor) revert ExecutorMismatch();
        if (gasleft() > intent.maxGas) revert GasLimitTooHigh();
        if (!TOKENS.isAllowed(intent.outAsset)) revert TokenNotAllowed(intent.outAsset);
        if (!PRICE_SOURCES.isAllowed(intent.priceSource)) revert PriceSourceNotAllowed(intent.priceSource);
        if (intent.maxSlippageBps >= BPS) revert InvalidSlippage(); // >= 100% would disable the floor
        // The net-delta measurement of `amountInSpent` is only sound for a single-step policy; a
        // multi-step policy that also produces/consumes the pool's input currency would misvalue the
        // run. Refuse rather than misprice (the live route is single-step).
        if (_steps.length != 1) revert RelativeRequiresSingleStep();
        if (nonceUsed[intent.seriesId]) revert NonceReplay(); // cancelled or exhausted series

        // ---- cadence gate + progress update BEFORE any external call (I-AUTH-1) ----
        Series storage s = _series[intent.seriesId];
        if (s.runs != 0) {
            uint64 nextRunAt = s.lastRun + intent.interval;
            if (block.timestamp < nextRunAt) revert IntervalNotElapsed(nextRunAt);
        }
        uint32 run = s.runs + 1;
        s.runs = run;
        s.lastRun = uint64(block.timestamp);
        if (run == intent.maxRuns) {
            nonceUsed[intent.seriesId] = true; // exhaustion consumes the series id
            emit SeriesFinished(intent.seriesId, run);
        }
        _verifySignature(_hashRecurringRelative(intent), sig);

        // ---- orient the floor against the source (fail closed on an unvaluable pair) ----
        // `priceX96` = currency1 per currency0, Q96. The INPUT asset is whichever pool currency is
        // NOT the outAsset; if the outAsset is neither, this source cannot value the run.
        IOrientedPriceSource src = IOrientedPriceSource(intent.priceSource);
        address c0 = src.currency0();
        address c1 = src.currency1();
        address inAsset;
        if (intent.outAsset == c1) {
            inAsset = c0; // spending currency0, buying currency1 (e.g. aeWETH -> 0xZAPS)
        } else if (intent.outAsset == c0) {
            inAsset = c1; // spending currency1, buying currency0 (e.g. 0xZAPS -> aeWETH)
        } else {
            revert PairNotValuable(intent.outAsset, c0, c1);
        }
        // Read spot BEFORE the steps move the pool, so the reference is the untouched market mid the
        // owner's slippage band is measured against — not the price our own trade just produced.
        uint256 priceX96 = src.priceX96(); // reverts (fails closed) if the market is unreadable

        // ---- run + measure this run's ACTUAL input spent and output produced ----
        uint256 preIn = IERC20(inAsset).balanceOf(address(this));
        uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));
        _runSteps();
        // Underflow-reverts (fail closed) if the run somehow ended holding MORE input than it started
        // with — i.e. it did not actually spend the pool's input currency.
        uint256 amountInSpent = preIn - IERC20(inAsset).balanceOf(address(this));
        if (amountInSpent == 0) revert NoInputSpent();

        uint256 floor = _relativeFloor(intent.outAsset, c1, priceX96, amountInSpent, intent.maxSlippageBps);
        (uint256 net, uint256 executorFee, uint256 potFee) =
            _settleWithExecutorFee(intent.outAsset, preOut, floor);
        emit ExecutedRecurringRelative(
            intent.seriesId,
            run,
            msg.sender,
            intent.priceSource,
            priceX96,
            intent.outAsset,
            net,
            executorFee,
            potFee,
            floor
        );
    }

    // --------------------------------------------------------------------- //
    // Execution type 3: triggered (fires once when the market crosses)       //
    // --------------------------------------------------------------------- //

    /// @notice Execute an owner-signed trigger, valid only while the allowlisted price source
    ///         reports the market past the signed threshold. The clone reads the price itself — the
    ///         submitter cannot supply one (ADR-0004: permissionless, on-chain-conditioned).
    function executeTrigger(TriggerIntent calldata intent, bytes calldata sig) external nonReentrant {
        if (intent.zap != address(this)) revert WrongZap();
        if (intent.chainId != block.chainid) revert WrongChain();
        if (intent.policyHash != policyHash) revert PolicyMismatch();
        if (block.timestamp > intent.deadline) revert Expired();
        if (block.timestamp < intent.validAfter) revert NotYetValid();
        if (tx.gasprice > intent.maxFeePerGas) revert GasPriceTooHigh();
        if (intent.recipient != recipient) revert WrongRecipient();
        if (intent.executor != address(0) && msg.sender != intent.executor) revert ExecutorMismatch();
        if (gasleft() > intent.maxGas) revert GasLimitTooHigh();
        if (!TOKENS.isAllowed(intent.outAsset)) revert TokenNotAllowed(intent.outAsset);
        if (!PRICE_SOURCES.isAllowed(intent.priceSource)) revert PriceSourceNotAllowed(intent.priceSource);
        if (
            intent.baselinePriceX96 == 0 || intent.thresholdBps == 0 || intent.thresholdBps > MAX_THRESHOLD_BPS
                || (!intent.above && intent.thresholdBps >= BPS)
        ) revert InvalidThreshold();
        if (nonceUsed[intent.nonce]) revert NonceReplay();
        nonceUsed[intent.nonce] = true; // consume first (I-AUTH-1)
        _verifySignature(_hashTrigger(intent), sig);

        // ---- the on-chain condition: the market, not the submitter, arms the trigger ----
        uint256 price = IPriceSource(intent.priceSource).priceX96();
        uint256 bound;
        if (intent.above) {
            bound = (intent.baselinePriceX96 * (BPS + intent.thresholdBps)) / BPS;
            if (price < bound) revert TriggerNotMet(price, bound);
        } else {
            bound = (intent.baselinePriceX96 * (BPS - intent.thresholdBps)) / BPS;
            if (price > bound) revert TriggerNotMet(price, bound);
        }

        uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));
        _runSteps();
        (uint256 net, uint256 executorFee, uint256 potFee) =
            _settleWithExecutorFee(intent.outAsset, preOut, intent.minOut);
        emit ExecutedTrigger(
            intent.nonce, msg.sender, intent.priceSource, price, intent.outAsset, net, executorFee, potFee
        );
    }

    // --------------------------------------------------------------------- //
    // Shared execution internals                                             //
    // --------------------------------------------------------------------- //

    /// @dev The frozen step loop, byte-for-byte V2 semantics: re-check the registry, resolve
    ///      fixed/balance-relative amount, exact-approve, fixed-selector adapter call, reset.
    function _runSteps() private {
        uint256 n = _steps.length;
        for (uint256 i; i < n; ++i) {
            Step storage s = _steps[i];
            if (!ADAPTERS.isAllowed(s.adapter)) revert AdapterNotAllowed(s.adapter);

            uint256 amountIn = s.amountIn;
            if (amountIn == BALANCE_RELATIVE) {
                amountIn = IERC20(s.tokenIn).balanceOf(address(this));
                if (amountIn == 0) revert ZeroBalanceRelativeStep(i);
            }

            if (s.tokenIn != address(0)) s.tokenIn.approveExact(s.spender, amountIn);
            (address adapterOut, uint256 adapterAmountOut) = IAdapter(s.adapter).execute(s.tokenIn, amountIn, s.data);
            s.tokenIn.approveExact(s.spender, 0);
            if (adapterOut == address(0) || adapterAmountOut == 0 || !TOKENS.isAllowed(adapterOut)) {
                revert InvalidAdapterResult(i, adapterOut, adapterAmountOut);
            }
        }
    }

    /// @dev Value `amountInSpent` of the pool's INPUT currency at live spot and apply the owner's
    ///      slippage band. `priceX96` = currency1 per currency0, Q96 (full 512-bit `mulDiv`, no
    ///      overflow). Direction is fixed by which side of the pool the `outAsset` is:
    ///        outAsset == currency1 (buying currency1 with currency0): expected = in * priceX96 / 2^96
    ///        outAsset == currency0 (buying currency0 with currency1): expected = in * 2^96 / priceX96
    ///      then `floor = expected * (BPS - maxSlippageBps) / BPS`.
    function _relativeFloor(
        address outAsset,
        address currency1,
        uint256 priceX96,
        uint256 amountInSpent,
        uint32 maxSlippageBps
    ) private pure returns (uint256) {
        uint256 expected;
        if (outAsset == currency1) {
            // input is currency0; multiply by the currency1-per-currency0 price
            expected = V4PoolMath.mulDiv(amountInSpent, priceX96, Q96);
        } else {
            // outAsset == currency0; input is currency1; multiply by the reciprocal (2^96 / priceX96)
            expected = V4PoolMath.mulDiv(amountInSpent, Q96, priceX96);
        }
        // A fair value that rounds down to zero (tiny input against a very small Q96 price) would
        // collapse the floor to zero and pass ANY nonzero output — the owner's slippage protection
        // would silently vanish. Fail closed instead.
        if (expected == 0) revert FloorUnderflow();
        return V4PoolMath.mulDiv(expected, BPS - maxSlippageBps, BPS);
    }

    /// @dev Settlement for the executor-driven paths: measure THIS run's output delta, carve the 1%
    ///      protocol fee (80% submitter / 20% lottery pot), enforce the owner's NET floor, and pay
    ///      the recipient. The only value that leaves is the measured delta (I-FLOW-4).
    function _settleWithExecutorFee(address outAsset, uint256 preOut, uint256 minOut)
        private
        returns (uint256 net, uint256 executorFee, uint256 potFee)
    {
        uint256 out = IERC20(outAsset).balanceOf(address(this)) - preOut; // underflow-reverts if no gain
        uint256 fee = (out * EXEC_FEE_BPS) / BPS;
        executorFee = (fee * EXECUTOR_SHARE_BPS) / BPS;
        potFee = fee - executorFee;
        net = out - fee;
        if (net < minOut) revert MinOutNotMet(); // floor is NET of the protocol fee (I-FLOW-2)

        if (executorFee != 0) outAsset.safeTransfer(msg.sender, executorFee);
        if (potFee != 0) {
            outAsset.safeTransfer(LOTTERY_POT, potFee);
            // Credit lottery tickets to the fee payer (this zap's owner). The pot only records —
            // it can never pull. A revert here fails the run closed rather than dropping the credit.
            ILotteryPot(LOTTERY_POT).notifyContribution(owner, outAsset, potFee);
        }
        outAsset.safeTransfer(recipient, net);
    }

    // --------------------------------------------------------------------- //
    // Recovery & revocation (always available to the owner)                  //
    // --------------------------------------------------------------------- //

    function emergencyExit(address[] calldata assets) external onlyOwner {
        for (uint256 i; i < assets.length; ++i) {
            address a = assets[i];
            uint256 bal = IERC20(a).balanceOf(address(this));
            if (bal != 0) {
                a.safeTransfer(owner, bal);
                emit EmergencyExit(owner, a, bal);
            }
        }
        uint256 nativeBal = address(this).balance;
        if (nativeBal != 0) {
            (bool ok,) = payable(owner).call{value: nativeBal}("");
            if (!ok) revert NativeExitFailed();
            emit EmergencyExit(owner, address(0), nativeBal);
        }
    }

    /// @notice Invalidate a nonce/seriesId off the fast path: kills a held one-shot intent, a held
    ///         trigger, or an ENTIRE recurring series (I-REC-3).
    function invalidateNonce(uint256 nonce) external onlyOwner {
        nonceUsed[nonce] = true;
        emit NonceInvalidated(nonce);
    }

    // --------------------------------------------------------------------- //
    // Signature verification (EIP-712 + ERC-1271)                            //
    // --------------------------------------------------------------------- //

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, block.chainid, address(this)));
    }

    function hashIntent(OpenZapIntent calldata intent) public view returns (bytes32) {
        return _hashOneShot(intent);
    }

    function hashRecurringIntent(RecurringIntent calldata intent) public view returns (bytes32) {
        return _hashRecurring(intent);
    }

    function hashRecurringRelativeIntent(RecurringRelativeIntent calldata intent) public view returns (bytes32) {
        return _hashRecurringRelative(intent);
    }

    function hashTriggerIntent(TriggerIntent calldata intent) public view returns (bytes32) {
        return _hashTrigger(intent);
    }

    function _hashOneShot(OpenZapIntent calldata intent) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.zap,
                intent.chainId,
                intent.nonce,
                intent.validAfter,
                intent.deadline,
                intent.recipient,
                intent.relayer,
                intent.maxRelayerFee,
                intent.maxGas,
                intent.maxFeePerGas,
                intent.policyHash,
                intent.outAsset,
                intent.minOut
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashRecurring(RecurringIntent calldata intent) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECURRING_TYPEHASH,
                intent.zap,
                intent.chainId,
                intent.seriesId,
                intent.validAfter,
                intent.deadline,
                intent.interval,
                intent.maxRuns,
                intent.recipient,
                intent.executor,
                intent.maxGas,
                intent.maxFeePerGas,
                intent.policyHash,
                intent.outAsset,
                intent.minOutPerRun
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashRecurringRelative(RecurringRelativeIntent calldata intent) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECURRING_RELATIVE_TYPEHASH,
                intent.zap,
                intent.chainId,
                intent.seriesId,
                intent.validAfter,
                intent.deadline,
                intent.interval,
                intent.maxRuns,
                intent.recipient,
                intent.executor,
                intent.maxGas,
                intent.maxFeePerGas,
                intent.policyHash,
                intent.outAsset,
                intent.priceSource,
                intent.maxSlippageBps
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashTrigger(TriggerIntent calldata intent) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRIGGER_TYPEHASH,
                intent.zap,
                intent.chainId,
                intent.nonce,
                intent.validAfter,
                intent.deadline,
                intent.priceSource,
                intent.baselinePriceX96,
                intent.thresholdBps,
                intent.above,
                intent.recipient,
                intent.executor,
                intent.maxGas,
                intent.maxFeePerGas,
                intent.policyHash,
                intent.outAsset,
                intent.minOut
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _verifySignature(bytes32 digest, bytes calldata sig) private view {
        address o = owner;
        if (o.code.length != 0) {
            (bool ok, bytes memory ret) = o.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, sig));
            if (!(ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC)) revert BadSignature();
        } else {
            address rec = _recover(digest, sig);
            if (rec == address(0) || rec != o) revert BadSignature();
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // --------------------------------------------------------------------- //
    // Views                                                                  //
    // --------------------------------------------------------------------- //

    function stepCount() external view returns (uint256) {
        return _steps.length;
    }

    function trackedAssets() external view returns (address[] memory) {
        return _trackedAssets;
    }

    function step(uint256 i) external view returns (Step memory) {
        return _steps[i];
    }

    /// @notice Progress of a recurring series: runs completed and the last run's timestamp.
    function series(uint256 seriesId) external view returns (uint32 runs, uint64 lastRun) {
        Series storage s = _series[seriesId];
        return (s.runs, s.lastRun);
    }

    receive() external payable {}
}
