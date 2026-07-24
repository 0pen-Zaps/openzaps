// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPriceSource} from "../../v3/interfaces/IPriceSource.sol";

/// @title IOrientedPriceSource
/// @notice An `IPriceSource` that ALSO exposes the two pool currencies its `priceX96` is oriented
///         around. The v3 read surface (`priceX96`) is a single scalar with no way to tell WHICH
///         asset is the numerator; the relative-floor path in `OpenZapV3_1` must know the pool's
///         `currency0`/`currency1` to value an arbitrary `(tokenIn, outAsset)` pair against the feed
///         and to REVERT when the pair is not this pool's pair (fail closed, never a phantom floor).
/// @dev `priceX96` is units of `currency1` per one unit of `currency0`, Q96 fixed-point
///      (`sqrtPriceX96^2 / 2^96`) — exactly the Uniswap orientation `V4PoolPriceSourceOriented`
///      documents (on the live pool: 0xZAPS per aeWETH, so `currency0 == aeWETH`,
///      `currency1 == 0xZAPS`; the feed FALLS when currency1 gains value). A source MUST return the SAME
///      `currency0`/`currency1` for its whole lifetime (they are the pool's immutable key), so the
///      capsule can trust them the way it trusts an immutable. The extra getters are the ONLY
///      addition over `IPriceSource`; the price semantics and the fail-closed contract are identical.
interface IOrientedPriceSource is IPriceSource {
    /// @notice The pool's `currency0` — the DENOMINATOR asset of `priceX96` (units-per-one-of-this).
    function currency0() external view returns (address);

    /// @notice The pool's `currency1` — the NUMERATOR asset of `priceX96` (this-per-one-of-currency0).
    function currency1() external view returns (address);
}
