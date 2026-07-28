import { encodeChain, type ChainNode, type CompiledZap } from "@/lib/blocks";
import type { SimulationCheck } from "@/lib/policy";

/**
 * The message shapes every conversational surface in the app shares.
 *
 * Four voices, and the distinction between them is the whole thesis: an
 * `agent` PROPOSES, a `capsule` DECIDES, the `chain` REPORTS, and `you` asks.
 * Only `agent` is ever model-authored. A `capsule` or `chain` body is built by
 * deterministic code — compileChain, deployable.ts, agent-narrative.ts — and
 * must never be paraphrased by a model, because the moment those two voices
 * blur, a user cannot tell a proposal from a guarantee.
 */
export type TranscriptRole = "you" | "agent" | "capsule" | "chain";

export type TranscriptFactRow = { key: string; label: string; value: string };

/** A message can BE a compiled plan, not merely describe one. */
export type TranscriptBody =
  | { kind: "text"; text: string }
  | { kind: "plan"; plan: TranscriptPlan }
  | { kind: "facts"; rows: TranscriptFactRow[] }
  | { kind: "checks"; checks: SimulationCheck[] }
  | { kind: "refusal"; reason: string; refuses: string[] };

export type TranscriptPlan = {
  chain: ChainNode[];
  /** `encodeChain(chain)` — so a card can hand off to `?view=design&d=…` as-is. */
  token: string;
  status: CompiledZap["status"];
  steps: string[];
  checks: SimulationCheck[];
  hash: string;
  gas: number;
  guardScore: number;
  /**
   * What this design will NOT do. Verbatim from deployable.ts, whose own
   * comment calls these sentences the most important thing in that file.
   * Never model prose, never reworded for tone.
   */
  refuses: string[];
  handoff: { label: string; href: string } | null;
};

export type TranscriptMessage = {
  id: string;
  role: TranscriptRole;
  body: TranscriptBody;
  /** ISO. Narrator entries carry the block timestamp; chat entries the clock. */
  at?: string;
  /** `verbatim` marks copy that must render unedited. */
  tone?: "normal" | "verbatim" | "error";
  evidence?: { label: string; href: string } | null;
};

export type TranscriptChip = {
  id: string;
  label: string;
  hint?: string;
  /** What the chip means to the surface, independent of its label. */
  value: string;
};

export type TranscriptComposer =
  | { mode: "none" }
  | { mode: "chips"; chips: TranscriptChip[]; busy?: boolean }
  | {
      mode: "text";
      placeholder: string;
      chips?: TranscriptChip[];
      maxLength: number;
      busy?: boolean;
    };

/**
 * `offline` is the no-API-key state, not an error: chips still work and the
 * deterministic surfaces are unaffected. It is separate from `error` so the UI
 * can explain the difference between "this deployment has no model" and "the
 * request failed".
 */
export type TranscriptStatus = "idle" | "thinking" | "compiling" | "error" | "offline";

/**
 * Build a plan card from a chain and the compiler's verdict on it.
 *
 * `refuses` is passed in rather than derived here because it comes from
 * deployable.ts (`unenforcedGuards` when deployable, `reasons` when not) and
 * this module deliberately does not depend on that layer — a plan card is a
 * rendering concern, and which sentences count as refusals is a policy one.
 */
export function planFromCompiled(
  chain: readonly ChainNode[],
  compiled: CompiledZap,
  opts: { handoff?: TranscriptPlan["handoff"]; refuses?: readonly string[] } = {},
): TranscriptPlan {
  return {
    chain: [...chain],
    token: encodeChain(chain),
    status: compiled.status,
    steps: [...compiled.steps],
    checks: [...compiled.checks],
    hash: compiled.hash,
    gas: compiled.gas,
    guardScore: compiled.guardScore,
    refuses: [...(opts.refuses ?? [])],
    handoff: opts.handoff ?? null,
  };
}

/** A message id that is stable for a given surface and index, with no clock. */
export function transcriptId(scope: string, index: number): string {
  return `${scope}-${index}`;
}
