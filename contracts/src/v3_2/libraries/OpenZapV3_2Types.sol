// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice A standing, owner-signed authorization to run the frozen policy repeatedly on a fixed
///         cadence with a spot-derived per-run floor — everything `RecurringRelativeIntent` does —
///         PLUS a signed slice of every run's output that is converted into 0xZAPS and staked into
///         the protocol lottery pot as the OWNER's tickets.
///
///         WHY THIS IS ITS OWN INTENT: the pot already receives 20% of the 1% protocol fee, but that
///         is the PROTOCOL's slice and it is not the owner's choice. This intent makes buying 0xZAPS
///         a first-class, owner-authorized property of the execution itself: every run of a stacking
///         series is a real market buy of the token, sized by the owner, credited to the owner's
///         lottery position. Diverting value is exactly the kind of semantic that must be signed, so
///         it gets its own typehash and its own domain version rather than an extra field bolted onto
///         a shape users have already signed under "3.1".
///
/// @dev Field layout mirrors `RecurringRelativeIntent` one-for-one and APPENDS `stackPriceSource` +
///      `stackBps`. `seriesId` shares the zap's nonce namespace, so `invalidateNonce(seriesId)`
///      cancels the series and exhaustion consumes it — identical to every other recurring shape.
///      `executor == address(0)` leaves submission permissionless.
///
///      THE TWO FLOORS ARE SEPARATE AND BOTH SPOT-DERIVED. `priceSource` + `maxSlippageBps` floor
///      the RECIPIENT's leg exactly as in v3.1. `stackPriceSource` floors the 0xZAPS CONVERSION leg,
///      because a slice converted through a manipulated pool would hand the owner dust tickets in
///      exchange for real output — a value-loss path that an unfloored conversion leaves wide open.
///      When `outAsset` is already 0xZAPS there is no conversion leg at all: the slice is diverted
///      as-is, and `stackPriceSource` MUST then be `address(0)` (the capsule enforces both halves of
///      that iff, so a stale or mismatched source can never be carried along unused).
struct RecurringStackIntent {
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
    address priceSource; // allowlisted IOrientedPriceSource pricing the RECIPIENT leg's fresh floor
    uint32 maxSlippageBps; // owner's slippage band below live spot; MUST be > EXEC_FEE_BPS and < 10_000
    address stackPriceSource; // allowlisted IOrientedPriceSource pricing outAsset -> 0xZAPS; zero iff outAsset is 0xZAPS
    uint32 stackBps; // slice of each run's post-fee output converted to 0xZAPS; MUST be > 0 and < 10_000
}
