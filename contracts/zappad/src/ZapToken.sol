// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ZapToken
/// @notice A fixed-supply, ownerless launch token with no transfer hooks or taxes.
contract ZapToken is ERC20 {
    string public constant contractName = "ZapToken";
    string public constant contractVersion = "1.0.0";

    address public immutable creator;
    address public immutable launchpad;
    string public metadataURI;

    error NotLaunchpad();
    error ZeroAddress();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        uint256 supply_,
        address recipient_,
        address creator_,
        address launchpad_
    ) ERC20(name_, symbol_) {
        if (recipient_ == address(0) || creator_ == address(0) || launchpad_ == address(0)) {
            revert ZeroAddress();
        }
        launchpad = launchpad_;
        creator = creator_;
        metadataURI = metadataURI_;
        _mint(recipient_, supply_);
    }

    /// @dev Burns only launch-position rounding dust still held by the launchpad.
    function burnLaunchpadBalance(uint256 amount) external {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _burn(msg.sender, amount);
    }
}
