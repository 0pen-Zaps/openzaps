// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @notice The two WETH capabilities this adapter uses beyond ERC-20: wrap and unwrap.
interface IWethWrap {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev Uniswap v4-core pool identity. ABI-identical to v4-core's `PoolKey`
///      (`Currency` is an address wrapper).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev v4-core `SwapParams`: `amountSpecified` negative means exact input.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @notice The v4-core PoolManager surface both swap directions use. `swapDelta` is v4's
///         `BalanceDelta`: an int256 packing (amount0 int128 high, amount1 int128 low),
///         positive when the pool owes this contract.
interface IV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function take(address currency, address to, uint256 amount) external;
    function settle() external payable returns (uint256 paid);
    function sync(address currency) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title RobinhoodV4NativePoolAdapter
/// @notice Exact-input adapter for ONE native-ETH Uniswap-v4 pool on Robinhood Chain, presented to
///         the capsule as an ERC-20 pair: aeWETH stands in for the pool's native currency0.
/// @dev The OpenZap core settles ERC-20 balances only, and `TokenAllowlist` rejects the zero
///      address, so a pool whose `currency0` is native ETH (`address(0)`) — the only market some
///      launched tokens have — cannot be served by `RobinhoodV4PoolAdapter`, which refuses such a
///      pool at construction. This adapter closes that gap by welding the wrap boundary into the
///      step itself:
///
///      - BUY (`tokenIn == WETH`): pull aeWETH, unwrap to native ETH, swap exact-input through the
///        pinned pool via the PoolManager's own unlock callback, and forward the measured
///        `currency1` output to the caller.
///      - SELL (`tokenIn == currency1`): pull the token, swap exact-input for native ETH, wrap the
///        measured native output back into aeWETH, and forward it to the caller.
///
///      aeWETH is the canonical 1:1 wrapped native (`deposit`/`withdraw` at par), so the wrap adds
///      no price surface: the capsule's tracked pair is [aeWETH, currency1] and the pool's real
///      price applies to it exactly.
///
///      The pool is chosen at deploy time and proven: the constructor recomputes
///      `keccak256(abi.encode(address(0), currency1, fee, tickSpacing, address(0)))` and refuses to
///      deploy unless it equals the `expectedPoolId` the deployer names. One deployment serves
///      exactly one pool — deploy a second instance for a second pool. It swaps the canonical
///      PoolManager directly (the same mechanic `HookBlocks` uses on this chain) because the
///      Universal Router path this repo's other adapters ride is built around ERC-20 settlement.
///
///      What this contract REFUSES to do:
///      - It refuses any user-supplied target, selector, path, command byte or route blob. `data` is
///        either empty or exactly one `uint256 minAmountOut`; nothing else is accepted.
///      - It refuses hooked pools and dynamic fees: the pool key is pinned hookless, so no
///        third-party hook code ever executes inside a step.
///      - It refuses partial fills: an exact-input swap that cannot consume the full input (pool
///        liquidity exhausted before the amount) reverts instead of stranding the difference.
///      - It refuses to run on any chain other than Robinhood Chain (4663), both at construction
///        and on every call.
///      - It refuses to hold anything: it reverts unless its input balance and native balance are
///        exactly restored, and it forwards the entire measured output to `msg.sender`.
///      - It refuses native ETH from anyone but the wrapped-native contract (unwrap) and the
///        PoolManager (take), and refuses `unlockCallback` calls that no in-flight swap opened.
///      - It refuses to be reentered.
contract RobinhoodV4NativePoolAdapter is IAdapter {
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    /// @dev v4-core `StateLibrary.POOLS_SLOT`; slot0 of a pool lives at
    ///      `keccak256(abi.encode(poolId, POOLS_SLOT))`.
    uint256 private constant POOLS_SLOT = 6;
    /// @dev `TickMath.MIN_SQRT_PRICE + 1`: the loosest legal zeroForOne limit.
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    /// @dev `TickMath.MAX_SQRT_PRICE - 1`: the loosest legal oneForZero limit.
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    /// @dev `LPFeeLibrary.MAX_LP_FEE` — 100% in hundredths of a bip. The dynamic-fee flag
    ///      (0x800000) is above this, so a static bound also refuses dynamic-fee pools.
    uint24 private constant MAX_STATIC_FEE = 1_000_000;
    int24 private constant MAX_TICK_SPACING = 32767;
    int24 private constant MIN_TICK_SPACING = 1;

    /// @notice The wrapped-native ERC-20 (aeWETH) that stands in for the pool's currency0.
    address public immutable weth;
    /// @notice The v4-core PoolManager that owns the pinned pool.
    IV4PoolManager public immutable poolManager;
    /// @notice The pool's ERC-20 side; `currency0` is native ETH by construction.
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    /// @notice The v4 pool id, `keccak256(abi.encode(poolKey))`. Lets a deployer prove on-chain
    ///         that this instance is wired to the pool they intended.
    bytes32 public immutable poolId;

    uint256 private _entered;
    /// @dev Consumed-once digest tying each unlock callback to the swap that opened it; nonzero
    ///      only between `unlock` and the callback.
    bytes32 private _pendingUnlock;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error CurrenciesEqual();
    error InvalidTickSpacing(int24 value);
    error InvalidFee(uint24 value);
    error PoolIdMismatch(bytes32 expected, bytes32 actual);
    error PoolNotInitialized();
    error UnsupportedToken(address token);
    error InvalidData();
    error ZeroAmount();
    error AmountTooLarge();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error PartialFill(uint256 expected, uint256 consumed);
    error BadSwapDelta();
    error NoOutput();
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error ResidualInput(uint256 expected, uint256 actual);
    error ResidualNative(uint256 expected, uint256 actual);
    error OnlyPoolManager();
    error UnexpectedUnlock();
    error NativeNotAccepted();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param weth_ Canonical wrapped native (aeWETH). MUST unwrap/wrap at par via
    ///        `withdraw`/`deposit`; it is the ERC-20 the capsule funds a buy with and settles a
    ///        sell in.
    /// @param poolManager_ The v4-core PoolManager holding the pinned pool.
    /// @param currency1_ The pool's token side (higher-sorted; currency0 is native ETH).
    /// @param fee_ Static LP fee in hundredths of a bip. Dynamic-fee pools are refused.
    /// @param tickSpacing_ Pool tick spacing, 1..32767.
    /// @param expectedPoolId_ The pool id the deployer intends; construction recomputes and
    ///        compares, so a mistyped key cannot deploy.
    constructor(
        address weth_,
        address poolManager_,
        address currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        bytes32 expectedPoolId_
    ) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (weth_ == address(0) || poolManager_ == address(0) || currency1_ == address(0)) revert ZeroAddress();
        if (weth_ == currency1_) revert CurrenciesEqual();
        if (tickSpacing_ < MIN_TICK_SPACING || tickSpacing_ > MAX_TICK_SPACING) {
            revert InvalidTickSpacing(tickSpacing_);
        }
        if (fee_ > MAX_STATIC_FEE) revert InvalidFee(fee_);

        _requireCode(weth_);
        _requireCode(poolManager_);
        _requireCode(currency1_);

        // The pinned pool key is (native, currency1, fee, tickSpacing, no hook) BY CONSTRUCTION —
        // recomputed here and matched against what the deployer intended, so this adapter can never
        // be wired to a hooked, dynamic-fee, or ERC-20-currency0 pool by mistake.
        bytes32 computed = keccak256(abi.encode(address(0), currency1_, fee_, tickSpacing_, address(0)));
        if (computed != expectedPoolId_) revert PoolIdMismatch(expectedPoolId_, computed);

        weth = weth_;
        poolManager = IV4PoolManager(poolManager_);
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        poolId = computed;

        // Fail closed at the door: an uninitialized pool means a mistyped key, and every later
        // swap would revert anyway.
        bytes32 word = IV4PoolManager(poolManager_).extsload(keccak256(abi.encode(computed, POOLS_SLOT)));
        if (uint160(uint256(word)) == 0) revert PoolNotInitialized();
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn `weth` (buy: aeWETH → currency1) or `currency1` (sell: currency1 → aeWETH).
    /// @param amountIn Exact input amount, pulled from `msg.sender`.
    /// @param data Empty, or exactly `abi.encode(uint256 minAmountOut)`. No routing bytes are ever
    ///        accepted: this is a bounded typed value the adapter validates and enforces itself.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 minAmountOut = _decodeMinAmountOut(data);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > uint256(uint128(type(int128).max))) revert AmountTooLarge();
        bool isBuy = tokenIn == weth;
        if (!isBuy && tokenIn != currency1) revert UnsupportedToken(tokenIn);
        tokenOut = isBuy ? currency1 : weth;

        // Balances BEFORE the pull: the input must be exactly restored, the native balance must be
        // exactly restored, and the output delta is the only number this contract acts on.
        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        if (IERC20(tokenIn).balanceOf(address(this)) - inputBefore != amountIn) {
            revert InexactInputTransfer(amountIn, IERC20(tokenIn).balanceOf(address(this)) - inputBefore);
        }

        if (isBuy) {
            // Unwrap the pulled aeWETH; the native arrives through `receive` (gated to `weth`).
            IWethWrap(weth).withdraw(amountIn);
        }

        bytes memory unlockData = abi.encode(isBuy, amountIn);
        _pendingUnlock = keccak256(unlockData);
        poolManager.unlock(unlockData);
        // A stale digest means `unlock` returned without invoking the callback — only a non-v4
        // PoolManager can do that, and leaving it set would let that manager drive `unlockCallback`
        // in a LATER transaction, outside the reentrancy mutex, with no floor.
        if (_pendingUnlock != bytes32(0)) revert UnexpectedUnlock();

        if (!isBuy) {
            // Wrap the measured native output back into aeWETH before settling with the caller.
            uint256 nativeOut = address(this).balance - nativeBefore;
            if (nativeOut == 0) revert NoOutput();
            IWethWrap(weth).deposit{value: nativeOut}();
        }

        if (address(this).balance != nativeBefore) revert ResidualNative(nativeBefore, address(this).balance);
        if (IERC20(tokenIn).balanceOf(address(this)) != inputBefore) {
            revert ResidualInput(inputBefore, IERC20(tokenIn).balanceOf(address(this)));
        }

        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        if (outputAfter <= outputBefore) revert NoOutput();

        // The measured delta is the only number this contract will act on or report.
        amountOut = outputAfter - outputBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput(minAmountOut, amountOut);
        SafeApprove.safeTransfer(tokenOut, msg.sender, amountOut);
    }

