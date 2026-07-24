// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice A standing, owner-signed authorization to run the frozen policy REPEATEDLY on a fixed
///         cadence. One signature covers the whole series; the clone enforces the cadence on-chain,
///         so any executor can submit a due run but nobody — including the executor — can run early,
///         run twice in a window, or outlive `maxRuns`/`deadline`.
/// @dev `seriesId` shares the zap's nonce namespace: consuming/invalidating it cancels the series.
///      `executor == address(0)` leaves submission permissionless (ADR-0004's trigger model);
///      a nonzero `executor` pins the series to one submitter. `minOutPerRun` is measured NET of
///      the protocol executor fee, mirroring v1/v2's net-of-fee `minOut` (invariant I-FLOW-2).
struct RecurringIntent {
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
    uint256 minOutPerRun; // net of executor fee, enforced on EVERY run
}

/// @notice A one-shot, owner-signed authorization gated by an on-chain price condition. The clone
///         reads `priceSource` (which must be allowlisted) at execution and refuses to run unless
///         the market has actually moved past the signed threshold — the executor picks the moment,
///         the chain verifies the moment (ADR-0004: permissionless, on-chain-conditioned).
/// @dev Condition: `above == true`  => current >= baseline * (10_000 + thresholdBps) / 10_000
///                 `above == false` => current <= baseline * (10_000 - thresholdBps) / 10_000
///      Both prices are Q96 values from the SAME source, so scale cancels. A fired trigger consumes
///      its nonce; re-arming requires a fresh signature.
struct TriggerIntent {
    address zap;
    uint256 chainId;
    uint256 nonce;
    uint64 validAfter;
    uint64 deadline;
    address priceSource; // must be allowlisted in the factory's price-source registry
    uint256 baselinePriceX96; // reference price frozen into the signature
    uint32 thresholdBps; // move size that arms the trigger, in basis points of baseline
    bool above; // direction: true = fire on rise, false = fire on fall
    address recipient;
    address executor; // address(0) => permissionless submission
    uint256 maxGas;
    uint256 maxFeePerGas;
    bytes32 policyHash;
    address outAsset;
    uint256 minOut; // net of executor fee
}
