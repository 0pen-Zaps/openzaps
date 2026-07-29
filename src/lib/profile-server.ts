import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";

import {
  ACTIVITY_FROM_BLOCK,
  emergencyExitEvent,
  executedEvent,
  executedRecurringEvent,
  executedRecurringRelativeEvent,
  executedRecurringStackEvent,
  executedTriggerEvent,
  policyHaltedEvent,
  zapCreatedEvent,
  type AutomatedRunLogInput,
  type ExecutedLogInput,
  type ExitLogInput,
  type PolicyHaltedLogInput,
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
  ROBINHOOD_RPC_URL,
  configuredCapsuleLineageForFactory,
  configuredCapsuleFactories,
  openZapAbi,
  openZapPolicyHaltAbi,
  robinhoodChain,
} from "@/lib/robinhood";

const ADDRESS_CHUNK = 200;
const TIMESTAMP_BUDGET = 250;

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/**
 * Complete confirmed history for one owner across every configured lineage
 * factories. Throws on an authoritative RPC failure so the route can return an
 * explicit unavailable response instead of a fabricated empty dashboard.
 */
export async function fetchWalletProfile(ownerInput: Address): Promise<WalletProfilePayload> {
  const capsuleFactories = configuredCapsuleFactories();
  const owner = getAddress(ownerInput);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const creationLogs = await client.getLogs({
    address: [...capsuleFactories],
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
  const creationByZap = new Map(created.map((log) => [getAddress(log.zap), log]));
  const haltCapableAddresses = zapAddresses.filter((zap) => {
    const creation = creationByZap.get(zap);
    const lineage = creation ? configuredCapsuleLineageForFactory(creation.factory)?.id : null;
    return lineage === "v1.2" || lineage === "v3.2";
  });
  const chunks = chunk(zapAddresses, ADDRESS_CHUNK);
  const haltChunks = chunk(haltCapableAddresses, ADDRESS_CHUNK);

  const logsFor = <T>(event: T, addressChunks: readonly Address[][] = chunks): Promise<unknown[][]> => Promise.all(
    addressChunks.map((addresses) => client.getLogs({
      address: addresses,
      event: event as never,
      fromBlock: ACTIVITY_FROM_BLOCK,
      toBlock: head,
      strict: true,
    }) as Promise<unknown[]>),
  );

  const [
    executedChunks,
    exitChunks,
    recurringChunks,
    relativeChunks,
    stackChunks,
    triggerChunks,
    invalidatedChunks,
    finishedChunks,
    haltedChunks,
  ] =
    await Promise.all([
      logsFor(executedEvent),
      logsFor(emergencyExitEvent),
      logsFor(executedRecurringEvent),
      logsFor(executedRecurringRelativeEvent),
      logsFor(executedRecurringStackEvent),
      logsFor(executedTriggerEvent),
      logsFor(nonceInvalidatedEvent),
      logsFor(seriesFinishedEvent),
      logsFor(policyHaltedEvent, haltChunks),
    ]);

  const executed = decodeExecuted(executedChunks.flat() as EventLog[]);
  const exits = decodeExits(exitChunks.flat() as EventLog[]);
  const automated: AutomatedRunLogInput[] = [
    ...decodeAutomated(recurringChunks.flat() as EventLog[], "recurring"),
    ...decodeAutomated(relativeChunks.flat() as EventLog[], "recurring-relative"),
    ...decodeAutomated(stackChunks.flat() as EventLog[], "recurring-stack"),
    ...decodeAutomated(triggerChunks.flat() as EventLog[], "trigger"),
  ];
  const invalidated = decodeInvalidated(invalidatedChunks.flat() as EventLog[]);
  const finished = decodeFinished(finishedChunks.flat() as EventLog[]);
  const halted = decodeHalted(haltedChunks.flat() as EventLog[]);

  const zapReads = await Promise.all(
    zapAddresses.map(async (zap): Promise<WalletZapRead> => {
      const creation = creationByZap.get(zap);
      const lineage = creation ? configuredCapsuleLineageForFactory(creation.factory)?.id : null;
      const haltCapable = lineage === "v1.2" || lineage === "v3.2";
      const [trackedResult, haltedResult] = await Promise.allSettled([
        client.readContract({
        address: zap,
        abi: openZapAbi,
        functionName: "trackedAssets",
        blockNumber: head,
      }),
        haltCapable
          ? client.readContract({
              address: zap,
              abi: openZapPolicyHaltAbi,
              functionName: "policyHalted",
              blockNumber: head,
            })
          : Promise.resolve(null),
      ]);
      return {
        zap,
        trackedAssets: trackedResult.status === "fulfilled" ? trackedResult.value : null,
        policyHalted: haltedResult.status === "fulfilled" ? haltedResult.value : null,
      };
    }),
  );

  const allLogs: { blockNumber: bigint }[] = [
    ...created,
    ...executed,
    ...exits,
    ...automated,
    ...invalidated,
    ...finished,
    ...halted,
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
    halted,
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
  stackIn?: bigint;
  zapsOut?: bigint;
  runs?: number;
  policyHash?: Hex;
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
    if (kind === "recurring-stack" && (args.stackIn === undefined || args.zapsOut === undefined)) return [];
    return [{
      emitter: log.address,
      kind,
      executor: args.executor,
      outAsset: args.outAsset,
      amountOut: args.amountOut,
      executorFee: args.executorFee ?? 0n,
      potFee: args.potFee ?? 0n,
      stackIn: kind === "recurring-stack" ? args.stackIn ?? null : null,
      zapsOut: kind === "recurring-stack" ? args.zapsOut ?? null : null,
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

function decodeHalted(logs: readonly EventLog[]): PolicyHaltedLogInput[] {
  return logs.flatMap((log) => log.args?.owner && log.args.policyHash
    ? [{
        emitter: log.address,
        owner: log.args.owner,
        policyHash: log.args.policyHash,
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
