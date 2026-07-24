// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPriceSource} from "../v3/interfaces/IPriceSource.sol";
import {IOrientedPriceSource} from "./interfaces/IOrientedPriceSource.sol";
import {V4PoolMath} from "../libraries/V4PoolMath.sol";

interface IV4StateReader {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title V4PoolPriceSourceOriented
/// @notice `V4PoolPriceSource` plus the two orientation getters the v3.1 relative-floor path needs.
///         Identical reading of one Uniswap-v4-style pool's `slot0` via `extsload` and the same
///         `sqrtPriceX96^2 / 2^96` conversion — the ONLY additions are the `currency0`/`currency1`
///         immutables and their getters (`IOrientedPriceSource`). Built as a NEW variant so the live
///         `V4PoolPriceSource` (still used by the trigger path) is left untouched.
///
///         DIRECTION — READ THIS BEFORE SIGNING A RELATIVE INTENT AGAINST IT. `priceX96` is the
///         Uniswap orientation: units of `currency1` per one unit of `currency0` (on the live pool:
///         0xZAPS per aeWETH, so `currency0 == aeWETH`, `currency1 == 0xZAPS`). The feed FALLS when
///         `currency1` GAINS value. `currency0`/`currency1` MUST be passed exactly as the pool key's
///         ordered token addresses that `poolId` was derived from — the capsule trusts them as the
///         pool's identity.
/// @dev A spot pool price IS manipulable within a block; the relative floor treats it as a fair-value
///      REFERENCE bounded by the owner's signed `maxSlippageBps`, not an oracle. Fails closed:
///      reverts while the pool is uninitialized rather than reporting a phantom price.
contract V4PoolPriceSourceOriented is IOrientedPriceSource {
    /// @dev `StateLibrary.POOLS_SLOT` in v4-core.
    uint256 private constant POOLS_SLOT = 6;

    address public immutable poolManager;
    bytes32 public immutable poolId;
    address public immutable currency0;
    address public immutable currency1;

    error ZeroAddress();
    error NoCode(address target);
    error PoolNotInitialized();
    error CurrenciesEqual();

    constructor(address poolManager_, bytes32 poolId_, address currency0_, address currency1_) {
        if (poolManager_ == address(0)) revert ZeroAddress();
        if (poolManager_.code.length == 0) revert NoCode(poolManager_);
        // currency0 may legitimately be address(0) on chains where native is the v4 currency0, but
        // the two currencies must differ or the pool key is nonsense.
        if (currency0_ == currency1_) revert CurrenciesEqual();
        poolManager = poolManager_;
        poolId = poolId_;
        currency0 = currency0_;
        currency1 = currency1_;
    }

    /// @notice The pool's current sqrt price, Q64.96.
    function sqrtPriceX96() public view returns (uint160 price) {
        bytes32 word = IV4StateReader(poolManager).extsload(keccak256(abi.encode(poolId, POOLS_SLOT)));
        // casting to 'uint160' is safe: slot0 packs sqrtPriceX96 in the low 160 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        price = uint160(uint256(word));
        if (price == 0) revert PoolNotInitialized();
    }

    /// @inheritdoc IPriceSource
    function priceX96() external view returns (uint256) {
        uint256 sqrtP = sqrtPriceX96();
        // price = sqrtP^2 / 2^96, computed with 512-bit precision so extreme ticks cannot overflow.
        return V4PoolMath.mulDiv(sqrtP, sqrtP, V4PoolMath.Q96);
    }
}
