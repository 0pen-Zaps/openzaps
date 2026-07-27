import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import {
  BPS,
  EXEC_FEE_BPS,
  EXECUTOR_SHARE_BPS,
  buildRecurringRelativeTypedData,
  buildRecurringStackTypedData,
  buildRecurringTypedData,
  buildTriggerTypedData,
  computeExecutorFeeSplit,
  computeStackSplit,
  isTriggerArmed,
  isValidStackBps,
  nextRunAt,
  serializeIntentFile,
  slippageClearsFee,
  triggerBoundX96,
  type RecurringIntent,
  type RecurringRelativeIntent,
  type RecurringStackIntent,
  type TriggerIntent,
} from "@/lib/executions";

const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as Address;
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const HASH = "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270" as Hex;

const recurring: RecurringIntent = {
  zap: ZAP,
  chainId: 4663n,
  seriesId: 1n,
  validAfter: 0n,
  deadline: 1_793_750_400n,
  interval: 86_400n,
  maxRuns: 30,
  recipient: ADDR,
  executor: "0x0000000000000000000000000000000000000000",
  maxGas: 1_500_000n,
  maxFeePerGas: 2_000_000_000n,
  policyHash: HASH,
  outAsset: ADDR,
  minOutPerRun: parseEther("98"),
};

const trigger: TriggerIntent = {
  ...recurring,
  nonce: 7n,
  priceSource: ADDR,
  baselinePriceX96: parseEther("1000"),
  thresholdBps: 1000,
  above: true,
  minOut: parseEther("98"),
};

describe("computeExecutorFeeSplit", () => {
  it("carves 1% and splits it 80/20", () => {
    const split = computeExecutorFeeSplit(parseEther("100"));
    expect(split.fee).toBe(parseEther("1"));
    expect(split.executorCut).toBe(parseEther("0.8"));
    expect(split.potCut).toBe(parseEther("0.2"));
    expect(split.net).toBe(parseEther("99"));
  });

  it("mirrors the contract's floor-division rounding", () => {
    // below 100 wei the 1% fee floors to zero — everything reaches the recipient
    expect(computeExecutorFeeSplit(99n)).toEqual({ fee: 0n, executorCut: 0n, potCut: 0n, net: 99n });
    // conservation holds for awkward amounts
    for (const out of [10_001n, 123_456_789n, 999_999_999_999_999_999n]) {
      const { fee, executorCut, potCut, net } = computeExecutorFeeSplit(out);
      expect(executorCut + potCut).toBe(fee);
      expect(net + fee).toBe(out);
      expect(fee).toBe((out * EXEC_FEE_BPS) / BPS);
      expect(executorCut).toBe((fee * EXECUTOR_SHARE_BPS) / BPS);
    }
  });
});

describe("trigger math", () => {
  it("computes the +10% and -10% bounds the capsule enforces", () => {
    expect(triggerBoundX96(parseEther("1000"), 1000n, true)).toBe(parseEther("1100"));
    expect(triggerBoundX96(parseEther("1000"), 1000n, false)).toBe(parseEther("900"));
  });

  it("arms exactly at the bound, never before", () => {
    const base = parseEther("1000");
    expect(isTriggerArmed(parseEther("1100") - 1n, base, 1000n, true)).toBe(false);
    expect(isTriggerArmed(parseEther("1100"), base, 1000n, true)).toBe(true);
    expect(isTriggerArmed(parseEther("900") + 1n, base, 1000n, false)).toBe(false);
    expect(isTriggerArmed(parseEther("900"), base, 1000n, false)).toBe(true);
  });
});

describe("nextRunAt", () => {
  it("gates the first run on validAfter and later runs on the interval", () => {
    expect(nextRunAt(0n, 0n, 3600n, 1_000n)).toBe(1_000n);
    expect(nextRunAt(3n, 50_000n, 3600n, 1_000n)).toBe(53_600n);
  });
});

