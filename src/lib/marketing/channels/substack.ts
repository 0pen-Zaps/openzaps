import "server-only";

import {
  ChannelAdapterError,
  assertIdempotencyKey,
  providerError,
  safelyFetch,
  type ChannelFetch,
} from "./shared";
import {
  canonicalSubstackPostUrl,
  normalizeSubstackTitle,
  prepareSubstackRichText,
} from "../substack-handoff";

export const DEFITUTORIALS_PUBLICATION_URL =
  "https://defitutorials.substack.com";
export const DEFITUTORIALS_EDITOR_URL =
  "https://defitutorials.substack.com/publish/post";
export const DEFITUTORIALS_FEED_URL =
  "https://defitutorials.substack.com/feed";

const SUBSTACK_TITLE_MAX = 200;
const SUBSTACK_SUBTITLE_MAX = 300;
const SUBSTACK_MARKDOWN_MAX = 250_000;
const SUBSTACK_TAG_MAX = 32;
const SUBSTACK_TAGS_MAX = 5;
const SUBSTACK_FEED_MAX_BYTES = 2_000_000;
const SUBSTACK_FEED_MAX_ITEMS = 100;
const SUBSTACK_FEED_ID_MAX = 2_048;
const SUBSTACK_FEED_TITLE_MAX = 500;

export interface SubstackTutorialDraft {
  title: string;
  subtitle?: string;
  bodyMarkdown: string;
  tags?: string[];
  idempotencyKey: string;
}

export interface SubstackEditorHandoff {
  channel: "substack";
  status: "requires-human-publish";
  editorUrl: string;
  publicationUrl: string;
  idempotencyKey: string;
  apiWriteAttempted: false;
  privateEndpointUsed: false;
  draft: {
    title: string;
    subtitle?: string;
    /** Immutable reviewed source retained for audit and revision. */
    bodyMarkdown: string;
    /** Derived, sanitized editor copy. Never sent to Substack by this adapter. */
    bodyHtml: string;
    bodyPlainText: string;
    tags: string[];
  };
}

export interface SubstackFeedPost {
  id: string;
  title: string;
  url: string;
  publishedAt?: string;
  description?: string;
  author?: string;
}

export interface SubstackFeedResult {
  channel: "substack";
  feedUrl: string;
  idempotencyKey: string;
  notModified: boolean;
  posts: SubstackFeedPost[];
  etag?: string;
  lastModified?: string;
}

export interface SubstackFeedInput {
  idempotencyKey: string;
  etag?: string;
  lastModified?: string;
}

export interface SubstackFeedDependencies {
  fetchImpl?: ChannelFetch;
  nowMs?: number;
}

export type SubstackPublicationVerificationStatus =
  | "rss_confirmed"
  | "not_found"
  | "title_mismatch";

export interface SubstackPublicationVerification {
  channel: "substack";
  status: SubstackPublicationVerificationStatus;
  canonicalUrl: string;
  approvedTitle: string;
  feedUrl: string;
  checkedAt: string;
  publishedAt?: string;
  /** A schema change is still required before this receipt can be appended. */
  persisted: false;
}

export interface SubstackPublicationVerificationInput {
  canonicalUrl: string;
  approvedTitle: string;
}

function assertDraftText(
  value: string | undefined,
  maximum: number,
  label: string,
  required: boolean,
): void {
  if (value === undefined) {
    if (!required) return;
    throw new ChannelAdapterError(
      "substack",
      "invalid-input",
      `${label} must be 1-${maximum} characters.`,
    );
  }
  if ((required && !value.trim()) || Array.from(value).length > maximum) {
    throw new ChannelAdapterError(
      "substack",
      "invalid-input",
      `${label} must be ${required ? "1-" : "at most "}${maximum} characters.`,
    );
  }
}

/**
 * Substack has no supported public write API. This produces an auditable,
 * copy-ready package for a human to publish in the official editor.
 */
