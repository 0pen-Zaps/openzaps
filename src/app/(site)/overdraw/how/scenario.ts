import { BPS, capacityOf, waterfall, type RevealedDraw } from "@/lib/overdraw";

/**
 * The one round the walkthrough animates.
 *
 * Every number on that page is computed HERE, by the same `waterfall` the live
 * surface previews with and `ZapOverdraw._discharge` mirrors — never typed into
 * the markup. A teaching page that quietly disagrees with the contract is worse
 * than no teaching page, because it is believed.
 */

const ROUND = 1n;
const ENTRY = 1_000n * 10n ** 18n;
const RAKE_BPS = 200;
const KEEPER_BPS = 50;

/** Four seats, chosen so the round ends with three paid and one cut. */
const PLAYERS = [
  { label: "A", address: "0x000000000000000000000000000000000000000A", draw: 1_000 },
  { label: "B", address: "0x000000000000000000000000000000000000000b", draw: 2_500 },
  { label: "C", address: "0x000000000000000000000000000000000000000C", draw: 3_000 },
  { label: "D", address: "0x000000000000000000000000000000000000000d", draw: 5_000 },
] as const;

const draws: RevealedDraw[] = PLAYERS.map((p) => ({
  player: p.address as RevealedDraw["player"],
  draw: p.draw,
}));

const seats = PLAYERS.length;
const fees = BigInt(seats) * ENTRY;
const rake = (fees * BigInt(RAKE_BPS)) / BigInt(BPS);
const keeper = (fees * BigInt(KEEPER_BPS)) / BigInt(BPS);

/** No pool yet — this is the first round the table ever plays. */
const capacity = capacityOf(seats, ENTRY, RAKE_BPS, KEEPER_BPS, 0n);
const result = waterfall(draws, capacity, ROUND);

export type DemoSeat = {
  readonly label: string;
  /** Where the seat sits before the sort — the order the draws were opened in. */
  readonly revealRank: number;
  /** Where it sits after the sort — smallest draw first. */
  readonly sortedRank: number;
  readonly draw: number;
  readonly wants: bigint;
  readonly paid: bigint;
  readonly served: boolean;
  /** Share of the bus this seat asks for, as a percentage width. */
  readonly widthPct: number;
};

const seatsOut: DemoSeat[] = result.rows.map((row, sortedRank) => {
  const player = PLAYERS.find((p) => p.address.toLowerCase() === row.player.toLowerCase());
  if (!player) throw new Error("scenario row does not match a demo player");
  return {
    label: player.label,
    revealRank: PLAYERS.indexOf(player),
    sortedRank,
    draw: row.draw,
    wants: row.wants,
    paid: row.paid,
    served: row.served,
    widthPct: (row.draw / BPS) * 100,
  };
});

export const DEMO = {
  entry: ENTRY,
  seats,
  fees,
  rake,
  keeper,
  capacity,
  served: result.served,
  carry: result.carry,
  /** In sorted order: the order the bus actually pays them in. */
  rows: seatsOut,
  /** In reveal order, for the scenes before the sort. */
  byReveal: [...seatsOut].sort((a, b) => a.revealRank - b.revealRank),
} as const;

/** Whole tokens, for captions. The demo deals in round numbers on purpose. */
export function tokens(value: bigint): string {
  return (Number(value / 10n ** 15n) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
