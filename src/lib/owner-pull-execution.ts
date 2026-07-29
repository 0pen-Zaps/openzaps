export type OneShotLineage = "v1.1" | "v1.2";
export type OneShotFundingMode = "prefunded" | "owner-pull" | "needs-funding";

/**
 * Choose an execution funding path from chain-derived state.
 *
 * A partially funded capsule is never topped up through Permit2: the v1.2
 * contract requires an exact fresh pull and proves the pulled amount was fully
 * consumed. The owner can either finish/remove the prefund explicitly or use
 * the ordinary prefunded path once the full frozen amount is present.
 */
export function oneShotFundingMode(
  lineage: OneShotLineage,
  policyHalted: boolean,
  capsuleInputBalance: bigint,
  requiredAmount: bigint,
): OneShotFundingMode {
  if (requiredAmount <= 0n) throw new Error("The frozen input amount must be positive.");
  if (capsuleInputBalance < 0n) throw new Error("Capsule input balance cannot be negative.");
  if (policyHalted) throw new Error("This capsule's execution policy is permanently halted.");
  if (capsuleInputBalance >= requiredAmount) return "prefunded";
  if (capsuleInputBalance > 0n) {
    throw new Error(
      "Owner-pull is unavailable while the capsule holds a partial input balance. Recover or fully fund it first.",
    );
  }
  return lineage === "v1.2" ? "owner-pull" : "needs-funding";
}

/**
 * ERC-20 approvals to canonical Permit2 are exact and finite. A non-zero
 * mismatched allowance is reset before the exact approval so tokens with the
 * standard approval-race guard are handled without widening authority.
 */
export function exactPermit2ApprovalPlan(
  currentAllowance: bigint,
  requiredAmount: bigint,
): readonly bigint[] {
  if (currentAllowance < 0n) throw new Error("Permit2 allowance cannot be negative.");
  if (requiredAmount <= 0n) throw new Error("Permit2 approval amount must be positive.");
  if (currentAllowance === requiredAmount) return [];
  if (currentAllowance === 0n) return [requiredAmount];
  return [0n, requiredAmount];
}
