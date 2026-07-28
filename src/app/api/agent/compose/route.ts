import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, type NextRequest } from "next/server";

import { AGENT_MODEL, PROPOSE_CHAIN_TOOL, agentSystemPrompt } from "@/lib/agent-catalog";
import {
  compileChain,
  decodeChain,
  encodeChain,
  getBlock,
  makeNode,
  type ParamValue,
} from "@/lib/blocks";
import { reduceChainToLivePolicy } from "@/lib/deployable";
import { callerKey, createRateLimit } from "@/lib/rate-limit";
import { planFromCompiled, type TranscriptPlan } from "@/lib/transcript";

/**
 * Natural language in, a compiled Zap proposal out.
 *
 * The model's only output is a chain of catalog block ids. Everything a person would act on —
 * whether the design is legal, what it will cost, what it refuses to do — is computed here by the
 * same deterministic code the visual builder uses. The model proposes; `compileChain` disposes.
 *
 * The schema's `enum` of block ids is a hint to the model, not a guarantee. The guarantee is
 * `decodeChain(encodeChain(...))` below: the untrusted-share-link decoder, applied to model output.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_PROMPT_BYTES = 4_096;

/**
 * Thinking is ON by default on this model and `max_tokens` caps thinking plus response text
 * together, so a budget sized around the tool call alone truncates mid-proposal.
 */
const MAX_TOKENS = 16_000;

export type AgentComposeResponse =
  | { ok: true; plan: TranscriptPlan; rationale: string; model: string }
  | { ok: false; refusal: { reason: string; issues: string[] } }
  | { ok: false; error: string };

/** Six proposals a minute per caller: generous for a person, hostile to a loop. */
const rateLimited = createRateLimit(6, 60_000);

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!ANTHROPIC_API_KEY) {
    // Same degradation shape as the relay's `relayConfigured()`: a deployment without the
    // dependency says so, rather than failing in a way that reads as a bug.
    return NextResponse.json(
      { ok: false, error: "The agent is not configured on this deployment." } satisfies AgentComposeResponse,
      { status: 503 },
    );
  }
  if (rateLimited(callerKey(request))) {
    return NextResponse.json({ ok: false, error: "Too many requests." } satisfies AgentComposeResponse, { status: 429 });
  }

  const body = await request.text();
  if (body.length > MAX_PROMPT_BYTES) {
    return NextResponse.json({ ok: false, error: "That request is too long." } satisfies AgentComposeResponse, {
      status: 413,
    });
  }
  const prompt = readPrompt(body);
  if (!prompt) {
    return NextResponse.json(
      { ok: false, error: "Body must be JSON with a non-empty prompt." } satisfies AgentComposeResponse,
      { status: 400 },
    );
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages.create({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      // Server-side fallback: on a safety-classifier decline the API re-runs the request on the
      // recommended model rather than handing back a refusal. "default" routes by category, so
      // there is no fallback model list to maintain here.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Adaptive thinking is the default on this model and must stay on: with thinking disabled it
      // can write a tool call into plain response text instead of emitting a tool_use block — the
      // turn returns 200 and the call silently never happened, which this route depends on.
      output_config: { effort: "low" },
      system: [{ type: "text", text: agentSystemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: [PROPOSE_CHAIN_TOOL as unknown as Anthropic.Beta.BetaToolUnion],
      tool_choice: { type: "tool", name: PROPOSE_CHAIN_TOOL.name },
      messages: [{ role: "user", content: prompt }],
    });
  } catch (cause) {
    const status = cause instanceof Anthropic.RateLimitError ? 429 : 502;
    return NextResponse.json(
      { ok: false, error: "The agent could not be reached right now." } satisfies AgentComposeResponse,
      { status },
    );
  }

  // Check stop_reason BEFORE reading content: on a refusal the content array is empty, and
  // indexing it unconditionally throws on exactly the request that most needs a clear answer.
  if (message.stop_reason === "refusal") {
    return NextResponse.json({
      ok: false,
      refusal: { reason: "The model declined this request.", issues: [] },
    } satisfies AgentComposeResponse);
  }

  const call = message.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock =>
      block.type === "tool_use" && block.name === PROPOSE_CHAIN_TOOL.name,
  );
  if (!call) {
    return NextResponse.json({
      ok: false,
      refusal: { reason: "The agent produced no design for that request.", issues: [] },
    } satisfies AgentComposeResponse);
  }

  return NextResponse.json(materializeAndCompile(call.input));
}