describe("typed data builders", () => {
  // Independent digest derivation, mirroring contracts/test/BaseV3.t.sol byte for byte: if either
  // the builder or the contract changes shape, this and the Foundry suite disagree.
  const DOMAIN_TYPEHASH = keccak256(
    stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  const RECURRING_TYPEHASH = keccak256(
    stringToHex(
      "RecurringIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOutPerRun)",
    ),
  );

  function manualRecurringDigest(it_: RecurringIntent): Hex {
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [DOMAIN_TYPEHASH, keccak256(stringToHex("OpenZap")), keccak256(stringToHex("3")), it_.chainId, it_.zap],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "uint32" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "address" },
          { type: "uint256" },
        ],
        [
          RECURRING_TYPEHASH,
          it_.zap,
          it_.chainId,
          it_.seriesId,
          it_.validAfter,
          it_.deadline,
          it_.interval,
          it_.maxRuns,
          it_.recipient,
          it_.executor,
          it_.maxGas,
          it_.maxFeePerGas,
          it_.policyHash,
          it_.outAsset,
          it_.minOutPerRun,
        ],
      ),
    );
    return keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex);
  }

  it("recurring typed data hashes to the same digest the capsule computes", () => {
    expect(hashTypedData(buildRecurringTypedData(recurring))).toBe(manualRecurringDigest(recurring));
  });

  it("binds the domain to the zap address and chain (no cross-clone replay)", () => {
    const digest = hashTypedData(buildRecurringTypedData(recurring));
    expect(hashTypedData(buildRecurringTypedData({ ...recurring, zap: ADDR }))).not.toBe(digest);
    expect(hashTypedData(buildRecurringTypedData({ ...recurring, chainId: 1n }))).not.toBe(digest);
  });

  const RECURRING_RELATIVE_TYPEHASH = keccak256(
    stringToHex(
      "RecurringRelativeIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps)",
    ),
  );

  const relative: RecurringRelativeIntent = {
    zap: ZAP,
    chainId: 4663n,
    seriesId: 3n,
    validAfter: 0n,
    deadline: 1_793_750_400n,
    interval: 86_400n,
    maxRuns: 10,
    recipient: ADDR,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: 3_000_000n,
    maxFeePerGas: 10_000_000_000n,
    policyHash: HASH,
    outAsset: ADDR,
    priceSource: ZAP,
    maxSlippageBps: 500,
  };

  function manualRelativeDigest(it_: RecurringRelativeIntent): Hex {
    // Domain version "3.1" — a distinct signing surface from v3 ("3"), so a v3 sig can't replay.
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [DOMAIN_TYPEHASH, keccak256(stringToHex("OpenZap")), keccak256(stringToHex("3.1")), it_.chainId, it_.zap],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" },
          { type: "uint64" }, { type: "uint64" }, { type: "uint32" }, { type: "address" }, { type: "address" },
          { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "address" },
          { type: "uint32" },
        ],
        [
          RECURRING_RELATIVE_TYPEHASH, it_.zap, it_.chainId, it_.seriesId, it_.validAfter, it_.deadline, it_.interval,
          it_.maxRuns, it_.recipient, it_.executor, it_.maxGas, it_.maxFeePerGas, it_.policyHash, it_.outAsset,
          it_.priceSource, it_.maxSlippageBps,
        ],
      ),
    );
    return keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex);
  }

  it("relative typed data hashes to the same digest the v3.1 capsule computes (domain 3.1)", () => {
    expect(hashTypedData(buildRecurringRelativeTypedData(relative))).toBe(manualRelativeDigest(relative));
  });

  it("relative digest differs from an otherwise-identical v3 recurring digest (no cross-version replay)", () => {
    // Same seriesId/zap/chain but different domain version + typehash → different digest.
    const rel = hashTypedData(buildRecurringRelativeTypedData(relative));
    const rec = hashTypedData(buildRecurringTypedData({ ...recurring, zap: ZAP, seriesId: 3n }));
    expect(rel).not.toBe(rec);
  });

  const RECURRING_STACK_TYPEHASH = keccak256(
    stringToHex(
      "RecurringStackIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps,address stackPriceSource,uint32 stackBps)",
    ),
  );

  const stack: RecurringStackIntent = {
    ...relative,
    maxSlippageBps: 500,
    stackPriceSource: ADDR,
    stackBps: 500,
  };

  function manualStackDigest(it_: RecurringStackIntent): Hex {
    // Domain version "3.2" — distinct from both "3" and "3.1".
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [DOMAIN_TYPEHASH, keccak256(stringToHex("OpenZap")), keccak256(stringToHex("3.2")), it_.chainId, it_.zap],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" },
          { type: "uint64" }, { type: "uint64" }, { type: "uint32" }, { type: "address" }, { type: "address" },
          { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "address" },
          { type: "uint32" }, { type: "address" }, { type: "uint32" },
        ],
        [
          RECURRING_STACK_TYPEHASH, it_.zap, it_.chainId, it_.seriesId, it_.validAfter, it_.deadline, it_.interval,
          it_.maxRuns, it_.recipient, it_.executor, it_.maxGas, it_.maxFeePerGas, it_.policyHash, it_.outAsset,
          it_.priceSource, it_.maxSlippageBps, it_.stackPriceSource, it_.stackBps,
        ],
      ),
    );
    return keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex);
  }

  it("stack typed data hashes to the same digest the v3.2 capsule computes (domain 3.2)", () => {
    expect(hashTypedData(buildRecurringStackTypedData(stack))).toBe(manualStackDigest(stack));
  });

  it("a v3.1 relative signature cannot be replayed as a stacking authorization", () => {
    // Identical schedule, route, and recipient — but stacking diverts output the relative signer
    // never agreed to, so the two MUST hash differently under every circumstance.
    expect(hashTypedData(buildRecurringStackTypedData(stack))).not.toBe(
      hashTypedData(buildRecurringRelativeTypedData(relative)),
    );
  });

  it("stack digest changes with the slice and the conversion source", () => {
    const digest = hashTypedData(buildRecurringStackTypedData(stack));
    expect(hashTypedData(buildRecurringStackTypedData({ ...stack, stackBps: 501 }))).not.toBe(digest);
    expect(hashTypedData(buildRecurringStackTypedData({ ...stack, stackPriceSource: ZAP }))).not.toBe(digest);
  });

  it("trigger typed data changes with every authority-bearing field", () => {
    const digest = hashTypedData(buildTriggerTypedData(trigger));
    expect(hashTypedData(buildTriggerTypedData({ ...trigger, above: false }))).not.toBe(digest);
    expect(hashTypedData(buildTriggerTypedData({ ...trigger, thresholdBps: 999 }))).not.toBe(digest);
    expect(hashTypedData(buildTriggerTypedData({ ...trigger, priceSource: ZAP }))).not.toBe(digest);
  });
});

