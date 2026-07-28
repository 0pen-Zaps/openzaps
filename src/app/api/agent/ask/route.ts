import Anthropic from "@anthropic-ai/sdk";
import { getAddress } from "viem";
import { NextResponse, type NextRequest } from "next/server";

import { AGENT_MODEL } from "@/lib/agent-catalog";
import { ZAP_FACT_KEYS, serializeFacts, zapFacts, type ZapFact, type ZapFactKey } from "@/lib/agent-context";
import { callerKey, createRateLimit } from "@/lib/rate-limit";
import type { TranscriptFactRow } from "@/lib/transcript";
import { isZapNotFound } from "@/lib/zap";
import { fetchZapDetail } from "@/lib/zap-server";

/**
 * Ask a question about one capsule.
 *
 * The model formats; the app supplies the numbers. It sees only the whitelisted fact projection,
 * and it must cite the fact keys its answer rests on — cited values are then re-read from the
 * payload rather than trusted from the prose. An answer containing a figure that appears nowhere
 * in the facts is discarded in favour of the facts themselves, because a confidently wrong number
 * about someone's money is worse than no answer.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY_BYTES = 2_048;
const MAX_TOKENS = 8_000;

/**
 * This is the most exposed model route in the app: `AskZap` renders on every public, crawlable
 * `/explore/[address]` page, so an unmetered loop over the capsule list is billable model spend
 * AND unmetered Robinhood RPC load. The limiter runs before either is touched.
 */
const rateLimited = createRateLimit(8, 60_000);

const ANSWER_TOOL = {
  name: "answer_from_facts",
  description:
    "Answer the question using only the supplied facts. Cite the fact keys your answer rests on. If the facts do not contain the answer, set unanswerable and say what is missing.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "cites", "unanswerable"],
    properties: {
      answer: { type: "string", maxLength: 1200 },
      cites: {
        type: "array",
        minItems: 0,
        maxItems: 6,
        items: { type: "string", enum: [...ZAP_FACT_KEYS] },
      },
      unanswerable: { type: "boolean" },
    },
  },
} as const;

export type AgentAskResponse =
  | { ok: true; answer: string; cited: TranscriptFactRow[]; grounded: boolean; model: string }
  | { ok: false; error: string };

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (rateLimited(callerKey(request))) {
    return NextResponse.json({ ok: false, error: "Too many questions. Try again in a minute." } satisfies AgentAskResponse, {
      status: 429,
    });
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "That question is too long." } satisfies AgentAskResponse, {
      status: 413,
    });
  }

  const parsed = readBody(body);
  if (!parsed) {
    return NextResponse.json(
      { ok: false, error: "Body must be JSON with `zap` and `question`." } satisfies AgentAskResponse,
      { status: 400 },
    );
  }

  // Read the capsule first. Without a model this still answers deterministically,
  // which is what makes the unconfigured path useful rather than merely graceful.
  let facts: ZapFact[];
  try {
    facts = zapFacts(await fetchZapDetail(parsed.zap));
  } catch (cause) {
    if (isZapNotFound(cause)) {
      return NextResponse.json(
        { ok: false, error: `${parsed.zap} was not created by the OpenZap factory.` } satisfies AgentAskResponse,
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "Robinhood RPC reads for this capsule are unavailable right now." } satisfies AgentAskResponse,
      { status: 503 },
    );
  }

  if (!ANTHROPIC_API_KEY) {
    // Not an error: hand back the facts. The client renders the same card it
    // would have rendered alongside a model answer.
    return NextResponse.json(deterministic(facts, "The agent is not configured, so here are the capsule's facts."));
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages.create({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        {
          type: "text",
          text:
            "You answer questions about one OpenZap capsule using ONLY the facts supplied in the user message. " +
            "Never infer, estimate, or recall a value that is not in the facts. Never state a number that does not appear there. " +
            "If the facts do not answer the question, set unanswerable and name what is missing. " +
            "Cite the fact keys your answer rests on. Be brief.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [ANSWER_TOOL as unknown as Anthropic.Beta.BetaToolUnion],
      tool_choice: { type: "tool", name: ANSWER_TOOL.name },
      messages: [{ role: "user", content: `FACTS\n${serializeFacts(facts)}\n\nQUESTION\n${parsed.question}` }],
    });
  } catch {
    return NextResponse.json(deterministic(facts, "The agent could not be reached, so here are the capsule's facts."));
  }

  if (message.stop_reason === "refusal") {
    return NextResponse.json(deterministic(facts, "The agent declined that question. Here are the capsule's facts."));
  }

  const call = message.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock =>
      block.type === "tool_use" && block.name === ANSWER_TOOL.name,
  );
  if (!call) return NextResponse.json(deterministic(facts, "The agent gave no answer. Here are the capsule's facts."));

  return NextResponse.json(groundAnswer(call.input, facts));
}

