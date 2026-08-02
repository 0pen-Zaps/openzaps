import { getAddress, parseAbi, type Address, type Hex } from "viem";

const E18 = 10n ** 18n;

/**
 * Immutable public release manifest for the first 0xZAPS fee campaign.
 *
 * These values are intentionally not environment-overridable. A different
 * address, runtime hash, or campaign term is a different reviewed release and
 * must arrive as a source change rather than silently replacing this campaign.
 */
export const FEE_REWARDS_MANIFEST = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  token: getAddress("0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  adapter: {
    address: getAddress("0x543A48f9A261607192b41e0a12A5ab143F3cAD9c"),
    runtimeCodeHash:
      "0xbfb40896738d786e657e3f524595ee43d98a7570f9ec162a1262b012a868d195" as Hex,
  },
  vault: {
    address: getAddress("0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338"),
    runtimeCodeHash:
      "0x4d62bd109d8fed9a04c02343cf6357dbf6d6789ef5ed9940b11add836c3caac4" as Hex,
    totalShares: 100n * E18,
    initialShareRecipient: getAddress("0x5a52D4B820Ae7F02880d270562950918ACb14aA2"),
  },
  campaign: {
    address: getAddress("0x57d7A79185B64EBA1345D880f97d85A46d4e582F"),
    runtimeCodeHash:
      "0xdc3b2cc96fedbf6c7de50f4bfd0d5ad37b3039a0a30bde0510a559aba8393312" as Hex,
    deploymentBlock: 25_451_599n,
    sponsor: getAddress("0x5a52D4B820Ae7F02880d270562950918ACb14aA2"),
    startAt: 1_785_716_580n,
    endAt: 1_786_321_380n,
    claimDeadline: 1_788_913_380n,
    feeShareAllocation: 50n * E18,
  },
  source: {
    lpLockerFeeConversion: getAddress("0x290F735F63824BB5836cDe24a35F5103A5B5Bc99"),
    feeLocker: getAddress("0x88db2340bE5991B2b5Fca2Baee39B5CE048Cd70c"),
    adminIndex: 0n,
  },
  permit: {
    name: "OpenZaps",
    version: "1",
  },
} as const;

export const feeRewardsAdapterAbi = parseAbi([
  "function LP_LOCKER_FEE_CONVERSION() view returns (address)",
  "function FEE_LOCKER() view returns (address)",
  "function isPositionConfigured(address clankerToken, uint256 adminIndex, address feeOwner, address[] rewardAssets) view returns (bool)",
  "function harvest(address clankerToken, uint256 adminIndex, address feeOwner, address[] rewardAssets)",
]);

export const feeRewardsVaultAbi = parseAbi([
  "function FEE_SOURCE() view returns (address)",
  "function TOTAL_SHARES() view returns (uint256)",
  "function activated() view returns (bool)",
  "function clankerToken() view returns (address)",
  "function adminIndex() view returns (uint256)",
  "function initialShareRecipient() view returns (address)",
  "function rewardAssetCount() view returns (uint256)",
  "function rewardAssets(uint256 index) view returns (address)",
  "function cumulativeRewardPerShare(address asset) view returns (uint256)",
  "function accountedRewardBalance(address asset) view returns (uint256)",
  "function queuedRewards(address asset) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function accruedRewards(address account, address rewardAsset) view returns (uint256)",
  "function claimable(address account, address rewardAsset) view returns (uint256)",
  "function activate()",
  "function harvest()",
  "function sync()",
  "function claimFor(address account)",
  "function claimRewards(address account)",
  "function claimCheckpointedFor(address account)",
  "event Activated(address indexed initialHolder, uint256 fixedSupply)",
  "event Harvested(address indexed caller)",
  "event RewardsSynchronized(address indexed asset, uint256 newlyReceived, uint256 indexedAmount, uint256 queuedAmount)",
  "event RewardClaimed(address indexed caller, address indexed account, address indexed asset, uint256 amount)",
]);

