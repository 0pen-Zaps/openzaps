// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

interface IPermit2AllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IRobinhoodUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title RobinhoodV4SwapAdapter
/// @notice Exact-input adapter for one immutable Robinhood Chain Bags/Uniswap-v4 pool.
/// @dev The Robinhood Universal Router uses a modified v4 exact-input struct with an extra
///      `minHopPriceX36` field. This adapter constructs that calldata itself and accepts no user
///      supplied routing bytes, preventing arbitrary-router-call policies. OpenZap performs the
///      owner-signed final-output/slippage check around this call.
contract RobinhoodV4SwapAdapter is IAdapter {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    bytes1 private constant V4_SWAP_COMMAND = 0x10;
    bytes3 private constant V4_ACTIONS = 0x060c0f;

    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable hooks;
    bytes32 public immutable poolId;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error InvalidCurrencyOrder();
    error UnsupportedToken(address token);
    error UnexpectedData();
    error ZeroAmount();
    error AmountTooLarge();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error NoOutput();
    error ResidualInput(uint256 expected, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(
        address universalRouter_,
        address permit2_,
        address currency0_,
        address currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        address hooks_
    ) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (
            universalRouter_ == address(0) || permit2_ == address(0) || currency0_ == address(0)
                || currency1_ == address(0) || hooks_ == address(0)
        ) revert ZeroAddress();
        if (currency0_ >= currency1_) revert InvalidCurrencyOrder();
        _requireCode(universalRouter_);
        _requireCode(permit2_);
        _requireCode(currency0_);
        _requireCode(currency1_);
        _requireCode(hooks_);

        universalRouter = universalRouter_;
        permit2 = permit2_;
        currency0 = currency0_;
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;
        poolId = keccak256(abi.encode(currency0_, currency1_, fee_, tickSpacing_, hooks_));
    }

    /// @inheritdoc IAdapter
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (data.length != 0) revert UnexpectedData();
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > type(uint128).max || amountIn > type(uint160).max) revert AmountTooLarge();
        if (tokenIn != currency0 && tokenIn != currency1) {
            revert UnsupportedToken(tokenIn);
        }
        tokenOut = tokenIn == currency0 ? currency1 : currency0;
        bool zeroForOne = tokenIn == currency0;

        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));
        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - inputBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        SafeApprove.approveExact(tokenIn, permit2, amountIn);
        IPermit2AllowanceTransfer(permit2).approve(tokenIn, universalRouter, uint160(amountIn), uint48(block.timestamp));

        PoolKey memory key =
            PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
        ExactInputSingleParams memory swap = ExactInputSingleParams({
            poolKey: key,
            zeroForOne: zeroForOne,
            amountIn: uint128(amountIn),
            amountOutMinimum: 0,
            minHopPriceX36: 0,
            hookData: bytes("")
        });

        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swap);
        actionParams[1] = abi.encode(tokenIn, amountIn);
        actionParams[2] = abi.encode(tokenOut, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(V4_ACTIONS), actionParams);
        IRobinhoodUniversalRouter(universalRouter).execute(abi.encodePacked(V4_SWAP_COMMAND), inputs, block.timestamp);

        // Revoke both legs of the Permit2 path before transferring output back to the zap.
        IPermit2AllowanceTransfer(permit2).approve(tokenIn, universalRouter, 0, 0);
        SafeApprove.approveExact(tokenIn, permit2, 0);

        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        if (inputAfter != inputBefore) revert ResidualInput(inputBefore, inputAfter);
        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        if (outputAfter <= outputBefore) revert NoOutput();
        amountOut = outputAfter - outputBefore;
        SafeApprove.safeTransfer(tokenOut, msg.sender, amountOut);
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
