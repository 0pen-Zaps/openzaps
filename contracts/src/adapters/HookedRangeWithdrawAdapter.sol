// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {HookedRangeVault} from "../primitives/HookedRangeVault.sol";
import {HookedRangeVaultFactory} from "../primitives/HookedRangeVaultFactory.sol";
import {HookedPoolSwapBase} from "./HookedPoolSwapBase.sol";

/// @title HookedRangeWithdrawAdapter
/// @notice "Zap out of a Hookr pool" as ONE OpenZap step: `HookedRangeVault` shares in, ONE pool
///         currency out. The shares are burned straight out of the calling zap, both legs land
///         here, the off-target leg is swapped into the target inside the same pool, and the
///         measured total is paid to the zap.
/// @dev ONE deployment serves every vault of the pinned `HookedRangeVaultFactory`. The vault IS
///      `tokenIn` (the share token), verified against the factory; the settlement currency is
///      named in the step data — `abi.encode(address assetOut, uint256 minAssetsOut)`, exactly 64
///      bytes — and must be one of the vault's two currencies. No other target is ever read from
///      calldata.
///
///      Composes with `HookedRangeDepositAdapter` into a MIGRATION: zap out of pool A settling in
///      HOOKR, then zap into pool B from that HOOKR, as two steps of one policy with HOOKR as the
///      carried asset.
///
///      HONEST LIMITS:
///      - The in-pool swap of the off-target leg pays the hook's dynamic fee like any trade.
///      - If pool liquidity cannot absorb the whole off-target leg, the unswapped remainder is
///        refunded to the calling zap (where it strands until `emergencyExit`) rather than the
///        step reverting; the target output still has to clear `minAssetsOut`.
///      - Redemption itself can never be blocked by the hook (vaults refuse hooks with removal
///        permissions), so a zap out is always available.
contract HookedRangeWithdrawAdapter is IAdapter, HookedPoolSwapBase {
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    HookedRangeVaultFactory public immutable factory;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error InvalidData();
    error UnknownVault(address vault);
    error AssetNotInPool(address asset);
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

    constructor(address poolManager_, address factory_) HookedPoolSwapBase(poolManager_) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (poolManager_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        _requireCode(poolManager_);
        _requireCode(factory_);
        if (HookedRangeVaultFactory(factory_).poolManager() != poolManager_) revert UnknownVault(factory_);
        factory = HookedRangeVaultFactory(factory_);
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn A vault share token deployed by the pinned factory.
    /// @param amountIn Share count to redeem — exactly the allowance the zap grants this step.
    /// @param data Exactly `abi.encode(address assetOut, uint256 minAssetsOut)`.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (!factory.isVault(tokenIn)) revert UnknownVault(tokenIn);
        HookedRangeVault vault = HookedRangeVault(tokenIn);
        (address assetOut, uint256 minAssetsOut) = _decode(vault, data);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > type(uint128).max) revert AmountTooLarge();

        address currency0 = vault.currency0();
        address assetOther = assetOut == currency0 ? vault.currency1() : currency0;

        uint256 targetBefore = IERC20(assetOut).balanceOf(address(this));
        uint256 otherBefore = IERC20(assetOther).balanceOf(address(this));

        uint256 callerSharesBefore = vault.balanceOf(msg.sender);
        vault.redeem(amountIn, 0, 0, address(this), msg.sender);
        uint256 burned = callerSharesBefore - vault.balanceOf(msg.sender);
        if (burned != amountIn) revert InexactShareBurn(amountIn, burned);

        uint256 otherReceived = IERC20(assetOther).balanceOf(address(this)) - otherBefore;
        if (otherReceived != 0) {
            _swapExactIn(vault.poolKey(), assetOther == currency0, otherReceived);
        }

        amountOut = IERC20(assetOut).balanceOf(address(this)) - targetBefore;
        if (amountOut == 0) revert NoOutput();
        if (amountOut < minAssetsOut) revert InsufficientOutput(minAssetsOut, amountOut);
        tokenOut = assetOut;
        SafeApprove.safeTransfer(assetOut, msg.sender, amountOut);

        // Anything of the off-target leg the pool could not absorb goes back to the caller —
        // measured against the PRE-call snapshot so donations never move.
        uint256 otherResidual = IERC20(assetOther).balanceOf(address(this)) - otherBefore;
        if (otherResidual != 0) SafeApprove.safeTransfer(assetOther, msg.sender, otherResidual);
    }

    /// @notice Decode and verify step data for a given vault without executing.
    function decodeData(address vault, bytes calldata data)
        external
        view
        returns (address assetOut, uint256 minAssetsOut)
    {
        if (!factory.isVault(vault)) revert UnknownVault(vault);
        return _decode(HookedRangeVault(vault), data);
    }

    function _decode(HookedRangeVault vault, bytes calldata data)
        private
        view
        returns (address assetOut, uint256 minAssetsOut)
    {
        if (data.length != 64) revert InvalidData();
        (assetOut, minAssetsOut) = abi.decode(data, (address, uint256));
        if (assetOut != vault.currency0() && assetOut != vault.currency1()) revert AssetNotInPool(assetOut);
        if (minAssetsOut > type(uint128).max) revert AmountTooLarge();
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
