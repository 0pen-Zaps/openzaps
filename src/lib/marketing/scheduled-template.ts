import type {
  MarketingCandidate,
  MarketingClaim,
  MarketingDisclosure,
  MarketingPolicyFlags,
  MarketingTopic,
} from "@/lib/marketing/types";
import {
  AGENT_KIT_MARKETING_CAMPAIGN_ID,
  LEARN_HUB_MARKETING_CAMPAIGN_ID,
  SCHEDULED_MARKETING_TEMPLATE_ID,
} from "@/lib/marketing/types";

export const SCHEDULED_MARKETING_CHANNELS = ["x", "discord"] as const;

export type ScheduledMarketingChannel =
  (typeof SCHEDULED_MARKETING_CHANNELS)[number];

export interface ReviewedMarketingFactRequirement {
  key: string;
  sourceUrl: string;
}

/**
 * Source-reviewed, deterministic public copy. Adding a campaign requires a
 * source change plus an immutable database queue entry with the same content
 * hash. Model output can never become an automatic campaign.
 */
export interface ReviewedMarketingCampaign {
  id: string;
  channel: ScheduledMarketingChannel;
  queueOrder: number;
  notBefore: string | null;
  body: string;
  links: string[];
  topics: MarketingTopic[];
  disclosures: MarketingDisclosure[];
  claims: MarketingClaim[];
  flags: MarketingPolicyFlags;
  requiredFacts: ReviewedMarketingFactRequirement[];
  canonicalSourceUrls: string[];
  /** SHA-256 of reviewedMarketingCampaignCanonicalPayload(campaign). */
  contentHash: string;
}

const SAFE_FLAGS: MarketingPolicyFlags = {
  containsCredential: false,
  guaranteesReturns: false,
  impersonatesPerson: false,
  requestsPolicyBypass: false,
  unsolicitedBulkMessaging: false,
  usesUnavailableAsZero: false,
};

const FEATURE_CLAIMS: MarketingClaim[] = [
  {
    text:
      "Virtual Trading is a browser-local paper-trading sandbox with 10,000 virtual USDG; it does not use a wallet, approval, signature, transaction, or real funds.",
    factKeys: ["product.virtual_trading"],
    treatment: "asserted",
  },
  {
    text:
      "Virtual Trading exposes current marks for the deployed 0xZAPS/USDG and aeWETH/USDG routes.",
    factKeys: ["product.virtual_trading_markets"],
    treatment: "asserted",
  },
  {
    text: "Virtual Trading returned a fresh read-only paper-trade quote.",
    factKeys: ["product.virtual_trading_quote"],
    treatment: "asserted",
  },
  {
    text:
      "Request a Zap accepts a workflow request for human review and a bounded authority map rather than automatic deployment.",
    factKeys: ["product.request_a_zap", "product.request_a_zap_intake"],
    treatment: "asserted",
  },
];

const FEATURE_FACTS: ReviewedMarketingFactRequirement[] = [
  {
    key: "product.virtual_trading",
    sourceUrl: "https://www.0xzaps.com/virtual-trading",
  },
  {
    key: "product.virtual_trading_markets",
    sourceUrl: "https://www.0xzaps.com/api/virtual-trading/markets",
  },
  {
    key: "product.virtual_trading_quote",
    sourceUrl: "https://www.0xzaps.com/api/virtual-trading/quote",
  },
  {
    key: "product.request_a_zap",
    sourceUrl: "https://www.0xzaps.com/request-a-zap",
  },
  {
    key: "product.request_a_zap_intake",
    sourceUrl: "https://www.0xzaps.com/api/leads/request",
  },
];

const FEATURE_SOURCE_URLS = FEATURE_FACTS.map((fact) => fact.sourceUrl);

const AGENT_KIT_FACTS: ReviewedMarketingFactRequirement[] = [
  {
    key: "product.agent_kit_sdk_release",
    sourceUrl: "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0",
  },
  {
    key: "product.agent_kit_mcp_release",
    sourceUrl: "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0",
  },
  {
    key: "product.agent_kit_boundaries",
    sourceUrl: "https://www.0xzaps.com/docs",
  },
];

