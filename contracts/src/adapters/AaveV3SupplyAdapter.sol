// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAdapter} from "../interfaces/IAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function getReserveAToken(address asset) external view returns (address);
}

interface IAaveV3AToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

/// @title AaveV3SupplyAdapter
/// @notice Supplies one immutable Aave v3 reserve on Base on behalf of the calling zap, so the zap —
///         not this adapter — becomes the Aave account holder and receives the aToken.
/// @dev The whole point of this adapter is that it is a *credential*, not a router. The Aave Pool and
///      the single reserve it may touch are constructor immutables, so allowlisting this adapter in
///      `AdapterRegistry` is exactly equivalent to allowlisting the sentence "supply <asset> to <pool>".
///
///      What this adapter refuses to do:
///      - It refuses any `data`. There are no routing bytes, no target, no selector, no referral code
///        and no `onBehalfOf` a caller could steer. `onBehalfOf` is always `msg.sender`; a policy can
///        never redirect a supply to a third party.
///      - It refuses any token but its own immutable `asset`, and it refuses to run off Base (8453) —
///        checked in the constructor and again on every call, so a chain fork cannot repoint it.
///      - It refuses to keep an allowance. The exact `amountIn` is approved to the Pool and reset to
///        zero in the same call; any revert unwinds the approval with the transaction.
///      - It refuses to hold funds. It reverts (rather than sweeping or papering over it) if the input
///        did not fully leave, or if an aToken landed on itself — either can only mean the Pool ignored
///        `onBehalfOf`, and a silent sweep would turn a broken Pool into a plausible-looking receipt.
///      - It refuses to report an unmeasured number. `amountOut` is the observed increase of the
///        *caller's* aToken balance across the supply, never `amountIn` and never a Pool return value.
///
///      Two honest caveats, both inherent to Aave rather than to this adapter:
///      - aTokens are rebasing. `supply` bumps the reserve's liquidity index first, so if the caller
///        already held this aToken the measured delta is the supplied principal *plus* the interest
///        that accrued to that pre-existing balance in the same transaction. That interest is the
///        caller's own, and OpenZap settles it to the caller's policy recipient like any other gain.
///      - Aave's ray round-trip (`rayDiv` at mint, `rayMul` at read) can make the measured delta differ
///        from `amountIn` by a wei. Never assume `amountOut == amountIn`; the zap's signed `minOut` is
///        the only slippage authority.
///
///      There is deliberately no matching borrow adapter. See `AaveV3BorrowAdapter.sol` for why the
///      borrow leg cannot be expressed under `IAdapter` at all, and the fork tests that prove it.
contract AaveV3SupplyAdapter is IAdapter {
    uint256 public constant BASE_CHAIN_ID = 8453;
    uint16 private constant NO_REFERRAL = 0;

    /// @notice The Aave v3 Pool this adapter is welded to.
    address public immutable pool;
    /// @notice The single reserve this adapter may supply.
    address public immutable asset;
    /// @notice The reserve's aToken, resolved from the Pool at construction and re-checked every call.
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
    error InexactInputTransfer(uint256 expected, uint256 received);
    error ResidualInput(uint256 expected, uint256 actual);
    error ATokenMisdirected(uint256 expected, uint256 actual);
    error NoOutput();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param pool_ Aave v3 Pool (Base mainnet: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5).
    /// @param asset_ The one reserve this adapter is allowed to supply. One adapter per reserve.
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
    /// @param tokenIn Must equal the immutable `asset`.
    /// @param amountIn Exact units of `asset` pulled from `msg.sender` and supplied.
    /// @param data Must be empty. This adapter takes no parameters of any kind.
    /// @return tokenOut The reserve's aToken.
    /// @return amountOut The measured increase of `msg.sender`'s aToken balance.
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (data.length != 0) revert UnexpectedData();
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn != asset) revert UnsupportedToken(tokenIn);

        // Aave governance can swap a reserve's aToken implementation *and* its address. If that ever
        // happens, stop: measuring a stale aToken would report a gain the zap never received.
        address live = IAaveV3Pool(pool).getReserveAToken(asset);
        if (live != aToken) revert ATokenReplaced(aToken, live);
        tokenOut = aToken;

        // Deltas, never absolute balances: a donation to this adapter must not become someone's output.
        uint256 inputBefore = IERC20(asset).balanceOf(address(this));
        uint256 selfATokenBefore = IERC20(aToken).balanceOf(address(this));
        uint256 callerATokenBefore = IERC20(aToken).balanceOf(msg.sender);

        SafeApprove.safeTransferFrom(asset, msg.sender, address(this), amountIn);
        uint256 received = IERC20(asset).balanceOf(address(this)) - inputBefore;
        if (received != amountIn) revert InexactInputTransfer(amountIn, received);

        SafeApprove.approveExact(asset, pool, amountIn);
        // onBehalfOf = msg.sender: the aToken, the collateral flag and the Aave account are the zap's.
        IAaveV3Pool(pool).supply(asset, amountIn, msg.sender, NO_REFERRAL);
        SafeApprove.approveExact(asset, pool, 0);

        uint256 inputAfter = IERC20(asset).balanceOf(address(this));
        if (inputAfter != inputBefore) revert ResidualInput(inputBefore, inputAfter);
        uint256 selfATokenAfter = IERC20(aToken).balanceOf(address(this));
        if (selfATokenAfter != selfATokenBefore) revert ATokenMisdirected(selfATokenBefore, selfATokenAfter);

        uint256 callerATokenAfter = IERC20(aToken).balanceOf(msg.sender);
        if (callerATokenAfter <= callerATokenBefore) revert NoOutput();
        amountOut = callerATokenAfter - callerATokenBefore;
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
