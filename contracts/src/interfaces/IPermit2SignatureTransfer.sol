// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Minimal Permit2 SignatureTransfer witness surface used by OpenZap.
/// @dev The signed Permit2 digest binds `msg.sender` as the spender. OpenZap constructs the transfer
///      destination and requested amount itself, so a submitter can relay the signatures but can
///      never become the spender or redirect the pull.
interface IPermit2SignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}
