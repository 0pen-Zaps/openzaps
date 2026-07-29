import { BLOCKS, RECIPES, type LegoBlock } from "@/lib/blocks";

/**
 * The prompt and tool schema the compose route hands the model.
 *
 * Both are GENERATED from the block catalog rather than written alongside it. A hand-maintained
 * copy of the block list is a second source of truth that drifts the first time someone adds a
 * block — and the failure is silent, because the model just never proposes the new one.
 *
 * The schema is also the safety boundary's first layer: it can only name catalog block ids and
 * their declared params. There is no field anywhere in it for an address, a calldata blob, or a
 * wei amount — the model proposes a shape, and `compileChain` decides whether that shape is legal.
 */

export const AGENT_MODEL = process.env.OPENZAPS_AGENT_MODEL ?? "claude-opus-5";

/**
 * The first twelve recipes are the deployable set, held to that claim by deployable.test.ts.
 * Citing anything past that boundary in the prompt would teach the model to propose designs the
 * compiler then refuses — a worse experience than not suggesting them at all.
 */
export const DEPLOYABLE_RECIPE_COUNT = 12;

/**
 * Blocks the model may propose.
 *
 * `blocked` maturity is excluded outright: those are blocks the builder itself refuses to deploy,
 * so proposing one can only ever produce a refusal card.
 */
export const PROPOSABLE_BLOCKS: readonly LegoBlock[] = BLOCKS.filter((block) => block.maturity !== "blocked");

export const PROPOSABLE_BLOCK_IDS: readonly string[] = PROPOSABLE_BLOCKS.map((block) => block.id);

export const PROPOSE_CHAIN_TOOL = {
  name: "propose_chain",
  description:
    "Propose a Zap as an ordered chain of catalog blocks. You do not decide whether the chain is legal, deployable, or safe — a deterministic compiler judges it after you, and will refuse anything that does not hold.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["nodes", "rationale"],
    properties: {
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        description: "The chain in execution order: a source, then actions and guards, then a sink.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["blockId", "params"],
          properties: {
            blockId: { type: "string", enum: [...PROPOSABLE_BLOCK_IDS] },
            params: {
              type: "object",
              description:
                "Values for this block's declared params, keyed by param key. Omit a key to accept its default.",
              additionalProperties: { type: ["string", "number"] },
            },
          },
        },
      },
      rationale: {
        type: "string",
        maxLength: 400,
        description: "One or two sentences on why this chain answers the request.",
      },
    },
  },
} as const;

/**
 * The catalog, rendered for the model.
 *
 * Params are listed with their type and domain so the model proposes values that survive
 * `decodeChain`'s domain check rather than being silently dropped.
 */
export function agentSystemPrompt(): string {
  return [
    "You turn a person's plain-language intent into a proposed Zap: an ordered chain of blocks that a deterministic compiler then judges.",
    "",
    "A Zap is an immutable onchain policy capsule on Robinhood Chain 4663. Once deployed, its route, adapters, calldata shape, and recipient are frozen. That is what makes it safe to point an agent at — so propose bounded designs, and prefer adding a guard over leaving a bound implicit.",
    "",
    "RULES",
    "- Call propose_chain exactly once. Never answer in prose.",
    "- Use only the block ids listed below. There are no others.",
    "- A chain runs in order: it starts with a source, ends with a sink, and each block's output shape must match the next block's input shape.",
    "- You never choose addresses, calldata, or raw amounts. If a bound is not expressible as a block param, leave it out — do not invent a field.",
    "- You do not decide legality. Propose the clearest design that answers the request; the compiler will report what it refuses.",
    "",
    "BLOCK CATALOG",
    ...PROPOSABLE_BLOCKS.map(describeBlock),
    "",
    "DEPLOYABLE PATTERNS",
    "These compile to live policies today and are the safest shapes to start from:",
    ...RECIPES.slice(0, DEPLOYABLE_RECIPE_COUNT).map(
      (recipe) => `- ${recipe.name}: ${recipe.tagline} — ${recipe.blocks.map(([id]) => id).join(" → ")}`,
    ),
  ].join("\n");
}

function describeBlock(block: LegoBlock): string {
  const flow = `${block.accepts ?? "—"} → ${block.emits ?? "—"}`;
  const params = block.params.length > 0 ? ` params: ${block.params.map(describeParam).join(", ")}` : "";
  const maturity = block.maturity === "live" ? "" : ` [${block.maturity}]`;
  return `- ${block.id} (${block.kind}, ${flow})${maturity}: ${block.blurb}.${params}`;
}

function describeParam(param: LegoBlock["params"][number]): string {
  switch (param.type) {
    case "number":
      return `${param.key}=number ${param.min}..${param.max}`;
    case "select":
      return `${param.key}=one of [${param.options.join("|")}]`;
    case "amount":
      return `${param.key}=decimal amount${param.unit ? ` in ${param.unit}` : ""}`;
    case "text":
      return `${param.key}=text`;
  }
}
