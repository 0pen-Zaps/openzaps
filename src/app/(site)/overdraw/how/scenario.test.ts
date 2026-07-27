import { describe, expect, it } from "vitest";

import { DEMO, tokens } from "@/app/(site)/overdraw/how/scenario";

/**
 * The walkthrough teaches the rules, so its numbers have to be the contract's.
 * These are the same figures `test_waterfallServesModestFirstAndCutsTheRest`
 * pins in Solidity: if the two ever disagree, the animation is teaching a game
 * nobody is playing.
 */
describe("walkthrough scenario", () => {
  const T = 10n ** 18n;

  it("takes 4,000 in fees and puts 3,900 on the bus", () => {
    expect(DEMO.seats).toBe(4);
    expect(DEMO.fees).toBe(4_000n * T);
    expect(DEMO.rake).toBe(80n * T);
    expect(DEMO.keeper).toBe(20n * T);
    expect(DEMO.capacity).toBe(3_900n * T);
  });

  it("pays the three modest draws and cuts the greedy one", () => {
    expect(DEMO.rows.map((r) => r.draw)).toEqual([1_000, 2_500, 3_000, 5_000]);
    expect(DEMO.rows.map((r) => r.paid)).toEqual([390n * T, 975n * T, 1_170n * T, 0n]);
    expect(DEMO.rows.map((r) => r.served)).toEqual([true, true, true, false]);
  });

  it("leaves 1,365 for the pool, and every wei is accounted for", () => {
    expect(DEMO.served).toBe(2_535n * T);
    expect(DEMO.carry).toBe(1_365n * T);
    expect(DEMO.served + DEMO.carry).toBe(DEMO.capacity);
  });

  it("orders the seats by draw, not by the order they were opened in", () => {
    // D opened first but draws the most, so it must sort last and be the one cut.
    expect(DEMO.byReveal.map((r) => r.label)).toEqual(["A", "B", "C", "D"]);
    expect(DEMO.rows.map((r) => r.label)).toEqual(["A", "B", "C", "D"]);
    expect(DEMO.rows.at(-1)?.served).toBe(false);
  });

  it("sizes each bar by the share of the bus it asks for", () => {
    expect(DEMO.rows.map((r) => r.widthPct)).toEqual([10, 25, 30, 50]);
  });

  it("formats whole tokens for captions", () => {
    expect(tokens(3_900n * T)).toBe("3,900");
    expect(tokens(0n)).toBe("0");
  });
});
