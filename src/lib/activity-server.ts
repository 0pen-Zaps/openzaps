import { createPublicClient, http, type Address, type Hex } from "viem";

import {
  ACTIVITY_FEED_LIMIT,
  ACTIVITY_FROM_BLOCK,
  aggregateActivity,
  emergencyExitEvent,
  executedEvent,
  executedRecurringEvent,
  executedRecurringRelativeEvent,
  executedTriggerEvent,
  zapCreatedEvent,
  type AutomatedRunLogInput,
  type CreatedLogInput,
  type ExecutedLogInput,
  type ExitLogInput,
  type ProtocolActivity,
} from "@/lib/activity";
import {
  OPENZAP_CONTRACTS,
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  ROBINHOOD_RPC_URL,
  robinhoodChain,
} from "@/lib/robinhood";

export interface ProtocolActivityPayload extends ProtocolActivity {
  headBlock: string;
}

const ADDRESS_CHUNK = 200;
const TIMESTAMP_BUDGET = 60;

/**
 * Every factory whose clones are protocol capsules. Deduped and lowercase-keyed
 * because v3 and v3.1 can share an address in a preview config; a duplicate here
 * would double-count creations.
 */
const CAPSULE_FACTORIES: Address[] = [
  ...new Map(
    [OPENZAP_CONTRACTS.factory, OPENZAP_V3_CONTRACTS.factory, OPENZAP_V3_1_CONTRACTS.factory].map(
      (address) => [address.toLowerCase(), address] as const,
    ),
  ).values(),
];

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/**
 * Read the complete protocol history from chain logs. The Executed and
 * EmergencyExit queries are address-scoped to the factory's own ZapCreated
 * set, so spoofed events from foreign contracts never reach the RPC response,
 * result-count caps scale with protocol usage instead of chain-wide noise,
 * and aggregateActivity's emitter filter remains as defense in depth.
 * Throws on RPC failure — callers decide how to fail closed.
 */
export async function fetchProtocolActivity(): Promise<ProtocolActivityPayload> {
  const head = await client.getBlockNumber();
  // Every factory that mints capsules, not just v1.1 — otherwise an automated
  // (v3 / v3.1) zap never appears in the explorer at all. ZapCreated is
  // byte-identical across the three, so one event ABI decodes all of them.
  const createdLogs = await client.getLogs({
    address: CAPSULE_FACTORIES,
    event: zapCreatedEvent,
    fromBlock: ACTIVITY_FROM_BLOCK,
    toBlock: head,
    strict: true,
  });

  const created = createdLogs.flatMap((log): CreatedLogInput[] =>
    log.args?.zap && log.args?.owner
      ? [{
          zap: log.args.zap,
          owner: log.args.owner,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [],
  );

  const zapAddresses = [...new Set(created.map((log) => log.zap))];
  const chunks: Address[][] = [];
  for (let i = 0; i < zapAddresses.length; i += ADDRESS_CHUNK) {
    chunks.push(zapAddresses.slice(i, i + ADDRESS_CHUNK));
  }

  /** Same address-scoped window as the other queries, for one automation event. */
  const automationLogs = <T>(event: T) =>
    Promise.all(
      chunks.map((addresses) =>
        client.getLogs({ address: addresses, event: event as never, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
      ),
    );

  const [executedChunks, exitChunks] = await Promise.all([
    Promise.all(
      chunks.map((addresses) =>
        client.getLogs({ address: addresses, event: executedEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
      ),
    ),
    Promise.all(
      chunks.map((addresses) =>
        client.getLogs({ address: addresses, event: emergencyExitEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
      ),
    ),
  ]);

  const executed = executedChunks.flat().flatMap((log): ExecutedLogInput[] =>
    log.args?.recipient && log.args?.outAsset && log.args?.amountOut !== undefined
      ? [{
          emitter: log.address,
          recipient: log.args.recipient,
          outAsset: log.args.outAsset,
          amountOut: log.args.amountOut,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        }]
      : [],
  );
  const exits = exitChunks.flat().flatMap((log): ExitLogInput[] =>
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

  // Automated runs: recurring, relative-floor recurring, and one-shot triggers.
  // Each is scoped to the same canonical zap set as Executed/EmergencyExit, and
  // a chain with no v3 capsules simply returns three empty arrays.
  const [recurringChunks, relativeChunks, triggerChunks] = await Promise.all([
    automationLogs(executedRecurringEvent),
    automationLogs(executedRecurringRelativeEvent),
    automationLogs(executedTriggerEvent),
  ]);

  type AutomationArgs = {
    seriesId?: bigint;
    nonce?: bigint;
    run?: number;
    executor?: Address;
    outAsset?: Address;
    amountOut?: bigint;
    executorFee?: bigint;
    potFee?: bigint;
  };
  const decodeAutomated = (
    logs: readonly { address: Address; args?: AutomationArgs; transactionHash: Hex; blockNumber: bigint; logIndex: number }[],
    kind: AutomatedRunLogInput["kind"],
  ): AutomatedRunLogInput[] =>
    logs.flatMap((log) => {
      const a = log.args;
      if (!a?.executor || !a.outAsset || a.amountOut === undefined) return [];
      return [{
        emitter: log.address,
        kind,
        executor: a.executor,
        outAsset: a.outAsset,
        amountOut: a.amountOut,
        executorFee: a.executorFee ?? 0n,
        potFee: a.potFee ?? 0n,
        seriesId: a.seriesId ?? a.nonce ?? 0n,
        run: a.run === undefined ? null : Number(a.run),
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      }];
    });

  const automated: AutomatedRunLogInput[] = [
    ...decodeAutomated(recurringChunks.flat() as never, "recurring"),
    ...decodeAutomated(relativeChunks.flat() as never, "recurring-relative"),
    ...decodeAutomated(triggerChunks.flat() as never, "trigger"),
  ];

  // Spend the timestamp budget on the newest blocks — the rows the feed will
  // actually display — and treat every timestamp as optional: one failed
  // getBlock leaves that row's timestamp null instead of failing the payload.
  const newestBlocks = [...new Set([...created, ...executed, ...exits, ...automated].map((log) => log.blockNumber))]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, Math.max(TIMESTAMP_BUDGET, ACTIVITY_FEED_LIMIT));
  const timestamps = new Map<bigint, number>();
  await Promise.allSettled(
    newestBlocks.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      timestamps.set(blockNumber, Number(block.timestamp));
    }),
  );

  const payload = aggregateActivity(created, executed, exits, automated, timestamps, new Date().toISOString());
  return { ...payload, headBlock: head.toString() };
}
