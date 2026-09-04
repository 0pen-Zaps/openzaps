// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SafeApprove} from "../libraries/SafeApprove.sol";
import {IHookedV4PoolManager} from "../primitives/HookedRangeVault.sol";

/// @title HookedPoolSwapBase
/// @notice One exact-input swap on a hooked v4 pool, driven through the PoolManager's own unlock
///         callback — no router, no Permit2, no path bytes. Shared by the hooked-range deposit and
///         withdraw adapters, which each swap ONE leg inside the pool they LP into.
/// @dev Both ERC-20 sides only (the vault refuses native). The swap uses the loosest legal price
///      limit: on a Hookr pool with input-side cuts the hook REQUIRES that limit, and on every
///      pool it lets the fill go as deep as liquidity allows. A partial fill (liquidity exhausted)
///      is tolerated and REPORTED as `consumed < amountIn`; the caller decides what to do with the
///      unswapped remainder. Hook swap deltas are irrelevant here because only measured token
///      deltas are ever acted on.
abstract contract HookedPoolSwapBase {
    IHookedV4PoolManager public immutable poolManager;

    /// @dev `TickMath.MIN_SQRT_PRICE + 1` / `TickMath.MAX_SQRT_PRICE - 1`.
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @dev Consume-once digest tying each unlock callback to the swap that opened it.
    bytes32 private _pendingUnlock;

    error OnlyPoolManager();
    error UnexpectedUnlock();
    error BadSwapDelta();
    error SwapTooLarge();

    constructor(address poolManager_) {
        poolManager = IHookedV4PoolManager(poolManager_);
    }

    /// @dev Swap up to `amountIn` of the `zeroForOne ? currency0 : currency1` side of `key`.
    ///      Returns what the pool actually consumed and produced, from the pool's own delta.
    function _swapExactIn(IHookedV4PoolManager.PoolKey memory key, bool zeroForOne, uint256 amountIn)
        internal
        returns (uint256 consumed, uint256 produced)
    {
        // casting is safe: type(int128).max is positive and fits uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amountIn > uint256(uint128(type(int128).max))) revert SwapTooLarge();
        bytes memory unlockData = abi.encode(key, zeroForOne, amountIn);
        _pendingUnlock = keccak256(unlockData);
        bytes memory result = poolManager.unlock(unlockData);
        if (_pendingUnlock != bytes32(0)) revert UnexpectedUnlock();
        (consumed, produced) = abi.decode(result, (uint256, uint256));
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
        // The remaining casts below are guarded: inDelta < 0 and outDelta > 0 are asserted first,
        // and both halves came from int128 lanes, so uint256(-inDelta) / uint256(outDelta) cannot
        // truncate.
        // forge-lint: disable-start(unsafe-typecast)
        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;

        // Exact input: we must owe the pool the input side and be owed the output side.
        if (inDelta >= 0 || outDelta <= 0) revert BadSwapDelta();
        uint256 owed = uint256(-inDelta);
        if (owed > amountIn) revert BadSwapDelta();

        poolManager.take(tokenOut, address(this), uint256(outDelta));
        poolManager.sync(tokenIn);
        SafeApprove.safeTransfer(tokenIn, address(poolManager), owed);
        poolManager.settle();

        return abi.encode(owed, uint256(outDelta));
        // forge-lint: disable-end(unsafe-typecast)
    }
}