export function createSubstackEditorHandoff(
  input: SubstackTutorialDraft,
): SubstackEditorHandoff {
  assertIdempotencyKey("substack", input.idempotencyKey);
  assertDraftText(input.title, SUBSTACK_TITLE_MAX, "Substack title", true);
  assertDraftText(
    input.subtitle,
    SUBSTACK_SUBTITLE_MAX,
    "Substack subtitle",
    false,
  );
  if (
    !input.bodyMarkdown.trim() ||
    input.bodyMarkdown.length > SUBSTACK_MARKDOWN_MAX
  ) {
    throw new ChannelAdapterError(
      "substack",
      "invalid-input",
      `Substack bodyMarkdown must be 1-${SUBSTACK_MARKDOWN_MAX} characters.`,
    );
  }
  const tags = input.tags ?? [];
  if (
    tags.length > SUBSTACK_TAGS_MAX ||
    tags.some(
      (tag) =>
        !tag.trim() ||
        Array.from(tag).length > SUBSTACK_TAG_MAX ||
        /[\r\n]/.test(tag),
    )
  ) {
    throw new ChannelAdapterError(
      "substack",
      "invalid-input",
      `Substack supports up to ${SUBSTACK_TAGS_MAX} non-empty tags of ${SUBSTACK_TAG_MAX} characters.`,
    );
  }
  const richText = prepareSubstackRichText(input.bodyMarkdown);

  return {
    channel: "substack",
    status: "requires-human-publish",
    editorUrl: DEFITUTORIALS_EDITOR_URL,
    publicationUrl: DEFITUTORIALS_PUBLICATION_URL,
    idempotencyKey: input.idempotencyKey,
    apiWriteAttempted: false,
    privateEndpointUsed: false,
    draft: {
      title: input.title.trim(),
      ...(input.subtitle?.trim() ? { subtitle: input.subtitle.trim() } : {}),
      bodyMarkdown: input.bodyMarkdown,
      bodyHtml: richText.html,
      bodyPlainText: richText.plainText,
      tags: tags.map((tag) => tag.trim()),
    },
  };
}

function decodeXmlEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    (entity, encoded: string) => {
      if (encoded[0] !== "#") return entities[encoded.toLowerCase()] ?? entity;
      const radix = encoded[1]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? encoded.slice(2) : encoded.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      try {
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      } catch {
        return entity;
      }
    },
  );
}

function unwrapXmlText(value: string): string {
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return decodeXmlEntities(cdata ? cdata[1] : value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlElement(block: string, name: string): string | undefined {
  const match = block.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"),
  );
  return match?.[1];
}

function validSubstackPostUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const canonical = canonicalSubstackPostUrl(url.toString());
    if (canonical) return canonical;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "open.substack.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) return undefined;
    const match = url.pathname.match(
      /^\/pub\/defitutorials\/p\/([a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?)\/?$/u,
    );
    return match?.[1]
      ? `https://defitutorials.substack.com/p/${match[1]}`
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseSubstackRss(xml: string): SubstackFeedPost[] {
  const trimmedXml = xml.trim();
  const root = trimmedXml.match(/<(rss|feed)\b[^>]*>/iu)?.[1];
  if (
    !trimmedXml ||
    xml.length > SUBSTACK_FEED_MAX_BYTES ||
    !root ||
    !new RegExp(`<\\/${root}>\\s*$`, "iu").test(trimmedXml) ||
    (root.toLowerCase() === "rss"
      && !/<channel\b[^>]*>[\s\S]*<\/channel>\s*<\/rss>\s*$/iu.test(
        trimmedXml,
      ))
  ) {
    throw new ChannelAdapterError(
      "substack",
      "invalid-response",
      "Substack returned an invalid feed.",
    );
  }

  const blocks = Array.from(xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi))
    .slice(0, SUBSTACK_FEED_MAX_ITEMS)
    .map((match) => match[1]);
  const posts: SubstackFeedPost[] = [];
  const seenUrls = new Set<string>();

  for (const block of blocks) {
    const rawTitle = xmlElement(block, "title");
    const rawLink = xmlElement(block, "link");
    const title = rawTitle ? unwrapXmlText(rawTitle) : "";
    const url = rawLink ? validSubstackPostUrl(unwrapXmlText(rawLink)) : undefined;
    if (!title || !url) continue;

    const rawGuid = xmlElement(block, "guid");
    const id = rawGuid ? unwrapXmlText(rawGuid) : url;
    if (
      !id ||
      id.length > SUBSTACK_FEED_ID_MAX ||
      title.length > SUBSTACK_FEED_TITLE_MAX ||
      seenUrls.has(url)
    ) {
      continue;
    }

    const rawPublishedAt = xmlElement(block, "pubDate");
    const publishedMs = rawPublishedAt
      ? Date.parse(unwrapXmlText(rawPublishedAt))
      : Number.NaN;
    const rawDescription = xmlElement(block, "description");
    const rawAuthor =
      xmlElement(block, "dc:creator") ?? xmlElement(block, "author");

    seenUrls.add(url);
    posts.push({
      id,
      title,
      url,
      ...(Number.isFinite(publishedMs)
        ? { publishedAt: new Date(publishedMs).toISOString() }
        : {}),
      ...(rawDescription
        ? { description: unwrapXmlText(rawDescription).slice(0, 1_000) }
        : {}),
      ...(rawAuthor ? { author: unwrapXmlText(rawAuthor) } : {}),
    });
  }

  return posts;
}

async function readBoundedFeed(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let xml = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > SUBSTACK_FEED_MAX_BYTES) {
        await reader.cancel();
        throw new ChannelAdapterError(
          "substack",
          "invalid-response",
          "Substack returned an invalid feed.",
          { status: response.status },
        );
      }
      xml += decoder.decode(value, { stream: true });
    }
    xml += decoder.decode();
    return xml;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchSubstackFeed(
  input: SubstackFeedInput,
  dependencies: SubstackFeedDependencies = {},
): Promise<SubstackFeedResult> {
  assertIdempotencyKey("substack", input.idempotencyKey);
  const headers: Record<string, string> = {
    accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
  };
  if (input.etag && !/[\r\n]/.test(input.etag)) {
    headers["if-none-match"] = input.etag;
  }
  if (
    input.lastModified &&
    !/[\r\n]/.test(input.lastModified) &&
    Number.isFinite(Date.parse(input.lastModified))
  ) {
    headers["if-modified-since"] = input.lastModified;
  }

  const response = await safelyFetch(
    "substack",
    dependencies.fetchImpl ?? fetch,
    DEFITUTORIALS_FEED_URL,
    {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
    },
  );
  if (response.status === 304) {
    return {
      channel: "substack",
      feedUrl: DEFITUTORIALS_FEED_URL,
      idempotencyKey: input.idempotencyKey,
      notModified: true,
      posts: [],
      ...(response.headers.get("etag")
        ? { etag: response.headers.get("etag") as string }
        : {}),
      ...(response.headers.get("last-modified")
        ? { lastModified: response.headers.get("last-modified") as string }
        : {}),
    };
  }
  if (!response.ok) {
    throw providerError("substack", response, dependencies.nowMs);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > SUBSTACK_FEED_MAX_BYTES
  ) {
    throw new ChannelAdapterError(
      "substack",
      "invalid-response",
      "Substack returned an invalid feed.",
      { status: response.status },
    );
  }
  const xml = await readBoundedFeed(response);
  const posts = parseSubstackRss(xml);
  return {
    channel: "substack",
    feedUrl: DEFITUTORIALS_FEED_URL,
    idempotencyKey: input.idempotencyKey,
    notModified: false,
    posts,
    ...(response.headers.get("etag")
      ? { etag: response.headers.get("etag") as string }
      : {}),
    ...(response.headers.get("last-modified")
      ? { lastModified: response.headers.get("last-modified") as string }
      : {}),
  };
}

