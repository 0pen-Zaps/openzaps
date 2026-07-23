// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {V4PoolMath} from "../libraries/V4PoolMath.sol";

interface IV4PoolManager {
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

    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title ZapRangeVault
/// @notice A full-range Uniswap v4 liquidity position on ONE fixed hookless pool, wrapped as an
///         ERC-20 share token. Deposit the pool's two currencies, receive shares; burn shares, get
///         the currencies back plus a pro-rata slice of every trading fee the position earned.
///         Robinhood Chain has 23k v4 pools and not a single ERC-20 LP token — the OpenZap
///         settlement model needs "one ERC-20 in, one ERC-20 out", and a v4 position is neither.
///         This contract is the missing venue: the position stays an internal detail, the SHARE is
///         the ERC-20 the rest of a zap chain can move.
///
/// @dev THIS CONTRACT IS UNAUDITED AND CUSTODIES REAL USER FUNDS — the same verdict as `ZapVault`,
///      with strictly more moving parts. It has been unit- and fork-tested, not reviewed by a third
///      party. Do not route other people's funds into it before an independent review.
///
///      WHAT IT DOES NOT DO — read this list as the specification, not as a disclaimer:
///
///      * NO ADMIN. No owner, pauser, guardian, proxy, upgrade path, `selfdestruct` or
///        `delegatecall`. Nobody can move position liquidity except by burning the shares that
///        claim it. The consequence is symmetric: there is no rescue path either.
///      * NO FEES TO ANYONE. Every trading fee the position earns is compounded back into the
///        position (or held as tracked reserves until it can be) and belongs entirely to share
///        holders. There is no fee variable and no code that could read one.
///      * NO RANGE MANAGEMENT. The position is FULL RANGE, frozen at construction. No rebalancing,
///        no active management, no oracle. Full-range LP carries impermanent loss versus holding;
///        this contract does nothing to warn about or resist it.
///      * NO HOOKED POOLS. A hook can reenter, skim or reorder liquidity operations; this vault
///        refuses to be constructed against any pool with a hook.
///      * NO NATIVE ETH. Both pool currencies must be real ERC-20s.
///      * NO DONATION ACCOUNTING. The vault tracks its own reserves in storage; raw token balances
///        are never used for pricing. Tokens transferred directly to this contract are invisible to
///        every code path and unrecoverable — which is precisely what makes a donation-inflation
///        attack pointless here.
///      * NO CHAIN GUARD, like `ZapVault` and unlike the adapters: a chain-id change must never trap
///        principal in a contract with no admin rescue.
///
///      SHARE ACCOUNTING: shares are minted pro-rata to POSITION LIQUIDITY added (the pool's `L`
///      unit), not to token amounts — `L` is the one number the pool itself keeps honest. Fee
///      compounding increases `L` without minting shares, which is how fees accrue to holders. The
///      OZ-style virtual offset (`VIRTUAL_SHARES`/`VIRTUAL_LIQUIDITY`) plus revert-on-zero guards
///      handle first-depositor rounding games; the deploy script additionally seeds and burns an
///      unredeemable first deposit.
///
///      FEE FLOW: every deposit/redeem first runs `_compound()` — a zero-delta "poke" that realises
///      accrued fees into tracked reserves, then folds whatever both-sided reserves allow back into
///      the position. One-sided residue waits in reserves and is paid out pro-rata on redeem, so
///      nothing is ever stranded. Fees realised by the CURRENT operation land in reserves for the
///      next touch — a one-touch lag, stated rather than hidden.
///
///      SETTLEMENT AUTHORITY: `V4PoolMath` only SIZES a liquidity change. What is owed or received
///      is always the pool's own `modifyLiquidity` delta, settled exactly. A sizing error therefore
///      fails closed inside the PoolManager (`CurrencyNotSettled`), never as silent mispricing.
contract ZapRangeVault {
    using SafeApprove for address;

    // --------------------------------------------------------------------- //
    // Immutable configuration                                                //
    // --------------------------------------------------------------------- //

    address public immutable poolManager;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    /// @notice Full-range bounds: the most extreme ticks usable at `tickSpacing`.
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint160 public immutable sqrtPriceLowerX96;
    uint160 public immutable sqrtPriceUpperX96;
    /// @notice The v4 pool id this vault LPs into, `keccak256(abi.encode(poolKey))`.
    bytes32 public immutable poolId;

    uint8 public constant decimals = 18;

    /// @dev `StateLibrary.POOLS_SLOT` in v4-core — verified against the live PoolManager by this
    ///      repo's fork suites and deploy preflight.
    uint256 private constant POOLS_SLOT = 6;
    /// @dev `LPFeeLibrary` bounds, as in the adapters.
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000;
    uint24 private constant MAX_STATIC_FEE = 1_000_000;

    /// @dev Virtual-offset parameters, same shape as `ZapVault`.
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

    /// @notice The liquidity this vault currently holds in the position.
    uint128 public positionLiquidity;
    /// @notice Realised fees (and settlement dust) held for holders, tracked in storage — NEVER
    ///         read from raw balances, so donations cannot touch pricing.
    uint256 public reserve0;
    uint256 public reserve1;

    /// @dev 0 = idle, 1 = entered. Doubles as the unlock-callback gate.
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
    error HookedPoolUnsupported();
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
    /// @param fee_ Static LP fee. Dynamic-fee pools are refused (they require a hook).
    /// @param tickSpacing_ Pool tick spacing; also fixes the full-range bounds.
    /// @param name_ Share-token name.
    /// @param symbol_ Share-token symbol.
    constructor(
        address poolManager_,
        address currency0_,
        address currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        string memory name_,
        string memory symbol_
    ) {
        if (poolManager_ == address(0)) revert ZeroAddress();
        if (currency0_ == address(0)) revert NativeCurrencyUnsupported();
        if (currency1_ == address(0)) revert ZeroAddress();
        if (currency0_ >= currency1_) revert InvalidCurrencyOrder();
        if (fee_ == DYNAMIC_FEE_FLAG || fee_ > MAX_STATIC_FEE) revert InvalidFee(fee_);
        if (tickSpacing_ < 1 || tickSpacing_ > 32767) revert InvalidTickSpacing(tickSpacing_);
        _requireCode(poolManager_);
        _requireCode(currency0_);
        _requireCode(currency1_);

        poolManager = poolManager_;
        currency0 = currency0_;
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        (tickLower, tickUpper) = V4PoolMath.usableTickRange(tickSpacing_);
        sqrtPriceLowerX96 = V4PoolMath.getSqrtPriceAtTick(tickLower);
        sqrtPriceUpperX96 = V4PoolMath.getSqrtPriceAtTick(tickUpper);
        // Hookless is enforced structurally: the key is built with hooks = address(0), so the pool
        // id can only ever resolve to a hookless pool.
        poolId = keccak256(abi.encode(currency0_, currency1_, fee_, tickSpacing_, address(0)));
        name = name_;
        symbol = symbol_;

        // The pool must already exist: a vault for an uninitialized pool is a deployment mistake.
        _currentSqrtPrice();
    }

    // --------------------------------------------------------------------- //
    // Deposit / redeem                                                       //
    // --------------------------------------------------------------------- //

    /// @notice Deposit up to `amount0`/`amount1`, receive shares priced in position liquidity.
    ///         Whatever the current pool ratio cannot absorb is refunded in the same call.
    /// @dev Shares are priced BEFORE the liquidity is added, against post-compound state. `used`
    ///      amounts are what the pool actually charged for the added liquidity.
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
    ///         both currencies plus a pro-rata slice of tracked reserves.
    /// @dev Spends the share-token allowance when `msg.sender != owner` — the exact ERC-20 approval
    ///      primitive an OpenZap step can grant, which is what makes a "withdraw liquidity" step
    ///      expressible at all.
    function redeem(uint256 shares, uint256 min0, uint256 min1, address receiver, address owner)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        _requireReceiver(receiver);
        _compound();

        uint256 liquidityShare = _toLiquidity(shares, false);
        uint256 supply = totalSupply; // pre-burn, includes the redeemer
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

    function poolKey() external view returns (IV4PoolManager.PoolKey memory) {
        return IV4PoolManager.PoolKey({
            currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)
        });
    }

