import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  MAX_ROUTER_AMOUNT,
  buildRobinhoodPolicy,
  expectedCloneRuntime,
  hashRobinhoodPolicy,
} from "@/lib/openzap";
import { OPENZAP_CONTRACTS, ROBINHOOD_ASSETS } from "@/lib/robinhood";
import {
  ZAP_STEP_READ_LIMIT,
  ZapNotFoundError,
  aggregateZapDetail,
  assertCanonicalClone,
  assetSymbolForDisplay,
  deriveLifecycle,
  isZapNotFound,
  newestZapCreations,
  stepsToRead,
  type ZapCreatedLogInput,
  type ZapDetailInput,
  type ZapExecutedLogInput,
  type ZapExitLogInput,
  type ZapPolicyRead,
  type ZapStepRead,
} from "@/lib/zap";

const ZAP = "0x7f0BE9e9dD17c57df38F46b7fEFc4EdB7f1243AB" as const;
const OWNER = "0x5a52D4B820Ae7F02880d270562950918ACb14aA2" as const;
const SPOOFER = "0x9999999999999999999999999999999999999999" as const;
const AMOUNT_IN = 100n * 10n ** 18n;
const HEX32 = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const NOW = "2026-07-22T00:00:00.000Z";
const RUNTIME = expectedCloneRuntime(OPENZAP_CONTRACTS.implementation);

/** The canonical live-route policy: a single-step aeWETH -> 0xZAPS buy. */
const canonicalPolicy = buildRobinhoodPolicy(OWNER, "buy", AMOUNT_IN);

function policyRead(overrides: Partial<ZapPolicyRead> = {}): ZapPolicyRead {
  return {
    owner: OWNER,
    recipient: OWNER,
    maxRelayerFeeCap: 0n,
    optimization: true,
    trackedAssets: [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps],
    stepCount: 1n,
    steps: canonicalPolicy.steps as readonly ZapStepRead[],
    policyHash: hashRobinhoodPolicy(canonicalPolicy),
    ...overrides,
  };
}

function created(overrides: Partial<ZapCreatedLogInput> = {}): ZapCreatedLogInput {
  return {
    zap: ZAP,
    owner: OWNER,
    policyHash: hashRobinhoodPolicy(canonicalPolicy),
    implCodeHash: HEX32(0xabc),
    salt: HEX32(0xdef),
    txHash: HEX32(1),
    blockNumber: 100n,
    logIndex: 0,
    ...overrides,
  };
}

function executed(overrides: Partial<ZapExecutedLogInput> = {}): ZapExecutedLogInput {
  return {
    emitter: ZAP,
    nonce: 7n,
    recipient: OWNER,
    outAsset: ROBINHOOD_ASSETS.zaps,
    amountOut: 5n * 10n ** 18n,
    fee: 0n,
    txHash: HEX32(2),
    blockNumber: 200n,
    logIndex: 3,
    ...overrides,
  };
}

function exited(overrides: Partial<ZapExitLogInput> = {}): ZapExitLogInput {
  return {
    emitter: ZAP,
    owner: OWNER,
    asset: ROBINHOOD_ASSETS.weth,
    amount: 10n ** 15n,
    txHash: HEX32(3),
    blockNumber: 300n,
    logIndex: 1,
    ...overrides,
  };
}

function detailInput(overrides: Partial<ZapDetailInput> = {}): ZapDetailInput {
  return {
    address: ZAP,
    created: created(),
    policy: policyRead(),
    factory: { version: "1.1.0", implementation: OPENZAP_CONTRACTS.implementation },
    runtime: RUNTIME,
    balances: { weth: 0n, zaps: 0n, native: 0n },
    executed: [],
    exits: [],
    timestamps: new Map(),
    headBlock: 1_000n,
    readAt: NOW,
    ...overrides,
  };
}

