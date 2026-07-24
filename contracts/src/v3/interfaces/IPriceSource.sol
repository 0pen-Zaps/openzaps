// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IPriceSource
/// @notice The single fixed read surface a trigger condition is evaluated through. A price source is
///         pinned to ONE market at deployment and allowlisted in a dedicated registry, so a trigger
///         intent can name a source but never invent one — the same discipline `IAdapter` applies to
///         the write path (invariant I-SURF-1), applied to the read path.
/// @dev `priceX96` is the price of currency1 denominated in currency0, Q96 fixed-point
///      (`(sqrtPriceX96^2) / 2^96` for a Uniswap-style pool). The zap compares this value against an
///      owner-signed baseline in the SAME units from the SAME source, so the absolute scale cancels
///      out — only the source's internal consistency matters. A source MUST revert rather than
///      return 0 when its market is unreadable (fail closed, never a phantom price).
interface IPriceSource {
    function priceX96() external view returns (uint256);
}
