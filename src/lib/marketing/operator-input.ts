import { normalizeMarketingSourceUrl } from "@/lib/marketing/source-url";

const MARKETING_RUN_ID = /^[^\s/\\]{1,200}$/u;

export function parseMarketingSourceUrls(raw: string): string[] {
  const candidates = raw
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  return candidates.map(normalizeMarketingSourceUrl);
}

/**
 * A workflow run id may be linked from the private review notification.
 * Credentials are never accepted from query parameters.
 */
export function marketingRunIdFromSearch(search: string): string {
  const runId = new URLSearchParams(search).get("run") ?? "";
  return MARKETING_RUN_ID.test(runId) ? runId : "";
}
