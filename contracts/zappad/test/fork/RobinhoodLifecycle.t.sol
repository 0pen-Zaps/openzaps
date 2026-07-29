// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZapFeeVault } from "../../src/ZapFeeVault.sol";
import { ZapPadBootstrap } from "../../src/ZapPadBootstrap.sol";
import { ZapPadLaunchpad } from "../../src/ZapPadLaunchpad.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter02,
    IUniswapV3Factory,
    IUniswapV3PoolMinimal
} from "../../src/interfaces/IUniswapV3.sol";

/// @dev Runs automatically when ROBINHOOD_RPC_URL is provided:
///      ROBINHOOD_RPC_URL="https://..." forge test --match-contract RobinhoodLifecycleTest -vv
///      Production sign-off uses an archive backend that serves untouched
///      historical account and storage proofs at the pinned block.
contract RobinhoodLifecycleTest is Test {
    address internal constant POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant TREASURY = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant USDG_POOL_WHALE = 0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a;

    uint256 internal constant DEFAULT_FORK_BLOCK = 21_955_368;
    uint24 internal constant FEE_TIER = 3000;
    int24 internal constant WETH_FLOOR_TICK = -276_300;
    int24 internal constant USDG_FLOOR_TICK = -460_020;

    function test_liveRobinhoodLaunchSwapHarvestAndClaim() public {
        if (!_selectRobinhoodFork()) return;

        assertEq(block.chainid, 4663);
        assertTrue(POSITION_MANAGER.code.length > 0);
        assertTrue(V3_FACTORY.code.length > 0);
        assertTrue(SWAP_ROUTER.code.length > 0);
        assertTrue(WETH.code.length > 0);
        assertTrue(USDG.code.length > 0);
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).factory(), V3_FACTORY, "canonical NPM factory");
        assertEq(IUniswapV3Factory(V3_FACTORY).feeAmountTickSpacing(FEE_TIER), 60);

        ZapPadBootstrap bootstrap = new ZapPadBootstrap(TREASURY, POSITION_MANAGER, SWAP_ROUTER, WETH, USDG);
        ZapPadLaunchpad launchpad = ZapPadLaunchpad(bootstrap.launchpad());
        assertEq(address(launchpad.v3Factory()), V3_FACTORY);
        assertEq(launchpad.tickSpacingFor(FEE_TIER), 60);

        (bytes32 salt, address predictedToken) =
            _mineSalt(launchpad, WETH, "ZapPad Fork Canary", "ZFC", "ipfs://zappad-fork-canary");
        ZapPadLaunchpad.LaunchParams memory params = ZapPadLaunchpad.LaunchParams({
            name: "ZapPad Fork Canary",
            symbol: "ZFC",
            metadataURI: "ipfs://zappad-fork-canary",
            salt: salt,
            floorTick: WETH_FLOOR_TICK,
            pairedAsset: WETH,
            feeTier: FEE_TIER,
            firstBuyPairIn: 0,
            minFirstBuyTokensOut: 1
        });

        uint256 firstBuy = 0.0001 ether;
        vm.deal(address(this), 1 ether);
        (address token, address vaultAddress) = launchpad.launch{ value: firstBuy }(params);
        assertEq(token, predictedToken);
        assertGt(IERC20(token).balanceOf(address(this)), 0, "live first buy");

        (
            bool exists,
            address launchCreator,
            address pool,
            address recordedVault,
            uint256 positionId,
            address pairedAsset,
            uint24 feeTier,
            int24 floorTick
        ) = launchpad.launches(token);
        assertTrue(exists);
        assertEq(launchCreator, address(this));
        assertEq(recordedVault, vaultAddress);
        assertEq(pairedAsset, WETH);
        assertEq(feeTier, FEE_TIER);
        assertEq(floorTick, WETH_FLOOR_TICK);
        assertEq(IUniswapV3Factory(V3_FACTORY).getPool(token, WETH, FEE_TIER), pool);
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
        assertGt(sqrtPriceX96, 0);
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).ownerOf(positionId), vaultAddress);
        assertEq(IERC20(token).balanceOf(address(launchpad)), 0);
        assertEq(IERC20(WETH).balanceOf(address(launchpad)), 0);
        assertEq(IERC20(token).allowance(address(launchpad), POSITION_MANAGER), 0);
        assertEq(IERC20(WETH).allowance(address(launchpad), SWAP_ROUTER), 0);

        ZapFeeVault vault = ZapFeeVault(vaultAddress);
        assertEq(vault.balanceOf(address(this)), 80e18);
        assertEq(vault.balanceOf(TREASURY), 20e18);
        (, uint256 harvestedWeth) = vault.harvest();
        assertGt(harvestedWeth, 0, "live swap generated LP fees");
        assertEq(vault.claimable(TREASURY, WETH), (harvestedWeth * 20) / 100);
        uint256 beforeClaim = IERC20(WETH).balanceOf(address(this));
        (, uint256 claimedWeth) = vault.claimAll(address(this));
        assertEq(claimedWeth, (harvestedWeth * 80) / 100);
        assertEq(IERC20(WETH).balanceOf(address(this)), beforeClaim + claimedWeth);
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).ownerOf(positionId), vaultAddress);
    }

    function test_liveRobinhoodUsdgLaunchSellHarvestAndClaims() public {
        if (!_selectRobinhoodFork()) return;

        address treasury = makeAddr("usdg-treasury");
        ZapPadBootstrap bootstrap = new ZapPadBootstrap(treasury, POSITION_MANAGER, SWAP_ROUTER, WETH, USDG);
        ZapPadLaunchpad launchpad = ZapPadLaunchpad(bootstrap.launchpad());

        string memory name = "ZapPad USDG Fork";
        string memory symbol = "ZUSD";
        string memory metadataURI = "ipfs://zappad-usdg-fork";
        (bytes32 salt, address predictedToken) = _mineSalt(launchpad, USDG, name, symbol, metadataURI);

        // Impersonate the canonical live WETH/USDG pool to fund this
        // deterministic fork-only lifecycle without changing live state.
        vm.prank(USDG_POOL_WHALE);
        assertTrue(IERC20(USDG).transfer(address(this), 10_000_000));
        assertTrue(IERC20(USDG).approve(address(launchpad), 1_000_000));

        ZapPadLaunchpad.LaunchParams memory params = ZapPadLaunchpad.LaunchParams({
            name: name,
            symbol: symbol,
            metadataURI: metadataURI,
            salt: salt,
            floorTick: USDG_FLOOR_TICK,
            pairedAsset: USDG,
            feeTier: FEE_TIER,
            firstBuyPairIn: 1_000_000,
            minFirstBuyTokensOut: 1
        });

        (address token, address vaultAddress) = launchpad.launch(params);
        assertEq(token, predictedToken);
        assertGt(IERC20(token).balanceOf(address(this)), 0, "USDG first buy");
        assertEq(IERC20(USDG).allowance(address(this), address(launchpad)), 0);
        assertEq(IERC20(USDG).allowance(address(launchpad), SWAP_ROUTER), 0);

        (
            bool exists,
            address launchCreator,
            address pool,
            address recordedVault,
            uint256 positionId,
            address pairedAsset,
            uint24 feeTier,
            int24 floorTick
        ) = launchpad.launches(token);
        assertTrue(exists);
        assertEq(launchCreator, address(this));
        assertEq(recordedVault, vaultAddress);
        assertEq(pairedAsset, USDG);
        assertEq(feeTier, FEE_TIER);
        assertEq(floorTick, USDG_FLOOR_TICK);
        assertEq(IUniswapV3Factory(V3_FACTORY).getPool(token, USDG, FEE_TIER), pool);
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).ownerOf(positionId), vaultAddress);

        ZapFeeVault vault = ZapFeeVault(vaultAddress);
        assertEq(vault.balanceOf(address(this)), 80e18);
        assertEq(vault.balanceOf(treasury), 20e18);

        uint256 sellAmount = 1e24;
        assertTrue(IERC20(token).approve(SWAP_ROUTER, sellAmount));
        uint256 usdgOut = ISwapRouter02(SWAP_ROUTER)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: USDG,
                    fee: FEE_TIER,
                    recipient: address(this),
                    amountIn: sellAmount,
                    amountOutMinimum: 1,
                    sqrtPriceLimitX96: 0
                })
            );
        assertGt(usdgOut, 0, "reverse USDG swap");
        assertEq(IERC20(token).allowance(address(this), SWAP_ROUTER), 0);

        (uint256 harvestedToken, uint256 harvestedUsdg) = vault.harvest();
        assertGt(harvestedToken, 0, "launch-token fees");
        assertGt(harvestedUsdg, 0, "USDG fees");

        uint256 creatorTokenClaimable = vault.claimable(address(this), token);
        uint256 treasuryTokenClaimable = vault.claimable(treasury, token);
        uint256 creatorUsdgClaimable = vault.claimable(address(this), USDG);
        uint256 treasuryUsdgClaimable = vault.claimable(treasury, USDG);
        assertEq(creatorTokenClaimable, (harvestedToken * 80) / 100);
        assertEq(treasuryTokenClaimable, (harvestedToken * 20) / 100);
        assertEq(creatorUsdgClaimable, (harvestedUsdg * 80) / 100);
        assertEq(treasuryUsdgClaimable, (harvestedUsdg * 20) / 100);

        (uint256 creatorTokenClaimed, uint256 creatorUsdgClaimed) = vault.claimAll(address(this));
        vm.prank(treasury);
        (uint256 treasuryTokenClaimed, uint256 treasuryUsdgClaimed) = vault.claimAll(treasury);
        assertEq(creatorTokenClaimed, creatorTokenClaimable);
        assertEq(creatorUsdgClaimed, creatorUsdgClaimable);
        assertEq(treasuryTokenClaimed, treasuryTokenClaimable);
        assertEq(treasuryUsdgClaimed, treasuryUsdgClaimable);

        assertEq(vault.claimable(address(this), token), 0);
        assertEq(vault.claimable(address(this), USDG), 0);
        assertEq(vault.claimable(treasury, token), 0);
        assertEq(vault.claimable(treasury, USDG), 0);
        assertEq(IERC20(token).balanceOf(vaultAddress), 0);
        assertLe(IERC20(USDG).balanceOf(vaultAddress), 1);

        (, uint256 tokenLastBalance, uint256 tokenTotalSynced, uint256 tokenTotalClaimed) =
            vault.assetState(token);
        (, uint256 usdgLastBalance, uint256 usdgTotalSynced, uint256 usdgTotalClaimed) =
            vault.assetState(USDG);
        assertEq(tokenTotalSynced, tokenTotalClaimed + tokenLastBalance);
        assertEq(usdgTotalSynced, usdgTotalClaimed + usdgLastBalance);
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).ownerOf(positionId), vaultAddress);
        assertEq(address(launchpad).balance, 0);
        assertEq(IERC20(token).balanceOf(address(launchpad)), 0);
        assertEq(IERC20(USDG).balanceOf(address(launchpad)), 0);
    }

    function _selectRobinhoodFork() private returns (bool selected) {
        string memory rpcUrl = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return false;
        }
        uint256 forkBlock = vm.envOr("ROBINHOOD_FORK_BLOCK", DEFAULT_FORK_BLOCK);
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
        return true;
    }

    function _mineSalt(
        ZapPadLaunchpad launchpad,
        address pairedAsset,
        string memory name,
        string memory symbol,
        string memory metadataURI
    ) private view returns (bytes32 salt, address predicted) {
        for (uint256 i; i < 100_000; ++i) {
            salt = bytes32(i);
            predicted = launchpad.predictTokenAddress(address(this), salt, name, symbol, metadataURI);
            if (predicted < pairedAsset) return (salt, predicted);
        }
        revert("SALT_NOT_FOUND");
    }
}
