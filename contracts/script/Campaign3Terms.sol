// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Immutable schedule and economic constants for the October 2026
///         Campaign 3 release. Dates are UTC; the three-month window from Oct 15,
///         2026 to Jan 15, 2027 is 92 days, while every per-leg economic term
///         matches Campaign 2.
library Campaign3Terms {
    uint64 internal constant START_AT = 1_792_022_400; // 2026-10-15 00:00:00 UTC
    uint64 internal constant END_AT = 1_799_971_200; // 2027-01-15 00:00:00 UTC (exclusive)
    uint64 internal constant CLAIM_DEADLINE = 1_802_563_200; // 2027-02-14 00:00:00 UTC
    uint64 internal constant SWEEP_AFTER = 1_802_563_200; // 2027-02-14 00:00:00 UTC

    uint64 internal constant DURATION_SECONDS = 92 days;
    uint64 internal constant SWEEP_TAIL = 30 days;
    uint64 internal constant MIN_FUNDING_LEAD = 24 hours;

    uint256 internal constant STAKER_FEE_SHARES = 50e18;
    uint256 internal constant HOOK_BLOCKS_FEE_SHARES = 50e18;
    uint16 internal constant MIN_OUT_BPS = 9_700;
    uint256 internal constant MAX_BUY_WEI = 0.05 ether;
    uint256 internal constant MIN_BUY_WEI = 0.0005 ether;
}
