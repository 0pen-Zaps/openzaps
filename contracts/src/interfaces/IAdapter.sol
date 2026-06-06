// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IAdapter
/// @notice The single, fixed interface through which every OpenZap step reaches a DeFi protocol.
/// @dev This is the keystone of ADR-0001: a zap NEVER performs `target.call(arbitraryData)`. It only
///      ever calls `IAdapter(allowlistedAdapter).execute(...)` with a constant selector and a frozen
///      `data` blob set at deploy time. Because the selector is constant, allowlisting the adapter
///      address is equivalent to allowlisting the `(adapter, selector)` pair (invariant I-SURF-1).
///      The adapter pulls `amountIn` of `tokenIn` from the calling zap via an exact, same-call
///      approval, performs its frozen protocol action parameterised by `data`, and returns the output.
///      The zap does NOT trust the returned values for accounting — it measures balance deltas.
interface IAdapter {
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 amountOut);
}
