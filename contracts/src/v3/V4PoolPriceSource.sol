// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPriceSource} from "./interfaces/IPriceSource.sol";
import {V4PoolMath} from "../libraries/V4PoolMath.sol";

interface IV4StateReader {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title V4PoolPriceSource
/// @notice An `IPriceSource` pinned to ONE Uniswap-v4-style pool on ONE PoolManager — the price
///         oracle for trigger zaps on the live aeWETH ↔ 0xZAPS route. Reads `Pool.State.slot0`
///         directly via `extsload`, exactly as `ZapRangeVault` does, and converts the sqrt price to
///         Q96.
///
///         DIRECTION — READ THIS BEFORE SIGNING A TRIGGER AGAINST IT. `priceX96` is the Uniswap
///         orientation: units of currency1 per one unit of currency0 (on the live pool: 0xZAPS per
///         aeWETH). That means the feed FALLS when currency1 (0xZAPS) GAINS value. Any UI phrasing
///         a condition as a move of the TOKEN's price must invert the direction and use the
///         reciprocal magnitude (a +x token move is a x/(1+x) feed drop) — see
///         `feedConditionForZapsMove` in `src/lib/automate.ts`, which exists solely to do this.
/// @dev A spot pool price IS manipulable within a block; a trigger built on it must treat the
///      threshold as an ARMING condition, not a fair-value oracle. What keeps the funds safe is
///      that arming only unlocks the policy the owner already signed — fixed route, fixed amounts,
///      fixed recipient, owner-signed `minOut` floor — so the worst a manipulator can achieve is
///      running the owner's own trade at a moment the owner authorized ("if the market moves X%,
///      do THIS"), while paying the pool fees to move it. Fails closed: reverts while the pool is
///      uninitialized rather than reporting a phantom price.
contract V4PoolPriceSource is IPriceSource {
    /// @dev `StateLibrary.POOLS_SLOT` in v4-core (verified against the live PoolManager by the
    ///      ZapRangeVault fork suite this pattern is copied from).
    uint256 private constant POOLS_SLOT = 6;

    address public immutable poolManager;
    bytes32 public immutable poolId;

    error ZeroAddress();
    error NoCode(address target);
    error PoolNotInitialized();

    constructor(address poolManager_, bytes32 poolId_) {
        if (poolManager_ == address(0)) revert ZeroAddress();
        if (poolManager_.code.length == 0) revert NoCode(poolManager_);
        poolManager = poolManager_;
        poolId = poolId_;
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
