import { MAX_EXECUTION_FEE_PER_GAS, MAX_EXECUTION_GAS } from "@/lib/openzap";
import type { ChainNode } from "@/lib/blocks";

/** Smallest execution budget the visual block is willing to sign. */
export const MIN_EXECUTION_GAS_UNITS = 100_000;
/** Contract/app ceiling, expressed as a safe JS integer for sliders and URLs. */
export const MAX_EXECUTION_GAS_UNITS = Number(MAX_EXECUTION_GAS);
export const MIN_EXECUTION_FEE_GWEI = 1;
export const MAX_EXECUTION_FEE_GWEI = Number(MAX_EXECUTION_FEE_PER_GAS / 1_000_000_000n);

export type ExecutorAccess = "anyone" | "owner-only";

export interface ExecutionPolicy {
  maxGas: number;
  maxFeePerGasGwei: number;
  executorAccess: ExecutorAccess;
}

export const DEFAULT_EXECUTION_POLICY: Readonly<ExecutionPolicy> = Object.freeze({
  maxGas: MAX_EXECUTION_GAS_UNITS,
  maxFeePerGasGwei: MAX_EXECUTION_FEE_GWEI,
  executorAccess: "anyone",
});

/** The three execution-policy blocks shipped as one composable stack. */
export const EXECUTION_POLICY_BLOCK_IDS = [
  "guard-gas-limit",
  "guard-gas-price",
  "guard-executor",
] as const;

export type ExecutionPolicyResolution =
  | { ok: true; policy: ExecutionPolicy }
  | { ok: false; reasons: string[] };

/**
 * Resolve every placed execution-policy block into the one EIP-712 value each
 * intent can carry. Repeated numeric caps intersect at the tightest value;
 * owner-only intersects an open executor block by winning. This makes stack
 * order irrelevant and never lets a later, looser block silently override an
 * earlier bound.
 */
export function resolveExecutionPolicy(chain: readonly ChainNode[]): ExecutionPolicyResolution {
  const gasLimits: number[] = [];
  const feeLimits: number[] = [];
  let executorAccess: ExecutorAccess = DEFAULT_EXECUTION_POLICY.executorAccess;
  const reasons: string[] = [];

  for (const node of chain) {
    if (node.blockId === "guard-gas-limit") {
      const value = Number(node.params.maxGas);
      if (!Number.isInteger(value) || value < MIN_EXECUTION_GAS_UNITS || value > MAX_EXECUTION_GAS_UNITS) {
        reasons.push(
          `Execution gas limit must be a whole number between ${MIN_EXECUTION_GAS_UNITS.toLocaleString("en-US")} and ${MAX_EXECUTION_GAS_UNITS.toLocaleString("en-US")} gas.`,
        );
      } else {
        gasLimits.push(value);
      }
    }

    if (node.blockId === "guard-gas-price") {
      const value = Number(node.params.maxFeeGwei);
      if (!Number.isInteger(value) || value < MIN_EXECUTION_FEE_GWEI || value > MAX_EXECUTION_FEE_GWEI) {
        reasons.push(
          `Gas price cap must be a whole number between ${MIN_EXECUTION_FEE_GWEI} and ${MAX_EXECUTION_FEE_GWEI} gwei.`,
        );
      } else {
        feeLimits.push(value);
      }
    }

    if (node.blockId === "guard-executor") {
      const access = String(node.params.access ?? "");
      if (access === "Owner only") executorAccess = "owner-only";
      else if (access !== "Anyone") reasons.push("Executor access must be Anyone or Owner only.");
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    policy: {
      maxGas: gasLimits.length > 0 ? Math.min(...gasLimits) : DEFAULT_EXECUTION_POLICY.maxGas,
      maxFeePerGasGwei:
        feeLimits.length > 0 ? Math.min(...feeLimits) : DEFAULT_EXECUTION_POLICY.maxFeePerGasGwei,
      executorAccess,
    },
  };
}

/** Write a fully explicit builder handoff; old links without these keys use defaults. */
export function writeExecutionPolicyParams(params: URLSearchParams, policy: ExecutionPolicy): void {
  params.set("maxGas", String(policy.maxGas));
  params.set("maxFeeGwei", String(policy.maxFeePerGasGwei));
  params.set("executor", policy.executorAccess === "owner-only" ? "owner" : "anyone");
}

/** Validate execution-policy query fields before they enter a live signing form. */
export function readExecutionPolicyParams(params: URLSearchParams): ExecutionPolicy | null {
  const rawGas = params.get("maxGas");
  const rawFee = params.get("maxFeeGwei");
  const rawExecutor = params.get("executor");
  const maxGas = rawGas === null ? DEFAULT_EXECUTION_POLICY.maxGas : Number(rawGas);
  const maxFeePerGasGwei = rawFee === null ? DEFAULT_EXECUTION_POLICY.maxFeePerGasGwei : Number(rawFee);
  const executorAccess: ExecutorAccess | null =
    rawExecutor === null || rawExecutor === "anyone"
      ? "anyone"
      : rawExecutor === "owner"
        ? "owner-only"
        : null;

  if (!Number.isInteger(maxGas) || maxGas < MIN_EXECUTION_GAS_UNITS || maxGas > MAX_EXECUTION_GAS_UNITS) {
    return null;
  }
  if (
    !Number.isInteger(maxFeePerGasGwei)
    || maxFeePerGasGwei < MIN_EXECUTION_FEE_GWEI
    || maxFeePerGasGwei > MAX_EXECUTION_FEE_GWEI
  ) {
    return null;
  }
  if (executorAccess === null) return null;
  return { maxGas, maxFeePerGasGwei, executorAccess };
}

export function maxFeePerGasWei(policy: ExecutionPolicy): bigint {
  return BigInt(policy.maxFeePerGasGwei) * 1_000_000_000n;
}
