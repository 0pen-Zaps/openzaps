// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title TokenAllowlist
/// @notice Curated set of ERC-20s a zap may track or route (ADR-0001 / invariant I-TOK-1). v1 admits
///         only audited, standard-return, non-fee-on-transfer, non-rebasing tokens, because the
///         balance-delta postconditions that are the protocol's safety core assume honest accounting
///         (invariant I-TOK-2). "ERC-20-first" means *this vetted set*, not "any ERC-20".
/// @dev `owner` is intended to be a Safe multisig behind a TimelockController. Ownership uses a
///      two-step (propose/accept) handoff so a mistyped transfer cannot brick governance.
contract TokenAllowlist {
    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isAllowed;

    event TokenSet(address indexed token, bool allowed);
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

    function setToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        isAllowed[token] = allowed;
        emit TokenSet(token, allowed);
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
