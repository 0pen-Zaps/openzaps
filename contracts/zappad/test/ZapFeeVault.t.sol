// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZapFeeVault } from "../src/ZapFeeVault.sol";
import { ZapToken } from "../src/ZapToken.sol";
import { ZapPadTestBase } from "./helpers/ZapPadTestBase.sol";

contract ZapFeeVaultTest is ZapPadTestBase {
    function test_harvestAndClaimsBothAssetsProRataEightyTwenty() public {
        (ZapToken token, ZapFeeVault vault,) = _launch(address(usdg), keccak256("pro rata"));
        uint256 tokenFees = 1000e18;
        uint256 pairFees = 500e18;
        _fundAndAccrue(token, vault, tokenFees, pairFees);

        assertEq(vault.claimable(creator, address(token)), 800e18);
        assertEq(vault.claimable(creator, address(usdg)), 400e18);
        assertEq(vault.claimable(treasury, address(token)), 200e18);
        assertEq(vault.claimable(treasury, address(usdg)), 100e18);

        vm.prank(creator);
        (uint256 creatorToken, uint256 creatorPair) = vault.claimAll(creator);
        assertEq(creatorToken, 800e18);
        assertEq(creatorPair, 400e18);

        vm.prank(treasury);
        (uint256 treasuryToken, uint256 treasuryPair) = vault.claimAll(treasury);
        assertEq(treasuryToken, 200e18);
        assertEq(treasuryPair, 100e18);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(usdg.balanceOf(address(vault)), 0);

        _assertConserved(vault, address(token));
        _assertConserved(vault, address(usdg));
    }

    function test_shareTransferCheckpointsPriorRevenueAtBoundary() public {
        (ZapToken token, ZapFeeVault vault,) = _launch(address(usdg), keccak256("transfer boundary"));

        _fundAndAccrue(token, vault, 0, 1000e18);
        vm.prank(creator);
        vault.transfer(alice, 40e18);
        assertEq(vault.balanceOf(creator), 40e18);
        assertEq(vault.balanceOf(alice), 40e18);

        _fundAndAccrue(token, vault, 0, 1000e18);

        vm.prank(creator);
        (, uint256 creatorPair) = vault.claimAll(creator);
        vm.prank(alice);
        (, uint256 alicePair) = vault.claimAll(alice);
        vm.prank(treasury);
        (, uint256 treasuryPair) = vault.claimAll(treasury);

        assertEq(creatorPair, 1200e18, "creator: 80% before, 40% after");
        assertEq(alicePair, 400e18, "alice: only 40% after transfer");
        assertEq(treasuryPair, 400e18, "treasury: 20% throughout");
        assertEq(usdg.balanceOf(address(vault)), 0);
        _assertConserved(vault, address(usdg));
    }

    function test_directDonationsAreIncludedWithoutExternalHarvest() public {
        (ZapToken token, ZapFeeVault vault,) = _launch(address(usdg), keccak256("donations"));
        uint256 tokenDonation = 250e18;
        uint256 pairDonation = 100e18;

        vm.prank(address(positionManager));
        token.transfer(address(vault), tokenDonation);
        usdg.mint(address(vault), pairDonation);

        assertEq(vault.claimable(creator, address(token)), 200e18);
        assertEq(vault.claimable(creator, address(usdg)), 80e18);
        assertEq(vault.claimable(treasury, address(token)), 50e18);
        assertEq(vault.claimable(treasury, address(usdg)), 20e18);

        vault.sync();
        vm.prank(creator);
        vault.claimAll(creator);
        vm.prank(treasury);
        vault.claimAll(treasury);
        _assertConserved(vault, address(token));
        _assertConserved(vault, address(usdg));
    }

    function test_prefundedDeterministicVaultDistributesAssetsToInitialShares() public {
        uint256 tokenPrefund = 1000e18;
        uint256 pairPrefund = 500e18;
        uint256 nextNonce = vm.getNonce(address(this));
        address predictedVault = vm.computeCreateAddress(address(this), nextNonce);
        usdg.mint(predictedVault, tokenPrefund);
        weth.mint(predictedVault, pairPrefund);

        ZapFeeVault prefundedVault = new ZapFeeVault(
            "Prefunded Fee Rights",
            "zfPRE",
            address(this),
            creator,
            treasury,
            address(usdg),
            address(weth),
            address(positionManager),
            8000
        );
        assertEq(address(prefundedVault), predictedVault);
        assertEq(prefundedVault.claimable(creator, address(usdg)), 800e18);
        assertEq(prefundedVault.claimable(creator, address(weth)), 400e18);
        assertEq(prefundedVault.claimable(treasury, address(usdg)), 200e18);
        assertEq(prefundedVault.claimable(treasury, address(weth)), 100e18);

        vm.prank(creator);
        prefundedVault.claimAll(creator);
        vm.prank(treasury);
        prefundedVault.claimAll(treasury);
        _assertConserved(prefundedVault, address(usdg));
        _assertConserved(prefundedVault, address(weth));
    }

    function test_shareTransferNeverCallsExternalCollect() public {
        (, ZapFeeVault vault,) = _launch(address(weth), keccak256("no collect transfer"));
        positionManager.setRevertCollect(true);

        vm.prank(creator);
        vault.transfer(alice, 10e18);
        assertEq(vault.balanceOf(alice), 10e18);

        vm.expectRevert(bytes("COLLECT_DISABLED"));
        vault.harvest();
    }

    function test_lockPositionRequiresLaunchpadOwnershipProofAndIsOneShot() public {
        (, ZapFeeVault vault, uint256 positionId) = _launch(address(weth), keccak256("owner proof"));

        vm.expectRevert(ZapFeeVault.NotLaunchpad.selector);
        vm.prank(attacker);
        vault.lockPosition(positionId);

        vm.expectRevert(ZapFeeVault.PositionAlreadySet.selector);
        vm.prank(address(launchpad));
        vault.lockPosition(positionId);

        ZapFeeVault emptyVault = new ZapFeeVault(
            "Empty Fee Rights",
            "zfEMPTY",
            address(this),
            creator,
            treasury,
            address(usdg),
            address(weth),
            address(positionManager),
            8000
        );
        vm.expectRevert(ZapFeeVault.InvalidPosition.selector);
        emptyVault.lockPosition(0);

        vm.expectRevert(ZapFeeVault.InvalidPosition.selector);
        emptyVault.lockPosition(positionId);
    }

    function test_harvestRequiresPosition() public {
        ZapFeeVault emptyVault = new ZapFeeVault(
            "Empty Fee Rights",
            "zfEMPTY",
            address(this),
            creator,
            treasury,
            address(usdg),
            address(weth),
            address(positionManager),
            8000
        );
        vm.expectRevert(ZapFeeVault.PositionNotSet.selector);
        emptyVault.harvest();
    }

    function test_claimValidatesRecipientAndIgnoresUnsupportedAsset() public {
        (, ZapFeeVault vault,) = _launch(address(weth), keccak256("claim validation"));

        vm.expectRevert(ZapFeeVault.ZeroAddress.selector);
        vm.prank(creator);
        vault.claimAll(address(0));

        vm.expectRevert(ZapFeeVault.ZeroAddress.selector);
        vm.prank(creator);
        vault.claim(address(weth), address(0));

        vm.prank(creator);
        assertEq(vault.claim(attacker, creator), 0);
        assertEq(vault.claimable(creator, attacker), 0);
    }

    function test_revenueAssetsCannotBeRecoveredAndNoRecoveryMethodExists() public {
        (ZapToken token, ZapFeeVault vault,) = _launch(address(usdg), keccak256("no recovery"));
        usdg.mint(address(vault), 100e18);

        (bool genericRecover,) = address(vault)
            .call(
                abi.encodeWithSignature(
                    "recoverToken(address,address,uint256)", address(usdg), attacker, 100e18
                )
            );
        (bool rescueRecover,) = address(vault)
            .call(
                abi.encodeWithSignature(
                    "rescueERC20(address,address,uint256)", address(token), attacker, 100e18
                )
            );
        assertFalse(genericRecover);
        assertFalse(rescueRecover);
        assertEq(usdg.balanceOf(address(vault)), 100e18);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_claimCannotBeRepeated() public {
        (ZapToken token, ZapFeeVault vault,) = _launch(address(usdg), keccak256("single claim"));
        _fundAndAccrue(token, vault, 100e18, 100e18);

        vm.prank(creator);
        vault.claimAll(creator);
        vm.prank(creator);
        (uint256 tokenAgain, uint256 pairAgain) = vault.claimAll(creator);
        assertEq(tokenAgain, 0);
        assertEq(pairAgain, 0);
    }

    function testFuzz_harvestClaimsRemainSolventAndConserved(uint96 rawTokenFees, uint96 rawPairFees) public {
        uint256 tokenFees = bound(uint256(rawTokenFees), 1, 10_000_000e18);
        uint256 pairFees = bound(uint256(rawPairFees), 1, 10_000_000e18);
        (ZapToken token, ZapFeeVault vault,) =
            _launch(address(usdg), keccak256(abi.encode(rawTokenFees, rawPairFees)));
        _fundAndAccrue(token, vault, tokenFees, pairFees);

        assertEq(vault.claimable(creator, address(token)), (tokenFees * 80) / 100);
        assertEq(vault.claimable(treasury, address(token)), (tokenFees * 20) / 100);
        assertEq(vault.claimable(creator, address(usdg)), (pairFees * 80) / 100);
        assertEq(vault.claimable(treasury, address(usdg)), (pairFees * 20) / 100);

        vm.prank(creator);
        vault.claimAll(creator);
        vm.prank(treasury);
        vault.claimAll(treasury);

        _assertConserved(vault, address(token));
        _assertConserved(vault, address(usdg));
        (,,, uint256 tokenClaimed) = vault.assetState(address(token));
        (,,, uint256 pairClaimed) = vault.assetState(address(usdg));
        assertLe(tokenClaimed, tokenFees);
        assertLe(pairClaimed, pairFees);
    }

    function testFuzz_transferBoundaryPreservesEarnedRevenue(
        uint96 rawFirst,
        uint96 rawSecond,
        uint64 rawShares
    ) public {
        uint256 first = bound(uint256(rawFirst), 1, 1_000_000e18);
        uint256 second = bound(uint256(rawSecond), 1, 1_000_000e18);
        uint256 moved = bound(uint256(rawShares), 0, 80e18);
        (ZapToken token, ZapFeeVault vault,) =
            _launch(address(usdg), keccak256(abi.encode(rawFirst, rawSecond, rawShares)));

        _fundAndAccrue(token, vault, 0, first);
        vm.prank(creator);
        vault.transfer(alice, moved);
        _fundAndAccrue(token, vault, 0, second);

        uint256 creatorExpected = (first * 80e18) / 100e18 + (second * (80e18 - moved)) / 100e18;
        uint256 aliceExpected = (second * moved) / 100e18;
        // Treasury never transfers, so its two checkpoints share one index and round only once.
        uint256 treasuryExpected = ((first + second) * 20e18) / 100e18;

        assertEq(vault.claimable(creator, address(usdg)), creatorExpected);
        assertEq(vault.claimable(alice, address(usdg)), aliceExpected);
        assertEq(vault.claimable(treasury, address(usdg)), treasuryExpected);

        vm.prank(creator);
        vault.claimAll(creator);
        vm.prank(alice);
        vault.claimAll(alice);
        vm.prank(treasury);
        vault.claimAll(treasury);
        _assertConserved(vault, address(usdg));
    }

    function _assertConserved(ZapFeeVault vault, address asset) private view {
        (, uint256 lastBalance, uint256 totalSynced, uint256 totalClaimed) = vault.assetState(asset);
        assertEq(IERC20(asset).balanceOf(address(vault)), lastBalance, "tracked balance");
        assertEq(totalSynced, totalClaimed + lastBalance, "synced = claimed + solvent balance");
    }
}
