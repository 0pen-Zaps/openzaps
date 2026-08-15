// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {HookBlocks} from "../src/campaign/HookBlocks.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface IVaultPreflight {
    function activated() external view returns (bool);
    function rewardAssetCount() external view returns (uint256);
    function rewardAssets(uint256 index) external view returns (address);
    function balanceOf(address account) external view returns (uint256);
}

interface IPoolManagerPreflight {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployHookBlocksRobinhood
/// @notice UNAUDITED. Deploys the HookBlocks bond leg of the second 0xZAPS
///         fee campaign on Robinhood Chain (4663): 50 of the vault's 100 fee
///         shares fund it, and its permissionless crank converts the WETH
///         they earn into $HOOKR through the live native-ETH/HOOKR pool,
///         bonding every bought token forever.
///
///         This script deploys ONE new contract and mutates nothing live: the
///         vault, locker wiring, campaign 1, and every OpenZaps lineage stay
///         untouched. Funding is a separate, sponsor-signed step described in
///         docs/staking-campaign-2-runbook.md, alongside the leg-A campaign
///         redeploy.
///
///         The 14-day window is anchored by CAMPAIGN2_START_AT (unix seconds,
///         required env) so both legs share one schedule:
///           endAt        = startAt + 14 days
///           sweepAfter   = endAt + 30 days
///
///         Rehearse without `--broadcast` first:
///
///           CAMPAIGN2_START_AT=<unix> \
///           forge script script/DeployHookBlocksRobinhood.s.sol:DeployHookBlocksRobinhood \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com \
///             --sender <deployer-address>
///
///         Broadcast with a Forge signer (`--account`, hardware wallet, or
///         external signer). No key material is read by this script:
///
///           CAMPAIGN2_START_AT=<unix> \
///           forge script script/DeployHookBlocksRobinhood.s.sol:DeployHookBlocksRobinhood \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com \
///             --account <keystore-name> --sender <deployer-address> --broadcast --slow
contract DeployHookBlocksRobinhood is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    // Live campaign-1 stack this leg composes with (never mutates).
    address internal constant FEE_SHARE_VAULT = 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant SPONSOR = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;

    // The live HOOKR market: hookless native-ETH/HOOKR pool on the canonical
    // v4 PoolManager, verified by hashing the key back to its poolId.
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint24 internal constant POOL_FEE = 2500;
    int24 internal constant POOL_TICK_SPACING = 25;
    bytes32 internal constant POOL_ID = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;
    /// @dev v4-core `StateLibrary.POOLS_SLOT`.
    uint256 internal constant POOLS_SLOT = 6;

    // Campaign-2 terms. The window is the product ask; the bond bounds are
    // sized in docs/staking-campaign-2-hook-blocks.md.
    uint64 internal constant CAMPAIGN_DURATION = 14 days;
    uint64 internal constant SWEEP_TAIL = 30 days;
    uint16 internal constant MIN_OUT_BPS = 9_700;
    uint256 internal constant MAX_BOND_WEI = 0.05 ether;
    uint256 internal constant MIN_BOND_WEI = 0.0005 ether;
    uint256 internal constant FEE_SHARE_ALLOCATION = 50e18;

    error WrongChain(uint256 actual);
    error StartTooSoon(uint256 startAt, uint256 blockTime);
    error StartTooFar(uint256 startAt, uint256 blockTime);
    error VaultNotActivated();
    error VaultRewardAssetMismatch();
    error SponsorCannotFund(uint256 balance);
    error PoolIdDerivationMismatch(bytes32 expected, bytes32 actual);
    error PoolNotInitialized();
    error DeployedIdentityMismatch();

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 startAt = vm.envUint("CAMPAIGN2_START_AT");
        // At least an hour of funding room, at most a month out: a start in
        // the past bricks the constructor, a typo'd far future strands the
        // shares against a window nobody intended.
        if (startAt < block.timestamp + 1 hours) revert StartTooSoon(startAt, block.timestamp);
        if (startAt > block.timestamp + 30 days) revert StartTooFar(startAt, block.timestamp);
        uint64 endAt = uint64(startAt) + CAMPAIGN_DURATION;
        uint64 sweepAfter = endAt + SWEEP_TAIL;

        // ---------------------------------------------------------- preflight
        IVaultPreflight vault = IVaultPreflight(FEE_SHARE_VAULT);
        if (!vault.activated()) revert VaultNotActivated();
        if (vault.rewardAssetCount() != 1 || vault.rewardAssets(0) != AEWETH) {
            revert VaultRewardAssetMismatch();
        }
        uint256 sponsorShares = vault.balanceOf(SPONSOR);
        if (sponsorShares < FEE_SHARE_ALLOCATION) revert SponsorCannotFund(sponsorShares);

        bytes32 derivedPoolId = keccak256(abi.encode(address(0), HOOKR, POOL_FEE, POOL_TICK_SPACING, address(0)));
        if (derivedPoolId != POOL_ID) revert PoolIdDerivationMismatch(POOL_ID, derivedPoolId);
        bytes32 slot0 = IPoolManagerPreflight(POOL_MANAGER).extsload(keccak256(abi.encode(POOL_ID, POOLS_SLOT)));
        uint160 sqrtPriceX96 = uint160(uint256(slot0));
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        console2.log("== HookBlocks deploy preflight ==");
        console2.log("chain id:", block.chainid);
        console2.log("sponsor vault shares:", sponsorShares);
        console2.log("pool sqrtPriceX96:", sqrtPriceX96);
        console2.log("startAt:", startAt);
        console2.log("endAt:", endAt);
        console2.log("sweepAfter:", sweepAfter);

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
            uint64(startAt),
            endAt,
            sweepAfter,
            MIN_OUT_BPS,
            MAX_BOND_WEI,
            MIN_BOND_WEI
        );
        vm.stopBroadcast();

        // ----------------------------------------------------------- readback
        if (
            hookBlocks.FEE_SHARES() != FEE_SHARE_VAULT || hookBlocks.WETH() != AEWETH || hookBlocks.HOOKR() != HOOKR
                || address(hookBlocks.POOL_MANAGER()) != POOL_MANAGER || hookBlocks.POOL_ID() != POOL_ID
                || hookBlocks.SPONSOR() != SPONSOR || hookBlocks.START_AT() != uint64(startAt)
                || hookBlocks.END_AT() != endAt || hookBlocks.SWEEP_AFTER() != sweepAfter
                || hookBlocks.MIN_OUT_BPS() != MIN_OUT_BPS || hookBlocks.MAX_BOND_WEI() != MAX_BOND_WEI
                || hookBlocks.MIN_BOND_WEI() != MIN_BOND_WEI
        ) revert DeployedIdentityMismatch();

        console2.log("== HookBlocks deployed ==");
        console2.log("address:", address(hookBlocks));
        console2.log("runtime code hash:");
        console2.logBytes32(keccak256(address(hookBlocks).code));
        console2.log("fund with vault.approve(hookBlocks, 50e18) then");
        console2.log("hookBlocks.fundFeeShares(50e18) from the sponsor, before startAt.");
    }
}
