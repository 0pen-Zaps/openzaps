// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ISafe } from "../../src/interfaces/ISafe.sol";

contract MockSafeProxy {
    address internal singleton;

    constructor(address singleton_) {
        singleton = singleton_;
    }

    fallback() external payable {
        if (msg.sig == ISafe.masterCopy.selector) {
            address masterCopy = singleton;
            assembly {
                mstore(0, masterCopy)
                return(0, 0x20)
            }
        }
        address implementation = singleton;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(success) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

contract MockSafeProxyFactory {
    address public lastSingleton;
    bytes public lastInitializer;
    uint256 public lastSaltNonce;

    function proxyCreationCode() external pure returns (bytes memory) {
        return type(MockSafeProxy).creationCode;
    }

    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy)
    {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        proxy = address(new MockSafeProxy{ salt: salt }(singleton));
        (bool success,) = proxy.call(initializer);
        require(success, "INITIALIZER_FAILED");
        lastSingleton = singleton;
        lastInitializer = initializer;
        lastSaltNonce = saltNonce;
    }
}

contract MockSafeSingleton {
    address internal singletonSlot;
    address[] private _owners;
    uint256 private _threshold;
    uint256 public nonce;

    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    function VERSION() external pure returns (string memory) {
        return "1.4.1";
    }

    function getChainId() external view returns (uint256) {
        return block.chainid;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getModulesPaginated(address start, uint256)
        external
        pure
        returns (address[] memory modules, address next)
    {
        require(start == address(0x1), "INVALID_START");
        modules = new address[](0);
        next = address(0x1);
    }

    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external {
        require(_threshold == 0, "ALREADY_SETUP");
        require(to == address(0) && data.length == 0, "MODULE_SETUP");
        require(paymentToken == address(0) && payment == 0 && paymentReceiver == address(0), "PAYMENT_SETUP");
        _owners = owners;
        _threshold = threshold;
        bytes32 slot = FALLBACK_HANDLER_STORAGE_SLOT;
        assembly {
            sstore(slot, fallbackHandler)
        }
    }

    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory data) {
        data = new bytes(length * 32);
        for (uint256 i; i < length; ++i) {
            bytes32 value;
            assembly {
                value := sload(add(offset, i))
                mstore(add(add(data, 0x20), mul(i, 0x20)), value)
            }
        }
    }

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 safeNonce
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                to,
                value,
                keccak256(data),
                operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                safeNonce
            )
        );
    }

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes calldata
    ) external payable returns (bool success) {
        require(operation == 0, "ONLY_CALL");
        bool owner;
        for (uint256 i; i < _owners.length; ++i) {
            if (_owners[i] == msg.sender) owner = true;
        }
        require(owner, "NOT_OWNER");
        ++nonce;
        (success,) = to.call{ value: value }(data);
        require(success, "EXECUTION_FAILED");
    }
}
