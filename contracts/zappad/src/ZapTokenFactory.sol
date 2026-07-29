// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ZapToken } from "./ZapToken.sol";

/// @notice One-time-bound deployment factory that keeps token creation code out
///         of the launchpad's EIP-170 runtime-size budget.
contract ZapTokenFactory {
    address public launchpad;
    address private _binder;

    event LaunchpadBound(address indexed launchpad);

    error NotBinder();
    error NotLaunchpad();
    error AlreadyBound();
    error InvalidLaunchpad();

    constructor() {
        _binder = msg.sender;
    }

    function bindLaunchpad(address launchpad_) external {
        if (msg.sender != _binder) revert NotBinder();
        if (launchpad != address(0)) revert AlreadyBound();
        if (launchpad_ == address(0) || launchpad_.code.length == 0) revert InvalidLaunchpad();
        launchpad = launchpad_;
        _binder = address(0);
        emit LaunchpadBound(launchpad_);
    }

    function deploy(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply,
        address creator,
        bytes32 userSalt
    ) external returns (address token) {
        if (msg.sender != launchpad) revert NotLaunchpad();
        token = address(
            new ZapToken{ salt: keccak256(abi.encode(creator, userSalt)) }(
                name, symbol, metadataURI, supply, msg.sender, creator, msg.sender
            )
        );
    }

    function tokenInitCodeHash(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply,
        address creator
    ) external view returns (bytes32) {
        return _tokenInitCodeHash(name, symbol, metadataURI, supply, creator);
    }

    function predictTokenAddress(
        address creator,
        bytes32 userSalt,
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply
    ) external view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                keccak256(abi.encode(creator, userSalt)),
                _tokenInitCodeHash(name, symbol, metadataURI, supply, creator)
            )
        );
        return address(uint160(uint256(hash)));
    }

    function _tokenInitCodeHash(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply,
        address creator
    ) private view returns (bytes32) {
        address target = launchpad;
        if (target == address(0)) revert InvalidLaunchpad();
        return keccak256(
            abi.encodePacked(
                type(ZapToken).creationCode,
                abi.encode(name, symbol, metadataURI, supply, target, creator, target)
            )
        );
    }
}
