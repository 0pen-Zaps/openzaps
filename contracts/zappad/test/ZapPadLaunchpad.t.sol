// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TickMath } from "../src/libraries/TickMath.sol";
import { ZapFeeVault } from "../src/ZapFeeVault.sol";
import { ZapPadLaunchpad } from "../src/ZapPadLaunchpad.sol";
import { ZapToken } from "../src/ZapToken.sol";
import { ZapPadTestBase } from "./helpers/ZapPadTestBase.sol";
import { MockPositionManager, MockSwapRouter, MockV3Factory } from "./mocks/MockUniswapV3.sol";

contract ZapPadLaunchpadTest is ZapPadTestBase {
    function test_launchesWethPairWithPredictedTokenAndPermanentLpLock() public {
        (ZapToken token, ZapFeeVault vault, uint256 positionId) =
            _launch(address(weth), keccak256("weth launch"));

        (
            bool exists,
            address launchCreator,
            address pool,
            address feeVault,
            uint256 recordedPositionId,
            address pairedAsset,
            uint24 feeTier,
            int24 floorTick
        ) = launchpad.launches(address(token));

        assertTrue(exists);
        assertEq(launchCreator, creator);
        assertTrue(pool.code.length > 0);
        assertEq(feeVault, address(vault));
        assertEq(recordedPositionId, positionId);
        assertEq(pairedAsset, address(weth));
        assertEq(feeTier, DEFAULT_FEE);
        assertEq(floorTick, DEFAULT_TICK);
        assertEq(positionManager.ownerOf(positionId), address(vault));
        assertEq(vault.positionId(), positionId);
        assertEq(token.balanceOf(address(positionManager)), launchpad.LAUNCH_SUPPLY());
        assertEq(token.balanceOf(address(launchpad)), 0);
        assertEq(token.totalSupply(), launchpad.LAUNCH_SUPPLY());
        assertEq(token.creator(), creator);
        assertEq(token.launchpad(), address(launchpad));
        assertEq(launchpad.tokenCount(), 1);
        (bytes32 configHash, uint64 launchedAt, uint256 firstBuyAmountIn, uint256 firstBuyAmountOut) =
            launchpad.launchProvenance(address(token));
        assertNotEq(configHash, bytes32(0));
        assertEq(launchedAt, block.timestamp);
        assertEq(firstBuyAmountIn, 0);
        assertEq(firstBuyAmountOut, 0);
    }

    function test_launchesUsdgPairAndDistributesFeeSharesEightyTwenty() public {
        (ZapToken token, ZapFeeVault vault, uint256 positionId) =
            _launch(address(usdg), keccak256("usdg launch"));

        assertEq(vault.launchToken(), address(token));
        assertEq(vault.pairedAsset(), address(usdg));
        assertEq(vault.launchpad(), address(launchpad));
        assertEq(vault.totalSupply(), vault.SHARE_SUPPLY());
        assertEq(vault.balanceOf(creator), 80e18);
        assertEq(vault.balanceOf(treasury), 20e18);
        assertEq(positionManager.ownerOf(positionId), address(vault));
    }

    function test_zeroPairDefaultsToWeth() public {
        (bytes32 salt,) = _mineSaltBelowPair(creator, address(weth), keccak256("default weth"));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(0), salt);
        vm.prank(creator);
        (address token,) = launchpad.launch(p);

        (,,,,, address pairedAsset,,) = launchpad.launches(token);
        assertEq(pairedAsset, address(weth));
    }

    function test_firstBuyWithNativeEthWrapsAndBuysForCreator() public {
        (bytes32 salt,) = _mineSaltBelowPair(creator, address(weth), keccak256("eth buy"));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), salt);
        uint256 amountIn = 0.01 ether;
        uint256 expectedOut = amountIn * swapRouter.outputMultiplier();
        p.minFirstBuyTokensOut = expectedOut;
        bytes32 expectedConfigHash = launchpad.launchConfigHash(creator, p, amountIn);
        vm.deal(creator, amountIn);
        vm.warp(1_785_285_600);

        vm.prank(creator);
        (address token,) = launchpad.launch{ value: amountIn }(p);

        assertEq(IERC20(token).balanceOf(creator), expectedOut);
        assertEq(weth.balanceOf(address(positionManager)), amountIn);
        assertEq(address(creator).balance, 0);
        (bytes32 configHash, uint64 launchedAt, uint256 firstBuyAmountIn, uint256 firstBuyAmountOut) =
            launchpad.launchProvenance(token);
        assertEq(configHash, expectedConfigHash);
        assertEq(launchedAt, block.timestamp);
        assertEq(firstBuyAmountIn, amountIn);
        assertEq(firstBuyAmountOut, expectedOut);
    }

    function test_firstBuyWithUsdgPullsExactInputAndBuysForCreator() public {
        (bytes32 salt,) = _mineSaltBelowPair(creator, address(usdg), keccak256("usdg buy"));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(usdg), salt);
        uint256 amountIn = 2500e18;
        uint256 expectedOut = amountIn * swapRouter.outputMultiplier();
        p.firstBuyPairIn = amountIn;
        p.minFirstBuyTokensOut = expectedOut;
        bytes32 expectedConfigHash = launchpad.launchConfigHash(creator, p, 0);
        usdg.mint(creator, amountIn);
        vm.prank(creator);
        usdg.approve(address(launchpad), amountIn);

        vm.prank(creator);
        (address token,) = launchpad.launch(p);

        assertEq(IERC20(token).balanceOf(creator), expectedOut);
        assertEq(usdg.balanceOf(creator), 0);
        assertEq(usdg.balanceOf(address(positionManager)), amountIn);
        assertEq(usdg.allowance(address(launchpad), address(swapRouter)), 0);
        (bytes32 configHash,, uint256 firstBuyAmountIn, uint256 firstBuyAmountOut) =
            launchpad.launchProvenance(token);
        assertEq(configHash, expectedConfigHash);
        assertEq(firstBuyAmountIn, amountIn);
        assertEq(firstBuyAmountOut, expectedOut);
    }

    function test_revertsWethFirstBuyWhenErc20AmountIsAlsoSpecified() public {
        (bytes32 salt,) = _mineSaltBelowPair(creator, address(weth), keccak256("bad weth buy"));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), salt);
        p.firstBuyPairIn = 1;
        vm.expectRevert(ZapPadLaunchpad.FirstBuyMismatch.selector);
        vm.prank(creator);
        launchpad.launch(p);
    }

    function test_revertsUsdgFirstBuyWhenNativeValueIsSent() public {
        (bytes32 salt,) = _mineSaltBelowPair(creator, address(usdg), keccak256("bad usdg buy"));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(usdg), salt);
        vm.deal(creator, 1 ether);
        vm.expectRevert(ZapPadLaunchpad.FirstBuyMismatch.selector);
        vm.prank(creator);
        launchpad.launch{ value: 1 }(p);
    }

    function test_revertsFirstBuyWhenMinimumOutputCannotBeMet() public {
        (bytes32 salt,) = _mineSaltBelowPair(creator, address(weth), keccak256("slippage"));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), salt);
        uint256 amountIn = 1 ether;
        p.minFirstBuyTokensOut = amountIn * swapRouter.outputMultiplier() + 1;
        vm.deal(creator, amountIn);
        vm.expectRevert(bytes("TOO_LITTLE_RECEIVED"));
        vm.prank(creator);
        launchpad.launch{ value: amountIn }(p);
    }

    function test_revertsDisallowedPair() public {
        ZapPadLaunchpad.LaunchParams memory p = _params(attacker, bytes32(uint256(1)));
        vm.expectRevert(ZapPadLaunchpad.PairNotAllowed.selector);
        vm.prank(creator);
        launchpad.launch(p);
    }

    function test_revertsUnsupportedOrDisabledFeeTiers() public {
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), bytes32(uint256(1)));
        p.feeTier = 100;
        vm.expectRevert(ZapPadLaunchpad.FeeTierNotAllowed.selector);
        vm.prank(creator);
        launchpad.launch(p);

        p.feeTier = 500;
        v3Factory.setFeeSpacing(500, 0);
        vm.expectRevert(ZapPadLaunchpad.FeeTierNotEnabled.selector);
        vm.prank(creator);
        launchpad.launch(p);
    }

    function test_revertsInvalidTicksAndRoundsNegativeTickDown() public {
        (bytes32 validSalt,) = _mineSaltBelowPair(creator, address(weth), keccak256("tick rounding"));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), validSalt);
        p.floorTick = DEFAULT_TICK - 1;
        vm.prank(creator);
        (address token,) = launchpad.launch(p);
        (,,,,,,, int24 alignedTick) = launchpad.launches(token);
        assertEq(alignedTick, DEFAULT_TICK - 60);

        (bytes32 lowSalt,) = _mineSaltBelowPair(creator, address(weth), keccak256("tick low"));
        p = _params(address(weth), lowSalt);
        p.floorTick = -887_221;
        vm.expectRevert(ZapPadLaunchpad.InvalidTick.selector);
        vm.prank(creator);
        launchpad.launch(p);

        (bytes32 highSalt,) = _mineSaltBelowPair(creator, address(weth), keccak256("tick high"));
        p = _params(address(weth), highSalt);
        p.floorTick = 887_220;
        vm.expectRevert(ZapPadLaunchpad.InvalidTick.selector);
        vm.prank(creator);
        launchpad.launch(p);
    }

    function test_revertsInvalidMetadataLengths() public {
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), bytes32(uint256(1)));
        p.name = "";
        _expectInvalidMetadata(p);

        p = _params(address(weth), bytes32(uint256(2)));
        p.name = new string(65);
        _expectInvalidMetadata(p);

        p = _params(address(weth), bytes32(uint256(3)));
        p.symbol = "";
        _expectInvalidMetadata(p);

        p = _params(address(weth), bytes32(uint256(4)));
        p.symbol = new string(13);
        _expectInvalidMetadata(p);

        p = _params(address(weth), bytes32(uint256(5)));
        p.metadataURI = new string(2049);
        _expectInvalidMetadata(p);
    }

    function test_revertsIfPredictedTokenSortsAfterPair() public {
        (bytes32 salt, address predicted) = _mineSaltAbovePair(creator, address(weth), keccak256("bad order"));
        assertGt(uint256(uint160(predicted)), uint256(uint160(address(weth))));
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), salt);
        vm.expectRevert(ZapPadLaunchpad.TokenNotBelowPair.selector);
        vm.prank(creator);
        launchpad.launch(p);
    }

    function test_revertsIfPoolWasAlreadyInitialized() public {
        (bytes32 salt, address predicted) =
            _mineSaltBelowPair(creator, address(weth), keccak256("existing pool"));
        v3Factory.createInitializedPool(
            predicted, address(weth), DEFAULT_FEE, TickMath.getSqrtPriceAtTick(DEFAULT_TICK)
        );
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), salt);
        vm.expectRevert(ZapPadLaunchpad.PoolAlreadyInitialized.selector);
        vm.prank(creator);
        launchpad.launch(p);
    }

    function test_usesExistingUninitializedPool() public {
        (bytes32 salt, address predicted) =
            _mineSaltBelowPair(creator, address(weth), keccak256("uninitialized pool"));
        address existing = v3Factory.createPool(predicted, address(weth), DEFAULT_FEE);
        ZapPadLaunchpad.LaunchParams memory p = _params(address(weth), salt);
        vm.prank(creator);
        (address token,) = launchpad.launch(p);
        (,, address pool,,,,,) = launchpad.launches(token);
        assertEq(pool, existing);
    }

    function test_lpNftCannotBeMovedByUnauthorizedAccountAndVaultHasNoEscapeMethod() public {
        (, ZapFeeVault vault, uint256 positionId) = _launch(address(weth), keccak256("locked nft"));

        vm.expectRevert();
        vm.prank(attacker);
        positionManager.transferFrom(address(vault), attacker, positionId);

        (bool success,) = address(vault)
            .call(abi.encodeWithSignature("transferPosition(address,uint256)", attacker, positionId));
        assertFalse(success);
        assertEq(positionManager.ownerOf(positionId), address(vault));
    }

    function test_indexesNewestLaunchesFirst() public {
        (ZapToken first,,) = _launch(address(weth), keccak256("first"));
        (ZapToken second,,) = _launch(address(usdg), keccak256("second"));

        address[] memory all = launchpad.launchedTokens(0, 10);
        assertEq(all.length, 2);
        assertEq(all[0], address(second));
        assertEq(all[1], address(first));

        address[] memory page = launchpad.launchedTokens(1, 1);
        assertEq(page.length, 1);
        assertEq(page[0], address(first));
        assertEq(launchpad.launchedTokens(2, 10).length, 0);
        assertEq(launchpad.launchedTokens(0, 0).length, 0);
    }

    function test_constructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(ZapPadLaunchpad.WrongChain.selector);
        new ZapPadLaunchpad(
            treasury,
            address(tokenFactory),
            address(feeVaultFactory),
            address(positionManager),
            address(swapRouter),
            address(weth),
            address(usdg)
        );
    }

    function test_constructorRejectsRouterFromDifferentFactory() public {
        MockV3Factory otherFactory = new MockV3Factory();
        MockPositionManager otherPositionManager = new MockPositionManager(address(otherFactory));
        MockSwapRouter mismatchedRouter = new MockSwapRouter(address(otherPositionManager));

        vm.expectRevert(ZapPadLaunchpad.DependencyMismatch.selector);
        new ZapPadLaunchpad(
            treasury,
            address(tokenFactory),
            address(feeVaultFactory),
            address(positionManager),
            address(mismatchedRouter),
            address(weth),
            address(usdg)
        );
    }

    function test_tickSpacingQueriesOnlyAllowlistedTiers() public view {
        assertEq(launchpad.tickSpacingFor(500), 10);
        assertEq(launchpad.tickSpacingFor(3000), 60);
        assertEq(launchpad.tickSpacingFor(10_000), 200);
        assertEq(launchpad.tickSpacingFor(100), 0);
    }

    function testFuzz_predictionMatchesDeployment(bytes32 seed, bool useUsdg) public {
        address pair = useUsdg ? address(usdg) : address(weth);
        (bytes32 salt, address predicted) = _mineSaltBelowPair(creator, pair, seed);
        ZapPadLaunchpad.LaunchParams memory p = _params(pair, salt);
        vm.prank(creator);
        (address deployed,) = launchpad.launch(p);
        assertEq(deployed, predicted);
        assertLt(uint256(uint160(deployed)), uint256(uint160(pair)));
    }

    function _expectInvalidMetadata(ZapPadLaunchpad.LaunchParams memory p) private {
        vm.expectRevert(ZapPadLaunchpad.InvalidMetadata.selector);
        vm.prank(creator);
        launchpad.launch(p);
    }
}
