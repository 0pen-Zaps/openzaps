// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZapFeeVault } from "../src/ZapFeeVault.sol";
import { ZapPadLaunchpad } from "../src/ZapPadLaunchpad.sol";
import { ZapToken } from "../src/ZapToken.sol";
import { ZapTokenFactory } from "../src/ZapTokenFactory.sol";
import { ZapFeeVaultFactory } from "../src/ZapFeeVaultFactory.sol";
import { ISafe } from "../src/interfaces/ISafe.sol";
import { ISwapRouter02 } from "../src/interfaces/IUniswapV3.sol";
import { SafeTreasuryDeployment } from "../script/lib/SafeTreasuryDeployment.sol";
import { ZapPadCanaryValidation } from "../script/lib/ZapPadCanaryValidation.sol";
import { ZapPadTestBase } from "./helpers/ZapPadTestBase.sol";
import { MockSafeProxyFactory, MockSafeSingleton } from "./mocks/MockSafe.sol";

contract DeploymentAutomationTest is ZapPadTestBase {
    MockSafeProxyFactory internal safeFactory;
    MockSafeSingleton internal safeSingleton;
    address internal safe;
    address[] internal safeOwners;

    function setUp() public override {
        super.setUp();
        safeFactory = new MockSafeProxyFactory();
        safeSingleton = new MockSafeSingleton();
        safeOwners = new address[](3);
        safeOwners[0] = alice;
        safeOwners[1] = bob;
        safeOwners[2] = creator;
        safe = _deploySafe(safeOwners, 2, 7);

        treasury = safe;
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

    function test_safeDeploymentCalldataPredictionAndReadbacks() public view {
        bytes memory expectedInitializer =
            SafeTreasuryDeployment.initializer(safeOwners, 2, address(0xF411BACC));
        assertEq(safeFactory.lastSingleton(), address(safeSingleton));
        assertEq(keccak256(safeFactory.lastInitializer()), keccak256(expectedInitializer));
        assertEq(safeFactory.lastSaltNonce(), 7);
        assertEq(ISafe(safe).masterCopy(), address(safeSingleton));
        assertEq(ISafe(safe).getThreshold(), 2);
        assertEq(ISafe(safe).getOwners(), safeOwners);
    }

    function test_safeConfigRejectsDuplicatesAndInvalidThreshold() public {
        address[] memory duplicateOwners = new address[](2);
        duplicateOwners[0] = alice;
        duplicateOwners[1] = alice;
        vm.expectRevert(abi.encodeWithSelector(SafeTreasuryDeployment.DuplicateOwner.selector, alice));
        this.validateSafeConfig(duplicateOwners, 1);

        vm.expectRevert(SafeTreasuryDeployment.InvalidThreshold.selector);
        this.validateSafeConfig(safeOwners, 4);
    }

    function test_mockCanaryReverseSwapSplitTransferClaimsAndCleanup() public {
        (ZapToken token, ZapFeeVault vault, uint256 positionId) =
            _launch(address(usdg), keccak256("deployment canary"));

        usdg.mint(creator, 1e18);
        vm.startPrank(creator);
        assertTrue(usdg.approve(address(swapRouter), 1e18));
        uint256 bought = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(usdg),
                tokenOut: address(token),
                fee: DEFAULT_FEE,
                recipient: creator,
                amountIn: 1e18,
                amountOutMinimum: 1,
                sqrtPriceLimitX96: 0
            })
        );
        assertTrue(token.approve(address(swapRouter), bought / 4));
        usdg.mint(address(positionManager), bought * 1000);
        uint256 reversed = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(token),
                tokenOut: address(usdg),
                fee: DEFAULT_FEE,
                recipient: creator,
                amountIn: bought / 4,
                amountOutMinimum: 1,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(reversed, 0);
        assertTrue(usdg.approve(address(swapRouter), 0));
        assertTrue(token.approve(address(swapRouter), 0));
        vm.stopPrank();

        _fundAndAccrue(token, vault, 1000e18, 500e18);
        ZapPadCanaryValidation.Distribution memory initial =
            ZapPadCanaryValidation.assertInitialDistribution(vault, creator, safe, 1000e18, 500e18);

        vm.prank(creator);
        assertTrue(vault.transfer(safe, 10e18));
        ZapPadCanaryValidation.assertTransferredShares(vault, creator, safe, initial);

        _fundAndAccrue(token, vault, 2000e18, 1000e18);
        ZapPadCanaryValidation.Distribution memory total =
            ZapPadCanaryValidation.assertPostTransferDistribution(
                vault, creator, safe, initial, 2000e18, 1000e18
            );

        vm.prank(creator);
        (uint256 creatorToken, uint256 creatorPair) = vault.claimAll(creator);
        ZapPadCanaryValidation.assertCreatorClaimed(vault, creator, creatorToken, creatorPair, total);
        ZapPadCanaryValidation.assertTreasuryClaimable(vault, safe, total);
        ZapPadCanaryValidation.assertCustodyAndCleanup(
            launchpad, vault, creator, address(token), address(usdg), positionId
        );

        uint256 safeTokenBefore = token.balanceOf(safe);
        uint256 safePairBefore = usdg.balanceOf(safe);
        ZapPadCanaryValidation.SafeClaimPlan memory plan =
            ZapPadCanaryValidation.buildSafeClaimPlan(ISafe(safe), vault, safe, ISafe(safe).nonce());
        vm.prank(alice);
        assertTrue(
            ISafe(safe)
                .execTransaction(
                    plan.target, 0, plan.data, 0, 0, 0, 0, address(0), payable(address(0)), bytes("")
                )
        );
        ZapPadCanaryValidation.assertFinalized(
            launchpad,
            vault,
            creator,
            safe,
            address(token),
            address(usdg),
            positionId,
            total,
            safeTokenBefore,
            safePairBefore
        );
        assertEq(IERC20(address(token)).balanceOf(safe), safeTokenBefore + total.treasuryToken);
        assertEq(IERC20(address(usdg)).balanceOf(safe), safePairBefore + total.treasuryPair);
    }

    function validateSafeConfig(address[] memory owners, uint256 threshold) external pure {
        SafeTreasuryDeployment.validateConfig(owners, threshold);
    }

    function _deploySafe(address[] memory owners, uint256 threshold, uint256 saltNonce)
        private
        returns (address deployed)
    {
        address handler = address(0xF411BACC);
        vm.etch(handler, hex"00");
        bytes memory setupData = SafeTreasuryDeployment.initializer(owners, threshold, handler);
        address predicted = SafeTreasuryDeployment.predict(
            address(safeFactory), address(safeSingleton), setupData, saltNonce
        );
        SafeTreasuryDeployment.requireFresh(predicted);
        deployed = safeFactory.createProxyWithNonce(address(safeSingleton), setupData, saltNonce);
        SafeTreasuryDeployment.verify(
            deployed, predicted, address(safeSingleton), handler, owners, threshold, block.chainid, true
        );
    }
}
