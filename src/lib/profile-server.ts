import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";

import {
  ACTIVITY_FROM_BLOCK,
  emergencyExitEvent,
  executedEvent,
  executedRecurringEvent,
  executedRecurringRelativeEvent,
  executedTriggerEvent,
  zapCreatedEvent,
  type AutomatedRunLogInput,
  type ExecutedLogInput,
  type ExitLogInput,
} from "@/lib/activity";
import {
  aggregateWalletProfile,
  nonceInvalidatedEvent,
  seriesFinishedEvent,
  type NonceInvalidatedLogInput,
  type SeriesFinishedLogInput,
  type WalletCreationLogInput,
  type WalletProfilePayload,
  type WalletZapRead,
} from "@/lib/profile";
import {
  OPENZAP_CONTRACTS,
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  ROBINHOOD_RPC_URL,
  openZapAbi,
  openZapProtocolConfigured,
  openZapV3Configured,
  openZapV3_1Configured,
  robinhoodChain,
} from "@/lib/robinhood";

const ADDRESS_CHUNK = 200;
const TIMESTAMP_BUDGET = 250;

const CAPSULE_FACTORIES: Address[] = [
  ...new Map(
    [OPENZAP_CONTRACTS.factory, OPENZAP_V3_CONTRACTS.factory, OPENZAP_V3_1_CONTRACTS.factory]
      .map((address) => [address.toLowerCase(), address] as const),
  ).values(),
];

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/**
 * Complete confirmed history for one owner across the v1.1, v3, and v3.1
 * factories. Throws on an authoritative RPC failure so the route can return an
 * explicit unavailable response instead of a fabricated empty dashboard.
 */
