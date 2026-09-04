// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {IHookedV4PoolManager} from "../primitives/HookedRangeVault.sol";
import {HookedPoolSwapBase} from "./HookedPoolSwapBase.sol";

/// @dev The slice of `HookrMarketCoordinatorV2` this adapter reads. ABI-identical to the
///      coordinator's `Market` record (its `MarketOrigin` enum is a uint8 on the wire).
interface IHookrMarketCoordinatorV2 {
    struct Market {
        bool live;
        uint8 origin;
        address subject;
        address quote;
        address creator;
        address kernel;
        address revenueVault;
        address lpFeeRecipient;
        bytes32 kernelId;
        bytes32 stackHash;
        bytes32 poolId;
        uint160 sqrtPriceX96;
        int24 tickSpacing;
        uint256 subjectSupplied;
        uint256 quoteSupplied;
        uint256 subjectUsed;
        uint256 quoteUsed;
        uint256 cumulativeFee0;
        uint256 cumulativeFee1;
        uint256 openedAtBlock;
        bytes32 launchIntentId;
        address initialBuyRouter;
        uint256 creatorAllocation;
        uint256 initialBuyQuoteIn;
        uint256 initialBuySubjectOut;
        uint256 initialBuySubjectOutMinimum;
        bytes32 initialBuyModuleDataHash;
    }

    function getMarket(bytes32 poolId) external view returns (Market memory market);
    function poolManager() external view returns (address);
}

/// @title HookrMarketSwapAdapter
/// @notice "Zap in to / out of a Hookr modular market" as ONE OpenZap step: quote in, subject out
///         (buy) or subject in, quote out (sell), on any market one of the pinned Hookr
///         coordinators has recorded (Modular V2 and V3 share the record shape; V3 binds a
///         per-market hook instance, which the record carries as `kernel`). The quote side is
///         presented as aeWETH for a native-quoted market.
/// @dev ONE deployment serves every market of every pinned coordinator. The market is named in
///      step data — `abi.encode(bytes32 poolId, uint256 minAmountOut)`, exactly 64 bytes — and
///      verified against the coordinators in order: the first LIVE record wins, and the pool key
///      rebuilt from it (sorted currencies, dynamic fee, its tick spacing, its kernel as the hook)
///      must hash to that very id. The coordinators ARE the bound: a pool id none has recorded is
///      refused, and a recorded kernel is the only hook ever swapped through.
///
///      Swaps go through the PoolManager's own unlock with EMPTY hookData. The kernel treats an
///      untrusted sender with empty hook data as its own payer and recipient, so the directional
///      tax and dynamic fee apply exactly as for any other trader; there is no partner envelope
///      and none is needed.
///
///      PARTIAL FILLS ARE REFUSED: a step's `amountIn` is frozen in the policy hash, and a fill
///      short of it would strand the remainder in the capsule. Everything else mirrors the
///      reference native-pool adapter: chain guard, measured deltas only, exact input restored,
///      native balance restored, zero residual allowance.
contract HookrMarketSwapAdapter is IAdapter, HookedPoolSwapBase {
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000;

    address[] private _coordinators;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error InvalidData();
    error MarketNotLive(bytes32 poolId);
    error PoolIdMismatch(bytes32 expected, bytes32 actual);
    error UnsupportedToken(address token);
    error ZeroAmount();
    error AmountTooLarge();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error PartialFill(uint256 expected, uint256 consumed);
    error ResidualInput(uint256 expected, uint256 actual);
    error NoOutput();
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address poolManager_, address weth_, address[] memory coordinators_)
        HookedPoolSwapBase(poolManager_, weth_)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (poolManager_ == address(0) || weth_ == address(0) || coordinators_.length == 0) revert ZeroAddress();
        _requireCode(poolManager_);
        _requireCode(weth_);
        for (uint256 i = 0; i < coordinators_.length; i++) {
            address coordinator = coordinators_[i];
            if (coordinator == address(0)) revert ZeroAddress();
            _requireCode(coordinator);
            if (IHookrMarketCoordinatorV2(coordinator).poolManager() != poolManager_) revert ZeroAddress();
            _coordinators.push(coordinator);
        }
    }

    function coordinators() external view returns (address[] memory) {
        return _coordinators;
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn The market's quote face (aeWETH or the ERC-20 quote) to buy, or its subject to sell.
    /// @param amountIn Exact input amount, pulled from `msg.sender`.
    /// @param data Exactly `abi.encode(bytes32 poolId, uint256 minAmountOut)`.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        (IHookedV4PoolManager.PoolKey memory key, address subject, address quoteFace, uint256 minAmountOut) =
            _decode(data);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > uint256(uint128(type(int128).max))) revert AmountTooLarge();

        bool isBuy = tokenIn == quoteFace;
        if (!isBuy && tokenIn != subject) revert UnsupportedToken(tokenIn);
        tokenOut = isBuy ? subject : quoteFace;

        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));

        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - inputBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        // The pool side of `tokenIn`: the quote face maps onto the native or ERC-20 quote side.
        address quoteCurrency = key.currency0 == address(0) && quoteFace == weth
            ? address(0)
            : quoteFace;
        address inCurrency = isBuy ? quoteCurrency : subject;
        bool zeroForOne = inCurrency == key.currency0;
        (uint256 consumed,) = _swapExactIn(key, zeroForOne, amountIn);
        if (consumed != amountIn) revert PartialFill(amountIn, consumed);

        if (IERC20(tokenIn).balanceOf(address(this)) != inputBefore) {
            revert ResidualInput(inputBefore, IERC20(tokenIn).balanceOf(address(this)));
        }
        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        if (outputAfter <= outputBefore) revert NoOutput();
        amountOut = outputAfter - outputBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput(minAmountOut, amountOut);
        SafeApprove.safeTransfer(tokenOut, msg.sender, amountOut);
    }

    /// @notice The pool key, subject, and quote face for a recorded market — for off-chain preflight.
    function marketFor(bytes32 poolId)
        external
        view
        returns (IHookedV4PoolManager.PoolKey memory key, address subject, address quoteFace)
    {
        (key, subject, quoteFace,) = _decode(abi.encode(poolId, uint256(0)));
    }

    function _decode(bytes memory data)
        private
        view
        returns (IHookedV4PoolManager.PoolKey memory key, address subject, address quoteFace, uint256 minAmountOut)
    {
        if (data.length != 64) revert InvalidData();
        bytes32 poolId;
        (poolId, minAmountOut) = abi.decode(data, (bytes32, uint256));
        if (minAmountOut > type(uint128).max) revert AmountTooLarge();

        IHookrMarketCoordinatorV2.Market memory market;
        for (uint256 i = 0; i < _coordinators.length; i++) {
            market = IHookrMarketCoordinatorV2(_coordinators[i]).getMarket(poolId);
            if (market.live && market.subject != address(0) && market.kernel != address(0)) break;
        }
        if (!market.live || market.subject == address(0) || market.kernel == address(0)) revert MarketNotLive(poolId);

        subject = market.subject;
        address quote = market.quote;
        (address currency0, address currency1) = quote < subject ? (quote, subject) : (subject, quote);
        key = IHookedV4PoolManager.PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: market.tickSpacing,
            hooks: market.kernel
        });
        bytes32 computed = keccak256(abi.encode(currency0, currency1, DYNAMIC_FEE_FLAG, market.tickSpacing, market.kernel));
        if (computed != poolId || market.poolId != poolId) revert PoolIdMismatch(poolId, computed);
        quoteFace = quote == address(0) ? weth : quote;
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
