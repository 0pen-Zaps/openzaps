// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library ReviewedArtifact {
    error MissingExpectedHash();
    error RawHashMismatch(bytes32 expected, bytes32 actual);

    function requireExpectedHash(string memory raw, bytes32 expected) internal pure returns (bytes32 actual) {
        if (expected == bytes32(0)) revert MissingExpectedHash();
        actual = keccak256(bytes(raw));
        if (actual != expected) revert RawHashMismatch(expected, actual);
    }
}