const AGENT_KIT_CLAIMS: MarketingClaim[] = [
  {
    text:
      "The npm registry publishes @openzaps/sdk@0.1.0 with a provenance attestation.",
    factKeys: ["product.agent_kit_sdk_release"],
    treatment: "asserted",
  },
  {
    text:
      "The npm registry publishes @openzaps/mcp@0.1.0 with a provenance attestation.",
    factKeys: ["product.agent_kit_mcp_release"],
    treatment: "asserted",
  },
  {
    text:
      "The SDK prepares unsigned policy data without signing or broadcasting; the read-only MCP surface discovers capsules without holding a wallet key; creation stays with the owner wallet or Safe, and execution authority lives in the immutable policy or typed intent.",
    factKeys: ["product.agent_kit_boundaries"],
    treatment: "asserted",
  },
];

const AGENT_KIT_X_FACTS: ReviewedMarketingFactRequirement[] = [
  {
    key: "product.agent_kit_sdk_release",
    sourceUrl: "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0",
  },
  {
    key: "product.agent_kit_mcp_release",
    sourceUrl: "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0",
  },
  {
    key: "product.agent_kit_page",
    sourceUrl: "https://www.0xzaps.com/agent-kit",
  },
];

const AGENT_KIT_X_CLAIMS: MarketingClaim[] = [
  {
    text:
      "The npm registry publishes @openzaps/sdk@0.1.0, and the live Agent Kit page states that the SDK compiles the exact policy tuple and prepares unsigned EIP-712 data.",
    factKeys: ["product.agent_kit_sdk_release", "product.agent_kit_page"],
    treatment: "asserted",
  },
  {
    text:
      "The npm registry publishes @openzaps/mcp@0.1.0, and the live Agent Kit page states that the MCP surface gives agent clients read-only capsule discovery.",
    factKeys: ["product.agent_kit_mcp_release", "product.agent_kit_page"],
    treatment: "asserted",
  },
  {
    text:
      "The live Agent Kit page states that neither package holds a wallet key, signs, or broadcasts.",
    factKeys: ["product.agent_kit_page"],
    treatment: "asserted",
  },
];

const LEARN_HUB_FACTS: ReviewedMarketingFactRequirement[] = [
  {
    key: "product.learn_hub",
    sourceUrl: "https://www.0xzaps.com/learn",
  },
];

const LEARN_HUB_CLAIMS: MarketingClaim[] = [
  {
    text:
      "OpenZaps Learn publishes source-reviewed product updates and only RSS-confirmed DeFi Tutorials, withholds drafts and editor handoffs from its catalog until RSS confirmation, and links to Request a Zap for a human-reviewed authority map.",
    factKeys: ["product.learn_hub"],
    treatment: "asserted",
  },
];

