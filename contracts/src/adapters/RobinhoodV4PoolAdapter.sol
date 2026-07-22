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

/// @title RobinhoodV4PoolAdapter
/// @notice Exact-input adapter for ONE Uniswap-v4 pool on Robinhood Chain, where the pool is chosen
///         at deploy time instead of being hardcoded in the source.
/// @dev This is `RobinhoodV4SwapAdapter` with the PoolKey lifted into constructor immutables:
///      `currency0`, `currency1`, `fee`, `tickSpacing` and `hooks`. One deployment still serves
///      exactly one pool — deploy a second instance for a second pool. The security shape is
///      deliberately identical to the hardcoded adapter:
///
///      - ONE fixed `IAdapter.execute` selector, so allowlisting this address in `AdapterRegistry`
///        is equivalent to allowlisting the single action "exact-input swap through this one pool".
///      - The adapter builds the Universal Router `commands`/`inputs` itself. It is immutable
///        calldata derived only from constructor immutables and the caller's `amountIn`.
///      - `amountOut` is the MEASURED balance delta of this contract, never a number the router
///        reported.
///
///      Robinhood's Universal Router uses a v4 exact-input-single struct with one extra
///      `minHopPriceX36` field ahead of `hookData`; this adapter pins it to zero and relies on the
///      caller-supplied `minAmountOut` plus OpenZap's owner-signed final-output check for slippage.
///
///      What this contract REFUSES to do:
///      - It refuses any user-supplied target, selector, path, command byte or route blob. `data` is
///        either empty or exactly one `uint256 minAmountOut`; nothing else is accepted.
///      - It refuses to be deployed for a native-ETH pool (`currency0 == address(0)`). The OpenZap
///        core settles on a single ERC-20 `outAsset` and `TokenAllowlist` rejects the zero address,
///        so a native-ETH pool could never be expressed by a policy. Failing at construction is
///        clearer than failing at execution.
///      - It refuses to be deployed with an out-of-order or duplicate currency pair, a codeless
///        router/Permit2/token/hook, a tickSpacing outside v4's legal range, a static fee above
///        100%, or the dynamic-fee flag without a hook (which v4 itself rejects at initialize).
///      - It refuses to run on any chain other than Robinhood Chain (4663), both at construction
///        and on every call.
///      - It refuses to hold anything: it reverts unless its input balance is exactly restored, and
///        it forwards the entire measured output to `msg.sender`. It leaves no ERC-20 allowance and
///        no Permit2 allowance behind on any path.
///      - It refuses to be reentered.
contract RobinhoodV4PoolAdapter is IAdapter {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @dev Robinhood's variant of v4 `ExactInputSingleParams`: identical to upstream except for the
    ///      extra `minHopPriceX36` field. Encoded by this contract only.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    /// @dev Universal Router command `V4_SWAP`.
    bytes1 private constant V4_SWAP_COMMAND = 0x10;
    /// @dev v4 router actions: SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f).
    bytes3 private constant V4_ACTIONS = 0x060c0f;

    /// @dev `LPFeeLibrary.DYNAMIC_FEE_FLAG` — a pool whose fee is set by its hook per swap.
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000;
    /// @dev `LPFeeLibrary.MAX_LP_FEE` — 100% in hundredths of a bip.
    uint24 private constant MAX_STATIC_FEE = 1_000_000;
    /// @dev `TickMath.MAX_TICK_SPACING` / `MIN_TICK_SPACING`.
    int24 private constant MAX_TICK_SPACING = 32767;
    int24 private constant MIN_TICK_SPACING = 1;

    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable hooks;
    /// @notice The v4 pool id, `keccak256(abi.encode(poolKey))`. Lets a deployer prove on-chain that
    ///         this instance is wired to the pool they intended.
    bytes32 public immutable poolId;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error NativeCurrencyUnsupported();
    error InvalidCurrencyOrder();
    error InvalidTickSpacing(int24 value);
    error InvalidFee(uint24 value);
    error DynamicFeeRequiresHook();
    error UnsupportedToken(address token);
    error InvalidData();
    error ZeroAmount();
    error AmountTooLarge();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error NoOutput();
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error ResidualInput(uint256 expected, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param universalRouter_ Robinhood Universal Router.
    /// @param permit2_ Canonical Permit2.
    /// @param currency0_ Lower-sorted pool currency. MUST be a real ERC-20; native ETH is refused.
    /// @param currency1_ Higher-sorted pool currency.
    /// @param fee_ Static LP fee in hundredths of a bip, or `0x800000` for a dynamic-fee pool.
    /// @param tickSpacing_ Pool tick spacing, 1..32767.
    /// @param hooks_ Pool hook, or `address(0)` for a hookless pool.
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
        if (universalRouter_ == address(0) || permit2_ == address(0)) revert ZeroAddress();
        // A v4 pool may legitimately use the zero address as currency0 to mean native ETH. OpenZap
        // cannot express that, so refuse it here rather than deploy an adapter that can never settle.
        if (currency0_ == address(0)) revert NativeCurrencyUnsupported();
        if (currency1_ == address(0)) revert ZeroAddress();
        if (currency0_ >= currency1_) revert InvalidCurrencyOrder();
        if (tickSpacing_ < MIN_TICK_SPACING || tickSpacing_ > MAX_TICK_SPACING) {
            revert InvalidTickSpacing(tickSpacing_);
        }
        if (fee_ == DYNAMIC_FEE_FLAG) {
            // v4's PoolManager.initialize rejects a dynamic-fee pool with no hook to set the fee.
            if (hooks_ == address(0)) revert DynamicFeeRequiresHook();
        } else if (fee_ > MAX_STATIC_FEE) {
            revert InvalidFee(fee_);
        }

        _requireCode(universalRouter_);
        _requireCode(permit2_);
        _requireCode(currency0_);
        _requireCode(currency1_);
        if (hooks_ != address(0)) _requireCode(hooks_);

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
    /// @param tokenIn Must be `currency0` or `currency1`; the other currency is the output.
    /// @param amountIn Exact input amount, pulled from `msg.sender`.
    /// @param data Empty, or exactly `abi.encode(uint256 minAmountOut)`. No routing bytes are ever
    ///        accepted: this is a bounded typed value the adapter validates and enforces itself.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 minAmountOut = _decodeMinAmountOut(data);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > type(uint128).max) revert AmountTooLarge();
        if (tokenIn != currency0 && tokenIn != currency1) revert UnsupportedToken(tokenIn);

        tokenOut = tokenIn == currency0 ? currency1 : currency0;
        bool zeroForOne = tokenIn == currency0;

        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));
        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - inputBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        SafeApprove.approveExact(tokenIn, permit2, amountIn);
        // casting to 'uint160'/'uint48' is safe because amountIn was bounded to uint128 above and a
        // uint48 unix timestamp does not overflow until the year 8,921,556.
        // forge-lint: disable-next-line(unsafe-typecast)
        IPermit2AllowanceTransfer(permit2).approve(tokenIn, universalRouter, uint160(amountIn), uint48(block.timestamp));

        // casting to 'uint128' is safe because _decodeMinAmountOut rejects anything larger.
        // forge-lint: disable-next-line(unsafe-typecast)
        _swap(tokenIn, tokenOut, zeroForOne, amountIn, uint128(minAmountOut));

        // Revoke both legs of the Permit2 path before transferring output back to the caller.
        IPermit2AllowanceTransfer(permit2).approve(tokenIn, universalRouter, 0, 0);
        SafeApprove.approveExact(tokenIn, permit2, 0);

        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        if (inputAfter != inputBefore) revert ResidualInput(inputBefore, inputAfter);
        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        if (outputAfter <= outputBefore) revert NoOutput();

        // The measured delta is the only number this contract will act on or report.
        amountOut = outputAfter - outputBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput(minAmountOut, amountOut);
        SafeApprove.safeTransfer(tokenOut, msg.sender, amountOut);
    }

    /// @notice The immutable PoolKey this instance is wired to.
    function poolKey() external view returns (PoolKey memory) {
        return PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
    }

    /// @dev Builds the entire Universal Router payload from immutables plus the two bounded scalars.
    ///      Split out only to keep `execute`'s stack within via-ir's reach.
    function _swap(address tokenIn, address tokenOut, bool zeroForOne, uint256 amountIn, uint128 minAmountOut) private {
        ExactInputSingleParams memory swapParams = ExactInputSingleParams({
            poolKey: PoolKey({
                currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks
            }),
            zeroForOne: zeroForOne,
            // casting to 'uint128' is safe because execute() reverts on amountIn > type(uint128).max.
            // forge-lint: disable-next-line(unsafe-typecast)
            amountIn: uint128(amountIn),
            amountOutMinimum: minAmountOut,
            minHopPriceX36: 0,
            hookData: bytes("")
        });

        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swapParams);
        actionParams[1] = abi.encode(tokenIn, amountIn); // SETTLE_ALL
        actionParams[2] = abi.encode(tokenOut, uint256(0)); // TAKE_ALL, floor enforced locally

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(V4_ACTIONS), actionParams);
        IRobinhoodUniversalRouter(universalRouter).execute(abi.encodePacked(V4_SWAP_COMMAND), inputs, block.timestamp);
    }

    function _decodeMinAmountOut(bytes calldata data) private pure returns (uint256 minAmountOut) {
        if (data.length == 0) return 0;
        if (data.length != 32) revert InvalidData();
        minAmountOut = abi.decode(data, (uint256));
        if (minAmountOut > type(uint128).max) revert AmountTooLarge();
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
