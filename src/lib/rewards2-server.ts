import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";

import { FEE_REWARDS_MANIFEST, feeRewardsCampaignAbi, feeRewardsVaultAbi } from "@/lib/rewards";
import { rewardsClient } from "@/lib/rewards-server";
import { FEE_REWARDS_2_MANIFEST, feeRewards2Deployment, hookBlocksAbi } from "@/lib/rewards2";

/** v4-core `StateLibrary.POOLS_SLOT`: slot0 lives at keccak(poolId, 6). */
const POOLS_SLOT = 6n;
const E18 = 10n ** 18n;

const feeLockerAbi = parseAbi([
  "function availableFees(address feeOwner, address token) view returns (uint256)",
]);

const extsloadAbi = parseAbi([
  "function extsload(bytes32 slot) external view returns (bytes32)",
]);

export type Campaign2Check = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type Campaign2Preflight = {
  headBlock: string;
  blockHash: Hex;
  blockTimestamp: string;
  readAt: string;
  deployment: "absent" | "partial" | "configured";
  checks: Campaign2Check[];
  figures: {
    sponsorShares: string;
    pendingLockerWeth: string;
    sqrtPriceX96: string;
    hookrPerEthMilli: string;
  };
  live: null | {
    hookBlocks: {
      address: string;
      feeSharesFunded: boolean;
      bondingPaused: boolean;
      finalized: boolean;
      feeSharePrincipal: string;
      totalEthBonded: string;
      totalHookrBonded: string;
      blockCount: string;
      bondableWeth: string;
    };
    campaign: {
      address: string;
      feeSharesFunded: boolean;
      finalized: boolean;
      totalStaked: string;
      startAt: string;
      endAt: string;
      claimDeadline: string;
    };
  };
};

function formatWholeAndMilli(value: bigint): string {
  // hookrPerEth to three decimals without floating point: milli-units.
  return ((value * 1_000n) / E18).toString();
}

type Campaign2Deployment = {
  campaign: {
    address: `0x${string}`;
    runtimeCodeHash: Hex;
    startAt: bigint;
    endAt: bigint;
    claimDeadline: bigint;
  };
  hookBlocks: { address: `0x${string}`; runtimeCodeHash: Hex };
};

/**
 * One block-pinned, all-or-nothing preflight snapshot for the campaign-2
 * operator surface. Every figure is read at the same block; any failed read
 * throws so the route reports UNAVAILABLE rather than a zero that reads
 * like an answer. Pre-deploy it proves the runbook preconditions; once the
 * manifest carries the released addresses it also verifies their runtime
 * hashes and reads both legs' live state at the pinned block.
 *
 * `manifestOverride` exists for tests only: the release path must flow
 * through the real `FEE_REWARDS_2_MANIFEST` source change.
 */
