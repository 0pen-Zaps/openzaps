// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";

/// @dev The exact — and only — surface of `ZapVault` this adapter is allowed to touch. Note what is
///      absent: no `withdraw`, no `transferFrom`, no `approve`. Two functions, one of them a view
///      read taken once at construction.
interface IZapVaultRedeem {
    function asset() external view returns (address);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

/// @title ZapVaultRedeemAdapter
/// @notice The unwind leg for `ZapVault`: vault shares in, underlying asset out, both sides booked to
///         the calling zap. One deployment serves exactly one vault, welded in at construction.
/// @dev The mirror of `ZapVaultDepositAdapter`. Together they make a `ZapVault` position something a
///      frozen OpenZap policy can enter *and* leave, instead of a one-way door that only
///      `emergencyExit` could reopen.
///
///      ---------------------------------------------------------------------------------------- //
///      WHY THIS DIRECTION IS EXPRESSIBLE AT ALL — the question worth answering before reading on.
///      ---------------------------------------------------------------------------------------- //
///      A redeem needs authority over shares the *zap* holds, while the *adapter* is the caller. That
///      is the same shape that killed the Aave borrow leg (see `AaveV3BorrowAdapter.sol`), so it is
///      not obvious it survives here. It does, and for a specific reason:
///
///      ERC-4626's `redeem(shares, receiver, owner)` spends a plain ERC-20 allowance
///      `allowance[owner][msg.sender]` on the *share token*. `OpenZap.execute` already emits exactly
///      that call — `s.tokenIn.approveExact(s.spender, s.amountIn)` with `spender == adapter` forced
///      equal at `initialize` — and for a redeem step `tokenIn` IS the share token. So the one
///      approval primitive OpenZap owns is, by coincidence of the standards rather than by design,
///      precisely the primitive ERC-4626 asks for. Aave's `approveDelegation(delegatee, amount)` is a
///      different function that OpenZap can never emit; `ZapVault.approve(spender, value)` is
///      `approve(address,uint256)` itself. No core change is needed. This is proved end to end
///      through a real clone in `test_roundTripThroughRealOpenZapClones`, and the allowance is shown
///      to be load-bearing (not incidental) by `test_redeemRevertsWithoutTheZapsAllowance`.
///
///      ---------------------------------------------------------------------------------------- //
///      `redeem`, NOT `withdraw` — and the adapter does not take custody of the shares.
///      ---------------------------------------------------------------------------------------- //
///      `withdraw(assets, receiver, owner)` is denominated in ASSETS and burns a rounded-*up*, and
///      therefore unknown-at-signing, number of shares. `Step.amountIn` is a constant frozen into the
///      policy and is also the exact size of the allowance OpenZap grants, so a `withdraw` step could
///      only ever be authorised for a share count nobody can compute in advance — it would revert on
///      `InsufficientAllowance` whenever the vault's price moved by a wei. `redeem` is denominated in
///      SHARES: `amountIn` shares in, `amountIn` of allowance spent, exactly. Those line up, so
///      `redeem` is the only correct entry point here.
///
///      `owner = msg.sender` and `receiver = msg.sender`. The shares are burned straight out of the
///      zap and the assets are paid straight to the zap; nothing routes through this contract. That
///      is a deliberate deviation from the "pull `amountIn` from `msg.sender` first" shape the swap
///      and supply adapters use, and it is strictly less custody: a `transferFrom`-then-redeem
///      version would spend the identical allowance but leave the adapter transiently holding
///      somebody's shares. The bounded-pull guarantee that shape exists to provide is kept and
///      proved by measurement instead — the caller's share balance must fall by EXACTLY `amountIn`
///      (`InexactShareBurn`), so this adapter can never consume more than the policy named.
///
///      Because it never calls `approve`, it leaves no allowance of its own on any path. It cannot
///      revoke an allowance a caller granted it — only the owner of an allowance can. That is
///      harmless: this adapter's only use of an allowance is to redeem `msg.sender`'s own shares to
///      `msg.sender`, so a stale grant cannot be turned against its grantor by anyone. Under OpenZap
///      the question is moot, since `execute` resets the step approval to zero itself.
///
///      What this adapter refuses to do:
///      - It refuses any target, selector, route blob, receiver or owner from the caller. `data` is
///        either empty or exactly one `uint256 minAssetsOut`, a bounded typed scalar it enforces
///        itself.
///      - It refuses any token but the vault's own share token, i.e. the vault address.
///      - It refuses to run off Robinhood Chain (4663), checked at construction and on every call.
///        As with the deposit side this traps nothing: `ZapVault.redeem` remains callable directly by
///        whoever holds the shares, and `emergencyExit` can always move them out of a zap.
///      - It refuses to hold funds. Its own share and asset balances must be unchanged across the
///        call (`SharesMisdirected`, `ResidualAsset`); it does not sweep, because a sweep would mean
///        papering over a vault that ignored `receiver`.
///      - It refuses to report an unmeasured number. `amountOut` is the observed increase of the
///        *caller's* asset balance; the vault's return value is only a cross-check that must agree
///        exactly (`InexactAssetPayout`). That check is also what makes a fee-on-transfer underlying
///        fail loudly here, matching the vault's own refusal of such assets.
///      - It refuses to be reentered.
///
///      Honest note, inherited from `ZapVault`: a non-zero redeem that would pay out zero assets
///      reverts inside the vault with `ZeroAssets` rather than burning the shares for nothing. It
///      surfaces through this adapter as a clean revert and fails the whole zap run. That is the
///      intended outcome.
contract ZapVaultRedeemAdapter is IAdapter {
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    /// @notice The single `ZapVault` this adapter may redeem from. Also the only accepted `tokenIn`,
    ///         because an ERC-4626 vault is its own share token.
    address public immutable vault;
    /// @notice The vault's underlying ERC-20, read from the vault at construction. The `tokenOut`.
    address public immutable asset;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error UnsupportedToken(address token);
    error InvalidData();
    error ZeroAmount();
    error InexactShareBurn(uint256 expected, uint256 actual);
    error SharesMisdirected(uint256 expected, uint256 actual);
    error ResidualAsset(uint256 expected, uint256 actual);
    error NoOutput();
    error InexactAssetPayout(uint256 reported, uint256 measured);
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param vault_ The `ZapVault` this adapter is welded to.
    constructor(address vault_) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (vault_ == address(0)) revert ZeroAddress();
        _requireCode(vault_);

        address asset_ = IZapVaultRedeem(vault_).asset();
        if (asset_ == address(0)) revert ZeroAddress();
        _requireCode(asset_);

        vault = vault_;
        asset = asset_;
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn Must equal the immutable `vault` (the share token).
    /// @param amountIn Exact number of shares burned from `msg.sender`, spending the allowance
    ///        `msg.sender` granted this adapter on the share token.
    /// @param data Empty, or exactly `abi.encode(uint256 minAssetsOut)`. Nothing else is accepted.
    /// @return tokenOut The vault's underlying asset.
    /// @return amountOut The measured increase of `msg.sender`'s asset balance.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 minAssetsOut = _decodeMinOut(data);
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn != vault) revert UnsupportedToken(tokenIn);
        tokenOut = asset;