export async function fetchWalletProfile(ownerInput: Address): Promise<WalletProfilePayload> {
  assertConfigured();
  const owner = getAddress(ownerInput);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const creationLogs = await client.getLogs({
    address: CAPSULE_FACTORIES,
    event: zapCreatedEvent,
    args: { owner },
    fromBlock: ACTIVITY_FROM_BLOCK,
    toBlock: head,
    strict: true,
  });

  const created = creationLogs.flatMap((log): WalletCreationLogInput[] =>
    log.args?.zap && log.args?.owner && log.args?.policyHash
      ? [{
          zap: log.args.zap,
          owner: log.args.owner,
          factory: log.address,
          policyHash: log.args.policyHash,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [],
  );
  const zapAddresses = [...new Map(created.map((log) => [log.zap.toLowerCase(), getAddress(log.zap)])).values()];
  const chunks = chunk(zapAddresses, ADDRESS_CHUNK);

  const logsFor = <T>(event: T): Promise<unknown[][]> => Promise.all(
    chunks.map((addresses) => client.getLogs({
      address: addresses,
      event: event as never,
      fromBlock: ACTIVITY_FROM_BLOCK,
      toBlock: head,
      strict: true,
    }) as Promise<unknown[]>),
  );

  const [executedChunks, exitChunks, recurringChunks, relativeChunks, triggerChunks, invalidatedChunks, finishedChunks] =
    await Promise.all([
      logsFor(executedEvent),
      logsFor(emergencyExitEvent),
      logsFor(executedRecurringEvent),
      logsFor(executedRecurringRelativeEvent),
      logsFor(executedTriggerEvent),
      logsFor(nonceInvalidatedEvent),
      logsFor(seriesFinishedEvent),
    ]);

  const executed = decodeExecuted(executedChunks.flat() as EventLog[]);
  const exits = decodeExits(exitChunks.flat() as EventLog[]);
  const automated: AutomatedRunLogInput[] = [
    ...decodeAutomated(recurringChunks.flat() as EventLog[], "recurring"),
    ...decodeAutomated(relativeChunks.flat() as EventLog[], "recurring-relative"),
    ...decodeAutomated(triggerChunks.flat() as EventLog[], "trigger"),
  ];
  const invalidated = decodeInvalidated(invalidatedChunks.flat() as EventLog[]);
  const finished = decodeFinished(finishedChunks.flat() as EventLog[]);

  const trackedResults = await Promise.allSettled(
    zapAddresses.map(async (zap): Promise<WalletZapRead> => ({
      zap,
      trackedAssets: await client.readContract({
        address: zap,
        abi: openZapAbi,
        functionName: "trackedAssets",
        blockNumber: head,
      }),
    })),
  );
  const zapReads: WalletZapRead[] = trackedResults.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { zap: zapAddresses[index], trackedAssets: null },
  );

  const allLogs: { blockNumber: bigint }[] = [
    ...created,
    ...executed,
    ...exits,
    ...automated,
    ...invalidated,
    ...finished,
  ];
  const newestBlocks = [...new Set(allLogs.map((log) => log.blockNumber))]
    .sort((a, b) => a < b ? 1 : -1)
    .slice(0, TIMESTAMP_BUDGET);
  const timestamps = new Map<bigint, number>();
  await Promise.allSettled(newestBlocks.map(async (blockNumber) => {
    const block = await client.getBlock({ blockNumber });
    timestamps.set(blockNumber, Number(block.timestamp));
  }));

  return aggregateWalletProfile({
    owner,
    created,
    executed,
    automated,
    exits,
    invalidated,
    finished,
    zapReads,
    timestamps,
    fromBlock: ACTIVITY_FROM_BLOCK,
    headBlock: head,
    updatedAt: new Date().toISOString(),
  });
}

type EventArgs = {
  recipient?: Address;
  outAsset?: Address;
  amountOut?: bigint;
  owner?: Address;
  asset?: Address;
  amount?: bigint;
  seriesId?: bigint;
  nonce?: bigint;
  run?: number;
  executor?: Address;
  executorFee?: bigint;
  potFee?: bigint;
  runs?: number;
};

type EventLog = {
  address: Address;
  args?: EventArgs;
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
};

function decodeExecuted(logs: readonly EventLog[]): ExecutedLogInput[] {
  return logs.flatMap((log) => {
    const args = log.args;
    return args?.recipient && args.outAsset && args.amountOut !== undefined
      ? [{
          emitter: log.address,
          recipient: args.recipient,
          outAsset: args.outAsset,
          amountOut: args.amountOut,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [];
  });
}

function decodeExits(logs: readonly EventLog[]): ExitLogInput[] {
  return logs.flatMap((log) => {
    const args = log.args;
    return args?.owner && args.asset && args.amount !== undefined
      ? [{
          emitter: log.address,
          owner: args.owner,
          asset: args.asset,
          amount: args.amount,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [];
  });
}

function decodeAutomated(
  logs: readonly EventLog[],
  kind: AutomatedRunLogInput["kind"],
): AutomatedRunLogInput[] {
  return logs.flatMap((log) => {
    const args = log.args;
    if (!args?.executor || !args.outAsset || args.amountOut === undefined) return [];
    return [{
      emitter: log.address,
      kind,
      executor: args.executor,
      outAsset: args.outAsset,
      amountOut: args.amountOut,
      executorFee: args.executorFee ?? 0n,
      potFee: args.potFee ?? 0n,
      seriesId: args.seriesId ?? args.nonce ?? 0n,
      run: args.run === undefined ? null : Number(args.run),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
    }];
  });
}

function decodeInvalidated(logs: readonly EventLog[]): NonceInvalidatedLogInput[] {
  return logs.flatMap((log) => log.args?.nonce !== undefined
    ? [{
        emitter: log.address,
        nonce: log.args.nonce,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      }]
    : [],
  );
}

function decodeFinished(logs: readonly EventLog[]): SeriesFinishedLogInput[] {
  return logs.flatMap((log) => log.args?.seriesId !== undefined && log.args.runs !== undefined
    ? [{
        emitter: log.address,
        seriesId: log.args.seriesId,
        runs: Number(log.args.runs),
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      }]
    : [],
  );
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < values.length; index += size) rows.push(values.slice(index, index + size));
  return rows;
}

function assertConfigured(): void {
  if (!openZapProtocolConfigured() || !openZapV3Configured() || !openZapV3_1Configured()) {
    throw new Error("Every OpenZap lineage must be configured before reporting complete wallet activity.");
  }
}
