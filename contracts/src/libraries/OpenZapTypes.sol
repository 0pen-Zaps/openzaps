// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice One frozen action in a zap's fixed action graph.
/// @dev `adapter` must be allowlisted; `data` is the frozen route parameters; the zap approves
///      exactly `amountIn` of `tokenIn` to `spender` for the duration of this single call only.
struct Step {
    address adapter;
    address tokenIn; // address(0) => no token approval needed for this step
    address spender; // who receives the exact approval (normally == adapter)
    uint256 amountIn;
    bytes data;
}

/// @notice The complete, immutable policy a zap is deployed with. Hashed to `policyHash` at init.
/// @dev `optimization` MUST be true in v1 (ADR-0004 defers protective/liquidation zaps).
struct Policy {
    address owner; // creation + revocation + emergency-exit authority
    address recipient; // the single allowed final recipient
    uint256 maxRelayerFeeCap; // hard policy ceiling; a per-run intent fee must be <= this
    bool optimization;
    address[] trackedAssets;
    Step[] steps;
}

/// @notice The per-run, owner-signed authorization (EIP-712). Binds every field that would
///         otherwise hand the submitter optionality (invariant I-AUTH-4): recipient, fee cap,
///         gas, deadline, route output, and min-out.
struct OpenZapIntent {
    address zap;
    uint256 chainId;
    uint256 nonce;
    uint64 validAfter;
    uint64 deadline;
    address recipient;
    address relayer;
    uint256 maxRelayerFee;
    uint256 maxGas;
    uint256 maxFeePerGas;
    bytes32 policyHash;
    address outAsset;
    uint256 minOut; // measured NET of relayer fee (invariant I-FLOW-2)
}
