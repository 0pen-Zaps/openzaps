// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Minimal ERC-1271 contract wallet (Safe-like) for testing smart-wallet signers.
contract MockERC1271Wallet {
    address public immutable signer;
    bytes4 internal constant MAGIC = 0x1626ba7e;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(hash, v, r, s) == signer ? MAGIC : bytes4(0xffffffff);
    }
}
