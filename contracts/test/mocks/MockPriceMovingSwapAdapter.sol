// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../../src/interfaces/IAdapter.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

interface ISettablePriceSource {
    function setPrice(uint256 p) external;
}

/// @notice Test adapter that performs a `rate`-scaled swap AND moves a price source AS A SIDE EFFECT
///         of the swap. Lets a test prove the capsule samples spot BEFORE `_runSteps` (the
///         spot-before-swap invariant): the capsule's pre-swap read sees the OLD price, while this
///         adapter overwrites it to `postSwapPriceX96` mid-run. If the read were relocated to after
///         the swap, it would observe `postSwapPriceX96` instead.
/// @dev `data = abi.encode(tokenOut, rate, priceSource, postSwapPriceX96)`.
contract MockPriceMovingSwapAdapter is IAdapter {
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        override
        returns (address tokenOut, uint256 amountOut)
    {
        (address out, uint256 rate, address priceSource, uint256 postSwapPriceX96) =
            abi.decode(data, (address, uint256, address, uint256));
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rate) / 1e18;
        // Move the pool price as a side effect of executing the swap.
        ISettablePriceSource(priceSource).setPrice(postSwapPriceX96);
        IERC20(out).transfer(msg.sender, amountOut);
        tokenOut = out;
    }
}