    /// @notice PoolManager unlock callback: swap the exact input, take the output, settle the debt.
    ///         Callable only by the pinned PoolManager, and only while a swap is mid-flight.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        // Consume the digest: a callback with no opening swap, a second callback for one swap, or
        // tampered data all revert here.
        if (_pendingUnlock == bytes32(0) || keccak256(data) != _pendingUnlock) revert UnexpectedUnlock();
        _pendingUnlock = bytes32(0);

        (bool isBuy, uint256 amountIn) = abi.decode(data, (bool, uint256));
        int256 delta = poolManager.swap(
            PoolKey({
                currency0: address(0), currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)
            }),
            SwapParams({
                    zeroForOne: isBuy,
                    // Negative means exact input in v4-core.
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: isBuy ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
                }),
            ""
        );

        int256 amount0 = delta >> 128;
        int256 amount1 = int256(int128(uint128(uint256(delta))));

        if (isBuy) {
            // Exact-in native → currency1 must owe the pool ETH and be owed currency1.
            if (amount0 >= 0 || amount1 <= 0) revert BadSwapDelta();
            uint256 owed = uint256(-amount0);
            if (owed > amountIn) revert BadSwapDelta();
            // A fill below the full input means pool liquidity ran out at the loosest legal price
            // limit. The step's signed amount would be partly stranded — refuse instead.
            if (owed != amountIn) revert PartialFill(amountIn, owed);
            poolManager.take(currency1, address(this), uint256(amount1));
            poolManager.settle{value: owed}();
        } else {
            // Exact-in currency1 → native must owe the pool the token and be owed ETH.
            if (amount1 >= 0 || amount0 <= 0) revert BadSwapDelta();
            uint256 owed = uint256(-amount1);
            if (owed > amountIn) revert BadSwapDelta();
            if (owed != amountIn) revert PartialFill(amountIn, owed);
            poolManager.take(address(0), address(this), uint256(amount0));
            // ERC-20 settlement: declare, transfer, settle.
            poolManager.sync(currency1);
            SafeApprove.safeTransfer(currency1, address(poolManager), owed);
            poolManager.settle();
        }
        return abi.encode(amount0, amount1);
    }

    /// @notice The immutable PoolKey this instance is wired to. `currency0` is native ETH.
    function poolKey() external view returns (PoolKey memory) {
        return
            PoolKey({
                currency0: address(0), currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)
            });
    }

    /// @notice Native ETH is accepted only from the wrapped-native contract's unwrap and from the
    ///         PoolManager's `take`. Anything else must not be able to masquerade as swap flow.
    receive() external payable {
        if (msg.sender != weth && msg.sender != address(poolManager)) revert NativeNotAccepted();
    }

    function _decodeMinAmountOut(bytes calldata data) private pure returns (uint256 minAmountOut) {
        if (data.length == 0) return 0;
        if (data.length != 32) revert InvalidData();
        minAmountOut = abi.decode(data, (uint256));
        if (minAmountOut > type(uint128).max) revert AmountTooLarge();
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
