import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";

import type { RelayRecord } from "@/lib/relay";
import { executionReceiptAbi, type ExecutionReceiptRecord } from "@/lib/receipt-server";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URL, robinhoodChain } from "@/lib/robinhood";

export type GuardianLifecycleStatus =
  | "due"
  | "waiting"
  | "blocked"
  | "underfunded"
  | "expired"
  | "reverted"
  | "finalized"
  | "consumed-unknown";

export interface GuardianBlockContext {
  blockNumber: bigint;
  timestamp: bigint;
  latestBaseFeePerGas: bigint | null;
  pendingBaseFeePerGas: bigint | null;
}

export interface GuardianSnapshot {
  intentId: string;
  zap: string;
  owner: string;
  kind: RelayRecord["kind"];
  nonce: string;
  executor: string;
  status: GuardianLifecycleStatus;
  detail: string;
  nextRunAt: string | null;
  runs: number | null;
  executionState: "none" | "reverted" | "finalized" | "consumed-unknown";
  latestReceipt: ExecutionReceiptRecord | null;
  observedAt: string;
  authorityScope: "none";
}

const guardianReadAbi = parseAbi([
  "function nonceUsed(uint256) view returns (bool)",
  "function series(uint256 seriesId) view returns (uint32 runs,uint64 lastRun)",
]);
const priceReadAbi = parseAbi(["function priceX96() view returns (uint256)"]);
const BPS = 10_000n;
const MAX_THRESHOLD_BPS = 1_000_000n;
const SIMULATION_ACCOUNT = "0x000000000000000000000000000000000000dEaD" as Address;

/** The same ordered multi-RPC failover posture as the executor, usable by receipt/guardian routes. */
export function operationsRpcUrls(): string[] {
  const configured = process.env.OPENZAPS_RPC_URLS
    ?.split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return configured && configured.length > 0
    ? [...new Set(configured)]
    : [process.env.OPENZAPS_RPC_URL?.trim() || ROBINHOOD_RPC_URL];
}

export function createOperationsPublicClient(): PublicClient {
  const urls = operationsRpcUrls();
  const transport =
    urls.length > 1
      ? fallback(urls.map((url) => http(url, { retryCount: 1, timeout: 8_000 })), { rank: true })
      : http(urls[0], { retryCount: 2, timeout: 8_000 });
  return createPublicClient({ chain: robinhoodChain, transport });
}

export function classifyGuardianSimulationError(error: unknown): "underfunded" | "blocked" {
  const message =
    error && typeof error === "object"
      ? [
          "errorName" in error ? String(error.errorName) : "",
          "shortMessage" in error ? String(error.shortMessage) : "",
          "message" in error ? String(error.message) : "",
        ].join(" ")
      : String(error ?? "");
  return /ZeroBalanceRelativeStep|ERC20InsufficientBalance|insufficient (?:token )?balance|transfer amount exceeds balance|empty balance/i.test(
    message,
  )
    ? "underfunded"
    : "blocked";
}

function nonceFor(record: RelayRecord): string {
  return String(record.kind === "trigger" ? record.intent.nonce : record.intent.seriesId);
}

function executionState(receipt: ExecutionReceiptRecord | null): GuardianSnapshot["executionState"] {
  return receipt?.outcome ?? "none";
}

function messageTuple(intent: RelayRecord["intent"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(intent).map(([key, value]) => [
      key,
      typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : value,
    ]),
  );
}

function executionFunction(kind: RelayRecord["kind"]) {
  if (kind === "recurring") return "executeRecurring";
  if (kind === "recurring-relative") return "executeRecurringRelative";
  if (kind === "recurring-stack") return "executeRecurringStack";
  return "executeTrigger";
}

function baseSnapshot(
  record: RelayRecord,
  context: GuardianBlockContext,
  latestReceipt: ExecutionReceiptRecord | null,
): Omit<GuardianSnapshot, "status" | "detail" | "nextRunAt" | "runs"> {
  return {
    intentId: record.id,
    zap: record.zap,
    owner: record.owner,
    kind: record.kind,
    nonce: nonceFor(record),
    executor: String(record.intent.executor),
    executionState: executionState(latestReceipt),
    latestReceipt,
    observedAt: new Date(Number(context.timestamp) * 1_000).toISOString(),
    authorityScope: "none",
  };
}

/**
 * Production stays dark unless the operator explicitly confirms both the feature and a durable
 * quota outside this process (for example a Vercel Firewall/KV rule). The warm-instance limiter is
 * useful burst hygiene but is not a production quota.
 */
