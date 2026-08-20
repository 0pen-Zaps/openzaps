import tutorialManifestJson from "../../../docs/tutorials/manifest.json";

import { createHash } from "node:crypto";

import {
  OPENZAPS_FEED_ITEMS,
  type OpenZapsFeedItem,
} from "@/lib/marketing/feed";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";
import {
  normalizeConfirmedTutorialManifest,
  normalizeWithheldTutorialTitles,
} from "@/lib/marketing/tutorial-publication";

const OPENZAPS_ORIGIN = "https://www.0xzaps.com";
const X_SHARE_INTENT = "https://x.com/intent/post";
const MAX_PUBLIC_ITEMS = 200;
const MAX_PUBLIC_SUMMARY_LENGTH = 500;
const MAX_X_SHARE_TEXT_LENGTH = 220;

export type PublicContentKind = "product_update" | "tutorial";

export interface PublicContentItem {
  id: string;
  kind: PublicContentKind;
  title: string;
  summary: string;
  canonicalUrl: string;
  publishedAt: string;
  sourceLabel: "OpenZaps" | "DeFi Tutorials";
  external: boolean;
}

export interface PublicContentShareTargets {
  copyUrl: string;
  xIntentUrl: string;
}

export class PublicContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicContentError";
  }
}

function canonicalOpenZapsUrl(raw: string): string {
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
      throw new PublicContentError("OpenZaps update URL is not canonical.");
    }
    url.pathname = url.pathname === "/"
      ? "/"
      : url.pathname.replace(/\/$/u, "");
    return url.toString();
  } catch (error) {
    if (error instanceof PublicContentError) throw error;
    throw new PublicContentError("OpenZaps update URL is invalid.");
  }
}

function boundedText(value: string, label: string, max: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    !normalized
    || Array.from(normalized).length > max
    || containsCredentialLikeData(normalized)
  ) {
    throw new PublicContentError(`${label} is invalid.`);
  }
  return normalized;
}

function isoTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || value.length > 40) {
    throw new PublicContentError(`${label} is invalid.`);
  }
  return new Date(timestamp).toISOString();
}

function attributedShareUrl(
  item: PublicContentItem,
  source: "openzaps" | "x",
  medium: "referral" | "social",
): string {
  const url = new URL(item.canonicalUrl);
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", medium);
  url.searchParams.set(
    "utm_campaign",
    item.kind === "tutorial" ? "tutorial_update" : "product_update",
  );
  url.searchParams.set("utm_content", "learn_hub");
  return url.toString();
}

function boundedXShareText(item: PublicContentItem): string {
  const suffix = item.kind === "tutorial"
    ? " — DeFi Tutorials via @0xzaps"
    : " — OpenZaps via @0xzaps";
  const titleBudget = MAX_X_SHARE_TEXT_LENGTH - Array.from(suffix).length;
  const title = Array.from(item.title).slice(0, titleBudget).join("");
  return `${title}${suffix}`;
}

/**
 * Prepare explicit, user-confirmed distribution links for one verified public
 * item. These links open an X composer or copy a tracked URL; they never post.
 */
export function publicContentShareTargets(
  item: PublicContentItem,
): PublicContentShareTargets {
  const xIntent = new URL(X_SHARE_INTENT);
  xIntent.searchParams.set("text", boundedXShareText(item));
  xIntent.searchParams.set("url", attributedShareUrl(item, "x", "social"));

  return {
    copyUrl: attributedShareUrl(item, "openzaps", "referral"),
    xIntentUrl: xIntent.toString(),
  };
}

/**
 * Build the public, search-indexable content catalog from reviewed sources.
 * The tutorial parser deliberately excludes drafts and prepared handoffs.
 */
export function publicContentCatalog(
  manifest: unknown = tutorialManifestJson,
  feedItems: readonly OpenZapsFeedItem[] = OPENZAPS_FEED_ITEMS,
): PublicContentItem[] {
  const confirmedTutorials = normalizeConfirmedTutorialManifest(manifest);
  if (feedItems.length + confirmedTutorials.length > MAX_PUBLIC_ITEMS) {
    throw new PublicContentError("Public content catalog exceeds its item bound.");
  }

  const items: PublicContentItem[] = [
    ...feedItems.map((item) => ({
      id: `openzaps:${boundedText(item.id, "OpenZaps update id", 200)}`,
      kind: "product_update" as const,
      title: boundedText(item.title, "OpenZaps update title", 200),
      summary: boundedText(
        item.description,
        "OpenZaps update description",
        MAX_PUBLIC_SUMMARY_LENGTH,
      ),
      canonicalUrl: canonicalOpenZapsUrl(item.url),
      publishedAt: isoTimestamp(item.publishedAt, "OpenZaps update publishedAt"),
      sourceLabel: "OpenZaps" as const,
      external: false,
    })),
    ...confirmedTutorials.map((tutorial) => ({
      id: `defitutorials:${tutorial.id}`,
      kind: "tutorial" as const,
      title: tutorial.title,
      summary:
        "Read the source-reviewed walkthrough on DeFi Tutorials. Verify every bound before using real funds.",
      canonicalUrl: tutorial.canonicalUrl,
      publishedAt: tutorial.publishedAt,
      sourceLabel: "DeFi Tutorials" as const,
      external: true,
    })),
  ];

  if (
    new Set(items.map((item) => item.id)).size !== items.length
    || new Set(items.map((item) => item.canonicalUrl)).size !== items.length
  ) {
    throw new PublicContentError("Public content entries must be unique.");
  }

  return items.sort(
    (left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
      || left.id.localeCompare(right.id),
  );
}

export const PUBLIC_CONTENT_ITEMS = Object.freeze(publicContentCatalog());

export const PUBLIC_CONTENT_CATALOG_DIGEST = createHash("sha256")
  .update(JSON.stringify(PUBLIC_CONTENT_ITEMS))
  .digest("hex");

export const NON_PUBLIC_TUTORIAL_TITLES = Object.freeze(
  normalizeWithheldTutorialTitles(tutorialManifestJson),
);
