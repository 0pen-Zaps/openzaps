import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import {
  StakerAccountingMismatchError,
  buildStakerRows,
  shareOfTotal,
  sumClaimedByAccount,
  uniqueStakerAccounts,
  type StakerAccountState,
} from "@/lib/rewards-stakers";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as Address;
const B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb" as Address;
const C = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const OTHER_ASSET = "0x1111111111111111111111111111111111111111" as Address;

function state(
  account: Address,
  stakedBalance: bigint,
  rewardWeight = 0n,
  earnedWeth = 0n,
): StakerAccountState {
  return { account, stakedBalance, rewardWeight, earnedWeth };
}

describe("uniqueStakerAccounts", () => {
  it("deduplicates case-insensitively and preserves first-seen order", () => {
    const lowercaseA = A.toLowerCase() as Address;
    expect(uniqueStakerAccounts([B, A, lowercaseA, C, B])).toEqual([B, A, C]);
  });

  it("returns an empty list for no events", () => {
    expect(uniqueStakerAccounts([])).toEqual([]);
  });
});

describe("sumClaimedByAccount", () => {
  it("sums per account and ignores other reward assets", () => {
    const claims = [
      { account: A, asset: WETH, amount: 3n },
      { account: A, asset: WETH, amount: 4n },
      { account: B, asset: OTHER_ASSET, amount: 100n },
      { account: B, asset: WETH.toLowerCase() as Address, amount: 5n },
    ];
    const byAccount = sumClaimedByAccount(claims, WETH);
    expect(byAccount.get(A.toLowerCase())).toBe(7n);
    expect(byAccount.get(B.toLowerCase())).toBe(5n);
    expect(byAccount.size).toBe(2);
  });
});

describe("shareOfTotal", () => {
  it("stays silent when there is no total, instead of answering zero", () => {
    expect(shareOfTotal(5n, 0n)).toBeNull();
    expect(shareOfTotal(-1n, 10n)).toBeNull();
  });

  it("reports a two-decimal percentage", () => {
    expect(shareOfTotal(1n, 4n)).toBe(25);
    expect(shareOfTotal(1n, 3n)).toBe(33.33);
    expect(shareOfTotal(0n, 3n)).toBe(0);
    expect(shareOfTotal(3n, 3n)).toBe(100);
  });
});

describe("buildStakerRows", () => {
  it("orders by staked principal, then lifetime rewards, then address", () => {
    const states = [
      state(C, 10n, 10n, 1n),
      state(A, 10n, 10n, 0n),
      state(B, 30n, 40n, 2n),
    ];
    const built = buildStakerRows(states, new Map(), 50n);
    expect(built.rows.map((row) => row.account)).toEqual([B, C, A]);
  });

  it("keeps exited addresses with reward history and drops empty accounts from rows only", () => {
    const claimed = new Map([[B.toLowerCase(), 9n]]);
    const states = [
      state(A, 20n, 25n, 3n),
      state(B, 0n, 5n, 0n),
      state(C, 0n, 0n, 0n),
    ];
    const built = buildStakerRows(states, claimed, 20n);
    expect(built.rows.map((row) => row.account)).toEqual([A, B]);
    expect(built.rows[1]).toEqual({
      account: B,
      stakedBalance: "0",
      rewardWeight: "5",
      earnedWeth: "0",
      claimedWeth: "9",
    });
    expect(built.activeStakerCount).toBe(1);
    expect(built.allTimeStakerCount).toBe(3);
    expect(built.totalEarnedWeth).toBe(3n);
    expect(built.totalClaimedWeth).toBe(9n);
    expect(built.truncated).toBe(false);
  });

  it("truncates rows past the limit while counts and totals stay complete", () => {
    const states = [
      state(A, 30n, 30n, 1n),
      state(B, 20n, 20n, 2n),
      state(C, 10n, 10n, 4n),
    ];
    const built = buildStakerRows(states, new Map(), 60n, 2);
    expect(built.rows.map((row) => row.account)).toEqual([A, B]);
    expect(built.truncated).toBe(true);
    expect(built.allTimeStakerCount).toBe(3);
    expect(built.activeStakerCount).toBe(3);
    expect(built.totalEarnedWeth).toBe(7n);
  });

  it("refuses to build a list whose balances do not sum to totalStaked", () => {
    const states = [state(A, 5n), state(B, 6n)];
    expect(() => buildStakerRows(states, new Map(), 12n)).toThrowError(
      StakerAccountingMismatchError,
    );
  });

  it("refuses a claim history naming an account outside the enumeration", () => {
    const claimed = new Map([[C.toLowerCase(), 1n]]);
    expect(() => buildStakerRows([state(A, 5n)], claimed, 5n)).toThrowError(
      StakerAccountingMismatchError,
    );
  });

  it("builds a verified empty register when nobody has staked", () => {
    const built = buildStakerRows([], new Map(), 0n);
    expect(built.rows).toEqual([]);
    expect(built.activeStakerCount).toBe(0);
    expect(built.allTimeStakerCount).toBe(0);
    expect(built.totalEarnedWeth).toBe(0n);
    expect(built.totalClaimedWeth).toBe(0n);
    expect(built.truncated).toBe(false);
  });
});
