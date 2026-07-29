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

const AUTHORITY_CLAIMS: MarketingClaim[] = [
  {
    text:
      "The immutable Zap policy and owner-signed intent define what may execute.",
    factKeys: ["authority.execution"],
    treatment: "asserted",
  },
  {
    text:
      "An agent may submit a due run but cannot widen its signed execution terms.",
    factKeys: ["authority.submission"],
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
      "Give an agent the trigger, never broad wallet authority. OpenZaps seals recipient, amount, cadence, floor, adapter, asset, and calldata in owner-signed intent. Explore https://www.0xzaps.com\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: AUTHORITY_CLAIMS,
    flags: SAFE_FLAGS,
  },
  discord: {
    id: SCHEDULED_MARKETING_TEMPLATE_ID,
    channel: "discord",
    body:
      "Give an agent the trigger, never broad wallet authority.\n\nOpenZaps turns an owner-signed intent into a sealed policy capsule: recipient, amount, cadence, floor, adapter, asset, and calldata stay bounded. An agent may submit a due run, but it cannot widen those terms.\n\nExplore: https://www.0xzaps.com\n\nPre-audit software. Verify before use.",
    links: ["https://www.0xzaps.com"],
    topics: ["protocol"],
    disclosures: ["pre_audit"],
    claims: AUTHORITY_CLAIMS,
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
