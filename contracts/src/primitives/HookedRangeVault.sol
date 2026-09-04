// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {V4PoolMath} from "../libraries/V4PoolMath.sol";

interface IHookedV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title HookedRangeVault
/// @notice `ZapRangeVault` for a HOOKED Uniswap v4 pool: a full-range position on ONE fixed pool
///         whose key carries a hook, wrapped as an ERC-20 share token. Built for the pools the
///         Hookr launchpad graduates (dynamic-fee, tick spacing 60, one shared hook), where the
///         token side is a fresh launch and the quote side is HOOKR.
///
/// @dev THIS CONTRACT IS UNAUDITED AND CUSTODIES REAL USER FUNDS. Same verdict, same posture as
///      `ZapRangeVault`: no admin, no fees to anyone, no range management, no native ETH, no
///      donation accounting, no chain guard. Read that contract's header for the full
///      specification; only the differences are stated here.
///
///      WHAT A HOOK CAN AND CANNOT DO TO THIS VAULT — enforced structurally, not by trust:
///
///      * The hook is pinned at construction and lives in the pool id; this vault can never LP
///        into a pool with a different hook (or no hook).
///      * The hook's PERMISSION BITS are read off its address (v4-core `Hooks` encodes them in the
///        low 14 bits) and the constructor REFUSES any hook that can act on liquidity removal or
///        that can return a delta on liquidity changes:
///          - BEFORE_REMOVE_LIQUIDITY / AFTER_REMOVE_LIQUIDITY: a hook with either could block or
///            observe-and-front-run redemptions. Refused, so a redeem can never be vetoed.
///          - AFTER_ADD_LIQUIDITY_RETURNS_DELTA / AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: a hook with
///            either could skim principal on the way in or out. Refused, so the pool's own
///            `modifyLiquidity` delta is the only settlement authority, exactly as in the
///            hookless vault.
///        BEFORE_ADD_LIQUIDITY is allowed: the Hookr hook uses it to fence outside LPs out for a
///        finite anti-snipe window after launch. During that window a deposit REVERTS (fail
///        closed); after it, deposits are permissionless. AFTER_ADD_LIQUIDITY (no delta) is
///        allowed for the same reason: it can observe, not take.
///      * Swap-side hook behaviour (dynamic fee, surge fee, swap deltas) does not touch this
///        contract: it never swaps. The fee it EARNS is whatever the hook sets per swap; the
///        `feesAccrued` delta from `modifyLiquidity` is the pool's own accounting of it.
///      * The dynamic-fee flag (`0x800000`) is accepted because every Hookr pool carries it. A
///        static fee is also accepted for a hooked pool that uses one.
///
///      This vault still passes EMPTY hookData on every liquidity change. A hook that requires
///      hookData to admit liquidity is incompatible by design: hookData is exactly the arbitrary
///      routing bytes the OpenZap model refuses.
contract HookedRangeVault {
    using SafeApprove for address;

    // --------------------------------------------------------------------- //
    // Immutable configuration                                                //
    // --------------------------------------------------------------------- //

    address public immutable poolManager;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    /// @notice The pinned hook. Nonzero by construction; its permission bits were vetted.
    address public immutable hooks;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint160 public immutable sqrtPriceLowerX96;
    uint160 public immutable sqrtPriceUpperX96;
    /// @notice The v4 pool id this vault LPs into, `keccak256(abi.encode(poolKey))`.
    bytes32 public immutable poolId;

    uint8 public constant decimals = 18;

    uint256 private constant POOLS_SLOT = 6;
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000;
    uint24 private constant MAX_STATIC_FEE = 1_000_000;

    /// @dev v4-core `Hooks` flag bits, read off the low 14 bits of the hook address.
    uint160 private constant BEFORE_REMOVE_LIQUIDITY_FLAG = 1 << 9;
    uint160 private constant AFTER_REMOVE_LIQUIDITY_FLAG = 1 << 8;
    uint160 private constant AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG = 1 << 1;
    uint160 private constant AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG = 1 << 0;
    uint160 private constant REFUSED_HOOK_FLAGS = BEFORE_REMOVE_LIQUIDITY_FLAG | AFTER_REMOVE_LIQUIDITY_FLAG
        | AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;

    uint256 private constant VIRTUAL_SHARES = 1_000;
    uint256 private constant VIRTUAL_LIQUIDITY = 1;

    // --------------------------------------------------------------------- //
    // Share token (ERC-20)                                                   //
    // --------------------------------------------------------------------- //

    string public name;
    string public symbol;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // --------------------------------------------------------------------- //
    // Position accounting                                                    //
    // --------------------------------------------------------------------- //

    uint128 public positionLiquidity;
    uint256 public reserve0;
    uint256 public reserve1;

    uint256 private _entered;

    // --------------------------------------------------------------------- //
    // Events                                                                 //
    // --------------------------------------------------------------------- //

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(
        address indexed sender,
        address indexed receiver,
        uint256 amount0Used,
        uint256 amount1Used,
        uint128 liquidityAdded,
        uint256 shares
    );
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 amount0,
        uint256 amount1,
        uint128 liquidityRemoved,
        uint256 shares
    );
    event Compounded(uint128 liquidityAdded, uint256 fees0, uint256 fees1);

    // --------------------------------------------------------------------- //
    // Errors                                                                 //
    // --------------------------------------------------------------------- //

    error ZeroAddress();
    error NoCode(address target);
    error NativeCurrencyUnsupported();
    error InvalidCurrencyOrder();
    error HookRequired();
    error HookPermissionsRefused(address hooks, uint160 refusedFlags);
    error InvalidFee(uint24 value);
    error InvalidTickSpacing(int24 value);
    error PoolNotInitialized();
    error InvalidReceiver(address receiver);
    error ZeroLiquidity(uint256 amount0, uint256 amount1);
    error ZeroShares(uint128 liquidityAdded);
    error ZeroAssets(uint256 shares);
    error InsufficientShares(uint256 minimum, uint256 actual);
    error InsufficientOutput(uint256 minimum0, uint256 minimum1, uint256 actual0, uint256 actual1);
    error InexactTokenTransfer(address token, uint256 expected, uint256 actual);
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address owner, address spender, uint256 allowed, uint256 needed);
    error InsufficientReserve(address token, uint256 reserve, uint256 needed);
    error NotPoolManager(address caller);
    error UnexpectedCallback();
    error UnexpectedFeeDelta();
    error UnexpectedPrincipalDelta();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @param poolManager_ The v4 PoolManager the pool lives in.
    /// @param currency0_ Lower-sorted pool currency. Must be a real ERC-20.
    /// @param currency1_ Higher-sorted pool currency.
    /// @param fee_ The pool key's fee: the dynamic-fee flag or a static fee.
    /// @param tickSpacing_ Pool tick spacing; also fixes the full-range bounds.
    /// @param hooks_ The pool's hook. Required; its permission bits are vetted.
    /// @param name_ Share-token name.
    /// @param symbol_ Share-token symbol.
    constructor(
        address poolManager_,
        address currency0_,
        address currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        address hooks_,
        string memory name_,
        string memory symbol_
    ) {
        if (poolManager_ == address(0)) revert ZeroAddress();
        if (currency0_ == address(0)) revert NativeCurrencyUnsupported();
        if (currency1_ == address(0)) revert ZeroAddress();
        if (currency0_ >= currency1_) revert InvalidCurrencyOrder();
        if (hooks_ == address(0)) revert HookRequired();
        uint160 refused = uint160(hooks_) & REFUSED_HOOK_FLAGS;
        if (refused != 0) revert HookPermissionsRefused(hooks_, refused);
        if (fee_ != DYNAMIC_FEE_FLAG && fee_ > MAX_STATIC_FEE) revert InvalidFee(fee_);
        if (tickSpacing_ < 1 || tickSpacing_ > 32767) revert InvalidTickSpacing(tickSpacing_);
        _requireCode(poolManager_);
        _requireCode(currency0_);
        _requireCode(currency1_);
        _requireCode(hooks_);

        poolManager = poolManager_;
        currency0 = currency0_;
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;
        (tickLower, tickUpper) = V4PoolMath.usableTickRange(tickSpacing_);
        sqrtPriceLowerX96 = V4PoolMath.getSqrtPriceAtTick(tickLower);
        sqrtPriceUpperX96 = V4PoolMath.getSqrtPriceAtTick(tickUpper);
        poolId = keccak256(abi.encode(currency0_, currency1_, fee_, tickSpacing_, hooks_));
        name = name_;
        symbol = symbol_;

        _currentSqrtPrice();
    }

    // --------------------------------------------------------------------- //
    // Deposit / redeem                                                       //
    // --------------------------------------------------------------------- //

    /// @notice Deposit up to `amount0`/`amount1`, receive shares priced in position liquidity.
    ///         Whatever the current pool ratio cannot absorb is refunded in the same call.
    ///         Reverts while the hook's anti-snipe guard fences outside liquidity out.
    function deposit(uint256 amount0, uint256 amount1, uint256 minShares, address receiver)
        external
        nonReentrant
        returns (uint256 shares, uint256 used0, uint256 used1)
    {
        _requireReceiver(receiver);
        _compound();

        if (amount0 != 0) _pullExact(currency0, amount0);
        if (amount1 != 0) _pullExact(currency1, amount1);

        uint128 liquidityAdded = V4PoolMath.getLiquidityForAmounts(
            _currentSqrtPrice(), sqrtPriceLowerX96, sqrtPriceUpperX96, amount0, amount1
        );
        if (liquidityAdded == 0) revert ZeroLiquidity(amount0, amount1);

        shares = _toShares(liquidityAdded, false);
        if (shares == 0) revert ZeroShares(liquidityAdded);
        if (shares < minShares) revert InsufficientShares(minShares, shares);

        (uint256 owed0, uint256 owed1, uint256 fees0, uint256 fees1) = _modifyPosition(int256(uint256(liquidityAdded)));
        positionLiquidity += liquidityAdded;
        reserve0 += fees0;
        reserve1 += fees1;

        used0 = _settleDepositLeg(currency0, amount0, owed0);
        used1 = _settleDepositLeg(currency1, amount1, owed1);

        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, used0, used1, liquidityAdded, shares);
    }

    /// @notice Burn `shares` from `owner`, removing the pro-rata position liquidity and paying out
    ///         both currencies plus a pro-rata slice of tracked reserves. Cannot be vetoed by the
    ///         hook: hooks with removal permissions are refused at construction.
    function redeem(uint256 shares, uint256 min0, uint256 min1, address receiver, address owner)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        _requireReceiver(receiver);
        _compound();

        uint256 liquidityShare = _toLiquidity(shares, false);
        uint256 supply = totalSupply;
        uint256 reservePay0 = supply == 0 ? 0 : (reserve0 * shares) / supply;
        uint256 reservePay1 = supply == 0 ? 0 : (reserve1 * shares) / supply;

        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares);

        uint256 principal0;
        uint256 principal1;
        // casting to 'uint128' is safe: _toLiquidity is bounded by positionLiquidity (uint128).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 liquidityRemoved = uint128(liquidityShare);
        if (liquidityRemoved != 0) {
            uint256 fees0;
            uint256 fees1;
            (principal0, principal1, fees0, fees1) = _modifyPosition(-int256(liquidityShare));
            positionLiquidity -= liquidityRemoved;
            reserve0 += fees0;
            reserve1 += fees1;
        }

        reserve0 -= reservePay0;
        reserve1 -= reservePay1;
        amount0 = principal0 + reservePay0;
        amount1 = principal1 + reservePay1;
        if (amount0 == 0 && amount1 == 0 && shares != 0) revert ZeroAssets(shares);
        if (amount0 < min0 || amount1 < min1) revert InsufficientOutput(min0, min1, amount0, amount1);

        if (amount0 != 0) _pushExact(currency0, receiver, amount0);
        if (amount1 != 0) _pushExact(currency1, receiver, amount1);
        emit Withdraw(msg.sender, receiver, owner, amount0, amount1, liquidityRemoved, shares);
    }

    // --------------------------------------------------------------------- //
    // Views                                                                  //
    // --------------------------------------------------------------------- //

    function poolKey() external view returns (IHookedV4PoolManager.PoolKey memory) {
        return _poolKey();
    }

    function currentSqrtPriceX96() external view returns (uint160) {
        return _currentSqrtPrice();
    }

    function previewDeposit(uint256 amount0, uint256 amount1)
        external
        view
        returns (uint256 shares, uint128 liquidityAdded)
    {
        liquidityAdded = V4PoolMath.getLiquidityForAmounts(
            _currentSqrtPrice(), sqrtPriceLowerX96, sqrtPriceUpperX96, amount0, amount1
        );
        shares = _toShares(liquidityAdded, false);
    }

    function previewRedeem(uint256 shares) external view returns (uint256 amount0, uint256 amount1) {
        uint256 liquidityShare = _toLiquidity(shares, false);
        // casting to 'uint128' is safe: bounded by positionLiquidity (uint128).
        // forge-lint: disable-next-line(unsafe-typecast)
        (amount0, amount1) = V4PoolMath.getAmountsForLiquidity(
            _currentSqrtPrice(), sqrtPriceLowerX96, sqrtPriceUpperX96, uint128(liquidityShare)
        );
        uint256 supply = totalSupply;
        if (supply != 0) {
            amount0 += (reserve0 * shares) / supply;
            amount1 += (reserve1 * shares) / supply;
        }
    }

    // --------------------------------------------------------------------- //
    // v4 unlock callback                                                     //
    // --------------------------------------------------------------------- //

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);
        if (_entered != 1) revert UnexpectedCallback();

        int256 liquidityDelta = abi.decode(data, (int256));
        (int256 callerDelta, int256 feesAccrued) = IHookedV4PoolManager(poolManager)
            .modifyLiquidity(
                _poolKey(),
                IHookedV4PoolManager.ModifyLiquidityParams({
                    tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)
                }),
                ""
            );

        _settleOrTake(currency0, _amount0(callerDelta));
        _settleOrTake(currency1, _amount1(callerDelta));
        return abi.encode(callerDelta, feesAccrued);
    }

    // --------------------------------------------------------------------- //
    // ERC-20 share token                                                     //
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
    // Internals — position                                                   //
    // --------------------------------------------------------------------- //

    function _poolKey() private view returns (IHookedV4PoolManager.PoolKey memory) {
        return IHookedV4PoolManager.PoolKey({
            currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks
        });
    }

    function _compound() private {
        if (positionLiquidity == 0) return;

        uint256 r0 = reserve0;
        uint256 r1 = reserve1;
        uint128 liquidityAdded = 0;
        if (r0 > 1 && r1 > 1) {
            liquidityAdded = V4PoolMath.getLiquidityForAmounts(
                _currentSqrtPrice(), sqrtPriceLowerX96, sqrtPriceUpperX96, r0 - 1, r1 - 1
            );
        }

        (uint256 owed0, uint256 owed1, uint256 fees0, uint256 fees1) = _modifyPosition(int256(uint256(liquidityAdded)));
        positionLiquidity += liquidityAdded;

        if (owed0 > r0 + fees0) revert InsufficientReserve(currency0, r0 + fees0, owed0);
        if (owed1 > r1 + fees1) revert InsufficientReserve(currency1, r1 + fees1, owed1);
        reserve0 = r0 + fees0 - owed0;
        reserve1 = r1 + fees1 - owed1;

        if (liquidityAdded != 0 || fees0 != 0 || fees1 != 0) {
            emit Compounded(liquidityAdded, fees0, fees1);
        }
    }

    // forge-lint: disable-start(unsafe-typecast)
    function _modifyPosition(int256 liquidityDelta)
        private
        returns (uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1)
    {
        bytes memory result = IHookedV4PoolManager(poolManager).unlock(abi.encode(liquidityDelta));
        (int256 callerDelta, int256 feesAccrued) = abi.decode(result, (int256, int256));

        int256 fee0 = int256(_amount0(feesAccrued));
        int256 fee1 = int256(_amount1(feesAccrued));
        if (fee0 < 0 || fee1 < 0) revert UnexpectedFeeDelta();
        fees0 = uint256(fee0);
        fees1 = uint256(fee1);

        int256 p0 = int256(_amount0(callerDelta)) - fee0;
        int256 p1 = int256(_amount1(callerDelta)) - fee1;
        if (liquidityDelta >= 0) {
            if (p0 > 0 || p1 > 0) revert UnexpectedPrincipalDelta();
            principal0 = uint256(-p0);
            principal1 = uint256(-p1);
        } else {
            if (p0 < 0 || p1 < 0) revert UnexpectedPrincipalDelta();
            principal0 = uint256(p0);
            principal1 = uint256(p1);
        }
    }
    // forge-lint: disable-end(unsafe-typecast)

    // casting is safe throughout: `delta` is a signed int128 lane whose sign is checked before the
    // magnitude is taken, and the fee/principal decomposition mirrors `ZapRangeVault` exactly.
    // forge-lint: disable-start(unsafe-typecast)
    function _settleOrTake(address currency, int128 delta) private {
        if (delta < 0) {
            IHookedV4PoolManager(poolManager).sync(currency);
            currency.safeTransfer(poolManager, uint256(uint128(-delta)));
            IHookedV4PoolManager(poolManager).settle();
        } else if (delta > 0) {
            IHookedV4PoolManager(poolManager).take(currency, address(this), uint256(uint128(delta)));
        }
    }

    function _settleDepositLeg(address currency, uint256 amount, uint256 owed) private returns (uint256 used) {
        if (owed > amount) {
            uint256 dip = owed - amount;
            uint256 reserve = currency == currency0 ? reserve0 : reserve1;
            if (reserve < dip) revert InsufficientReserve(currency, reserve, dip);
            if (currency == currency0) reserve0 = reserve - dip;
            else reserve1 = reserve - dip;
            return amount;
        }
        used = owed;
        uint256 refund = amount - owed;
        if (refund != 0) _pushExact(currency, msg.sender, refund);
    }

    function _currentSqrtPrice() private view returns (uint160 sqrtPriceX96) {
        bytes32 word = IHookedV4PoolManager(poolManager).extsload(keccak256(abi.encode(poolId, POOLS_SLOT)));
        // casting to 'uint160' is safe: slot0 packs sqrtPriceX96 in the low 160 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        sqrtPriceX96 = uint160(uint256(word));
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
    }

    function _amount0(int256 delta) private pure returns (int128 amount) {
        assembly {
            amount := sar(128, delta)
        }
    }

    function _amount1(int256 delta) private pure returns (int128 amount) {
        assembly {
            amount := signextend(15, delta)
        }
    }
    // forge-lint: disable-end(unsafe-typecast)

    // --------------------------------------------------------------------- //
    // Internals — shares & tokens                                            //
    // --------------------------------------------------------------------- //

    function _toShares(uint256 liquidity, bool roundUp) private view returns (uint256) {
        uint256 numerator = liquidity * (totalSupply + VIRTUAL_SHARES);
        uint256 denominator = uint256(positionLiquidity) + VIRTUAL_LIQUIDITY;
        return roundUp ? _ceilDiv(numerator, denominator) : numerator / denominator;
    }

    function _toLiquidity(uint256 shares, bool roundUp) private view returns (uint256) {
        uint256 numerator = shares * (uint256(positionLiquidity) + VIRTUAL_LIQUIDITY);
        uint256 denominator = totalSupply + VIRTUAL_SHARES;
        return roundUp ? _ceilDiv(numerator, denominator) : numerator / denominator;
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        if (numerator == 0) return 0;
        return (numerator - 1) / denominator + 1;
    }

    function _requireReceiver(address receiver) private view {
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver(receiver);
    }

    function _pullExact(address token, uint256 amount) private {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert InexactTokenTransfer(token, amount, received);
    }

    function _pushExact(address token, address receiver, uint256 amount) private {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        token.safeTransfer(receiver, amount);
        uint256 sent = balanceBefore - IERC20(token).balanceOf(address(this));
        if (sent != amount) revert InexactTokenTransfer(token, amount, sent);
    }

    function _mint(address to, uint256 shares) private {
        totalSupply += shares;
        unchecked {
            balanceOf[to] += shares;
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

    function _spendAllowance(address owner, address spender, uint256 shares) private {
        uint256 allowed = allowance[owner][spender];
        if (allowed == type(uint256).max) return;
        if (allowed < shares) revert InsufficientAllowance(owner, spender, allowed, shares);
        unchecked {
            allowance[owner][spender] = allowed - shares;
        }
        emit Approval(owner, spender, allowed - shares);
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
