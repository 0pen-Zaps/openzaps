import type { Address } from "viem";

import { BPS, MIN_REVEALS, capacityOf, waterfall, type RevealedDraw, type Waterfall } from "@/lib/overdraw";

/**
 * A no-stakes ZapDraw table.
 *
 * Same rules, same arithmetic, virtual money. It exists because the real game
 * has one failure mode that costs you everything and teaches you nothing until
 * it has already happened: a sealed draw that is never revealed forfeits its
 * entry. The live game's first round ended two seats, zero reveals — both
 * players lost their entry to the carry pool and the page never said why.
 *
 * So the point of practice mode is not to be fun. It is to let someone lose a
 * round to a missed reveal while it costs nothing, once, so they recognise the
 * shape of it later. `advance()` will happily let you skip the reveal, and the
 * result explains exactly what it cost.
 *
 * Settlement runs through the SAME `waterfall()` and `capacityOf()` the live
 * surface uses, which are themselves mirrors of `ZapOverdraw._discharge`. If
 * this ever disagrees with the contract, the bug is in the shared mirror and
 * the live projection is wrong too — which is the point of not forking it.
 */

/** Virtual 0xZAPS a new player starts with: ten entries' worth. */
export const PRACTICE_START_BALANCE = 10_000_000n * 10n ** 18n;
export const PRACTICE_ENTRY_FEE = 1_000_000n * 10n ** 18n;
export const PRACTICE_RAKE_BPS = 200;
export const PRACTICE_KEEPER_BPS = 50;

export type PracticePhase = "commit" | "reveal" | "settled";

export interface PracticeRival {
  readonly name: string;
  readonly address: Address;
  readonly draw: number;
  /** Rivals forget too — that is what makes MIN_REVEALS bite in practice. */
  readonly reveals: boolean;
}

export interface PracticeSeat {
  readonly draw: number;
  readonly revealed: boolean;
}

export interface PracticeResult {
  readonly round: number;
  readonly capacity: bigint;
  readonly waterfall: Waterfall;
  /** What the player took home this round. Zero when they never revealed. */
  readonly paid: bigint;
  /** True when the player held a seat and let the reveal window close. */
  readonly forfeited: boolean;
  /** True when the table had too few reveals for the bus to run at all. */
  readonly stalled: boolean;
  readonly carryAfter: bigint;
}

export interface PracticeState {
  readonly round: number;
  readonly phase: PracticePhase;
  readonly balance: bigint;
  readonly carryPool: bigint;
  readonly rivals: readonly PracticeRival[];
  readonly seat: PracticeSeat | null;
  readonly result: PracticeResult | null;
  /** Advances every round so rival draws differ without a clock or a global. */
  readonly seed: number;
}

/**
 * The player's stand-in address.
 *
 * Fixed, so tiebreaks are stable across a session, and all-digits so it needs
 * no EIP-55 checksum — `tiebreak` encodes it as a real address and viem
 * rejects a mixed-case one that does not checksum.
 */
export const PRACTICE_PLAYER = "0x0000000000000000000000000000000000009999" as const as Address;

const RIVAL_NAMES = ["Ada", "Bo", "Cyd", "Dev", "Eli", "Fen"] as const;

/**
 * Deterministic PRNG.
 *
 * Practice must be reproducible: a tutorial that shuffles under you cannot be
 * tested, and a player who retries the same seed should see the same table.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function buildRivals(seed: number, count: number): PracticeRival[] {
  const next = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const draw = Math.max(1, Math.min(BPS, Math.round(next() * 6_000) + 500));
    // One rival in six forgets to reveal. Frequent enough to be met early,
    // rare enough that a stalled round still feels like bad luck.
    const reveals = next() > 1 / 6;
    return {
      name: RIVAL_NAMES[i % RIVAL_NAMES.length],
      address: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      draw,
      reveals,
    };
  });
}

export function practiceStart(seed = 1): PracticeState {
  return {
    round: 1,
    phase: "commit",
    balance: PRACTICE_START_BALANCE,
    carryPool: 0n,
    rivals: buildRivals(seed, 3),
    seat: null,
    result: null,
    seed,
  };
}

/** Seats on the table this round: the player's, if taken, plus every rival. */
export function practiceSeats(state: PracticeState): number {
  return state.rivals.length + (state.seat ? 1 : 0);
}

