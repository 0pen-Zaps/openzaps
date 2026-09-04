// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {HookedRangeVault, IHookedV4PoolManager} from "../primitives/HookedRangeVault.sol";
import {HookedRangeVaultFactory} from "../primitives/HookedRangeVaultFactory.sol";
import {HookedPoolSwapBase} from "./HookedPoolSwapBase.sol";

/// @title HookedRangeDepositAdapter
/// @notice "Zap in to a Hookr pool" as ONE OpenZap step: one pool currency in (HOOKR, or the
///         launched token), ERC-20 LP shares of that pool's `HookedRangeVault` out. Half the input
///         is swapped in the pool itself, both halves are deposited, and the shares are minted
///         straight to the calling zap.
/// @dev ONE deployment serves EVERY vault the pinned `HookedRangeVaultFactory` has deployed or
///      will deploy, which is what makes a new Hookr launch reachable without an OpenZaps
///      deployment. The vault is named in the step data and verified against the factory: the
///      data is `abi.encode(address vault, uint256 minSharesOut)`, exactly 64 bytes, and any
///      address the factory did not deploy is refused. This is the ONLY target this adapter will
///      ever take from calldata, and the factory guarantees what it can be: a `HookedRangeVault`
///      of this repository, on the pinned PoolManager, with the pinned hook and quote token. The
///      pool is read off the vault, so a vault/pool mismatch cannot be introduced.
///
///      Same security shape as the reference adapters otherwise: one fixed selector, chain guard
///      4663 at construction and on every call, reentrancy guard, measured deltas only, zero
///      residual allowance on every path, `receiver` hardcoded to `msg.sender`.
///
///      HONEST LIMITS (inherited from `ZapRangeDepositAdapter`, plus one):
///      - Exact-half split by amount, refund of whatever the pool ratio cannot absorb; the refund
///        strands in the calling zap until `emergencyExit`.
///      - The in-pool swap pays the hook's dynamic fee (surge included) like any other trade.
///      - If the pool's liquidity cannot absorb the half-swap, the unswapped remainder is refunded
///        rather than the step reverting; the share output still has to clear `minSharesOut`.
///      - A deposit REVERTS while the pool's anti-snipe guard is active (the hook fences outside
///        LPs out for a finite window after launch). Fail closed, try later.
contract HookedRangeDepositAdapter is IAdapter, HookedPoolSwapBase {
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    HookedRangeVaultFactory public immutable factory;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error InvalidData();
    error UnknownVault(address vault);
    error UnsupportedToken(address token);
    error ZeroAmount();
    error AmountTooLarge();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error NoSwapOutput();
    error SharesMisdirected();
    error InexactShareMint(uint256 reported, uint256 measured);
    error InsufficientShares(uint256 minimum, uint256 actual);
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
    /// @param tokenIn Either currency of the named vault's pool; the other half is bought in-pool.
    /// @param amountIn Exact input amount, pulled from `msg.sender`. Must be at least 2.
    /// @param data Exactly `abi.encode(address vault, uint256 minSharesOut)`.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        (HookedRangeVault vault, uint256 minSharesOut) = _decode(data);
        if (amountIn < 2) revert ZeroAmount();
        if (amountIn > type(uint128).max) revert AmountTooLarge();

        address currency0 = vault.currency0();
        address currency1 = vault.currency1();
        if (tokenIn != currency0 && tokenIn != currency1) revert UnsupportedToken(tokenIn);
        address tokenOther = tokenIn == currency0 ? currency1 : currency0;

        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 otherBefore = IERC20(tokenOther).balanceOf(address(this));

        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - inBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        // Swap exactly half in the vault's own pool; what the pool could not consume stays as
        // input residue and is refunded below.
        (uint256 consumed,) = _swapExactIn(vault.poolKey(), tokenIn == currency0, amountIn / 2);
        uint256 otherOut = IERC20(tokenOther).balanceOf(address(this)) - otherBefore;
        if (otherOut == 0) revert NoSwapOutput();
        uint256 keep = amountIn - consumed;

        amountOut = _depositBoth(vault, tokenIn, keep, otherOut, minSharesOut);
        tokenOut = address(vault);

        uint256 inResidual = IERC20(tokenIn).balanceOf(address(this)) - inBefore;
        if (inResidual != 0) SafeApprove.safeTransfer(tokenIn, msg.sender, inResidual);
        uint256 otherResidual = IERC20(tokenOther).balanceOf(address(this)) - otherBefore;
        if (otherResidual != 0) SafeApprove.safeTransfer(tokenOther, msg.sender, otherResidual);
    }

    /// @notice Decode and verify step data without executing — for off-chain preflight.
    function decodeData(bytes calldata data) external view returns (address vault, uint256 minSharesOut) {
        (HookedRangeVault v, uint256 m) = _decode(data);
        return (address(v), m);
    }

    function _depositBoth(HookedRangeVault vault, address tokenIn, uint256 keep, uint256 otherOut, uint256 minSharesOut)
        private
        returns (uint256 sharesMinted)
    {
        address currency0 = vault.currency0();
        address currency1 = vault.currency1();
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

    function _decode(bytes calldata data) private view returns (HookedRangeVault vault, uint256 minSharesOut) {
        if (data.length != 64) revert InvalidData();
        address vaultAddress;
        (vaultAddress, minSharesOut) = abi.decode(data, (address, uint256));
        if (!factory.isVault(vaultAddress)) revert UnknownVault(vaultAddress);
        if (minSharesOut > type(uint128).max) revert AmountTooLarge();
        vault = HookedRangeVault(vaultAddress);
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
