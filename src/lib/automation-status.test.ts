import { describe, expect, it } from "vitest";

import { parseAutomationIntent } from "@/lib/automation-records";
import { deriveAutomationLifecycle } from "@/lib/automation-status";

const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033";
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ZERO = "0x0000000000000000000000000000000000000000";
const OUT = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07";
const HASH = "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270";
const SIG = `0x${"ab".repeat(65)}`;

function recurring() {
  return parseAutomationIntent(JSON.stringify({
    kind: "recurring",
    intent: {
      zap: ZAP,
      chainId: "4663",
      seriesId: "1",
      validAfter: "100",
      deadline: "1000",
      interval: "100",
      maxRuns: "3",
      recipient: OWNER,
      executor: ZERO,
      maxGas: "2000000",
      maxFeePerGas: "10000000000",
      policyHash: HASH,
      outAsset: OUT,
      minOutPerRun: "1",
    },
    signature: SIG,
  }));
}

function trigger() {
  return parseAutomationIntent(JSON.stringify({
    kind: "trigger",
    intent: {
      zap: ZAP,
      chainId: "4663",
      nonce: "7",
      validAfter: "100",
      deadline: "1000",
      priceSource: "0xB4f66bFa00D2496513a5fD43ff47912A3fe0Bb5F",
      baselinePriceX96: "10000",
      thresholdBps: "1000",
      above: true,
      recipient: OWNER,
      executor: ZERO,
      maxGas: "2000000",
      maxFeePerGas: "10000000000",
      policyHash: HASH,
      outAsset: OUT,
      minOut: "1",
    },
    signature: SIG,
  }));
}

describe("deriveAutomationLifecycle", () => {
  it("distinguishes a cadence-locked series from a due run", () => {
    const waiting = deriveAutomationLifecycle(
      recurring(),
      { nonceUsed: false, runs: 1, lastRun: 200n, priceX96: null },
      { revoked: false, completed: false },
      250n,
    );
    const due = deriveAutomationLifecycle(
      recurring(),
      { nonceUsed: false, runs: 1, lastRun: 200n, priceX96: null },
      { revoked: false, completed: false },
      300n,
    );
    expect(waiting.lifecycle).toBe("waiting");
    expect(due.lifecycle).toBe("due");
    expect(due.cancelable).toBe(true);
  });

  it("marks a trigger armed only after its one-sided bound is met", () => {
    expect(deriveAutomationLifecycle(
      trigger(),
      { nonceUsed: false, runs: null, lastRun: null, priceX96: 10_999n },
      { revoked: false, completed: false },
      200n,
    ).lifecycle).toBe("waiting");
    expect(deriveAutomationLifecycle(
      trigger(),
      { nonceUsed: false, runs: null, lastRun: null, priceX96: 11_000n },
      { revoked: false, completed: false },
      200n,
    ).lifecycle).toBe("armed");
  });

  it("uses explicit revocation and completion events ahead of nonceUsed ambiguity", () => {
    const chain = { nonceUsed: true, runs: 1, lastRun: 200n, priceX96: null };
    expect(deriveAutomationLifecycle(recurring(), chain, { revoked: true, completed: false }, 300n).lifecycle).toBe("revoked");
    expect(deriveAutomationLifecycle(recurring(), chain, { revoked: false, completed: true }, 300n).lifecycle).toBe("completed");
  });

  it("fails closed when nonce state cannot be read", () => {
    const state = deriveAutomationLifecycle(recurring(), null, { revoked: false, completed: false }, 300n);
    expect(state.lifecycle).toBe("unavailable");
    expect(state.cancelable).toBe(false);
  });

  it("labels an unshared local capsule as a draft", () => {
    expect(deriveAutomationLifecycle(null, null, { revoked: false, completed: false }, 300n).lifecycle).toBe("draft");
  });
});
