import type { ZapDetailPayload } from "@/lib/zap";

/**
 * The only thing about a capsule a model ever sees.
 *
 * An explicit key list, not a JSON dump of `ZapDetailPayload`. The difference matters the day
 * someone adds a field to that type: a dump would silently start sending it, and nobody would
 * notice until it was already in a prompt. Adding a key here is a decision.
 *
 * Two things are deliberately absent:
 *  - `ZapStepView.data`, the frozen calldata. A model has no use for a calldata blob and every
 *    reason not to have one — it must never be in a position to echo, edit, or invent one.
 *  - the raw `executions[]` array. Only a capped summary goes in; a capsule with 400 runs would
 *    otherwise fill the context with rows nobody asked about.
 */

export type ZapFactKey =
  | "address"
  | "owner"
  | "recipient"
  | "lifecycle"
  | "lineage"
  | "createdAt"
  | "createdTx"
  | "policyHash"
  | "policyHaltStatus"
  | "policyHalted"
  | "haltedAt"
  | "haltedTx"
  | "hashMatches"
  | "canonicalClone"
  | "matchesLiveRoute"
  | "deviations"
  | "routeKind"
  | "direction"
  | "inputSymbol"
  | "outputSymbol"
  | "adapter"
  | "amountIn"
  | "maxRelayerFeeCap"
  | "trackedAssets"
  | "stepCount"
  | "optimization"
  | "executionCount"
  | "automatedRunCount"
  | "recoveryCount"
  | "firstExecutionAt"
  | "lastExecutionAt"
  | "amountOutByAsset"
  | "feeByAsset"
  | "stackedInputByAsset"
  | "stackedZaps"
  | "balanceWeth"
  | "balanceZaps"
  | "balanceNative"
  | "headBlock"
  | "readAt"
  | "factoryVersion";

export interface ZapFact {
  key: ZapFactKey;
  label: string;
  value: string;
}

/** Every fact key, in the order `zapFacts` emits them. */
export const ZAP_FACT_KEYS: readonly ZapFactKey[] = [
  "address",
  "owner",
  "recipient",
  "lifecycle",
  "lineage",
  "createdAt",
  "createdTx",
  "policyHash",
  "policyHaltStatus",
  "policyHalted",
  "haltedAt",
  "haltedTx",
  "hashMatches",
  "canonicalClone",
  "matchesLiveRoute",
  "deviations",
  "routeKind",
  "direction",
  "inputSymbol",
  "outputSymbol",
  "adapter",
  "amountIn",
  "maxRelayerFeeCap",
  "trackedAssets",
  "stepCount",
  "optimization",
  "executionCount",
  "automatedRunCount",
  "recoveryCount",
  "firstExecutionAt",
  "lastExecutionAt",
  "amountOutByAsset",
  "feeByAsset",
  "stackedInputByAsset",
  "stackedZaps",
  "balanceWeth",
  "balanceZaps",
  "balanceNative",
  "headBlock",
  "readAt",
  "factoryVersion",
];

