import { createHash } from "node:crypto";

import tutorialManifestJson from "../../../docs/tutorials/manifest.json";

import type { SubstackFeedPost } from "@/lib/marketing/channels/substack";
import { OPENZAPS_FEED_ITEMS } from "@/lib/marketing/feed";
import {
  canonicalSubstackPostUrl,
  normalizeSubstackTitle,
} from "@/lib/marketing/substack-handoff";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";
import { normalizeConfirmedTutorialManifest } from "@/lib/marketing/tutorial-publication";

const SYNDICATION_VERSION = 1 as const;
const MAX_FEED_ITEMS = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_SOURCE_ID_LENGTH = 200;
const MAX_CAMPAIGN_SLUG_LENGTH = 96;
const OPENZAPS_ORIGIN = "https://www.0xzaps.com";
const SAFE_SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/u;

export const SYNDICATION_SOURCES = ["openzaps", "defitutorials"] as const;
export type SyndicationSource = (typeof SYNDICATION_SOURCES)[number];

export const SYNDICATION_CLASSIFICATIONS = [
  "reviewable",
  "needs_classification",
] as const;
export type SyndicationClassification =
  (typeof SYNDICATION_CLASSIFICATIONS)[number];

export interface SyndicationAttributedUrls {
  x: string;
  discord: string;
}

interface SyndicationItemBase {
  /** URL-based, versioned identity used only for discovery deduplication. */
  key: string;
  source: SyndicationSource;
  /** Stable source-local identifier. Substack GUIDs are intentionally ignored. */
  sourceId: string;
  canonicalUrl: string;
  title: string;
  publishedAt: string | null;
  campaignSlug: string;
  /** Deterministic, non-personal attribution for an eventual reviewed draft. */
  attributedUrls: SyndicationAttributedUrls;
}

export interface ReviewableSyndicationItem extends SyndicationItemBase {
  classification: "reviewable";
  draftable: true;
}

export interface UnclassifiedSyndicationItem extends SyndicationItemBase {
  classification: "needs_classification";
  draftable: false;
}

/**
 * Discovery metadata only. Feed descriptions, bodies, authors, and audience
 * data are deliberately absent from this contract.
 */
export type SyndicationItem =
  | ReviewableSyndicationItem
  | UnclassifiedSyndicationItem;

export class SyndicationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyndicationInputError";
  }
}

function normalizedIsoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 40) {
    throw new SyndicationInputError(`${label} must be a bounded ISO timestamp.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new SyndicationInputError(`${label} must be a valid ISO timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function boundedTitle(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new SyndicationInputError(`${label} must be text.`);
  }
  const title = value.trim().replace(/\s+/gu, " ");
  if (!title || Array.from(title).length > MAX_TITLE_LENGTH) {
    throw new SyndicationInputError(
      `${label} must be 1-${MAX_TITLE_LENGTH} characters.`,
    );
  }
  if (containsCredentialLikeData(title)) {
    throw new SyndicationInputError(`${label} contains credential-like data.`);
  }
  return title;
}

function boundedSourceId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > MAX_SOURCE_ID_LENGTH
    || !SAFE_SOURCE_ID.test(value)
  ) {
    throw new SyndicationInputError(`${label} is not a safe source id.`);
  }
  return value;
}

function canonicalOpenZapsUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 240) {
    throw new SyndicationInputError("OpenZaps feed URL is invalid.");
  }
  try {
    const url = new URL(raw);
    if (
      url.origin !== OPENZAPS_ORIGIN
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || !/^\/(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?\/?$/u.test(
        url.pathname,
      )
    ) {
      throw new SyndicationInputError("OpenZaps feed URL is not canonical.");
    }
    url.pathname = url.pathname === "/"
      ? "/"
      : url.pathname.replace(/\/$/u, "");
    return url.toString();
  } catch (error) {
    if (error instanceof SyndicationInputError) throw error;
    throw new SyndicationInputError("OpenZaps feed URL is invalid.");
  }
}

