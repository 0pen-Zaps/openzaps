import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { parseRelaySubmission, relayIntentNonce } from "@/lib/relay";

const SIG = `0x${"ab".repeat(65)}` as Hex;
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const HASH = "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270";

const recurring = {
  kind: "recurring",
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    chainId: "4663",
    seriesId: "1",
    validAfter: "0",
    deadline: "1893456000",
    interval: "86400",
    maxRuns: "10",
    recipient: ADDR,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: "3000000",
    maxFeePerGas: "10000000000",
    policyHash: HASH,
    outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
    minOutPerRun: "0",
  },
  signature: SIG,
};

const trigger = {
  kind: "trigger",
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    chainId: "4663",
    nonce: "7",
    validAfter: "0",
    deadline: "1893456000",
    priceSource: ADDR,
    baselinePriceX96: "79228162514264337593543950336",
    thresholdBps: "1000",
    above: true,
    recipient: ADDR,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: "3000000",
    maxFeePerGas: "10000000000",
    policyHash: HASH,
    outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
    minOut: "0",
  },
  signature: SIG,
};

describe("parseRelaySubmission", () => {
  it("accepts a well-formed recurring submission", () => {
    const s = parseRelaySubmission(recurring);
    expect(s.kind).toBe("recurring");
    expect(s.intent.interval).toBe("86400");
    expect(s.intent.zap).toBe(recurring.intent.zap.toLowerCase());
    expect(s.intent.outAsset).toBe(recurring.intent.outAsset.toLowerCase());
    expect(s.intent.policyHash).toBe(recurring.intent.policyHash.toLowerCase());
    expect(s.signature).toBe(SIG);
    expect(Object.keys(s.intent)).toHaveLength(14);
  });

  it("accepts a well-formed trigger submission", () => {
    const s = parseRelaySubmission(trigger);
    expect(s.kind).toBe("trigger");
    expect(s.intent.above).toBe(true);
  });

  it("rejects a uint field sent as a JSON number (precision loss)", () => {
    expect(() => parseRelaySubmission({ ...recurring, intent: { ...recurring.intent, seriesId: 1 } })).toThrow(/seriesId/);
  });

  it("canonicalizes every uint string so leading zeros cannot split one on-chain nonce", () => {
    const s = parseRelaySubmission({
      ...trigger,
      intent: {
        ...trigger.intent,
        chainId: "0004663",
        nonce: "0007",
        validAfter: "000",
        maxGas: "003000000",
        baselinePriceX96: "079228162514264337593543950336",
      },
    });
    expect(s.intent).toMatchObject({
      chainId: "4663",
      nonce: "7",
      validAfter: "0",
      maxGas: "3000000",
      baselinePriceX96: "79228162514264337593543950336",
    });
    expect(relayIntentNonce(s)).toBe("7");
  });

  it("rejects an unknown kind", () => {
    expect(() => parseRelaySubmission({ ...recurring, kind: "swap" })).toThrow(/kind/);
  });

  it("rejects a malformed signature", () => {
    expect(() => parseRelaySubmission({ ...recurring, signature: "0x1234" })).toThrow(/signature/);
  });

  it("rejects a missing field", () => {
    const rest = { ...recurring.intent } as Record<string, unknown>;
    delete rest.interval;
    expect(() => parseRelaySubmission({ ...recurring, intent: rest })).toThrow(/interval/);
  });

  it("rejects a malformed address", () => {
    expect(() => parseRelaySubmission({ ...recurring, intent: { ...recurring.intent, zap: "nope" } })).toThrow(/zap/);
  });
});

const recurringRelative = {
  kind: "recurring-relative",
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    chainId: "4663",
    seriesId: "3",
    validAfter: "0",
    deadline: "1893456000",
    interval: "86400",
    maxRuns: "10",
    recipient: ADDR,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: "3000000",
    maxFeePerGas: "10000000000",
    policyHash: HASH,
    outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
    priceSource: "0xB4f66bFa00D2496513a5fD43ff47912A3fe0Bb5F",
    maxSlippageBps: "500",
  },
  signature: SIG,
};

describe("recurring-relative kind", () => {
  it("accepts a well-formed relative submission and rejects a missing floor field", () => {
    const s = parseRelaySubmission(recurringRelative);
    expect(s.kind).toBe("recurring-relative");
    expect(s.intent.priceSource).toBe("0xb4f66bfa00d2496513a5fd43ff47912a3fe0bb5f");
    expect(s.intent.maxSlippageBps).toBe("500");
    expect("minOutPerRun" in s.intent).toBe(false);
    const noSlip = { ...recurringRelative, intent: { ...recurringRelative.intent } } as { intent: Record<string, unknown> };
    delete noSlip.intent.maxSlippageBps;
    expect(() => parseRelaySubmission(noSlip)).toThrow(/maxSlippageBps/);
  });

  it("uses seriesId as its dedup nonce", () => {
    expect(relayIntentNonce(parseRelaySubmission(recurringRelative))).toBe("3");
  });
});

describe("relayIntentNonce", () => {
  it("is seriesId for recurring and nonce for trigger", () => {
    expect(relayIntentNonce(parseRelaySubmission(recurring))).toBe("1");
    expect(relayIntentNonce(parseRelaySubmission(trigger))).toBe("7");
  });
});
