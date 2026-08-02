import {
  getBlock,
  type ChainNode,
  type CompiledZap,
  type LegoBlock,
} from "@/lib/blocks";
import {
  sanitizeAnalyticsPayload,
  type CapturedAnalyticsAttribution,
} from "@/lib/analytics";
import { protocolsForAction } from "@/lib/protocols";

const REQUEST_PATH = "/request-a-zap";
const STORAGE_KEY = "openzaps:lead:builder-handoff:v1";
const STORAGE_VERSION = 1;
const MAX_STORED_DRAFT_LENGTH = 2_500;
const MAX_WORKFLOW_LENGTH = 1_200;
const MAX_PROTOCOLS_ASSETS_LENGTH = 800;
const MAX_SEQUENCE_BLOCKS = 20;
const SAFE_CONTEXT_PARAM_KEYS = new Set([
  "asset",
  "collateral",
  "into",
  "market",
  "pool",
  "settle",
  "venue",
]);
const PROTOCOL_SELECTOR_KEY: Readonly<Record<string, string>> = {
  swap: "venue",
  supply: "market",
};

type RecognizedNode = Readonly<{
  block: LegoBlock;
  node: ChainNode;
}>;

export type BuilderLeadRequestDraft = Readonly<{
  workflow: string;
  protocolsAssets: string;
}>;

export type BuilderLeadRequestHandoff = Readonly<{
  href: string;
  draft: BuilderLeadRequestDraft;
}>;

