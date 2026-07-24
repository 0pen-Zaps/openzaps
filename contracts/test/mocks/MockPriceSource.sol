// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPriceSource} from "../../src/v3/interfaces/IPriceSource.sol";

/// @notice Test price source with a settable Q96 price. `setPrice(0)` makes it revert like a real
///         source over an uninitialized market (fail closed).
contract MockPriceSource is IPriceSource {
    uint256 private _priceX96;

    error PoolNotInitialized();

    function setPrice(uint256 p) external {
        _priceX96 = p;
    }

    function priceX96() external view returns (uint256) {
        if (_priceX96 == 0) revert PoolNotInitialized();
        return _priceX96;
    }
}
