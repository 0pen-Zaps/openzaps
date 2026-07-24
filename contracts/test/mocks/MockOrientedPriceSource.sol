// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IOrientedPriceSource} from "../../src/v3_1/interfaces/IOrientedPriceSource.sol";

/// @notice Test price source for the v3.1 relative-floor path: a settable Q96 price plus settable
///         `currency0`/`currency1` orientation. `setPrice(0)` makes it revert like a real source over
///         an uninitialized market (fail closed), mirroring `MockPriceSource`.
contract MockOrientedPriceSource is IOrientedPriceSource {
    uint256 private _priceX96;
    address public currency0;
    address public currency1;

    error PoolNotInitialized();

    constructor(address currency0_, address currency1_) {
        currency0 = currency0_;
        currency1 = currency1_;
    }

    function setPrice(uint256 p) external {
        _priceX96 = p;
    }

    /// @dev Escape hatch so a single test can point the source at an unrelated pair.
    function setCurrencies(address c0, address c1) external {
        currency0 = c0;
        currency1 = c1;
    }

    function priceX96() external view returns (uint256) {
        if (_priceX96 == 0) revert PoolNotInitialized();
        return _priceX96;
    }
}
