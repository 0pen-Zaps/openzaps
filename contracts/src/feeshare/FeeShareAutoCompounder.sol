// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {IOrientedPriceSource} from "../v3_1/interfaces/IOrientedPriceSource.sol";
import {IFeeShareVault} from "./FeeShareTermWrap.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @title FeeShareAutoCompounder
/// @notice Deposit tokenized fee shares, keep them withdrawable at any time,
///         and let permissionless upkeep convert the vault's WETH into 0xZAPS
///         for the depositors. Exactly one route exists and it is welded at
///         construction: vault reward -> pinned adapter -> 0xZAPS, floored
///         against the pinned oriented price source. There is no path
///         parameter, no action array, and no operator.
/// @dev This is the pool.fans "automation" narrowed to OpenZaps invariants:
///      the any-token/any-path router is rejected by design. The floor is a
///      single immutable basis-point band for the whole pool rather than
///      per-depositor: a per-depositor floor on a pooled swap would hand any
///      depositor a veto over everyone's run (set an unclearable floor and
///      no harvest ever settles). Depositors accept an instance's floor by
///      depositing into it; different floors are different deployments.
///      No rate is promised: routed 0xZAPS is whatever the vault's fee flow
///      and the pool's spot produce, which may be zero.
contract FeeShareAutoCompounder {
    using SafeApprove for address;

    // ---------------------------------------------------------------- errors
    error ZeroAmount();
    error ZeroAddress();
    error NoDeposits();
    error NothingToRoute();
    error BelowMinHarvest();
    error FloorNotMet();
    error WrongOrientation();
    error TransferFailed();
    error InsufficientBalance();

    // ---------------------------------------------------------------- events
    event Deposited(address indexed account, uint256 shares);
    event Withdrawn(address indexed account, uint256 shares);
    event HarvestedAndRouted(address indexed caller, uint256 wethIn, uint256 zapsOut, uint256 floor);
    event ZapsClaimed(address indexed account, uint256 amount);

    // ------------------------------------------------------------ immutables
    /// @notice The fee-share token, which is also the vault paying WETH.
    address public immutable FEE_SHARES;
    /// @notice The vault's reward asset and the swap input.
    address public immutable WETH;
    /// @notice The routed output token.
    address public immutable ZAPS;
    /// @notice The one allowlisted adapter this compounder may call.
    IAdapter public immutable ADAPTER;
    /// @notice Spot source the floor derives from; orientation checked once
    ///         at construction and trusted per its lifetime-immutability
    ///         contract.
    IOrientedPriceSource public immutable PRICE_SOURCE;
    /// @notice Floor band: routed output must be at least spot * bps / 10_000.
    uint16 public immutable MIN_OUT_BPS;
    /// @notice Runs below this much WETH revert instead of wasting the floor
    ///         on dust.
    uint256 public immutable MIN_HARVEST_WEI;

    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 2 ** 96;
    uint256 private constant ACC_SCALE = 1e18;

    /// @dev The frozen adapter argument blob, set once at construction. The
    ///      adapter's selector is constant, so (adapter, data) fully pins the
    ///      protocol action.
    bytes public adapterData;

    // ----------------------------------------------------------- accounting
    mapping(address => uint256) public deposits;
    uint256 public totalDeposits;
    uint256 public cumulativeZapsPerShare;
    uint256 public zapsReserve;
    mapping(address => uint256) private zapsDebt;
    mapping(address => uint256) private accruedZaps;

    constructor(
        address feeShares,
        address weth,
        address zaps,
        IAdapter adapter,
        IOrientedPriceSource priceSource,
        uint16 minOutBps,
        uint256 minHarvestWei,
        bytes memory adapterData_
    ) {
        require(
            feeShares != address(0) && weth != address(0) && zaps != address(0) && address(adapter) != address(0)
                && address(priceSource) != address(0),
            ZeroAddress()
        );
        require(minOutBps != 0 && minOutBps <= BPS, ZeroAmount());
        // priceX96 is currency1 per one currency0. The floor below multiplies
        // WETH input by priceX96, so the source must be oriented WETH -> ZAPS.
        require(priceSource.currency0() == weth && priceSource.currency1() == zaps, WrongOrientation());
        FEE_SHARES = feeShares;
        WETH = weth;
        ZAPS = zaps;
        ADAPTER = adapter;
        PRICE_SOURCE = priceSource;
        MIN_OUT_BPS = minOutBps;
        MIN_HARVEST_WEI = minHarvestWei;
        adapterData = adapterData_;
    }

    // ------------------------------------------------------------- deposits

    function deposit(uint256 shares) external {
        require(shares != 0, ZeroAmount());
        _checkpoint(msg.sender);
        deposits[msg.sender] += shares;
        totalDeposits += shares;
        zapsDebt[msg.sender] = (deposits[msg.sender] * cumulativeZapsPerShare) / ACC_SCALE;
        require(IERC20(FEE_SHARES).transferFrom(msg.sender, address(this), shares), TransferFailed());
        emit Deposited(msg.sender, shares);
    }

    /// @notice Withdraw fee shares at any time. Accrued 0xZAPS stays claimable.
    function withdraw(uint256 shares) external {
        require(shares != 0, ZeroAmount());
        require(deposits[msg.sender] >= shares, InsufficientBalance());
        _checkpoint(msg.sender);
        deposits[msg.sender] -= shares;
        totalDeposits -= shares;
        zapsDebt[msg.sender] = (deposits[msg.sender] * cumulativeZapsPerShare) / ACC_SCALE;
        require(IERC20(FEE_SHARES).transfer(msg.sender, shares), TransferFailed());
        emit Withdrawn(msg.sender, shares);
    }

    // -------------------------------------------------------------- routing

    /// @notice Pull the vault's WETH and route it through the welded adapter
    ///         into 0xZAPS for depositors. Permissionless: anyone pays gas,
    ///         nobody chooses the route, and a run that cannot clear the
    ///         spot-derived floor reverts for everyone rather than degrading
    ///         anyone.
    function harvestAndRoute() external {
        require(totalDeposits != 0, NoDeposits());
        if (IFeeShareVault(FEE_SHARES).claimable(address(this), WETH) != 0) {
            IFeeShareVault(FEE_SHARES).claimFor(address(this));
        }
        uint256 wethIn = IERC20(WETH).balanceOf(address(this));
        require(wethIn != 0, NothingToRoute());
        require(wethIn >= MIN_HARVEST_WEI, BelowMinHarvest());

        // Spot floor. priceX96 is ZAPS per WETH in Q96; with wethIn <= ~1e21
        // and priceX96 <= ~1e40 the product stays far below 2^256.
        uint256 priceX96 = PRICE_SOURCE.priceX96();
        uint256 floor = (wethIn * priceX96 / Q96) * MIN_OUT_BPS / BPS;

        uint256 zapsBefore = IERC20(ZAPS).balanceOf(address(this));
        WETH.approveExact(address(ADAPTER), wethIn);
        ADAPTER.execute(WETH, wethIn, adapterData);
        // Balance delta is the only trusted measure of output.
        uint256 zapsOut = IERC20(ZAPS).balanceOf(address(this)) - zapsBefore;
        require(zapsOut >= floor && zapsOut != 0, FloorNotMet());

        cumulativeZapsPerShare += (zapsOut * ACC_SCALE) / totalDeposits;
        zapsReserve += zapsOut;
        emit HarvestedAndRouted(msg.sender, wethIn, zapsOut, floor);
    }

    // --------------------------------------------------------------- claims

    function claimZaps() external {
        _checkpoint(msg.sender);
        uint256 amount = accruedZaps[msg.sender];
        if (amount == 0) return;
        accruedZaps[msg.sender] = 0;
        zapsReserve -= amount;
        require(IERC20(ZAPS).transfer(msg.sender, amount), TransferFailed());
        emit ZapsClaimed(msg.sender, amount);
    }

    function claimableZaps(address account) external view returns (uint256) {
        uint256 pending = (deposits[account] * cumulativeZapsPerShare) / ACC_SCALE - zapsDebt[account];
        return accruedZaps[account] + pending;
    }

    // ------------------------------------------------------------- internals

    function _checkpoint(address account) private {
        uint256 pending = (deposits[account] * cumulativeZapsPerShare) / ACC_SCALE - zapsDebt[account];
        if (pending != 0) accruedZaps[account] += pending;
        zapsDebt[account] = (deposits[account] * cumulativeZapsPerShare) / ACC_SCALE;
    }
}
