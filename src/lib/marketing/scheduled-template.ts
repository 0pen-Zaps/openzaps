import type {
  MarketingCandidate,
  MarketingClaim,
  MarketingDisclosure,
  MarketingPolicyFlags,
  MarketingTopic,
} from "@/lib/marketing/types";
import {
  AGENT_KIT_MARKETING_CAMPAIGN_ID,
  FEE_REWARDS_MARKETING_CAMPAIGN_ID,
  LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
  LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
  SCHEDULED_MARKETING_TEMPLATE_ID,
  SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
} from "@/lib/marketing/types";
import { attributedReviewedCampaignUrl } from "@/lib/marketing/campaign-attribution";

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
  /** Exclusive manual-publication cutoff; omitted for automatic campaigns. */
  notAfter?: string | null;
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

const FEE_REWARDS_FACTS: ReviewedMarketingFactRequirement[] = [
  {
    key: "product.fee_rewards_terms",
    sourceUrl: "https://www.0xzaps.com/rewards",
  },
  {
    key: "product.fee_rewards_active_snapshot",
    sourceUrl: "https://www.0xzaps.com/api/protocol/rewards",
  },
];

const FEE_REWARDS_CLAIMS: MarketingClaim[] = [
  {
    text:
      "The live rewards surface identifies a separate fixed 2026 campaign active from Aug 3 00:23 UTC until Aug 10 00:23 UTC, with claims available until Sep 9 00:23 UTC; it is funded with 50 of 100 tokenized Clanker fee shares, uses 0xZAPS stake principal, pays WETH as the only campaign reward asset by time-weighted stake, and holding 0xZAPS alone grants no fee rights.",
    factKeys: ["product.fee_rewards_terms"],
    treatment: "asserted",
  },
  {
    text:
      "A fresh block-pinned production snapshot reports that the fixed campaign is active, its 50 fee-share principal is funded, its reviewed runtime identities still match, and its vault and configured Clanker fee source are verified.",
    factKeys: ["product.fee_rewards_active_snapshot"],
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

const SHARE_ZAP_DESIGN_FACTS: ReviewedMarketingFactRequirement[] = [
  {
    key: "product.shareable_zap_design",
    sourceUrl: "https://www.0xzaps.com/docs",
  },
];

const SHARE_ZAP_DESIGN_CLAIMS: MarketingClaim[] = [
  {
    text:
      "An OpenZaps design link carries only a designed chain into the builder, which bounds and validates the untrusted payload before recompiling recognized blocks and parameters; the link grants no wallet authority, design mode never prompts for wallet access, approval, funding, a signature, or a transaction, and any supported live action remains separately wallet-reviewed and signed.",
    factKeys: ["product.shareable_zap_design"],
    treatment: "asserted",
  },
];

const AGENT_KIT_ATTRIBUTED_URLS = {
  discord: attributedReviewedCampaignUrl(
    "https://www.0xzaps.com/agent-kit",
    AGENT_KIT_MARKETING_CAMPAIGN_ID,
    "discord",
  ),
  x: attributedReviewedCampaignUrl(
    "https://www.0xzaps.com/agent-kit",
    AGENT_KIT_MARKETING_CAMPAIGN_ID,
    "x",
  ),
} as const;

const LEARN_HUB_ATTRIBUTED_URLS = {
  discord: attributedReviewedCampaignUrl(
    "https://www.0xzaps.com/learn",
    LEARN_HUB_MARKETING_CAMPAIGN_ID,
    "discord",
  ),
  x: attributedReviewedCampaignUrl(
    "https://www.0xzaps.com/learn",
    LEARN_HUB_MARKETING_CAMPAIGN_ID,
    "x",
  ),
} as const;

const SHARE_ZAP_DESIGN_ATTRIBUTED_URLS = {
  discord: attributedReviewedCampaignUrl(
    "https://www.0xzaps.com/zap?view=design",
    SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    "discord",
  ),
  x: attributedReviewedCampaignUrl(
    "https://www.0xzaps.com/zap?view=design",
    SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    "x",
  ),
} as const;

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
    id: LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
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
    id: LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
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
    id: FEE_REWARDS_MARKETING_CAMPAIGN_ID,
    channel: "x",
    queueOrder: 22,
    notBefore: "2026-08-03T00:23:00.000Z",
    notAfter: "2026-08-10T00:23:00.000Z",
    body:
      "0xZAPS fee campaign is active from Aug 3 00:23 UTC until Aug 10 00:23 UTC; claims until Sep 9 00:23 UTC.\n\n50/100 tokenized fee shares fund it. Stake: 0xZAPS. Rewards: WETH. Holding alone grants no fee rights.\n\nhttps://www.0xzaps.com/rewards\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/rewards"],
    topics: ["token", "trading"],
    disclosures: ["pre_audit"],
    claims: FEE_REWARDS_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: FEE_REWARDS_FACTS,
    canonicalSourceUrls: FEE_REWARDS_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "69c67b003586adec1309b417161b967d4ff3003b26a208bfec29ea705082c749",
  },
  {
    id: FEE_REWARDS_MARKETING_CAMPAIGN_ID,
    channel: "discord",
    queueOrder: 23,
    notBefore: "2026-08-03T00:23:00.000Z",
    notAfter: "2026-08-10T00:23:00.000Z",
    body:
      "**0xZAPS fee campaign — active from Aug 3 00:23 UTC until Aug 10 00:23 UTC; claims until Sep 9 00:23 UTC (2026).**\n\nThis separate campaign is funded with 50 of 100 tokenized Clanker fee shares. Stake principal is 0xZAPS. The campaign reward asset is WETH only, allocated by time-weighted stake; no payout amount is promised.\n\nHolding 0xZAPS alone grants no fee rights. Inspect the current phase, principal, exact contracts, and deadlines before acting:\nhttps://www.0xzaps.com/rewards\n\nThese contracts have not been externally audited. Pre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/rewards"],
    topics: ["token", "trading"],
    disclosures: ["pre_audit"],
    claims: FEE_REWARDS_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: FEE_REWARDS_FACTS,
    canonicalSourceUrls: FEE_REWARDS_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "1c8588ed3256b2802a2dc2510f77df1d7a48ee59ccaf382ff22508008a22abf3",
  },
  {
    id: LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
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
    id: LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
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
  {
    id: LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    channel: "discord",
    queueOrder: 40,
    notBefore: "2026-08-07T14:00:00.000Z",
    body:
      "**Share a Zap design—not wallet authority.**\n\nOpenZaps can encode a designed chain into a `?d=` link. When someone opens it, the builder validates the design against the current typed-block catalog and recompiles the result. Design mode does not prompt for wallet access, approval, a signature, or a transaction.\n\nA link may carry a live-route design or a design-only blueprint. The receiver still has to review which bounds the selected lineage enforces; any live action requires their own wallet review and signature.\n\nBuild and review:\nhttps://www.0xzaps.com/zap?view=design\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/zap?view=design"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: SHARE_ZAP_DESIGN_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: SHARE_ZAP_DESIGN_FACTS,
    canonicalSourceUrls: SHARE_ZAP_DESIGN_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "d36350d80f73d71b56c269cb29fe58088db8e74b258d3c75302dc9858e75ab88",
  },
  {
    id: LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    channel: "x",
    queueOrder: 41,
    notBefore: "2026-08-10T14:00:00.000Z",
    body:
      "Share a Zap design—not wallet authority.\n\nA link carries a design into the builder. It is validated and recompiled without a wallet prompt, signature, or transaction.\n\nBuild and review:\nhttps://www.0xzaps.com/zap?view=design\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com/zap?view=design"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: SHARE_ZAP_DESIGN_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: SHARE_ZAP_DESIGN_FACTS,
    canonicalSourceUrls: SHARE_ZAP_DESIGN_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "7f28715d95af94e6b99a72c1581172e1c1d030570b39c67a11909d1eeaeefc38",
  },
  {
    id: AGENT_KIT_MARKETING_CAMPAIGN_ID,
    channel: "discord",
    queueOrder: 120,
    notBefore: "2026-08-03T14:00:00.000Z",
    body:
      `**The OpenZaps Agent Kit is published.**\n\n\`@openzaps/sdk@0.1.0\` compiles the exact policy tuple and prepares unsigned EIP-712 data. \`@openzaps/mcp@0.1.0\` gives agent clients read-only capsule discovery. Both releases carry npm provenance attestations.\n\nNeither package holds a key, signs, or broadcasts. Your wallet or Safe creates authority; the signed intent and immutable Zap policy set the bounds.\n\nConnect an agent: ${AGENT_KIT_ATTRIBUTED_URLS.discord}\n\nPre-audit software. Verify before use.`,
    links: [AGENT_KIT_ATTRIBUTED_URLS.discord],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: AGENT_KIT_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: AGENT_KIT_FACTS,
    canonicalSourceUrls: AGENT_KIT_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "9fcbfdbf84d79274c27dac26479aaf0560e7434cbb6614b0e90d976fb0af39dc",
  },
  {
    id: AGENT_KIT_MARKETING_CAMPAIGN_ID,
    channel: "x",
    queueOrder: 121,
    notBefore: "2026-08-05T14:00:00.000Z",
    body:
      `OpenZaps Agent Kit is live.\n\nSDK: bounded policies. MCP: read-only discovery. No keys, signing, or broadcasting.\n\n${AGENT_KIT_ATTRIBUTED_URLS.x}\n\nPre-audit software. Verify before use.`,
    links: [AGENT_KIT_ATTRIBUTED_URLS.x],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: AGENT_KIT_X_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: AGENT_KIT_X_FACTS,
    canonicalSourceUrls: AGENT_KIT_X_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "7abff834112caf333811d11ff2291915179029d704c41b1b6f386a4ea64438e7",
  },
  {
    id: LEARN_HUB_MARKETING_CAMPAIGN_ID,
    channel: "x",
    queueOrder: 130,
    notBefore: "2026-08-04T14:00:00.000Z",
    body:
      `OpenZaps Learn is live.\n\nSource-reviewed updates + RSS-confirmed DeFi Tutorials. Drafts stay out until confirmed.\n\n${LEARN_HUB_ATTRIBUTED_URLS.x}\n\nPre-audit software. Verify before use.`,
    links: [LEARN_HUB_ATTRIBUTED_URLS.x],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: LEARN_HUB_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: LEARN_HUB_FACTS,
    canonicalSourceUrls: LEARN_HUB_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "f25701fecbcd1be418a5e97c64a87e3db8ad5c69fc9e4e7677b4b84bb9f3837c",
  },
  {
    id: LEARN_HUB_MARKETING_CAMPAIGN_ID,
    channel: "discord",
    queueOrder: 131,
    notBefore: "2026-08-04T14:00:00.000Z",
    body:
      `**OpenZaps Learn is live.**\n\nThe new hub collects source-reviewed OpenZaps product updates and DeFi Tutorials whose title and canonical URL are RSS-confirmed. Drafts and editor handoffs are withheld from the Learn catalog until RSS confirmation.\n\nUse it to follow what shipped, read why the bounds matter, or request a human-reviewed authority map for one workflow:\n${LEARN_HUB_ATTRIBUTED_URLS.discord}\n\nPre-audit software. Verify before use.`,
    links: [LEARN_HUB_ATTRIBUTED_URLS.discord],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: LEARN_HUB_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: LEARN_HUB_FACTS,
    canonicalSourceUrls: LEARN_HUB_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "3e919b5a929225399ff4dc444f89079a6a65a1abb6dc3a9fe89fc09bfa73d646",
  },
  {
    id: SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    channel: "discord",
    queueOrder: 140,
    notBefore: "2026-08-07T14:00:00.000Z",
    body:
      `**Share a Zap design—not wallet authority.**\n\nOpenZaps can encode a designed chain into a \`?d=\` link. When someone opens it, the builder validates the design against the current typed-block catalog and recompiles the result. Design mode does not prompt for wallet access, approval, a signature, or a transaction.\n\nA link may carry a live-route design or a design-only blueprint. The receiver still has to review which bounds the selected lineage enforces; any live action requires their own wallet review and signature.\n\nBuild and review:\n${SHARE_ZAP_DESIGN_ATTRIBUTED_URLS.discord}\n\nPre-audit software. Verify before use.`,
    links: [SHARE_ZAP_DESIGN_ATTRIBUTED_URLS.discord],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: SHARE_ZAP_DESIGN_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: SHARE_ZAP_DESIGN_FACTS,
    canonicalSourceUrls: SHARE_ZAP_DESIGN_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "e4a832a26c0cd79787c77829bbf2a54529fb696588df1899570492df0ae461d5",
  },
  {
    id: SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    channel: "x",
    queueOrder: 141,
    notBefore: "2026-08-10T14:00:00.000Z",
    body:
      `Share a Zap design—not wallet authority.\n\nValidated in builder. No wallet prompt, signature, or transaction.\n\n${SHARE_ZAP_DESIGN_ATTRIBUTED_URLS.x}\n\nPre-audit software. Verify before use.`,
    links: [SHARE_ZAP_DESIGN_ATTRIBUTED_URLS.x],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: SHARE_ZAP_DESIGN_CLAIMS,
    flags: SAFE_FLAGS,
    requiredFacts: SHARE_ZAP_DESIGN_FACTS,
    canonicalSourceUrls: SHARE_ZAP_DESIGN_FACTS.map((fact) => fact.sourceUrl),
    contentHash:
      "4be6f92cd4047cb149d5a03257773d472c035fe613a91746215a25224c2ad392",
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
  `${LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID}:discord`,
  `${LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID}:x`,
  `${LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID}:x`,
  `${LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID}:discord`,
  `${LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID}:discord`,
  `${LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID}:x`,
  `${AGENT_KIT_MARKETING_CAMPAIGN_ID}:discord`,
  `${AGENT_KIT_MARKETING_CAMPAIGN_ID}:x`,
  `${LEARN_HUB_MARKETING_CAMPAIGN_ID}:x`,
  `${LEARN_HUB_MARKETING_CAMPAIGN_ID}:discord`,
  `${SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID}:discord`,
  `${SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID}:x`,
]);

