// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZapFeeVault } from "../../src/ZapFeeVault.sol";
import { ZapPadLaunchpad } from "../../src/ZapPadLaunchpad.sol";
import { INonfungiblePositionManager } from "../../src/interfaces/IUniswapV3.sol";
import { ISafe } from "../../src/interfaces/ISafe.sol";

library ZapPadCanaryValidation {
    uint256 internal constant ONE_HUNDRED_SHARES = 100e18;
    uint256 internal constant INITIAL_CREATOR_SHARES = 80e18;
    uint256 internal constant INITIAL_TREASURY_SHARES = 20e18;
    uint256 internal constant FINAL_CREATOR_SHARES = 70e18;
    uint256 internal constant FINAL_TREASURY_SHARES = 30e18;

    struct Distribution {
        uint256 creatorToken;
        uint256 creatorPair;
        uint256 treasuryToken;
        uint256 treasuryPair;
    }

    struct SafeClaimPlan {
        address target;
        bytes data;
        uint256 nonce;
        bytes32 safeTransactionHash;
    }

    error CanaryCheckFailed(bytes32 check, uint256 expected, uint256 actual);
    error CanaryAddressMismatch(bytes32 check, address expected, address actual);

    function assertInitialDistribution(
        ZapFeeVault vault,
        address creator,
        address treasury,
        uint256 harvestedToken,
        uint256 harvestedPair
    ) internal view returns (Distribution memory distribution) {
        _eq("shareSupply", ONE_HUNDRED_SHARES, vault.totalSupply());
        _eq("creatorShares80", INITIAL_CREATOR_SHARES, vault.balanceOf(creator));
        _eq("treasuryShares20", INITIAL_TREASURY_SHARES, vault.balanceOf(treasury));

        distribution = Distribution({
            creatorToken: (harvestedToken * 80) / 100,
            creatorPair: (harvestedPair * 80) / 100,
            treasuryToken: (harvestedToken * 20) / 100,
            treasuryPair: (harvestedPair * 20) / 100
        });
        _assertClaimable(vault, creator, treasury, distribution);
    }

    function assertTransferredShares(
        ZapFeeVault vault,
        address creator,
        address treasury,
        Distribution memory initial
    ) internal view {
        _eq("creatorShares70", FINAL_CREATOR_SHARES, vault.balanceOf(creator));
        _eq("treasuryShares30", FINAL_TREASURY_SHARES, vault.balanceOf(treasury));
        _assertClaimable(vault, creator, treasury, initial);
    }

    function assertPostTransferDistribution(
        ZapFeeVault vault,
        address creator,
        address treasury,
        Distribution memory initial,
        uint256 secondHarvestedToken,
        uint256 secondHarvestedPair
    ) internal view returns (Distribution memory total) {
        total = Distribution({
            creatorToken: initial.creatorToken + (secondHarvestedToken * 70) / 100,
            creatorPair: initial.creatorPair + (secondHarvestedPair * 70) / 100,
            treasuryToken: initial.treasuryToken + (secondHarvestedToken * 30) / 100,
            treasuryPair: initial.treasuryPair + (secondHarvestedPair * 30) / 100
        });
        _assertClaimable(vault, creator, treasury, total);
    }

    function assertCreatorClaimed(
        ZapFeeVault vault,
        address creator,
        uint256 claimedToken,
        uint256 claimedPair,
        Distribution memory expected
    ) internal view {
        _eq("creatorTokenClaim", expected.creatorToken, claimedToken);
        _eq("creatorPairClaim", expected.creatorPair, claimedPair);
        _eq("creatorTokenCleared", 0, vault.claimable(creator, vault.launchToken()));
        _eq("creatorPairCleared", 0, vault.claimable(creator, vault.pairedAsset()));
    }

    function assertTreasuryClaimable(ZapFeeVault vault, address treasury, Distribution memory expected)
        internal
        view
    {
        _eq("treasuryTokenClaimable", expected.treasuryToken, vault.claimable(treasury, vault.launchToken()));
        _eq("treasuryPairClaimable", expected.treasuryPair, vault.claimable(treasury, vault.pairedAsset()));
    }

    function assertCustodyAndCleanup(
        ZapPadLaunchpad launchpad,
        ZapFeeVault vault,
        address creator,
        address token,
        address pair,
        uint256 positionId
    ) internal view {
        INonfungiblePositionManager manager = launchpad.positionManager();
        _addressEq("vaultLaunchToken", token, vault.launchToken());
        _addressEq("vaultPairedAsset", pair, vault.pairedAsset());
        _eq("vaultPositionId", positionId, vault.positionId());
        _addressEq("lpOwner", address(vault), manager.ownerOf(positionId));
        _eq("launchpadNativeBalance", 0, address(launchpad).balance);
        _eq("launchpadTokenBalance", 0, IERC20(token).balanceOf(address(launchpad)));
        _eq("launchpadPairBalance", 0, IERC20(pair).balanceOf(address(launchpad)));
        _eq("launchpadPositionApproval", 0, IERC20(token).allowance(address(launchpad), address(manager)));
        _eq(
            "launchpadRouterApproval",
            0,
            IERC20(pair).allowance(address(launchpad), address(launchpad.swapRouter()))
        );
        _eq(
            "creatorRouterTokenApproval", 0, IERC20(token).allowance(creator, address(launchpad.swapRouter()))
        );
        _eq("creatorRouterPairApproval", 0, IERC20(pair).allowance(creator, address(launchpad.swapRouter())));
        _eq("creatorLaunchpadPairApproval", 0, IERC20(pair).allowance(creator, address(launchpad)));
    }

    function buildSafeClaimPlan(ISafe safe, ZapFeeVault vault, address treasury, uint256 safeNonce)
        internal
        view
        returns (SafeClaimPlan memory plan)
    {
        bytes memory data = abi.encodeCall(ZapFeeVault.claimAll, (treasury));
        plan = SafeClaimPlan({
            target: address(vault),
            data: data,
            nonce: safeNonce,
            safeTransactionHash: safe.getTransactionHash(
                address(vault), 0, data, 0, 0, 0, 0, address(0), address(0), safeNonce
            )
        });
    }

    function assertFinalized(
        ZapPadLaunchpad launchpad,
        ZapFeeVault vault,
        address creator,
        address treasury,
        address token,
        address pair,
        uint256 positionId,
        Distribution memory expected,
        uint256 treasuryTokenBalanceBefore,
        uint256 treasuryPairBalanceBefore
    ) internal view {
        _eq("creatorShares70Final", FINAL_CREATOR_SHARES, vault.balanceOf(creator));
        _eq("treasuryShares30Final", FINAL_TREASURY_SHARES, vault.balanceOf(treasury));
        _eq("creatorTokenClaimableFinal", 0, vault.claimable(creator, token));
        _eq("creatorPairClaimableFinal", 0, vault.claimable(creator, pair));
        _eq("treasuryTokenClaimableFinal", 0, vault.claimable(treasury, token));
        _eq("treasuryPairClaimableFinal", 0, vault.claimable(treasury, pair));
        _atLeast(
            "treasuryTokenReceived",
            treasuryTokenBalanceBefore + expected.treasuryToken,
            IERC20(token).balanceOf(treasury)
        );
        _atLeast(
            "treasuryPairReceived",
            treasuryPairBalanceBefore + expected.treasuryPair,
            IERC20(pair).balanceOf(treasury)
        );

        (, uint256 tokenLastBalance, uint256 tokenTotalSynced, uint256 tokenTotalClaimed) =
            vault.assetState(token);
        (, uint256 pairLastBalance, uint256 pairTotalSynced, uint256 pairTotalClaimed) =
            vault.assetState(pair);
        _eq("tokenTrackedBalance", tokenLastBalance, IERC20(token).balanceOf(address(vault)));
        _eq("pairTrackedBalance", pairLastBalance, IERC20(pair).balanceOf(address(vault)));
        _eq("tokenConservation", tokenTotalSynced, tokenTotalClaimed + tokenLastBalance);
        _eq("pairConservation", pairTotalSynced, pairTotalClaimed + pairLastBalance);
        assertCustodyAndCleanup(launchpad, vault, creator, token, pair, positionId);
    }

    function _assertClaimable(
        ZapFeeVault vault,
        address creator,
        address treasury,
        Distribution memory expected
    ) private view {
        _eq("creatorTokenClaimable", expected.creatorToken, vault.claimable(creator, vault.launchToken()));
        _eq("creatorPairClaimable", expected.creatorPair, vault.claimable(creator, vault.pairedAsset()));
        _eq("treasuryTokenClaimable", expected.treasuryToken, vault.claimable(treasury, vault.launchToken()));
        _eq("treasuryPairClaimable", expected.treasuryPair, vault.claimable(treasury, vault.pairedAsset()));
    }

    function _eq(bytes32 check, uint256 expected, uint256 actual) private pure {
        if (actual != expected) revert CanaryCheckFailed(check, expected, actual);
    }

    function _atLeast(bytes32 check, uint256 minimum, uint256 actual) private pure {
        if (actual < minimum) revert CanaryCheckFailed(check, minimum, actual);
    }

    function _addressEq(bytes32 check, address expected, address actual) private pure {
        if (actual != expected) revert CanaryAddressMismatch(check, expected, actual);
    }
}
