// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {IHookedV4PoolManager, IWethWrapVault} from "../primitives/HookedRangeVault.sol";

/// @title HookedPoolSwapBase
/// @notice One exact-input swap on a hooked v4 pool, driven through the PoolManager's own unlock
///         callback — no router, no Permit2, no path bytes, EMPTY hookData. Shared by the
///         hooked-range deposit/withdraw adapters and the Hookr market swap adapter.
/// @dev NATIVE QUOTE. A pool whose `currency0` is native ETH is swapped with the wrapped native
///      ERC-20 (`weth`) as the caller-facing asset: native input is unwrapped just before the
///      swap and settled by value, native output is taken and wrapped before it is reported.
///      Callers therefore only ever see ERC-20 balance deltas. `receive` accepts native only from
///      `weth` and the PoolManager.
///
///      The swap uses the loosest legal price limit. A partial fill (liquidity exhausted) is
///      tolerated and REPORTED as `consumed < amountIn`; unconsumed native input is re-wrapped so
///      the caller's `weth` balance reflects it. Hook swap deltas are irrelevant here because only
///      measured token deltas are ever acted on.
abstract contract HookedPoolSwapBase {
    IHookedV4PoolManager public immutable poolManager;
    address public immutable weth;

    /// @dev `TickMath.MIN_SQRT_PRICE + 1` / `TickMath.MAX_SQRT_PRICE - 1`.
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    bytes32 private _pendingUnlock;

    error OnlyPoolManager();
    error UnexpectedUnlock();
    error BadSwapDelta();
    error SwapTooLarge();
    error NativeNotAccepted();
    error ResidualNative(uint256 expected, uint256 actual);

    constructor(address poolManager_, address weth_) {
        poolManager = IHookedV4PoolManager(poolManager_);
        weth = weth_;
    }

    receive() external payable {
        if (msg.sender != weth && msg.sender != address(poolManager)) revert NativeNotAccepted();
    }

    /// @dev Swap up to `amountIn` of the `zeroForOne ? currency0 : currency1` side of `key`, where
    ///      a native side is supplied/received as `weth`. Returns what the pool actually consumed
    ///      and produced, from the pool's own delta; the native balance is restored exactly.
    function _swapExactIn(IHookedV4PoolManager.PoolKey memory key, bool zeroForOne, uint256 amountIn)
        internal
        returns (uint256 consumed, uint256 produced)
    {
        // casting is safe: type(int128).max is positive and fits uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amountIn > uint256(uint128(type(int128).max))) revert SwapTooLarge();
        bool nativeIn = zeroForOne && key.currency0 == address(0);
        bool nativeOut = !zeroForOne && key.currency0 == address(0);
        uint256 nativeBefore = address(this).balance;

        if (nativeIn) IWethWrapVault(weth).withdraw(amountIn);

        bytes memory unlockData = abi.encode(key, zeroForOne, amountIn);
        _pendingUnlock = keccak256(unlockData);
        bytes memory result = poolManager.unlock(unlockData);
        if (_pendingUnlock != bytes32(0)) revert UnexpectedUnlock();
        (consumed, produced) = abi.decode(result, (uint256, uint256));

        if (nativeIn && consumed < amountIn) IWethWrapVault(weth).deposit{value: amountIn - consumed}();
        if (nativeOut) IWethWrapVault(weth).deposit{value: produced}();
        if (address(this).balance != nativeBefore) revert ResidualNative(nativeBefore, address(this).balance);
    }

    /// @notice PoolManager unlock callback. Callable only by the pinned PoolManager, only while a
    ///         swap is mid-flight, and only with the exact data that opened it.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (_pendingUnlock == bytes32(0) || keccak256(data) != _pendingUnlock) revert UnexpectedUnlock();
        _pendingUnlock = bytes32(0);

        (IHookedV4PoolManager.PoolKey memory key, bool zeroForOne, uint256 amountIn) =
            abi.decode(data, (IHookedV4PoolManager.PoolKey, bool, uint256));

        int256 delta = poolManager.swap(
            key,
            IHookedV4PoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            ""
        );

        int256 amount0 = delta >> 128;
        // casting is safe: v4-core packs two int128 halves into the BalanceDelta int256; the low
        // 128 bits ARE amount1 by construction, so the truncating cast is the decoding.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 amount1 = int256(int128(uint128(uint256(delta))));

        (int256 inDelta, int256 outDelta) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        // The remaining casts are guarded: inDelta < 0 and outDelta > 0 are asserted first, and
        // both halves came from int128 lanes, so the magnitudes cannot truncate.
        // forge-lint: disable-start(unsafe-typecast)
        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;

        if (inDelta >= 0 || outDelta <= 0) revert BadSwapDelta();
        uint256 owed = uint256(-inDelta);
        if (owed > amountIn) revert BadSwapDelta();

        poolManager.take(tokenOut, address(this), uint256(outDelta));
        if (tokenIn == address(0)) {
            poolManager.settle{value: owed}();
        } else {
            poolManager.sync(tokenIn);
            SafeApprove.safeTransfer(tokenIn, address(poolManager), owed);
            poolManager.settle();
        }

        return abi.encode(owed, uint256(outDelta));
        // forge-lint: disable-end(unsafe-typecast)
    }
}
