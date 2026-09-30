import { getAddress, type Address, type Hex } from "viem";

const E18 = 10n ** 18n;

export type Campaign3Deployment = {
  campaign: {
    address: Address;
    runtimeCodeHash: Hex;
    deploymentBlock: bigint;
    startAt: bigint;
    endAt: bigint;
    claimDeadline: bigint;
  };
  hookBlocks: {
    address: Address;
    runtimeCodeHash: Hex;
    deploymentBlock: bigint;
    startAt: bigint;
    endAt: bigint;
    sweepAfter: bigint;
  };
};

/**
 * Prepared, not-yet-deployed manifest for the October 2026 third fee
 * campaign. The date window is UTC and follows the explicit Oct 1–31 schedule
 * (31 days); the 50/50 allocation and per-leg buy controls match Campaign 2.
 * No RPC reads or wallet writes are enabled until both deployed addresses and
 * their runtime hashes are reviewed into `deployment`.
 */
export const FEE_REWARDS_3_MANIFEST = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  token: getAddress("0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  hookr: getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c"),
  vault: {
    address: getAddress("0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338"),
    runtimeCodeHash:
      "0x4d62bd109d8fed9a04c02343cf6357dbf6d6789ef5ed9940b11add836c3caac4" as Hex,
    totalShares: 100n * E18,
  },
  sponsor: getAddress("0x5a52D4B820Ae7F02880d270562950918ACb14aA2"),
  hookrPool: {
    poolManager: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
    poolId: "0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf" as Hex,
    fee: 2_500,
    tickSpacing: 25,
    currency0: "0x0000000000000000000000000000000000000000" as Address,
    currency1: getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c"),
    hooks: "0x0000000000000000000000000000000000000000" as Address,
  },
  schedule: {
    startAt: 1_790_812_800n,
    endAt: 1_793_491_200n,
    claimDeadline: 1_796_083_200n,
    sweepAfter: 1_796_083_200n,
  },
  terms: {
    durationSeconds: 31n * 86_400n,
    sweepTailSeconds: 30n * 86_400n,
    stakerFeeShares: 50n * E18,
    hookBlocksFeeShares: 50n * E18,
    minOutBps: 9_700,
    maxBuyWei: 50_000_000_000_000_000n,
    minBuyWei: 500_000_000_000_000n,
  },
  deployment: null as Campaign3Deployment | null,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonZeroAddress(value: unknown): value is Address {
  return (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    !/^0x0{40}$/i.test(value)
  );
}

function isNonZeroCodeHash(value: unknown): value is Hex {
  return (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(value) &&
    !/^0x0{64}$/i.test(value)
  );
}

function isPositiveBlock(value: unknown): value is bigint {
  return typeof value === "bigint" && value > 0n;
}

function isCampaignDeployment(value: unknown): value is Campaign3Deployment["campaign"] {
  if (!isRecord(value)) return false;
  return (
    isNonZeroAddress(value.address) &&
    isNonZeroCodeHash(value.runtimeCodeHash) &&
    isPositiveBlock(value.deploymentBlock) &&
    value.startAt === FEE_REWARDS_3_MANIFEST.schedule.startAt &&
    value.endAt === FEE_REWARDS_3_MANIFEST.schedule.endAt &&
    value.claimDeadline === FEE_REWARDS_3_MANIFEST.schedule.claimDeadline
  );
}

function isHookBlocksDeployment(value: unknown): value is Campaign3Deployment["hookBlocks"] {
  if (!isRecord(value)) return false;
  return (
    isNonZeroAddress(value.address) &&
    isNonZeroCodeHash(value.runtimeCodeHash) &&
    isPositiveBlock(value.deploymentBlock) &&
    value.startAt === FEE_REWARDS_3_MANIFEST.schedule.startAt &&
    value.endAt === FEE_REWARDS_3_MANIFEST.schedule.endAt &&
    value.sweepAfter === FEE_REWARDS_3_MANIFEST.schedule.sweepAfter
  );
}

/** Only report configured when both deployed legs have verified identities and the exact pinned schedule. */
export function feeRewards3Deployment(
  manifest: { deployment: unknown } = FEE_REWARDS_3_MANIFEST,
): "absent" | "partial" | "configured" {
  if (manifest.deployment === null) return "absent";
  if (!isRecord(manifest.deployment)) return "partial";

  const { campaign, hookBlocks } = manifest.deployment;
  if (campaign == null && hookBlocks == null) return "absent";
  if (
    isCampaignDeployment(campaign) &&
    isHookBlocksDeployment(hookBlocks) &&
    campaign.address.toLowerCase() !== hookBlocks.address.toLowerCase()
  ) {
    return "configured";
  }
  return "partial";
}
