// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title AdapterRegistry
/// @notice Global allowlist of adapter contracts a zap may call (ADR-0002). Because every adapter is
///         reached through the single fixed `IAdapter.execute` selector, allowlisting the address is
///         equivalent to allowlisting the `(adapter, selector)` pair (invariant I-SURF-1).
/// @dev `owner` is intended to be a Safe multisig behind a TimelockController — governance lives
///      AROUND zaps, never inside them. Removing an adapter here is a kill-switch: live zaps that
///      reference it will revert on `execute` and can only be drained via `emergencyExit`. Ownership
///      uses a two-step (propose/accept) handoff so a mistyped transfer cannot brick the kill-switch.
contract AdapterRegistry {
    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isAllowed;

    event AdapterSet(address indexed adapter, bool allowed);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        isAllowed[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    /// @notice Begin a two-step ownership transfer. Pass address(0) to cancel a pending transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete the transfer; only the pending owner can accept.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
