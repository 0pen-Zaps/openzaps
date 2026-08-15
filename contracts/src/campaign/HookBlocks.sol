// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {V4PoolMath} from "../libraries/V4PoolMath.sol";

/// @notice The minimal surface of the tokenized fee-share vault this contract
///         holds shares of: an ERC-20 whose holders accrue a reward asset,
///         with a permissionless pull that pays the accrued reward to the
///         holder, plus the reward-asset introspection the constructor pins.
interface IFeeShareVaultV1 {
    function claimFor(address account) external;
    function claimable(address account, address rewardAsset) external view returns (uint256);
    function rewardAssetCount() external view returns (uint256);
    function rewardAssets(uint256 index) external view returns (address);
}

/// @notice The one WETH capability this contract uses beyond ERC-20: unwrap.
interface IWethUnwrap {
    function withdraw(uint256 amount) external;
}

/// @dev Uniswap v4-core pool identity. ABI-identical to v4-core's `PoolKey`
///      (`Currency` is an address wrapper).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev v4-core `SwapParams`: `amountSpecified` negative means exact input.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @notice The v4-core PoolManager surface the bond path uses. `swapDelta` is
///         v4's `BalanceDelta`: an int256 packing (amount0 int128 high,
///         amount1 int128 low), positive when the pool owes this contract.
interface IV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function take(address currency, address to, uint256 amount) external;
    function settle() external payable returns (uint256 paid);
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title HookBlocks
/// @notice The bonding half of the second 0xZAPS fee campaign. For one
///         immutable term this contract holds tokenized fee shares, converts
///         the WETH they earn into $HOOKR through one constructor-pinned
///         Uniswap-v4 pool, and locks every bought token into an append-only
///         ledger of Hook Blocks. **No function on any path can move bonded
///         HOOKR out** — not the sponsor, not a caller, nobody. "Permanently
///         bonded" is a property of the bytecode, not a promise.
///
///         Lifecycle mirrors the live fee campaign: the sponsor funds fee
///         shares once before `START_AT`; `bond()` is permissionless upkeep
///         from then on; `finalize()` after `END_AT` returns exactly the
///         deposited shares to the sponsor, which mechanically ends this
///         contract's claim on future fees; residual WETH keeps bonding until
///         dry. If bonding ever becomes impossible (the pinned pool's
///         liquidity is not locked), `sweepUnbonded()` recovers un-bonded
///         WETH and native ETH to the sponsor so value is never trapped —
///         bonded HOOKR stays where it is, forever.
///
///         Two narrow admin safeguards exist, both sponsor-only and both
///         structurally unable to touch bonded HOOKR or divert the leg's
///         WETH anywhere but its fixed destinations:
///           1. `setBondingPaused` halts FUTURE `bond()` calls (for a broken
///              or manipulated pool). It gates nothing else: funding,
///              `finalize`, and the sweep run pause-or-not, so principal and
///              recovery paths are never behind the switch.
///           2. `sweepUnbonded` opens to the SPONSOR at `END_AT` (recover a
///              stuck leg as soon as the term is over) and to EVERYONE at
///              `SWEEP_AFTER` (the sponsor-less backstop). Payout is fixed
///              to the sponsor on both paths; during the window nobody, the
///              sponsor included, can move the leg's WETH.
/// @dev The swap is a pooled, permissionless conversion floored on same-block
///      spot, which is sandwichable in principle (see FeeShareAutoCompounder
///      for the full argument). The exposure per event is bounded the same
///      way the deployed pattern bounds it: at most `MAX_BOND_WEI` converted
///      per call, at most one bond per block, output floored at spot times
///      `MIN_OUT_BPS` (plus an optional stricter caller floor), and measured
///      by balance delta only. The WETH at risk is protocol flow — staker
///      rewards and fee-share principal never touch this contract's swap.
///      No rate is promised: bonded HOOKR is whatever the fee flow and the
///      pool's real price produce, which may be zero.
contract HookBlocks {
    using SafeApprove for address;

    // ---------------------------------------------------------------- errors
    error WrongChain(uint256 actual);
    error ZeroAddress();
    error NoCode(address target);
    error InvalidSchedule();
    error InvalidBounds();
    error NativeCurrencyRequired();
    error HookedPoolRefused();
    error WrongCurrency1();
    error InvalidTickSpacing(int24 value);
    error InvalidFee(uint24 value);
    error PoolIdMismatch(bytes32 expected, bytes32 actual);
    error PoolNotInitialized();
    error WrongVaultRewardAsset();
    error OnlySponsor();
    error AlreadyFunded();
    error NotFunded();
    error FundingClosed();
    error InvalidAmount();
    error FeeShareTransferMismatch();
    error BondRateLimited();
    error BondingPaused();
    error BelowMinBond();
    error FloorTooLow();
    error FloorNotMet(uint256 floor, uint256 actual);
    error AmountTooLarge();
    error BadSwapDelta();
    error TermNotEnded();
    error AlreadyFinalized();
    error SweepNotOpen();
    error NothingToSweep();
    error NativeNotAccepted();
    error OnlyPoolManager();
    error UnexpectedUnlock();
    error NativeSendFailed();
    error Reentrancy();

    // ---------------------------------------------------------------- events
    event FeeSharesFunded(address indexed sponsor, uint256 amount);
    event Bonded(
        address indexed caller, uint256 indexed blockIndex, uint256 ethIn, uint256 hookrBonded, uint256 floor
    );
    event BondingPauseSet(bool paused);
    event Finalized(uint256 feeSharesReturned);
    event UnbondedSwept(address indexed caller, uint256 wethAmount, uint256 nativeAmount);

    // ------------------------------------------------------------ immutables
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    /// @dev v4-core `StateLibrary.POOLS_SLOT`; slot0 of a pool lives at
    ///      `keccak256(abi.encode(poolId, POOLS_SLOT))`.
    uint256 private constant POOLS_SLOT = 6;
    /// @dev `TickMath.MIN_SQRT_PRICE + 1`: the loosest legal zeroForOne limit.
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    /// @dev `LPFeeLibrary.MAX_LP_FEE` — 100% in hundredths of a bip.
    uint24 private constant MAX_STATIC_FEE = 1_000_000;
    int24 private constant MAX_TICK_SPACING = 32767;
    uint256 private constant BPS = 10_000;

    /// @notice The fee-share token, which is also the vault that pays WETH.
    address public immutable FEE_SHARES;
    /// @notice The reward asset the vault pays (aeWETH on Robinhood Chain).
    address public immutable WETH;
    /// @notice The token every bond buys and locks.
    address public immutable HOOKR;
    /// @notice The v4-core PoolManager that owns the pinned pool.
    IV4PoolManager public immutable POOL_MANAGER;
    /// @notice Pinned pool key: native ETH / HOOKR, hookless, static fee.
    uint24 public immutable POOL_FEE;
    int24 public immutable POOL_TICK_SPACING;
    /// @notice `keccak256(abi.encode(poolKey))`, proven at construction.
    bytes32 public immutable POOL_ID;
    /// @notice Only address allowed to fund, and fixed recipient of returned
    ///         shares and swept residue. Never able to touch bonded HOOKR.
    address public immutable SPONSOR;
    /// @notice Funding closes here; the campaign window this bonder mirrors.
    uint64 public immutable START_AT;
    /// @notice After this, `finalize()` may return the shares to the sponsor.
    uint64 public immutable END_AT;
    /// @notice After this, un-bonded WETH/ETH may be swept to the sponsor.
    uint64 public immutable SWEEP_AFTER;
    /// @notice A bond must clear spot price times this, in basis points.
    uint16 public immutable MIN_OUT_BPS;
    /// @notice At most this much ETH is converted by a single bond call.
    uint256 public immutable MAX_BOND_WEI;
    /// @notice Bonds below this much ETH revert rather than waste the swap.
    uint256 public immutable MIN_BOND_WEI;

    // ----------------------------------------------------------------- state
    /// @notice One permanent ledger entry per successful bond.
    struct HookBlock {
        uint128 ethIn;
        uint128 hookrBonded;
        uint64 bondedAt;
    }

    HookBlock[] private _blocks;
    /// @notice Total native ETH ever converted into bonded HOOKR.
    uint256 public totalEthBonded;
    /// @notice Total HOOKR ever bonded. Never decreases.
    uint256 public totalHookrBonded;

    bool public feeSharesFunded;
    bool public finalized;
    /// @notice Sponsor-set circuit breaker for FUTURE bond() calls only.
    ///         Funding, finalize, and the sweep are never behind it.
    bool public bondingPaused;
    uint256 public feeSharePrincipal;
    /// @notice Last block a bond fired; at most one bond per block.
    uint256 public lastBondBlock;

    uint256 private _entered;
    /// @dev Consumed-once sentinel tying each unlock callback to the bond
    ///      that opened it; nonzero only between `unlock` and the callback.
    uint256 private _pendingBondEth;

    modifier nonReentrant() {
        require(_entered == 0, Reentrancy());
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(
        address feeShares,
        address weth,
        address hookr,
        address poolManager,
        uint24 poolFee,
        int24 poolTickSpacing,
        bytes32 expectedPoolId,
        address sponsor,
        uint64 startAt,
        uint64 endAt,
        uint64 sweepAfter,
        uint16 minOutBps,
        uint256 maxBondWei,
        uint256 minBondWei
    ) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (
            feeShares == address(0) || weth == address(0) || hookr == address(0) || poolManager == address(0)
                || sponsor == address(0)
        ) revert ZeroAddress();
        _requireCode(feeShares);
        _requireCode(weth);
        _requireCode(hookr);
        _requireCode(poolManager);
        if (weth == hookr || feeShares == hookr) revert WrongCurrency1();
        if (startAt <= block.timestamp || endAt <= startAt || sweepAfter <= endAt) revert InvalidSchedule();
        if (minOutBps == 0 || minOutBps > BPS) revert InvalidBounds();
        if (maxBondWei == 0 || minBondWei == 0 || minBondWei > maxBondWei || maxBondWei > type(uint128).max) {
            revert InvalidBounds();
        }
        if (poolTickSpacing < 1 || poolTickSpacing > MAX_TICK_SPACING) revert InvalidTickSpacing(poolTickSpacing);
        if (poolFee > MAX_STATIC_FEE) revert InvalidFee(poolFee);

        // The pinned pool must quote HOOKR in native ETH with no hook: the
        // bond path unwraps WETH and settles native, and refuses to hand
        // execution to third-party hook code. The live HOOKR market is
        // exactly this shape; a different pool is a different contract.
        bytes32 poolId = keccak256(abi.encode(address(0), hookr, poolFee, poolTickSpacing, address(0)));
        if (poolId != expectedPoolId) revert PoolIdMismatch(expectedPoolId, poolId);

        // Reward-asset introspection, campaign-style: the vault must pay
        // exactly one reward asset and it must be the WETH we unwrap.
        IFeeShareVaultV1 vault = IFeeShareVaultV1(feeShares);
        if (vault.rewardAssetCount() != 1 || vault.rewardAssets(0) != weth) revert WrongVaultRewardAsset();

        FEE_SHARES = feeShares;
        WETH = weth;
        HOOKR = hookr;
        POOL_MANAGER = IV4PoolManager(poolManager);
        POOL_FEE = poolFee;
        POOL_TICK_SPACING = poolTickSpacing;
        POOL_ID = poolId;
        SPONSOR = sponsor;
        START_AT = startAt;
        END_AT = endAt;
        SWEEP_AFTER = sweepAfter;
        MIN_OUT_BPS = minOutBps;
        MAX_BOND_WEI = maxBondWei;
        MIN_BOND_WEI = minBondWei;

        // Fail closed at the door: an uninitialized pool means a mistyped
        // key, and every later bond would revert anyway.
        if (_sqrtPriceX96() == 0) revert PoolNotInitialized();
    }

    // ---------------------------------------------------------------- funding

    /// @notice One-time, exact-transfer deposit of fee-share tokens by the
    ///         sponsor, strictly before the term starts. Mirrors the live
    ///         campaign's funding semantics.
    function fundFeeShares(uint256 amount) external nonReentrant {
        require(msg.sender == SPONSOR, OnlySponsor());
        require(!feeSharesFunded, AlreadyFunded());
        require(block.timestamp < START_AT, FundingClosed());
        require(amount != 0, InvalidAmount());

        uint256 beforeBalance = IERC20(FEE_SHARES).balanceOf(address(this));
        FEE_SHARES.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(FEE_SHARES).balanceOf(address(this)) - beforeBalance;
        // The contract must be able to return exactly the deposited rights.
        require(received == amount, FeeShareTransferMismatch());

        feeSharePrincipal = received;
        feeSharesFunded = true;
        emit FeeSharesFunded(msg.sender, received);
    }

    // ---------------------------------------------------------------- bonding

    /// @notice Permissionless crank: pull the vault WETH this contract's
    ///         shares have earned, unwrap up to `MAX_BOND_WEI`, market-buy
    ///         HOOKR through the pinned pool, and bond the entire measured
    ///         output forever. Callable from funding until the contract runs
    ///         dry — including after `finalize()`, so residual reward is
    ///         drained into blocks rather than stranded.
    /// @param minHookrOut Optional caller floor. The enforced floor is the
    ///        stricter of this and spot times `MIN_OUT_BPS`; passing zero
    ///        keeps the spot floor alone.
    function bond(uint256 minHookrOut) external nonReentrant returns (uint256 hookrBonded) {
        require(feeSharesFunded, NotFunded());
        require(!bondingPaused, BondingPaused());
        require(lastBondBlock != block.number, BondRateLimited());
        lastBondBlock = block.number;

        // Pull accrued reward defensively: an unavailable vault degrades to
        // bonding only what is already held, never to a brick.
        try IFeeShareVaultV1(FEE_SHARES).claimable(address(this), WETH) returns (uint256 c) {
            if (c != 0) {
                try IFeeShareVaultV1(FEE_SHARES).claimFor(address(this)) {} catch {}
            }
        } catch {}

        // Convert at most MAX_BOND_WEI per call, counting native already on
        // hand (a prior partial fill's remainder, or force-sent dust) toward
        // the cap so the sandwich bound holds regardless of donations.
        uint256 nativeHeld = address(this).balance;
        uint256 room = nativeHeld >= MAX_BOND_WEI ? 0 : MAX_BOND_WEI - nativeHeld;
        uint256 wethHeld = IERC20(WETH).balanceOf(address(this));
        uint256 draw = wethHeld > room ? room : wethHeld;
        if (draw != 0) IWethUnwrap(WETH).withdraw(draw);

        uint256 ethIn = address(this).balance;
        if (ethIn > MAX_BOND_WEI) ethIn = MAX_BOND_WEI;
        require(ethIn >= MIN_BOND_WEI, BelowMinBond());

        // Same-block spot floor, read from the pinned pool itself. Zero is
        // refused: a floor that rounds to nothing floors nothing.
        uint256 sqrtPrice = _sqrtPriceX96();
        if (sqrtPrice == 0) revert PoolNotInitialized();
        uint256 priceX96 = V4PoolMath.mulDiv(sqrtPrice, sqrtPrice, V4PoolMath.Q96);
        uint256 floor = (V4PoolMath.mulDiv(ethIn, priceX96, V4PoolMath.Q96) * MIN_OUT_BPS) / BPS;
        if (minHookrOut > floor) floor = minHookrOut;
        require(floor != 0, FloorTooLow());

        uint256 nativeBefore = address(this).balance;
        uint256 hookrBefore = IERC20(HOOKR).balanceOf(address(this));

        _pendingBondEth = ethIn;
        POOL_MANAGER.unlock(abi.encode(ethIn));

        // Measured balance deltas are the only numbers this contract records.
        uint256 ethSpent = nativeBefore - address(this).balance;
        hookrBonded = IERC20(HOOKR).balanceOf(address(this)) - hookrBefore;
        require(hookrBonded >= floor, FloorNotMet(floor, hookrBonded));
        if (ethSpent > type(uint128).max || hookrBonded > type(uint128).max) revert AmountTooLarge();

        uint256 blockIndex = _blocks.length;
        _blocks.push(
            HookBlock({
                // casting is safe: both values were bounded to uint128 above.
                // forge-lint: disable-next-line(unsafe-typecast)
                ethIn: uint128(ethSpent),
                // forge-lint: disable-next-line(unsafe-typecast)
                hookrBonded: uint128(hookrBonded),
                // casting to 'uint64' is safe until the year 584,942,417,355.
                // forge-lint: disable-next-line(unsafe-typecast)
                bondedAt: uint64(block.timestamp)
            })
        );
        totalEthBonded += ethSpent;
        totalHookrBonded += hookrBonded;
        emit Bonded(msg.sender, blockIndex, ethSpent, hookrBonded, floor);
    }

    /// @notice PoolManager unlock callback: swap the exact native input for
    ///         HOOKR, take the output, settle the debt. Callable only by the
    ///         pinned PoolManager, and only while a bond is mid-flight.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(POOL_MANAGER), OnlyPoolManager());
        uint256 ethIn = abi.decode(data, (uint256));
        // Consume the sentinel: a callback with no opening bond, a second
        // callback for one bond, or a tampered amount all revert here.
        require(ethIn != 0 && _pendingBondEth == ethIn, UnexpectedUnlock());
        _pendingBondEth = 0;

        int256 delta = POOL_MANAGER.swap(
            PoolKey({
                currency0: address(0),
                currency1: HOOKR,
                fee: POOL_FEE,
                tickSpacing: POOL_TICK_SPACING,
                hooks: address(0)
            }),
            SwapParams({
                zeroForOne: true,
                // Negative means exact input in v4-core.
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: MIN_SQRT_PRICE_PLUS_ONE
            }),
            ""
        );

        int256 amount0 = delta >> 128;
        int256 amount1 = int256(int128(uint128(uint256(delta))));
        // Exact-in native->HOOKR must owe the pool ETH and be owed HOOKR.
        if (amount0 >= 0 || amount1 <= 0) revert BadSwapDelta();
        uint256 owed = uint256(-amount0);
        if (owed > ethIn) revert BadSwapDelta();

        POOL_MANAGER.take(HOOKR, address(this), uint256(amount1));
        POOL_MANAGER.settle{value: owed}();
        return abi.encode(uint256(amount1), owed);
    }

    /// @notice Sponsor circuit breaker for the conversion leg: pausing stops
    ///         FUTURE `bond()` calls while a pool is broken or being ground
    ///         against the floor, and nothing else. It cannot move an asset,
    ///         cannot touch bonded HOOKR, and cannot reach principal or
    ///         recovery paths: funding, `finalize`, and `sweepUnbonded` all
    ///         run pause-or-not, and the sweep's payout stays fixed to the
    ///         sponsor either way.
    function setBondingPaused(bool paused) external {
        require(msg.sender == SPONSOR, OnlySponsor());
        bondingPaused = paused;
        emit BondingPauseSet(paused);
    }

    // ------------------------------------------------------------ settlement

    /// @notice Returns exactly the deposited fee shares to the sponsor after
    ///         the term ends, which stops all future fee flow to this
    ///         contract. Reward already earned stays bondable afterward.
    ///         Permissionless, like every post-window step of the campaign.
    function finalize() external nonReentrant {
        require(feeSharesFunded, NotFunded());
        require(block.timestamp > END_AT, TermNotEnded());
        require(!finalized, AlreadyFinalized());

        // One final defensive pull so the term's tail is captured while the
        // shares are still here. Upstream failure cannot block the return.
        try IFeeShareVaultV1(FEE_SHARES).claimFor(address(this)) {} catch {}

        finalized = true;
        uint256 shares = feeSharePrincipal;
        feeSharePrincipal = 0;
        uint256 beforeBalance = IERC20(FEE_SHARES).balanceOf(address(this));
        FEE_SHARES.safeTransfer(SPONSOR, shares);
        uint256 debited = beforeBalance - IERC20(FEE_SHARES).balanceOf(address(this));
        require(debited == shares, FeeShareTransferMismatch());
        emit Finalized(shares);
    }

    /// @notice Recovers un-bonded WETH and native ETH to the sponsor — the
    ///         value-never-trapped escape hatch for a pool whose liquidity
    ///         walked away. The SPONSOR may sweep as soon as the term ends
    ///         (`END_AT`); everyone else from `SWEEP_AFTER`, the backstop
    ///         that needs no sponsor at all. Payout is fixed to the sponsor
    ///         on both paths, the window itself is untouchable (no sweep
    ///         before `END_AT` for anyone), and no path reaches HOOKR.
    function sweepUnbonded() external nonReentrant {
        uint256 opensAt = msg.sender == SPONSOR ? END_AT : SWEEP_AFTER;
        require(block.timestamp > opensAt, SweepNotOpen());
        uint256 wethAmount = IERC20(WETH).balanceOf(address(this));
        uint256 nativeAmount = address(this).balance;
        require(wethAmount != 0 || nativeAmount != 0, NothingToSweep());

        if (wethAmount != 0) WETH.safeTransfer(SPONSOR, wethAmount);
        if (nativeAmount != 0) {
            (bool ok,) = SPONSOR.call{value: nativeAmount}("");
            require(ok, NativeSendFailed());
        }
        emit UnbondedSwept(msg.sender, wethAmount, nativeAmount);
    }

    // ----------------------------------------------------------------- views

    /// @notice Number of Hook Blocks bonded so far.
    function blockCount() external view returns (uint256) {
        return _blocks.length;
    }

    /// @notice One immutable ledger entry.
    function hookBlock(uint256 index) external view returns (HookBlock memory) {
        return _blocks[index];
    }

    /// @notice WETH a bond crank could work with right now: vault-claimable
    ///         plus already-held. Zero when the vault view reverts — a keeper
    ///         signal, never a settlement input.
    function bondableWeth() external view returns (uint256) {
        uint256 pending;
        try IFeeShareVaultV1(FEE_SHARES).claimable(address(this), WETH) returns (uint256 c) {
            pending = c;
        } catch {}
        return pending + IERC20(WETH).balanceOf(address(this)) + address(this).balance;
    }

    /// @notice The pinned pool key, reconstructable for offchain proof.
    function poolKey() external view returns (PoolKey memory) {
        return PoolKey({
            currency0: address(0),
            currency1: HOOKR,
            fee: POOL_FEE,
            tickSpacing: POOL_TICK_SPACING,
            hooks: address(0)
        });
    }

    /// @notice Native ETH is accepted only from the WETH contract's unwrap.
    ///         Anything else must not be able to masquerade as bond flow.
    receive() external payable {
        if (msg.sender != WETH) revert NativeNotAccepted();
    }

    // ------------------------------------------------------------- internals

    function _sqrtPriceX96() private view returns (uint160) {
        bytes32 word = POOL_MANAGER.extsload(keccak256(abi.encode(POOL_ID, POOLS_SLOT)));
        // casting to 'uint160' is safe: slot0 packs sqrtPriceX96 in the low
        // 160 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(uint256(word));
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