/**
 * Turn a model proposal into a compiled plan, or refuse.
 *
 * Exported for tests: every fail-closed branch below is reachable with a hand-written input, so
 * the guarantees can be verified without a live model.
 */
export function materializeAndCompile(input: unknown): AgentComposeResponse {
  const parsed = parseProposal(input);
  if (!parsed) return refuse("The agent's proposal was malformed.", []);

  const unknown = parsed.nodes.filter((node) => !getBlock(node.blockId)).map((node) => node.blockId);
  if (unknown.length > 0) {
    return refuse(`No such block: ${unknown.join(", ")}.`, []);
  }

  const raw = parsed.nodes.map((node, index) => makeNode(node.blockId, `a${index}`, node.params));

  // The guarantee. `?d=` share links are untrusted input, so decodeChain already drops unknown
  // block ids, looks every param key up in the catalog, and checks every value against its
  // declared domain. Round-tripping model output through it applies that same distrust — a
  // param the model invented or a value outside its range does not survive, and the length
  // mismatch turns into a refusal rather than a quietly different design.
  const chain = decodeChain(encodeChain(raw));
  if (!chain || chain.length !== raw.length) {
    return refuse("That proposal did not survive validation.", []);
  }

  const compiled = compileChain(chain);
  if (compiled.status === "block") {
    // A blocking issue never renders as a plan card. The compiler's own sentences are the
    // explanation — this route does not paraphrase them.
    return refuse(
      "That design will not compile.",
      compiled.issues.filter((issue) => issue.level === "block").map((issue) => issue.message),
    );
  }

  // `warn` is not a rejection: the builder accepts warn chains, the card shows the warn checks,
  // and the person decides. Refusing here would be stricter than the surface it hands off to.
  const policy = reduceChainToLivePolicy(chain);
  const refuses = policy.deployable ? policy.unenforcedGuards : policy.reasons;

  return {
    ok: true,
    plan: planFromCompiled(chain, compiled, {
      refuses,
      handoff: { label: "Open in the composer", href: `/zap?view=design&d=${encodeURIComponent(encodeChain(chain))}` },
    }),
    rationale: parsed.rationale,
    model: AGENT_MODEL,
  };
}

function refuse(reason: string, issues: string[]): AgentComposeResponse {
  return { ok: false, refusal: { reason, issues } };
}

interface Proposal {
  nodes: Array<{ blockId: string; params: Record<string, ParamValue> }>;
  rationale: string;
}

/** Shape check only — legality is `compileChain`'s job, not this function's. */
function parseProposal(input: unknown): Proposal | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (!Array.isArray(row.nodes) || row.nodes.length === 0 || row.nodes.length > 12) return null;

  const nodes: Proposal["nodes"] = [];
  for (const entry of row.nodes) {
    if (!entry || typeof entry !== "object") return null;
    const node = entry as Record<string, unknown>;
    if (typeof node.blockId !== "string") return null;
    nodes.push({ blockId: node.blockId, params: coerceParams(node.params) });
  }

  return { nodes, rationale: typeof row.rationale === "string" ? row.rationale.slice(0, 400) : "" };
}

function coerceParams(value: unknown): Record<string, ParamValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ParamValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" || (typeof raw === "number" && Number.isFinite(raw))) out[key] = raw;
  }
  return out;
}

function readPrompt(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const prompt = (parsed as { prompt?: unknown }).prompt;
    if (typeof prompt !== "string") return null;
    const trimmed = prompt.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
