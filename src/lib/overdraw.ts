import { getAddress, zeroAddress, type Address, type Hex } from "viem";

/**
 * Client-side model of the OVERDRAW game (`contracts/src/game/ZapOverdraw.sol`).
 *
 * Three things live here and nothing else: the ABI the surface calls through,
 * the fail-closed answer to "is this game deployed", and a pure re-implementation
 * of the settlement waterfall so the interface can show a player what the round
 * would pay *right now* without an RPC round trip per keystroke.
 *
 * The waterfall mirror is the part to be careful with. It is a convenience, not
 * an authority: the contract settles from the draws it has at `revealEnd`, and
 * every reveal after the preview changes the answer. Anything rendered from it
 * must be labelled as a projection, never as a result.
 */

/** Basis-point denominator. A draw of `BPS` claims the whole capacity. */
export const BPS = 10_000;

/** Seats per round, mirroring `ZapOverdraw.MAX_SEATS`. */
export const MAX_SEATS = 64;

/** Revealed draws a round needs before it discharges, mirroring `MIN_REVEALS`. */
export const MIN_REVEALS = 2;

/**
 * The deployed game, or `null` when there isn't one.
 *
 * Deliberately env-only with no baked fallback, and deliberately `null` rather
 * than a placeholder: this contract takes real 0xZAPS and pays real 0xZAPS, so
 * "we have not deployed it yet" and "here is an address" must never be the same
 * state in the UI. A malformed or zero value reads as not deployed. Configuring
 * this variable is the moment the product starts asking people for money.
 */
export function overdrawAddress(): Address | null {
  const raw = process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS;
  if (!raw) return null;
  try {
    const parsed = getAddress(raw);
    return parsed === zeroAddress ? null : parsed;
  } catch {
    return null;
  }
}

/** Which window a round is in. Mirrors `ZapOverdraw.phase()`. */
export type Phase = "commit" | "reveal" | "settle";

export function phaseAt(now: number, commitEnd: number, revealEnd: number): Phase {
  if (now <= commitEnd) return "commit";
  if (now <= revealEnd) return "reveal";
  return "settle";
}

export type RoundHeader = {
  readonly commitEnd: number;
  readonly revealEnd: number;
  readonly seats: number;
  readonly reveals: number;
  readonly settled: boolean;
  readonly pot: bigint;
};

/** One revealed draw, in reveal order — the order that breaks ties. */
export type RevealedDraw = {
  readonly player: Address;
  readonly draw: number;
};

export type WaterfallRow = RevealedDraw & {
  /** What the draw asks for. */
  readonly wants: bigint;
  /** What it is actually paid — `wants`, or zero once the bus runs dry. */
  readonly paid: bigint;
  readonly served: boolean;
};

export type Waterfall = {
  readonly rows: readonly WaterfallRow[];
  readonly served: bigint;
  /** Capacity the bus does not deliver, which becomes the next round's opening pot. */
  readonly carry: bigint;
  /** True when there are too few reveals for the bus to discharge at all. */
  readonly stalled: boolean;
};

/**
 * The settlement waterfall, as the contract runs it.
 *
 * Sorted ascending by draw, ties broken by reveal order, each row paid in full
 * while the remaining current covers it, and the walk stops at the first row it
 * cannot cover. Kept in step with `ZapOverdraw._discharge`, including the two
 * details that are easy to get wrong and that `overdraw.test.ts` pins:
 *
 *   * a draw that rounds down to zero is served for nothing and does NOT stop
 *     the walk for the larger draws behind it, and
 *   * a round below {MIN_REVEALS} does not discharge at all — the whole capacity
 *     carries rather than being handed to whoever turned up alone.
 */
export function waterfall(draws: readonly RevealedDraw[], capacity: bigint): Waterfall {
  if (draws.length < MIN_REVEALS || capacity <= 0n) {
    return {
      rows: draws.map((entry) => ({ ...entry, wants: 0n, paid: 0n, served: false })),
      served: 0n,
      carry: capacity > 0n ? capacity : 0n,
      stalled: true,
    };
  }

  // Sort a copy by (draw asc, reveal index asc). The index tiebreak is what the
  // contract gets for free by packing it into the low bits of its sort key.
  const order = draws
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.draw === b.entry.draw ? a.index - b.index : a.entry.draw - b.entry.draw));

  const rows: WaterfallRow[] = [];
  let remaining = capacity;
  let dry = false;

  for (const { entry } of order) {
    const wants = (capacity * BigInt(entry.draw)) / BigInt(BPS);
    if (dry) {
      rows.push({ ...entry, wants, paid: 0n, served: false });
      continue;
    }
    if (wants === 0n) {
      rows.push({ ...entry, wants: 0n, paid: 0n, served: true });
      continue;
    }
    if (wants > remaining) {
      dry = true;
      rows.push({ ...entry, wants, paid: 0n, served: false });
      continue;
    }
    remaining -= wants;
    rows.push({ ...entry, wants, paid: wants, served: true });
  }

  return { rows, served: capacity - remaining, carry: remaining, stalled: false };
}

