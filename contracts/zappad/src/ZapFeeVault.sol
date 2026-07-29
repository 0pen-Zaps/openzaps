// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { INonfungiblePositionManager } from "./interfaces/IUniswapV3.sol";

/// @title ZapFeeVault
/// @notice Permanently locks one Uniswap v3 LP NFT and tokenizes its harvested fees.
/// @dev A harvested/synced batch belongs to fee-share holders at that checkpoint.
///      ERC-20 transfers sync balances already received by this vault but never
///      invoke the external Uniswap collection path.
contract ZapFeeVault is ERC20, ERC20Permit, ReentrancyGuard {
    using SafeERC20 for IERC20;

    string public constant contractName = "ZapFeeVault";
    string public constant contractVersion = "1.0.0";
    uint256 public constant SHARE_SUPPLY = 100e18;
    uint256 public constant SCALE = 1e36;
    uint16 public constant BPS = 10_000;

    struct AssetState {
        uint256 accRevenuePerShare;
        uint256 lastBalance;
        uint256 totalSynced;
        uint256 totalClaimed;
    }

    address public immutable launchpad;
    address public immutable launchToken;
    address public immutable pairedAsset;
    INonfungiblePositionManager public immutable positionManager;
    uint256 public positionId;
    bool private _accountingActive;

    mapping(address asset => AssetState) public assetState;
    mapping(address user => mapping(address asset => uint256)) public userIndexPaid;
    mapping(address user => mapping(address asset => uint256)) public accrued;

    event PositionLocked(uint256 indexed positionId);
    event FeesHarvested(address indexed caller, uint256 launchTokenAmount, uint256 pairedAssetAmount);
    event RevenueSynced(address indexed asset, uint256 amount, uint256 accRevenuePerShare);
    event Claimed(address indexed holder, address indexed to, address indexed asset, uint256 amount);

    error ZeroAddress();
    error InvalidDistribution();
    error InvalidPosition();
    error NotLaunchpad();
    error PositionAlreadySet();
    error PositionNotSet();
    error BalanceInvariant();

    constructor(
        string memory name_,
        string memory symbol_,
        address launchpad_,
        address creator_,
        address protocolTreasury_,
        address launchToken_,
        address pairedAsset_,
        address positionManager_,
        uint16 creatorShareBps_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (
            launchpad_ == address(0) || creator_ == address(0) || protocolTreasury_ == address(0)
                || launchToken_ == address(0) || pairedAsset_ == address(0) || positionManager_ == address(0)
        ) revert ZeroAddress();
        if (launchToken_ == pairedAsset_ || creatorShareBps_ > BPS) revert InvalidDistribution();

        launchpad = launchpad_;
        launchToken = launchToken_;
        pairedAsset = pairedAsset_;
        positionManager = INonfungiblePositionManager(positionManager_);

        uint256 creatorShares = (SHARE_SUPPLY * creatorShareBps_) / BPS;
        if (creatorShares > 0) _mint(creator_, creatorShares);
        if (creatorShares < SHARE_SUPPLY) _mint(protocolTreasury_, SHARE_SUPPLY - creatorShares);

        // Intentionally start from zero: a deterministic future vault address
        // can be prefunded, and those assets must belong to the initial shares
        // rather than becoming permanently stranded below a constructor baseline.
        assetState[launchToken_].lastBalance = 0;
        assetState[pairedAsset_].lastBalance = 0;
        _accountingActive = true;
    }

    /// @notice Permissionlessly collect the position fees and checkpoint them.
    function harvest() external nonReentrant returns (uint256 launchAmount, uint256 pairAmount) {
        uint256 tokenId = positionId;
        if (tokenId == 0) revert PositionNotSet();
        (launchAmount, pairAmount) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        _syncAll();
        emit FeesHarvested(msg.sender, launchAmount, pairAmount);
    }

    /// @notice Checkpoint tokens already transferred to the vault.
    function sync() external {
        _syncAll();
    }

    function claim(address asset, address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        if (asset != launchToken && asset != pairedAsset) return 0;
        _syncAll();
        _settle(msg.sender);
        amount = _pay(msg.sender, to, asset);
    }

    function claimAll(address to) external nonReentrant returns (uint256 launchAmount, uint256 pairAmount) {
        if (to == address(0)) revert ZeroAddress();
        _syncAll();
        _settle(msg.sender);
        launchAmount = _pay(msg.sender, to, launchToken);
        pairAmount = _pay(msg.sender, to, pairedAsset);
    }

    function revenueAssets() external view returns (address[] memory assets) {
        assets = new address[](2);
        assets[0] = launchToken;
        assets[1] = pairedAsset;
    }

    function claimable(address holder, address asset) public view returns (uint256) {
        if (asset != launchToken && asset != pairedAsset) return 0;
        AssetState memory state = assetState[asset];
        uint256 currentIndex = state.accRevenuePerShare;
        uint256 currentBalance = IERC20(asset).balanceOf(address(this));
        if (currentBalance < state.lastBalance) revert BalanceInvariant();
        if (currentBalance > state.lastBalance) {
            currentIndex += ((currentBalance - state.lastBalance) * SCALE) / SHARE_SUPPLY;
        }
        return
            accrued[holder][asset] + (balanceOf(holder) * (currentIndex - userIndexPaid[holder][asset]))
                / SCALE;
    }

    function claimableAll(address holder)
        external
        view
        returns (address[] memory assets, uint256[] memory amounts)
    {
        assets = new address[](2);
        amounts = new uint256[](2);
        assets[0] = launchToken;
        assets[1] = pairedAsset;
        amounts[0] = claimable(holder, launchToken);
        amounts[1] = claimable(holder, pairedAsset);
    }

    /// @notice One-shot registration after the canonical NPM directly mints the
    ///         position to this vault. Ownership is proven on the NPM itself.
    function lockPosition(uint256 tokenId) external {
        if (msg.sender != launchpad) revert NotLaunchpad();
        if (positionId != 0) revert PositionAlreadySet();
        if (tokenId == 0 || positionManager.ownerOf(tokenId) != address(this)) {
            revert InvalidPosition();
        }
        positionId = tokenId;
        emit PositionLocked(tokenId);
    }

    function _pay(address holder, address to, address asset) private returns (uint256 amount) {
        amount = accrued[holder][asset];
        if (amount == 0) return 0;
        accrued[holder][asset] = 0;
        AssetState storage state = assetState[asset];
        state.lastBalance -= amount;
        state.totalClaimed += amount;
        IERC20(asset).safeTransfer(to, amount);
        emit Claimed(holder, to, asset, amount);
    }

    function _syncAll() private {
        _sync(launchToken);
        _sync(pairedAsset);
    }

    function _sync(address asset) private {
        AssetState storage state = assetState[asset];
        uint256 currentBalance = IERC20(asset).balanceOf(address(this));
        if (currentBalance < state.lastBalance) revert BalanceInvariant();
        uint256 delta = currentBalance - state.lastBalance;
        if (delta == 0) return;
        state.accRevenuePerShare += (delta * SCALE) / SHARE_SUPPLY;
        state.lastBalance = currentBalance;
        state.totalSynced += delta;
        emit RevenueSynced(asset, delta, state.accRevenuePerShare);
    }

    function _settle(address holder) private {
        if (holder == address(0)) return;
        uint256 shares = balanceOf(holder);
        _settleAsset(holder, shares, launchToken);
        _settleAsset(holder, shares, pairedAsset);
    }

    function _settleAsset(address holder, uint256 shares, address asset) private {
        uint256 current = assetState[asset].accRevenuePerShare;
        uint256 paid = userIndexPaid[holder][asset];
        if (current > paid) {
            accrued[holder][asset] += (shares * (current - paid)) / SCALE;
            userIndexPaid[holder][asset] = current;
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        if (_accountingActive) {
            _syncAll();
            _settle(from);
            if (to != from) _settle(to);
        }
        super._update(from, to, value);
    }
}
