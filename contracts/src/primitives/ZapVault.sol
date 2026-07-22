// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title ZapVault
/// @notice A deliberately boring, immutable ERC-4626 vault. Deposit an ERC-20, receive an ERC-20
///         receipt (the share token); burn the receipt, get the ERC-20 back. That single shape —
///         one ERC-20 in, one ERC-20 out — is what the OpenZap settlement model needs from a
///         "supply" venue, and Robinhood Chain has no contract that provides it.
///
/// @dev THIS CONTRACT IS UNAUDITED AND CUSTODIES REAL USER FUNDS. It has been unit-tested, not
///      reviewed by a third party. Read it in full before depositing; it is intentionally short
///      enough to do that in one sitting. Deposit only what you can afford to lose.
///
///      WHAT IT DOES NOT DO — read this list as the specification, not as a disclaimer:
///
///      * IT EARNS NOTHING. There is no strategy, no lending, no staking, no rehypothecation.
///        `totalAssets()` is literally `asset.balanceOf(this)`. A share appreciates if and only if
///        somebody sends assets to this contract without minting shares. Do not describe this as a
///        yield product; it is a receipt-token wrapper.
///      * NO ADMIN. No owner, no governor, no pauser, no guardian, no timelock, no `selfdestruct`,
///        no `delegatecall`, no proxy, no upgrade path, no initializer. Nobody — including the
///        deployer — can move a deposited asset except by burning the shares that claim it. The
///        consequence is symmetric: there is also no rescue path if you send the wrong token here.
///      * NO FEES. Not zero-by-default-but-settable: there is no fee variable and no code that
///        could read one.
///      * NO NATIVE ETH. There is no `receive()` and no `payable` function; ETH sent here reverts.
///      * NO FEE-ON-TRANSFER OR DEFLATIONARY ASSETS. Every asset movement is measured and must
///        match exactly, so such a token simply cannot be deposited or withdrawn (it reverts).
///        This is an explicit refusal, not silent mispricing.
///      * NO REBASING ASSET SUPPORT. Nothing breaks — a balance change accrues to every share
///        holder pro rata — but a negative rebase is a loss socialised across holders, and this
///        contract does nothing to warn about or resist it. Do not pair it with a rebasing asset.
///      * NO PERMIT (EIP-2612), no ERC-165, no flash loans, no deposit/withdraw hooks or callbacks,
///        no allowlist, no deposit cap, no queue, no share transfer restrictions.
///      * NO CHAIN GUARD. Unlike the adapters in `src/adapters`, this contract does not check
///        `block.chainid`. That is deliberate: a chain-id change (fork, renumbering) must never be
///        able to permanently trap deposited principal in a contract that has no admin rescue.
///
///      RESIDUAL RISK THIS CONTRACT CANNOT REMOVE: shares are a pro-rata claim on whatever balance
///      the asset contract credits to this vault. If the asset is upgradeable, pausable,
///      blacklisting, or seizable, its controller can freeze or confiscate that balance. A vault
///      cannot be safer than its underlying.
///
///      INFLATION / DONATION ATTACK: handled with the virtual shares+assets offset (OZ-style).
///      Every conversion prices against `totalSupply + VIRTUAL_SHARES` and `totalAssets +
///      VIRTUAL_ASSETS`, which makes the empty vault behave as if it were already seeded with
///      `VIRTUAL_SHARES` shares backing `VIRTUAL_ASSETS` wei. A first depositor who donates D to
///      round a later depositor's shares down must forfeit roughly `VIRTUAL_SHARES` times more
///      than they can capture, so the attack is unprofitable rather than merely inconvenient.
///      Belt and braces: a non-zero `deposit` that would round to zero shares reverts
///      (`ZeroShares`) instead of silently confiscating the deposit, and a non-zero `redeem` that
///      would pay zero assets reverts (`ZeroAssets`). Note the honest limit of this defence — it
///      makes the attack ruinous for the attacker and non-silent for the victim, but a sufficiently
///      rich griefer can still make small deposits revert. See `test/ZapVault.t.sol`.
///
///      KNOWN ERC-4626 DEVIATION: because of those two guards, `previewDeposit`/`previewRedeem` can
///      return 0 for an amount that the corresponding call then reverts on. The spec prefers
///      preview and call to agree. Reverting was chosen over silently burning a user's principal;
///      integrators must handle the revert.
///
///      ARITHMETIC: conversions use plain checked `a * b / c`. Inputs large enough to overflow the
///      intermediate product revert instead of truncating. This is a fail-closed refusal of absurd
///      values, chosen over a 512-bit mulDiv so the math stays auditable by eye.
///
///      ROUNDING: every path rounds in the vault's favour, i.e. against the caller —
///      `deposit`/`redeem` round the caller's output down, `mint`/`withdraw` round the caller's
///      input up. The share price is therefore non-decreasing under normal operation.
contract ZapVault {
    using SafeApprove for address;

    // --------------------------------------------------------------------- //
    // Immutable configuration                                                //
    // --------------------------------------------------------------------- //

    /// @notice The underlying ERC-20 this vault custodies (ERC-4626 `asset()`).
    address public immutable asset;

    /// @notice Share decimals: the asset's decimals plus `DECIMALS_OFFSET`.
    uint8 public immutable decimals;

    /// @dev Virtual-offset parameters. `VIRTUAL_SHARES` is the attacker's cost multiplier.
    uint8 internal constant DECIMALS_OFFSET = 3;
    uint256 internal constant VIRTUAL_SHARES = 1_000; // 10 ** DECIMALS_OFFSET
    uint256 internal constant VIRTUAL_ASSETS = 1;
    /// @dev Keeps `assetDecimals + DECIMALS_OFFSET` inside uint8 and rejects nonsense metadata.
    uint8 internal constant MAX_ASSET_DECIMALS = 36;

    // --------------------------------------------------------------------- //
    // Share token (ERC-20). Written once in the constructor, then never.     //
    // --------------------------------------------------------------------- //

    string public name;
    string public symbol;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @dev 0 = idle, 1 = entered.
    uint256 private _entered;

    // --------------------------------------------------------------------- //
    // Events                                                                 //
    // --------------------------------------------------------------------- //

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );

    // --------------------------------------------------------------------- //
    // Errors                                                                 //
    // --------------------------------------------------------------------- //

    error ZeroAddress();
    error NoCode(address target);
    error AssetDecimalsUnavailable();
    error AssetDecimalsTooLarge(uint256 assetDecimals);
    error InvalidReceiver(address receiver);
    error ZeroShares(uint256 assets);
    error ZeroAssets(uint256 shares);
    error InexactAssetTransfer(uint256 expected, uint256 actual);
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address owner, address spender, uint256 allowed, uint256 needed);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param asset_ The underlying ERC-20. Must have code and expose `decimals()`.
    /// @param name_ Share-token name.
    /// @param symbol_ Share-token symbol.
    constructor(address asset_, string memory name_, string memory symbol_) {
        if (asset_ == address(0)) revert ZeroAddress();
        if (asset_.code.length == 0) revert NoCode(asset_);

        (bool ok, bytes memory ret) = asset_.staticcall(abi.encodeWithSelector(IERC20Decimals.decimals.selector));
        if (!ok || ret.length < 32) revert AssetDecimalsUnavailable();
        uint256 assetDecimals = abi.decode(ret, (uint256));
        if (assetDecimals > MAX_ASSET_DECIMALS) revert AssetDecimalsTooLarge(assetDecimals);

        asset = asset_;
        // casting to 'uint8' is safe because assetDecimals <= MAX_ASSET_DECIMALS (36) is enforced above,
        // and 36 + DECIMALS_OFFSET (3) = 39 also fits in uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        decimals = uint8(assetDecimals) + DECIMALS_OFFSET;
        name = name_;
        symbol = symbol_;
    }

    // --------------------------------------------------------------------- //
    // ERC-4626 views                                                         //
    // --------------------------------------------------------------------- //

    /// @notice Assets under management: exactly this contract's balance of `asset`. Nothing is ever
    ///         lent out, staked, or otherwise held anywhere else, so there is no oracle, no accrual
    ///         and no stale-price surface here.
    function totalAssets() public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _toShares(assets, false);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, false);
    }

    /// @dev Rounds down: the depositor never receives a share they did not fully pay for.
    function previewDeposit(uint256 assets) public view returns (uint256) {
        return _toShares(assets, false);
    }

    /// @dev Rounds up: the minter always pays at least what the shares are worth.
    function previewMint(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, true);
    }

    /// @dev Rounds up: the withdrawer always burns at least the shares their assets are worth.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _toShares(assets, true);
    }

    /// @dev Rounds down: the redeemer never receives more than their shares are worth.
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, false);
    }

    /// @dev Unbounded — there is no cap and no pause. Extreme values revert inside the conversion
    ///      arithmetic rather than being silently accepted.
    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    /// @dev Unbounded, same reasoning as `maxDeposit`.
    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return _toAssets(balanceOf[owner], false);
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }

    // --------------------------------------------------------------------- //
    // ERC-4626 mutative entry points                                         //
    // --------------------------------------------------------------------- //

    /// @notice Deposit exactly `assets`, receive the (rounded-down) share amount.
    /// @dev Reverts rather than accepting a non-zero deposit that rounds to zero shares — that case
    ///      is a 100% loss for the depositor and is exactly what a share-price inflation front-run
    ///      tries to engineer. `deposit(0)` is still a legal no-op.
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        _requireReceiver(receiver);
        shares = _toShares(assets, false); // priced BEFORE the asset lands, per ERC-4626
        if (shares == 0 && assets != 0) revert ZeroShares(assets);
        _pullExact(assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Mint exactly `shares`, paying the (rounded-up) asset amount.
    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        _requireReceiver(receiver);
        assets = _toAssets(shares, true);
        _pullExact(assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Withdraw exactly `assets`, burning the (rounded-up) share amount from `owner`.
    function withdraw(uint256 assets, address receiver, address owner) external nonReentrant returns (uint256 shares) {
        _requireReceiver(receiver);
        shares = _toShares(assets, true);
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares); // burn before the external transfer (checks-effects-interactions)
        _pushExact(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /// @notice Burn exactly `shares` from `owner`, paying out the (rounded-down) asset amount.
    /// @dev Reverts rather than burning non-zero shares for zero assets. `redeem(0)` is a no-op.
    function redeem(uint256 shares, address receiver, address owner) external nonReentrant returns (uint256 assets) {
        _requireReceiver(receiver);
        assets = _toAssets(shares, false);
        if (assets == 0 && shares != 0) revert ZeroAssets(shares);
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares);
        _pushExact(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    // --------------------------------------------------------------------- //
    // Share token (ERC-20)                                                   //
    // --------------------------------------------------------------------- //

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (msg.sender != from) _spendAllowance(from, msg.sender, value);
        _transfer(from, to, value);
        return true;
    }

    // --------------------------------------------------------------------- //
    // Internals                                                              //
    // --------------------------------------------------------------------- //

    /// @dev shares = assets * (totalSupply + VIRTUAL_SHARES) / (totalAssets + VIRTUAL_ASSETS)
    function _toShares(uint256 assets, bool roundUp) private view returns (uint256) {
        uint256 numerator = assets * (totalSupply + VIRTUAL_SHARES);
        uint256 denominator = totalAssets() + VIRTUAL_ASSETS;
        return roundUp ? _ceilDiv(numerator, denominator) : numerator / denominator;
    }

    /// @dev assets = shares * (totalAssets + VIRTUAL_ASSETS) / (totalSupply + VIRTUAL_SHARES)
    function _toAssets(uint256 shares, bool roundUp) private view returns (uint256) {
        uint256 numerator = shares * (totalAssets() + VIRTUAL_ASSETS);
        uint256 denominator = totalSupply + VIRTUAL_SHARES;
        return roundUp ? _ceilDiv(numerator, denominator) : numerator / denominator;
    }

    /// @dev `denominator` is always >= 1 here (both are a sum with a non-zero virtual constant).
    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        if (numerator == 0) return 0;
        return (numerator - 1) / denominator + 1;
    }

    /// @dev Rejects the zero address (would burn shares or assets) and this contract (share dust
    ///      stuck forever, or an accidental donation on the way out).
    function _requireReceiver(address receiver) private view {
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver(receiver);
    }

    /// @dev Pulls exactly `assets` in and proves it by measured delta. A fee-on-transfer or
    ///      deflationary asset credits less than it was sent and therefore reverts here — the vault
    ///      refuses such tokens outright rather than mispricing them.
    function _pullExact(uint256 assets) private {
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), assets);
        uint256 received = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (received != assets) revert InexactAssetTransfer(assets, received);
    }

    /// @dev Sends exactly `assets` out and proves the vault's own balance fell by exactly that.
    ///      Catches an asset that charges the sender a fee on top of the transferred value. It
    ///      cannot prove what `receiver` was credited, so an asset that only becomes
    ///      fee-on-transfer after deployment can still shortchange a withdrawer; that is stated
    ///      here rather than papered over.
    function _pushExact(address receiver, uint256 assets) private {
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        asset.safeTransfer(receiver, assets);
        uint256 sent = balanceBefore - IERC20(asset).balanceOf(address(this)); // reverts if balance grew
        if (sent != assets) revert InexactAssetTransfer(assets, sent);
    }

    function _mint(address to, uint256 shares) private {
        totalSupply += shares;
        unchecked {
            balanceOf[to] += shares; // cannot exceed totalSupply, which is checked above
        }
        emit Transfer(address(0), to, shares);
    }

    function _burn(address from, uint256 shares) private {
        uint256 balance = balanceOf[from];
        if (balance < shares) revert InsufficientBalance(from, balance, shares);
        unchecked {
            balanceOf[from] = balance - shares;
            totalSupply -= shares;
        }
        emit Transfer(from, address(0), shares);
    }

    function _transfer(address from, address to, uint256 shares) private {
        if (to == address(0)) revert InvalidReceiver(to);
        uint256 balance = balanceOf[from];
        if (balance < shares) revert InsufficientBalance(from, balance, shares);
        unchecked {
            balanceOf[from] = balance - shares;
            balanceOf[to] += shares;
        }
        emit Transfer(from, to, shares);
    }

    /// @dev `type(uint256).max` is treated as an infinite allowance and is not decremented.
    function _spendAllowance(address owner, address spender, uint256 shares) private {
        uint256 allowed = allowance[owner][spender];
        if (allowed == type(uint256).max) return;
        if (allowed < shares) revert InsufficientAllowance(owner, spender, allowed, shares);
        unchecked {
            allowance[owner][spender] = allowed - shares;
        }
        emit Approval(owner, spender, allowed - shares);
    }
}
