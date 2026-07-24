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
  buildRecurringTypedData,
  buildTriggerTypedData,
  computeExecutorFeeSplit,
  isTriggerArmed,
  nextRunAt,
  serializeIntentFile,
  triggerBoundX96,
  type RecurringIntent,
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

  it("trigger typed data changes with every authority-bearing field", () => {
    const digest = hashTypedData(buildTriggerTypedData(trigger));
    expect(hashTypedData(buildTriggerTypedData({ ...trigger, above: false }))).not.toBe(digest);
    expect(hashTypedData(buildTriggerTypedData({ ...trigger, thresholdBps: 999 }))).not.toBe(digest);
    expect(hashTypedData(buildTriggerTypedData({ ...trigger, priceSource: ZAP }))).not.toBe(digest);
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
