import {
  createPublicClient,
  getAddress,
  hashDomain,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { unstable_cache } from "next/cache";

import {
  FEE_REWARDS_MANIFEST,
  campaignPhase,
  feeRewardsAdapterAbi,
  feeRewardsCampaignAbi,
  feeRewardsVaultAbi,
  permitTokenAbi,
  type FeeRewardsPayload,
} from "@/lib/rewards";
import {
  ROBINHOOD_RPC_URL as PUBLIC_ROBINHOOD_RPC_URL,
  robinhoodChain,
} from "@/lib/robinhood";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const MAX_SHARED_SNAPSHOT_AGE_MS = 30_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;

export class StaleRewardsSnapshotError extends Error {
  constructor() {
    super("The shared rewards snapshot is too old to use safely.");
    this.name = "StaleRewardsSnapshotError";
  }
}

const EIP712_DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHash(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function rewardsRpcUrl(): string {
  const candidate = process.env.ROBINHOOD_RPC_URL?.trim() || PUBLIC_ROBINHOOD_RPC_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Robinhood rewards RPC configuration is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Robinhood rewards RPC configuration is invalid.");
  }
  return parsed.toString();
}

function rewardsClient() {
  return createPublicClient({
    chain: robinhoodChain,
    // Every snapshot is block-pinned and all-or-nothing, but most of its reads
    // are independent. Robinhood's canonical RPC supports JSON-RPC batching,
    // so one logical snapshot should not become dozens of HTTP requests.
    transport: http(rewardsRpcUrl(), {
      batch: { batchSize: 50, wait: 0 },
      retryCount: 2,
      timeout: 15_000,
    }),
  });
}

async function readViewer(
  client: ReturnType<typeof rewardsClient>,
  viewer: Address,
  blockNumber: bigint,
): Promise<NonNullable<FeeRewardsPayload["viewer"]>> {
  const manifest = FEE_REWARDS_MANIFEST;
  const [
    tokenBalance,
    allowance,
    stakedBalance,
    rewardWeight,
    earnedWeth,
    feeShareBalance,
    directVaultClaimableWeth,
    wethBalance,
    permitNonce,
  ] = await Promise.all([
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "balanceOf",
      args: [viewer],
      blockNumber,
    }),
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "allowance",
      args: [viewer, manifest.campaign.address],
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "balanceOf",
      args: [viewer],
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "rewardWeight",
      args: [viewer],
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "earned",
      args: [viewer, manifest.weth],
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "balanceOf",
      args: [viewer],
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "claimable",
      args: [viewer, manifest.weth],
      blockNumber,
    }),
    client.readContract({
      address: manifest.weth,
      abi: permitTokenAbi,
      functionName: "balanceOf",
      args: [viewer],
      blockNumber,
    }),
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "nonces",
      args: [viewer],
      blockNumber,
    }),
  ]);

  return {
    account: viewer,
    tokenBalance: tokenBalance.toString(),
    allowance: allowance.toString(),
    stakedBalance: stakedBalance.toString(),
    rewardWeight: rewardWeight.toString(),
    earnedWeth: earnedWeth.toString(),
    feeShareBalance: feeShareBalance.toString(),
    directVaultClaimableWeth: directVaultClaimableWeth.toString(),
    wethBalance: wethBalance.toString(),
    permitNonce: permitNonce.toString(),
  };
}

/**
 * Read the complete public campaign at one block. No partial payload is
 * returned: runtime identity, immutable bindings, current state, permit
 * identity, and the final canonical hash recheck all have to succeed together.
 */
