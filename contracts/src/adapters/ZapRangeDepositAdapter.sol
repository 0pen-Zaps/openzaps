// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {ZapRangeVault} from "../primitives/ZapRangeVault.sol";

interface IPermit2AllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IRobinhoodUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title ZapRangeDepositAdapter
/// @notice "Provide liquidity" as a single OpenZap step: ONE pool currency in, ERC-20 LP shares
///         out. The adapter swaps half the input through the SAME pool the vault LPs into (the
///         proven Universal Router encoding), deposits both halves into the welded `ZapRangeVault`,
///         and the minted shares land directly on the calling zap.
/// @dev One deployment serves one vault, welded at construction; the pool is read off the vault so
///      a vault/pool mismatch cannot be introduced. Same security shape as the reference adapters:
///      one fixed selector, no arbitrary calldata (`data` is empty or exactly one
///      `abi.encode(uint256 minSharesOut)`), chain guard 4663 at construction and on every call,
///      reentrancy guard, measured deltas only, zero residual ERC-20/Permit2 allowance on every
///      path.
///
///      `receiver` is hardcoded to `msg.sender` — the shares are minted straight to the zap; the
///      adapter can never become the holder of record. The vault's own return value is only a
///      cross-check against the measured share delta (`InexactShareMint`).
///
///      HONEST LIMITS:
///      - The 50/50 split is exact-half by amount, which is only approximately value-optimal;
///        whatever the current pool ratio cannot absorb is refunded to the calling zap, where it
///        STRANDS until the owner sweeps it with `emergencyExit`. For the intended sizes the dust
///        is small, but it is dust by design, not zero.
///      - The refund means this step does NOT consume exactly `amountIn` of the input; the zap's
///        settlement only measures the outAsset (the shares), so nothing mis-accounts — but a
///        policy author should know the input side is "up to", not "exactly".
contract ZapRangeDepositAdapter is IAdapter {
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
    ZapRangeVault public immutable vault;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    bytes32 public immutable poolId;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error UnsupportedToken(address token);
    error InvalidData();
    error ZeroAmount();
    error AmountTooLarge();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error NoSwapOutput();
    error InexactShareMint(uint256 reported, uint256 measured);
    error SharesMisdirected();
    error InsufficientShares(uint256 minimum, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address universalRouter_, address permit2_, address vault_) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (universalRouter_ == address(0) || permit2_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        _requireCode(universalRouter_);
        _requireCode(permit2_);
        _requireCode(vault_);

        universalRouter = universalRouter_;
        permit2 = permit2_;
        vault = ZapRangeVault(vault_);
        // Welded off the vault, so this adapter can only ever swap in the pool it LPs into. The
        // vault refuses hooked pools at construction, so the swap pool is hookless by transitivity.
        currency0 = ZapRangeVault(vault_).currency0();
        currency1 = ZapRangeVault(vault_).currency1();
        fee = ZapRangeVault(vault_).fee();
        tickSpacing = ZapRangeVault(vault_).tickSpacing();
        poolId = ZapRangeVault(vault_).poolId();
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn Either pool currency; the other half of the position is bought in-pool.
    /// @param amountIn Exact input amount, pulled from `msg.sender`. Must be at least 2.
    /// @param data Empty, or exactly `abi.encode(uint256 minSharesOut)`.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 minSharesOut = _decodeMinSharesOut(data);
        if (amountIn < 2) revert ZeroAmount();
        if (amountIn > type(uint128).max) revert AmountTooLarge();
        if (tokenIn != currency0 && tokenIn != currency1) revert UnsupportedToken(tokenIn);
        address tokenOther = tokenIn == currency0 ? currency1 : currency0;

        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 otherBefore = IERC20(tokenOther).balanceOf(address(this));

        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - inBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        // Swap exactly half in the vault's own pool; the other half stays for the deposit.
        uint256 swapAmount = amountIn / 2;
        _swap(tokenIn, swapAmount);
        uint256 otherOut = IERC20(tokenOther).balanceOf(address(this)) - otherBefore;
        if (otherOut == 0) revert NoSwapOutput();
        uint256 keep = amountIn - swapAmount;

        amountOut = _depositBoth(tokenIn, keep, otherOut, minSharesOut);
        tokenOut = address(vault);

        // Refund whatever the pool ratio could not absorb — measured against the PRE-call
        // snapshots, so donations to this adapter are never swept to the caller.
        uint256 inResidual = IERC20(tokenIn).balanceOf(address(this)) - inBefore;
        if (inResidual != 0) SafeApprove.safeTransfer(tokenIn, msg.sender, inResidual);
        uint256 otherResidual = IERC20(tokenOther).balanceOf(address(this)) - otherBefore;
        if (otherResidual != 0) SafeApprove.safeTransfer(tokenOther, msg.sender, otherResidual);
    }

    /// @notice The immutable PoolKey this adapter swaps through — always the vault's pool.
    function poolKey() external view returns (PoolKey memory) {
        return
            PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)});
    }

    /// @dev Deposit both legs into the vault with shares minted DIRECTLY to the caller, then verify
    ///      the mint by measured delta on both sides.
    function _depositBoth(address tokenIn, uint256 keep, uint256 otherOut, uint256 minSharesOut)
        private
        returns (uint256 sharesMinted)
    {
        (uint256 amount0, uint256 amount1) = tokenIn == currency0 ? (keep, otherOut) : (otherOut, keep);

        uint256 callerSharesBefore = vault.balanceOf(msg.sender);
        uint256 ownSharesBefore = vault.balanceOf(address(this));

        SafeApprove.approveExact(currency0, address(vault), amount0);
        SafeApprove.approveExact(currency1, address(vault), amount1);
        (uint256 reported,,) = vault.deposit(amount0, amount1, minSharesOut, msg.sender);
        SafeApprove.approveExact(currency0, address(vault), 0);
        SafeApprove.approveExact(currency1, address(vault), 0);

        sharesMinted = vault.balanceOf(msg.sender) - callerSharesBefore;
        if (sharesMinted == 0 || vault.balanceOf(address(this)) != ownSharesBefore) revert SharesMisdirected();
        if (sharesMinted != reported) revert InexactShareMint(reported, sharesMinted);
        if (sharesMinted < minSharesOut) revert InsufficientShares(minSharesOut, sharesMinted);
    }

    /// @dev One proven single-pool Universal Router swap, identical to `RobinhoodV4PoolAdapter`.
    function _swap(address tokenIn, uint256 swapAmount) private {
        address tokenOther = tokenIn == currency0 ? currency1 : currency0;
        bool zeroForOne = tokenIn == currency0;

        SafeApprove.approveExact(tokenIn, permit2, swapAmount);
        // casting to 'uint160'/'uint48' is safe: swapAmount <= amountIn <= uint128.max, and a
        // uint48 unix timestamp does not overflow until the year 8,921,556.
        // forge-lint: disable-next-line(unsafe-typecast)
        IPermit2AllowanceTransfer(permit2)
            .approve(tokenIn, universalRouter, uint160(swapAmount), uint48(block.timestamp));

        ExactInputSingleParams memory swapParams = ExactInputSingleParams({
            poolKey: PoolKey({
                currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)
            }),
            zeroForOne: zeroForOne,
            // casting to 'uint128' is safe: bounded in execute().
            // forge-lint: disable-next-line(unsafe-typecast)
            amountIn: uint128(swapAmount),
            amountOutMinimum: 0, // the share floor + the owner-signed intent minOut bound this step
            minHopPriceX36: 0,
            hookData: bytes("")
        });

        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swapParams);
        actionParams[1] = abi.encode(tokenIn, swapAmount); // SETTLE_ALL
        actionParams[2] = abi.encode(tokenOther, uint256(0)); // TAKE_ALL
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(V4_ACTIONS), actionParams);
        IRobinhoodUniversalRouter(universalRouter).execute(abi.encodePacked(V4_SWAP_COMMAND), inputs, block.timestamp);

        IPermit2AllowanceTransfer(permit2).approve(tokenIn, universalRouter, 0, 0);
        SafeApprove.approveExact(tokenIn, permit2, 0);
    }

    function _decodeMinSharesOut(bytes calldata data) private pure returns (uint256 minSharesOut) {
        if (data.length == 0) return 0;
        if (data.length != 32) revert InvalidData();
        minSharesOut = abi.decode(data, (uint256));
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
