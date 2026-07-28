import { describe, expect, it } from "vitest";

import { groundAnswer, isGrounded } from "@/app/api/agent/ask/route";
import { ZAP_FACT_KEYS, serializeFacts, zapFacts, type ZapFact } from "@/lib/agent-context";
import type { ZapDetailPayload } from "@/lib/zap";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as const;
const ADAPTER = "0x04f62dA4b51a010eFa32aa81569169C47AEd602C" as const;
const CALLDATA = `0x${"ab".repeat(120)}` as const;

function payload(overrides: Partial<ZapDetailPayload> = {}): ZapDetailPayload {
  return {
    provenance: {
      address: ZAP,
      owner: OWNER,
      policyHash: `0x${"11".repeat(32)}`,
      implCodeHash: `0x${"22".repeat(32)}`,
      salt: `0x${"33".repeat(32)}`,
      createdBlock: "20104418",
      createdTx: `0x${"44".repeat(32)}`,
      createdAt: 1_785_092_325,
    },
    policy: {
      owner: OWNER,
      recipient: OWNER,
      maxRelayerFeeCap: "0",
      optimization: true,
      trackedAssets: [ADAPTER],
      stepCount: "1",
      step: { adapter: ADAPTER, tokenIn: ADAPTER, spender: ADAPTER, amountIn: "10000000000000000", data: CALLDATA },
      policyHash: `0x${"11".repeat(32)}`,
      direction: "buy",
      routeKind: "swap",
      inputSymbol: "aeWETH",
      outputSymbol: "0xZAPS",
      hashMatches: true,
      canonicalClone: true,
      matchesLiveRoute: true,
      deviations: [],
    },
    stats: {
      executionCount: 2,
      recoveryCount: 0,
      amountOutByAsset: { "0xZAPS": "1716346053537753342021997" },
      feeByAsset: {},
      firstExecutionAt: 1_785_100_000,
      lastExecutionAt: 1_785_189_674,
    },
    balances: { weth: "0", zaps: "0", native: "0" },
    executions: [],
    recoveries: [],
    lifecycle: "executed",
    headBlock: "21073692",
    readAt: "2026-07-27T00:00:00.000Z",
    factory: { version: "v3.1", implementation: ADAPTER },
    ...overrides,
  } as ZapDetailPayload;
}

describe("zapFacts", () => {
  it("never emits the frozen calldata", () => {
    // A model has no use for a calldata blob and every reason not to have one.
    const serialized = serializeFacts(zapFacts(payload()));
    expect(serialized).not.toContain(CALLDATA);
    expect(serialized).not.toContain("ababab");
  });

  it("never emits the raw executions array", () => {
    const withRuns = payload({
      executions: Array.from({ length: 40 }, (_, i) => ({
        nonce: String(i),
        recipient: OWNER,
        outAsset: ADAPTER,
        assetSymbol: "0xZAPS",
        amountOut: "1",
        fee: "0",
        txHash: `0x${"55".repeat(32)}`,
        blockNumber: "1",
        logIndex: i,
        timestamp: null,
      })),
    } as Partial<ZapDetailPayload>);
    const facts = zapFacts(withRuns);
    expect(facts.some((fact) => fact.key === "executionCount")).toBe(true);
    expect(serializeFacts(facts)).not.toContain('"nonce"');
  });

  it("only emits keys that are in the declared key list", () => {
    // The list is the contract; a fact outside it means the projection grew
    // without anyone deciding it should.
    for (const fact of zapFacts(payload())) {
      expect(ZAP_FACT_KEYS, fact.key).toContain(fact.key);
    }
  });

  it("surfaces the adapter address but not the step data", () => {
    const facts = zapFacts(payload());
    expect(facts.find((fact) => fact.key === "adapter")?.value).toBe(ADAPTER);
    expect(facts.some((fact) => fact.value === CALLDATA)).toBe(false);
  });

  it("reports deviations plainly, including when there are none", () => {
    expect(zapFacts(payload()).find((f) => f.key === "deviations")?.value).toBe("none");

    const broken = payload({
      policy: { ...payload().policy, hashMatches: false, deviations: ["Committed hash does not match."] },
    } as Partial<ZapDetailPayload>);
    const facts = zapFacts(broken);
    expect(facts.find((f) => f.key === "deviations")?.value).toContain("Committed hash");
    expect(facts.find((f) => f.key === "hashMatches")?.value).toBe("NO");
  });

  it("omits empty and null values rather than emitting blanks", () => {
    const bare = payload({ stats: { ...payload().stats, feeByAsset: {}, firstExecutionAt: null } } as Partial<ZapDetailPayload>);
    const facts = zapFacts(bare);
    expect(facts.some((fact) => fact.key === "feeByAsset")).toBe(false);
    expect(facts.some((fact) => fact.key === "firstExecutionAt")).toBe(false);
    expect(facts.every((fact) => fact.value.length > 0)).toBe(true);
  });
});

