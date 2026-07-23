// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

interface IAaveV3Pool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getReserveAToken(address asset) external view returns (address);
}

interface IAaveV3AToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

/// @title AaveV3WithdrawAdapter
/// @notice The unwind leg for `AaveV3SupplyAdapter`: aToken in, the reserve's underlying out, both
///         sides booked to the calling zap. One deployment serves exactly one reserve on one Aave v3
///         Pool, welded in at construction — the same shape as the supply adapter, run backwards.
/// @dev Together with `AaveV3SupplyAdapter` this makes an Aave position something a frozen OpenZap
///      policy can both enter and leave, instead of a one-way door only `emergencyExit` could reopen.
///
///      ---------------------------------------------------------------------------------------- //
///      WHY THIS DIRECTION MUST TAKE CUSTODY — unlike the ERC-4626 vault redeem.
///      ---------------------------------------------------------------------------------------- //
///      `ZapVaultRedeemAdapter` never touches the shares: ERC-4626's `redeem(shares, receiver, owner)`
///      spends the plain ERC-20 allowance `allowance[owner][msg.sender]` on the share token, and
///      `OpenZap.execute` already emits exactly that `approve`. Aave has NO such `owner` parameter.
///      `Pool.withdraw(asset, amount, to)` burns the aToken from `msg.sender` — the caller of
///      `withdraw`, which is this adapter — and there is no way to name a different account whose
///      aToken should be burned. So this adapter must first pull the zap's aToken into itself with the
///      one allowance OpenZap grants (`tokenIn = aToken`, `spender = adapter`), then withdraw as
///      itself. That transient custody is bounded by the allowance and measured; it is the minimum
///      Aave's surface allows, and every claim here is proved on a Base-mainnet fork.
///
///      ---------------------------------------------------------------------------------------- //
///      NO approval to the Pool. The Pool burns the aToken; it does not pull it.
///      ---------------------------------------------------------------------------------------- //
///      A withdraw needs NO `approve(aToken, pool)`. Aave's Pool calls `aToken.burn(msg.sender, ...)`
///      through the aToken's `onlyPool` entry point, which decrements the caller's scaled balance
///      directly — it never routes through the ERC-20 allowance surface. Proved on the fork with the
///      adapter holding a zero aToken→Pool allowance throughout
///      (`test_withdraw_needsNoATokenAllowanceToThePool`). The only approval in play is the
///      zap → adapter aToken allowance for the pull, and OpenZap resets that to zero itself.
///
///      ---------------------------------------------------------------------------------------- //
///      It withdraws `type(uint256).max`, i.e. it FLUSHES its whole aToken balance every call.
///      ---------------------------------------------------------------------------------------- //
///      aTokens are rebasing: `balanceOf` is a scaled balance re-multiplied by the reserve's liquidity
///      index, so no face amount you can pass to `withdraw` maps to an exact scaled burn — a ray
///      round-trip can shave or strand a wei. Passing the nominal `amountIn` can even revert
///      `NOT_ENOUGH_AVAILABLE_USER_BALANCE` on that wei. The one amount that burns an EXACT scaled
///      quantity is `type(uint256).max`: Aave withdraws the caller's entire scaled balance, leaving it
///      at precisely zero. Because this adapter pulls the caller's aToken into itself first and then
///      withdraws max, it always leaves with a zero aToken balance and zero scaled balance — proved on
///      the fork to hold to the wei, even after a 30-day index tick and even with a stray aToken parked
///      on the adapter (`test_withdraw_flushesToZeroResidual`). It can therefore never accumulate
///      aToken dust; it is stateless between calls by construction.
///
///      The honest consequence of flushing, spelled out rather than hidden: this is a pass-through, not
///      a vault. Do NOT transfer aTokens directly to it. Any aToken sitting on the adapter when
///      `execute` runs is withdrawn along with the caller's own and paid to `msg.sender` — the calling
///      zap's frozen recipient. That is finders-keepers on a misdirected donation, the same property
///      every non-custodial router has; it is never a theft from a zap (a zap's aTokens live on the
///      zap, protected by its allowance, and are only ever pulled up to the exact `amountIn` a signed
///      intent authorises) and it can never strand funds. The alternative — refusing to run while any
///      stray balance is present — would let one wei of donated aToken brick the shared adapter for
///      everyone, which is strictly worse.
///
///      What this adapter refuses to do:
///      - It refuses any `data`. There are no routing bytes, no target, no selector, no `to` a caller
///        could steer. `to` is always `msg.sender`; a policy can never redirect the underlying to a
///        third party. There is deliberately no `minOut` either: a withdraw is 1:1 in the reserve, not
///        a swap, so OpenZap's owner-signed final-output check is the sole slippage authority — exactly
///        as for the supply leg.
///      - It refuses any token but its own immutable `aToken`, and it refuses to run off Base (8453),
///        checked in the constructor and again on every call so a chain fork cannot repoint it.
///      - It refuses to hold the underlying. The Pool pays it straight to `msg.sender`; the adapter
///        reverts (rather than sweeping) if any underlying landed on itself, which could only mean the
///        Pool ignored `to`, and a silent sweep would turn a broken Pool into a plausible receipt.
///      - It refuses to leave any aToken behind. After the flush its aToken balance must be exactly
///        zero (`ATokenResidual`).
///      - It refuses to report an unmeasured number. `amountOut` is the observed increase of the
///        *caller's* underlying balance, cross-checked to equal the Pool's own return value
///        (`InexactAssetPayout`); a fee-on-transfer or rebasing underlying makes that check fail
///        loudly, which is the correct outcome.
///      - It refuses to be reentered.
///
///      Honest caveat, inherent to Aave rather than to this adapter: the reserve must have enough free
///      liquidity to honor the withdraw, and Aave forbids a withdraw that would drop the caller's
///      health factor below one. Both surface here as a clean revert of the whole zap run — funds
///      untouched, nonce unburned — and `emergencyExit` remains the unconditional escape either way.
contract AaveV3WithdrawAdapter is IAdapter {
    uint256 public constant BASE_CHAIN_ID = 8453;
    /// @dev Aave's "withdraw everything" sentinel; withdraws the caller's entire scaled balance.
    uint256 private constant WITHDRAW_ALL = type(uint256).max;

    /// @notice The Aave v3 Pool this adapter is welded to.
    address public immutable pool;
    /// @notice The single reserve's underlying asset — this adapter's `tokenOut`.
    address public immutable asset;
    /// @notice The reserve's aToken — this adapter's only accepted `tokenIn`. Resolved from the Pool
    ///         at construction and re-checked every call.
    address public immutable aToken;

    uint256 private _entered;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error ReserveNotListed(address asset);
    error ATokenMismatch(address aToken, address underlying);
    error ATokenReplaced(address expected, address actual);
    error UnsupportedToken(address token);
    error UnexpectedData();
    error ZeroAmount();
    error ATokenResidual(uint256 expected, uint256 actual);
    error ResidualOutput(uint256 expected, uint256 actual);
    error NoOutput();
    error InexactAssetPayout(uint256 reported, uint256 measured);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param pool_ Aave v3 Pool (Base mainnet: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5).
    /// @param asset_ The one reserve this adapter is allowed to withdraw. One adapter per reserve.
    constructor(address pool_, address asset_) {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (pool_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        _requireCode(pool_);
        _requireCode(asset_);

        address aToken_ = IAaveV3Pool(pool_).getReserveAToken(asset_);
        if (aToken_ == address(0)) revert ReserveNotListed(asset_);
        _requireCode(aToken_);
        address underlying = IAaveV3AToken(aToken_).UNDERLYING_ASSET_ADDRESS();
        if (underlying != asset_) revert ATokenMismatch(aToken_, underlying);

        pool = pool_;
        asset = asset_;
        aToken = aToken_;
    }

    /// @inheritdoc IAdapter
    /// @param tokenIn Must equal the immutable `aToken`.
    /// @param amountIn Exact face units of the aToken pulled from `msg.sender`. Bounded by the
    ///        allowance `msg.sender` granted this adapter, so it can never pull more than the policy
    ///        named. The pulled aToken (plus any stray balance — see the contract notice) is then
    ///        withdrawn in full.
    /// @param data Must be empty. This adapter takes no parameters of any kind.
    /// @return tokenOut The reserve's underlying asset.
    /// @return amountOut The measured increase of `msg.sender`'s underlying balance.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (data.length != 0) revert UnexpectedData();
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn != aToken) revert UnsupportedToken(tokenIn);

        // Aave governance can swap a reserve's aToken implementation *and* its address. If that ever
        // happens, stop: pulling or measuring a stale aToken would be meaningless.
        address live = IAaveV3Pool(pool).getReserveAToken(asset);
        if (live != aToken) revert ATokenReplaced(aToken, live);
        tokenOut = asset;

        // Deltas, never absolute balances. The underlying is paid to the caller, so measure the
        // caller's gain; the adapter's own underlying balance must be unchanged by the end.
        uint256 selfAssetBefore = IERC20(asset).balanceOf(address(this));
        uint256 callerAssetBefore = IERC20(asset).balanceOf(msg.sender);

        // Pull the caller's aToken into this adapter, bounded by the allowance OpenZap granted. No
        // approval to the Pool follows: the Pool burns this adapter's aToken directly through the
        // aToken's onlyPool path (proved on the fork).
        SafeApprove.safeTransferFrom(aToken, msg.sender, address(this), amountIn);

        // Withdraw the adapter's ENTIRE aToken balance to the caller. `max` is the only amount that
        // burns an exact scaled quantity, so the adapter always ends at a zero aToken balance — it can
        // never accumulate dust. `to = msg.sender`: the underlying is paid straight to the zap.
        uint256 reported = IAaveV3Pool(pool).withdraw(asset, WITHDRAW_ALL, msg.sender);

        // The flush must have left nothing behind, and the underlying must have gone to the caller.
        uint256 selfATokenAfter = IERC20(aToken).balanceOf(address(this));
        if (selfATokenAfter != 0) revert ATokenResidual(0, selfATokenAfter);
        uint256 selfAssetAfter = IERC20(asset).balanceOf(address(this));
        if (selfAssetAfter != selfAssetBefore) revert ResidualOutput(selfAssetBefore, selfAssetAfter);

        uint256 callerAssetAfter = IERC20(asset).balanceOf(msg.sender);
        if (callerAssetAfter <= callerAssetBefore) revert NoOutput();

        // Measured delta only. The Pool's return value is a cross-check that must agree exactly; it
        // will not for a fee-on-transfer or rebasing underlying, and refusing is the correct outcome.
        amountOut = callerAssetAfter - callerAssetBefore;
        if (amountOut != reported) revert InexactAssetPayout(reported, amountOut);
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
