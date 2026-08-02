export type LeadClientAttribution = Readonly<{
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  entryPoint?: "builder_review";
  landingPath: "/request-a-zap";
}>;

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
    website: readString(data, "website"),
    attribution: {
      ...attribution,
      referrer: privacySafeReferrer(referrer),
    },
  };
}
