// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../../src/interfaces/IAdapter.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @notice Test adapter: pulls `amountIn` of `tokenIn` from the calling zap and pays out
///         `amountIn * rate / 1e18` of a pre-funded `tokenOut`. `data = abi.encode(tokenOut, rate)`.
contract MockSwapAdapter is IAdapter {
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        override
        returns (address tokenOut, uint256 amountOut)
    {
        uint256 rate;
        (tokenOut, rate) = abi.decode(data, (address, uint256));
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rate) / 1e18;
        IERC20(tokenOut).transfer(msg.sender, amountOut);
    }
}