async function fetchPublicFeeRewardsUncached(): Promise<FeeRewardsPayload> {
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

  const [
    adapterCode,
    vaultCode,
    campaignCode,
    adapterLocker,
    adapterFeeLocker,
    sourcePositionConfigured,
    vaultFeeSource,
    vaultActivated,
    vaultToken,
    vaultAdminIndex,
    vaultInitialRecipient,
    vaultRewardAssetCount,
    vaultRewardAsset,
    vaultTotalShares,
    vaultTotalSupply,
    sponsorFeeShareBalance,
    sponsorClaimableWeth,
    vaultAccountedRewardBalance,
    vaultQueuedRewards,
    campaignStakingToken,
    campaignFeeShareToken,
    campaignRewardAssetCount,
    campaignRewardAsset,
    campaignStartAt,
    campaignEndAt,
    campaignClaimDeadline,
    feeSharesFunded,
    finalized,
    rewardsSwept,
    feeSharePrincipal,
    campaignSponsor,
    totalStaked,
    totalRewardWeight,
    rewardState,
    lastUpdateAt,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    permitDomain,
    domainSeparator,
  ] = await Promise.all([
    client.getBytecode({ address: manifest.adapter.address, blockNumber }),
    client.getBytecode({ address: manifest.vault.address, blockNumber }),
    client.getBytecode({ address: manifest.campaign.address, blockNumber }),
    client.readContract({
      address: manifest.adapter.address,
      abi: feeRewardsAdapterAbi,
      functionName: "LP_LOCKER_FEE_CONVERSION",
      blockNumber,
    }),
    client.readContract({
      address: manifest.adapter.address,
      abi: feeRewardsAdapterAbi,
      functionName: "FEE_LOCKER",
      blockNumber,
    }),
    client.readContract({
      address: manifest.adapter.address,
      abi: feeRewardsAdapterAbi,
      functionName: "isPositionConfigured",
      args: [manifest.token, manifest.source.adminIndex, manifest.vault.address, [manifest.weth]],
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "FEE_SOURCE",
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
      functionName: "clankerToken",
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "adminIndex",
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "initialShareRecipient",
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "rewardAssetCount",
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "rewardAssets",
      args: [0n],
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "TOTAL_SHARES",
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "totalSupply",
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "balanceOf",
      args: [manifest.campaign.sponsor],
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "claimable",
      args: [manifest.campaign.sponsor, manifest.weth],
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "accountedRewardBalance",
      args: [manifest.weth],
      blockNumber,
    }),
    client.readContract({
      address: manifest.vault.address,
      abi: feeRewardsVaultAbi,
      functionName: "queuedRewards",
      args: [manifest.weth],
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "STAKING_TOKEN",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "FEE_SHARE_TOKEN",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "rewardAssetCount",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "rewardAssets",
      args: [0n],
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "startAt",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "endAt",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "claimDeadline",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "feeSharesFunded",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "finalized",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "rewardsSwept",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "feeSharePrincipal",
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "sponsor",
      blockNumber,
    }),
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
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "rewardState",
      args: [manifest.weth],
      blockNumber,
    }),
    client.readContract({
      address: manifest.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: "lastUpdateAt",
      blockNumber,
    }),
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "name",
      blockNumber,
    }),
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "symbol",
      blockNumber,
    }),
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "decimals",
      blockNumber,
    }),
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "eip712Domain",
      blockNumber,
    }),
    client.readContract({
      address: manifest.token,
      abi: permitTokenAbi,
      functionName: "DOMAIN_SEPARATOR",
      blockNumber,
    }),
  ]);

  if (!adapterCode || !vaultCode || !campaignCode) {
    throw new Error("A reviewed rewards contract has no runtime bytecode.");
  }
  const adapterCodeHash = keccak256(adapterCode);
  const vaultCodeHash = keccak256(vaultCode);
  const campaignCodeHash = keccak256(campaignCode);
  if (
    !sameHash(adapterCodeHash, manifest.adapter.runtimeCodeHash) ||
    !sameHash(vaultCodeHash, manifest.vault.runtimeCodeHash) ||
    !sameHash(campaignCodeHash, manifest.campaign.runtimeCodeHash)
  ) {
    throw new Error("Rewards contract runtime identity does not match the reviewed release.");
  }

  const [domainFields, domainName, domainVersion, domainChainId, domainContract, domainSalt, domainExtensions] =
    permitDomain;
  const computedDomainSeparator = hashDomain({
    domain: {
      name: domainName,
      version: domainVersion,
      chainId: domainChainId,
      verifyingContract: domainContract,
    },
    types: EIP712_DOMAIN_TYPES,
  });
  if (
    tokenName !== manifest.permit.name ||
    tokenSymbol !== "0xZAPS" ||
    tokenDecimals !== 18 ||
    domainFields.toLowerCase() !== "0x0f" ||
    domainName !== manifest.permit.name ||
    domainVersion !== manifest.permit.version ||
    domainChainId !== BigInt(manifest.chainId) ||
    !sameAddress(domainContract, manifest.token) ||
    !sameHash(domainSalt, ZERO_HASH) ||
    domainExtensions.length !== 0 ||
    !sameHash(computedDomainSeparator, domainSeparator)
  ) {
    throw new Error("0xZAPS token or permit identity does not match the reviewed release.");
  }

  const [rewardRate, rewardPerTokenStored, campaignAccountedRewardBalance, campaignQueuedRewards] =
    rewardState;
  const expectedPrincipal = finalized ? 0n : manifest.campaign.feeShareAllocation;
  if (
    !sameAddress(adapterLocker, manifest.source.lpLockerFeeConversion) ||
    !sameAddress(adapterFeeLocker, manifest.source.feeLocker) ||
    !sourcePositionConfigured ||
    !sameAddress(vaultFeeSource, manifest.adapter.address) ||
    !vaultActivated ||
    !sameAddress(vaultToken, manifest.token) ||
    vaultAdminIndex !== manifest.source.adminIndex ||
    !sameAddress(vaultInitialRecipient, manifest.vault.initialShareRecipient) ||
    vaultRewardAssetCount !== 1n ||
    !sameAddress(vaultRewardAsset, manifest.weth) ||
    vaultTotalShares !== manifest.vault.totalShares ||
    vaultTotalSupply !== manifest.vault.totalShares ||
    !sameAddress(campaignStakingToken, manifest.token) ||
    !sameAddress(campaignFeeShareToken, manifest.vault.address) ||
    campaignRewardAssetCount !== 1n ||
    !sameAddress(campaignRewardAsset, manifest.weth) ||
    campaignStartAt !== manifest.campaign.startAt ||
    campaignEndAt !== manifest.campaign.endAt ||
    campaignClaimDeadline !== manifest.campaign.claimDeadline ||
    !sameAddress(campaignSponsor, manifest.campaign.sponsor) ||
    !feeSharesFunded ||
    feeSharePrincipal !== expectedPrincipal ||
    (rewardsSwept && !finalized) ||
    totalRewardWeight < totalStaked ||
    lastUpdateAt < manifest.campaign.startAt ||
    lastUpdateAt > manifest.campaign.endAt
  ) {
    throw new Error("Rewards immutable or current-state invariants do not match the reviewed release.");
  }

  const canonicalBlock = await client.getBlock({ blockNumber });
  if (!canonicalBlock.hash || !sameHash(canonicalBlock.hash, head.hash)) {
    throw new Error("The pinned Robinhood block changed during the rewards read.");
  }

  return {
    headBlock: blockNumber.toString(),
    blockHash: head.hash,
    blockTimestamp: head.timestamp.toString(),
    readAt: new Date().toISOString(),
    phase: campaignPhase(
      head.timestamp,
      feeSharesFunded,
      finalized,
      campaignStartAt,
      campaignEndAt,
      campaignClaimDeadline,
    ),
    verification: {
      adapterCodeHash,
      vaultCodeHash,
      campaignCodeHash,
      vaultActivated,
      sourcePositionConfigured,
    },
    campaign: {
      feeSharesFunded,
      finalized,
      rewardsSwept,
      feeSharePrincipal: feeSharePrincipal.toString(),
      totalStaked: totalStaked.toString(),
      totalRewardWeight: totalRewardWeight.toString(),
      rewardRate: rewardRate.toString(),
      rewardPerTokenStored: rewardPerTokenStored.toString(),
      accountedRewardBalance: campaignAccountedRewardBalance.toString(),
      queuedRewards: campaignQueuedRewards.toString(),
      lastUpdateAt: lastUpdateAt.toString(),
    },
    vault: {
      totalSupply: vaultTotalSupply.toString(),
      sponsorFeeShareBalance: sponsorFeeShareBalance.toString(),
      sponsorClaimableWeth: sponsorClaimableWeth.toString(),
      accountedRewardBalance: vaultAccountedRewardBalance.toString(),
      queuedRewards: vaultQueuedRewards.toString(),
    },
    viewer: null,
    permit: {
      name: domainName,
      version: domainVersion,
    },
  };
}

