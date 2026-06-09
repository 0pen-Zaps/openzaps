// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../../src/interfaces/IAdapter.sol";
import {OpenZap} from "../../src/OpenZap.sol";
import {OpenZapIntent} from "../../src/libraries/OpenZapTypes.sol";

/// @notice Adapter that attempts to re-enter the calling zap's `execute` mid-step. The re-entry must
///         be rejected by the reentrancy guard before any state change (invariant I-AUTH-1).
contract MockReentrantAdapter is IAdapter {
    function execute(address, uint256, bytes calldata) external override returns (address, uint256) {
        OpenZapIntent memory dummy;
        OpenZap(payable(msg.sender)).execute(dummy, ""); // reverts Reentrancy() -> bubbles up
        return (address(0), 0);
    }
}
