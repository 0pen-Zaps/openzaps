// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZapFeeVault } from "../../src/ZapFeeVault.sol";
import { ZapFeeVaultFactory } from "../../src/ZapFeeVaultFactory.sol";
import { ZapPadLaunchpad } from "../../src/ZapPadLaunchpad.sol";
import { ZapToken } from "../../src/ZapToken.sol";
import { ZapTokenFactory } from "../../src/ZapTokenFactory.sol";
import {
    MockERC20,
    MockPositionManager,
    MockSwapRouter,
    MockV3Factory,
    MockWETH
} from "../mocks/MockUniswapV3.sol";

abstract contract ZapPadTestBase is Test {
    uint24 internal constant DEFAULT_FEE = 3000;
    int24 internal constant DEFAULT_TICK = -276_300;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    MockWETH internal weth;
    MockERC20 internal usdg;
    MockV3Factory internal v3Factory;
    MockPositionManager internal positionManager;
    MockSwapRouter internal swapRouter;
    ZapTokenFactory internal tokenFactory;
    ZapFeeVaultFactory internal feeVaultFactory;
    ZapPadLaunchpad internal launchpad;

    function setUp() public virtual {
        vm.chainId(4663);
        weth = new MockWETH();
        usdg = new MockERC20("USDG", "USDG");
        v3Factory = new MockV3Factory();
        positionManager = new MockPositionManager(address(v3Factory));
        swapRouter = new MockSwapRouter(address(positionManager));
        positionManager.setRouter(address(swapRouter));
        tokenFactory = new ZapTokenFactory();
        feeVaultFactory = new ZapFeeVaultFactory();
        launchpad = new ZapPadLaunchpad(
            treasury,
            address(tokenFactory),
            address(feeVaultFactory),
            address(positionManager),
            address(swapRouter),
            address(weth),
            address(usdg)
        );
        tokenFactory.bindLaunchpad(address(launchpad));
        feeVaultFactory.bindLaunchpad(address(launchpad));
    }

    function _params(address pair, bytes32 salt)
        internal
        pure
        returns (ZapPadLaunchpad.LaunchParams memory p)
    {
        p = ZapPadLaunchpad.LaunchParams({
            name: "Test Zap",
            symbol: "TZAP",
            metadataURI: "ipfs://test-zap",
            salt: salt,
            floorTick: DEFAULT_TICK,
            pairedAsset: pair,
            feeTier: DEFAULT_FEE,
            firstBuyPairIn: 0,
            minFirstBuyTokensOut: 0
        });
    }

    function _mineSaltBelowPair(address launchCreator, address pair, bytes32 seed)
        internal
        view
        returns (bytes32 salt, address prediction)
    {
        uint256 start = uint256(seed);
        for (uint256 i; i < 100_000; ++i) {
            salt = bytes32(start + i);
            prediction = tokenFactory.predictTokenAddress(
                launchCreator, salt, "Test Zap", "TZAP", "ipfs://test-zap", launchpad.LAUNCH_SUPPLY()
            );
            if (prediction < pair) return (salt, prediction);
        }
        revert("SALT_NOT_FOUND");
    }

    function _mineSaltAbovePair(address launchCreator, address pair, bytes32 seed)
        internal
        view
        returns (bytes32 salt, address prediction)
    {
        uint256 start = uint256(seed);
        for (uint256 i; i < 100_000; ++i) {
            salt = bytes32(start + i);
            prediction = tokenFactory.predictTokenAddress(
                launchCreator, salt, "Test Zap", "TZAP", "ipfs://test-zap", launchpad.LAUNCH_SUPPLY()
            );
            if (prediction > pair) return (salt, prediction);
        }
        revert("SALT_NOT_FOUND");
    }

    function _launch(address pair, bytes32 seed)
        internal
        returns (ZapToken token, ZapFeeVault vault, uint256 positionId)
    {
        (bytes32 salt, address predicted) = _mineSaltBelowPair(creator, pair, seed);
        ZapPadLaunchpad.LaunchParams memory p = _params(pair, salt);
        vm.prank(creator);
        (address tokenAddress, address vaultAddress) = launchpad.launch(p);
        assertEq(tokenAddress, predicted, "CREATE2 prediction");
        token = ZapToken(tokenAddress);
        vault = ZapFeeVault(vaultAddress);
        (,,,, positionId,,,) = launchpad.launches(tokenAddress);
    }

    function _fundAndAccrue(ZapToken token, ZapFeeVault vault, uint256 launchAmount, uint256 pairAmount)
        internal
    {
        uint256 launchBefore = IERC20(address(token)).balanceOf(address(vault));
        uint256 pairBefore = IERC20(vault.pairedAsset()).balanceOf(address(vault));
        if (pairAmount > 0) {
            MockERC20(vault.pairedAsset()).mint(address(positionManager), pairAmount);
        }
        positionManager.accrueFees(vault.positionId(), launchAmount, pairAmount);
        vault.harvest();
        assertEq(IERC20(address(token)).balanceOf(address(vault)), launchBefore + launchAmount);
        assertEq(IERC20(vault.pairedAsset()).balanceOf(address(vault)), pairBefore + pairAmount);
    }
}