describe("aggregateZapDetail provenance gate", () => {
  it("refuses a ZapCreated log that names a different zap", () => {
    expect(() => aggregateZapDetail(detailInput({ created: created({ zap: SPOOFER }) }))).toThrow(
      /does not belong to this zap/,
    );
  });

  it("accepts a lowercase creation log for a checksummed address", () => {
    const payload = aggregateZapDetail(
      detailInput({ created: created({ zap: ZAP.toLowerCase() as `0x${string}` }) }),
    );
    expect(payload.provenance.address).toBe(ZAP);
    expect(payload.provenance.owner).toBe(OWNER);
  });

  it("drops Executed and EmergencyExit logs emitted by another contract", () => {
    const payload = aggregateZapDetail(
      detailInput({
        executed: [executed(), executed({ emitter: SPOOFER, amountOut: 999n * 10n ** 18n, txHash: HEX32(9) })],
        exits: [exited({ emitter: SPOOFER, txHash: HEX32(10) })],
      }),
    );
    expect(payload.stats.executionCount).toBe(1);
    expect(payload.stats.recoveryCount).toBe(0);
    expect(payload.stats.amountOutByAsset["0xZAPS"]).toBe((5n * 10n ** 18n).toString());
    expect(payload.executions.every((entry) => entry.txHash === HEX32(2))).toBe(true);
  });

  it("counts an execution whose emitter arrives lowercase from the RPC", () => {
    const payload = aggregateZapDetail(
      detailInput({ executed: [executed({ emitter: ZAP.toLowerCase() as `0x${string}` })] }),
    );
    expect(payload.stats.executionCount).toBe(1);
  });
});

describe("aggregateZapDetail stats", () => {
  it("reports amountOut net of fee so gross is amountOut + fee", () => {
    const payload = aggregateZapDetail(
      detailInput({ executed: [executed({ amountOut: 9n * 10n ** 17n, fee: 10n ** 17n })] }),
    );
    expect(payload.stats.amountOutByAsset["0xZAPS"]).toBe((9n * 10n ** 17n).toString());
    expect(payload.stats.feeByAsset["0xZAPS"]).toBe((10n ** 17n).toString());
    const gross =
      BigInt(payload.stats.amountOutByAsset["0xZAPS"]) + BigInt(payload.stats.feeByAsset["0xZAPS"]);
    expect(gross).toBe(10n ** 18n);
  });

  it("sums output and fees per asset across executions", () => {
    const payload = aggregateZapDetail(
      detailInput({
        executed: [
          executed({ amountOut: 2n * 10n ** 18n, fee: 1n, txHash: HEX32(4) }),
          executed({ amountOut: 3n * 10n ** 18n, fee: 2n, txHash: HEX32(5), logIndex: 4 }),
          executed({ outAsset: ROBINHOOD_ASSETS.weth, amountOut: 10n ** 15n, fee: 5n, txHash: HEX32(6), logIndex: 5 }),
        ],
      }),
    );
    expect(payload.stats.amountOutByAsset["0xZAPS"]).toBe((5n * 10n ** 18n).toString());
    expect(payload.stats.feeByAsset["0xZAPS"]).toBe("3");
    expect(payload.stats.amountOutByAsset["aeWETH"]).toBe((10n ** 15n).toString());
    expect(payload.stats.feeByAsset["aeWETH"]).toBe("5");
  });

  it("orders executions newest first and reports first/last timestamps it knows", () => {
    const payload = aggregateZapDetail(
      detailInput({
        executed: [
          executed({ blockNumber: 200n, logIndex: 1, txHash: HEX32(4) }),
          executed({ blockNumber: 400n, logIndex: 0, txHash: HEX32(5) }),
        ],
        timestamps: new Map([
          [200n, 1_700_000_000],
          [400n, 1_700_009_999],
        ]),
      }),
    );
    expect(payload.executions.map((entry) => entry.txHash)).toEqual([HEX32(5), HEX32(4)]);
    expect(payload.stats.firstExecutionAt).toBe(1_700_000_000);
    expect(payload.stats.lastExecutionAt).toBe(1_700_009_999);
  });

  it("leaves timestamps null when the block was outside the budget", () => {
    const payload = aggregateZapDetail(detailInput({ executed: [executed()] }));
    expect(payload.executions[0].timestamp).toBeNull();
    expect(payload.stats.firstExecutionAt).toBeNull();
    expect(payload.provenance.createdAt).toBeNull();
  });
});