function stableChecksum(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function campaignSlug(
  source: SyndicationSource,
  sourceId: string,
  canonicalUrl: string,
): string {
  // A manifest entry authorizes review; it must not rewrite attribution for an
  // item that discovery already identified by canonical URL. Substack manifest
  // ids can legitimately differ from the public /p/<slug> path.
  const stableSourceId = source === "defitutorials"
    ? new URL(canonicalUrl).pathname.slice("/p/".length)
    : sourceId;
  const base = `${source}-${stableSourceId}`;
  if (base.length <= MAX_CAMPAIGN_SLUG_LENGTH) return base;
  const suffix = stableChecksum(base);
  return `${base.slice(0, MAX_CAMPAIGN_SLUG_LENGTH - suffix.length - 1)}-${suffix}`;
}

function attributedUrl(
  canonicalUrl: string,
  channel: keyof SyndicationAttributedUrls,
  slug: string,
): string {
  const url = new URL(canonicalUrl);
  const values = channel === "x"
    ? {
        utm_source: "x",
        utm_medium: "social",
        utm_campaign: slug,
        utm_content: "feed_update",
      }
    : {
        utm_source: "discord",
        utm_medium: "community",
        utm_campaign: slug,
        utm_content: "feed_update",
      };
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function syndicationAttributedUrls(
  canonicalUrl: string,
  slug: string,
): SyndicationAttributedUrls {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/u.test(slug)) {
    throw new SyndicationInputError("Syndication campaign slug is invalid.");
  }
  let canonical: string | null = null;
  try {
    const url = new URL(canonicalUrl);
    if (url.hostname === "www.0xzaps.com") {
      canonical = canonicalOpenZapsUrl(canonicalUrl);
    } else if (url.hostname === "defitutorials.substack.com") {
      canonical = canonicalSubstackPostUrl(canonicalUrl);
    }
  } catch (error) {
    if (error instanceof SyndicationInputError) throw error;
  }
  if (!canonical || canonical !== canonicalUrl) {
    throw new SyndicationInputError("Syndication canonical URL is invalid.");
  }
  return {
    x: attributedUrl(canonical, "x", slug),
    discord: attributedUrl(canonical, "discord", slug),
  };
}

function baseItem(
  source: SyndicationSource,
  sourceId: string,
  canonicalUrl: string,
  title: string,
  publishedAt: string | null,
): SyndicationItemBase {
  const slug = campaignSlug(source, sourceId, canonicalUrl);
  const key = createHash("sha256")
    .update(`syndication:v${SYNDICATION_VERSION}\0${source}\0${canonicalUrl}`)
    .digest("hex");
  return {
    key,
    source,
    sourceId,
    canonicalUrl,
    title,
    publishedAt,
    campaignSlug: slug,
    attributedUrls: syndicationAttributedUrls(canonicalUrl, slug),
  };
}

const CONFIRMED_TUTORIALS = new Map(
  normalizeConfirmedTutorialManifest(tutorialManifestJson).map((tutorial) => [
    tutorial.canonicalUrl,
    tutorial,
  ]),
);

/** Required public receipts for a safe first-run Substack baseline. */
export const CONFIRMED_TUTORIAL_BASELINE_URLS = Object.freeze(
  [...CONFIRMED_TUTORIALS.keys()].sort(),
);

function sortItems(items: SyndicationItem[]): SyndicationItem[] {
  return items.sort((left, right) => {
    const leftMs = left.publishedAt ? Date.parse(left.publishedAt) : -1;
    const rightMs = right.publishedAt ? Date.parse(right.publishedAt) : -1;
    return rightMs - leftMs || left.key.localeCompare(right.key);
  });
}

function assertNoConflictingDuplicate(
  existing: SyndicationItem,
  candidate: SyndicationItem,
): void {
  if (
    existing.title !== candidate.title
    || existing.publishedAt !== candidate.publishedAt
    || existing.classification !== candidate.classification
  ) {
    throw new SyndicationInputError(
      `Conflicting duplicate syndication item: ${candidate.key}`,
    );
  }
}

/** Normalize the source-controlled, maintainer-approved OpenZaps feed. */
export function normalizeApprovedOpenZapsFeedItems(): SyndicationItem[] {
  if (OPENZAPS_FEED_ITEMS.length > MAX_FEED_ITEMS) {
    throw new SyndicationInputError("OpenZaps feed exceeds its item bound.");
  }
  const items = OPENZAPS_FEED_ITEMS.map((item): ReviewableSyndicationItem => {
    const sourceId = boundedSourceId(item.id, "OpenZaps feed id");
    const canonicalUrl = canonicalOpenZapsUrl(item.url);
    const title = boundedTitle(item.title, "OpenZaps feed title");
    return {
      ...baseItem(
        "openzaps",
        sourceId,
        canonicalUrl,
        title,
        normalizedIsoDate(item.publishedAt, "OpenZaps feed publishedAt"),
      ),
      classification: "reviewable",
      draftable: true,
    };
  });
  if (new Set(items.map((item) => item.key)).size !== items.length) {
    throw new SyndicationInputError("OpenZaps feed contains duplicate URLs.");
  }
  return sortItems(items);
}

/**
 * Normalize public DeFi Tutorials RSS metadata. A post is draftable only when
 * its canonical URL and whitespace-normalized title match one rss_confirmed
 * manifest entry. No RSS body, description, author, or GUID is retained.
 */
export function normalizeSubstackFeedPosts(
  posts: readonly SubstackFeedPost[],
): SyndicationItem[] {
  if (!Array.isArray(posts) || posts.length > MAX_FEED_ITEMS) {
    throw new SyndicationInputError(
      `Substack feed must contain at most ${MAX_FEED_ITEMS} items.`,
    );
  }

  const byKey = new Map<string, SyndicationItem>();
  for (const post of posts) {
    const canonicalUrl = typeof post?.url === "string"
      ? canonicalSubstackPostUrl(post.url)
      : null;
    if (!canonicalUrl) {
      throw new SyndicationInputError(
        "Substack feed item must use a canonical DeFi Tutorials post URL.",
      );
    }
    const urlSourceId = boundedSourceId(
      new URL(canonicalUrl).pathname.slice("/p/".length),
      "Substack post slug",
    );
    const title = normalizeSubstackTitle(
      boundedTitle(post.title, "Substack feed title"),
    );
    if (!title) {
      throw new SyndicationInputError("Substack feed title is invalid.");
    }

    const confirmed = CONFIRMED_TUTORIALS.get(canonicalUrl);
    const isConfirmed = confirmed?.title === title;
    const sourceId = isConfirmed ? confirmed.id : urlSourceId;
    const feedPublishedAt = post.publishedAt === undefined
      ? null
      : normalizedIsoDate(post.publishedAt, "Substack feed publishedAt");
    const candidate: SyndicationItem = isConfirmed
      ? {
          ...baseItem(
            "defitutorials",
            sourceId,
            canonicalUrl,
            confirmed.title,
            feedPublishedAt ?? confirmed.publishedAt,
          ),
          classification: "reviewable",
          draftable: true,
        }
      : {
          ...baseItem(
            "defitutorials",
            sourceId,
            canonicalUrl,
            title,
            feedPublishedAt,
          ),
          classification: "needs_classification",
          draftable: false,
        };
    const existing = byKey.get(candidate.key);
    if (existing) {
      assertNoConflictingDuplicate(existing, candidate);
      continue;
    }
    byKey.set(candidate.key, candidate);
  }
  return sortItems([...byKey.values()]);
}

/** Combine both read-only discovery sources without admitting any delivery. */
export function discoverReviewOnlySyndicationItems(
  substackPosts: readonly SubstackFeedPost[] = [],
): SyndicationItem[] {
  const combined = [
    ...normalizeApprovedOpenZapsFeedItems(),
    ...normalizeSubstackFeedPosts(substackPosts),
  ];
  if (new Set(combined.map((item) => item.key)).size !== combined.length) {
    throw new SyndicationInputError("Syndication sources produced a duplicate key.");
  }
  return sortItems(combined);
}