function truncate(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, maximum - 1).join("")}…`;
}

function recognizedNodes(chain: readonly ChainNode[]): RecognizedNode[] {
  return chain.flatMap((node) => {
    const block = getBlock(node.blockId);
    return block ? [{ block, node }] : [];
  });
}

function summarizedSequence(nodes: readonly RecognizedNode[]): string {
  if (nodes.length === 0) return "No recognized catalog blocks";
  const visible = nodes.slice(0, MAX_SEQUENCE_BLOCKS).map(({ block }) => block.name);
  const omitted = nodes.length - visible.length;
  return `${visible.join(" → ")}${omitted > 0 ? ` → ${omitted} more catalog blocks` : ""}`;
}

function selectedCatalogContext(nodes: readonly RecognizedNode[]): string[] {
  const values = new Set<string>();
  for (const { block, node } of nodes) {
    for (const param of block.params) {
      if (param.type !== "select" || !SAFE_CONTEXT_PARAM_KEYS.has(param.key)) continue;
      const selected = node.params[param.key];
      if (typeof selected === "string" && param.options.includes(selected)) {
        values.add(selected);
      }
    }
  }
  return [...values];
}

function validatedCatalogSelectParams(
  block: LegoBlock,
  node: ChainNode,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of block.params) {
    if (param.type !== "select") continue;
    const selected = node.params[param.key];
    if (typeof selected === "string" && param.options.includes(selected)) {
      values[param.key] = selected;
    }
  }
  return values;
}

function catalogProtocols(nodes: readonly RecognizedNode[]): string[] {
  return [
    ...new Set(
      nodes.flatMap(({ block, node }) => {
        const params = validatedCatalogSelectParams(block, node);
        const selectorKey = PROTOCOL_SELECTOR_KEY[block.id];
        if (selectorKey && params[selectorKey] === undefined) return [];
        return protocolsForAction(block.id, params).map((protocol) => protocol.name);
      }),
    ),
  ];
}

function maturitySentence(nodes: readonly RecognizedNode[]): string {
  if (nodes.length === 0) {
    return "No catalog maturity can be inferred until the design contains recognized blocks.";
  }
  const designOnlyCount = nodes.filter(({ block }) => block.maturity !== "live").length;
  if (designOnlyCount > 0) {
    return `The design includes ${designOnlyCount} non-live catalog ${
      designOnlyCount === 1 ? "block" : "blocks"
    }, so treat it as design-only until reviewed.`;
  }
  return "Its recognized blocks are individually catalogued live, but the complete route still requires deployability review.";
}

function workflowSummary(
  nodes: readonly RecognizedNode[],
  compiled: CompiledZap,
): string {
  const sequence = summarizedSequence(nodes);
  return truncate(
    [
      "Review this OpenZaps builder design as a bounded-authority hypothesis.",
      `Recognized sequence: ${sequence}.`,
      `The current local compiler verdict is ${compiled.status}.`,
      maturitySentence(nodes),
      "Map the fixed targets, route, assets, recipient, amount limits, trigger or cadence, output floor, expiry, recovery path, and what an agent can never change.",
    ].join(" "),
    MAX_WORKFLOW_LENGTH,
  );
}

function protocolsAssetsSummary(nodes: readonly RecognizedNode[]): string {
  const names = [...new Set(nodes.map(({ block }) => block.name))];
  const protocols = catalogProtocols(nodes);
  const context = selectedCatalogContext(nodes);
  return truncate(
    [
      `OpenZaps catalog blocks: ${names.length > 0 ? names.join(", ") : "none recognized"}.`,
      `Catalog protocols: ${protocols.length > 0 ? protocols.join(", ") : "none"}.`,
      `Selected catalog assets/context: ${context.length > 0 ? context.join(", ") : "none"}.`,
    ].join(" "),
    MAX_PROTOCOLS_ASSETS_LENGTH,
  );
}

function validDraft(value: unknown): value is BuilderLeadRequestDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || typeof record.workflow !== "string"
    || typeof record.protocolsAssets !== "string"
  ) {
    return false;
  }
  return (
    record.workflow.startsWith(
      "Review this OpenZaps builder design as a bounded-authority hypothesis.",
    )
    && record.workflow.length <= MAX_WORKFLOW_LENGTH
    && record.protocolsAssets.startsWith("OpenZaps catalog blocks:")
    && record.protocolsAssets.length <= MAX_PROTOCOLS_ASSETS_LENGTH
  );
}

/** Store a one-shot, same-tab prefill without putting strategy context in a URL. */
export function storeBuilderLeadRequestDraft(
  storage: Pick<Storage, "setItem">,
  draft: BuilderLeadRequestDraft,
): boolean {
  if (!validDraft(draft)) return false;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, ...draft }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Consume and remove the prefill before it can survive a later tab session. */
export function consumeBuilderLeadRequestDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
): BuilderLeadRequestDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
    storage.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw || raw.length > MAX_STORED_DRAFT_LENGTH) return null;

  try {
    const stored = JSON.parse(raw) as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
    const { version, ...draft } = stored as Record<string, unknown>;
    return version === STORAGE_VERSION && validDraft(draft) ? draft : null;
  } catch {
    return null;
  }
}

/**
 * Store through the browser boundary. Reading `sessionStorage` can itself
 * throw in storage-restricted contexts, before Storage.setItem is reached.
 */
export function storeBuilderLeadRequestDraftInBrowser(
  draft: BuilderLeadRequestDraft,
  browser: Pick<Window, "sessionStorage"> = window,
): boolean {
  try {
    return storeBuilderLeadRequestDraft(browser.sessionStorage, draft);
  } catch {
    return false;
  }
}

/** Consume through the same fail-closed browser boundary. */
export function consumeBuilderLeadRequestDraftInBrowser(
  browser: Pick<Window, "sessionStorage"> = window,
): BuilderLeadRequestDraft | null {
  try {
    return consumeBuilderLeadRequestDraft(browser.sessionStorage);
  } catch {
    return null;
  }
}

/**
 * Build a deterministic, privacy-bounded handoff from the visual builder to
 * Request a Zap. Only the fixed entry point and a privacy-reduced first touch
 * enter the URL. The safe catalog summary stays in one-shot tab storage until
 * the destination form consumes it. Design tokens, node ids, free text,
 * amounts, addresses, compiler details, and fingerprints cross neither path.
 */
export function builderLeadRequestHandoff(
  chain: readonly ChainNode[],
  compiled: CompiledZap,
  acquisition: CapturedAnalyticsAttribution | null = null,
): BuilderLeadRequestHandoff {
  const nodes = recognizedNodes(chain);
  const params = new URLSearchParams({
    entry_point: "builder_review",
  });
  const safeAcquisition = sanitizeAnalyticsPayload(acquisition ?? {});
  for (const [property, query] of [
    ["source", "utm_source"],
    ["medium", "utm_medium"],
    ["campaign", "utm_campaign"],
    ["content", "utm_content"],
  ] as const) {
    const value = safeAcquisition[property];
    if (typeof value === "string") params.set(query, value);
  }
  return {
    href: `${REQUEST_PATH}?${params.toString()}`,
    draft: {
      workflow: workflowSummary(nodes, compiled),
      protocolsAssets: protocolsAssetsSummary(nodes),
    },
  };
}