const cachedPublicFeeRewards = unstable_cache(
  fetchPublicFeeRewardsUncached,
  [
    "0xzaps-fee-rewards-public-v1",
    // A verifier implementation can change without changing the manifest.
    // Vercel supplies this immutable SHA, preventing cross-release reuse.
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() || "local",
    // Next's Data Cache can survive deployments. Bind the cache entry to the
    // complete release manifest, including timing, allocations, immutables,
    // source position, and runtime hashes—not merely contract addresses.
    JSON.stringify(FEE_REWARDS_MANIFEST, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ],
  { revalidate: 10, tags: ["0xzaps-fee-rewards-public"] },
);

function assertSharedSnapshotFresh(snapshot: FeeRewardsPayload, now = Date.now()): void {
  const readAt = Date.parse(snapshot.readAt);
  const age = now - readAt;
  if (
    !Number.isFinite(readAt)
    || age > MAX_SHARED_SNAPSHOT_AGE_MS
    || age < -MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    // `unstable_cache` can retain its last successful value when background
    // revalidation fails. Never let that turn an arbitrarily old chain read
    // into a fresh-looking API response or a transaction-ready UI state.
    throw new StaleRewardsSnapshotError();
  }
}

function normalizeViewer(viewer: Address | null): Address | null {
  if (viewer !== null && !isAddress(viewer)) {
    throw new Error("Rewards viewer is not a valid address.");
  }
  return viewer === null ? null : getAddress(viewer);
}

async function attachViewer(
  snapshot: FeeRewardsPayload,
  account: Address | null,
): Promise<FeeRewardsPayload> {
  if (account === null) return snapshot;

  const client = rewardsClient();
  const blockNumber = BigInt(snapshot.headBlock);
  const [chainId, viewer] = await Promise.all([
    client.getChainId(),
    readViewer(client, account, blockNumber),
  ]);
  if (chainId !== FEE_REWARDS_MANIFEST.chainId) {
    throw new Error("Rewards RPC returned the wrong chain.");
  }

  // The public snapshot can be reused briefly, but private wallet fields must
  // still prove they were read from that exact canonical block.
  const canonicalBlock = await client.getBlock({ blockNumber });
  if (!canonicalBlock.hash || !sameHash(canonicalBlock.hash, snapshot.blockHash)) {
    throw new Error("The pinned Robinhood block changed during the rewards viewer read.");
  }
  assertSharedSnapshotFresh(snapshot);

  return { ...snapshot, viewer };
}

/**
 * Uncached verifier used by focused safety tests and explicit release checks.
 * Runtime identity and all public values are freshly re-read before any
 * optional wallet fields are attached at the same canonical block.
 */
export async function fetchFeeRewardsUncached(viewer: Address | null): Promise<FeeRewardsPayload> {
  const account = normalizeViewer(viewer);
  return attachViewer(await fetchPublicFeeRewardsUncached(), account);
}

/**
 * Production read path. Public contract identity/state is shared for 10
 * seconds across SSR and API callers; wallet fields remain private, uncached,
 * and pinned to the cached snapshot's canonical block.
 */
export async function fetchFeeRewards(viewer: Address | null): Promise<FeeRewardsPayload> {
  const account = normalizeViewer(viewer);
  const snapshot = await cachedPublicFeeRewards();
  assertSharedSnapshotFresh(snapshot);
  return attachViewer(snapshot, account);
}
