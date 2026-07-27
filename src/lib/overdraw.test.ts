import { afterEach, describe, expect, it } from "vitest";

import {
  BPS,
  MIN_REVEALS,
  capacityOf,
  overdrawAddress,
  phaseAt,
  waterfall,
  type RevealedDraw,
} from "@/lib/overdraw";

const A = "0x000000000000000000000000000000000000000A" as const;
const B = "0x000000000000000000000000000000000000000b" as const;
const C = "0x000000000000000000000000000000000000000C" as const;
const D = "0x000000000000000000000000000000000000000d" as const;

function draws(...entries: readonly [string, number][]): RevealedDraw[] {
  return entries.map(([player, draw]) => ({ player: player as RevealedDraw["player"], draw }));
}

describe("waterfall", () => {
  /**
   * The same numbers `test_waterfallServesModestFirstAndCutsTheRest` pins in
   * Solidity. If this preview and the contract ever disagree, the interface is
   * lying to a player about what their draw is worth, so the two suites carry
   * the identical case on purpose.
   */
  it("serves the modest first and cuts everyone the bus cannot reach", () => {
    const capacity = 390n * 10n ** 18n;
    const result = waterfall(
      // Reveal order deliberately unsorted, to prove the sort is the contract's.
      draws([D, 5000], [A, 1000], [C, 3000], [B, 2500]),
      capacity,
    );

    expect(result.rows.map((row) => row.player)).toEqual([A, B, C, D]);
    expect(result.rows.map((row) => row.paid)).toEqual([
      39n * 10n ** 18n,
      975n * 10n ** 17n,
      117n * 10n ** 18n,
      0n,
    ]);
    expect(result.rows.map((row) => row.served)).toEqual([true, true, true, false]);
    expect(result.served).toBe(2535n * 10n ** 17n);
    expect(result.carry).toBe(1365n * 10n ** 17n);
    expect(result.stalled).toBe(false);
  });

  it("breaks equal draws in reveal order", () => {
    const capacity = 195n * 10n ** 18n;
    const result = waterfall(draws([B, 10_000], [A, 10_000]), capacity);

    expect(result.rows[0]?.player).toBe(B);
    expect(result.rows[0]?.paid).toBe(capacity);
    expect(result.rows[1]?.paid).toBe(0n);
    expect(result.carry).toBe(0n);
  });

  /**
   * The detail most likely to drift: a draw too small to round up to one wei is
   * served for nothing and must NOT stop the walk, because the larger draws
   * queued behind it are still perfectly payable.
   */
  it("skips a dust draw without blocking the queue behind it", () => {
    const result = waterfall(draws([A, 1], [B, 5000], [C, 5000]), 300n);

    expect(result.rows.map((row) => row.paid)).toEqual([0n, 150n, 150n]);
    expect(result.rows[0]?.served).toBe(true);
    expect(result.carry).toBe(0n);
  });

  it("does not discharge below the reveal floor", () => {
    const result = waterfall(draws([A, 10_000]), 195n * 10n ** 18n);

    expect(MIN_REVEALS).toBe(2);
    expect(result.stalled).toBe(true);
    expect(result.served).toBe(0n);
    expect(result.carry).toBe(195n * 10n ** 18n);
    expect(result.rows.every((row) => row.paid === 0n)).toBe(true);
  });

  it("carries the whole capacity when nobody revealed", () => {
    const result = waterfall([], 500n);
    expect(result.rows).toEqual([]);
    expect(result.carry).toBe(500n);
    expect(result.stalled).toBe(true);
  });

  it("never serves more than the capacity, whatever the table draws", () => {
    const capacity = 1_000_000n;
    for (let a = 1; a <= BPS; a += 137) {
      for (let b = 1; b <= BPS; b += 331) {
        const result = waterfall(draws([A, a], [B, b], [C, BPS]), capacity);
        expect(result.served).toBeLessThanOrEqual(capacity);
        expect(result.served + result.carry).toBe(capacity);
      }
    }
  });

  it("never serves a greedier draw while a more modest one was cut", () => {
    const capacity = 1_000n;
    for (let a = 1; a <= BPS; a += 97) {
      for (let b = 1; b <= BPS; b += 89) {
        if (a === b) continue;
        const rows = waterfall(draws([A, a], [B, b]), capacity).rows;
        const modest = rows.find((row) => row.draw === Math.min(a, b));
        const greedy = rows.find((row) => row.draw === Math.max(a, b));
        // A greedy row paid something implies the modest row was paid too. Dust
        // is the honest exception: a draw that rounds to zero is "served" but
        // pays nothing, so compare on `served`, not on the amount.
        if (greedy?.served) expect(modest?.served).toBe(true);
      }
    }
  });
});

describe("capacityOf", () => {
  it("charges rake and keeper on fresh fees only, never on the carry", () => {
    const entry = 100n * 10n ** 18n;
    const carry = 1_000n * 10n ** 18n;
    const seats = 4;
    const pot = BigInt(seats) * entry + carry;

    // 2% rake and 0.5% keeper on 400 tokens of fees is 8 + 2; the 1000 carried
    // in is untaxed, so capacity is 1400 - 10.
    expect(capacityOf(pot, seats, entry, 200, 50)).toBe(1_390n * 10n ** 18n);
  });

  it("floors at zero rather than reporting a negative capacity", () => {
    expect(capacityOf(0n, 0, 100n, 200, 50)).toBe(0n);
  });
});

describe("phaseAt", () => {
  it("treats each window boundary as inclusive, matching the contract", () => {
    expect(phaseAt(50, 100, 200)).toBe("commit");
    expect(phaseAt(100, 100, 200)).toBe("commit");
    expect(phaseAt(101, 100, 200)).toBe("reveal");
    expect(phaseAt(200, 100, 200)).toBe("reveal");
    expect(phaseAt(201, 100, 200)).toBe("settle");
  });
});

describe("overdrawAddress", () => {
  const original = process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS;

  afterEach(() => {
    // The var is process-global even though vitest isolates the file, so restore
    // it rather than leaving a later test reading a value this one set.
    if (original === undefined) delete process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS;
    else process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS = original;
  });

  it("reads as not deployed when unset, zero, or malformed", () => {
    delete process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS;
    expect(overdrawAddress()).toBeNull();

    process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS = "0x0000000000000000000000000000000000000000";
    expect(overdrawAddress()).toBeNull();

    process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS = "not-an-address";
    expect(overdrawAddress()).toBeNull();

    process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS = "0x1234";
    expect(overdrawAddress()).toBeNull();
  });

  it("checksums a configured address", () => {
    process.env.NEXT_PUBLIC_OVERDRAW_ADDRESS = "0xdd90bfa4adc7f4401e611abac692d939f9f4cb07";
    expect(overdrawAddress()).toBe("0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07");
  });
});
