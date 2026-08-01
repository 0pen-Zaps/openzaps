import {
  canonicalSubstackPostUrl,
  normalizeSubstackTitle,
} from "@/lib/marketing/substack-handoff";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";

const MAX_TUTORIALS = 100;
const MAX_TUTORIAL_ID_LENGTH = 200;
const TUTORIAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PUBLICATION_URL = "https://defitutorials.substack.com";
const FEED_URL = "https://defitutorials.substack.com/feed";

export interface ConfirmedTutorialPublication {
  id: string;
  title: string;
  canonicalUrl: string;
  publishedAt: string;
}

export class TutorialPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TutorialPublicationError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function confirmedId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > MAX_TUTORIAL_ID_LENGTH
    || !TUTORIAL_ID.test(value)
  ) {
    throw new TutorialPublicationError("Confirmed tutorial id is invalid.");
  }
  return value;
}

function confirmedTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40) {
    throw new TutorialPublicationError(
      "Confirmed tutorial publishedAt must be a bounded ISO timestamp.",
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TutorialPublicationError(
      "Confirmed tutorial publishedAt must be a valid ISO timestamp.",
    );
  }
  return new Date(timestamp).toISOString();
}

function tutorialManifestEntries(raw: unknown): unknown[] {
  const manifest = record(raw);
  if (
    manifest?.version !== 1
    || manifest.publication !== PUBLICATION_URL
    || manifest.feed !== FEED_URL
    || !Array.isArray(manifest.tutorials)
  ) {
    throw new TutorialPublicationError("Tutorial manifest is invalid.");
  }
  if (manifest.tutorials.length > MAX_TUTORIALS) {
    throw new TutorialPublicationError("Tutorial manifest exceeds its item bound.");
  }
  return manifest.tutorials;
}

/**
 * The source manifest is also the publication boundary. Drafts and prepared
 * editor handoffs remain invisible until a canonical URL and title have been
 * read back from the public DeFi Tutorials RSS feed and recorded as
 * `rss_confirmed`.
 */
export function normalizeConfirmedTutorialManifest(
  raw: unknown,
): ConfirmedTutorialPublication[] {
  const confirmed: ConfirmedTutorialPublication[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const rawTutorial of tutorialManifestEntries(raw)) {
    const tutorial = record(rawTutorial);
    if (!tutorial || tutorial.status !== "rss_confirmed") continue;

    const id = confirmedId(tutorial.id);
    const title = typeof tutorial.title === "string"
      ? normalizeSubstackTitle(tutorial.title)
      : null;
    const canonicalUrl = typeof tutorial.canonicalUrl === "string"
      ? canonicalSubstackPostUrl(tutorial.canonicalUrl)
      : null;
    if (
      !title
      || containsCredentialLikeData(title)
      || !canonicalUrl
      || canonicalUrl !== tutorial.canonicalUrl
    ) {
      throw new TutorialPublicationError(
        "Confirmed tutorial manifest entry is not canonical.",
      );
    }
    if (ids.has(id) || urls.has(canonicalUrl)) {
      throw new TutorialPublicationError(
        "Confirmed tutorial manifest entries must be unique.",
      );
    }

    ids.add(id);
    urls.add(canonicalUrl);
    confirmed.push({
      id,
      title,
      canonicalUrl,
      publishedAt: confirmedTimestamp(tutorial.publishedAt),
    });
  }

  return confirmed.sort(
    (left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
      || left.id.localeCompare(right.id),
  );
}

/**
 * Titles that must never appear on a public catalog until the release manifest
 * records a canonical RSS receipt. This is server-side negative evidence for
 * the automatic launch gate, not public draft content.
 */
export function normalizeWithheldTutorialTitles(raw: unknown): string[] {
  const titles: string[] = [];
  const unique = new Set<string>();
  for (const rawTutorial of tutorialManifestEntries(raw)) {
    const tutorial = record(rawTutorial);
    if (!tutorial || tutorial.status === "rss_confirmed") continue;
    const title = typeof tutorial.title === "string"
      ? normalizeSubstackTitle(tutorial.title)
      : null;
    if (!title || containsCredentialLikeData(title) || unique.has(title)) {
      throw new TutorialPublicationError(
        "Withheld tutorial manifest title is invalid.",
      );
    }
    unique.add(title);
    titles.push(title);
  }
  return titles.sort((left, right) => left.localeCompare(right));
}
