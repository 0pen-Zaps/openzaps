export const LEAD_REVIEW_TARGET_BUSINESS_DAYS = 2 as const;
export const LEAD_REVIEW_TIME_ZONE = "America/New_York" as const;
export const LEAD_SCORECARD_MAX_ROWS = 100 as const;

const ROLLING_DAY_MS = 24 * 60 * 60 * 1_000;
const ATTRIBUTION_GROUP_LIMIT = 12;

const ATTRIBUTION_SOURCES = new Set([
  "discord",
  "farcaster",
  "github",
  "homepage",
  "newsletter",
  "openzaps",
  "rss",
  "substack",
  "x",
]);
const ATTRIBUTION_CAMPAIGNS = new Set([
  "agent_kit",
  "learn_hub",
  "product_update",
  "request_a_zap",
  "tutorial_update",
  "virtual-trading",
]);
const ATTRIBUTION_CONTENT = new Set([
  "agent_kit",
  "app_nav",
  "builder_review",
  "developer_section",
  "docs_release",
  "execution_demo",
  "feed_update",
  "final_cta",
  "hero",
  "homepage_recent",
  "landing_footer",
  "learn_hub",
  "nav",
  "request_form",
  "request_success",
  "site_footer",
  "tutorial",
  "virtual_trading",
]);
const ATTRIBUTION_META_BUCKETS = new Set(["not_set", "other", "remaining"]);

type LeadStatus = "new" | "contacted" | "qualified" | "closed";

type LeadReviewInput = Readonly<{
  qualificationScore: number;
  status: LeadStatus;
  createdAt: string;
}>;

export type LeadScorecardInput = LeadReviewInput & Readonly<{
  attribution: Readonly<Record<string, unknown>>;
}>;

export type LeadReviewSla = Readonly<{
  dueAt: string;
  state: "within_target" | "overdue";
  targetBusinessDays: typeof LEAD_REVIEW_TARGET_BUSINESS_DAYS;
  timeZone: typeof LEAD_REVIEW_TIME_ZONE;
  calendar: "weekdays_only_no_holidays";
}>;

export type LeadScorecardWindow = Readonly<{
  accepted: number;
  score3Plus: number;
  progressed: number;
  currentQualified: number;
}>;

export type LeadScorecardAttribution = Readonly<{
  source: string;
  campaign: string;
  content: string;
  accepted: number;
  score3Plus: number;
  currentQualified: number;
}>;

export type LeadScorecard = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  scope: Readonly<{
    basis: "accepted_requests_onward";
    population: "nonexpired_stored_requests";
    selection: "qualification_score_desc_then_created_at_desc";
    maxRows: typeof LEAD_SCORECARD_MAX_ROWS;
    returnedRows: number;
    truncated: boolean;
    complete: boolean;
  }>;
  windows: Readonly<{
    days7: LeadScorecardWindow;
    days30: LeadScorecardWindow;
  }>;
  overdueReviewCount: number;
  stages: Readonly<Record<LeadStatus, number>>;
  attribution: readonly LeadScorecardAttribution[];
}>;

type CalendarDate = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

