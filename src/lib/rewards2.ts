import { encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";

const E18 = 10n ** 18n;
export const CAMPAIGN_2_PULSE_MAX_AGE_MS = 2 * 60_000;
const CAMPAIGN_2_PULSE_MAX_FUTURE_SKEW_MS = 5_000;

/**
 * A live campaign claim is valid only while both the observation and the
 * canonical block it describes are recent. Checking both prevents a freshly
 * stamped response from a lagging RPC being presented as current state.
 */
export function campaign2PulseIsFresh(
  snapshot: { readAt: string; blockTimestamp: string },
  now = Date.now(),
): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(snapshot.blockTimestamp)) return false;
  const readAt = Date.parse(snapshot.readAt);
  const blockTimestampSeconds = Number(snapshot.blockTimestamp);
  const blockAt = blockTimestampSeconds * 1_000;
  return [readAt, blockAt].every((timestamp) => {
    const age = now - timestamp;
    return Number.isFinite(timestamp)
      && Number.isSafeInteger(timestamp)
      && age <= CAMPAIGN_2_PULSE_MAX_AGE_MS
      && age >= -CAMPAIGN_2_PULSE_MAX_FUTURE_SKEW_MS;
  });
}

/**
 * Immutable public manifest for the SECOND 0xZAPS fee campaign: a 14-day
 * window that puts 100% of the tokenized fee stream to work in two legs —
 * 50 of the vault's 100 shares stream WETH to 0xZAPS stakers (the proven
 * campaign mechanics), and 50 shares feed HookBlocks, which market-buys
 * $HOOKR through one pinned pool and burns every bought token to the dead
 * address in the same transaction, recording each one in a permanent ledger.
 *
 * `deployment` is `null` until the two campaign-2 contracts arrive as a
 * reviewed release — an address plus verified `runtimeCodeHash` in a source
 * change, exactly like the campaign-1 manifest. Until then the surface fails
 * closed: there is nothing to read and nothing to sign. The reference
 * identities below are already live and verifiable; they are context.
 */
export const FEE_REWARDS_2_MANIFEST = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  /** 0xZAPS — the staking token of leg A, enforced onchain on 4663. */
  token: getAddress("0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"),
  /** aeWETH — the only reward asset the fee vault pays. */
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  /** $HOOKR — the token leg B buys and burns. */
  hookr: getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c"),
  /** The live tokenized fee-share vault both legs draw from. */
  vault: {
    address: getAddress("0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338"),
    totalShares: 100n * E18,
  },
  sponsor: getAddress("0x5a52D4B820Ae7F02880d270562950918ACb14aA2"),
  /**
   * The one HOOKR market leg B is pinned to: the hookless native-ETH/HOOKR
   * pool on the canonical v4 PoolManager. `poolId` is provably
   * `keccak256(abi.encode(key))` — `deriveHookrPoolId()` recomputes it and
   * the unit test refuses any drift, the same proof `HookBlocks` performs
   * in its constructor.
   */
  hookrPool: {
    poolManager: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
    poolId: "0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf" as Hex,
    key: {
      currency0: "0x0000000000000000000000000000000000000000" as Address,
      currency1: getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c"),
      fee: 2500,
      tickSpacing: 25,
      hooks: "0x0000000000000000000000000000000000000000" as Address,
    },
  },
  /** The reviewed campaign-2 terms, fixed before any deployment. */
  terms: {
    durationSeconds: 14n * 86_400n,
    stakerFeeShares: 50n * E18,
    hookBlocksFeeShares: 50n * E18,
    minOutBps: 9_700,
    maxBuyWei: 50_000_000_000_000_000n, // 0.05 ETH
    minBuyWei: 500_000_000_000_000n, // 0.0005 ETH
  },
  /**
   * The released campaign-2 contracts, verified on chain 4663 on 2026-08-20
   * before this manifest was written: runtime hashes re-read from deployed
   * code (leg A's is byte-exact to the pre-derived constructor simulation of
   * the unchanged campaign-1 artifact), immutable read-backs exact, and the
   * schedule identical across both legs. A different address or term is a
   * different reviewed release. Source: main @ campaign2-source tag lineage;
   * deploy receipts 0xb10ac1a1…9780 (HookBlocks) and 0x73504fcc…37a1
   * (campaign).
   */
  deployment: {
    campaign: {
      address: getAddress("0x7F57F7B760614e67D3B3887433fA124B4c9A09F9"),
      runtimeCodeHash:
        "0xfa2c508f6b75979fd9a88626526565397a9c10ea93d98f2b817a76fddb9b76df" as Hex,
      deploymentBlock: 41_581_207n,
      startAt: 1_787_259_600n,
      endAt: 1_788_469_200n,
      claimDeadline: 1_791_061_200n,
    },
    hookBlocks: {
      address: getAddress("0xB5F7D9D4269c897Df70Df26F7bA48c0d933Be8Db"),
      runtimeCodeHash:
        "0x8b9fc3ae1a3ad1475d038f09d3945ec8bbe9954ca15956221639e6cc186f3526" as Hex,
      deploymentBlock: 41_579_883n,
      startAt: 1_787_259_600n,
      endAt: 1_788_469_200n,
      sweepAfter: 1_791_061_200n,
    },
  },
} as const;