export function guardianEnabled(
  env: {
    NODE_ENV?: string;
    OPENZAPS_GUARDIAN_ENABLED?: string;
    OPENZAPS_GUARDIAN_DURABLE_QUOTA_ENABLED?: string;
  } = process.env,
): boolean {
  if (env.NODE_ENV !== "production") return env.OPENZAPS_GUARDIAN_ENABLED !== "false";
  return (
    env.OPENZAPS_GUARDIAN_ENABLED === "true"
    && env.OPENZAPS_GUARDIAN_DURABLE_QUOTA_ENABLED === "true"
  );
}

/** Ordered bounded pool for the page's receipt + chain derivations. */
export async function mapGuardianPage<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Derive lifecycle from current chain state, then dry-run due executions to distinguish a healthy
 * due intent from underfunding or another fail-closed blocker. This is observation only: it never
 * signs, submits, changes a relay row, or grants an executor.
 */
export async function deriveGuardianSnapshot(
  client: PublicClient,
  record: RelayRecord,
  context: GuardianBlockContext,
  latestReceipt: ExecutionReceiptRecord | null,
): Promise<GuardianSnapshot> {
  const base = baseSnapshot(record, context, latestReceipt);
  const nowSec = context.timestamp;
  if (BigInt(String(record.intent.chainId)) !== BigInt(ROBINHOOD_CHAIN_ID)) {
    return {
      ...base,
      status: "blocked",
      detail: `intent chainId ${record.intent.chainId} does not match ${ROBINHOOD_CHAIN_ID}`,
      nextRunAt: null,
      runs: null,
    };
  }

  const nonce = BigInt(base.nonce);
  const recurring = record.kind !== "trigger";
  let used: boolean;
  try {
    used = await client.readContract({
      address: getAddress(record.zap),
      abi: guardianReadAbi,
      functionName: "nonceUsed",
      args: [nonce],
      blockNumber: context.blockNumber,
    });
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      detail: `capsule state unreadable: ${
        error && typeof error === "object" && "shortMessage" in error ? String(error.shortMessage) : String(error)
      }`,
      nextRunAt: null,
      runs: null,
    };
  }

  let runs: number | null = null;
  let lastRun = 0n;
  let maxRuns: bigint | null = null;
  if (recurring) {
    try {
      const [chainRuns, chainLastRun] = await client.readContract({
        address: getAddress(record.zap),
        abi: guardianReadAbi,
        functionName: "series",
        args: [nonce],
        blockNumber: context.blockNumber,
      });
      runs = Number(chainRuns);
      lastRun = BigInt(chainLastRun);
      maxRuns = BigInt(String(record.intent.maxRuns));
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        detail: `series state unreadable: ${
          error && typeof error === "object" && "shortMessage" in error ? String(error.shortMessage) : String(error)
        }`,
        nextRunAt: null,
        runs: null,
      };
    }
  }

  if (used && recurring) {
    if (maxRuns !== null && runs !== null && BigInt(runs) >= maxRuns) {
      return {
        ...base,
        status: "finalized",
        detail: `all ${maxRuns} authorized runs are finalized`,
        nextRunAt: null,
        runs,
      };
    }
    return {
      ...base,
      executionState: "consumed-unknown",
      status: "consumed-unknown",
      detail:
        `recurring series was invalidated onchain after ${runs ?? 0}/${maxRuns ?? "?"} runs; `
        + "a prior execution receipt cannot attribute the revocation",
      nextRunAt: null,
      runs,
    };
  }

  if (used) {
    if (latestReceipt?.outcome !== "finalized") {
      return {
        ...base,
        executionState: "consumed-unknown",
        status: "consumed-unknown",
        detail:
          "authorization nonce is consumed onchain, but no verified finalized receipt attributes the consumption",
        nextRunAt: null,
        runs: null,
      };
    }
    return {
      ...base,
      status: "finalized",
      detail: `authorization consumed by finalized transaction ${latestReceipt.txHash}`,
      nextRunAt: null,
      runs: null,
    };
  }

  const deadline = BigInt(String(record.intent.deadline));
  const validAfter = BigInt(String(record.intent.validAfter));
  if (nowSec > deadline) {
    return { ...base, status: "expired", detail: `deadline ${deadline} passed`, nextRunAt: null, runs: null };
  }
  if (nowSec < validAfter) {
    return {
      ...base,
      status: "waiting",
      detail: `authorization starts at ${validAfter}`,
      nextRunAt: validAfter.toString(),
      runs: record.kind === "trigger" ? null : 0,
    };
  }

  let nextRunAt: string | null = null;
  if (recurring) {
    if (runs !== null && maxRuns !== null && BigInt(runs) >= maxRuns) {
      return {
        ...base,
        status: "finalized",
        detail: `all ${maxRuns} authorized runs are finalized`,
        nextRunAt: null,
        runs,
      };
    }
    if (runs !== null && maxRuns !== null && runs > 0) {
      const dueAt = lastRun + BigInt(String(record.intent.interval));
      nextRunAt = dueAt.toString();
      if (nowSec < dueAt) {
        return {
          ...base,
          status: "waiting",
          detail: `run ${runs + 1}/${maxRuns} is due at ${dueAt}`,
          nextRunAt,
          runs,
        };
      }
    }
  } else {
    const baseline = BigInt(String(record.intent.baselinePriceX96));
    if (baseline === 0n) {
      return { ...base, status: "blocked", detail: "baselinePriceX96 is zero", nextRunAt: null, runs: null };
    }
    try {
      const price = await client.readContract({
        address: getAddress(String(record.intent.priceSource)),
        abi: priceReadAbi,
        functionName: "priceX96",
        blockNumber: context.blockNumber,
      });
      const threshold = BigInt(String(record.intent.thresholdBps));
      const above = record.intent.above === true;
      if (threshold > MAX_THRESHOLD_BPS || (!above && threshold >= BPS)) {
        return {
          ...base,
          status: "blocked",
          detail: above
            ? `above thresholdBps exceeds ${MAX_THRESHOLD_BPS}`
            : "below thresholdBps must be less than 10000",
          nextRunAt: null,
          runs: null,
        };
      }
      const bound = above ? (baseline * (BPS + threshold)) / BPS : (baseline * (BPS - threshold)) / BPS;
      const armed = above ? price >= bound : price <= bound;
      if (!armed) {
        return {
          ...base,
          status: "waiting",
          detail: `trigger price ${price} has not crossed bound ${bound}`,
          nextRunAt: null,
          runs: null,
        };
      }
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        detail: `price source unreadable: ${
          error && typeof error === "object" && "shortMessage" in error ? String(error.shortMessage) : String(error)
        }`,
        nextRunAt: null,
        runs: null,
      };
    }
  }

  const signedMaxFeePerGas = BigInt(String(record.intent.maxFeePerGas));
  const feeObservations = [
    ["latest", context.latestBaseFeePerGas],
    ["pending", context.pendingBaseFeePerGas],
  ] as const;
  const gasAboveCap = feeObservations.find(([, fee]) => fee !== null && fee > signedMaxFeePerGas);
  if (gasAboveCap) {
    return {
      ...base,
      status: "blocked",
      detail: `${gasAboveCap[0]} base fee ${gasAboveCap[1]} exceeds signed maxFeePerGas ${signedMaxFeePerGas}`,
      nextRunAt,
      runs,
    };
  }

  const signedExecutor = getAddress(String(record.intent.executor));
  const account = signedExecutor === zeroAddress ? SIMULATION_ACCOUNT : signedExecutor;
  const maxGas = BigInt(String(record.intent.maxGas));
  try {
    await client.simulateContract({
      address: getAddress(record.zap),
      abi: executionReceiptAbi,
      functionName: executionFunction(record.kind),
      args: [messageTuple(record.intent), record.signature],
      account,
      gas: maxGas < 10_000_000n ? maxGas : 10_000_000n,
      blockNumber: context.blockNumber,
    } as Parameters<PublicClient["simulateContract"]>[0]);
  } catch (error) {
    const classified = classifyGuardianSimulationError(error);
    if (latestReceipt?.outcome === "reverted") {
      return {
        ...base,
        status: "reverted",
        detail: `latest attempt ${latestReceipt.txHash} reverted; current simulation: ${
          error && typeof error === "object" && "shortMessage" in error ? String(error.shortMessage) : String(error)
        }`,
        nextRunAt,
        runs,
      };
    }
    return {
      ...base,
      status: classified,
      detail: `${
        classified === "underfunded" ? "capsule is underfunded" : "execution is blocked"
      }: ${error && typeof error === "object" && "shortMessage" in error ? String(error.shortMessage) : String(error)}`,
      nextRunAt,
      runs,
    };
  }

  return {
    ...base,
    status: "due",
    detail: latestReceipt?.outcome === "reverted"
      ? `retry is due after reverted transaction ${latestReceipt.txHash}; simulation now succeeds`
      : "execution is due and simulation succeeds",
    nextRunAt,
    runs,
  };
}