describe("computeStackSplit", () => {
  it("carves the protocol fee FIRST, then the slice from what remains", () => {
    // 1_000_000 out → 1% fee = 10_000 (8_000 executor / 2_000 pot), post-fee 990_000.
    // 5% slice of 990_000 = 49_500 → recipient 940_500.
    const split = computeStackSplit(1_000_000n, 500);
    expect(split.fee).toBe(10_000n);
    expect(split.executorCut).toBe(8_000n);
    expect(split.potCut).toBe(2_000n);
    expect(split.net).toBe(990_000n);
    expect(split.stackIn).toBe(49_500n);
    expect(split.toRecipient).toBe(940_500n);
  });

  it("conserves value exactly — nothing is created or lost by stacking", () => {
    for (const out of [1n, 7n, 12_345n, 999_999_999_999n, 10n ** 24n]) {
      for (const bps of [1, 100, 500, 2_500, 9_999]) {
        const s = computeStackSplit(out, bps);
        expect(s.executorCut + s.potCut + s.stackIn + s.toRecipient).toBe(out);
      }
    }
  });

  it("leaves the executor and pot fee untouched by the slice size", () => {
    // Stacking must never change what the executor earns, or executors would prefer some series.
    const base = computeExecutorFeeSplit(1_000_000n);
    for (const bps of [1, 500, 9_999]) {
      const s = computeStackSplit(1_000_000n, bps);
      expect(s.executorCut).toBe(base.executorCut);
      expect(s.potCut).toBe(base.potCut);
    }
  });

  it("floors the slice to zero on dust, which the capsule rejects rather than silently no-ops", () => {
    // 99 post-fee wei at 1 bps rounds to 0 — StackSliceUnderflow on-chain.
    expect(computeStackSplit(100n, 1).stackIn).toBe(0n);
  });
});

describe("slippageClearsFee", () => {
  it("rejects any band at or inside the 1% protocol fee", () => {
    // The floor is GROSS-derived but NET-enforced, so these bands brick every run of the series.
    // This is the exact live v3.1 failure the v3.2 capsule now refuses to sign at all.
    expect(slippageClearsFee(0)).toBe(false);
    expect(slippageClearsFee(50)).toBe(false);
    expect(slippageClearsFee(100)).toBe(false); // EXEC_FEE_BPS itself — the trap value
  });

  it("accepts a band above the fee and below 100%", () => {
    expect(slippageClearsFee(101)).toBe(true);
    expect(slippageClearsFee(500)).toBe(true);
    expect(slippageClearsFee(9_999)).toBe(true);
    expect(slippageClearsFee(10_000)).toBe(false); // would disable the floor entirely
  });
});

describe("isValidStackBps", () => {
  it("requires a real slice strictly between 0% and 100%", () => {
    expect(isValidStackBps(0)).toBe(false); // that's a RecurringRelativeIntent, not a stack
    expect(isValidStackBps(1)).toBe(true);
    expect(isValidStackBps(9_999)).toBe(true);
    expect(isValidStackBps(10_000)).toBe(false); // would divert the recipient's entire leg
  });
});

describe("serializeIntentFile", () => {
  it("round-trips to the executor's on-disk format (bigints as decimal strings)", () => {
    const sig = `0x${"ab".repeat(65)}` as Hex;
    const parsed = JSON.parse(serializeIntentFile("recurring", recurring, sig));
    expect(parsed.kind).toBe("recurring");
    expect(parsed.signature).toBe(sig);
    expect(parsed.intent.interval).toBe("86400");
    expect(parsed.intent.maxRuns).toBe("30");
    expect(parsed.intent.zap).toBe(ZAP);
    expect(Object.keys(parsed.intent)).toHaveLength(14);

    const trig = JSON.parse(serializeIntentFile("trigger", trigger, sig));
    expect(trig.intent.above).toBe(true);
    expect(trig.intent.baselinePriceX96).toBe(parseEther("1000").toString());
  });
});
