import type { Address, Hex } from "viem";

/**
 * Event shapes for enumerating campaign stakers from chain logs. These mirror
 * the entries in feeRewardsCampaignAbi exactly; they exist as literal objects
 * because getLogs takes a single event, not a full contract ABI.
 */
export const stakedEvent = {
  type: "event",
  name: "Staked",
  inputs: [
    { indexed: true, name: "account", type: "address" },
    { indexed: false, name: "requestedAmount", type: "uint256" },
    { indexed: false, name: "creditedAmount", type: "uint256" },
  ],
} as const;

export const rewardPaidEvent = {
  type: "event",
  name: "RewardPaid",
  inputs: [
    { indexed: true, name: "caller", type: "address" },
    { indexed: true, name: "account", type: "address" },
    { indexed: true, name: "asset", type: "address" },
    { indexed: false, name: "amount", type: "uint256" },
  ],
} as const;

/**
 * Hard bound on how many distinct staking addresses one snapshot will read.
 * The list promises completeness — its accounting invariant only proves
 * anything if every enumerated account was actually read — so past this bound
 * the snapshot fails closed instead of silently sampling.
 */
export const STAKER_ENUMERATION_LIMIT = 750;

/** Rows actually published in one payload; the counts still cover everyone. */
export const STAKER_LIST_LIMIT = 200;

export type FeeRewardsStakerRow = {
  account: Address;
  stakedBalance: string;
  rewardWeight: string;
  earnedWeth: string;
  claimedWeth: string;
};

export type FeeRewardsStakersPayload = {
  headBlock: string;
  blockHash: Hex;
  blockTimestamp: string;
  readAt: string;
  campaignCodeHash: Hex;
  totalStaked: string;
  totalRewardWeight: string;
  activeStakerCount: number;
  allTimeStakerCount: number;
  totalEarnedWeth: string;
  totalClaimedWeth: string;
  rewardPool: {
    /** WETH already vested across every staker's current `earned(...)` balance. */
    claimableNowWeth: string;
    /** WETH physically held by the campaign, including vested and still-streaming rewards. */
    campaignHeldWeth: string;
    /** Campaign-held WETH that has not vested to stakers yet. */
    stillAccruingWeth: string;
    /** WETH assigned to the campaign's fee shares but not harvested into it yet. */
    awaitingHarvestWeth: string;
    /** Campaign-held plus vault-claimable WETH; excludes rewards already claimed. */
    totalAllocatedWeth: string;
  };
  truncated: boolean;
  stakers: FeeRewardsStakerRow[];
};

export type StakerAccountState = {
  account: Address;
  stakedBalance: bigint;
  rewardWeight: bigint;
  earnedWeth: bigint;
};

/**
 * Thrown when the enumerated accounts do not reconcile against the campaign's
 * own totals at the same block. Stake only moves through stake and withdraw,
 * and rewards only pay to prior stakers, so a mismatch proves the log scan is
 * incomplete — the one failure mode a "complete list" must never render.
 */
export class StakerAccountingMismatchError extends Error {
  constructor(detail: string) {
    super(`The staker enumeration does not reconcile with campaign state: ${detail}`);
    this.name = "StakerAccountingMismatchError";
  }
}

/** First-seen order, deduplicated case-insensitively. */
export function uniqueStakerAccounts(accounts: readonly Address[]): Address[] {
  const seen = new Set<string>();
  const unique: Address[] = [];
  for (const account of accounts) {
    const key = account.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(account);
  }
  return unique;
}

/** Lifetime WETH paid out per account, keyed by lowercase address. */
export function sumClaimedByAccount(
  claims: readonly { account: Address; asset: Address; amount: bigint }[],
  rewardAsset: Address,
): Map<string, bigint> {
  const asset = rewardAsset.toLowerCase();
  const byAccount = new Map<string, bigint>();
  for (const claim of claims) {
    if (claim.asset.toLowerCase() !== asset) continue;
    const key = claim.account.toLowerCase();
    byAccount.set(key, (byAccount.get(key) ?? 0n) + claim.amount);
  }
  return byAccount;
}

/**
 * Percentage of `total` held by `part`, to two decimals. Null when there is
 * no total to divide by, so the UI can stay silent rather than render a zero
 * that reads like an answer.
 */
export function shareOfTotal(part: bigint, total: bigint): number | null {
  if (part < 0n || total <= 0n) return null;
  return Number((part * 10_000n) / total) / 100;
}

export type BuiltStakerList = {
  rows: FeeRewardsStakerRow[];
  activeStakerCount: number;
  allTimeStakerCount: number;
  totalEarnedWeth: bigint;
  totalClaimedWeth: bigint;
  truncated: boolean;
};

/**
 * Assemble the published list from per-account reads and claim history, all
 * pinned to one block.
 *
 * Verifies completeness before returning anything: enumerated balances must
 * sum exactly to the campaign's totalStaked, and every account that was ever
 * paid rewards must be in the enumerated set. Rows sort by staked principal,
 * then lifetime rewards, then address, so the order is deterministic across
 * snapshots of the same block.
 */
export function buildStakerRows(
  states: readonly StakerAccountState[],
  claimedByAccount: ReadonlyMap<string, bigint>,
  totalStaked: bigint,
  limit: number = STAKER_LIST_LIMIT,
): BuiltStakerList {
  const enumerated = new Set(states.map((state) => state.account.toLowerCase()));
  for (const claimant of claimedByAccount.keys()) {
    if (!enumerated.has(claimant)) {
      throw new StakerAccountingMismatchError(
        "an account with paid rewards is missing from the staker enumeration.",
      );
    }
  }

  let balanceSum = 0n;
  let totalEarnedWeth = 0n;
  for (const state of states) {
    balanceSum += state.stakedBalance;
    totalEarnedWeth += state.earnedWeth;
  }
  if (balanceSum !== totalStaked) {
    throw new StakerAccountingMismatchError(
      "enumerated balances do not sum to the campaign's total staked.",
    );
  }
  let totalClaimedWeth = 0n;
  for (const amount of claimedByAccount.values()) totalClaimedWeth += amount;

  const withClaims = states.map((state) => ({
    ...state,
    claimedWeth: claimedByAccount.get(state.account.toLowerCase()) ?? 0n,
  }));
  const relevant = withClaims.filter(
    (state) => state.stakedBalance > 0n || state.earnedWeth > 0n || state.claimedWeth > 0n,
  );
  relevant.sort((left, right) => {
    if (left.stakedBalance !== right.stakedBalance) {
      return left.stakedBalance > right.stakedBalance ? -1 : 1;
    }
    const leftRewards = left.earnedWeth + left.claimedWeth;
    const rightRewards = right.earnedWeth + right.claimedWeth;
    if (leftRewards !== rightRewards) return leftRewards > rightRewards ? -1 : 1;
    return left.account.toLowerCase() < right.account.toLowerCase() ? -1 : 1;
  });

  const rows = relevant.slice(0, limit).map((state): FeeRewardsStakerRow => ({
    account: state.account,
    stakedBalance: state.stakedBalance.toString(),
    rewardWeight: state.rewardWeight.toString(),
    earnedWeth: state.earnedWeth.toString(),
    claimedWeth: state.claimedWeth.toString(),
  }));

  return {
    rows,
    activeStakerCount: withClaims.filter((state) => state.stakedBalance > 0n).length,
    allTimeStakerCount: states.length,
    totalEarnedWeth,
    totalClaimedWeth,
    truncated: relevant.length > rows.length,
  };
}
