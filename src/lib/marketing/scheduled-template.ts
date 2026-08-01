import type {
  MarketingCandidate,
  MarketingClaim,
  MarketingDisclosure,
  MarketingPolicyFlags,
  MarketingTopic,
} from "@/lib/marketing/types";
import { SCHEDULED_MARKETING_TEMPLATE_ID } from "@/lib/marketing/types";

export const SCHEDULED_MARKETING_CHANNELS = ["x", "discord"] as const;

export type ScheduledMarketingChannel =
  (typeof SCHEDULED_MARKETING_CHANNELS)[number];

interface ScheduledMarketingTemplate {
  id: typeof SCHEDULED_MARKETING_TEMPLATE_ID;
  channel: ScheduledMarketingChannel;
  body: string;
  links: string[];
  topics: MarketingTopic[];
  disclosures: MarketingDisclosure[];
  claims: MarketingClaim[];
  flags: MarketingPolicyFlags;
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

const TEMPLATES: Readonly<
  Record<ScheduledMarketingChannel, ScheduledMarketingTemplate>
> = {
  x: {
    id: SCHEDULED_MARKETING_TEMPLATE_ID,
    channel: "x",
    body:
      "New on OpenZaps:\n\n→ Virtual Trading: paper trades with 10,000 virtual USDG and live read-only quotes. No wallet. No real funds.\n\n→ Request a Zap: submit one workflow to request a human-reviewed authority map.\n\nhttps://www.0xzaps.com\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com"],
    topics: ["simulation", "protocol"],
    disclosures: ["pre_audit"],
    claims: FEATURE_CLAIMS,
    flags: SAFE_FLAGS,
  },
  discord: {
    id: SCHEDULED_MARKETING_TEMPLATE_ID,
    channel: "discord",
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
  },
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function scheduledMarketingTemplate(
  channel: ScheduledMarketingChannel,
): ScheduledMarketingTemplate {
  const template = TEMPLATES[channel];
  return {
    ...template,
    links: [...template.links],
    topics: [...template.topics],
    disclosures: [...template.disclosures],
    claims: template.claims.map((claim) => ({
      ...claim,
      factKeys: [...claim.factKeys],
    })),
    flags: { ...template.flags },
  };
}

/**
 * Automatic delivery is permitted only when every public and policy-relevant
 * candidate field still exactly matches the versioned server template.
 */
export function isScheduledMarketingTemplateCandidate(
  candidate: MarketingCandidate,
  templateId: string,
): boolean {
  if (
    templateId !== SCHEDULED_MARKETING_TEMPLATE_ID ||
    !SCHEDULED_MARKETING_CHANNELS.includes(
      candidate.channel as ScheduledMarketingChannel,
    )
  ) {
    return false;
  }
  const template = TEMPLATES[candidate.channel as ScheduledMarketingChannel];
  return (
    candidate.action === "broadcast" &&
    candidate.kind === "product_update" &&
    candidate.interaction === null &&
    sameJson(candidate.topics, template.topics) &&
    candidate.body === template.body &&
    sameJson(candidate.links, template.links) &&
    sameJson(candidate.disclosures, template.disclosures) &&
    sameJson(candidate.claims, template.claims) &&
    sameJson(candidate.flags, template.flags)
  );
}
