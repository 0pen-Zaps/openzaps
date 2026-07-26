import type { AutomationMode } from "@/lib/automate";
import { netFloorFromQuote } from "@/lib/automate";
import { BPS, computeExecutorFeeSplit } from "@/lib/executions";

export interface BuilderQuoteEconomics {
  grossOut: bigint;
  recipientOut: bigint;
  minimumOut: bigint;
  automationFee: bigint;
}

/**
 * Translate a fresh gross route quote into exactly what each live execution
 * lineage guarantees. Recurring-relative is intentionally stricter than a
 * trigger: v3.1 compares the post-fee recipient amount against its live
 * spot/slippage floor, while a v3 trigger signs an absolute floor after both
 * slippage and fee have been applied.
 */
export function builderQuoteEconomics(
  grossOut: bigint,
  slippageBps: number,
  mode: AutomationMode | null,
): BuilderQuoteEconomics {
  const boundedSlippage = Math.max(0, Math.min(Math.trunc(slippageBps), Number(BPS - 1n)));
  if (mode === null) {
    return {
      grossOut,
      recipientOut: grossOut,
      minimumOut: (grossOut * (BPS - BigInt(boundedSlippage))) / BPS,
      automationFee: 0n,
    };
  }

  const split = computeExecutorFeeSplit(grossOut);
  return {
    grossOut,
    recipientOut: split.net,
    minimumOut:
      mode === "recurring"
        ? (grossOut * (BPS - BigInt(boundedSlippage))) / BPS
        : netFloorFromQuote(grossOut, boundedSlippage),
    automationFee: split.fee,
  };
}