const REVIEW_ONLY_CAMPAIGNS = new Set([
  `${FEE_REWARDS_MARKETING_CAMPAIGN_ID}:x`,
  `${FEE_REWARDS_MARKETING_CAMPAIGN_ID}:discord`,
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
    ...(campaign.notAfter === undefined
      ? {}
      : {
          notAfter:
            campaign.notAfter === null
              ? null
              : new Date(campaign.notAfter).toISOString(),
        }),
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

/** Financial/token artifacts stay owner-review-only even when source-exact. */
export function reviewedMarketingCampaignIsReviewOnly(
  campaignId: string,
  channel: ScheduledMarketingChannel,
): boolean {
  return REVIEW_ONLY_CAMPAIGNS.has(`${campaignId}:${channel}`);
}

/**
 * Source-only artifacts for an owner to inspect and copy into a manual post.
 * These entries are deliberately absent from the durable cron queue and this
 * accessor never claims a schedule slot or starts a workflow.
 */
export function reviewOnlyMarketingCampaigns(): ReviewedMarketingCampaign[] {
  return CAMPAIGNS.filter((campaign) =>
    REVIEW_ONLY_CAMPAIGNS.has(`${campaign.id}:${campaign.channel}`),
  ).map(cloneCampaign);
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
  const afterStart = campaign.notBefore === null
    || evaluatedAt >= Date.parse(campaign.notBefore);
  const beforeEnd = campaign.notAfter === undefined
    || campaign.notAfter === null
    || evaluatedAt < Date.parse(campaign.notAfter);
  return afterStart && beforeEnd;
}

/** Return only review-only artifacts inside their exact publication window. */
export function availableReviewOnlyMarketingCampaigns(
  now: string,
): ReviewedMarketingCampaign[] {
  return reviewOnlyMarketingCampaigns().filter((campaign) =>
    reviewedMarketingCampaignIsAvailable(
      campaign.id,
      campaign.channel,
      now,
    ),
  );
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
    ...(campaign.notAfter === undefined
      ? {}
      : {
          notAfter:
            campaign.notAfter === null
              ? null
              : new Date(campaign.notAfter).toISOString(),
        }),
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