        uint256 selfSharesBefore = IERC20(vault).balanceOf(address(this));
        uint256 selfAssetBefore = IERC20(asset).balanceOf(address(this));
        uint256 callerSharesBefore = IERC20(vault).balanceOf(msg.sender);
        uint256 callerAssetBefore = IERC20(asset).balanceOf(msg.sender);

        // owner = receiver = msg.sender: burn the zap's shares, pay the zap. Nothing lands here.
        uint256 reported = IZapVaultRedeem(vault).redeem(amountIn, msg.sender, msg.sender);

        // Bounded consumption, proved by measurement rather than by taking custody first: the caller
        // must have lost EXACTLY the share count the policy named — no more (the whole point) and no
        // less (which would mean the burn did not happen where the payout was credited). Underflows
        // and reverts if the caller's share balance somehow grew.
        uint256 burned = callerSharesBefore - IERC20(vault).balanceOf(msg.sender);
        if (burned != amountIn) revert InexactShareBurn(amountIn, burned);

        uint256 selfSharesAfter = IERC20(vault).balanceOf(address(this));
        if (selfSharesAfter != selfSharesBefore) revert SharesMisdirected(selfSharesBefore, selfSharesAfter);
        uint256 selfAssetAfter = IERC20(asset).balanceOf(address(this));
        if (selfAssetAfter != selfAssetBefore) revert ResidualAsset(selfAssetBefore, selfAssetAfter);

        uint256 callerAssetAfter = IERC20(asset).balanceOf(msg.sender);
        if (callerAssetAfter <= callerAssetBefore) revert NoOutput();

        // Measured delta only. The vault's number is a cross-check that must agree exactly; it will
        // not for a fee-on-transfer or rebasing underlying, and refusing is the correct outcome.
        amountOut = callerAssetAfter - callerAssetBefore;
        if (amountOut != reported) revert InexactAssetPayout(reported, amountOut);
        if (amountOut < minAssetsOut) revert InsufficientOutput(minAssetsOut, amountOut);
    }

    function _decodeMinOut(bytes calldata data) private pure returns (uint256 minAssetsOut) {
        if (data.length == 0) return 0;
        if (data.length != 32) revert InvalidData();
        minAssetsOut = abi.decode(data, (uint256));
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
