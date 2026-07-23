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

/// @title ZapRangeWithdrawAdapter
/// @notice "Withdraw liquidity" as a single OpenZap step: LP shares in, ONE pool currency out. The
///         adapter redeems the shares from the welded `ZapRangeVault` (burning them straight out of
///         the calling zap via the exact ERC-20 allowance OpenZap grants), swaps the off-target leg
///         through the vault's own pool, and forwards the whole measured output to the zap.
/// @dev Why this is expressible at all: `ZapRangeVault.redeem(shares, ..., owner)` spends a plain
///      ERC-20 allowance on the share token — the one approval primitive `OpenZap.execute` emits —
///      exactly the coincidence that made `ZapVaultRedeemAdapter` possible. The share count is
///      denominated in `Step.amountIn`, so the allowance is spent exactly.
///
///      One deployment serves one vault AND one output currency, both welded at construction;
///      deploy a second instance for the other currency. Same security shape as the reference
///      adapters: fixed selector, `data` empty or exactly `abi.encode(uint256 minAssetsOut)`, chain
///      guard 4663, reentrancy guard, measured deltas, zero residual allowance on every path.
contract ZapRangeWithdrawAdapter is IAdapter {
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
    /// @notice The single currency this instance settles on.
    address public immutable assetOut;
    bytes32 public immutable poolId;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error AssetNotInPool(address asset);
    error UnsupportedToken(address token);
    error InvalidData();
    error ZeroAmount();
    error AmountTooLarge();
    error InexactShareBurn(uint256 expected, uint256 actual);
    error NoOutput();
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address universalRouter_, address permit2_, address vault_, address assetOut_) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (universalRouter_ == address(0) || permit2_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        _requireCode(universalRouter_);
        _requireCode(permit2_);
        _requireCode(vault_);

        universalRouter = universalRouter_;
        permit2 = permit2_;
        vault = ZapRangeVault(vault_);
        currency0 = ZapRangeVault(vault_).currency0();
        currency1 = ZapRangeVault(vault_).currency1();
        fee = ZapRangeVault(vault_).fee();
        tickSpacing = ZapRangeVault(vault_).tickSpacing();
        poolId = ZapRangeVault(vault_).poolId();
        if (assetOut_ != ZapRangeVault(vault_).currency0() && assetOut_ != ZapRangeVault(vault_).currency1()) {
            revert AssetNotInPool(assetOut_);
        }
        assetOut = assetOut_;
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn Must be the vault share token (the vault address itself).
    /// @param amountIn Share count to redeem — exactly the allowance the zap grants this step.
    /// @param data Empty, or exactly `abi.encode(uint256 minAssetsOut)` for the final single-asset
    ///        output.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 minAssetsOut = _decodeMinAssetsOut(data);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > type(uint128).max) revert AmountTooLarge();
        if (tokenIn != address(vault)) revert UnsupportedToken(tokenIn);
        address assetOther = assetOut == currency0 ? currency1 : currency0;

        uint256 targetBefore = IERC20(assetOut).balanceOf(address(this));
        uint256 otherBefore = IERC20(assetOther).balanceOf(address(this));

        // Burn the shares straight out of the calling zap; both currencies land here. No custody of
        // the shares is ever taken — the exact-approval is spent by the vault, and the burn is
        // verified by measured delta.
        uint256 callerSharesBefore = vault.balanceOf(msg.sender);
        vault.redeem(amountIn, 0, 0, address(this), msg.sender);
        uint256 burned = callerSharesBefore - vault.balanceOf(msg.sender);
        if (burned != amountIn) revert InexactShareBurn(amountIn, burned);

        // Swap the off-target leg into the target through the vault's own pool.
        uint256 otherReceived = IERC20(assetOther).balanceOf(address(this)) - otherBefore;
        if (otherReceived != 0) _swap(assetOther, otherReceived);

        amountOut = IERC20(assetOut).balanceOf(address(this)) - targetBefore;
        if (amountOut == 0) revert NoOutput();
        if (amountOut < minAssetsOut) revert InsufficientOutput(minAssetsOut, amountOut);
        tokenOut = assetOut;
        SafeApprove.safeTransfer(assetOut, msg.sender, amountOut);
    }

    /// @notice The immutable PoolKey this adapter swaps through — always the vault's pool.
    function poolKey() external view returns (PoolKey memory) {
        return
            PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)});
    }

    /// @dev One proven single-pool Universal Router swap, identical to `RobinhoodV4PoolAdapter`.
    function _swap(address tokenIn, uint256 swapAmount) private {
        if (swapAmount > type(uint128).max) revert AmountTooLarge();
        address tokenOther = tokenIn == currency0 ? currency1 : currency0;
        bool zeroForOne = tokenIn == currency0;

        SafeApprove.approveExact(tokenIn, permit2, swapAmount);
        // casting to 'uint160'/'uint48' is safe: swapAmount bounded to uint128 above, and a uint48
        // unix timestamp does not overflow until the year 8,921,556.
        // forge-lint: disable-next-line(unsafe-typecast)
        IPermit2AllowanceTransfer(permit2)
            .approve(tokenIn, universalRouter, uint160(swapAmount), uint48(block.timestamp));

        ExactInputSingleParams memory swapParams = ExactInputSingleParams({
            poolKey: PoolKey({
                currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)
            }),
            zeroForOne: zeroForOne,
            // casting to 'uint128' is safe: bounded above.
            // forge-lint: disable-next-line(unsafe-typecast)
            amountIn: uint128(swapAmount),
            amountOutMinimum: 0, // the caller-facing minAssetsOut floors the measured total
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

    function _decodeMinAssetsOut(bytes calldata data) private pure returns (uint256 minAssetsOut) {
        if (data.length == 0) return 0;
        if (data.length != 32) revert InvalidData();
        minAssetsOut = abi.decode(data, (uint256));
        if (minAssetsOut > type(uint128).max) revert AmountTooLarge();
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
