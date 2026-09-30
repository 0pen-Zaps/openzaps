// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {HookBlocks} from "../src/campaign/HookBlocks.sol";
import {Campaign3Terms} from "./Campaign3Terms.sol";

interface IVaultPreflight {
    function activated() external view returns (bool);
    function rewardAssetCount() external view returns (uint256);
    function rewardAssets(uint256 index) external view returns (address);
    function balanceOf(address account) external view returns (uint256);
}

interface IPoolManagerPreflight {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployHookBlocksRobinhoodCampaign3
/// @notice Deploys Campaign 3's HookBlocks leg on Robinhood Chain (4663).
///         This is a new immutable deployment; it does not modify Campaigns 1
///         or 2, the fee-share vault, or any locker wiring.
///
///         The explicitly requested October 1–31 UTC schedule is a 31-day
///         window. The 50/50 share allocation, 97% spot floor, per-buy bounds,
///         and 30-day recovery tail match Campaign 2. Do not broadcast this
///         release without explicit authorization; the checked-in schedule
///         also requires at least 24 hours of funding runway.
///
///         Read-only rehearsal only (do not add `--broadcast`):
///
///           forge script script/DeployHookBlocksRobinhoodCampaign3.s.sol:DeployHookBlocksRobinhoodCampaign3 \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com \
///             --sender <deployer-address>
contract DeployHookBlocksRobinhoodCampaign3 is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    // Live fee-stream stack shared with Campaign 2; this script only reads it.
    address internal constant FEE_SHARE_VAULT = 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant SPONSOR = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;

    // The hookless native-ETH/HOOKR pool on the canonical v4 PoolManager.
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint24 internal constant POOL_FEE = 2_500;
    int24 internal constant POOL_TICK_SPACING = 25;
    bytes32 internal constant POOL_ID = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;
    uint256 internal constant POOLS_SLOT = 6;

    error WrongChain(uint256 actual);
    error StartTooSoon(uint256 startAt, uint256 blockTime);
    error StartTooFar(uint256 startAt, uint256 blockTime);
    error VaultNotActivated();
    error VaultRewardAssetMismatch();
    error SponsorCannotFund(uint256 balance, uint256 required);
    error PoolIdDerivationMismatch(bytes32 expected, bytes32 actual);
    error PoolNotInitialized();
    error DeployedIdentityMismatch();

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (Campaign3Terms.END_AT - Campaign3Terms.START_AT != Campaign3Terms.DURATION_SECONDS) {
            revert DeployedIdentityMismatch();
        }
        if (Campaign3Terms.CLAIM_DEADLINE != Campaign3Terms.END_AT + Campaign3Terms.SWEEP_TAIL) {
            revert DeployedIdentityMismatch();
        }
        if (Campaign3Terms.SWEEP_AFTER != Campaign3Terms.END_AT + Campaign3Terms.SWEEP_TAIL) {
            revert DeployedIdentityMismatch();
        }
        if (Campaign3Terms.START_AT < block.timestamp + Campaign3Terms.MIN_FUNDING_LEAD) {
            revert StartTooSoon(Campaign3Terms.START_AT, block.timestamp);
        }
        if (Campaign3Terms.START_AT > block.timestamp + 30 days) {
            revert StartTooFar(Campaign3Terms.START_AT, block.timestamp);
        }

        // ---------------------------------------------------------- preflight
        IVaultPreflight vault = IVaultPreflight(FEE_SHARE_VAULT);
        if (!vault.activated()) revert VaultNotActivated();
        if (vault.rewardAssetCount() != 1 || vault.rewardAssets(0) != AEWETH) {
            revert VaultRewardAssetMismatch();
        }
        uint256 sponsorShares = vault.balanceOf(SPONSOR);
        uint256 requiredShares = Campaign3Terms.STAKER_FEE_SHARES + Campaign3Terms.HOOK_BLOCKS_FEE_SHARES;
        if (sponsorShares < requiredShares) revert SponsorCannotFund(sponsorShares, requiredShares);

        bytes32 derivedPoolId = keccak256(abi.encode(address(0), HOOKR, POOL_FEE, POOL_TICK_SPACING, address(0)));
        if (derivedPoolId != POOL_ID) revert PoolIdDerivationMismatch(POOL_ID, derivedPoolId);
        bytes32 slot0 = IPoolManagerPreflight(POOL_MANAGER).extsload(keccak256(abi.encode(POOL_ID, POOLS_SLOT)));
        uint160 sqrtPriceX96 = uint160(uint256(slot0));
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        console2.log("== HookBlocks campaign 3 read-only preflight ==");
        console2.log("chain id:", block.chainid);
        console2.log("sponsor vault shares:", sponsorShares);
        console2.log("required shares for both legs:", requiredShares);
        console2.log("pool sqrtPriceX96:", sqrtPriceX96);
        console2.log("startAt:", Campaign3Terms.START_AT);
        console2.log("endAt:", Campaign3Terms.END_AT);
        console2.log("sweepAfter:", Campaign3Terms.SWEEP_AFTER);

        // ------------------------------------------------------------- deploy
        vm.startBroadcast();
        HookBlocks hookBlocks = new HookBlocks(
            FEE_SHARE_VAULT,
            AEWETH,
            HOOKR,
            POOL_MANAGER,
            POOL_FEE,
            POOL_TICK_SPACING,
            POOL_ID,
            SPONSOR,
            Campaign3Terms.START_AT,
            Campaign3Terms.END_AT,
            Campaign3Terms.SWEEP_AFTER,
            Campaign3Terms.MIN_OUT_BPS,
            Campaign3Terms.MAX_BUY_WEI,
            Campaign3Terms.MIN_BUY_WEI
        );
        vm.stopBroadcast();

        // ----------------------------------------------------------- readback
        if (
            hookBlocks.FEE_SHARES() != FEE_SHARE_VAULT || hookBlocks.WETH() != AEWETH || hookBlocks.HOOKR() != HOOKR
                || address(hookBlocks.POOL_MANAGER()) != POOL_MANAGER || hookBlocks.POOL_ID() != POOL_ID
                || hookBlocks.SPONSOR() != SPONSOR || hookBlocks.START_AT() != Campaign3Terms.START_AT
                || hookBlocks.END_AT() != Campaign3Terms.END_AT
                || hookBlocks.SWEEP_AFTER() != Campaign3Terms.SWEEP_AFTER
                || hookBlocks.MIN_OUT_BPS() != Campaign3Terms.MIN_OUT_BPS
                || hookBlocks.MAX_BUY_WEI() != Campaign3Terms.MAX_BUY_WEI
                || hookBlocks.MIN_BUY_WEI() != Campaign3Terms.MIN_BUY_WEI
        ) revert DeployedIdentityMismatch();

        console2.log("== HookBlocks campaign 3 prepared ==");
        console2.log("address:", address(hookBlocks));
        console2.log("runtime code hash:");
        console2.logBytes32(keccak256(address(hookBlocks).code));
        console2.log("Funding is a separate sponsor-authorized step; no funding is performed by this script.");
    }
}
