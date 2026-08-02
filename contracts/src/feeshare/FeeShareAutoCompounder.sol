// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {IOrientedPriceSource} from "../v3_1/interfaces/IOrientedPriceSource.sol";
import {IFeeShareVault} from "./FeeShareTermWrap.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @title FeeShareAutoCompounder
/// @notice Deposit tokenized fee shares, keep them withdrawable at any time,
///         and turn the vault's WETH reward into 0xZAPS. Reward accrues to
///         each depositor as WETH, per share, exactly as the fee campaign
///         accrues — synced before every change to the share set so no
///         depositor is ever diluted, no latecomer captures an earlier
///         depositor's yield, and no WETH is stranded when the pool empties.
///         A depositor takes their WETH directly (`claimWeth`, an escape
///         hatch so value can never be trapped) or routes it into 0xZAPS
///         through the constructor-pinned adapter (`route`), floored against
///         the pinned oriented price source. A keeper may route on a
///         depositor's behalf (`routeFor`) ONLY if that depositor opted in via
///         `setAutoRoute` — the routed WETH and the 0xZAPS both belong to that
///         depositor, never the caller.
/// @dev Routing is PER DEPOSITOR, not a pooled swap. That is deliberate: a
///      pooled permissionless swap floored on same-block spot is sandwichable
///      against unconsenting depositors (move the pool, clear the depressed
///      floor, reverse). Per-depositor routing bounds any sandwich to one
///      depositor's WETH and `MAX_ROUTE_WEI` per call, and a route only ever
///      fires for the depositor themselves or a keeper they explicitly
///      authorized — never against a depositor who has not opted in, whose
///      WETH stays recoverable through the non-front-runnable `claimWeth`.
///      The floor is still same-block spot and is NOT proof against a sandwich
///      of a route the depositor DID authorize; a stronger (TWAP) floor is a
///      follow-up before any external audit. No rate is promised: routed
///      0xZAPS is whatever the vault's fee flow and the pool's spot produce,
///      which may be zero.
contract FeeShareAutoCompounder {
    using SafeApprove for address;

    // ---------------------------------------------------------------- errors
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance();
    error NothingToRoute();
    error BelowMinRoute();
    error FloorNotMet();
    error WrongOrientation();
    error TransferFailed();
    error NotAuthorized();

    // ---------------------------------------------------------------- events
    event Deposited(address indexed account, uint256 shares);
    event Withdrawn(address indexed account, uint256 shares);
    event WethClaimed(address indexed account, uint256 amount);
    event AutoRouteSet(address indexed account, bool allowed);
    event Routed(address indexed caller, address indexed account, uint256 wethIn, uint256 zapsOut, uint256 floor);

    // ------------------------------------------------------------ immutables
    address public immutable FEE_SHARES;
    address public immutable WETH;
    address public immutable ZAPS;
    IAdapter public immutable ADAPTER;
    IOrientedPriceSource public immutable PRICE_SOURCE;
    /// @notice Routed WETH must yield at least spot * MIN_OUT_BPS / 10_000.
    uint16 public immutable MIN_OUT_BPS;
    /// @notice A single route converts at most this much WETH, bounding the
    ///         amount a same-block sandwich of the routed leg can extract.
    uint256 public immutable MAX_ROUTE_WEI;
    /// @notice Routes below this much WETH revert rather than waste the swap.
    uint256 public immutable MIN_ROUTE_WEI;

    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 2 ** 96;
    uint256 private constant ACC_SCALE = 1e18;

    /// @dev Frozen adapter argument blob; (adapter, constant selector, data)
    ///      fully pins the protocol action.
    bytes public adapterData;

    // ----------------------------------------------------------- accounting
    mapping(address => uint256) public deposits;
    uint256 public totalDeposits;
    /// @notice WETH owed per share, 1e18 scale, advanced by _sync().
    uint256 public cumulativeWethPerShare;
    /// @notice WETH accounted to depositors but not yet claimed or routed.
    uint256 public wethReserve;
    mapping(address => uint256) private wethDebt;
    /// @notice Realized WETH each depositor may claim or route.
    mapping(address => uint256) public wethOwed;
    /// @notice Depositors who authorize keepers to route their balance.
    mapping(address => bool) public autoRouteAllowed;

    constructor(
        address feeShares,
        address weth,
        address zaps,
        IAdapter adapter,
        IOrientedPriceSource priceSource,
        uint16 minOutBps,
        uint256 maxRouteWei,
        uint256 minRouteWei,
        bytes memory adapterData_
    ) {
        require(
            feeShares != address(0) && weth != address(0) && zaps != address(0) && address(adapter) != address(0)
                && address(priceSource) != address(0),
            ZeroAddress()
        );
        require(minOutBps != 0 && minOutBps <= BPS, ZeroAmount());
        require(maxRouteWei != 0 && minRouteWei != 0 && minRouteWei <= maxRouteWei, ZeroAmount());
        // priceX96 is currency1 per one currency0; the floor multiplies WETH
        // in, so the source must be oriented WETH -> ZAPS.
        require(priceSource.currency0() == weth && priceSource.currency1() == zaps, WrongOrientation());
        FEE_SHARES = feeShares;
        WETH = weth;
        ZAPS = zaps;
        ADAPTER = adapter;
        PRICE_SOURCE = priceSource;
        MIN_OUT_BPS = minOutBps;
        MAX_ROUTE_WEI = maxRouteWei;
        MIN_ROUTE_WEI = minRouteWei;
        adapterData = adapterData_;
    }

    // ------------------------------------------------------------- deposits

    function deposit(uint256 shares) external {
        require(shares != 0, ZeroAmount());
        _sync();
        _checkpoint(msg.sender);
        deposits[msg.sender] += shares;
        totalDeposits += shares;
        wethDebt[msg.sender] = (deposits[msg.sender] * cumulativeWethPerShare) / ACC_SCALE;
        require(IERC20(FEE_SHARES).transferFrom(msg.sender, address(this), shares), TransferFailed());
        emit Deposited(msg.sender, shares);
    }

    /// @notice Withdraw fee shares at any time. Reward owed up to now is
    ///         realized to the caller first, so leaving never forfeits it and
    ///         never strands it against the departing shares.
    function withdraw(uint256 shares) external {
        require(shares != 0, ZeroAmount());
        require(deposits[msg.sender] >= shares, InsufficientBalance());
        _sync();
        _checkpoint(msg.sender);
        deposits[msg.sender] -= shares;
        totalDeposits -= shares;
        wethDebt[msg.sender] = (deposits[msg.sender] * cumulativeWethPerShare) / ACC_SCALE;
        require(IERC20(FEE_SHARES).transfer(msg.sender, shares), TransferFailed());
        emit Withdrawn(msg.sender, shares);
    }

    // ------------------------------------------------------ claim and route

    /// @notice Take the caller's realized WETH directly. The escape hatch:
    ///         reward is always recoverable even if routing is impossible.
    function claimWeth() external {
        _sync();
        _checkpoint(msg.sender);
        uint256 amount = wethOwed[msg.sender];
        if (amount == 0) return;
        wethOwed[msg.sender] = 0;
        wethReserve -= amount;
        require(IERC20(WETH).transfer(msg.sender, amount), TransferFailed());
        emit WethClaimed(msg.sender, amount);
    }

    /// @notice Route the caller's own realized WETH into 0xZAPS.
    function route() external {
        _route(msg.sender);
    }

    /// @notice Opt in (or out of) keeper routing of the caller's own balance.
    ///         Off by default: without this, only the depositor can move their
    ///         WETH, and it is always recoverable as WETH via claimWeth.
    function setAutoRoute(bool allowed) external {
        autoRouteAllowed[msg.sender] = allowed;
        emit AutoRouteSet(msg.sender, allowed);
    }

    /// @notice Route `account`'s realized WETH into 0xZAPS for them. Keeper
    ///         convenience; the WETH spent and the 0xZAPS produced both belong
    ///         to `account`. Requires `account` to have opted in — otherwise a
    ///         keeper could force-convert a depositor's WETH (and front-run
    ///         their claimWeth) at a sandwichable same-block-spot floor, which
    ///         the depositor never consented to.
    function routeFor(address account) external {
        require(autoRouteAllowed[account], NotAuthorized());
        _route(account);
    }

    function _route(address account) private {
        _sync();
        _checkpoint(account);
        uint256 owed = wethOwed[account];
        uint256 amount = owed > MAX_ROUTE_WEI ? MAX_ROUTE_WEI : owed;
        require(amount != 0, NothingToRoute());
        require(amount >= MIN_ROUTE_WEI, BelowMinRoute());

        // Same-block spot floor. Not sandwich-proof for the routed leg; the
        // per-call cap bounds a single sandwich, and only the account itself
        // (route) or a keeper it opted in (routeFor) can trigger a route.
        uint256 priceX96 = PRICE_SOURCE.priceX96();
        uint256 floor = (amount * priceX96 / Q96) * MIN_OUT_BPS / BPS;

        wethOwed[account] = owed - amount;
        wethReserve -= amount;

        uint256 zapsBefore = IERC20(ZAPS).balanceOf(address(this));
        WETH.approveExact(address(ADAPTER), amount);
        ADAPTER.execute(WETH, amount, adapterData);
        // Balance delta is the only trusted measure of output.
        uint256 zapsOut = IERC20(ZAPS).balanceOf(address(this)) - zapsBefore;
        require(zapsOut >= floor && zapsOut != 0, FloorNotMet());

        require(IERC20(ZAPS).transfer(account, zapsOut), TransferFailed());
        emit Routed(msg.sender, account, amount, zapsOut, floor);
    }

    // ----------------------------------------------------------------- views

    function claimableWeth(address account) external view returns (uint256) {
        uint256 pending = (deposits[account] * cumulativeWethPerShare) / ACC_SCALE - wethDebt[account];
        return wethOwed[account] + pending;
    }

    // ------------------------------------------------------------- internals

    /// @dev Pull the vault's owed WETH (defensively) and fold whatever the
    ///      contract received into the per-share accumulator. Runs before
    ///      every share-set change and every claim/route, so realized reward
    ///      is always attributed to the shares present when it was earned.
    function _sync() private {
        // Guard BOTH the view and the claim: an untrusted vault whose
        // claimable() reverts must never brick withdraw or the claimWeth
        // escape hatch. A reverting vault degrades to no-new-reward.
        try IFeeShareVault(FEE_SHARES).claimable(address(this), WETH) returns (uint256 c) {
            if (c != 0) {
                try IFeeShareVault(FEE_SHARES).claimFor(address(this)) {} catch {}
            }
        } catch {}
        uint256 balance = IERC20(WETH).balanceOf(address(this));
        uint256 received = balance - wethReserve;
        if (received != 0 && totalDeposits != 0) {
            cumulativeWethPerShare += (received * ACC_SCALE) / totalDeposits;
            wethReserve = balance;
        }
    }

    function _checkpoint(address account) private {
        uint256 pending = (deposits[account] * cumulativeWethPerShare) / ACC_SCALE - wethDebt[account];
        if (pending != 0) wethOwed[account] += pending;
        wethDebt[account] = (deposits[account] * cumulativeWethPerShare) / ACC_SCALE;
    }
}
