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

/// @title RobinhoodV4RouteAdapter
/// @notice Exact-input adapter for ONE frozen multi-pool swap route on Robinhood Chain — several
///         swaps stitched into a single OpenZap step (e.g. USDG → aeWETH → 0xZAPS through two pools
///         that were never directly paired).
/// @dev Why this exists: the live v1.1 core freezes `Step.amountIn` at policy creation, so a swap
///      chain expressed as SEPARATE steps must guess every intermediate amount in advance and
///      strands any surplus (see `ROBINHOOD_EXPANSION.md` §1). Moving the chain INSIDE one adapter
///      call removes the guessing: hop k+1 spends exactly the MEASURED output of hop k, at runtime.
///      The zap still sees one step with one frozen `amountIn` and one measured output, so nothing
///      about the core's settlement or approval model changes.
///
///      The route — every pool, every token, the order — is frozen at construction and immutable
///      thereafter. One deployment serves exactly one route; a different route is a different
///      deployment. Allowlisting this address in `AdapterRegistry` is therefore equivalent to
///      allowlisting the single action "exact-input swap along this one route" (invariant I-SURF-1).
///
///      Each hop repeats, verbatim, the Universal Router exact-input-single encoding proven live by
///      `RobinhoodV4SwapAdapter` / `RobinhoodV4PoolAdapter` (Robinhood's router uses a modified v4
///      struct with an extra `minHopPriceX36` field; the multi-hop `PathKey` encoding has never been
///      exercised on this chain, so this adapter deliberately does not use it — one proven
///      single-pool call per hop instead of one unproven multi-hop call).
///
///      What this contract REFUSES to do, matching the reference adapters:
///      - No user-supplied target, selector, path, command byte or route blob. `data` is either
///        empty or exactly `abi.encode(uint256 minAmountOut)` for the FINAL output; nothing else.
///      - No native-ETH pools, no unsorted/duplicate pool currencies, no codeless router/Permit2/
///        token/hook, no illegal tickSpacing/fee, no dynamic fee without a hook.
///      - No route that revisits a token: every address in the path must be distinct, so the route
///        can never be circular (a route ending where it began could not settle as an OpenZap step).
///      - No custody: input must be exactly consumed, intermediate balances exactly restored, and
///        the entire measured final output is forwarded to `msg.sender`. No ERC-20 or Permit2
///        allowance survives on any path.
///      - No other chain than Robinhood Chain (4663), at construction and on every call.
///      - No reentrancy.
contract RobinhoodV4RouteAdapter is IAdapter {
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
    /// @dev A route is 2..4 hops. One hop is `RobinhoodV4PoolAdapter`'s job; more than four is a
    ///      cost, slippage and review burden no current route needs.
    uint256 public constant MIN_HOPS = 2;
    uint256 public constant MAX_HOPS = 4;

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

    /// @dev Frozen at construction, no writer anywhere else. `_path` has `_hops.length + 1` tokens;
    ///      hop i swaps `_path[i]` into `_path[i + 1]` through `_hops[i]`.
    address[] private _path;
    PoolKey[] private _hops;
    bytes32[] private _poolIds;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error NativeCurrencyUnsupported();
    error InvalidCurrencyOrder();
    error InvalidTickSpacing(int24 value);
    error InvalidFee(uint24 value);
    error DynamicFeeRequiresHook();
    error InvalidRouteLength();
    error HopMismatchesPath(uint256 hop);
    error RouteRevisitsToken(address token);
    error UnsupportedToken(address token);
    error InvalidData();
    error ZeroAmount();
    error AmountTooLarge();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error NoOutput();
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error ResidualInput(uint256 expected, uint256 actual);
    error ResidualIntermediate(uint256 hop, uint256 expected, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param universalRouter_ Robinhood Universal Router.
    /// @param permit2_ Canonical Permit2.
    /// @param path_ The token route, input first: `path_[i]` is swapped into `path_[i + 1]` by
    ///        `hops_[i]`. All entries must be distinct real ERC-20s.
    /// @param hops_ One PoolKey per hop, each validated exactly like `RobinhoodV4PoolAdapter` and
    ///        required to pair `path_[i]` with `path_[i + 1]`.
    constructor(address universalRouter_, address permit2_, address[] memory path_, PoolKey[] memory hops_) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (universalRouter_ == address(0) || permit2_ == address(0)) revert ZeroAddress();
        if (hops_.length < MIN_HOPS || hops_.length > MAX_HOPS) revert InvalidRouteLength();
        if (path_.length != hops_.length + 1) revert InvalidRouteLength();

        _requireCode(universalRouter_);
        _requireCode(permit2_);
        universalRouter = universalRouter_;
        permit2 = permit2_;

        for (uint256 i; i < path_.length; ++i) {
            address token = path_[i];
            if (token == address(0)) revert NativeCurrencyUnsupported();
            _requireCode(token);
            for (uint256 j; j < i; ++j) {
                if (path_[j] == token) revert RouteRevisitsToken(token);
            }
            _path.push(token);
        }

        for (uint256 i; i < hops_.length; ++i) {
            PoolKey memory k = hops_[i];
            if (k.currency0 == address(0)) revert NativeCurrencyUnsupported();
            if (k.currency1 == address(0)) revert ZeroAddress();
            if (k.currency0 >= k.currency1) revert InvalidCurrencyOrder();
            if (k.tickSpacing < MIN_TICK_SPACING || k.tickSpacing > MAX_TICK_SPACING) {
                revert InvalidTickSpacing(k.tickSpacing);
            }
            if (k.fee == DYNAMIC_FEE_FLAG) {
                // v4's PoolManager.initialize rejects a dynamic-fee pool with no hook to set the fee.
                if (k.hooks == address(0)) revert DynamicFeeRequiresHook();
            } else if (k.fee > MAX_STATIC_FEE) {
                revert InvalidFee(k.fee);
            }
            if (k.hooks != address(0)) _requireCode(k.hooks);

            // The hop must connect path[i] to path[i + 1] — in either sort order.
            address a = path_[i];
            address b = path_[i + 1];
            bool matches = (k.currency0 == a && k.currency1 == b) || (k.currency0 == b && k.currency1 == a);
            if (!matches) revert HopMismatchesPath(i);

            _hops.push(k);
            _poolIds.push(keccak256(abi.encode(k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks)));
        }
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn Must be the route's first token; the route's last token is the output.
    /// @param amountIn Exact input amount, pulled from `msg.sender`.
    /// @param data Empty, or exactly `abi.encode(uint256 minAmountOut)` for the FINAL output. No
    ///        routing bytes are ever accepted; intermediate hops carry no minimum because the final
    ///        floor (here and in the owner-signed intent `minOut`) bounds the whole route.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 minAmountOut = _decodeMinAmountOut(data);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > type(uint128).max) revert AmountTooLarge();
        if (tokenIn != _path[0]) revert UnsupportedToken(tokenIn);

        uint256 hopCount_ = _hops.length;
        tokenOut = _path[hopCount_];

        // Snapshot every token on the route so settlement is delta-based and donations to this
        // contract can never be spent or reported as output.
        uint256[] memory balancesBefore = new uint256[](hopCount_ + 1);
        for (uint256 i; i <= hopCount_; ++i) {
            balancesBefore[i] = IERC20(_path[i]).balanceOf(address(this));
        }

        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - balancesBefore[0];
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        uint256 hopAmountIn = amountIn;
        for (uint256 i; i < hopCount_; ++i) {
            // Only the final hop carries the local floor; the router enforces it a second time.
            // casting to 'uint128' is safe: amountIn was bounded above and every later hop input is
            // re-bounded before use; minAmountOut is bounded by _decodeMinAmountOut.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128 hopMinOut = i + 1 == hopCount_ ? uint128(minAmountOut) : 0;
            hopAmountIn = _swapHop(i, hopAmountIn, hopMinOut, balancesBefore[i + 1]);
        }

        // Input exactly consumed, every intermediate exactly restored, output is the measured delta.
        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        if (inputAfter != balancesBefore[0]) revert ResidualInput(balancesBefore[0], inputAfter);
        for (uint256 i = 1; i < hopCount_; ++i) {
            uint256 midAfter = IERC20(_path[i]).balanceOf(address(this));
            if (midAfter != balancesBefore[i]) revert ResidualIntermediate(i, balancesBefore[i], midAfter);
        }

        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        if (outputAfter <= balancesBefore[hopCount_]) revert NoOutput();
        amountOut = outputAfter - balancesBefore[hopCount_];
        if (amountOut < minAmountOut) revert InsufficientOutput(minAmountOut, amountOut);
        SafeApprove.safeTransfer(tokenOut, msg.sender, amountOut);
    }

    // --------------------------------------------------------------------- //
    // Views (deployer verification surface)                                  //
    // --------------------------------------------------------------------- //

    /// @notice The full frozen token route, input first.
    function route() external view returns (address[] memory) {
        return _path;
    }

    function hopCount() external view returns (uint256) {
        return _hops.length;
    }

    /// @notice The immutable PoolKey for hop `i`.
    function hop(uint256 i) external view returns (PoolKey memory) {
        return _hops[i];
    }

    /// @notice The v4 pool id for hop `i`, `keccak256(abi.encode(poolKey))`. Lets a deployer prove
    ///         on-chain that this instance is wired to the pools they intended.
    function poolId(uint256 i) external view returns (bytes32) {
        return _poolIds[i];
    }

    // --------------------------------------------------------------------- //
    // Internals                                                              //
    // --------------------------------------------------------------------- //

    /// @dev One proven single-pool Universal Router call: exact-approve the hop input through
    ///      Permit2, swap, revoke both approval legs, and return the MEASURED output delta for the
    ///      next hop. `outBefore` is the pre-run snapshot of the hop's output token.
    function _swapHop(uint256 i, uint256 hopAmountIn, uint128 hopMinOut, uint256 outBefore)
        private
        returns (uint256 measuredOut)
    {
        if (hopAmountIn > type(uint128).max) revert AmountTooLarge();
        PoolKey memory k = _hops[i];
        address hopTokenIn = _path[i];
        address hopTokenOut = _path[i + 1];
        bool zeroForOne = hopTokenIn == k.currency0;

        SafeApprove.approveExact(hopTokenIn, permit2, hopAmountIn);
        // casting to 'uint160'/'uint48' is safe because hopAmountIn was bounded to uint128 above and
        // a uint48 unix timestamp does not overflow until the year 8,921,556.
        // forge-lint: disable-next-line(unsafe-typecast)
        IPermit2AllowanceTransfer(permit2)
            .approve(hopTokenIn, universalRouter, uint160(hopAmountIn), uint48(block.timestamp));

        ExactInputSingleParams memory swapParams = ExactInputSingleParams({
            poolKey: k,
            zeroForOne: zeroForOne,
            // casting to 'uint128' is safe because hopAmountIn was bounded above.
            // forge-lint: disable-next-line(unsafe-typecast)
            amountIn: uint128(hopAmountIn),
            amountOutMinimum: hopMinOut,
            minHopPriceX36: 0,
            hookData: bytes("")
        });

        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swapParams);
        actionParams[1] = abi.encode(hopTokenIn, hopAmountIn); // SETTLE_ALL
        actionParams[2] = abi.encode(hopTokenOut, uint256(0)); // TAKE_ALL, floor enforced locally

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(V4_ACTIONS), actionParams);
        IRobinhoodUniversalRouter(universalRouter).execute(abi.encodePacked(V4_SWAP_COMMAND), inputs, block.timestamp);

        // Revoke both legs of the Permit2 path before measuring, on every hop.
        IPermit2AllowanceTransfer(permit2).approve(hopTokenIn, universalRouter, 0, 0);
        SafeApprove.approveExact(hopTokenIn, permit2, 0);

        uint256 outputAfter = IERC20(hopTokenOut).balanceOf(address(this));
        if (outputAfter <= outBefore) revert NoOutput();
        measuredOut = outputAfter - outBefore;
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
