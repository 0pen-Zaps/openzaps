// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Immutable schedule and economic constants for the October 2026
///         Campaign 3 release. Dates are UTC; the explicit Oct 1–31 window is
///         31 days, while every per-leg economic term matches Campaign 2.
library Campaign3Terms {
    uint64 internal constant START_AT = 1_790_812_800; // 2026-10-01 00:00:00 UTC
    uint64 internal constant END_AT = 1_793_491_200; // 2026-11-01 00:00:00 UTC (exclusive)
    uint64 internal constant CLAIM_DEADLINE = 1_796_083_200; // 2026-12-01 00:00:00 UTC
    uint64 internal constant SWEEP_AFTER = 1_796_083_200; // 2026-12-01 00:00:00 UTC

    uint64 internal constant DURATION_SECONDS = 31 days;
    uint64 internal constant SWEEP_TAIL = 30 days;
    uint64 internal constant MIN_FUNDING_LEAD = 24 hours;

    uint256 internal constant STAKER_FEE_SHARES = 50e18;
    uint256 internal constant HOOK_BLOCKS_FEE_SHARES = 50e18;
    uint16 internal constant MIN_OUT_BPS = 9_700;
    uint256 internal constant MAX_BUY_WEI = 0.05 ether;
    uint256 internal constant MIN_BUY_WEI = 0.0005 ether;
}
