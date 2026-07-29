// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ZapFeeVault } from "./ZapFeeVault.sol";

/// @notice One-time-bound deployment factory for immutable per-launch fee vaults.
contract ZapFeeVaultFactory {
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
        address creator,
        address protocolTreasury,
        address launchToken,
        address pairedAsset,
        address positionManager,
        uint16 creatorShareBps
    ) external returns (address vault) {
        if (msg.sender != launchpad) revert NotLaunchpad();
        vault = address(
            new ZapFeeVault{ salt: keccak256(abi.encode(launchToken)) }(
                name,
                symbol,
                msg.sender,
                creator,
                protocolTreasury,
                launchToken,
                pairedAsset,
                positionManager,
                creatorShareBps
            )
        );
    }
}