const CAMPAIGNS: readonly ReviewedMarketingCampaign[] = [
  {
    id: SCHEDULED_MARKETING_TEMPLATE_ID,
    channel: "x",
    queueOrder: 10,
    notBefore: null,
    body:
      "New on OpenZaps:\n\n→ Virtual Trading: paper trades with 10,000 virtual USDG and live read-only quotes. No wallet. No real funds.\n\n→ Request a Zap: submit one workflow to request a human-reviewed authority map.\n\nhttps://www.0xzaps.com\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com"],
    topics: ["simulation", "protocol"],
    disclosures: ["pre_audit"],
    claims: FEATURE_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: FEATURE_FACTS,
    canonicalSourceUrls: FEATURE_SOURCE_URLS,
    contentHash:
      "31bc8afd32a05563745a85b55a8ae267fda72da5c9cef4b3b63378b14cf53961",
  },
  {
    id: SCHEDULED_MARKETING_TEMPLATE_ID,
    channel: "discord",
    queueOrder: 11,
    notBefore: null,
    body:
      "New on OpenZaps:\n\n**Virtual Trading** lets you paper-trade deployed 0xZAPS/USDG and aeWETH/USDG routes with 10,000 virtual USDG and live read-only quotes. No wallet, approval, signature, transaction, or real funds.\n\n**Request a Zap** lets you submit one workflow for human review and request a bounded authority map: what the agent may trigger and what it can never change. A review is not an automatic deployment promise.\n\nTry Virtual Trading: https://www.0xzaps.com/virtual-trading\nRequest a Zap: https://www.0xzaps.com/request-a-zap\n\nPre-audit software. Verify before use.",
    links: [
      "https://www.0xzaps.com/virtual-trading",
      "https://www.0xzaps.com/request-a-zap",
    ],
    topics: ["simulation", "protocol"],
    disclosures: ["pre_audit"],
    claims: FEATURE_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: FEATURE_FACTS,
    canonicalSourceUrls: FEATURE_SOURCE_URLS,
    contentHash:
      "d87798d6ff0ba39a29c5b9da58397162cb43cd4908c5b604493e8fe98a0604f5",
  },
  {
    id: AGENT_KIT_MARKETING_CAMPAIGN_ID,
    channel: "discord",
    queueOrder: 20,
    notBefore: "2026-08-03T14:00:00.000Z",
    body:
      "**The OpenZaps Agent Kit is published.**\n\n`@openzaps/sdk@0.1.0` compiles the exact policy tuple and prepares unsigned EIP-712 data. `@openzaps/mcp@0.1.0` gives agent clients read-only capsule discovery. Both releases carry npm provenance attestations.\n\nNeither package holds a key, signs, or broadcasts. Your wallet or Safe creates authority; the signed intent and immutable Zap policy set the bounds.\n\nConnect an agent: https://www.0xzaps.com/docs#agents\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/docs#agents"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: AGENT_KIT_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: AGENT_KIT_FACTS,
    canonicalSourceUrls: AGENT_KIT_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "516443309a2b558c1335bb4f672a649a1f728ddc643bb0a762564835c6ff59ca",
  },
  {
    id: AGENT_KIT_MARKETING_CAMPAIGN_ID,
    channel: "x",
    queueOrder: 21,
    notBefore: "2026-08-05T14:00:00.000Z",
    body:
      "OpenZaps Agent Kit is published.\n\n→ SDK: compiles the exact policy tuple and prepares unsigned EIP-712 data.\n→ MCP: read-only capsule discovery.\n\nNeither package holds a key, signs, or broadcasts.\nhttps://www.0xzaps.com/agent-kit\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/agent-kit"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: AGENT_KIT_X_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: AGENT_KIT_X_FACTS,
    canonicalSourceUrls: AGENT_KIT_X_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "c0dc5ff730cdd8efaf58cf1af1940941e5c6dd60c75f542ad036226862448a0e",
  },
  {
    id: LEARN_HUB_MARKETING_CAMPAIGN_ID,
    channel: "x",
    queueOrder: 30,
    notBefore: "2026-08-04T14:00:00.000Z",
    body:
      "OpenZaps Learn is live.\n\nSource-reviewed product updates and RSS-confirmed DeFi Tutorials in one hub. Drafts stay off this catalog until RSS confirmation.\n\nRead—or request a bounded authority map:\nhttps://www.0xzaps.com/learn\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/learn"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: LEARN_HUB_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: LEARN_HUB_FACTS,
    canonicalSourceUrls: LEARN_HUB_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "d1582813d0f9c4a53385e75082bd6d3fba90a5ea0edd2ce86bed873ca7289717",
  },
  {
    id: LEARN_HUB_MARKETING_CAMPAIGN_ID,
    channel: "discord",
    queueOrder: 31,
    notBefore: "2026-08-04T14:00:00.000Z",
    body:
      "**OpenZaps Learn is live.**\n\nThe new hub collects source-reviewed OpenZaps product updates and DeFi Tutorials whose title and canonical URL are RSS-confirmed. Drafts and editor handoffs are withheld from the Learn catalog until RSS confirmation.\n\nUse it to follow what shipped, read why the bounds matter, or request a human-reviewed authority map for one workflow:\nhttps://www.0xzaps.com/learn\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/learn"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: LEARN_HUB_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: LEARN_HUB_FACTS,
    canonicalSourceUrls: LEARN_HUB_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "4f091100fe08207167569a2233d0c6ebe4910c64efd4161347277986478042c9",
  },
];

// The v2 X copy has a separately verified public receipt and is intentionally
// not eligible for automatic delivery. The matching Discord contract remains
// here to exercise the fail-closed automatic lane, but the production queue
// intentionally starts empty because that Discord update is also already
// public. A durable claim is still mandatory, so source membership alone can
// never authorize a provider write. Future campaigns must update source and
// the durable queue together.
const AUTO_DELIVERY_CAMPAIGNS = new Set([
  `${SCHEDULED_MARKETING_TEMPLATE_ID}:discord`,
  `${AGENT_KIT_MARKETING_CAMPAIGN_ID}:discord`,
  `${AGENT_KIT_MARKETING_CAMPAIGN_ID}:x`,
  `${LEARN_HUB_MARKETING_CAMPAIGN_ID}:x`,
  `${LEARN_HUB_MARKETING_CAMPAIGN_ID}:discord`,
]);

