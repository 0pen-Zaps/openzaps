import { createPublicClient, getAddress, http, type Address } from "viem";

import {
  ACTIVITY_FEED_LIMIT,
  ACTIVITY_FROM_BLOCK,
  emergencyExitEvent,
  executedEvent,
  zapCreatedEvent,
} from "@/lib/activity";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  ROBINHOOD_RPC_URL,
  erc20Abi,
  openZapAbi,
  openZapFactoryAbi,
  openZapProtocolConfigured,
  robinhoodChain,
} from "@/lib/robinhood";
import {
  ZapNotFoundError,
  aggregateZapDetail,
  newestZapCreations,
  stepsToRead,
  type ZapCreatedLogInput,
  type ZapDetailPayload,
  type ZapExecutedLogInput,
  type ZapExitLogInput,
  type ZapStepRead,
  type ZapSummary,
  type ZapSummaryPage,
} from "@/lib/zap";

const ADDRESS_CHUNK = 200;
const TIMESTAMP_BUDGET = 60;

/**
 * How long one factory scan may keep answering "is this address a zap?".
 *
 * Provenance is the only question an unknown address gets to ask, and the
 * answer for *every* address lives in a single unfiltered ZapCreated scan
 * (~14 logs, ~60ms today). Memoising that one scan is what stops a walk over
 * arbitrary 40-hex strings from turning into one chain scan per string: after
 * the first, unknown addresses cost a map lookup. The window is short because
 * the memo also decides 404s.
 */
const FACTORY_SNAPSHOT_TTL_MS = 10_000;

/**
 * A miss is the answer that 404s a page, so before one is allowed to stand the
 * memo is rebuilt from a scan that starts *after* the question was asked.
 *
 * Bounding this by elapsed time instead — "a snapshot at most N ms old may deny"
 * — is what made an earlier revision wrong: /app links straight to a capsule's
 * page the instant `createZap` confirms, and any non-zero window is a window in
 * which that link 404s a capsule the user just watched confirm. `0` forces the
 * rescan; `requireCreation` is what keeps the cost of forcing it proportionate.
 */
const FACTORY_MISS_MAX_AGE_MS = 0;

/**
 * How long a failed scan is remembered before another is attempted. The
 * unverified renders hold for only 15s by design, so during an RPC outage they
 * come back around often; without this, each one would open another connection
 * to a host that is already known to be down. The remembered failure is
 * rethrown, never downgraded into "not a zap": a scan that did not happen is
 * not evidence that an address is not a capsule, and a 404 built on one would
 * be exactly the fabrication this reader exists to avoid.
 */
const FACTORY_FAILURE_BACKOFF_MS = 2_000;

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/**
 * Robinhood Chain seals ~10 blocks a second, so viem's default 4s block-number
 * cache leaves `head` up to ~40 blocks behind the tip. Pinning a snapshot to a
 * stale head hides everything mined since — including the ZapCreated log of a
 * capsule deployed moments ago, which would then read as "not a zap". Every
 * pinned block is read fresh; the reads it pins are still one consistent block.
 */
function currentHead(): Promise<bigint> {
  return client.getBlockNumber({ cacheTime: 0 });
}

/** The factory's full creation set at one block, plus when it was read. */
type FactorySnapshot = {
  head: bigint;
  created: ZapCreatedLogInput[];
  /**
   * Keyed by checksummed address — `getAddress` is the canonical form on both
   * sides, so a lookup never depends on how the RPC or the URL spelled it.
   */
  byAddress: Map<Address, ZapCreatedLogInput>;
  readAtMs: number;
};

let factoryCache: FactorySnapshot | null = null;
let factoryInFlight: Promise<FactorySnapshot> | null = null;
let factoryFailure: { error: unknown; atMs: number } | null = null;