/** Capacity a round would discharge, given its pot and this deployment's fees. */
export function capacityOf(pot: bigint, seats: number, entryFee: bigint, rakeBps: number, keeperBps: number): bigint {
  const fees = BigInt(seats) * entryFee;
  const rake = (fees * BigInt(rakeBps)) / BigInt(BPS);
  const keeper = (fees * BigInt(keeperBps)) / BigInt(BPS);
  const capacity = pot - rake - keeper;
  return capacity > 0n ? capacity : 0n;
}

export const overdrawAbi = [
  { type: "function", name: "stake", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "entryFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "rakeBps", inputs: [], outputs: [{ type: "uint16" }], stateMutability: "view" },
  { type: "function", name: "keeperBps", inputs: [], outputs: [{ type: "uint16" }], stateMutability: "view" },
  { type: "function", name: "currentRound", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "phase", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  {
    type: "function",
    name: "rounds",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      { name: "commitEnd", type: "uint64" },
      { name: "revealEnd", type: "uint64" },
      { name: "seats", type: "uint32" },
      { name: "reveals", type: "uint32" },
      { name: "settled", type: "bool" },
      { name: "pot", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "seatOf",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [
      { name: "blob", type: "bytes32" },
      { name: "draw", type: "uint16" },
      { name: "revealSeq", type: "uint32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "credit",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "commitmentFor",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "player", type: "address" },
      { name: "draw", type: "uint16" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "revealedPlayers",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "revealedDraws",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ type: "uint16[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewCapacity",
    inputs: [],
    outputs: [
      { name: "capacity", type: "uint256" },
      { name: "fees", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "commit",
    inputs: [{ name: "blob", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "reveal",
    inputs: [
      { name: "draw", type: "uint16" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "settle", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "claim", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
] as const;

// --------------------------------------------------------------------- //
// The salt vault                                                         //
// --------------------------------------------------------------------- //

/**
 * A sealed draw the player still has to open.
 *
 * THIS IS THE MOST DANGEROUS PIECE OF STATE IN THE GAME. A commitment whose
 * salt is gone can never be revealed, and an unrevealed seat forfeits its entry
 * by design — so losing this record loses money, and no amount of contract
 * safety can give it back. Everything below therefore errs towards keeping it:
 * writes happen before the transaction is sent, records are never pruned on a
 * failed send, and the surface offers the player an exportable copy.
 */
export type SealedDraw = {
  readonly chainId: number;
  readonly game: Address;
  readonly round: string;
  readonly player: Address;
  readonly draw: number;
  readonly salt: Hex;
  readonly commitment: Hex;
  /** Epoch ms, for ordering and for showing the player how old a record is. */
  readonly sealedAt: number;
  /** Set once the reveal is confirmed, so the surface can stop nagging. */
  readonly revealedAt?: number;
};

const VAULT_KEY = "openzaps:overdraw:sealed:v1";

/** A random 32-byte salt from the platform CSPRNG. Never derived from a seed. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function isSealedDraw(value: unknown): value is SealedDraw {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.chainId === "number" &&
    typeof v.game === "string" &&
    typeof v.round === "string" &&
    typeof v.player === "string" &&
    typeof v.draw === "number" &&
    typeof v.salt === "string" &&
    typeof v.commitment === "string" &&
    typeof v.sealedAt === "number"
  );
}

/** Every sealed draw this browser knows about. Malformed rows are dropped, never guessed at. */
export function readSealedDraws(): SealedDraw[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(VAULT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSealedDraw) : [];
  } catch {
    return [];
  }
}

/**
 * Records a sealed draw, replacing any previous record for the same
 * (chain, game, round, player) — the contract allows one seat per address per
 * round, so a second record for that key can only be a re-seal of the same seat.
 */
export function saveSealedDraw(entry: SealedDraw): void {
  if (typeof window === "undefined") return;
  const rest = readSealedDraws().filter((row) => !sameSeat(row, entry));
  try {
    window.localStorage.setItem(VAULT_KEY, JSON.stringify([...rest, entry]));
  } catch {
    // A full or blocked localStorage must not take down the commit flow; the
    // surface warns separately when a seal could not be persisted.
  }
}

export function markRevealed(entry: SealedDraw, at: number): void {
  saveSealedDraw({ ...entry, revealedAt: at });
}

function sameSeat(a: SealedDraw, b: SealedDraw): boolean {
  return (
    a.chainId === b.chainId &&
    a.game.toLowerCase() === b.game.toLowerCase() &&
    a.round === b.round &&
    a.player.toLowerCase() === b.player.toLowerCase()
  );
}

/** The sealed draw for one seat, or `null` when this browser never held it. */
export function findSealedDraw(
  chainId: number,
  game: Address,
  round: bigint,
  player: Address,
): SealedDraw | null {
  const key = { chainId, game, round: round.toString(), player } as SealedDraw;
  return readSealedDraws().find((row) => sameSeat(row, key)) ?? null;
}

/** A copy-paste backup of one seal, so a cleared browser is recoverable by hand. */
export function exportSeal(entry: SealedDraw): string {
  return JSON.stringify(
    {
      game: entry.game,
      chainId: entry.chainId,
      round: entry.round,
      player: entry.player,
      draw: entry.draw,
      salt: entry.salt,
      commitment: entry.commitment,
    },
    null,
    2,
  );
}
