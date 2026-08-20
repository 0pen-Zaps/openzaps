/**
 * Client-safe, source-controlled approval registry for deterministic X replies.
 *
 * Both the executable classifier and the operator approval panel consume this
 * exact data. Any prompt or response change requires a new digest and explicit
 * owner/provider approval before automatic replies can become ready.
 */
export const X_MENTION_TEMPLATE_VERSION = 2 as const;

export const X_MENTION_TEMPLATE_IDS = [
  "about-v1",
  "agent-authority-v1",
  "docs-v1",
  "request-zap-v1",
  "virtual-trading-v1",
] as const;

export type XMentionTemplateId = (typeof X_MENTION_TEMPLATE_IDS)[number];

export const X_MENTION_APPROVAL_REGISTRY = [
  {
    templateId: "about-v1",
    prompts: [
      "/about",
      "about",
      "what is openzaps",
      "how does openzaps work",
      "what is a zap",
    ],
    body:
      "OpenZaps lets an owner pre-commit one bounded onchain workflow. An agent may hold the trigger but cannot widen the signed route, recipient, asset, amount, calldata, cadence, or limits. https://www.0xzaps.com/docs\n\nPre-audit. Reply @0xzaps stop to opt out.",
  },
  {
    templateId: "agent-authority-v1",
    prompts: [
      "/agent",
      "agent",
      "agent authority",
      "how do agents work",
      "what can an agent change",
      "what can an agent do",
      "what authority does an agent have",
    ],
    body:
      "Give the agent the trigger, never the authority. It may submit a due run, but the signed recipient, route, asset, amount, calldata, cadence, and safety limits stay fixed. https://www.0xzaps.com/docs\n\nPre-audit. Reply @0xzaps stop to opt out.",
  },
  {
    templateId: "docs-v1",
    prompts: [
      "/docs",
      "docs",
      "documentation",
      "where are docs",
      "where are the docs",
      "where can i find docs",
      "where can i find the docs",
    ],
    body:
      "OpenZaps docs: https://www.0xzaps.com/docs\n\nVerify before use. Reply @0xzaps stop to opt out.",
  },
  {
    templateId: "request-zap-v1",
    prompts: [
      "/request",
      "request",
      "request a zap",
      "how can i request a zap",
      "how do i request a zap",
      "where can i request a zap",
    ],
    body:
      "Request a Zap and get a human-reviewed authority map for one bounded workflow: https://www.0xzaps.com/request-a-zap\n\nThis is not an automatic deployment promise. Reply @0xzaps stop to opt out.",
  },
  {
    templateId: "virtual-trading-v1",
    prompts: [
      "/virtual",
      "virtual",
      "virtual trading",
      "how can i try virtual trading",
      "how do i try virtual trading",
      "where can i try virtual trading",
    ],
    body:
      "Try Virtual Trading with 10,000 virtual USDG—no wallet, deposit, approval, signature, transaction, or real funds: https://www.0xzaps.com/virtual-trading\n\nReply @0xzaps stop to opt out.",
  },
] as const satisfies ReadonlyArray<{
  templateId: XMentionTemplateId;
  prompts: readonly string[];
  body: string;
}>;

export const X_MENTION_APPROVAL_REGISTRY_CANONICAL_JSON = JSON.stringify({
  version: X_MENTION_TEMPLATE_VERSION,
  templates: X_MENTION_APPROVAL_REGISTRY,
});

/**
 * SHA-256 of X_MENTION_APPROVAL_REGISTRY_CANONICAL_JSON.
 *
 * A server-side unit test recomputes this value. Keeping the literal here lets
 * client code compare the exact reviewed digest without importing node:crypto.
 */
export const X_MENTION_TEMPLATE_REGISTRY_DIGEST =
  "5a4f584c31d46552e75fc4a675ee207d5966b341afe6ee0317cc864e69cb10e3";
