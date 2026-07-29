// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {OpenZapV3_2} from "./OpenZapV3_2.sol";
import {AdapterRegistry} from "../AdapterRegistry.sol";
import {TokenAllowlist} from "../TokenAllowlist.sol";
import {ZapLotteryPot} from "../v3/ZapLotteryPot.sol";
import {Policy} from "../libraries/OpenZapTypes.sol";

/// @title OpenZapFactoryV3_2
/// @notice UNAUDITED v3.2 CANDIDATE factory. Byte-for-byte the deployment machinery of
///         `OpenZapFactoryV3_1`, only pointed at the `OpenZapV3_2` implementation (which adds the
///         recurring-stack path). Every clone is registered with the protocol `ZapLotteryPot` at
///         creation — the same wiring that authorizes that clone, and nothing else, to record
///         lottery contributions when its executor fee settles AND when a stack slice is staked.
/// @dev Deployment order: pot first, then this factory (pot address in the constructor), then
///      `pot.setFactory(this)` — createZap reverts until that wiring completes (fail-closed default).
///      A v3.2 factory uses its OWN pot instance: `ZapLotteryPot.setFactory` is one-shot, so a single
///      pot cannot back a v3, a v3.1, and a v3.2 factory. This factory MUST NOT replace the live one.
/// @dev That own-pot requirement is load-bearing for the stack path specifically: a stacking clone
///      stakes real 0xZAPS into `lotteryPot`'s current round, so the pot it registers with must be
///      the same pot whose `ZAPS`/`BUY_ADAPTER` the implementation was pinned to. Reading both from
///      `lotteryPot_` below is what guarantees that, without relying on deployment discipline.
contract OpenZapFactoryV3_2 {
    string public constant VERSION = "3.2.0-candidate";

    address public immutable implementation;
    AdapterRegistry public immutable adapters;
    TokenAllowlist public immutable tokens;
    AdapterRegistry public immutable priceSources;
    ZapLotteryPot public immutable lotteryPot;
    bytes32 public immutable implCodeHash;

    event ZapCreated(
        address indexed zap, address indexed owner, bytes32 policyHash, bytes32 implCodeHash, bytes32 salt
    );

    error CloneFailed();
    error ZeroAddress();

    constructor(
        AdapterRegistry adapters_,
        TokenAllowlist tokens_,
        AdapterRegistry priceSources_,
        ZapLotteryPot lotteryPot_
    ) {
        if (address(priceSources_) == address(0) || address(lotteryPot_) == address(0)) {
            revert ZeroAddress();
        }
        adapters = adapters_;
        tokens = tokens_;
        priceSources = priceSources_;
        lotteryPot = lotteryPot_;
        // The stack leg's token and conversion adapter are READ FROM THE POT rather than passed in.
        // A clone that staked a different "0xZAPS" than the pot pays out, or converted through a
        // different adapter than the pot's own `buyZaps`, would be a silent divergence no test of this
        // factory alone would catch. Sourcing both from the pot makes that mismatch unconstructible.
        OpenZapV3_2 impl = new OpenZapV3_2(
            address(this),
            adapters_,
            tokens_,
            priceSources_,
            address(lotteryPot_),
            lotteryPot_.ZAPS(),
            lotteryPot_.BUY_ADAPTER()
        );
        implementation = address(impl);
        implCodeHash = address(impl).codehash;
    }

    /// @notice Deploy, atomically initialize, and pot-register a new immutable v3.2 zap for `p`.
    /// @dev CREATE2 salt is bound to the FULL policy exactly as in v2/v3 (I-ISO-3).
    function createZap(Policy calldata p, bytes32 salt) external returns (address zap) {
        zap = _cloneDeterministic(implementation, keccak256(abi.encode(p, salt)));
        OpenZapV3_2(payable(zap)).initialize(p);
        lotteryPot.registerZap(zap);
        emit ZapCreated(zap, p.owner, OpenZapV3_2(payable(zap)).policyHash(), implCodeHash, salt);
    }

    /// @notice Predict the address `(p, salt)` will deploy to (for off-chain discovery / funding).
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