/**
 * Accept a model answer only if it is grounded in the facts it was given.
 *
 * Exported for tests — the rejection paths are the point, and they must be checkable without a
 * live model.
 */
export function groundAnswer(input: unknown, facts: readonly ZapFact[]): AgentAskResponse {
  const byKey = new Map(facts.map((fact) => [fact.key, fact]));
  const parsed = parseAnswer(input);
  if (!parsed) return deterministic(facts, "The agent's answer was malformed. Here are the capsule's facts.");

  if (parsed.unanswerable) {
    return { ok: true, answer: parsed.answer, cited: [], grounded: true, model: AGENT_MODEL };
  }

  // Every cited key must be one this request actually built. A citation of a key
  // that was not supplied means the answer is about something else.
  const cited: TranscriptFactRow[] = [];
  for (const key of parsed.cites) {
    const fact = byKey.get(key);
    if (!fact) return deterministic(facts, "The agent cited a fact it was not given. Here are the capsule's facts.");
    // Values come from the payload, never from the model's prose.
    cited.push({ key: fact.key, label: fact.label, value: fact.value });
  }

  if (!isGrounded(parsed.answer, facts)) {
    return deterministic(facts, "The agent's answer contained a figure the capsule does not report. Here are its facts.");
  }

  return { ok: true, answer: parsed.answer, cited, grounded: true, model: AGENT_MODEL };
}

/**
 * Reject an answer containing a hex blob or a long number that appears in no fact.
 *
 * Deliberately narrow: short numbers ("2 runs", "1%") are ordinary prose and pass. What this
 * catches is the failure that matters — an invented address, hash, or balance stated as fact.
 */
export function isGrounded(answer: string, facts: readonly ZapFact[]): boolean {
  const haystack = facts.map((fact) => fact.value).join(" ").toLowerCase();

  for (const hex of answer.match(/0x[0-9a-fA-F]{6,}/g) ?? []) {
    if (!haystack.includes(hex.toLowerCase())) return false;
  }
  // Six or more digits: balances, wei amounts, block numbers. Separators stripped
  // so "1,234,567" is compared as the digits the facts actually carry.
  for (const digits of answer.match(/\d[\d,_]{5,}/g) ?? []) {
    if (!haystack.includes(digits.replace(/[,_]/g, ""))) return false;
  }
  return true;
}

function deterministic(facts: readonly ZapFact[], answer: string): AgentAskResponse {
  return {
    ok: true,
    answer,
    cited: facts.map((fact) => ({ key: fact.key, label: fact.label, value: fact.value })),
    grounded: true,
    model: AGENT_MODEL,
  };
}

function parseAnswer(input: unknown): { answer: string; cites: ZapFactKey[]; unanswerable: boolean } | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (typeof row.answer !== "string" || row.answer.trim().length === 0) return null;

  const cites: ZapFactKey[] = [];
  if (Array.isArray(row.cites)) {
    for (const key of row.cites.slice(0, 6)) {
      if (typeof key === "string" && (ZAP_FACT_KEYS as readonly string[]).includes(key)) cites.push(key as ZapFactKey);
    }
  }
  return { answer: row.answer.trim().slice(0, 1200), cites, unanswerable: row.unanswerable === true };
}

function readBody(body: string): { zap: `0x${string}`; question: string } | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as { zap?: unknown; question?: unknown };
    if (typeof row.zap !== "string" || !HEX_ADDRESS.test(row.zap)) return null;
    if (typeof row.question !== "string") return null;
    const question = row.question.trim();
    if (!question) return null;
    return { zap: getAddress(row.zap.toLowerCase()), question: question.slice(0, 500) };
  } catch {
    return null;
  }
}
