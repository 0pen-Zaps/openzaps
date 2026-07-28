import { describe, expect, it } from "vitest";

import {
  PRACTICE_ENTRY_FEE,
  PRACTICE_START_BALANCE,
  practiceCapacity,
  practiceCommit,
  practiceExpectedReveals,
  practiceNextRound,
  practiceOpenReveals,
  practiceReset,
  practiceReveal,
  practiceSeats,
  practiceSettle,
  practiceStart,
  practiceWillStall,
} from "@/lib/overdraw-practice";
import { MIN_REVEALS } from "@/lib/overdraw";

/** Drive a full round: commit -> reveal window -> optionally reveal -> settle. */
function playRound(seed: number, draw: number, reveal: boolean) {
  let s = practiceStart(seed);
  s = practiceCommit(s, draw);
  s = practiceOpenReveals(s);
  if (reveal) s = practiceReveal(s);
  return practiceSettle(s);
}

describe("the lesson: an unrevealed seat forfeits its entry", () => {
  it("charges the entry and pays nothing back when the reveal is skipped", () => {
    const s = playRound(1, 2_500, false);

    expect(s.result?.forfeited).toBe(true);
    expect(s.result?.paid).toBe(0n);
    // The entry left the balance at commit and never came back.
    expect(s.balance).toBe(PRACTICE_START_BALANCE - PRACTICE_ENTRY_FEE);
  });

  it("pays the same seat when it IS revealed", () => {
    const skipped = playRound(1, 2_500, false);
    const opened = playRound(1, 2_500, true);

    // Same seed, same draw, same rivals — the only difference is the reveal.
    expect(opened.result?.forfeited).toBe(false);
    expect(opened.balance).toBeGreaterThan(skipped.balance);
  });

  it("rolls the forfeited entry into the carry pool, as the contract does", () => {
    const s = playRound(1, 2_500, false);
    expect(s.carryPool).toBeGreaterThan(0n);
    expect(s.result?.carryAfter).toBe(s.carryPool);
  });
});

describe("commit", () => {
  it("takes exactly one entry fee", () => {
    const s = practiceCommit(practiceStart(1), 2_500);
    expect(s.balance).toBe(PRACTICE_START_BALANCE - PRACTICE_ENTRY_FEE);
    expect(s.seat).toEqual({ draw: 2_500, revealed: false });
  });

  it("refuses a second seat in the same round", () => {
    const once = practiceCommit(practiceStart(1), 2_500);
    expect(practiceCommit(once, 1_000)).toBe(once);
  });

  it("refuses a draw outside 1..BPS", () => {
    const s = practiceStart(1);
    for (const bad of [0, -1, 10_001, 1.5, Number.NaN]) {
      expect(practiceCommit(s, bad), String(bad)).toBe(s);
    }
  });

  it("refuses when the virtual balance cannot cover the entry", () => {
    const broke = { ...practiceStart(1), balance: 0n };
    expect(practiceCommit(broke, 2_500)).toBe(broke);
  });

  it("is only legal in the commit phase", () => {
    const revealing = practiceOpenReveals(practiceStart(1));
    expect(practiceCommit(revealing, 2_500)).toBe(revealing);
  });
});

describe("reveal", () => {
  it("is a no-op without a seat", () => {
    const s = practiceOpenReveals(practiceStart(1));
    expect(practiceReveal(s)).toBe(s);
  });

  it("is a no-op during the commit phase — you cannot open early", () => {
    const s = practiceCommit(practiceStart(1), 2_500);
    expect(practiceReveal(s)).toBe(s);
  });

  it("is idempotent", () => {
    let s = practiceOpenReveals(practiceCommit(practiceStart(1), 2_500));
    s = practiceReveal(s);
    expect(practiceReveal(s)).toBe(s);
  });
});

describe("settlement matches the contract's rules", () => {
  it("stalls below MIN_REVEALS and pays nobody", () => {
    // Force every rival to forget, then reveal alone.
    let s = practiceStart(1);
    s = { ...s, rivals: s.rivals.map((r) => ({ ...r, reveals: false })) };
    s = practiceReveal(practiceOpenReveals(practiceCommit(s, 2_500)));
    const done = practiceSettle(s);

    expect(practiceExpectedReveals(s)).toBeLessThan(MIN_REVEALS);
    expect(done.result?.stalled).toBe(true);
    expect(done.result?.paid).toBe(0n);
    // A stalled round hands the whole capacity to the pool rather than to the
    // one person who showed up.
    expect(done.carryPool).toBeGreaterThan(0n);
  });

  it("counts the player's seat only when revealed", () => {
    const s = practiceCommit(practiceStart(3), 2_500);
    expect(practiceSeats(s)).toBe(s.rivals.length + 1);

    const skipped = practiceSettle(practiceOpenReveals(s));
    expect(skipped.result?.waterfall.rows.some((r) => r.paid > 0n && r.draw === 2_500)).toBe(false);
  });

  it("only settles from the reveal phase", () => {
    const committing = practiceCommit(practiceStart(1), 2_500);
    expect(practiceSettle(committing)).toBe(committing);
  });

  it("capacity grows with the seat the player takes", () => {
    const empty = practiceStart(1);
    const seated = practiceCommit(empty, 2_500);
    expect(practiceCapacity(seated)).toBeGreaterThan(practiceCapacity(empty));
  });
});