export function practiceCapacity(state: PracticeState): bigint {
  return capacityOf(
    practiceSeats(state),
    PRACTICE_ENTRY_FEE,
    PRACTICE_RAKE_BPS,
    PRACTICE_KEEPER_BPS,
    state.carryPool,
  );
}

/** Take a seat. Costs a virtual entry; refuses if the balance cannot cover it. */
export function practiceCommit(state: PracticeState, draw: number): PracticeState {
  if (state.phase !== "commit" || state.seat) return state;
  if (!Number.isInteger(draw) || draw < 1 || draw > BPS) return state;
  if (state.balance < PRACTICE_ENTRY_FEE) return state;
  return { ...state, balance: state.balance - PRACTICE_ENTRY_FEE, seat: { draw, revealed: false } };
}

/** Close commits. Reveals open. */
export function practiceOpenReveals(state: PracticeState): PracticeState {
  return state.phase === "commit" ? { ...state, phase: "reveal" } : state;
}

export function practiceReveal(state: PracticeState): PracticeState {
  if (state.phase !== "reveal" || !state.seat || state.seat.revealed) return state;
  return { ...state, seat: { ...state.seat, revealed: true } };
}

/**
 * Close the reveal window and discharge.
 *
 * The player's seat counts only if it was revealed — the whole lesson. An
 * unrevealed seat still paid its entry, which is already gone from `balance`
 * and now rolls into the carry pool exactly as the contract does it.
 */
export function practiceSettle(state: PracticeState): PracticeState {
  if (state.phase !== "reveal") return state;

  const seats = practiceSeats(state);
  const capacity = capacityOf(seats, PRACTICE_ENTRY_FEE, PRACTICE_RAKE_BPS, PRACTICE_KEEPER_BPS, state.carryPool);

  const draws: RevealedDraw[] = [
    ...state.rivals.filter((r) => r.reveals).map((r) => ({ player: r.address, draw: r.draw })),
    ...(state.seat?.revealed ? [{ player: PRACTICE_PLAYER, draw: state.seat.draw }] : []),
  ];

  const settled = waterfall(draws, capacity, BigInt(state.round));
  const mine = settled.rows.find((row) => row.player === PRACTICE_PLAYER);
  const paid = mine?.paid ?? 0n;

  const released = releasedThisRound(seats, state.carryPool);
  const carryAfter = state.carryPool - released + settled.carry;

  const result: PracticeResult = {
    round: state.round,
    capacity,
    waterfall: settled,
    paid,
    forfeited: state.seat !== null && !state.seat.revealed,
    stalled: settled.stalled,
    carryAfter,
  };

  return { ...state, phase: "settled", balance: state.balance + paid, carryPool: carryAfter, result };
}

/** Next round: fresh rivals, carry survives, the result stays readable until then. */
export function practiceNextRound(state: PracticeState): PracticeState {
  if (state.phase !== "settled") return state;
  const seed = state.seed + 1;
  return {
    ...state,
    round: state.round + 1,
    phase: "commit",
    rivals: buildRivals(seed, 3),
    seat: null,
    seed,
  };
}

/** Wipe back to a fresh table and a fresh virtual balance. */
export function practiceReset(seed = 1): PracticeState {
  return practiceStart(seed);
}

/** Mirrors `releasableCarry` for the seat count actually on the table. */
function releasedThisRound(seats: number, carryPool: bigint): bigint {
  const rake = (BigInt(seats) * PRACTICE_ENTRY_FEE * BigInt(PRACTICE_RAKE_BPS)) / BigInt(BPS);
  return carryPool < rake ? carryPool : rake;
}

/** How many draws will actually be opened, for the "will this stall?" hint. */
export function practiceExpectedReveals(state: PracticeState): number {
  return state.rivals.filter((r) => r.reveals).length + (state.seat?.revealed ? 1 : 0);
}

export function practiceWillStall(state: PracticeState): boolean {
  return practiceExpectedReveals(state) < MIN_REVEALS;
}
