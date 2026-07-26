import { createPublicClient, http, type Address } from "viem";

import {
  POT_FEE_ASSETS,
  potAbi,
  toPendingAsset,
  type PotSnapshot,
} from "@/lib/pot";
import {
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  ROBINHOOD_RPC_URL,
  erc20Abi,
  robinhoodChain,
} from "@/lib/robinhood";

export interface PotPayload {
  pots: PotSnapshot[];
  headBlock: string;
  readAt: string;
}

interface PotCore {
  address: Address;
  label: string;
  round: string;
  prize: string;
  totalTickets: string;
  yourTickets: string | null;
  pending: PotSnapshot["pending"];
}

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/** Both live pots. v3 and v3.1 each got their own because `setFactory` is one-shot. */
const POTS: readonly { address: Address; label: string }[] = [
  { address: OPENZAP_V3_1_CONTRACTS.lotteryPot, label: "v3.1" },
  { address: OPENZAP_V3_CONTRACTS.lotteryPot, label: "v3" },
];

/** Live state only. Every read is pinned to the same captured head block. */
async function readPotCore(
  pot: { address: Address; label: string },
  viewer: Address | null,
  head: bigint,
): Promise<PotCore> {
  const round = await client.readContract({
    address: pot.address,
    abi: potAbi,
    functionName: "currentRound",
    blockNumber: head,
  });

  const [prize, totalTickets, yourTickets, balances] = await Promise.all([
    client.readContract({
      address: pot.address,
      abi: potAbi,
      functionName: "roundPrize",
      args: [round],
      blockNumber: head,
    }),
    client.readContract({
      address: pot.address,
      abi: potAbi,
      functionName: "totalTickets",
      args: [round],
      blockNumber: head,
    }),
    viewer
      ? client.readContract({
          address: pot.address,
          abi: potAbi,
          functionName: "tickets",
          args: [round, viewer],
          blockNumber: head,
        })
      : Promise.resolve(null),
    Promise.all(
      POT_FEE_ASSETS.map((asset) =>
        client.readContract({
          address: asset,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [pot.address],
          blockNumber: head,
        }),
      ),
    ),
  ]);

  return {
    address: pot.address,
    label: pot.label,
    round: round.toString(),
    prize: prize.toString(),
    totalTickets: totalTickets.toString(),
    yourTickets: yourTickets === null ? null : yourTickets.toString(),
    pending: POT_FEE_ASSETS.map((asset, index) => toPendingAsset(asset, balances[index])),
  };
}

/**
 * Prize, tickets, and held assets are authoritative contract reads at one block.
 *
 * Robinhood's public RPC currently rejects the multi-million-block event scan
 * needed for lifetime conversion/award history and applies a rolling subrequest
 * quota too small to rebuild it safely inside a request. Explorer, cached, or
 * partial history is not substituted. Those fields stay explicitly unavailable
 * until a durable RPC-backed index exists.
 */
export async function fetchPots(viewer: Address | null = null): Promise<PotPayload> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const headBefore = await client.getBlock({ blockNumber: head });
  if (!headBefore.hash) throw new Error("RPC head block is missing its canonical hash.");

  const cores = await Promise.all(POTS.map((pot) => readPotCore(pot, viewer, head)));
  const headAfter = await client.getBlock({ blockNumber: head });
  if (headAfter.hash !== headBefore.hash) {
    throw new Error("RPC head block changed during the pot state reads.");
  }

  const pots: PotSnapshot[] = cores.map((core) => ({
    ...core,
    historyStatus: "unavailable",
    historyHeadBlock: null,
    conversions: [],
    awards: [],
  }));
  return { pots, headBlock: head.toString(), readAt: new Date().toISOString() };
}