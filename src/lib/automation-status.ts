import { isTriggerArmed } from "@/lib/executions";
import type { ParsedAutomationIntent } from "@/lib/automation-records";

export type AutomationLifecycle =
  | "draft"
  | "scheduled"
  | "waiting"
  | "due"
  | "armed"
  | "expired"
  | "completed"
  | "revoked"
  | "consumed"
  | "unavailable";

export interface AutomationChainState {
  nonceUsed: boolean | null;
  runs: number | null;
  lastRun: bigint | null;
  priceX96: bigint | null;
}

export interface AutomationEvidence {
  revoked: boolean;
  completed: boolean;
}

export interface AutomationLifecycleView {
  lifecycle: AutomationLifecycle;
  label: string;
  detail: string;
  cancelable: boolean;
}

export function deriveAutomationLifecycle(
  intent: ParsedAutomationIntent | null,
  chain: AutomationChainState | null,
  evidence: AutomationEvidence,
  nowSec: bigint,
): AutomationLifecycleView {
  if (!intent) return view("draft", "Draft", "Capsule exists, but no standing intent is available in this browser or relay.");
  if (evidence.revoked) return view("revoked", "Revoked", "The authorization id was invalidated onchain.");
  if (evidence.completed) return view("completed", "Completed", "The trigger fired or the recurring series finished onchain.");
  if (!chain || chain.nonceUsed === null) {
    return view("unavailable", "State unavailable", "The capsule nonce state could not be read. Management is disabled.");
  }
  if (chain.nonceUsed) {
    return view("consumed", "Consumed", "The authorization id is spent; no later run can use it.");
  }
  if (nowSec > intent.deadline) return view("expired", "Expired", "The signed deadline passed without consuming the authorization.");
  if (nowSec < intent.validAfter) return view("scheduled", "Scheduled", "The authorization is signed but its valid-after time has not arrived.", true);

  if (intent.mode === "recurring") {
    if (intent.maxRuns !== null && chain.runs !== null && chain.runs >= intent.maxRuns) {
      return view("completed", "Completed", `All ${intent.maxRuns} runs are recorded onchain.`);
    }
    if (chain.runs === null || chain.lastRun === null || intent.interval === null) {
      return view("unavailable", "Series unavailable", "The recurring progress read failed. Management is disabled.");
    }
    const next = chain.runs === 0 ? intent.validAfter : chain.lastRun + intent.interval;
    if (nowSec >= next) {
      return view("due", "Run due", chain.runs === 0 ? "The first run may be submitted now." : `Run ${chain.runs + 1} may be submitted now.`, true);
    }
    return view("waiting", "Waiting", `Run ${chain.runs + 1} is cadence-locked until the next interval.`, true);
  }

  if (chain.priceX96 === null || intent.baselinePriceX96 === null) {
    return view("unavailable", "Price unavailable", "The nonce is live, but the price source could not be read.", true);
  }
  const armed =
    intent.thresholdBps !== null &&
    intent.above !== null &&
    isTriggerArmed(chain.priceX96, intent.baselinePriceX96, intent.thresholdBps, intent.above);
  return armed
    ? view("armed", "Armed", "The signed price condition is met and an executor may submit the run.", true)
    : view("waiting", "Watching price", "The one-sided signed threshold has not been met.", true);
}

function view(
  lifecycle: AutomationLifecycle,
  label: string,
  detail: string,
  cancelable = false,
): AutomationLifecycleView {
  return { lifecycle, label, detail, cancelable };
}