/**
 * Serve the factory's creation set from memo when it is younger than
 * `maxAgeMs`, otherwise rescan. Concurrent callers share one in-flight scan, so
 * a burst of distinct addresses costs one RPC round trip between them.
 *
 * A snapshot too stale for the caller's tolerance is never served as if it were
 * fresh, and a failed scan is never memoised as data. Both cases reject, which
 * callers surface as "unavailable" — the only honest answer when the read the
 * decision depends on did not happen.
 */
function factorySnapshot(maxAgeMs: number): Promise<FactorySnapshot> {
  const cached = factoryCache;
  if (cached && Date.now() - cached.readAtMs <= maxAgeMs) return Promise.resolve(cached);

  const failed = factoryFailure;
  if (failed && Date.now() - failed.atMs <= FACTORY_FAILURE_BACKOFF_MS) {
    return Promise.reject(failed.error);
  }

  if (!factoryInFlight) {
    const scan = readFactorySnapshot();
    factoryInFlight = scan;
    void scan.then(
      (snapshot) => {
        factoryCache = snapshot;
        factoryFailure = null;
        factoryInFlight = null;
      },
      (error: unknown) => {
        factoryFailure = { error, atMs: Date.now() };
        factoryInFlight = null;
      },
    );
  }
  return factoryInFlight;
}

