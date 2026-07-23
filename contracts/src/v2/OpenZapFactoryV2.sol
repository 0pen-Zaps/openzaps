// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {OpenZapV2} from "./OpenZapV2.sol";
import {AdapterRegistry} from "../AdapterRegistry.sol";
import {TokenAllowlist} from "../TokenAllowlist.sol";
import {Policy} from "../libraries/OpenZapTypes.sol";

/// @title OpenZapFactoryV2
/// @notice UNAUDITED v2 CANDIDATE factory. Byte-for-byte the deployment machinery of the live v1.1
///         `OpenZapFactory`, pointed at the `OpenZapV2` implementation. It deploys the single hardened
///         implementation in its own constructor, so the implementation can pin this factory as its
///         sole initializer (FACTORY immutable) — that, plus deterministic CREATE2 addresses and
///         atomic deploy-then-init, closes the clone-init front-running window (invariant I-ISO-3).
/// @dev A v2 zap deployed here is entirely independent of any v1.1 zap: different implementation,
///      different `implCodeHash`, different clone addresses. This factory MUST NOT replace the live
///      v1.1 factory. `implCodeHash` is published so Hermes can verify a discovered zap's
///      implementation against the approved release manifest before ever submitting to it.
contract OpenZapFactoryV2 {
    string public constant VERSION = "2.0.0-candidate";

    address public immutable implementation;
    AdapterRegistry public immutable adapters;
    TokenAllowlist public immutable tokens;
    bytes32 public immutable implCodeHash;

    event ZapCreated(
        address indexed zap, address indexed owner, bytes32 policyHash, bytes32 implCodeHash, bytes32 salt
    );

    error CloneFailed();

    constructor(AdapterRegistry adapters_, TokenAllowlist tokens_) {
        adapters = adapters_;
        tokens = tokens_;
        OpenZapV2 impl = new OpenZapV2(address(this), adapters_, tokens_);
        implementation = address(impl);
        implCodeHash = address(impl).codehash;
    }

    /// @notice Deploy and atomically initialize a new immutable v2 zap for `p`.
    /// @dev The CREATE2 salt is bound to the FULL policy (`keccak256(abi.encode(p, salt))`), so a
    ///      predicted (predict-then-fund) address can only ever be occupied by that exact policy —
    ///      including its `owner`, `recipient`, and the balance-relative/fixed shape of every step.
    ///      An attacker front-running with a different policy deploys to a different, un-funded address
    ///      and cannot hijack a victim's deposit (I-ISO-3).
    function createZap(Policy calldata p, bytes32 salt) external returns (address zap) {
        zap = _cloneDeterministic(implementation, keccak256(abi.encode(p, salt)));
        OpenZapV2(payable(zap)).initialize(p);
        emit ZapCreated(zap, p.owner, OpenZapV2(payable(zap)).policyHash(), implCodeHash, salt);
    }

    /// @notice Predict the address `(p, salt)` will deploy to (for off-chain discovery / funding).
    /// @dev Must be called with the SAME policy that will be deployed — the address is policy-bound.
    function predict(Policy calldata p, bytes32 salt) external view returns (address) {
        return _predict(implementation, keccak256(abi.encode(p, salt)), address(this));
    }

    // EIP-1167 minimal proxy, CREATE2 (OZ Clones layout).
    function _cloneDeterministic(address impl, bytes32 salt) internal returns (address addr) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            addr := create2(0, ptr, 0x37, salt)
        }
        if (addr == address(0)) revert CloneFailed();
    }

    function _predict(address impl, bytes32 salt, address deployer) internal pure returns (address predicted) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf3ff00000000000000000000000000000000)
            mstore(add(ptr, 0x38), shl(0x60, deployer))
            mstore(add(ptr, 0x4c), salt)
            mstore(add(ptr, 0x6c), keccak256(ptr, 0x37))
            predicted := and(keccak256(add(ptr, 0x37), 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
