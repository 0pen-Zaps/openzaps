import { createPublicClient, http, type Address } from "viem";

import {
  ACTIVITY_FEED_LIMIT,
  ACTIVITY_FROM_BLOCK,
  aggregateActivity,
  emergencyExitEvent,
  executedEvent,
  zapCreatedEvent,
  type CreatedLogInput,
  type ExecutedLogInput,
  type ExitLogInput,
  type ProtocolActivity,
} from "@/lib/activity";
import { OPENZAP_CONTRACTS, ROBINHOOD_RPC_URL, robinhoodChain } from "@/lib/robinhood";

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
  const head = await client.getBlockNumber();
  const createdLogs = await client.getLogs({
    address: OPENZAP_CONTRACTS.factory,
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

  // Spend the timestamp budget on the newest blocks — the rows the feed will
  // actually display — and treat every timestamp as optional: one failed
  // getBlock leaves that row's timestamp null instead of failing the payload.
  const newestBlocks = [...new Set([...created, ...executed, ...exits].map((log) => log.blockNumber))]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, Math.max(TIMESTAMP_BUDGET, ACTIVITY_FEED_LIMIT));
  const timestamps = new Map<bigint, number>();
  await Promise.allSettled(
    newestBlocks.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      timestamps.set(blockNumber, Number(block.timestamp));
    }),
  );

  const payload = aggregateActivity(created, executed, exits, timestamps, new Date().toISOString());
  return { ...payload, headBlock: head.toString() };
}