describe("assetSymbolForDisplay", () => {
  it("maps the zero address to ETH and the pool assets to their symbols", () => {
    expect(assetSymbolForDisplay(zeroAddress)).toBe("ETH");
    expect(assetSymbolForDisplay(ROBINHOOD_ASSETS.weth)).toBe("aeWETH");
    expect(assetSymbolForDisplay(ROBINHOOD_ASSETS.zaps)).toBe("0xZAPS");
    expect(assetSymbolForDisplay(SPOOFER)).toBe("0x9999…9999");
  });

  it("labels a native-ETH recovery as ETH", () => {
    const payload = aggregateZapDetail(detailInput({ exits: [exited({ asset: zeroAddress })] }));
    expect(payload.recoveries[0].assetSymbol).toBe("ETH");
  });
});

describe("deriveLifecycle", () => {
  const zeroBalances = { weth: "0", zaps: "0", native: "0" };

  it("reads created when nothing has happened and nothing is held", () => {
    expect(deriveLifecycle([], [], zeroBalances)).toBe("created");
    expect(aggregateZapDetail(detailInput()).lifecycle).toBe("created");
  });

  it("reads funded when the zap holds a balance but has no events", () => {
    expect(deriveLifecycle([], [], { ...zeroBalances, weth: "1" })).toBe("funded");
    expect(aggregateZapDetail(detailInput({ balances: { weth: 10n ** 18n, zaps: 0n, native: 0n } })).lifecycle).toBe(
      "funded",
    );
    expect(aggregateZapDetail(detailInput({ balances: { weth: 0n, zaps: 0n, native: 1n } })).lifecycle).toBe("funded");
  });

  it("reads executed after an Executed log", () => {
    expect(aggregateZapDetail(detailInput({ executed: [executed()] })).lifecycle).toBe("executed");
  });

  it("reads recovered when the newest event is an EmergencyExit", () => {
    const payload = aggregateZapDetail(
      detailInput({ executed: [executed({ blockNumber: 200n })], exits: [exited({ blockNumber: 300n })] }),
    );
    expect(payload.lifecycle).toBe("recovered");
  });

  it("reads executed again when an execution follows a recovery", () => {
    const payload = aggregateZapDetail(
      detailInput({ executed: [executed({ blockNumber: 400n })], exits: [exited({ blockNumber: 300n })] }),
    );
    expect(payload.lifecycle).toBe("executed");
  });
});

describe("assertCanonicalClone", () => {
  it("accepts the EIP-1167 runtime of this release's implementation", () => {
    expect(assertCanonicalClone(RUNTIME, OPENZAP_CONTRACTS.implementation)).toBe(true);
    expect(assertCanonicalClone(RUNTIME.toUpperCase() as `0x${string}`, OPENZAP_CONTRACTS.implementation)).toBe(true);
  });

  it("rejects missing code, a foreign runtime, and a foreign implementation", () => {
    expect(assertCanonicalClone(null, OPENZAP_CONTRACTS.implementation)).toBe(false);
    expect(assertCanonicalClone("0x6080604052", OPENZAP_CONTRACTS.implementation)).toBe(false);
    expect(assertCanonicalClone(expectedCloneRuntime(SPOOFER), SPOOFER)).toBe(false);
  });
});

