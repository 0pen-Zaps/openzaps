// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @dev Uniswap `SwapRouter02` on Base (0x2626664c2603336E57B271c5C0b26F421741e481). Note this is the
///      `02` shape: `ExactInputSingleParams` has NO `deadline` member (deadline moved to the
///      multicall wrapper, which this adapter never uses). Verified on a Base fork: the router's
///      runtime code contains selector 0x04e45aaf and not 0x414bf389.
interface IUniswapV3SwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    function factory() external view returns (address);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @title BaseV3SwapAdapter
/// @notice Exact-input, single-hop adapter for exactly ONE immutable Uniswap-v3 pool on Base.
/// @dev One deployed instance == one pool == one action. The router, the token pair and the fee tier
///      are immutable constructor arguments, so allowlisting this adapter address in
///      `AdapterRegistry` is equivalent to allowlisting "swap between these two tokens in this pool"
///      (invariant I-SURF-1).
///
///      What this adapter deliberately REFUSES to do:
///      - It refuses arbitrary calldata. `data` is exactly 32 bytes and decodes to a single
///        `uint256 amountOutMinimum`. There is no target address, no selector, no router command
///        string, no path, no hook blob. A caller cannot steer this adapter at another contract.
///      - It refuses a zero floor. `amountOutMinimum == 0` reverts. OpenZap's owner-signed
///        final-output check wraps the whole chain, but a step that would accept any output at all is
///        a standing MEV invitation, so the adapter keeps its own floor and re-checks the *measured*
///        delta against it rather than trusting the router's return value.
///      - It refuses tokens outside its pair. `tokenIn` must be `token0` or `token1`; direction is
///        derived from it, never passed in.
///      - It refuses native ETH. There is no `receive()`/`fallback()` and `exactInputSingle` is
///        called with zero value; WETH is an ordinary ERC-20 here and is never unwrapped.
///      - It refuses to hold anything. Input must be fully consumed, output is swept to `msg.sender`
///        in the same call, and the router allowance is set back to zero before the sweep.
///      - It refuses to run anywhere but Base. Both the constructor and `execute` check
///        `block.chainid == 8453`.
contract BaseV3SwapAdapter is IAdapter {
    uint256 public constant BASE_CHAIN_ID = 8453;

    address public immutable swapRouter;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    /// @notice The single pool this adapter is pinned to, resolved from the router's own factory.
    address public immutable pool;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error InvalidTokenOrder();
    error PoolNotFound(address tokenA, address tokenB, uint24 fee);
    error UnsupportedToken(address token);
    error InvalidData(uint256 length);
    error ZeroAmount();
    error ZeroMinimumOut();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error ResidualInput(uint256 expected, uint256 actual);
    error InsufficientOutput(uint256 measured, uint256 minimum);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param swapRouter_ Uniswap SwapRouter02 on Base.
    /// @param tokenA_ One side of the pair; must sort strictly below `tokenB_`.
    /// @param tokenB_ The other side of the pair.
    /// @param fee_ The v3 fee tier (e.g. 500 for 0.05%).
    constructor(address swapRouter_, address tokenA_, address tokenB_, uint24 fee_) {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (swapRouter_ == address(0) || tokenA_ == address(0) || tokenB_ == address(0)) revert ZeroAddress();
        if (tokenA_ >= tokenB_) revert InvalidTokenOrder();
        _requireCode(swapRouter_);
        _requireCode(tokenA_);
        _requireCode(tokenB_);

        // Resolve the pool through the router's OWN factory, so the adapter cannot be pinned to a
        // pool that the configured router would never route through.
        address factory = IUniswapV3SwapRouter02(swapRouter_).factory();
        if (factory == address(0)) revert ZeroAddress();
        address pool_ = IUniswapV3Factory(factory).getPool(tokenA_, tokenB_, fee_);
        if (pool_ == address(0)) revert PoolNotFound(tokenA_, tokenB_, fee_);
        _requireCode(pool_);

        swapRouter = swapRouter_;
        token0 = tokenA_;
        token1 = tokenB_;
        fee = fee_;
        pool = pool_;
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn Must be `token0` or `token1`; it alone decides the swap direction.
    /// @param amountIn Exact input amount, pulled from `msg.sender` (the zap).
    /// @param data `abi.encode(uint256 amountOutMinimum)` and nothing else. `uint256` rather than a
    ///        packed `uint128` because it is forwarded verbatim into SwapRouter02's `uint256`
    ///        `amountOutMinimum` field: a narrower type would need a widening cast and would impose a
    ///        bound the protocol itself does not have, for no safety gain.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (data.length != 32) revert InvalidData(data.length);
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn != token0 && tokenIn != token1) revert UnsupportedToken(tokenIn);

        uint256 amountOutMinimum = abi.decode(data, (uint256));
        if (amountOutMinimum == 0) revert ZeroMinimumOut();

        tokenOut = tokenIn == token0 ? token1 : token0;

        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));

        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - inputBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        SafeApprove.approveExact(tokenIn, swapRouter, amountIn);
        IUniswapV3SwapRouter02(swapRouter)
            .exactInputSingle(
                IUniswapV3SwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            );
        // Unconditionally clear the allowance, whatever the router did or did not consume.
        SafeApprove.approveExact(tokenIn, swapRouter, 0);

        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        if (inputAfter != inputBefore) revert ResidualInput(inputBefore, inputAfter);

        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        // Measured, not reported: the router's return value is discarded on purpose.
        amountOut = outputAfter - outputBefore;
        if (amountOut < amountOutMinimum) revert InsufficientOutput(amountOut, amountOutMinimum);

        SafeApprove.safeTransfer(tokenOut, msg.sender, amountOut);
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
