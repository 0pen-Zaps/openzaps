// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ZapFeeVaultFactory } from "./ZapFeeVaultFactory.sol";
import { ZapPadLaunchpad } from "./ZapPadLaunchpad.sol";
import { ZapTokenFactory } from "./ZapTokenFactory.sol";

/// @title ZapPadBootstrap
/// @notice Atomically deploys and irreversibly binds a complete ZapPad stack.
/// @dev This contract is only an immutable deployment record after construction.
contract ZapPadBootstrap {
    address public immutable tokenFactory;
    address public immutable feeVaultFactory;
    address public immutable launchpad;

    constructor(
        address protocolTreasury,
        address positionManager,
        address swapRouter,
        address weth,
        address usdg
    ) {
        ZapTokenFactory tokenFactory_ = new ZapTokenFactory();
        ZapFeeVaultFactory feeVaultFactory_ = new ZapFeeVaultFactory();
        ZapPadLaunchpad launchpad_ = new ZapPadLaunchpad(
            protocolTreasury,
            address(tokenFactory_),
            address(feeVaultFactory_),
            positionManager,
            swapRouter,
            weth,
            usdg
        );

        tokenFactory_.bindLaunchpad(address(launchpad_));
        feeVaultFactory_.bindLaunchpad(address(launchpad_));

        tokenFactory = address(tokenFactory_);
        feeVaultFactory = address(feeVaultFactory_);
        launchpad = address(launchpad_);
    }
}
