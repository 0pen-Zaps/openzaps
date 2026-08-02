import type { CapturedAnalyticsAttribution } from "@/lib/analytics";
import {
  normalizeAttributionCampaign,
  normalizeAttributionContent,
  normalizeAttributionMedium,
  normalizeAttributionSource,
} from "@/lib/marketing/campaign-attribution";

export type LeadClientAttribution = Readonly<{
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  entryPoint?: "builder_review";
  landingPath: "/request-a-zap";
}>;

function controlledLeadAttribution(
  attribution: LeadClientAttribution,
): LeadClientAttribution {
  const utmSource = normalizeAttributionSource(attribution.utmSource);
  const utmMedium = normalizeAttributionMedium(attribution.utmMedium);
  const utmCampaign = normalizeAttributionCampaign(attribution.utmCampaign);
  const utmContent = normalizeAttributionContent(attribution.utmContent);
  return {
    ...(utmSource ? { utmSource } : {}),
    ...(utmMedium ? { utmMedium } : {}),
    ...(utmCampaign ? { utmCampaign } : {}),
    ...(utmContent ? { utmContent } : {}),
    ...(attribution.entryPoint === "builder_review"
      ? { entryPoint: "builder_review" as const }
      : {}),
    landingPath: "/request-a-zap",
  };
}

/** Prefer the tab's first controlled touch while preserving the builder CTA. */
export function leadSubmissionAttribution(
  initial: LeadClientAttribution,
  firstTouch: CapturedAnalyticsAttribution | null,
): LeadClientAttribution {
  const normalizedInitial = controlledLeadAttribution(initial);
  if (!firstTouch) return normalizedInitial;
  return controlledLeadAttribution({
    utmSource: firstTouch.source,
    utmMedium: firstTouch.medium,
    utmCampaign: firstTouch.campaign,
    utmContent: firstTouch.content,
    entryPoint: normalizedInitial.entryPoint,
    landingPath: "/request-a-zap",
  });
}

function readString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optional(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

export function privacySafeReferrer(value: string): string | undefined {
  if (!value.startsWith("https://")) return undefined;
  try {
    return new URL(value).origin.slice(0, 500);
  } catch {
    return undefined;
  }
}

export function leadRequestPayload(
  data: FormData,
  attribution: LeadClientAttribution,
  referrer: string,
): Record<string, unknown> {
  return {
    persona: readString(data, "persona"),
    name: readString(data, "name"),
    email: readString(data, "email"),
    project: optional(readString(data, "project")),
    projectUrl: optional(readString(data, "projectUrl")),
    workflow: readString(data, "workflow"),
    protocolsAssets: optional(readString(data, "protocolsAssets")),
    trigger: readString(data, "trigger"),
    guardrails: readString(data, "guardrails"),
    timeline: readString(data, "timeline"),
    consent: data.get("consent") === "on",
    // Keep the legacy API key until old clients have aged out, but never source
    // it from a browser control that password managers or form fillers can
    // populate behind the user's back.
    website: "",
    attribution: {
      ...attribution,
      referrer: privacySafeReferrer(referrer),
    },
  };
}