describe("rounds", () => {
  it("carries the pool forward and resets the seat", () => {
    const first = playRound(1, 2_500, false);
    const second = practiceNextRound(first);

    expect(second.round).toBe(2);
    expect(second.phase).toBe("commit");
    expect(second.seat).toBeNull();
    expect(second.carryPool).toBe(first.carryPool);
  });

  it("deals different rivals each round", () => {
    const first = playRound(1, 2_500, true);
    const second = practiceNextRound(first);
    expect(second.rivals.map((r) => r.draw)).not.toEqual(first.rivals.map((r) => r.draw));
  });

  it("only advances from a settled round", () => {
    const s = practiceStart(1);
    expect(practiceNextRound(s)).toBe(s);
  });
});

describe("determinism", () => {
  it("same seed and same actions produce the same result", () => {
    expect(playRound(7, 3_000, true).result).toEqual(playRound(7, 3_000, true).result);
  });

  it("reset returns a pristine table", () => {
    const fresh = practiceReset(1);
    expect(fresh).toEqual(practiceStart(1));
    expect(fresh.balance).toBe(PRACTICE_START_BALANCE);
    expect(fresh.carryPool).toBe(0n);
  });
});

describe("practice must be able to cut you", () => {
  /** Share of non-stalled rounds where this draw was paid nothing. */
  function cutRate(draw: number, seeds = 40): number {
    let cut = 0;
    let counted = 0;
    for (let seed = 1; seed <= seeds; seed += 1) {
      const done = playRound(seed, draw, true);
      if (done.result?.stalled) continue;
      counted += 1;
      if ((done.result?.paid ?? 0n) === 0n) cut += 1;
    }
    return counted === 0 ? 0 : cut / counted;
  }

  it("cuts a greedy draw often", () => {
    // Before this was fixed the rival draws were too small to ever exhaust the
    // bus, so EVERY draw was served in every round and practice taught that
    // being cut cannot happen. On the live table a draw the bus cannot reach is
    // paid exactly zero and the entry is not returned.
    expect(cutRate(9_000)).toBeGreaterThan(0.5);
  });

  it("serves a modest draw reliably — that is the real rule, not a bug", () => {
    // "The modest are served first" is literally how _discharge works: draws
    // are sorted ascending and paid in full while the current covers them. A
    // small draw being safe is the truth practice should teach, so this asserts
    // it rather than manufacturing a cut that the contract would not produce.
    expect(cutRate(500)).toBe(0);
  });

  it("makes the cut risk rise monotonically with greed", () => {
    const rates = [1_000, 4_000, 6_000, 8_000, 9_500].map((d) => cutRate(d));
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i], `cut rate must not fall as the draw grows (step ${i})`).toBeGreaterThanOrEqual(rates[i - 1]);
    }
    // And the curve must actually span the range, not sit flat at either end.
    expect(rates[0]).toBeLessThan(0.2);
    expect(rates[rates.length - 1]).toBeGreaterThan(0.8);
  });
});

describe("rival generation", () => {
  it("does not deal an identical opponent every round", () => {
    // xorshift32 fed a small integer emits a tiny first value, which pinned
    // rival one to the same 8500 bps draw in every single round.
    const firsts = new Set(Array.from({ length: 12 }, (_, i) => practiceStart(i + 1).rivals[0].draw));
    expect(firsts.size).toBeGreaterThan(6);
  });

  it("spreads draws across the range rather than clustering", () => {
    const draws = Array.from({ length: 20 }, (_, i) => practiceStart(i + 1).rivals.map((r) => r.draw)).flat();
    expect(Math.min(...draws)).toBeLessThan(3_000);
    expect(Math.max(...draws)).toBeGreaterThan(8_000);
  });
});

describe("the stall hint", () => {
  it("warns before settling when too few draws will open", () => {
    let s = practiceStart(1);
    s = { ...s, rivals: s.rivals.map((r) => ({ ...r, reveals: false })) };
    s = practiceOpenReveals(practiceCommit(s, 2_500));
    expect(practiceWillStall(s)).toBe(true);
    expect(practiceWillStall(practiceReveal(s))).toBe(true); // 1 reveal < MIN_REVEALS
  });

  it("clears once enough draws will open", () => {
    let s = practiceStart(1);
    s = { ...s, rivals: s.rivals.map((r) => ({ ...r, reveals: true })) };
    s = practiceOpenReveals(practiceCommit(s, 2_500));
    expect(practiceWillStall(s)).toBe(false);
  });
});
