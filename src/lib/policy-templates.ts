import { keccak256, toBytes, type Address } from "viem";

import {
  compileChain,
  decodeDesign,
  encodeChain,
  type ChainNode,
  type ParamValue,
} from "@/lib/blocks";

export const POLICY_TEMPLATE_SCHEMA = "openzaps-policy-template/v1";
export const POLICY_TEMPLATE_HASH = /^0x[0-9a-f]{64}$/;
export const MAX_TEMPLATE_NAME = 80;
export const MAX_TEMPLATE_SUMMARY = 240;

export type PolicyTemplateChainEntry = {
  block: string;
  params: Record<string, ParamValue>;
};

export type PolicyTemplateContent = {
  schema: typeof POLICY_TEMPLATE_SCHEMA;
  version: number;
  parentHash: string | null;
  name: string;
  summary: string;
  chain: PolicyTemplateChainEntry[];
};

export type PublicPolicyTemplate = PolicyTemplateContent & {
  contentHash: string;
  token: string;
  compiledHash: string;
  /** EIP-191 signer that admitted this immutable version to the public registry. */
  publisher: Address;
  createdAt: string;
  /** Anonymous device convenience count only; never ranking, reputation, or proof of people. */
  subscriptionCount: number;
};

export type PreparedPolicyTemplate = Omit<PublicPolicyTemplate, "publisher" | "createdAt" | "subscriptionCount"> & {
  nodes: ChainNode[];
};

/**
 * Human-readable, content-bound publication consent.
 *
 * No nonce is needed: replaying this signature can only request the exact same
 * immutable content hash, whose primary key makes insertion idempotent. The
 * fixed domain and chain keep it from becoming a generic wallet signature.
 */
export function policyTemplatePublishMessage(
  template: Pick<PreparedPolicyTemplate, "schema" | "contentHash">,
): string {
  return [
    "OpenZaps public policy template publication",
    "Domain: 0xzaps.com",
    "Chain ID: 4663",
    `Schema: ${template.schema}`,
    `Content hash: ${template.contentHash}`,
    "",
    "This signature publishes this exact immutable template. It cannot move funds or authorize a Zap execution.",
  ].join("\n");
}

/**
 * Validate and content-address a template.
 *
 * Uids are intentionally absent from the hashed content: they are canvas-local
 * React identities, not policy semantics. Every block id and param is rebuilt
 * through `decodeDesign`, then compiled; a blocked chain cannot enter the public
 * registry. Metadata and parent/version lineage ARE hashed, so an immutable
 * version can never be relabelled or reparented under the same address.
 */
export function preparePolicyTemplate(input: unknown): PreparedPolicyTemplate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Template must be an object.");
  const row = input as Record<string, unknown>;
  const name = textField(row.name, "Name", MAX_TEMPLATE_NAME, true);
  const summary = textField(row.summary, "Summary", MAX_TEMPLATE_SUMMARY, false);
  const version = numberField(row.version, "Version");
  const parentHash = parentField(row.parentHash);
  if (parentHash === null && version !== 1) throw new Error("A root template must start at version 1.");
  if (parentHash !== null && version < 2) throw new Error("A fork must advance beyond version 1.");

  const nodes = decodeDesign(JSON.stringify({ chain: row.chain }));
  if (!nodes || nodes.length === 0) throw new Error("Template chain is empty or invalid.");
  const compiled = compileChain(nodes);
  if (compiled.status === "block") {
    throw new Error(`Template does not compile: ${compiled.issues.filter((issue) => issue.level === "block").map((issue) => issue.message).join(" ")}`);
  }

  const content: PolicyTemplateContent = {
    schema: POLICY_TEMPLATE_SCHEMA,
    version,
    parentHash,
    name,
    summary,
    chain: nodes.map((node) => ({
      block: node.blockId,
      params: sortedParams(node.params),
    })),
  };
  const contentHash = keccak256(toBytes(stableStringify(content)));
  return {
    ...content,
    contentHash,
    token: encodeChain(nodes),
    compiledHash: compiled.hash,
    nodes,
  };
}

export function isPolicyTemplateHash(value: unknown): value is string {
  return typeof value === "string" && POLICY_TEMPLATE_HASH.test(value.toLowerCase());
}

export function templateChain(chain: readonly ChainNode[]): PolicyTemplateChainEntry[] {
  return chain.map((node) => ({ block: node.blockId, params: sortedParams(node.params) }));
}

/** Stable JSON with object keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

function sortedParams(params: Readonly<Record<string, ParamValue>>): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(params).sort(([left], [right]) => left.localeCompare(right)));
}

function textField(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} is too long.`);
  return text;
}

function numberField(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function parentField(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isPolicyTemplateHash(value)) throw new Error("Parent hash must be a content hash.");
  return value.toLowerCase();
}
