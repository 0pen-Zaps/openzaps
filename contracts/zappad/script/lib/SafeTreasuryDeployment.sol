// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ISafe, ISafeProxyFactory } from "../../src/interfaces/ISafe.sol";

library SafeTreasuryDeployment {
    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    bytes32 internal constant GUARD_STORAGE_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant SAFE_VERSION_HASH = keccak256("1.4.1");
    address internal constant SENTINEL_OWNERS = address(0x1);

    error EmptyOwners();
    error InvalidThreshold();
    error InvalidOwner(address owner);
    error DuplicateOwner(address owner);
    error ExistingProxy(address predicted);
    error ProxyAddressMismatch(address predicted, address actual);
    error SafeReadbackMismatch(bytes32 field);

    function validateConfig(address[] memory owners, uint256 threshold) internal pure {
        uint256 length = owners.length;
        if (length == 0) revert EmptyOwners();
        if (threshold == 0 || threshold > length) revert InvalidThreshold();

        for (uint256 i; i < length; ++i) {
            address owner = owners[i];
            if (owner == address(0) || owner == SENTINEL_OWNERS) revert InvalidOwner(owner);
            for (uint256 j; j < i; ++j) {
                if (owners[j] == owner) revert DuplicateOwner(owner);
            }
        }
    }

    function initializer(address[] memory owners, uint256 threshold, address fallbackHandler)
        internal
        pure
        returns (bytes memory)
    {
        validateConfig(owners, threshold);
        if (fallbackHandler == address(0)) revert SafeReadbackMismatch("fallbackHandler");
        return abi.encodeCall(
            ISafe.setup,
            (owners, threshold, address(0), bytes(""), fallbackHandler, address(0), 0, payable(address(0)))
        );
    }

    function create2Salt(bytes memory setupData, uint256 saltNonce) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(keccak256(setupData), saltNonce));
    }

    function deploymentCodeHash(address factory, address singleton) internal pure returns (bytes32) {
        bytes memory creationCode = ISafeProxyFactory(factory).proxyCreationCode();
        return keccak256(abi.encodePacked(creationCode, uint256(uint160(singleton))));
    }

    function predict(address factory, address singleton, bytes memory setupData, uint256 saltNonce)
        internal
        view
        returns (address predicted)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                factory,
                create2Salt(setupData, saltNonce),
                deploymentCodeHash(factory, singleton)
            )
        );
        predicted = address(uint160(uint256(digest)));
    }

    function requireFresh(address predicted) internal view {
        if (predicted.code.length != 0) revert ExistingProxy(predicted);
    }

    function verify(
        address safeAddress,
        address predicted,
        address singleton,
        address fallbackHandler,
        address[] memory expectedOwners,
        uint256 expectedThreshold,
        uint256 expectedChainId,
        bool requireFreshNonce
    ) internal view {
        if (safeAddress != predicted) {
            revert ProxyAddressMismatch(predicted, safeAddress);
        }
        if (safeAddress.code.length == 0) revert SafeReadbackMismatch("code");

        ISafe safe = ISafe(safeAddress);
        if (safe.masterCopy() != singleton) revert SafeReadbackMismatch("singleton");
        if (keccak256(bytes(safe.VERSION())) != SAFE_VERSION_HASH) {
            revert SafeReadbackMismatch("version");
        }
        if (safe.getChainId() != expectedChainId) revert SafeReadbackMismatch("chainId");
        if (safe.getThreshold() != expectedThreshold) revert SafeReadbackMismatch("threshold");
        if (requireFreshNonce && safe.nonce() != 0) revert SafeReadbackMismatch("nonce");
        if (_fallbackHandler(safe) != fallbackHandler) {
            revert SafeReadbackMismatch("fallbackHandler");
        }
        if (_storageAddress(safe, GUARD_STORAGE_SLOT) != address(0)) {
            revert SafeReadbackMismatch("guard");
        }
        (address[] memory modules, address next) = safe.getModulesPaginated(SENTINEL_OWNERS, 1);
        if (modules.length != 0 || next != SENTINEL_OWNERS) {
            revert SafeReadbackMismatch("modules");
        }

        address[] memory actualOwners = safe.getOwners();
        if (actualOwners.length != expectedOwners.length) revert SafeReadbackMismatch("ownerCount");
        for (uint256 i; i < expectedOwners.length; ++i) {
            bool found;
            for (uint256 j; j < actualOwners.length; ++j) {
                if (actualOwners[j] == expectedOwners[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) revert SafeReadbackMismatch("owners");
        }
    }

    function _fallbackHandler(ISafe safe) private view returns (address handler) {
        handler = _storageAddress(safe, FALLBACK_HANDLER_STORAGE_SLOT);
    }

    function _storageAddress(ISafe safe, bytes32 slot) private view returns (address valueAddress) {
        bytes memory value = safe.getStorageAt(uint256(slot), 1);
        if (value.length != 32) revert SafeReadbackMismatch("storageLength");
        valueAddress = abi.decode(value, (address));
    }
}