export function zapFacts(payload: ZapDetailPayload): ZapFact[] {
  const { provenance, policy, stats, balances } = payload;
  const facts: ZapFact[] = [];
  const add = (key: ZapFactKey, label: string, value: string | number | boolean | null | undefined): void => {
    if (value === null || value === undefined || value === "") return;
    facts.push({ key, label, value: String(value) });
  };

  add("address", "capsule", provenance.address);
  add("owner", "owner", provenance.owner);
  add("recipient", "pays out to", policy.recipient);
  add("lifecycle", "lifecycle", payload.lifecycle);
  add("lineage", "canonical lineage", payload.lineage);
  add("createdAt", "created", provenance.createdAt ? new Date(provenance.createdAt * 1000).toISOString() : null);
  add("createdTx", "creation tx", provenance.createdTx);

  add("policyHash", "policy hash", policy.policyHash);
  add("policyHaltStatus", "one-way policy stop", payload.policyHalt.status);
  add(
    "policyHalted",
    "execution permanently halted",
    payload.policyHalt.policyHalted === null
      ? null
      : payload.policyHalt.policyHalted ? "yes" : "no",
  );
  add(
    "haltedAt",
    "policy halted",
    payload.policyHalt.haltedAt
      ? new Date(payload.policyHalt.haltedAt * 1000).toISOString()
      : null,
  );
  add("haltedTx", "policy halt tx", payload.policyHalt.haltedTx);
  add("hashMatches", "hash verifies", policy.hashMatches ? "yes" : "NO");
  add("canonicalClone", "canonical clone", policy.canonicalClone ? "yes" : "NO");
  add("matchesLiveRoute", "matches a live route", policy.matchesLiveRoute ? "yes" : "no");
  // The single most important field: a non-empty list means an invariant this
  // capsule claims does not hold.
  add("deviations", "invariants that do NOT hold", policy.deviations.length > 0 ? policy.deviations.join(" · ") : "none");

  add("routeKind", "route kind", policy.routeKind);
  add("direction", "direction", policy.direction);
  add("inputSymbol", "spends", policy.inputSymbol);
  add("outputSymbol", "produces", policy.outputSymbol);
  // The adapter address is a fact about what the capsule may call. The step's
  // `data` — its frozen calldata — is deliberately not included.
  add("adapter", "adapter", policy.step?.adapter);
  add("amountIn", "amount per run (wei)", policy.step?.amountIn);
  add("maxRelayerFeeCap", "max relayer fee (wei)", policy.maxRelayerFeeCap);
  add("trackedAssets", "tracked assets", policy.trackedAssets.join(" · "));
  add("stepCount", "steps", policy.stepCount);
  add("optimization", "optimization", policy.optimization ? "yes" : "no");

  add("executionCount", "confirmed runs", stats.executionCount);
  // Without this the two are indistinguishable to a model, and "20 confirmed
  // runs" on a capsule the owner submitted none of is a materially different
  // fact from 20 runs the owner signed one at a time.
  add("automatedRunCount", "of those, executor-submitted", stats.automatedRunCount);
  add("recoveryCount", "recoveries", stats.recoveryCount);
  add("firstExecutionAt", "first run", stats.firstExecutionAt ? new Date(stats.firstExecutionAt * 1000).toISOString() : null);
  add("lastExecutionAt", "last run", stats.lastExecutionAt ? new Date(stats.lastExecutionAt * 1000).toISOString() : null);
  add("amountOutByAsset", "total out", formatByAsset(stats.amountOutByAsset));
  add("feeByAsset", "total fees", formatByAsset(stats.feeByAsset));
  add("stackedInputByAsset", "total input stacked", formatByAsset(stats.stackedInputByAsset));
  add("stackedZaps", "total 0xZAPS stacked", BigInt(stats.stackedZaps) > 0n ? stats.stackedZaps : null);

  add("balanceWeth", "aeWETH balance (wei)", balances.weth);
  add("balanceZaps", "0xZAPS balance (wei)", balances.zaps);
  add("balanceNative", "native balance (wei)", balances.native);

  add("headBlock", "read at block", payload.headBlock);
  add("readAt", "read at", payload.readAt);
  add("factoryVersion", "lineage", payload.factory.version);

  return facts;
}

/** Render the fact list for a prompt. One fact per line, keys included so answers can cite them. */
export function serializeFacts(facts: readonly ZapFact[]): string {
  return facts.map((fact) => `${fact.key} (${fact.label}): ${fact.value}`).join("\n");
}

function formatByAsset(byAsset: Record<string, string>): string | null {
  const entries = Object.entries(byAsset);
  if (entries.length === 0) return null;
  return entries.map(([symbol, amount]) => `${amount} ${symbol}`).join(" · ");
}