async function readFactorySnapshot(): Promise<FactorySnapshot> {
  assertConfigured();
  const head = await currentHead();

  const createdLogs = await client.getLogs({
    address: OPENZAP_CONTRACTS.factory,
    event: zapCreatedEvent,
    fromBlock: ACTIVITY_FROM_BLOCK,
    toBlock: head,
    strict: true,
  });

  const created = createdLogs.flatMap((log): ZapCreatedLogInput[] =>
    log.args?.zap && log.args?.owner && log.args?.policyHash && log.args?.implCodeHash && log.args?.salt
      ? [{
          zap: getAddress(log.args.zap),
          owner: getAddress(log.args.owner),
          policyHash: log.args.policyHash,
          implCodeHash: log.args.implCodeHash,
          salt: log.args.salt,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [],
  );

  const byAddress = new Map<Address, ZapCreatedLogInput>();
  for (const log of created) {
    // First log wins: if the RPC ever repeats one, the earliest is the creation.
    if (!byAddress.has(log.zap)) byAddress.set(log.zap, log);
  }

  return { head, created, byAddress, readAtMs: Date.now() };
}

/**
 * Resolve an address to its ZapCreated log, or throw ZapNotFoundError.
 *
 * A stale memo may only be trusted to say *yes*: a creation log is immutable,
 * so an address in the set is a zap forever. Saying *no* is a 404, so a miss
 * against a snapshot older than FACTORY_MISS_MAX_AGE_MS is rechecked against a
 * fresh scan before the denial is allowed to stand.
 */
async function requireCreation(address: Address): Promise<ZapCreatedLogInput> {
  const cached = await factorySnapshot(FACTORY_SNAPSHOT_TTL_MS);
  const known = cached.byAddress.get(address);
  if (known) return known;

  // Bytecode settles the overwhelming majority of misses without a rescan, and
  // it is the one question whose answer cannot be stale in the direction that
  // hurts: an address with no code at this block was never deployed, so it is
  // not a capsule and never briefly was one. That makes a walk over arbitrary
  // 40-hex strings cost one `eth_getCode` each instead of a chain scan, and
  // leaves the forced rescan below for the only case that can actually race —
  // a contract that exists but is missing from the memo.
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") throw new ZapNotFoundError(address);

  const fresh = await factorySnapshot(FACTORY_MISS_MAX_AGE_MS);
  const rechecked = fresh.byAddress.get(address);
  if (rechecked) return rechecked;

  throw new ZapNotFoundError(address);
}

/**
 * Read one zap's full onchain story. Provenance is the gate, and it runs first
 * and alone: without a ZapCreated log emitted by the canonical factory for this
 * exact address, nothing else is read and nothing is reported. Only once that
 * passes does the ~20-call snapshot run, every event query scoped to the proven
 * address and every read pinned to a single freshly read head block, so the
 * page is one consistent snapshot rather than a stitched one.
 * Throws on RPC failure — callers decide how to fail closed.
 */
export async function fetchZapDetail(zapAddress: Address): Promise<ZapDetailPayload> {
  assertConfigured();
  const address = getAddress(zapAddress);
  const created = await requireCreation(address);
  const head = await currentHead();

  const [runtime, implementation, version, owner, recipient, maxRelayerFeeCap, optimization, trackedAssets, stepCount, policyHash] =
    await Promise.all([
      client.getCode({ address, blockNumber: head }),
      client.readContract({ address: OPENZAP_CONTRACTS.factory, abi: openZapFactoryAbi, functionName: "implementation", blockNumber: head }),
      client.readContract({ address: OPENZAP_CONTRACTS.factory, abi: openZapFactoryAbi, functionName: "VERSION", blockNumber: head }),
      client.readContract({ address, abi: openZapAbi, functionName: "owner", blockNumber: head }),
      client.readContract({ address, abi: openZapAbi, functionName: "recipient", blockNumber: head }),
      client.readContract({ address, abi: openZapAbi, functionName: "maxRelayerFeeCap", blockNumber: head }),
      client.readContract({ address, abi: openZapAbi, functionName: "optimization", blockNumber: head }),
      client.readContract({ address, abi: openZapAbi, functionName: "trackedAssets", blockNumber: head }),
      client.readContract({ address, abi: openZapAbi, functionName: "stepCount", blockNumber: head }),
      client.readContract({ address, abi: openZapAbi, functionName: "policyHash", blockNumber: head }),
    ]);

  // step(i) reverts past stepCount, so only read indices the zap declares, and
  // stop at the cap so a hostile stepCount cannot fan out into unbounded calls.
  const readableSteps = stepsToRead(stepCount);
  const steps: readonly ZapStepRead[] = await Promise.all(
    Array.from({ length: readableSteps }, (_, index) =>
      client.readContract({ address, abi: openZapAbi, functionName: "step", args: [BigInt(index)], blockNumber: head }),
    ),
  );

  const [wethBalance, zapsBalance, nativeBalance, executedLogs, exitLogs] = await Promise.all([
    client.readContract({ address: ROBINHOOD_ASSETS.weth, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber: head }),
    client.readContract({ address: ROBINHOOD_ASSETS.zaps, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber: head }),
    client.getBalance({ address, blockNumber: head }),
    client.getLogs({ address, event: executedEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
    client.getLogs({ address, event: emergencyExitEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
  ]);

  const executed = executedLogs.flatMap((log): ZapExecutedLogInput[] =>
    log.args?.nonce !== undefined &&
    log.args?.recipient &&
    log.args?.outAsset &&
    log.args?.amountOut !== undefined &&
    log.args?.fee !== undefined
      ? [{
          emitter: log.address,
          nonce: log.args.nonce,
          recipient: log.args.recipient,
          outAsset: log.args.outAsset,
          amountOut: log.args.amountOut,
          fee: log.args.fee,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [],
  );

  const exits = exitLogs.flatMap((log): ZapExitLogInput[] =>
    log.args?.owner && log.args?.asset && log.args?.amount !== undefined
      ? [{
          emitter: log.address,
          owner: log.args.owner,
          asset: log.args.asset,
          amount: log.args.amount,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [],
  );

  // The creation block always gets a timestamp — it anchors the provenance
  // card — and the rest of the budget goes to the newest event blocks.
  const eventBlocks = newestBlocks([...executed, ...exits], TIMESTAMP_BUDGET);
  const timestamps = await fetchTimestamps([created.blockNumber, ...eventBlocks]);

  return aggregateZapDetail({
    address,
    created,
    policy: { owner, recipient, maxRelayerFeeCap, optimization, trackedAssets, stepCount, steps, policyHash },
    factory: { version, implementation },
    runtime: runtime ?? null,
    balances: { weth: wethBalance, zaps: zapsBalance, native: nativeBalance },
    executed,
    exits,
    timestamps,
    headBlock: head,
    readAt: new Date().toISOString(),
  });
}

/**
 * List the newest zaps for the index, with the true size of the set beside
 * them so a truncated list can never be printed as a total. Execution counts
 * come from Executed logs address-scoped to the factory's own ZapCreated set —
 * never from nonceUsed, which invalidateNonce sets too and which would
 * overcount executions. Throws on RPC failure — callers decide how to fail
 * closed.
 */
export async function fetchZapSummaries(limit: number = ACTIVITY_FEED_LIMIT): Promise<ZapSummaryPage> {
  assertConfigured();
  // Same memoised scan the provenance gate uses, and the same pinned head, so
  // an execution can never be counted for a capsule the list does not contain.
  const snapshot = await factorySnapshot(FACTORY_SNAPSHOT_TTL_MS);
  const head = snapshot.head;
  const { rows: created, total, truncated } = newestZapCreations(snapshot.created, limit);

  const zapAddresses = [...new Set(created.map((log) => log.zap))];
  const chunks: Address[][] = [];
  for (let i = 0; i < zapAddresses.length; i += ADDRESS_CHUNK) {
    chunks.push(zapAddresses.slice(i, i + ADDRESS_CHUNK));
  }

  const executedChunks = await Promise.all(
    chunks.map((addresses) =>
      client.getLogs({ address: addresses, event: executedEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
    ),
  );

  const executionCounts = new Map<Address, number>();
  const lastExecutionBlock = new Map<Address, bigint>();
  for (const log of executedChunks.flat()) {
    const emitter = getAddress(log.address);
    executionCounts.set(emitter, (executionCounts.get(emitter) ?? 0) + 1);
    const previous = lastExecutionBlock.get(emitter);
    if (previous === undefined || log.blockNumber > previous) {
      lastExecutionBlock.set(emitter, log.blockNumber);
    }
  }

  // Timestamp cost scales with the rows the index will actually render, and the
  // union of creation and last-execution blocks fits inside that budget.
  const timestamps = await fetchTimestamps(
    newestBlocks(
      [...created, ...[...lastExecutionBlock.values()].map((blockNumber) => ({ blockNumber }))],
      Math.max(TIMESTAMP_BUDGET, created.length * 2),
    ),
  );

  const rows = created.map((log): ZapSummary => {
    const executedAt = lastExecutionBlock.get(log.zap);
    return {
      address: log.zap,
      owner: log.owner,
      createdBlock: log.blockNumber.toString(),
      createdTx: log.txHash,
      createdAt: timestamps.get(log.blockNumber) ?? null,
      policyHash: log.policyHash,
      executionCount: executionCounts.get(log.zap) ?? 0,
      lastExecutionAt: executedAt === undefined ? null : timestamps.get(executedAt) ?? null,
    };
  });

  return { rows, total, truncated };
}

/**
 * A malformed env override collapses a contract address to zeroAddress, which
 * would make every query return nothing and the page claim an empty history.
 */
function assertConfigured(): void {
  if (!openZapProtocolConfigured()) {
    throw new Error("OpenZap contract addresses are not configured; refusing to report zap state.");
  }
}

function newestBlocks(logs: readonly { blockNumber: bigint }[], budget: number): bigint[] {
  return [...new Set(logs.map((log) => log.blockNumber))]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, budget);
}

/** Every timestamp is optional: one failed getBlock nulls one row, not the payload. */
async function fetchTimestamps(blocks: readonly bigint[]): Promise<Map<bigint, number>> {
  const timestamps = new Map<bigint, number>();
  await Promise.allSettled(
    [...new Set(blocks)].map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      timestamps.set(blockNumber, Number(block.timestamp));
    }),
  );
  return timestamps;
}
