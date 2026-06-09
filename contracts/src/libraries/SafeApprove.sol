// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title SafeApprove
/// @notice Exact-approval and transfer helpers tolerant of non-standard ERC-20s (missing/`false`
///         return values, e.g. USDT-like). Underpins invariants I-APPR-1/2/3.
/// @dev Approvals are always set to an exact amount and reset to zero in the same transaction by the
///      caller, so the classic "must zero before re-approve" race does not arise within a step.
library SafeApprove {
    error ApproveFailed();
    error TransferFailed();

    function approveExact(address token, address spender, uint256 amount) internal {
        // approve(address,uint256)
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!(ok && (ret.length == 0 || abi.decode(ret, (bool))))) revert ApproveFailed();
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        // transfer(address,uint256)
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!(ok && (ret.length == 0 || abi.decode(ret, (bool))))) revert TransferFailed();
    }
}
