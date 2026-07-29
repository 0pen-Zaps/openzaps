// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPermit2SignatureTransfer} from "../../src/interfaces/IPermit2SignatureTransfer.sol";
import {SafeApprove} from "../../src/libraries/SafeApprove.sol";

/// @notice Hermetic Permit2 SignatureTransfer witness mock.
/// @dev Reproduces the canonical Permit2 EIP-712 domain, witness type construction, implicit
///      `msg.sender` spender binding, unordered nonce bitmap, EOA/ERC-1271 verification, and token
///      pull needed by the OpenZap tests. It deliberately exposes no allowance-transfer surface.
contract MockPermit2SignatureTransfer is IPermit2SignatureTransfer {
    using SafeApprove for address;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 private constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address owner => mapping(uint256 word => uint256 bitmap)) public nonceBitmap;

    error PermitExpired();
    error InvalidAmount();
    error InvalidNonce();
    error InvalidSignature();
    error InvalidRecipient();

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        if (block.timestamp > permit.deadline) revert PermitExpired();
        if (transferDetails.to == address(0)) revert InvalidRecipient();
        if (transferDetails.requestedAmount > permit.permitted.amount) revert InvalidAmount();

        uint256 word = permit.nonce >> 8;
        uint256 bit = uint256(1) << uint8(permit.nonce);
        if (nonceBitmap[owner][word] & bit != 0) revert InvalidNonce();
        nonceBitmap[owner][word] |= bit;

        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount));
        bytes32 permitTypehash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                witnessTypeString
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(permitTypehash, tokenPermissionsHash, msg.sender, permit.nonce, permit.deadline, witness)
        );
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, address(this)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        _verify(owner, digest, signature);

        permit.permitted.token.safeTransferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }

    function _verify(address signer, bytes32 digest, bytes calldata signature) private view {
        if (signer.code.length != 0) {
            (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
            if (!(ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC)) {
                revert InvalidSignature();
            }
            return;
        }

        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N || (v != 27 && v != 28)) revert InvalidSignature();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();
    }
}