describe("isGrounded", () => {
  const facts: ZapFact[] = [
    { key: "address", label: "capsule", value: ZAP },
    { key: "amountOutByAsset", label: "total out", value: "1716346053537753342021997 0xZAPS" },
    { key: "executionCount", label: "confirmed runs", value: "2" },
  ];

  it("accepts an answer that only restates supplied values", () => {
    expect(isGrounded(`It has run 2 times, producing 1716346053537753342021997 0xZAPS.`, facts)).toBe(true);
    expect(isGrounded(`The capsule is ${ZAP}.`, facts)).toBe(true);
  });

  it("rejects an invented address or hash", () => {
    expect(isGrounded("It pays out to 0xdeadbeefcafebabe0000000000000000000000ff.", facts)).toBe(false);
  });

  it("rejects an invented large number", () => {
    expect(isGrounded("It produced 9999999999999999999 0xZAPS.", facts)).toBe(false);
  });

  it("lets ordinary short numbers through", () => {
    // "2 runs", "1%", "30 days" are prose, not claims about balances.
    expect(isGrounded("It ran 2 times over 30 days, paying a 1% fee.", facts)).toBe(true);
  });

  it("compares digits with separators stripped", () => {
    expect(isGrounded("Total out: 1,716,346,053,537,753,342,021,997.", facts)).toBe(true);
  });
});

describe("groundAnswer", () => {
  const facts = zapFacts(payload());

  it("returns the model's answer with values re-read from the payload", () => {
    const result = groundAnswer(
      { answer: "It has run twice.", cites: ["executionCount"], unanswerable: false },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer).toBe("It has run twice.");
    // The value came from the payload, not from the prose.
    expect(result.cited).toEqual([{ key: "executionCount", label: "confirmed runs", value: "2" }]);
  });

  it("falls back to the facts when a cited key was never supplied", () => {
    const partial: ZapFact[] = [{ key: "address", label: "capsule", value: ZAP }];
    const result = groundAnswer({ answer: "It ran 2 times.", cites: ["executionCount"], unanswerable: false }, partial);
    if (!result.ok) throw new Error("expected the deterministic fallback");
    expect(result.answer).toContain("cited a fact it was not given");
    expect(result.cited).toEqual([{ key: "address", label: "capsule", value: ZAP }]);
  });

  it("falls back to the facts when the answer invents a figure", () => {
    const result = groundAnswer(
      { answer: "Its balance is 8888888888888888888 wei.", cites: ["balanceWeth"], unanswerable: false },
      facts,
    );
    if (!result.ok) throw new Error("expected the deterministic fallback");
    expect(result.answer).toContain("a figure the capsule does not report");
  });

  it("accepts an explicit unanswerable without citations", () => {
    const result = groundAnswer(
      { answer: "The facts do not say who deployed it.", cites: [], unanswerable: true },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cited).toEqual([]);
  });

  it("falls back on a malformed answer", () => {
    for (const input of [null, {}, { answer: "" }, { answer: 42 }]) {
      const result = groundAnswer(input, facts);
      if (!result.ok) throw new Error("expected the deterministic fallback");
      expect(result.answer).toContain("malformed");
    }
  });
});
