import { keccak256 } from "viem";
import { unstable_cache } from "next/cache";

import { FEE_REWARDS_MANIFEST, feeRewardsCampaignAbi } from "@/lib/rewards";
import {
  STAKER_ENUMERATION_LIMIT,
  buildStakerRows,
  rewardPaidEvent,
  stakedEvent,
  sumClaimedByAccount,
  uniqueStakerAccounts,
  type FeeRewardsStakersPayload,
  type StakerAccountState,
} from "@/lib/rewards-stakers";
import { rewardsClient } from "@/lib/rewards-server";

/**
 * The staker list gates no transaction, so it tolerates more age than the
 * campaign snapshot — but a cached list must still never outlive its own
 * refresh loop and masquerade as a current read.
 */
const MAX_STAKERS_SNAPSHOT_AGE_MS = 120_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;

export class StaleStakersSnapshotError extends Error {
  constructor() {
    super("The shared staker-list snapshot is too old to use safely.");
    this.name = "StaleStakersSnapshotError";
  }
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Enumerate every account that ever staked and read its position at one
 * pinned block. All-or-nothing like the campaign snapshot: runtime identity,
 * complete-log accounting invariants, and the canonical block hash recheck
 * all have to hold together, or the caller renders an explicit unavailable
 * state instead of a partial list.
 *
 * Exported uncached for focused safety tests and explicit release checks.
 */
export async function fetchFeeRewardsStakersUncached(): Promise<FeeRewardsStakersPayload> {
  const manifest = FEE_REWARDS_MANIFEST;
  const client = rewardsClient();

  const [chainId, head] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: "latest" }),
  ]);
  if (chainId !== manifest.chainId) {
    throw new Error("Rewards RPC returned the wrong chain.");
  }
  if (head.number === null || !head.hash) {
    throw new Error("Rewards RPC head is missing its canonical identity.");
  }
  if (head.number < manifest.campaign.deploymentBlock) {
    throw new Error("Rewards RPC head predates the reviewed release.");
  }
  const blockNumber = head.number;

  const [campaignCode, totalStaked, totalRewardWeight, stakedLogs, rewardPaidLogs] =
    await Promise.all([
      client.getBytecode({ address: manifest.campaign.address, blockNumber }),
      client.readContract({
        address: manifest.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: "totalStaked",
        blockNumber,
      }),
      client.readContract({
        address: manifest.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: "totalRewardWeight",
        blockNumber,
      }),
      client.getLogs({
        address: manifest.campaign.address,
        event: stakedEvent,
        fromBlock: manifest.campaign.deploymentBlock,
        toBlock: blockNumber,
        strict: true,
      }),
      client.getLogs({
        address: manifest.campaign.address,
        event: rewardPaidEvent,
        fromBlock: manifest.campaign.deploymentBlock,
        toBlock: blockNumber,
        strict: true,
      }),
    ]);

  if (!campaignCode) {
    throw new Error("The reviewed campaign contract has no runtime bytecode.");
  }
  const campaignCodeHash = keccak256(campaignCode);
  if (!sameHash(campaignCodeHash, manifest.campaign.runtimeCodeHash)) {
    throw new Error("Campaign runtime identity does not match the reviewed release.");
  }

  const accounts = uniqueStakerAccounts(stakedLogs.map((log) => log.args.account));
  if (accounts.length > STAKER_ENUMERATION_LIMIT) {
    throw new Error("The staker set exceeds this snapshot's complete-read bound.");
  }

  const states = await Promise.all(
    accounts.map(async (account): Promise<StakerAccountState> => {
      const [stakedBalance, rewardWeight, earnedWeth] = await Promise.all([
        client.readContract({
          address: manifest.campaign.address,
          abi: feeRewardsCampaignAbi,
          functionName: "balanceOf",
          args: [account],
          blockNumber,
        }),
        client.readContract({
          address: manifest.campaign.address,
          abi: feeRewardsCampaignAbi,
          functionName: "rewardWeight",
          args: [account],
          blockNumber,
        }),
        client.readContract({
          address: manifest.campaign.address,
          abi: feeRewardsCampaignAbi,
          functionName: "earned",
          args: [account, manifest.weth],
          blockNumber,
        }),
      ]);
      return { account, stakedBalance, rewardWeight, earnedWeth };
    }),
  );

  const claims = rewardPaidLogs.map((log) => ({
    account: log.args.account,
    asset: log.args.asset,
    amount: log.args.amount,
  }));
  const built = buildStakerRows(states, sumClaimedByAccount(claims, manifest.weth), totalStaked);

  const canonicalBlock = await client.getBlock({ blockNumber });
  if (!canonicalBlock.hash || !sameHash(canonicalBlock.hash, head.hash)) {
    throw new Error("The pinned Robinhood block changed during the staker-list read.");
  }

  return {
    headBlock: blockNumber.toString(),
    blockHash: head.hash,
    blockTimestamp: head.timestamp.toString(),
    readAt: new Date().toISOString(),
    campaignCodeHash,
    totalStaked: totalStaked.toString(),
    totalRewardWeight: totalRewardWeight.toString(),
    activeStakerCount: built.activeStakerCount,
    allTimeStakerCount: built.allTimeStakerCount,
    totalEarnedWeth: built.totalEarnedWeth.toString(),
    totalClaimedWeth: built.totalClaimedWeth.toString(),
    truncated: built.truncated,
    stakers: built.rows,
  };
}

const cachedStakers = unstable_cache(
  fetchFeeRewardsStakersUncached,
  [
    "0xzaps-fee-rewards-stakers-v1",
    // Same release binding as the campaign snapshot: a verifier change or a
    // manifest change must never reuse a previous release's cached list.
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() || "local",
    JSON.stringify(FEE_REWARDS_MANIFEST, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ],
  { revalidate: 30, tags: ["0xzaps-fee-rewards-stakers"] },
);

function assertStakersSnapshotFresh(snapshot: FeeRewardsStakersPayload, now = Date.now()): void {
  const readAt = Date.parse(snapshot.readAt);
  const age = now - readAt;
  if (
    !Number.isFinite(readAt)
    || age > MAX_STAKERS_SNAPSHOT_AGE_MS
    || age < -MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    throw new StaleStakersSnapshotError();
  }
}

/**
 * Per-instance in-flight coalescing, for the same reason as the campaign
 * snapshot: unstable_cache has no MISS coalescing and the key rotates every
 * deploy, and this fill fans out one RPC read per staker.
 */
let inflightStakers: Promise<FeeRewardsStakersPayload> | null = null;

function coalescedStakers(): Promise<FeeRewardsStakersPayload> {
  if (inflightStakers === null) {
    inflightStakers = cachedStakers().finally(() => {
      inflightStakers = null;
    });
  }
  return inflightStakers;
}

/** Production read path for the public staker list. */
export async function fetchFeeRewardsStakers(): Promise<FeeRewardsStakersPayload> {
  const snapshot = await coalescedStakers();
  assertStakersSnapshotFresh(snapshot);
  return snapshot;
}

export type { FeeRewardsStakersPayload };
