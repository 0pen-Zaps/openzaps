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
    transport: http(rewardsRpcUrl(), { retryCount: 2, timeout: 15_000 }),
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
 * Read the complete public campaign and optional wallet position at one block.
 * No partial payload is returned: runtime identity, immutable bindings, current
 * state, permit identity, viewer fields, and the final canonical hash recheck
 * all have to succeed together.
 */
export async function fetchFeeRewards(viewer: Address | null): Promise<FeeRewardsPayload> {
  if (viewer !== null && !isAddress(viewer)) {
    throw new Error("Rewards viewer is not a valid address.");
  }
  const account = viewer === null ? null : getAddress(viewer);
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
    viewerState,
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
    account ? readViewer(client, account, blockNumber) : Promise.resolve(null),
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
    viewer: viewerState,
    permit: {
      name: domainName,
      version: domainVersion,
    },
  };
}