describe("policy view", () => {
  it("derives the buy direction and its symbols for an aeWETH input", () => {
    const { policy } = aggregateZapDetail(detailInput());
    expect(policy.direction).toBe("buy");
    expect(policy.inputSymbol).toBe("aeWETH");
    expect(policy.outputSymbol).toBe("0xZAPS");
    expect(policy.step?.amountIn).toBe(AMOUNT_IN.toString());
  });

  it("derives the sell direction for a 0xZAPS input", () => {
    const sellPolicy = buildRobinhoodPolicy(OWNER, "sell", AMOUNT_IN);
    const { policy } = aggregateZapDetail(
      detailInput({
        policy: policyRead({
          steps: sellPolicy.steps as readonly ZapStepRead[],
          policyHash: hashRobinhoodPolicy(sellPolicy),
        }),
      }),
    );
    expect(policy.direction).toBe("sell");
    expect(policy.inputSymbol).toBe("0xZAPS");
    expect(policy.outputSymbol).toBe("aeWETH");
  });

  it("reports hashMatches and an empty deviation list for a live-route zap", () => {
    const { policy } = aggregateZapDetail(detailInput());
    expect(policy.hashMatches).toBe(true);
    expect(policy.canonicalClone).toBe(true);
    expect(policy.matchesLiveRoute).toBe(true);
    expect(policy.deviations).toEqual([]);
  });

  it("reports hashMatches false when the committed hash is not the policy's own", () => {
    const { policy } = aggregateZapDetail(
      detailInput({ policy: policyRead({ policyHash: HEX32(0xbad) }) }),
    );
    expect(policy.hashMatches).toBe(false);
    expect(policy.matchesLiveRoute).toBe(false);
    expect(policy.deviations).toContain("Policy hash does not match the policy this zap exposes.");
  });

  it("cannot recompute the hash when fewer steps were read than declared", () => {
    const { policy } = aggregateZapDetail(detailInput({ policy: policyRead({ stepCount: 3n }) }));
    expect(policy.hashMatches).toBe(false);
    expect(policy.stepCount).toBe("3");
    expect(policy.deviations).toContain(
      "Only 1 of 3 steps were read; the policy hash could not be recomputed.",
    );
  });

  it("names every invariant a policy outside the live route breaks", () => {
    const offRouteStep: ZapStepRead = {
      adapter: SPOOFER,
      spender: SPOOFER,
      tokenIn: SPOOFER,
      amountIn: MAX_ROUTER_AMOUNT + 1n,
      data: "0xdeadbeef",
    };
    const { policy } = aggregateZapDetail(
      detailInput({
        runtime: null,
        policy: policyRead({
          recipient: SPOOFER,
          maxRelayerFeeCap: 1n,
          optimization: false,
          trackedAssets: [ROBINHOOD_ASSETS.zaps],
          steps: [offRouteStep],
          policyHash: HEX32(0xbad),
        }),
      }),
    );

    expect(policy.direction).toBeNull();
    expect(policy.outputSymbol).toBeNull();
    expect(policy.inputSymbol).toBe("0x9999…9999");
    expect(policy.canonicalClone).toBe(false);
    expect(policy.matchesLiveRoute).toBe(false);
    expect(policy.deviations).toEqual([
      "Runtime bytecode is not an EIP-1167 clone of the canonical implementation.",
      `Recipient ${SPOOFER} is not the owner ${OWNER}.`,
      "maxRelayerFeeCap is 1; the live route requires 0.",
      "Optimization is disabled; the live route requires it enabled.",
      "Tracked assets are not exactly [aeWETH, 0xZAPS].",
      `Step adapter ${SPOOFER} is not the live adapter ${OPENZAP_CONTRACTS.adapter}.`,
      `Step spender ${SPOOFER} is not the live adapter ${OPENZAP_CONTRACTS.adapter}.`,
      "Step calldata is not empty; the live adapter takes none.",
      `Step amountIn ${MAX_ROUTER_AMOUNT + 1n} is outside the router's uint128 range.`,
      "Input asset 0x9999…9999 is outside the live aeWETH/0xZAPS route.",
      "Policy hash does not match the policy this zap exposes.",
    ]);
  });

  it("keeps the snapshot metadata the page renders", () => {
    const payload = aggregateZapDetail(detailInput());
    expect(payload.headBlock).toBe("1000");
    expect(payload.readAt).toBe(NOW);
    expect(payload.factory).toEqual({ version: "1.1.0", implementation: OPENZAP_CONTRACTS.implementation });
    expect(payload.balances).toEqual({ weth: "0", zaps: "0", native: "0" });
  });
});