    /// @notice The pool's current sqrt price (Q64.96), straight from PoolManager storage.
    function currentSqrtPriceX96() external view returns (uint160) {
        return _currentSqrtPrice();
    }

    /// @notice Approximate shares for a deposit at the CURRENT pool state. Ignores the compound the
    ///         real deposit would run first, so treat it as a quote, not a promise.
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

    /// @notice Approximate payout for a redeem at the CURRENT pool state: principal at the current
    ///         price plus pro-rata tracked reserves. Ignores unrealised fees, so it under-quotes.
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

    /// @notice Called back by the PoolManager inside `unlock`. Refused unless this vault initiated
    ///         the unlock in this very call (`_entered == 1`) and the caller is the PoolManager.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);
        if (_entered != 1) revert UnexpectedCallback();

        int256 liquidityDelta = abi.decode(data, (int256));
        (int256 callerDelta, int256 feesAccrued) = IV4PoolManager(poolManager)
            .modifyLiquidity(
                IV4PoolManager.PoolKey({
                    currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)
                }),
                IV4PoolManager.ModifyLiquidityParams({
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

    /// @dev Realise accrued fees (zero-delta poke) and fold both-sided reserves back into the
    ///      position. Runs before every deposit/redeem so share pricing always reflects the fees
    ///      earned so far. Reserves are folded with 1 wei of headroom per side because the pool
    ///      rounds what it is owed UP; the wei that headroom leaves behind stays in reserves.
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

    /// @dev Run one `modifyLiquidity` through the unlock dance and decompose the result into
    ///      principal owed/received and fees realised. Every sign is asserted, not assumed.
    function _modifyPosition(int256 liquidityDelta)
        private
        returns (uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1)
    {
        bytes memory result = IV4PoolManager(poolManager).unlock(abi.encode(liquidityDelta));
        (int256 callerDelta, int256 feesAccrued) = abi.decode(result, (int256, int256));

        int256 fee0 = int256(_amount0(feesAccrued));
        int256 fee1 = int256(_amount1(feesAccrued));
        if (fee0 < 0 || fee1 < 0) revert UnexpectedFeeDelta();
        fees0 = uint256(fee0);
        fees1 = uint256(fee1);

        // callerDelta = principal + fees, so principal = callerDelta - fees.
        int256 p0 = int256(_amount0(callerDelta)) - fee0;
        int256 p1 = int256(_amount1(callerDelta)) - fee1;
        if (liquidityDelta >= 0) {
            // Adding (or poking): principal can only be owed to the pool.
            if (p0 > 0 || p1 > 0) revert UnexpectedPrincipalDelta();
            principal0 = uint256(-p0);
            principal1 = uint256(-p1);
        } else {
            // Removing: principal can only be received from the pool.
            if (p0 < 0 || p1 < 0) revert UnexpectedPrincipalDelta();
            principal0 = uint256(p0);
            principal1 = uint256(p1);
        }
    }

    /// @dev Inside the callback: pay what the pool is owed (sync → transfer → settle) or collect
    ///      what it owes us (take), per currency, on the NET delta.
    function _settleOrTake(address currency, int128 delta) private {
        if (delta < 0) {
            IV4PoolManager(poolManager).sync(currency);
            currency.safeTransfer(poolManager, uint256(uint128(-delta)));
            IV4PoolManager(poolManager).settle();
        } else if (delta > 0) {
            IV4PoolManager(poolManager).take(currency, address(this), uint256(uint128(delta)));
        }
    }

    /// @dev Resolve one deposit leg after the pool has been settled: consume `owed` from the pulled
    ///      `amount`, refund the surplus, and dip into reserves for the pool's ≤1 wei round-up when
    ///      the pulled amount alone cannot cover it.
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

    /// @dev Read the pool's sqrt price from `Pool.State.slot0` via extsload; zero means the pool
    ///      was never initialized.
    function _currentSqrtPrice() private view returns (uint160 sqrtPriceX96) {
        bytes32 word = IV4PoolManager(poolManager).extsload(keccak256(abi.encode(poolId, POOLS_SLOT)));
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

    // --------------------------------------------------------------------- //
    // Internals — shares & tokens                                            //
    // --------------------------------------------------------------------- //

    /// @dev shares = liquidity * (totalSupply + VIRTUAL_SHARES) / (positionLiquidity + VIRTUAL_LIQUIDITY)
    function _toShares(uint256 liquidity, bool roundUp) private view returns (uint256) {
        uint256 numerator = liquidity * (totalSupply + VIRTUAL_SHARES);
        uint256 denominator = uint256(positionLiquidity) + VIRTUAL_LIQUIDITY;
        return roundUp ? _ceilDiv(numerator, denominator) : numerator / denominator;
    }

    /// @dev liquidity = shares * (positionLiquidity + VIRTUAL_LIQUIDITY) / (totalSupply + VIRTUAL_SHARES)
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