/**
 * Read-only publication verification against the public DeFi Tutorials RSS.
 * It neither calls a Substack write endpoint nor mutates the delivery ledger.
 */
export async function verifySubstackPublication(
  input: SubstackPublicationVerificationInput,
  dependencies: SubstackFeedDependencies = {},
): Promise<SubstackPublicationVerification> {
  const canonicalUrl = canonicalSubstackPostUrl(input.canonicalUrl);
  const approvedTitle = normalizeSubstackTitle(input.approvedTitle);
  if (!canonicalUrl || !approvedTitle) {
    throw new ChannelAdapterError(
      "substack",
      "invalid-input",
      "A canonical DeFi Tutorials post URL and approved title are required.",
    );
  }

  const checkedAt = new Date(dependencies.nowMs ?? Date.now()).toISOString();
  const feed = await fetchSubstackFeed(
    { idempotencyKey: "verify:defitutorials-publication" },
    dependencies,
  );
  const post = feed.posts.find(
    (candidate) => canonicalSubstackPostUrl(candidate.url) === canonicalUrl,
  );
  if (!post) {
    return {
      channel: "substack",
      status: "not_found",
      canonicalUrl,
      approvedTitle,
      feedUrl: DEFITUTORIALS_FEED_URL,
      checkedAt,
      persisted: false,
    };
  }

  const status = normalizeSubstackTitle(post.title) === approvedTitle
    ? "rss_confirmed"
    : "title_mismatch";
  return {
    channel: "substack",
    status,
    canonicalUrl,
    approvedTitle,
    feedUrl: DEFITUTORIALS_FEED_URL,
    checkedAt,
    ...(status === "rss_confirmed" && post.publishedAt
      ? { publishedAt: post.publishedAt }
      : {}),
    persisted: false,
  };
}