/**
 * Deployment state of campaign 2, all-or-nothing like the fee-share
 * wrappers: both contracts released = `configured`; neither = `absent` (the
 * deliberate not-live state); anything else = `partial`, a release error the
 * surface must never present as usable.
 */
export function feeRewards2Deployment(
  manifest: { deployment: unknown } = FEE_REWARDS_2_MANIFEST,
): "absent" | "partial" | "configured" {
  const deployment = manifest.deployment as {
    campaign?: unknown;
    hookBlocks?: unknown;
  } | null;
  if (deployment === null) return "absent";
  const campaign = Boolean(deployment.campaign);
  const hookBlocks = Boolean(deployment.hookBlocks);
  if (campaign && hookBlocks) return "configured";
  if (!campaign && !hookBlocks) return "absent";
  return "partial";
}

/**
 * Recomputes the v4 poolId from the pinned key. A v4 pool id IS
 * `keccak256(abi.encode(key))`, so this equality is a complete proof that
 * the recorded key describes the pool the manifest names.
 */
export function deriveHookrPoolId(): Hex {
  const key = FEE_REWARDS_2_MANIFEST.hookrPool.key;
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** The HookBlocks read/write surface, mirrored from the Solidity source. */
export const hookBlocksAbi = parseAbi([
  "function DEAD() view returns (address)",
  "function FEE_SHARES() view returns (address)",
  "function WETH() view returns (address)",
  "function HOOKR() view returns (address)",
  "function POOL_MANAGER() view returns (address)",
  "function POOL_ID() view returns (bytes32)",
  "function SPONSOR() view returns (address)",
  "function START_AT() view returns (uint64)",
  "function END_AT() view returns (uint64)",
  "function SWEEP_AFTER() view returns (uint64)",
  "function MIN_OUT_BPS() view returns (uint16)",
  "function MAX_BUY_WEI() view returns (uint256)",
  "function MIN_BUY_WEI() view returns (uint256)",
  "function feeSharesFunded() view returns (bool)",
  "function finalized() view returns (bool)",
  "function buybackPaused() view returns (bool)",
  "function feeSharePrincipal() view returns (uint256)",
  "function totalEthSpent() view returns (uint256)",
  "function totalHookrBought() view returns (uint256)",
  "function totalHookrBurned() view returns (uint256)",
  "function blockCount() view returns (uint256)",
  "function hookBlock(uint256 index) view returns ((uint128 ethIn, uint128 hookrBought, uint64 burnedAt))",
  "function pendingWeth() view returns (uint256)",
  "function lastBuyBlock() view returns (uint256)",
  "function fundFeeShares(uint256 amount)",
  "function buyAndBurn(uint256 minHookrOut) returns (uint256 hookrBurned)",
  "function setBuybackPaused(bool paused)",
  "function finalize()",
  "function sweepUnspent()",
  "event FeeSharesFunded(address indexed sponsor, uint256 amount)",
  "event BoughtAndBurned(address indexed caller, uint256 indexed blockIndex, uint256 ethIn, uint256 hookrBought, uint256 hookrBurned, uint256 floor)",
  "event BuybackPauseSet(bool paused)",
  "event Finalized(uint256 feeSharesReturned)",
  "event UnspentSwept(address indexed caller, uint256 wethAmount, uint256 nativeAmount, uint256 hookrBurned)",
]);

export type Campaign2Leg = {
  id: "stakers" | "hook-blocks";
  name: string;
  share: string;
  contract: string;
  tagline: string;
  /** Mechanisms the contracts enforce — never returns or price claims. */
  points: readonly string[];
};

/**
 * Plain-language description of the two legs, driven from the reviewed
 * contracts. Every sentence states a mechanism; the page test pins the
 * boundary sentences verbatim.
 */
export const CAMPAIGN_2_LEGS: readonly Campaign2Leg[] = [
  {
    id: "stakers",
    name: "Stakers",
    share: "50% of fees",
    contract: "OXZAPSFeeCampaignV1 (new 14-day term)",
    tagline: "Half the fee stream pays 0xZAPS stakers in WETH, like campaign 1.",
    points: [
      "Stake 0xZAPS through the fixed window; withdraw principal at any time — reward failures can never block an exit.",
      "Harvest is permissionless and streams only to the fixed end; no harvest can extend or reset the timer.",
      "After the window, finalize returns the 50 fee shares to the sponsor and claims stay open until the deadline.",
    ],
  },
  {
    id: "hook-blocks",
    name: "Hook Blocks",
    share: "50% of fees",
    contract: "HookBlocks",
    tagline: "The other half market-buys $HOOKR and burns it on the spot.",
    points: [
      "A permissionless crank converts the leg's WETH into $HOOKR through one constructor-pinned pool — no router, no path arrays.",
      "Every buy is floored against same-block spot and capped per call, and lands as one immutable Hook Block in an append-only ledger.",
      "The HOOKR is sent to the dead address in the same transaction that buys it, so the contract never holds any and there is nothing for anyone to reach.",
      "If a step fails, the crank reverts and the WETH simply waits: the sponsor can pause future buys and recover unconverted WETH once the term ends.",
      "The token has no burn function, so this removes HOOKR from circulation without reducing totalSupply.",
    ],
  },
];