describe("step read limit", () => {
  /**
   * The reader's cap is the contract's own ceiling, not a guess, and drift
   * between the two silently re-breaks the bug this test exists for: a capsule
   * with more steps than the reader will fetch gets `hashMatches: false` and is
   * branded mismatched despite being perfectly valid. Parsing the Solidity
   * source keeps the two numbers pinned together.
   */
  it("equals MAX_STEPS in the deployed OpenZap contract", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../contracts/src/OpenZap.sol", import.meta.url)),
      "utf8",
    );
    const declared = source.match(/uint256 private constant MAX_STEPS = (\d+);/);
    expect(declared).not.toBeNull();
    expect(ZAP_STEP_READ_LIMIT).toBe(Number(declared![1]));
  });

  it("reads every index a capsule declares, up to the cap", () => {
    expect(stepsToRead(0n)).toBe(0);
    expect(stepsToRead(1n)).toBe(1);
    expect(stepsToRead(15n)).toBe(15);
    expect(stepsToRead(BigInt(ZAP_STEP_READ_LIMIT))).toBe(ZAP_STEP_READ_LIMIT);
  });

  it("clamps a stepCount no honest capsule can have, including uint256 max", () => {
    expect(stepsToRead(BigInt(ZAP_STEP_READ_LIMIT) + 1n)).toBe(ZAP_STEP_READ_LIMIT);
    expect(stepsToRead(2n ** 256n - 1n)).toBe(ZAP_STEP_READ_LIMIT);
  });

  /** A MAX_STEPS capsule is deployable today: the factory is permissionless. */
  it("recomputes the hash of a full 16-step capsule instead of branding it mismatched", () => {
    const steps: ZapStepRead[] = Array.from({ length: ZAP_STEP_READ_LIMIT }, (_, index) => ({
      adapter: OPENZAP_CONTRACTS.adapter,
      spender: OPENZAP_CONTRACTS.adapter,
      tokenIn: ROBINHOOD_ASSETS.weth,
      amountIn: AMOUNT_IN + BigInt(index),
      data: "0x",
    }));
    const policy = { ...canonicalPolicy, steps };

    const { policy: view } = aggregateZapDetail(
      detailInput({
        policy: policyRead({
          stepCount: BigInt(ZAP_STEP_READ_LIMIT),
          steps,
          policyHash: hashRobinhoodPolicy(policy),
        }),
      }),
    );

    expect(stepsToRead(BigInt(ZAP_STEP_READ_LIMIT))).toBe(steps.length);
    expect(view.hashMatches).toBe(true);
    expect(view.deviations).not.toContain("Policy hash does not match the policy this zap exposes.");
    expect(view.deviations.some((entry) => entry.includes("steps were read"))).toBe(false);
    // Still off the one live route — 16 steps is valid, not canonical.
    expect(view.deviations).toContain("Step count is 16; the live route allows exactly one step.");
  });

  it("refuses to claim a hash match when the declared count exceeds the contract's own ceiling", () => {
    const steps: ZapStepRead[] = Array.from({ length: ZAP_STEP_READ_LIMIT }, () => ({
      adapter: OPENZAP_CONTRACTS.adapter,
      spender: OPENZAP_CONTRACTS.adapter,
      tokenIn: ROBINHOOD_ASSETS.weth,
      amountIn: AMOUNT_IN,
      data: "0x",
    }));

    const { policy: view } = aggregateZapDetail(
      detailInput({ policy: policyRead({ stepCount: 17n, steps }) }),
    );

    expect(view.hashMatches).toBe(false);
    expect(view.deviations).toContain(
      "Only 16 of 17 steps were read; the policy hash could not be recomputed.",
    );
  });
});