function cloneCampaign(
  campaign: ReviewedMarketingCampaign,
): ReviewedMarketingCampaign {
  return {
    ...campaign,
    notBefore:
      campaign.notBefore === null
        ? null
        : new Date(campaign.notBefore).toISOString(),
    links: [...campaign.links],
    topics: [...campaign.topics],
    disclosures: [...campaign.disclosures],
    claims: campaign.claims.map((claim) => ({
      ...claim,
      factKeys: [...claim.factKeys],
    })),
    flags: { ...campaign.flags },
    requiredFacts: campaign.requiredFacts.map((fact) => ({ ...fact })),
    canonicalSourceUrls: [...campaign.canonicalSourceUrls],
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function reviewedMarketingCampaigns(): ReviewedMarketingCampaign[] {
  return CAMPAIGNS.map(cloneCampaign);
}

export function reviewedMarketingCampaign(
  campaignId: string,
  channel: ScheduledMarketingChannel,
): ReviewedMarketingCampaign {
  const campaign = CAMPAIGNS.find(
    (entry) => entry.id === campaignId && entry.channel === channel,
  );
  if (!campaign) {
    throw new Error("Unknown reviewed marketing campaign.");
  }
  return cloneCampaign(campaign);
}

export function reviewedMarketingCampaignIsAvailable(
  campaignId: string,
  channel: ScheduledMarketingChannel,
  now: string,
): boolean {
  let campaign: ReviewedMarketingCampaign;
  try {
    campaign = reviewedMarketingCampaign(campaignId, channel);
  } catch {
    return false;
  }
  const evaluatedAt = Date.parse(now);
  if (!Number.isFinite(evaluatedAt)) return false;
  return campaign.notBefore === null || evaluatedAt >= Date.parse(campaign.notBefore);
}

export function reviewedMarketingCampaignCanonicalPayload(
  campaign: ReviewedMarketingCampaign,
): Record<string, unknown> {
  return {
    id: campaign.id,
    channel: campaign.channel,
    queueOrder: campaign.queueOrder,
    notBefore:
      campaign.notBefore === null
        ? null
        : new Date(campaign.notBefore).toISOString(),
    body: campaign.body,
    links: campaign.links,
    topics: campaign.topics,
    disclosures: campaign.disclosures,
    claims: campaign.claims,
    flags: campaign.flags,
    requiredFacts: campaign.requiredFacts,
    canonicalSourceUrls: campaign.canonicalSourceUrls,
  };
}

/** Compatibility accessor for the campaign that replaced the one-shot slot. */
export function scheduledMarketingTemplate(
  channel: ScheduledMarketingChannel,
): ReviewedMarketingCampaign {
  return reviewedMarketingCampaign(SCHEDULED_MARKETING_TEMPLATE_ID, channel);
}

function hasRequiredCampaignEvidence(
  candidate: MarketingCandidate,
  campaign: ReviewedMarketingCampaign,
): boolean {
  const facts = new Map(
    candidate.sourcePacket.facts.map((fact) => [fact.key, fact]),
  );
  return campaign.requiredFacts.every((requirement) => {
    const fact = facts.get(requirement.key);
    return fact?.status === "confirmed" && fact.sourceUrl === requirement.sourceUrl;
  });
}

/**
 * Automatic delivery is permitted only when every public, policy, and evidence
 * field still exactly matches a source-reviewed campaign.
 */
export function isReviewedMarketingCampaignCandidate(
  candidate: MarketingCandidate,
  campaignId: string,
): boolean {
  if (
    !SCHEDULED_MARKETING_CHANNELS.includes(
      candidate.channel as ScheduledMarketingChannel,
    )
  ) {
    return false;
  }
  const campaign = CAMPAIGNS.find(
    (entry) => entry.id === campaignId && entry.channel === candidate.channel,
  );
  if (
    !campaign ||
    !AUTO_DELIVERY_CAMPAIGNS.has(`${campaign.id}:${campaign.channel}`)
  ) {
    return false;
  }
  return (
    candidate.action === "broadcast" &&
    candidate.kind === "product_update" &&
    candidate.interaction === null &&
    sameJson(candidate.topics, campaign.topics) &&
    candidate.body === campaign.body &&
    sameJson(candidate.links, campaign.links) &&
    sameJson(candidate.disclosures, campaign.disclosures) &&
    sameJson(candidate.claims, campaign.claims) &&
    sameJson(candidate.flags, campaign.flags) &&
    hasRequiredCampaignEvidence(candidate, campaign)
  );
}

export function isScheduledMarketingTemplateCandidate(
  candidate: MarketingCandidate,
  templateId: string,
): boolean {
  return isReviewedMarketingCampaignCandidate(candidate, templateId);
}
