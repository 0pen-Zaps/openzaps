// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice A standing, owner-signed authorization to run the frozen policy REPEATEDLY on a fixed
///         cadence, exactly like `RecurringIntent`, EXCEPT the per-run output floor is RELATIVE to
///         the pool's spot price read AT EXECUTION rather than a single absolute number frozen at
///         signing. A `RecurringIntent` bakes one `minOutPerRun` into the signature; over hours or
///         days the market drifts, and a floor that was fair when signed becomes either a run-blocking
///         over-ask (the bug this fixes: 0xZAPS appreciated, spot fell below the frozen floor, every
///         run reverted `MinOutNotMet`) or a stale under-ask. This intent instead names an
///         allowlisted `priceSource` and a `maxSlippageBps` band; every run computes a FRESH fair
///         floor from live spot: `floor = expectedAtSpot * (10_000 - maxSlippageBps) / 10_000`,
///         measured NET of the 1% executor fee (invariant I-FLOW-2), same as `minOutPerRun`.
/// @dev Field layout mirrors `RecurringIntent` one-for-one, with the trailing `minOutPerRun`
///      (uint256) REPLACED by `priceSource` (address) + `maxSlippageBps` (uint32). `seriesId` shares
///      the zap's nonce namespace, so `invalidateNonce(seriesId)` cancels the series and exhaustion
///      consumes it — identical to `RecurringIntent`. `executor == address(0)` leaves submission
///      permissionless. `priceSource` MUST be allowlisted in the SAME price-source registry the
///      trigger path uses, and MUST expose `currency0`/`currency1` (`IOrientedPriceSource`) so the
///      capsule can orient the floor; a source that cannot value the run's pair fails the run closed.
struct RecurringRelativeIntent {
    address zap;
    uint256 chainId;
    uint256 seriesId;
    uint64 validAfter; // first run is allowed at this timestamp
    uint64 deadline; // series end — no run may start after this
    uint64 interval; // seconds that must elapse between consecutive runs
    uint32 maxRuns; // total runs the signature authorizes
    address recipient;
    address executor; // address(0) => any submitter may execute a due run
    uint256 maxGas;
    uint256 maxFeePerGas;
    bytes32 policyHash;
    address outAsset;
    address priceSource; // allowlisted IOrientedPriceSource used to price the fresh per-run floor
    uint32 maxSlippageBps; // owner's slippage band below live spot; MUST be < 10_000
}
