import { createPublicClient, http, type Address } from "viem";

import { ACTIVITY_FROM_BLOCK, assetSymbolFor } from "@/lib/activity";
import {
  POT_FEE_ASSETS,
  potAbi,
  roundAwardedEvent,
  toPendingAsset,
  zapsBoughtEvent,
  type PotAward,
  type PotConversion,
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

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/** Both live pots. v3 and v3.1 each got their own because `setFactory` is one-shot. */
const POTS: readonly { address: Address; label: string }[] = [
  { address: OPENZAP_V3_1_CONTRACTS.lotteryPot, label: "v3.1" },
  { address: OPENZAP_V3_CONTRACTS.lotteryPot, label: "v3" },
];

/**
 * Read one pot's full state: the round's prize and tickets, the fee assets still
 * awaiting a permissionless conversion, and the conversion / award history.
 *
 * Every number comes from a contract read or an event emitted BY THIS POT — the
 * address filter is what keeps a look-alike contract's events out. Throws on RPC
 * failure so the caller can fail closed rather than render an invented pot.
 */
async function readPot(
  pot: { address: Address; label: string },
  viewer: Address | null,
  head: bigint,
): Promise<PotSnapshot> {
  const round = await client.readContract({ address: pot.address, abi: potAbi, functionName: "currentRound" });

  const [prize, totalTickets, yourTickets, balances, boughtLogs, awardLogs] = await Promise.all([
    client.readContract({ address: pot.address, abi: potAbi, functionName: "roundPrize", args: [round] }),
    client.readContract({ address: pot.address, abi: potAbi, functionName: "totalTickets", args: [round] }),
    viewer
      ? client.readContract({ address: pot.address, abi: potAbi, functionName: "tickets", args: [round, viewer] })
      : Promise.resolve(null),
    // The open half of the loop: anything the pot holds that is not the prize asset.
    Promise.all(
      POT_FEE_ASSETS.map((asset) =>
        client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [pot.address] }),
      ),
    ),
    client.getLogs({ address: pot.address, event: zapsBoughtEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
    client.getLogs({ address: pot.address, event: roundAwardedEvent, fromBlock: ACTIVITY_FROM_BLOCK, toBlock: head, strict: true }),
  ]);

  const conversions: PotConversion[] = boughtLogs
    .flatMap((log) =>
      log.args?.caller && log.args?.assetIn && log.args?.amountIn !== undefined && log.args?.zapsOut !== undefined
        ? [{
            round: (log.args.round ?? 0n).toString(),
            caller: log.args.caller,
            assetIn: log.args.assetIn,
            symbolIn: assetSymbolFor(log.args.assetIn),
            amountIn: log.args.amountIn.toString(),
            zapsOut: log.args.zapsOut.toString(),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
          }]
        : [],
    )
    .reverse();

  const awards: PotAward[] = awardLogs
    .flatMap((log) =>
      log.args?.winner && log.args?.prize !== undefined
        ? [{
            round: (log.args.round ?? 0n).toString(),
            winner: log.args.winner,
            prize: log.args.prize.toString(),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
          }]
        : [],
    )
    .reverse();

  return {
    address: pot.address,
    label: pot.label,
    round: round.toString(),
    prize: prize.toString(),
    totalTickets: totalTickets.toString(),
    yourTickets: yourTickets === null ? null : yourTickets.toString(),
    pending: POT_FEE_ASSETS.map((asset, index) => toPendingAsset(asset, balances[index])),
    conversions,
    awards,
  };
}

/** Both pots at one block, so prize, tickets, and history describe the same moment. */
export async function fetchPots(viewer: Address | null = null): Promise<PotPayload> {
  const head = await client.getBlockNumber();
  const pots = await Promise.all(POTS.map((pot) => readPot(pot, viewer, head)));
  return { pots, headBlock: head.toString(), readAt: new Date().toISOString() };
}
