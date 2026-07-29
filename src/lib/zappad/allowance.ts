export interface ExactAllowancePlan {
  isExact: boolean;
  resetBeforeApproval: boolean;
  approveAfterReset: boolean;
  hasResidualAllowance: boolean;
}

/**
 * ZapPad deliberately uses an exact ERC-20 allowance for an atomic first buy.
 * A larger allowance is not equivalent: if the launch is cancelled or reverts,
 * the launcher would retain authority over the unused amount.
 */
export function exactAllowancePlan(
  currentAllowance: bigint,
  requiredAllowance: bigint,
): ExactAllowancePlan {
  if (currentAllowance < 0n || requiredAllowance < 0n) {
    throw new RangeError("Allowances cannot be negative.");
  }

  const isExact = currentAllowance === requiredAllowance;
  return {
    isExact,
    resetBeforeApproval: currentAllowance > 0n && !isExact,
    approveAfterReset: requiredAllowance > 0n && !isExact,
    hasResidualAllowance: currentAllowance > 0n,
  };
}
