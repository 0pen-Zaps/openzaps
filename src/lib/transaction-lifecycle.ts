import type { Hex } from "viem";

export type TransactionLifecycleStage =
  | "wallet"
  | "not-submitted"
  | "submitted"
  | "confirmed"
  | "reverted"
  | "unknown";

export type TransactionLifecycleState = {
  label: string;
  stage: TransactionLifecycleStage;
  hash?: Hex;
  updatedAt: string;
};

export type TransactionLifecycleStepStatus = "done" | "current" | "pending" | "error";

export function transactionLifecycleStepStatuses(
  stage: TransactionLifecycleStage | null,
): readonly TransactionLifecycleStepStatus[] {
  if (stage === null) return ["pending", "pending", "pending", "pending"];
  if (stage === "wallet") return ["done", "current", "pending", "pending"];
  if (stage === "not-submitted") return ["done", "error", "pending", "pending"];
  if (stage === "submitted") return ["done", "done", "done", "current"];
  if (stage === "confirmed") return ["done", "done", "done", "done"];
  if (stage === "reverted") return ["done", "done", "done", "error"];
  return ["done", "done", "done", "error"];
}
