import { createPublicClient, http, type Address } from "viem";

import {
  ACTIVITY_FEED_LIMIT,
  ACTIVITY_FROM_BLOCK,
  AUTOMATED_RUN_EVENTS,
  aggregateActivity,
  decodeAutomatedRuns,
  emergencyExitEvent,
  executedEvent,
  policyHaltedEvent,
  zapCreatedEvent,
  type AutomatedRunLogInput,
  type CreatedLogInput,
  type ExecutedLogInput,
  type ExitLogInput,
  type PolicyHaltedLogInput,
  type ProtocolActivity,
} from "@/lib/activity";
import {
  ROBINHOOD_RPC_URL,
  configuredCapsuleFactories,
  configuredCapsuleLineageForFactory,
  robinhoodChain,
} from "@/lib/robinhood";

export interface ProtocolActivityPayload extends ProtocolActivity {
  headBlock: string;
}

const ADDRESS_CHUNK = 200;
const TIMESTAMP_BUDGET = 60;

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
  const capsuleFactories = configuredCapsuleFactories();
  const head = await client.getBlockNumber({ cacheTime: 0 });
  // Every configured factory that mints capsules, not just v1.1 — otherwise an
  // automated zap never appears in the explorer at all. ZapCreated is
  // byte-identical across the lineages, so one event ABI decodes all of them.
  const createdLogs = await client.getLogs({
    address: [...capsuleFactories],
    event: zapCreatedEvent,
    fromBlock: ACTIVITY_FROM_BLOCK,
    toBlock: head,
    strict: true,
  });

  const created = createdLogs.flatMap((log): CreatedLogInput[] =>
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

  const zapAddresses = [...new Set(created.map((log) => log.zap))];
  const haltCapableAddresses = created.flatMap((log) => {
    const lineage = configuredCapsuleLineageForFactory(log.factory)?.id;
    return lineage === "v1.2" || lineage === "v3.2" ? [log.zap] : [];
  });
  const chunks: Address[][] = [];
  for (let i = 0; i < zapAddresses.length; i += ADDRESS_CHUNK) {
    chunks.push(zapAddresses.slice(i, i + ADDRESS_CHUNK));
  }
  const haltChunks: Address[][] = [];
  for (let i = 0; i < haltCapableAddresses.length; i += ADDRESS_CHUNK) {
    haltChunks.push(haltCapableAddresses.slice(i, i + ADDRESS_CHUNK));
  }

  /** Same address-scoped window as the other queries, for one automation event. */
  const automationLogs = <T>(event: T) =>
    Promise.all(
      chunks.map((addresses) =>
        client.getLogs({ address: addresses, event: event as never, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
      ),
    );

  const [executedChunks, exitChunks, haltedChunks] = await Promise.all([
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
    Promise.all(
      haltChunks.map((addresses) =>
        client.getLogs({ address: addresses, event: policyHaltedEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
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
  const halted = haltedChunks.flat().flatMap((log): PolicyHaltedLogInput[] =>
    log.args?.owner && log.args?.policyHash
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

  // Automated runs: recurring, relative-floor recurring, and one-shot triggers.
  // Each is scoped to the same canonical zap set as Executed/EmergencyExit, and
  // a chain with no v3 capsules simply returns empty arrays.
  const automated: AutomatedRunLogInput[] = (
    await Promise.all(
      AUTOMATED_RUN_EVENTS.map(async ({ event, kind }) =>
        decodeAutomatedRuns((await automationLogs(event)).flat() as never, kind),
      ),
    )
  ).flat();

  // Spend the timestamp budget on the newest blocks — the rows the feed will
  // actually display — and treat every timestamp as optional: one failed
  // getBlock leaves that row's timestamp null instead of failing the payload.
  const newestBlocks = [...new Set([...created, ...executed, ...exits, ...automated, ...halted].map((log) => log.blockNumber))]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, Math.max(TIMESTAMP_BUDGET, ACTIVITY_FEED_LIMIT));
  const timestamps = new Map<bigint, number>();
  await Promise.allSettled(
    newestBlocks.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      timestamps.set(blockNumber, Number(block.timestamp));
    }),
  );

  const payload = aggregateActivity(
    created,
    executed,
    exits,
    automated,
    timestamps,
    new Date().toISOString(),
    halted,
  );
  return { ...payload, headBlock: head.toString() };
}