export async function fetchCampaign2Preflight(
  manifestOverride?: typeof FEE_REWARDS_2_MANIFEST | (Omit<typeof FEE_REWARDS_2_MANIFEST, "deployment"> & { deployment: unknown }),
): Promise<Campaign2Preflight> {
  const manifest = (manifestOverride ?? FEE_REWARDS_2_MANIFEST) as typeof FEE_REWARDS_2_MANIFEST;
  const deployment = feeRewards2Deployment(manifest);
  const client = rewardsClient();

  const block = await client.getBlock();
  const blockNumber = block.number;

  const slot0Slot = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [manifest.hookrPool.poolId, POOLS_SLOT],
    ),
  );

  const [campaign1Finalized, vaultActivated, sponsorShares, pendingLockerWeth, slot0Word] =
    await Promise.all([
      client.readContract({
        address: FEE_REWARDS_MANIFEST.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: "finalized",
        blockNumber,
      }),
      client.readContract({
        address: manifest.vault.address,
        abi: feeRewardsVaultAbi,
        functionName: "activated",
        blockNumber,
      }),
      client.readContract({
        address: manifest.vault.address,
        abi: feeRewardsVaultAbi,
        functionName: "balanceOf",
        args: [manifest.sponsor],
        blockNumber,
      }),
      client.readContract({
        address: FEE_REWARDS_MANIFEST.source.feeLocker,
        abi: feeLockerAbi,
        functionName: "availableFees",
        args: [manifest.vault.address, manifest.weth],
        blockNumber,
      }),
      client.readContract({
        address: manifest.hookrPool.poolManager,
        abi: extsloadAbi,
        functionName: "extsload",
        args: [slot0Slot],
        blockNumber,
      }),
    ]);

  const sqrtPriceX96 = BigInt(slot0Word) & ((1n << 160n) - 1n);
  const poolInitialized = sqrtPriceX96 !== 0n;
  // priceX96 = sqrtP^2 / 2^96; HOOKR per ETH = priceX96 / 2^96.
  const hookrPerEth = poolInitialized
    ? (((sqrtPriceX96 * sqrtPriceX96) >> 96n) * E18) >> 96n
    : 0n;

  const checks: Campaign2Check[] = [
    {
      id: "campaign-1-finalized",
      label: "Campaign 1 finalized",
      ok: campaign1Finalized,
      detail: campaign1Finalized
        ? "Settlement returned its 50 shares to the sponsor."
        : "finalize() has not been called on campaign 1 yet.",
    },
    {
      id: "vault-activated",
      label: "Fee vault activated",
      ok: vaultActivated,
      detail: vaultActivated
        ? "The vault holds the fee position and pays aeWETH."
        : "The vault reports inactive; nothing can accrue.",
    },
    {
      id: "pool-initialized",
      label: "HOOKR pool initialized",
      ok: poolInitialized,
      detail: poolInitialized
        ? "slot0 carries a live price for the pinned pool."
        : "The pinned pool reports no price; bonds would fail closed.",
    },
  ];

  let live: Campaign2Preflight["live"] = null;

  if (deployment === "absent") {
    const fundable = sponsorShares >= manifest.vault.totalShares;
    checks.push({
      id: "sponsor-can-fund",
      label: "Sponsor holds all 100 shares",
      ok: fundable,
      detail: fundable
        ? "Both 50-share allocations are fundable today."
        : "The sponsor cannot fund 50 + 50 shares from its current balance.",
    });
  }

  if (deployment === "configured") {
    // The manifest's shape is documented but typed loosely until release;
    // narrow it here so a malformed release fails this read, not the UI.
    const released = manifest.deployment as unknown as Campaign2Deployment;

    const [campaignCode, hookBlocksCode] = await Promise.all([
      client.getBytecode({ address: released.campaign.address, blockNumber }),
      client.getBytecode({ address: released.hookBlocks.address, blockNumber }),
    ]);
    const campaignHashOk =
      !!campaignCode && keccak256(campaignCode).toLowerCase() === released.campaign.runtimeCodeHash.toLowerCase();
    const hookBlocksHashOk =
      !!hookBlocksCode &&
      keccak256(hookBlocksCode).toLowerCase() === released.hookBlocks.runtimeCodeHash.toLowerCase();
    checks.push({
      id: "runtime-hashes-verified",
      label: "Runtime hashes match the release",
      ok: campaignHashOk && hookBlocksHashOk,
      detail:
        campaignHashOk && hookBlocksHashOk
          ? "Both campaign-2 contracts match their pinned hashes at this block."
          : "Deployed bytecode does not match the reviewed release. Do not operate.",
    });

    const [
      hbFunded,
      hbPaused,
      hbFinalized,
      hbPrincipal,
      hbTotalEth,
      hbTotalHookr,
      hbBlockCount,
      hbBondable,
      cFunded,
      cFinalized,
      cTotalStaked,
    ] = await Promise.all([
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "feeSharesFunded", blockNumber }),
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "bondingPaused", blockNumber }),
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "finalized", blockNumber }),
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "feeSharePrincipal", blockNumber }),
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "totalEthBonded", blockNumber }),
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "totalHookrBonded", blockNumber }),
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "blockCount", blockNumber }),
      client.readContract({ address: released.hookBlocks.address, abi: hookBlocksAbi, functionName: "bondableWeth", blockNumber }),
      client.readContract({ address: released.campaign.address, abi: feeRewardsCampaignAbi, functionName: "feeSharesFunded", blockNumber }),
      client.readContract({ address: released.campaign.address, abi: feeRewardsCampaignAbi, functionName: "finalized", blockNumber }),
      client.readContract({ address: released.campaign.address, abi: feeRewardsCampaignAbi, functionName: "totalStaked", blockNumber }),
    ]);

    checks.push({
      id: "both-legs-funded",
      label: "Both legs funded 50 + 50",
      ok:
        hbFunded &&
        cFunded &&
        hbPrincipal === manifest.terms.hookBlocksFeeShares,
      detail:
        hbFunded && cFunded
          ? "All 100 shares are working for the window."
          : "One or both legs still await their exact 50-share funding.",
    });

    live = {
      hookBlocks: {
        address: released.hookBlocks.address,
        feeSharesFunded: hbFunded,
        bondingPaused: hbPaused,
        finalized: hbFinalized,
        feeSharePrincipal: hbPrincipal.toString(),
        totalEthBonded: hbTotalEth.toString(),
        totalHookrBonded: hbTotalHookr.toString(),
        blockCount: hbBlockCount.toString(),
        bondableWeth: hbBondable.toString(),
      },
      campaign: {
        address: released.campaign.address,
        feeSharesFunded: cFunded,
        finalized: cFinalized,
        totalStaked: cTotalStaked.toString(),
        startAt: released.campaign.startAt.toString(),
        endAt: released.campaign.endAt.toString(),
        claimDeadline: released.campaign.claimDeadline.toString(),
      },
    };
  }

  return {
    headBlock: blockNumber.toString(),
    blockHash: block.hash,
    blockTimestamp: block.timestamp.toString(),
    readAt: new Date().toISOString(),
    deployment,
    checks,
    figures: {
      sponsorShares: sponsorShares.toString(),
      pendingLockerWeth: pendingLockerWeth.toString(),
      sqrtPriceX96: sqrtPriceX96.toString(),
      hookrPerEthMilli: formatWholeAndMilli(hookrPerEth),
    },
    live,
  };
}
