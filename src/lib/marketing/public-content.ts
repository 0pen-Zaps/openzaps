import tutorialManifestJson from "../../../docs/tutorials/manifest.json";

import {
  OPENZAPS_FEED_ITEMS,
  type OpenZapsFeedItem,
} from "@/lib/marketing/feed";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";
import { normalizeConfirmedTutorialManifest } from "@/lib/marketing/tutorial-publication";

const OPENZAPS_ORIGIN = "https://www.0xzaps.com";
const MAX_PUBLIC_ITEMS = 200;
const MAX_PUBLIC_SUMMARY_LENGTH = 500;

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
        "Read the source-reviewed walkthrough on DeFi Tutorials. OpenZaps remains pre-audit; verify every bound before using real funds.",
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
