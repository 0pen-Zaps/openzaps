import {
  decodeFunctionData,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";

export const CAMPAIGN2_MANIFEST = Object.freeze({
  chainId: 4663,
  keeper: getAddress("0xA2b7dCE7CBf773462E4338a9E0403C53437e9bEC"),
  poolManager: Object.freeze({
    address: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
    runtimeCodeHash: "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626",
  }),
  poolId: "0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf",
  campaign: Object.freeze({
    address: getAddress("0x7F57F7B760614e67D3B3887433fA124B4c9A09F9"),
    runtimeCodeHash: "0xfa2c508f6b75979fd9a88626526565397a9c10ea93d98f2b817a76fddb9b76df",
  }),
  hookBlocks: Object.freeze({
    address: getAddress("0xB5F7D9D4269c897Df70Df26F7bA48c0d933Be8Db"),
    runtimeCodeHash: "0x8b9fc3ae1a3ad1475d038f09d3945ec8bbe9954ca15956221639e6cc186f3526",
  }),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  startAt: 1_787_259_600n,
  endAt: 1_788_469_200n,
  claimDeadline: 1_791_061_200n,
  sweepAfter: 1_791_061_200n,
  minBuyWei: 500_000_000_000_000n,
  maxBuyWei: 50_000_000_000_000_000n,
  minOutBps: 9_700n,
});

export const campaign2CampaignAbi = parseAbi([
  "function feeSharesFunded() view returns (bool)",
  "function finalized() view returns (bool)",
  "function startAt() view returns (uint64)",
  "function endAt() view returns (uint64)",
  "function claimDeadline() view returns (uint64)",
  "function harvest()",
  "function finalize()",
  "event RewardsSynchronized(address indexed asset,uint256 newlyReceived,uint256 rewardRate,uint256 queuedRewards)",
  "event Finalized(uint256 feeSharesReturned)",
]);

export const campaign2HookBlocksAbi = parseAbi([
  "function feeSharesFunded() view returns (bool)",
  "function finalized() view returns (bool)",
  "function buybackPaused() view returns (bool)",
  "function START_AT() view returns (uint64)",
  "function END_AT() view returns (uint64)",
  "function SWEEP_AFTER() view returns (uint64)",
  "function MIN_BUY_WEI() view returns (uint256)",
  "function MAX_BUY_WEI() view returns (uint256)",
  "function MIN_OUT_BPS() view returns (uint16)",
  "function POOL_MANAGER() view returns (address)",
  "function POOL_ID() view returns (bytes32)",
  "function pendingWeth() view returns (uint256)",
  "function totalEthSpent() view returns (uint256)",
  "function totalHookrBought() view returns (uint256)",
  "function totalHookrBurned() view returns (uint256)",
  "function blockCount() view returns (uint256)",
  "function buyAndBurn(uint256 minHookrOut) returns (uint256 hookrBurned)",
  "function finalize()",
  "event BoughtAndBurned(address indexed caller,uint256 indexed blockIndex,uint256 ethIn,uint256 hookrBought,uint256 hookrBurned,uint256 floor)",
  "event Finalized(uint256 feeSharesReturned)",
]);

const campaign2PoolManagerAbi = parseAbi([
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

const POOLS_SLOT = 6n;
const Q96 = 1n << 96n;
const UINT160_MASK = (1n << 160n) - 1n;
const BPS = 10_000n;
const CAMPAIGN2_SNAPSHOT_READ_SPACING_MS = 250;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
const CAMPAIGN2_POOL_SLOT0 = keccak256(encodeAbiParameters(
  [{ type: "bytes32" }, { type: "uint256" }],
  [CAMPAIGN2_MANIFEST.poolId, POOLS_SLOT],
));

/**
 * Re-read the exact v4 slot0 word at a historical block. Live burn policy
 * calls this through a separately configured archive RPC before it trusts a
 * journaled sample; a canonical header by itself does not prove the stored
 * price value came from that state.
 */
export async function fetchCampaign2PoolSqrtPriceAtBlock(
  publicClient,
  blockNumber,
  manifest = CAMPAIGN2_MANIFEST,
) {
  if (typeof blockNumber !== "bigint" || blockNumber < 0n) {
    throw new Error("campaign-2 pool-price block must be a nonnegative bigint");
  }
  const poolSlot0 = await publicClient.readContract({
    address: manifest.poolManager.address,
    abi: campaign2PoolManagerAbi,
    functionName: "extsload",
    args: [CAMPAIGN2_POOL_SLOT0],
    blockNumber,
  });
  const sqrtPriceX96 = BigInt(poolSlot0) & UINT160_MASK;
  if (sqrtPriceX96 <= 0n) {
    throw new Error("campaign-2 historical pool price is unavailable or uninitialized");
  }
  return sqrtPriceX96;
}

const EVENT_TOPICS = Object.freeze({
  "campaign-finalize": keccak256(toBytes("Finalized(uint256)")),
  "hook-blocks-finalize": keccak256(toBytes("Finalized(uint256)")),
  "hookr-buy-and-burn": keccak256(
    toBytes("BoughtAndBurned(address,uint256,uint256,uint256,uint256,uint256)"),
  ),
});

export const CAMPAIGN2_ACTIONS = Object.freeze({
  "staker-harvest": Object.freeze({
    id: "staker-harvest",
    target: CAMPAIGN2_MANIFEST.campaign.address,
    abi: campaign2CampaignAbi,
    functionName: "harvest",
    functionSignature: "harvest()",
    args: Object.freeze([]),
    gas: 900_000n,
    requiredEventTopic: null,
  }),
  "hookr-buy-and-burn": Object.freeze({
    id: "hookr-buy-and-burn",
    target: CAMPAIGN2_MANIFEST.hookBlocks.address,
    abi: campaign2HookBlocksAbi,
    functionName: "buyAndBurn",
    functionSignature: "buyAndBurn(uint256)",
    // This zero is only the immutable template placeholder. assertCampaign2Action refuses it;
    // every executable automation action is rebound to a strictly positive median-derived floor.
    args: Object.freeze([0n]),
    gas: 1_200_000n,
    requiredEventTopic: EVENT_TOPICS["hookr-buy-and-burn"],
  }),
  "campaign-finalize": Object.freeze({
    id: "campaign-finalize",
    target: CAMPAIGN2_MANIFEST.campaign.address,
    abi: campaign2CampaignAbi,
    functionName: "finalize",
    functionSignature: "finalize()",
    args: Object.freeze([]),
    gas: 900_000n,
    requiredEventTopic: EVENT_TOPICS["campaign-finalize"],
  }),
  "hook-blocks-finalize": Object.freeze({
    id: "hook-blocks-finalize",
    target: CAMPAIGN2_MANIFEST.hookBlocks.address,
    abi: campaign2HookBlocksAbi,
    functionName: "finalize",
    functionSignature: "finalize()",
    args: Object.freeze([]),
    gas: 700_000n,
    requiredEventTopic: EVENT_TOPICS["hook-blocks-finalize"],
  }),
});

function sameActionField(action, base, field) {
  if (field === "abi") return action[field] === base[field];
  return action[field] === base[field];
}

export function assertCampaign2Action(action) {
  const base = CAMPAIGN2_ACTIONS[action?.id];
  if (!base) throw new Error("unknown campaign-2 action");
  for (const field of [
    "id",
    "target",
    "abi",
    "functionName",
    "functionSignature",
    "gas",
    "requiredEventTopic",
  ]) {
    if (!sameActionField(action, base, field)) {
      throw new Error(`campaign-2 action changed pinned field ${field}`);
    }
  }
  if (action.id === "hookr-buy-and-burn") {
    if (action.args?.length !== 1 || typeof action.args[0] !== "bigint" || action.args[0] <= 0n) {
      throw new Error("campaign-2 automated burn requires a positive caller floor");
    }
  } else if (action !== base) {
    throw new Error("campaign-2 non-burn action must be the pinned release action");
  }
  return action;
}

export function campaign2BurnAction(minHookrOut) {
  if (typeof minHookrOut !== "bigint" || minHookrOut <= 0n) {
    throw new Error("campaign-2 automated burn floor must be a positive bigint");
  }
  const base = CAMPAIGN2_ACTIONS["hookr-buy-and-burn"];
  return Object.freeze({ ...base, args: Object.freeze([minHookrOut]) });
}

function sameHex(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.toLowerCase() === right.toLowerCase();
}

function requiredCodeHash(code, expected, label) {
  if (!code || code === "0x") throw new Error(`${label} has no runtime bytecode`);
  const actual = keccak256(code);
  if (!sameHex(actual, expected)) {
    throw new Error(`${label} runtime hash mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

/**
 * Robinhood's public RPC rejects the 25-call snapshot burst with HTTP 429.
 * Keep every decision input pinned to one block, but issue the reads at a
 * conservative four requests per second. A failed read stops the sequence and
 * therefore still fails closed before planning or signing anything.
 */
export async function sequenceCampaign2SnapshotReads(
  reads,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  if (!Array.isArray(reads) || reads.some((read) => typeof read !== "function")) {
    throw new Error("campaign-2 snapshot reads must be functions");
  }
  if (typeof pause !== "function") {
    throw new Error("campaign-2 snapshot pause must be a function");
  }
  const values = [];
  for (let index = 0; index < reads.length; index += 1) {
    values.push(await reads[index]());
    if (index + 1 < reads.length) {
      await pause(CAMPAIGN2_SNAPSHOT_READ_SPACING_MS);
    }
  }
  return values;
}

/**
 * Read every decision input at one explicit block and refuse any deployed-identity drift.
 * This is intentionally campaign-specific; callers cannot override addresses or selectors.
 */
export async function fetchCampaign2KeeperSnapshot(
  publicClient,
  manifest = CAMPAIGN2_MANIFEST,
  { lagBlocks = 128n, blockNumber: explicitBlockNumber = null } = {},
) {
  const chainId = await publicClient.getChainId();
  if (chainId !== manifest.chainId) {
    throw new Error(`campaign-2 keeper expected chain ${manifest.chainId}, RPC reports ${chainId}`);
  }
  if (typeof lagBlocks !== "bigint" || lagBlocks < 0n || lagBlocks > 10_000n) {
    throw new Error("campaign-2 snapshot lag must be a bigint from 0 to 10000 blocks");
  }
  const reportedHead = await publicClient.getBlockNumber();
  if (
    explicitBlockNumber !== null
    && (typeof explicitBlockNumber !== "bigint" || explicitBlockNumber < 0n || explicitBlockNumber > reportedHead)
  ) {
    throw new Error("campaign-2 explicit snapshot block must be a mined block at or below head");
  }
  const blockNumber = explicitBlockNumber
    ?? (reportedHead > lagBlocks ? reportedHead - lagBlocks : 0n);
  const block = await publicClient.getBlock({ blockNumber });
  if (block.number === null || block.number === undefined || !block.hash) {
    throw new Error("campaign-2 keeper could not pin a canonical head block");
  }
  const [
    campaignCode,
    hookBlocksCode,
    poolManagerCode,
    campaignFunded,
    campaignFinalized,
    campaignStartAt,
    campaignEndAt,
    campaignClaimDeadline,
    hookBlocksFunded,
    hookBlocksFinalized,
    buybackPaused,
    hookBlocksStartAt,
    hookBlocksEndAt,
    hookBlocksSweepAfter,
    minBuyWei,
    maxBuyWei,
    minOutBps,
    poolManager,
    poolId,
    poolSlot0,
    pendingWeth,
    totalEthSpent,
    totalHookrBought,
    totalHookrBurned,
    hookBlockCount,
  ] = await sequenceCampaign2SnapshotReads([
    () => publicClient.getBytecode({ address: manifest.campaign.address, blockNumber }),
    () => publicClient.getBytecode({ address: manifest.hookBlocks.address, blockNumber }),
    () => publicClient.getBytecode({ address: manifest.poolManager.address, blockNumber }),
    () => publicClient.readContract({ address: manifest.campaign.address, abi: campaign2CampaignAbi, functionName: "feeSharesFunded", blockNumber }),
    () => publicClient.readContract({ address: manifest.campaign.address, abi: campaign2CampaignAbi, functionName: "finalized", blockNumber }),
    () => publicClient.readContract({ address: manifest.campaign.address, abi: campaign2CampaignAbi, functionName: "startAt", blockNumber }),
    () => publicClient.readContract({ address: manifest.campaign.address, abi: campaign2CampaignAbi, functionName: "endAt", blockNumber }),
    () => publicClient.readContract({ address: manifest.campaign.address, abi: campaign2CampaignAbi, functionName: "claimDeadline", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "feeSharesFunded", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "finalized", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "buybackPaused", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "START_AT", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "END_AT", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "SWEEP_AFTER", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "MIN_BUY_WEI", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "MAX_BUY_WEI", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "MIN_OUT_BPS", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "POOL_MANAGER", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "POOL_ID", blockNumber }),
    () => publicClient.readContract({
      address: manifest.poolManager.address,
      abi: campaign2PoolManagerAbi,
      functionName: "extsload",
      args: [CAMPAIGN2_POOL_SLOT0],
      blockNumber,
    }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "pendingWeth", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "totalEthSpent", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "totalHookrBought", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "totalHookrBurned", blockNumber }),
    () => publicClient.readContract({ address: manifest.hookBlocks.address, abi: campaign2HookBlocksAbi, functionName: "blockCount", blockNumber }),
  ]);

  const campaignCodeHash = requiredCodeHash(
    campaignCode,
    manifest.campaign.runtimeCodeHash,
    "campaign-2 staker contract",
  );
  const hookBlocksCodeHash = requiredCodeHash(
    hookBlocksCode,
    manifest.hookBlocks.runtimeCodeHash,
    "campaign-2 HookBlocks contract",
  );
  const poolManagerCodeHash = requiredCodeHash(
    poolManagerCode,
    manifest.poolManager.runtimeCodeHash,
    "campaign-2 pool manager",
  );
  const sqrtPriceX96 = BigInt(poolSlot0) & UINT160_MASK;
  const scheduleMatches =
    campaignStartAt === manifest.startAt
    && campaignEndAt === manifest.endAt
    && campaignClaimDeadline === manifest.claimDeadline
    && hookBlocksStartAt === manifest.startAt
    && hookBlocksEndAt === manifest.endAt
    && hookBlocksSweepAfter === manifest.sweepAfter
    && minBuyWei === manifest.minBuyWei
    && maxBuyWei === manifest.maxBuyWei
    && BigInt(minOutBps) === manifest.minOutBps
    && sameHex(poolManager, manifest.poolManager.address)
    && sameHex(poolId, manifest.poolId)
    && sqrtPriceX96 > 0n;
  if (!scheduleMatches) {
    throw new Error("campaign-2 immutable schedule, pool, or buy bound does not match the release manifest");
  }
  const canonical = await publicClient.getBlock({ blockNumber });
  if (!sameHex(canonical?.hash, block.hash)) {
    throw new Error("campaign-2 pinned block changed during the snapshot; retry against a new head");
  }

  return {
    chainId,
    blockNumber,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    campaignCodeHash,
    hookBlocksCodeHash,
    poolManagerCodeHash,
    sqrtPriceX96,
    campaign: {
      funded: campaignFunded,
      finalized: campaignFinalized,
    },
    hookBlocks: {
      funded: hookBlocksFunded,
      finalized: hookBlocksFinalized,
      buybackPaused,
      pendingWeth,
      minBuyWei,
      maxBuyWei,
      minOutBps: BigInt(minOutBps),
      totalEthSpent,
      totalHookrBought,
      totalHookrBurned,
      blockCount: hookBlockCount,
    },
  };
}

export const CAMPAIGN2_PRICE_POLICY = Object.freeze({
  sampleBucketSeconds: 300n,
  minimumSamples: 7,
  minimumSpanSeconds: 1_800n,
  maximumAgeSeconds: 3_600n,
  excludeFreshSeconds: 300n,
  freshestSampleSeconds: 900n,
  maximumGapSeconds: 900n,
});

export function campaign2PriceX96(sqrtPriceX96) {
  if (sqrtPriceX96 <= 0n) throw new Error("campaign-2 square-root price must be positive");
  return (sqrtPriceX96 * sqrtPriceX96) / Q96;
}

export function campaign2EffectiveBuyInput(pendingWeth, manifest = CAMPAIGN2_MANIFEST) {
  if (pendingWeth < manifest.maxBuyWei) {
    throw new Error("campaign-2 pending WETH is below the full immutable buy cap");
  }
  // buyAndBurn can claim more rewards between signing and inclusion, but it can never spend more
  // than MAX_BUY_WEI. Waiting for a full capped batch makes this caller floor cover the entire
  // amount that can be spent, instead of delegating any increment to manipulable same-block spot.
  return manifest.maxBuyWei;
}

export function campaign2FloorFromPriceX96({
  priceX96,
  ethIn,
  minOutBps = CAMPAIGN2_MANIFEST.minOutBps,
}) {
  if (priceX96 <= 0n || ethIn <= 0n || minOutBps <= 0n || minOutBps > BPS) {
    throw new Error("campaign-2 price-floor inputs are outside their positive bounds");
  }
  const expectedHookr = (ethIn * priceX96) / Q96;
  const floor = (expectedHookr * minOutBps) / BPS;
  if (floor <= 0n) throw new Error("campaign-2 median price floor rounded to zero");
  return floor;
}

export function campaign2FloorFromSqrtPrice({
  sqrtPriceX96,
  ethIn,
  minOutBps = CAMPAIGN2_MANIFEST.minOutBps,
}) {
  if (sqrtPriceX96 <= 0n || ethIn <= 0n || minOutBps <= 0n || minOutBps > BPS) {
    throw new Error("campaign-2 price-floor inputs are outside their positive bounds");
  }
  // Byte-for-byte integer ordering with HookBlocks: floor(sqrt^2/Q96), then
  // floor(ethIn*priceX96/Q96), then the basis-point haircut.
  return campaign2FloorFromPriceX96({
    priceX96: campaign2PriceX96(sqrtPriceX96),
    ethIn,
    minOutBps,
  });
}

export function deriveCampaign2MedianFloor({
  observations,
  nowSec,
  ethIn,
  policy = CAMPAIGN2_PRICE_POLICY,
  manifest = CAMPAIGN2_MANIFEST,
}) {
  if (!Array.isArray(observations)) {
    return { ready: false, reason: "price observation journal is missing" };
  }
  if (policy.sampleBucketSeconds <= 0n) {
    return { ready: false, reason: "price observation policy has an invalid bucket width" };
  }
  const seenBuckets = new Set();
  const seenBlockNumbers = new Set();
  const seenBlockHashes = new Set();
  let previous = null;
  for (const entry of observations) {
    if (
      typeof entry?.bucket !== "bigint"
      || typeof entry.blockNumber !== "bigint"
      || typeof entry.blockTimestamp !== "bigint"
      || typeof entry.sqrtPriceX96 !== "bigint"
      || entry.bucket < 0n
      || entry.blockNumber < 0n
      || entry.blockTimestamp < 0n
      || entry.sqrtPriceX96 <= 0n
      || !BLOCK_HASH.test(entry.blockHash ?? "")
      || entry.bucket !== entry.blockTimestamp / policy.sampleBucketSeconds
    ) {
      return { ready: false, reason: "pool-price observation journal is structurally invalid" };
    }
    const bucket = entry.bucket.toString();
    const blockNumber = entry.blockNumber.toString();
    const blockHash = entry.blockHash.toLowerCase();
    if (
      seenBuckets.has(bucket)
      || seenBlockNumbers.has(blockNumber)
      || seenBlockHashes.has(blockHash)
      || (previous && (
        entry.bucket <= previous.bucket
        || entry.blockNumber <= previous.blockNumber
        || entry.blockTimestamp <= previous.blockTimestamp
      ))
    ) {
      return { ready: false, reason: "pool-price observations must be unique and strictly monotonic" };
    }
    seenBuckets.add(bucket);
    seenBlockNumbers.add(blockNumber);
    seenBlockHashes.add(blockHash);
    previous = entry;
  }
  const eligible = observations
    .filter((entry) => (
      typeof entry.blockTimestamp === "bigint"
      && typeof entry.sqrtPriceX96 === "bigint"
      && entry.sqrtPriceX96 > 0n
      && entry.blockTimestamp <= nowSec
      && nowSec - entry.blockTimestamp <= policy.maximumAgeSeconds
      && nowSec - entry.blockTimestamp >= policy.excludeFreshSeconds
    ));
  if (eligible.length < policy.minimumSamples) {
    return {
      ready: false,
      reason: `need ${policy.minimumSamples} canonical pool-price samples; have ${eligible.length}`,
    };
  }
  const first = eligible[0];
  const last = eligible[eligible.length - 1];
  if (last.blockTimestamp - first.blockTimestamp < policy.minimumSpanSeconds) {
    return { ready: false, reason: "pool-price samples do not yet span 30 minutes" };
  }
  if (nowSec - last.blockTimestamp > policy.freshestSampleSeconds) {
    return { ready: false, reason: "newest pool-price sample is stale" };
  }
  for (let index = 1; index < eligible.length; index += 1) {
    if (eligible[index].blockTimestamp - eligible[index - 1].blockTimestamp > policy.maximumGapSeconds) {
      return { ready: false, reason: "pool-price observation window has an excessive gap" };
    }
  }
  const sortedPrices = eligible.map((entry) => campaign2PriceX96(entry.sqrtPriceX96)).sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  const middle = Math.floor(sortedPrices.length / 2);
  const medianPriceX96 = sortedPrices.length % 2 === 1
    ? sortedPrices[middle]
    : sortedPrices[middle - 1] + ((sortedPrices[middle] - sortedPrices[middle - 1]) / 2n);
  const minHookrOut = campaign2FloorFromPriceX96({
    priceX96: medianPriceX96,
    ethIn,
    minOutBps: manifest.minOutBps,
  });
  return {
    ready: true,
    minHookrOut,
    medianPriceX96,
    effectiveEthIn: ethIn,
    sampleCount: eligible.length,
    sampleSpanSeconds: last.blockTimestamp - first.blockTimestamp,
    firstBlockNumber: first.blockNumber,
    lastBlockNumber: last.blockNumber,
    samples: eligible,
  };
}

export function campaign2HarvestWindow(nowSec, cadenceSeconds, manifest = CAMPAIGN2_MANIFEST) {
  if (nowSec < manifest.startAt) return -1n;
  return (nowSec - manifest.startAt) / cadenceSeconds;
}

/**
 * Choose at most one write. The loop therefore has one nonce, one receipt, and one postcondition
 * boundary at a time. It never plans pause changes, claims, withdrawals, or either sweep path.
 */
export function planCampaign2Maintenance({
  snapshot,
  lastHarvestWindow = -1n,
  cadenceSeconds = 86_400n,
  autoFinalize = true,
  manifest = CAMPAIGN2_MANIFEST,
}) {
  if (cadenceSeconds < 86_400n || cadenceSeconds > 172_800n) {
    return { action: null, outcome: "blocked", reason: "cadence must be between 24 and 48 hours" };
  }
  if (!snapshot.campaign.funded || !snapshot.hookBlocks.funded) {
    return { action: null, outcome: "blocked", reason: "one or both campaign-2 legs are not funded" };
  }

  const nowSec = snapshot.blockTimestamp;
  if (nowSec < manifest.startAt) {
    return { action: null, outcome: "idle", reason: "campaign-2 window has not opened" };
  }

  if (nowSec <= manifest.endAt) {
    const harvestWindow = campaign2HarvestWindow(nowSec, cadenceSeconds, manifest);
    // Window zero was serviced by the launch-day manual harvest. The first autonomous harvest is
    // due one complete cadence after START_AT, preventing a just-installed keeper from duplicating it.
    if (!snapshot.campaign.finalized && harvestWindow > 0n && harvestWindow > lastHarvestWindow) {
      return {
        action: CAMPAIGN2_ACTIONS["staker-harvest"],
        outcome: "ready",
        reason: `staker harvest window ${harvestWindow} is due`,
        harvestWindow,
      };
    }
    if (
      !snapshot.hookBlocks.finalized
      && !snapshot.hookBlocks.buybackPaused
      && snapshot.hookBlocks.pendingWeth >= manifest.maxBuyWei
    ) {
      return {
        action: CAMPAIGN2_ACTIONS["hookr-buy-and-burn"],
        outcome: "ready",
        reason: "HookBlocks has a full immutable MAX_BUY_WEI batch",
        harvestWindow,
      };
    }
    const reason = snapshot.hookBlocks.buybackPaused
      ? "HOOKR conversion is sponsor-paused; staker harvest cadence is current"
      : "staker harvest cadence is current and HookBlocks is below its full buy cap";
    return { action: null, outcome: "idle", reason, harvestWindow };
  }

  if (autoFinalize && !snapshot.campaign.finalized) {
    return {
      action: CAMPAIGN2_ACTIONS["campaign-finalize"],
      outcome: "ready",
      reason: "the campaign window ended and the staker leg needs its final harvest and share return",
    };
  }
  if (autoFinalize && !snapshot.hookBlocks.finalized) {
    return {
      action: CAMPAIGN2_ACTIONS["hook-blocks-finalize"],
      outcome: "ready",
      reason: "the campaign window ended and HookBlocks must return its fee-share principal",
    };
  }
  if (
    !snapshot.hookBlocks.buybackPaused
    && snapshot.hookBlocks.pendingWeth >= manifest.maxBuyWei
  ) {
    return {
      action: CAMPAIGN2_ACTIONS["hookr-buy-and-burn"],
      outcome: "ready",
      reason: "post-window HookBlocks has a full immutable MAX_BUY_WEI batch",
    };
  }
  return {
    action: null,
    outcome: "idle",
    reason: snapshot.hookBlocks.buybackPaused
      ? "post-window HOOKR conversion remains sponsor-paused; no sweep is automated"
      : "finalization is complete and residual WETH is below the full buy cap; no sweep is automated",
  };
}

export function verifyCampaign2Transaction(action, transaction) {
  assertCampaign2Action(action);
  if (!sameHex(transaction?.to, action.target)) {
    throw new Error(`settled ${action.id} transaction target does not match its pinned contract`);
  }
  if (BigInt(transaction?.value ?? 0n) !== 0n) {
    throw new Error(`settled ${action.id} transaction unexpectedly transferred native value`);
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: action.abi, data: transaction.input });
  } catch (error) {
    throw new Error(`settled ${action.id} calldata is not decodable`, { cause: error });
  }
  if (decoded.functionName !== action.functionName) {
    throw new Error(`settled ${action.id} selector does not match ${action.functionName}`);
  }
  const actualArgs = decoded.args ?? [];
  if (actualArgs.length !== action.args.length) {
    throw new Error(`settled ${action.id} argument count changed`);
  }
  for (let index = 0; index < actualArgs.length; index += 1) {
    if (BigInt(actualArgs[index]) !== BigInt(action.args[index])) {
      throw new Error(`settled ${action.id} argument ${index} changed`);
    }
  }
  return decoded;
}

export function verifyCampaign2Receipt(action, receipt, transaction, block) {
  verifyCampaign2Transaction(action, transaction);
  if (!sameHex(block?.hash, receipt?.blockHash)) {
    throw new Error(`${action.id} receipt block hash does not match the canonical block`);
  }
  if (receipt.status !== "success") {
    return { outcome: "reverted", eventObserved: false };
  }
  const requiredLog = action.requiredEventTopic === null
    ? null
    : receipt.logs.find(
      (log) => sameHex(log.address, action.target) && sameHex(log.topics?.[0], action.requiredEventTopic),
    );
  const eventObserved = action.requiredEventTopic === null ? null : Boolean(requiredLog);
  if (eventObserved === false) {
    throw new Error(`${action.id} succeeded without its required postcondition event`);
  }
  let eventDetails = null;
  if (action.id === "hookr-buy-and-burn") {
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: action.abi,
        data: requiredLog.data,
        topics: requiredLog.topics,
        strict: true,
      });
    } catch (error) {
      throw new Error("campaign-2 burn receipt event is not decodable", { cause: error });
    }
    const { ethIn, hookrBought, hookrBurned, floor } = decoded.args;
    if (
      ethIn <= 0n
      || ethIn > CAMPAIGN2_MANIFEST.maxBuyWei
      || floor < action.args[0]
      || hookrBought < floor
      || hookrBurned < hookrBought
    ) {
      throw new Error("campaign-2 burn event violates the signed floor or immutable buy bounds");
    }
    eventDetails = {
      ethIn: ethIn.toString(),
      hookrBought: hookrBought.toString(),
      hookrBurned: hookrBurned.toString(),
      floor: floor.toString(),
    };
  }
  return { outcome: "finalized", eventObserved, eventDetails };
}

export async function simulateCampaign2Action({
  publicClient,
  action,
  account,
  blockNumber,
}) {
  assertCampaign2Action(action);
  const simulationAccount = account ?? "0x000000000000000000000000000000000000dEaD";
  const { request, result } = await publicClient.simulateContract({
    address: action.target,
    abi: action.abi,
    functionName: action.functionName,
    args: action.args,
    account: simulationAccount,
    blockNumber,
    gas: action.gas,
  });
  return { request, result };
}