export const feeRewardsCampaignAbi = parseAbi([
  "function STAKING_TOKEN() view returns (address)",
  "function FEE_SHARE_TOKEN() view returns (address)",
  "function startAt() view returns (uint64)",
  "function endAt() view returns (uint64)",
  "function claimDeadline() view returns (uint64)",
  "function sponsor() view returns (address)",
  "function rewardAssetCount() view returns (uint256)",
  "function rewardAssets(uint256 index) view returns (address)",
  "function feeSharesFunded() view returns (bool)",
  "function finalized() view returns (bool)",
  "function rewardsSwept() view returns (bool)",
  "function feeSharePrincipal() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function totalRewardWeight() view returns (uint256)",
  "function lastUpdateAt() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function rewardWeight(address account) view returns (uint256)",
  "function rewardState(address rewardAsset) view returns (uint256 rewardRate, uint256 rewardPerTokenStored, uint256 accountedBalance, uint256 queuedRewards)",
  "function accruedRewards(address account, address rewardAsset) view returns (uint256)",
  "function earned(address account, address rewardAsset) view returns (uint256)",
  "function fundFeeShares(uint256 amount)",
  "function stake(uint256 amount)",
  "function stakeWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function withdraw(uint256 amount)",
  "function exit()",
  "function claimFor(address account)",
  "function harvest()",
  "function syncRewards()",
  "function checkpoint()",
  "function finalize()",
  "function sweepExpiredRewards()",
  "event FeeSharesFunded(address indexed sponsor, uint256 amount)",
  "event Staked(address indexed account, uint256 requestedAmount, uint256 creditedAmount)",
  "event Withdrawn(address indexed account, uint256 amount)",
  "event RewardsSynchronized(address indexed asset, uint256 newlyReceived, uint256 rewardRate, uint256 queuedRewards)",
  "event RewardPaid(address indexed caller, address indexed account, address indexed asset, uint256 amount)",
  "event Finalized(uint256 feeSharesReturned)",
  "event ExpiredRewardsSwept(address indexed asset, uint256 amount)",
]);

export const permitTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

export type FeeRewardsPhase =
  | "unfunded"
  | "upcoming"
  | "active"
  | "settlement-pending"
  | "claim-only"
  | "expired";

/** Contract-exact campaign phase boundaries. */
export function campaignPhase(
  timestamp: bigint,
  feeSharesFunded: boolean,
  finalized: boolean,
  startAt: bigint = FEE_REWARDS_MANIFEST.campaign.startAt,
  endAt: bigint = FEE_REWARDS_MANIFEST.campaign.endAt,
  claimDeadline: bigint = FEE_REWARDS_MANIFEST.campaign.claimDeadline,
): FeeRewardsPhase {
  if (!feeSharesFunded) return "unfunded";
  if (timestamp < startAt) return "upcoming";
  if (timestamp < endAt) return "active";
  if (!finalized) return "settlement-pending";
  if (timestamp <= claimDeadline) return "claim-only";
  return "expired";
}

export function formatCampaignPhase(phase: FeeRewardsPhase): string {
  switch (phase) {
    case "unfunded":
      return "Unfunded";
    case "upcoming":
      return "Upcoming";
    case "active":
      return "Active";
    case "settlement-pending":
      return "Settlement pending";
    case "claim-only":
      return "Claim only";
    case "expired":
      return "Expired";
  }
}

export type FeeRewardsPayload = {
  headBlock: string;
  blockHash: Hex;
  blockTimestamp: string;
  readAt: string;
  phase: FeeRewardsPhase;
  verification: {
    adapterCodeHash: Hex;
    vaultCodeHash: Hex;
    campaignCodeHash: Hex;
    vaultActivated: boolean;
    sourcePositionConfigured: boolean;
  };
  campaign: {
    feeSharesFunded: boolean;
    finalized: boolean;
    rewardsSwept: boolean;
    feeSharePrincipal: string;
    totalStaked: string;
    totalRewardWeight: string;
    rewardRate: string;
    rewardPerTokenStored: string;
    accountedRewardBalance: string;
    queuedRewards: string;
    lastUpdateAt: string;
  };
  vault: {
    totalSupply: string;
    sponsorFeeShareBalance: string;
    sponsorClaimableWeth: string;
    accountedRewardBalance: string;
    queuedRewards: string;
  };
  viewer: null | {
    account: Address;
    tokenBalance: string;
    allowance: string;
    stakedBalance: string;
    rewardWeight: string;
    earnedWeth: string;
    feeShareBalance: string;
    directVaultClaimableWeth: string;
    wethBalance: string;
    permitNonce: string;
  };
  permit: {
    name: string;
    version: string;
  };
};
