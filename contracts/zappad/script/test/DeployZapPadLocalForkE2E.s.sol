// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { DeployZapPad } from "../DeployZapPad.s.sol";

/// @notice Browser-test-only wrapper for the pinned historical Robinhood fork.
/// @dev This contract cannot run at the current mainnet height and is not a
/// production treasury-policy bypass.
contract DeployZapPadLocalForkE2E is DeployZapPad {
    uint256 internal constant LAST_ALLOWED_HISTORICAL_FORK_BLOCK = 21_955_380;
    bytes32 internal constant LOCAL_E2E_EVIDENCE_SENTINEL = keccak256("ZAPPAD_LOCAL_FORK_E2E_ONLY");

    error HistoricalForkOnly();
    error ExpectedUnlockedTestTreasury();

    function _verifyTreasury(address treasury) internal view override {
        if (block.number > LAST_ALLOWED_HISTORICAL_FORK_BLOCK) revert HistoricalForkOnly();
        if (treasury == address(0)) revert ExpectedUnlockedTestTreasury();
    }

    function _safeDeploymentEvidenceHash(address) internal view override returns (bytes32) {
        if (block.number > LAST_ALLOWED_HISTORICAL_FORK_BLOCK) revert HistoricalForkOnly();
        return LOCAL_E2E_EVIDENCE_SENTINEL;
    }
}
