// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @dev The exact — and only — surface of `ZapVault` this adapter is allowed to touch. Declared
///      locally rather than importing the contract so the call surface is auditable in one screen:
///      two functions, one of them a view read taken once at construction.
interface IZapVaultDeposit {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

/// @title ZapVaultDepositAdapter
/// @notice The one way a zap step can reach `ZapVault`: asset in, vault shares out, shares booked to
///         the calling zap. One deployment serves exactly one vault, welded in at construction.
/// @dev Until this adapter existed nothing in `src/adapters` called `ZapVault`, so an OpenZap policy
///      had no way to express "supply into the vault" at all. This closes that gap and nothing else.
///
///      The design rule it is built to is `AaveV3SupplyAdapter`'s: the adapter is a *credential*, not
///      a router. `vault` and `asset` are constructor immutables, so allowlisting this address in
///      `AdapterRegistry` is exactly equivalent to allowlisting the sentence "deposit <asset> into
///      <vault>". There is no second thing this address can be persuaded to do.
///
///      RECEIVER IS ALWAYS `msg.sender`, NEVER A PARAMETER. `ZapVault.deposit(assets, receiver)`
///      mints to `receiver`, and this adapter hardcodes `receiver = msg.sender`, so the shares land
///      on the zap that paid for them. A policy cannot redirect a deposit to a third party, and the
///      adapter cannot end up as the shareholder of record. Both halves are asserted at runtime: the
///      caller's share balance must rise and this contract's must not move (`SharesMisdirected`).
///
///      What this adapter refuses to do:
///      - It refuses any target, selector, route blob or receiver from the caller. `data` is either
///        empty or exactly one `uint256 minSharesOut` — a bounded typed scalar this contract decodes
///        and enforces itself. That floor is worth having: `ZapVault` prices a deposit against
///        `totalAssets()` *before* the assets land, so a same-block donation into the vault lowers
///        the share count a deposit mints. The zap's owner-signed `minOut` bounds the final
///        settlement; `minSharesOut` bounds this step even when it is not the last one.
///      - It refuses any token but the vault's own immutable `asset`.
///      - It refuses to run off Robinhood Chain (4663), checked at construction and on every call, so
///        a fork or chain renumbering cannot repoint it. Note this is strictly an adapter-level
///        guard: `ZapVault` itself deliberately has no chain guard, and this adapter is never the
///        only way out of it — the zap owner's `emergencyExit` moves the shares, and the vault's own
///        `redeem` is callable directly by whoever then holds them. Refusing here traps nothing.
///      - It refuses to keep an allowance. Exactly `amountIn` is approved to the vault and reset to
///        zero in the same call; any revert unwinds the approval with the transaction.
///      - It refuses to hold funds. It reverts rather than sweeping if the pulled asset did not fully
///        leave (`ResidualInput`) or if a share landed on itself — a silent sweep would turn a broken
///        vault into a plausible-looking receipt.
///      - It refuses to report an unmeasured number. `amountOut` is the observed increase of the
///        *caller's* share balance. The vault's own return value is used only as a cross-check that
///        must agree exactly (`InexactShareMint`), never as the reported figure.
///      - It refuses to be reentered.
///
///      Two honest notes, both inherited from `ZapVault` rather than introduced here:
///      - `amountOut` is NOT a function of `amountIn` alone. It is `assets * (totalSupply + 1000) /
///        (totalAssets + 1)`, rounded down. Never assume a ratio; `minSharesOut` and the signed
///        `minOut` are the only slippage authorities.
///      - A deposit that would round to zero shares reverts inside the vault with `ZeroShares` rather
///        than confiscating the principal. That surfaces through this adapter as a clean revert, and
///        the step — and the whole zap run — fails. That is the intended outcome.
contract ZapVaultDepositAdapter is IAdapter {
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    /// @notice The single `ZapVault` this adapter may deposit into. One adapter per vault.
    address public immutable vault;
    /// @notice The vault's underlying ERC-20, read from the vault at construction. Also the only
    ///         `tokenIn` this adapter accepts.
    address public immutable asset;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error UnsupportedToken(address token);
    error InvalidData();
    error ZeroAmount();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error ResidualInput(uint256 expected, uint256 actual);
    error SharesMisdirected(uint256 expected, uint256 actual);
    error NoOutput();
    error InexactShareMint(uint256 reported, uint256 measured);
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param vault_ The `ZapVault` this adapter is welded to. Its `asset()` is read once, here, and
    ///        frozen — the vault's asset is immutable, so there is nothing to re-check per call.
    constructor(address vault_) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (vault_ == address(0)) revert ZeroAddress();
        _requireCode(vault_);

        address asset_ = IZapVaultDeposit(vault_).asset();
        if (asset_ == address(0)) revert ZeroAddress();
        _requireCode(asset_);

        vault = vault_;
        asset = asset_;
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn Must equal the immutable `asset`.
    /// @param amountIn Exact units of `asset` pulled from `msg.sender` and deposited.
    /// @param data Empty, or exactly `abi.encode(uint256 minSharesOut)`. Nothing else is accepted.
    /// @return tokenOut The vault's share token, i.e. the vault address itself.
    /// @return amountOut The measured increase of `msg.sender`'s share balance.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 minSharesOut = _decodeMinOut(data);
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn != asset) revert UnsupportedToken(tokenIn);
        tokenOut = vault;

        // Deltas, never absolute balances: a donation to this adapter must not become someone's output.
        uint256 inputBefore = IERC20(asset).balanceOf(address(this));
        uint256 selfSharesBefore = IERC20(vault).balanceOf(address(this));
        uint256 callerSharesBefore = IERC20(vault).balanceOf(msg.sender);

        SafeApprove.safeTransferFrom(asset, msg.sender, address(this), amountIn);
        uint256 received = IERC20(asset).balanceOf(address(this)) - inputBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        SafeApprove.approveExact(asset, vault, amountIn);
        // receiver = msg.sender: the shares are the zap's, never this adapter's.
        uint256 reported = IZapVaultDeposit(vault).deposit(amountIn, msg.sender);
        SafeApprove.approveExact(asset, vault, 0);

        uint256 inputAfter = IERC20(asset).balanceOf(address(this));
        if (inputAfter != inputBefore) revert ResidualInput(inputBefore, inputAfter);
        uint256 selfSharesAfter = IERC20(vault).balanceOf(address(this));
        if (selfSharesAfter != selfSharesBefore) revert SharesMisdirected(selfSharesBefore, selfSharesAfter);

        uint256 callerSharesAfter = IERC20(vault).balanceOf(msg.sender);
        if (callerSharesAfter <= callerSharesBefore) revert NoOutput();

        // The measured delta is the only number this contract reports. The vault's return value is
        // cross-checked against it and must agree exactly — a mismatch means the share token is not
        // the plain, non-rebasing ERC-20 the settlement model assumes, so stop.
        amountOut = callerSharesAfter - callerSharesBefore;
        if (amountOut != reported) revert InexactShareMint(reported, amountOut);
        if (amountOut < minSharesOut) revert InsufficientOutput(minSharesOut, amountOut);
    }

    function _decodeMinOut(bytes calldata data) private pure returns (uint256 minSharesOut) {
        if (data.length == 0) return 0;
        if (data.length != 32) revert InvalidData();
        minSharesOut = abi.decode(data, (uint256));
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
