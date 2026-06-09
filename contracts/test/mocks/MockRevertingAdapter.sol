// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../../src/interfaces/IAdapter.sol";

/// @notice Adapter that always reverts — used to prove approvals are reset on every revert path and
///         that a misbehaving adapter cannot strand state (invariant I-APPR-1).
contract MockRevertingAdapter is IAdapter {
    error AdapterReverted();

    function execute(address, uint256, bytes calldata) external pure override returns (address, uint256) {
        revert AdapterReverted();
    }
}