const DATE_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: LEAD_REVIEW_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const DATE_TIME_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: LEAD_REVIEW_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function numericPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const raw = parts.find((part) => part.type === type)?.value ?? "";
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Could not resolve ${type} in the lead-review timezone.`);
  }
  return value;
}

function calendarDateAt(instant: Date): CalendarDate {
  const parts = DATE_PARTS_FORMATTER.formatToParts(instant);
  return {
    year: numericPart(parts, "year"),
    month: numericPart(parts, "month"),
    day: numericPart(parts, "day"),
  };
}

function addCalendarDays(date: CalendarDate, amount: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function weekday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addBusinessDays(date: CalendarDate, amount: number): CalendarDate {
  let current = date;
  let remaining = amount;
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    const day = weekday(current);
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return current;
}

function zonedEndOfDay(date: CalendarDate): number {
  const targetUtcShape = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    23,
    59,
    59,
    999,
  );
  let candidate = targetUtcShape;

  // Converge from a UTC-shaped wall clock to the equivalent instant in the
  // review timezone. Two passes cover both standard and daylight offsets.
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = DATE_TIME_PARTS_FORMATTER.formatToParts(new Date(candidate));
    const observedUtcShape = Date.UTC(
      numericPart(parts, "year"),
      numericPart(parts, "month") - 1,
      numericPart(parts, "day"),
      numericPart(parts, "hour"),
      numericPart(parts, "minute"),
      numericPart(parts, "second"),
      999,
    );
    const correction = targetUtcShape - observedUtcShape;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

export function leadReviewDueAt(createdAt: string): string | null {
  const submittedAt = new Date(createdAt);
  if (!Number.isFinite(submittedAt.valueOf())) return null;
  const dueDate = addBusinessDays(
    calendarDateAt(submittedAt),
    LEAD_REVIEW_TARGET_BUSINESS_DAYS,
  );
  return new Date(zonedEndOfDay(dueDate)).toISOString();
}

export function leadReviewSla(
  lead: LeadReviewInput,
  now = new Date(),
): LeadReviewSla | null {
  if (
    lead.qualificationScore < 3
    || lead.status !== "new"
    || !Number.isFinite(now.valueOf())
  ) return null;
  const dueAt = leadReviewDueAt(lead.createdAt);
  if (!dueAt) return null;
  return {
    dueAt,
    state: now.valueOf() > Date.parse(dueAt) ? "overdue" : "within_target",
    targetBusinessDays: LEAD_REVIEW_TARGET_BUSINESS_DAYS,
    timeZone: LEAD_REVIEW_TIME_ZONE,
    calendar: "weekdays_only_no_holidays",
  };
}

export function sortLeadsForReview<T extends LeadReviewInput>(
  leads: readonly T[],
  now = new Date(),
): T[] {
  return [...leads].sort((left, right) => {
    const leftSla = leadReviewSla(left, now);
    const rightSla = leadReviewSla(right, now);
    const leftRank = leftSla?.state === "overdue"
      ? 0
      : leftSla
        ? 1
        : 2;
    const rightRank = rightSla?.state === "overdue"
      ? 0
      : rightSla
        ? 1
        : 2;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftSla && rightSla) {
      const dueOrder = Date.parse(leftSla.dueAt) - Date.parse(rightSla.dueAt);
      if (dueOrder !== 0) return dueOrder;
    }
    if (left.qualificationScore !== right.qualificationScore) {
      return right.qualificationScore - left.qualificationScore;
    }
    return Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
}

function emptyWindow(): LeadScorecardWindow {
  return {
    accepted: 0,
    score3Plus: 0,
    progressed: 0,
    currentQualified: 0,
  };
}

function windowCounts(
  leads: readonly LeadScorecardInput[],
  earliest: number,
): LeadScorecardWindow {
  return leads.reduce<LeadScorecardWindow>((counts, lead) => {
    const createdAt = Date.parse(lead.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < earliest) return counts;
    return {
      accepted: counts.accepted + 1,
      score3Plus: counts.score3Plus + (lead.qualificationScore >= 3 ? 1 : 0),
      progressed: counts.progressed + (lead.status === "new" ? 0 : 1),
      currentQualified:
        counts.currentQualified + (lead.status === "qualified" ? 1 : 0),
    };
  }, emptyWindow());
}

function normalizedDimension(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function campaignBucket(value: unknown): string {
  const normalized = normalizedDimension(value);
  if (!normalized) return "not_set";
  if (ATTRIBUTION_CAMPAIGNS.has(normalized)) return normalized;
  if (normalized.startsWith("openzaps-")) return "product_update";
  if (normalized.startsWith("defitutorials-")) return "tutorial_update";
  return "other";
}

function contentBucket(value: unknown): string {
  const normalized = normalizedDimension(value);
  if (!normalized) return "not_set";
  return ATTRIBUTION_CONTENT.has(normalized) ? normalized : "other";
}

export function leadScorecardAttributionDimensionIsValid(
  kind: "source" | "campaign" | "content",
  value: string,
): boolean {
  if (ATTRIBUTION_META_BUCKETS.has(value)) return true;
  if (kind === "source") return ATTRIBUTION_SOURCES.has(value);
  if (kind === "campaign") return ATTRIBUTION_CAMPAIGNS.has(value);
  return ATTRIBUTION_CONTENT.has(value);
}

function safeSource(attribution: LeadScorecardInput["attribution"]): string {
  const explicit = normalizedDimension(attribution.utmSource);
  if (explicit) return ATTRIBUTION_SOURCES.has(explicit) ? explicit : "other";
  if (typeof attribution.referrer !== "string") return "not_set";
  try {
    const hostname = new URL(attribution.referrer).hostname.toLowerCase();
    if (["x.com", "twitter.com", "t.co"].includes(hostname)) return "x";
    if (["discord.com", "discord.gg"].includes(hostname)) return "discord";
    if (hostname === "defitutorials.substack.com" || hostname === "substack.com") {
      return "substack";
    }
    if (hostname === "0xzaps.com" || hostname === "www.0xzaps.com") {
      return "openzaps";
    }
  } catch {
    return "other";
  }
  return "other";
}

function attributionRows(
  leads: readonly LeadScorecardInput[],
  earliest: number,
): LeadScorecardAttribution[] {
  const groups = new Map<string, LeadScorecardAttribution>();
  for (const lead of leads) {
    const createdAt = Date.parse(lead.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < earliest) continue;
    const source = safeSource(lead.attribution);
    const campaign = campaignBucket(lead.attribution.utmCampaign);
    const content = contentBucket(lead.attribution.utmContent);
    const key = JSON.stringify([source, campaign, content]);
    const current = groups.get(key) ?? {
      source,
      campaign,
      content,
      accepted: 0,
      score3Plus: 0,
      currentQualified: 0,
    };
    groups.set(key, {
      ...current,
      accepted: current.accepted + 1,
      score3Plus: current.score3Plus + (lead.qualificationScore >= 3 ? 1 : 0),
      currentQualified:
        current.currentQualified + (lead.status === "qualified" ? 1 : 0),
    });
  }
  const sorted = [...groups.values()]
    .sort((left, right) =>
      right.accepted - left.accepted
      || right.score3Plus - left.score3Plus
      || left.source.localeCompare(right.source)
      || left.campaign.localeCompare(right.campaign)
      || left.content.localeCompare(right.content));
  if (sorted.length <= ATTRIBUTION_GROUP_LIMIT) return sorted;
  const visible = sorted.slice(0, ATTRIBUTION_GROUP_LIMIT - 1);
  const remaining = sorted.slice(ATTRIBUTION_GROUP_LIMIT - 1).reduce(
    (total, row) => ({
      source: "remaining",
      campaign: "remaining",
      content: "remaining",
      accepted: total.accepted + row.accepted,
      score3Plus: total.score3Plus + row.score3Plus,
      currentQualified: total.currentQualified + row.currentQualified,
    }),
    {
      source: "remaining",
      campaign: "remaining",
      content: "remaining",
      accepted: 0,
      score3Plus: 0,
      currentQualified: 0,
    },
  );
  return [...visible, remaining];
}

export function buildLeadScorecard(
  leads: readonly LeadScorecardInput[],
  now = new Date(),
): LeadScorecard {
  if (!Number.isFinite(now.valueOf())) {
    throw new Error("A valid scorecard timestamp is required.");
  }
  const bounded = leads.slice(0, LEAD_SCORECARD_MAX_ROWS);
  const nowMs = now.valueOf();
  const stages: Record<LeadStatus, number> = {
    new: 0,
    contacted: 0,
    qualified: 0,
    closed: 0,
  };
  let overdueReviewCount = 0;
  for (const lead of bounded) {
    stages[lead.status] += 1;
    if (leadReviewSla(lead, now)?.state === "overdue") {
      overdueReviewCount += 1;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    scope: {
      basis: "accepted_requests_onward",
      population: "nonexpired_stored_requests",
      selection: "qualification_score_desc_then_created_at_desc",
      maxRows: LEAD_SCORECARD_MAX_ROWS,
      returnedRows: bounded.length,
      truncated: bounded.length === LEAD_SCORECARD_MAX_ROWS,
      complete: bounded.length < LEAD_SCORECARD_MAX_ROWS,
    },
    windows: {
      days7: windowCounts(bounded, nowMs - 7 * ROLLING_DAY_MS),
      days30: windowCounts(bounded, nowMs - 30 * ROLLING_DAY_MS),
    },
    overdueReviewCount,
    stages,
    attribution: attributionRows(bounded, nowMs - 30 * ROLLING_DAY_MS),
  };
}
