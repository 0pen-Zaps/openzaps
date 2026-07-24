// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../../src/interfaces/IAdapter.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @notice Test stand-in for the pinned pot buy adapter (the live one is RobinhoodV4SwapAdapter,
///         which takes NO data). Fixed output token and rate are set at construction; `data` must
///         be empty, matching the bounded-adapter calling convention `ZapLotteryPot` uses.
contract MockZapsBuyAdapter is IAdapter {
    address public immutable tokenOut;
    uint256 public immutable rate; // 1e18 = 1:1

    error UnexpectedData();

    constructor(address tokenOut_, uint256 rate_) {
        tokenOut = tokenOut_;
        rate = rate_;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        override
        returns (address, uint256)
    {
        if (data.length != 0) revert UnexpectedData();
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = (amountIn * rate) / 1e18;
        IERC20(tokenOut).transfer(msg.sender, amountOut);
        return (tokenOut, amountOut);
    }
}
