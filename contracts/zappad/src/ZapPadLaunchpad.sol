// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { TickMath } from "./libraries/TickMath.sol";
import { ZapToken } from "./ZapToken.sol";
import { ZapFeeVault } from "./ZapFeeVault.sol";
import { IZapFeeVaultFactory, IZapTokenFactory } from "./interfaces/IZapPadFactories.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter02,
    IUniswapV3Factory,
    IUniswapV3PoolMinimal,
    IWETH9
} from "./interfaces/IUniswapV3.sol";

/// @title ZapPadLaunchpad
/// @notice One-transaction Robinhood Chain ERC-20 + Uniswap v3 + fee-right launchpad.
contract ZapPadLaunchpad is ReentrancyGuard {
    using SafeERC20 for IERC20;

    string public constant contractName = "ZapPadLaunchpad";
    string public constant contractVersion = "1.0.0";
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 public constant LAUNCH_SUPPLY = 1_000_000_000e18;
    uint256 public constant MAX_SEED_DUST = 1e18;
    uint16 public constant CREATOR_FEE_SHARE_BPS = 8000;
    uint16 public constant BPS = 10_000;
    bytes32 public constant LAUNCH_CONFIG_DOMAIN = keccak256("ZapPadLaunchConfig:v1");

    address public immutable protocolTreasury;
    address public immutable weth;
    address public immutable usdg;
    IZapTokenFactory public immutable tokenFactory;
    IZapFeeVaultFactory public immutable feeVaultFactory;
    INonfungiblePositionManager public immutable positionManager;
    IUniswapV3Factory public immutable v3Factory;
    ISwapRouter02 public immutable swapRouter;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        bytes32 salt;
        int24 floorTick;
        address pairedAsset;
        uint24 feeTier;
        uint256 firstBuyPairIn;
        uint256 minFirstBuyTokensOut;
    }

    struct Launch {
        bool exists;
        address creator;
        address pool;
        address feeVault;
        uint256 positionId;
        address pairedAsset;
        uint24 feeTier;
        int24 floorTick;
    }

    struct LaunchProvenance {
        bytes32 configHash;
        uint64 launchedAt;
        uint256 firstBuyAmountIn;
        uint256 firstBuyAmountOut;
    }

    mapping(address token => Launch) public launches;
    mapping(address token => LaunchProvenance) private _launchProvenance;
    address[] private _allTokens;

    event TokenLaunched(
        address indexed token,
        address indexed creator,
        address indexed feeVault,
        address pool,
        string name,
        string symbol,
        string metadataURI,
        uint256 positionId,
        address pairedAsset,
        uint24 feeTier,
        int24 floorTick
    );
    event CreatorFirstBuy(
        address indexed token,
        address indexed creator,
        address indexed pairedAsset,
        uint256 amountIn,
        uint256 amountOut
    );
    event PositionSeeded(
        address indexed token,
        address indexed pool,
        address indexed feeVault,
        uint256 positionId,
        uint128 liquidity,
        uint256 tokenAmount,
        uint256 dustBurned
    );
    event LaunchProvenanceRecorded(
        address indexed token,
        bytes32 indexed configHash,
        uint64 launchedAt,
        uint256 firstBuyAmountIn,
        uint256 firstBuyAmountOut
    );

    error WrongChain();
    error ZeroAddress();
    error MissingDependencyCode();
    error DependencyMismatch();
    error InvalidMetadata();
    error PairNotAllowed();
    error FeeTierNotAllowed();
    error FeeTierNotEnabled();
    error FirstBuyMismatch();
    error TokenNotBelowPair();
    error TokenAlreadyExists();
    error PoolAlreadyInitialized();
    error InvalidTick();
    error PositionLockFailed();
    error InvalidSeedAmounts();

    constructor(
        address protocolTreasury_,
        address tokenFactory_,
        address feeVaultFactory_,
        address positionManager_,
        address swapRouter_,
        address weth_,
        address usdg_
    ) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();
        if (
            protocolTreasury_ == address(0) || tokenFactory_ == address(0) || feeVaultFactory_ == address(0)
                || positionManager_ == address(0) || swapRouter_ == address(0) || weth_ == address(0)
                || usdg_ == address(0)
        ) revert ZeroAddress();
        if (
            tokenFactory_.code.length == 0 || feeVaultFactory_.code.length == 0
                || positionManager_.code.length == 0 || swapRouter_.code.length == 0 || weth_.code.length == 0
                || usdg_.code.length == 0
        ) revert MissingDependencyCode();

        address factory = INonfungiblePositionManager(positionManager_).factory();
        if (factory == address(0) || factory.code.length == 0) revert MissingDependencyCode();
        if (ISwapRouter02(swapRouter_).factory() != factory) revert DependencyMismatch();

        protocolTreasury = protocolTreasury_;
        tokenFactory = IZapTokenFactory(tokenFactory_);
        feeVaultFactory = IZapFeeVaultFactory(feeVaultFactory_);
        positionManager = INonfungiblePositionManager(positionManager_);
        v3Factory = IUniswapV3Factory(factory);
        swapRouter = ISwapRouter02(swapRouter_);
        weth = weth_;
        usdg = usdg_;
    }

    function tokenCount() external view returns (uint256) {
        return _allTokens.length;
    }

    function launchConfigHash(address creator, LaunchParams calldata p, uint256 nativeValue)
        external
        view
        returns (bytes32)
    {
        return _launchConfigHash(creator, p, nativeValue);
    }

    function launchProvenance(address token)
        external
        view
        returns (bytes32 configHash, uint64 launchedAt, uint256 firstBuyAmountIn, uint256 firstBuyAmountOut)
    {
        LaunchProvenance memory provenance = _launchProvenance[token];
        return (
            provenance.configHash,
            provenance.launchedAt,
            provenance.firstBuyAmountIn,
            provenance.firstBuyAmountOut
        );
    }

    function launchedTokens(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = _allTokens.length;
        if (offset >= total || limit == 0) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _allTokens[total - 1 - i];
        }
    }

    function pairAssets() external view returns (address[2] memory assets) {
        assets[0] = weth;
        assets[1] = usdg;
    }

    function tickSpacingFor(uint24 feeTier) public view returns (int24) {
        if (!_allowedFeeTier(feeTier)) return 0;
        return v3Factory.feeAmountTickSpacing(feeTier);
    }

    function tokenInitCodeHash(
        string memory name,
        string memory symbol,
        string memory metadataURI,
        address creator
    ) public view returns (bytes32) {
        return tokenFactory.tokenInitCodeHash(name, symbol, metadataURI, LAUNCH_SUPPLY, creator);
    }

    function predictTokenAddress(
        address creator,
        bytes32 salt,
        string memory name,
        string memory symbol,
        string memory metadataURI
    ) external view returns (address) {
        return tokenFactory.predictTokenAddress(creator, salt, name, symbol, metadataURI, LAUNCH_SUPPLY);
    }

    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address token, address feeVault)
    {
        _validateMetadata(p);
        address pair = p.pairedAsset == address(0) ? weth : p.pairedAsset;
        if (pair != weth && pair != usdg) revert PairNotAllowed();
        if (!_allowedFeeTier(p.feeTier)) revert FeeTierNotAllowed();

        int24 spacing = v3Factory.feeAmountTickSpacing(p.feeTier);
        if (spacing <= 0) revert FeeTierNotEnabled();
        int24 floorTick = _alignAndCheck(p.floorTick, spacing);

        if (pair == weth) {
            if (p.firstBuyPairIn != 0) revert FirstBuyMismatch();
        } else if (msg.value != 0) {
            revert FirstBuyMismatch();
        }

        token = tokenFactory.deploy(p.name, p.symbol, p.metadataURI, LAUNCH_SUPPLY, msg.sender, p.salt);
        ZapToken deployed = ZapToken(token);
        if (launches[token].exists) revert TokenAlreadyExists();
        if (token >= pair) revert TokenNotBelowPair();

        feeVault = feeVaultFactory.deploy(
            string.concat("ZapPad ", p.symbol, " Fee Rights"),
            string.concat("zf", p.symbol),
            msg.sender,
            protocolTreasury,
            token,
            pair,
            address(positionManager),
            CREATOR_FEE_SHARE_BPS
        );
        ZapFeeVault vault = ZapFeeVault(feeVault);

        (uint256 positionId, address pool, uint128 liquidity, uint256 amountSeeded) =
            _seedPosition(token, pair, p.feeTier, floorTick, spacing, feeVault);
        vault.lockPosition(positionId);
        if (vault.positionId() != positionId || positionManager.ownerOf(positionId) != feeVault) {
            revert PositionLockFailed();
        }

        uint256 leftover = IERC20(token).balanceOf(address(this));
        if (leftover > MAX_SEED_DUST || amountSeeded + leftover != LAUNCH_SUPPLY) {
            revert InvalidSeedAmounts();
        }
        if (leftover > 0) deployed.burnLaunchpadBalance(leftover);
        emit PositionSeeded(token, pool, feeVault, positionId, liquidity, amountSeeded, leftover);

        bytes32 configHash = _launchConfigHash(msg.sender, p, msg.value);
        _recordLaunch(token, feeVault, pool, positionId, pair, floorTick, configHash, p);

        uint256 firstBuyAmountIn = 0;
        uint256 firstBuyAmountOut = 0;
        if (msg.value > 0 || p.firstBuyPairIn > 0) {
            (firstBuyAmountIn, firstBuyAmountOut) =
                _creatorFirstBuy(token, pair, p.feeTier, p.firstBuyPairIn, p.minFirstBuyTokensOut);
        }
        LaunchProvenance storage provenance = _launchProvenance[token];
        provenance.firstBuyAmountIn = firstBuyAmountIn;
        provenance.firstBuyAmountOut = firstBuyAmountOut;
        emit LaunchProvenanceRecorded(
            token, configHash, provenance.launchedAt, firstBuyAmountIn, firstBuyAmountOut
        );
    }

    function _recordLaunch(
        address token,
        address feeVault,
        address pool,
        uint256 positionId,
        address pair,
        int24 floorTick,
        bytes32 configHash,
        LaunchParams calldata p
    ) private {
        launches[token] = Launch({
            exists: true,
            creator: msg.sender,
            pool: pool,
            feeVault: feeVault,
            positionId: positionId,
            pairedAsset: pair,
            feeTier: p.feeTier,
            floorTick: floorTick
        });
        _launchProvenance[token] = LaunchProvenance({
            configHash: configHash,
            launchedAt: uint64(block.timestamp),
            firstBuyAmountIn: 0,
            firstBuyAmountOut: 0
        });
        _allTokens.push(token);

        emit TokenLaunched(
            token,
            msg.sender,
            feeVault,
            pool,
            p.name,
            p.symbol,
            p.metadataURI,
            positionId,
            pair,
            p.feeTier,
            floorTick
        );
    }

    function _seedPosition(
        address token,
        address pair,
        uint24 feeTier,
        int24 floorTick,
        int24 spacing,
        address feeVault
    ) private returns (uint256 positionId, address pool, uint128 liquidity, uint256 amountSeeded) {
        pool = v3Factory.getPool(token, pair, feeTier);
        if (pool != address(0)) {
            (uint160 sqrtPriceX96,,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
            if (sqrtPriceX96 != 0) revert PoolAlreadyInitialized();
        }

        pool = positionManager.createAndInitializePoolIfNecessary(
            token, pair, feeTier, TickMath.getSqrtPriceAtTick(floorTick)
        );

        IERC20(token).forceApprove(address(positionManager), LAUNCH_SUPPLY);
        uint256 amount1;
        (positionId, liquidity, amountSeeded, amount1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token,
                token1: pair,
                fee: feeTier,
                tickLower: floorTick,
                tickUpper: _maxUsableTick(spacing),
                amount0Desired: LAUNCH_SUPPLY,
                amount1Desired: 0,
                amount0Min: LAUNCH_SUPPLY - MAX_SEED_DUST,
                amount1Min: 0,
                recipient: feeVault,
                deadline: block.timestamp
            })
        );
        IERC20(token).forceApprove(address(positionManager), 0);
        if (liquidity == 0 || amount1 != 0) revert InvalidSeedAmounts();
    }

    function _creatorFirstBuy(
        address token,
        address pair,
        uint24 feeTier,
        uint256 firstBuyPairIn,
        uint256 minTokensOut
    ) private returns (uint256 amountIn, uint256 amountOut) {
        if (pair == weth) {
            amountIn = msg.value;
            IWETH9(weth).deposit{ value: amountIn }();
        } else {
            uint256 beforeBalance = IERC20(pair).balanceOf(address(this));
            IERC20(pair).safeTransferFrom(msg.sender, address(this), firstBuyPairIn);
            amountIn = IERC20(pair).balanceOf(address(this)) - beforeBalance;
        }

        IERC20(pair).forceApprove(address(swapRouter), amountIn);
        amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: pair,
                tokenOut: token,
                fee: feeTier,
                recipient: msg.sender,
                amountIn: amountIn,
                amountOutMinimum: minTokensOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(pair).forceApprove(address(swapRouter), 0);
        emit CreatorFirstBuy(token, msg.sender, pair, amountIn, amountOut);
    }

    function _launchConfigHash(address creator, LaunchParams calldata p, uint256 nativeValue)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(LAUNCH_CONFIG_DOMAIN, block.chainid, address(this), creator, p, nativeValue)
        );
    }

    function _validateMetadata(LaunchParams calldata p) private pure {
        uint256 nameLength = bytes(p.name).length;
        uint256 symbolLength = bytes(p.symbol).length;
        uint256 metadataLength = bytes(p.metadataURI).length;
        if (
            nameLength == 0 || nameLength > 64 || symbolLength == 0 || symbolLength > 12
                || metadataLength > 2048
        ) revert InvalidMetadata();
    }

    function _allowedFeeTier(uint24 feeTier) private pure returns (bool) {
        return feeTier == 500 || feeTier == 3000 || feeTier == 10_000;
    }

    function _alignAndCheck(int24 tick, int24 spacing) private pure returns (int24 floorTick) {
        floorTick = (tick / spacing) * spacing;
        if (tick < 0 && tick % spacing != 0) floorTick -= spacing;
        int24 maxTick = _maxUsableTick(spacing);
        if (floorTick < -maxTick || floorTick > maxTick - spacing) revert InvalidTick();
    }

    function _maxUsableTick(int24 spacing) private pure returns (int24) {
        return (TickMath.MAX_TICK / spacing) * spacing;
    }
}