describe("newestZapCreations", () => {
  const at = (blockNumber: bigint, logIndex: number, zap: `0x${string}`): ZapCreatedLogInput =>
    created({ blockNumber, logIndex, zap, txHash: HEX32(Number(blockNumber)) });

  const ADDRESSES = Array.from(
    { length: 5 },
    (_, i) => `0x${(i + 1).toString(16).repeat(40).slice(0, 40)}` as `0x${string}`,
  );

  it("orders newest first by block and then by log index", () => {
    const page = newestZapCreations(
      [at(100n, 0, ADDRESSES[0]), at(300n, 1, ADDRESSES[1]), at(300n, 4, ADDRESSES[2])],
      10,
    );
    expect(page.rows.map((row) => row.zap)).toEqual([
      getAddress(ADDRESSES[2]),
      getAddress(ADDRESSES[1]),
      getAddress(ADDRESSES[0]),
    ]);
  });

  it("reports the whole set's size when the list is truncated", () => {
    const logs = ADDRESSES.map((address, i) => at(BigInt(100 + i), 0, address));
    const page = newestZapCreations(logs, 2);

    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.truncated).toBe(true);
  });

  it("is not truncated when the limit covers every capsule", () => {
    const logs = ADDRESSES.map((address, i) => at(BigInt(100 + i), 0, address));
    expect(newestZapCreations(logs, 5)).toMatchObject({ total: 5, truncated: false });
    expect(newestZapCreations(logs, 50)).toMatchObject({ total: 5, truncated: false });
    expect(newestZapCreations([], 50)).toMatchObject({ total: 0, truncated: false });
  });

  /** CREATE2 means one address is created once; a repeat is the RPC, not a capsule. */
  it("counts capsules rather than log rows when an address repeats", () => {
    const page = newestZapCreations(
      [at(100n, 0, ADDRESSES[0]), at(100n, 0, ADDRESSES[0]), at(200n, 0, ADDRESSES[1])],
      50,
    );
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
  });

  it("takes nothing rather than everything when the limit is zero or negative", () => {
    const logs = ADDRESSES.map((address, i) => at(BigInt(100 + i), 0, address));
    expect(newestZapCreations(logs, 0)).toMatchObject({ rows: [], total: 5, truncated: true });
    expect(newestZapCreations(logs, -1)).toMatchObject({ rows: [], total: 5, truncated: true });
  });
});

describe("isZapNotFound", () => {
  it("recognises the identity failure that may become a 404", () => {
    expect(isZapNotFound(new ZapNotFoundError(ZAP))).toBe(true);
    expect(new ZapNotFoundError(ZAP).message).toBe(`${ZAP} was not created by the OpenZap factory.`);
  });

  /** Across bundles `instanceof` can miss; the name still identifies the error. */
  it("recognises a structurally identical error from another module copy", () => {
    const crossBundle = new Error(`${ZAP} was not created by the OpenZap factory.`);
    crossBundle.name = "ZapNotFoundError";
    expect(isZapNotFound(crossBundle)).toBe(true);
  });

  it("never mistakes an RPC failure for a missing zap", () => {
    expect(isZapNotFound(new Error("HTTP request failed. Status: 503"))).toBe(false);
    expect(isZapNotFound(new Error("The request took too long to respond."))).toBe(false);
    expect(isZapNotFound(undefined)).toBe(false);
    expect(isZapNotFound("was not created by the OpenZap factory.")).toBe(false);
  });
});
