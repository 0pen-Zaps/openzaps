import type { Metadata } from "next";
import { TOKEN, CHAIN } from "@/lib/config";

// Canonical production origin. www is canonical: 0xzaps.com 308-redirects to www.0xzaps.com.
// Hardcoded default so canonicals never regress to a *.vercel.app alias when the env var is
// missing at build time; NEXT_PUBLIC_SITE_URL remains the override for previews.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.0xzaps.com").replace(/\/+$/, "");

export const SITE_NAME = "OpenZaps";
export const OG_IMAGE = "/og.png";

export const DEFAULT_TITLE = `OpenZaps — ${TOKEN.symbol} launching on pool.fans`;

export const DEFAULT_DESCRIPTION =
  `OpenZaps are immutable, ERC-20-first intent lockers for agent-triggered DeFi on ${CHAIN.name}. ` +
  `${TOKEN.symbol} is launching fair on the pool.fans tokenizer — bounded onchain automation with no discretionary wallet authority.`;

export const SEO_KEYWORDS = [
  "OpenZaps",
  TOKEN.symbol,
  `${TOKEN.symbol} token`,
  "0xzaps.com",
  "pool.fans",
  "pool.fans tokenizer",
  "fair launch token",
  "Base token launch",
  "DeFi automation",
  "onchain automation",
  "Hermes agent",
  "EIP-712 intents",
  "ERC-1271",
  "immutable zaps",
  "intent lockers",
  CHAIN.name,
];

export function absoluteUrl(path = ""): string {
  if (path.startsWith("http")) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${normalized === "/" ? "" : normalized}` || SITE_URL;
}

/**
 * Route-level metadata with canonical, OpenGraph, and Twitter cards resolved against the
 * canonical production origin. `title` should be bare — the root layout template appends
 * "| OpenZaps" — while OG/Twitter get the fully-suffixed title (templates don't apply there).
 */
export function pageMetadata({
  title,
  description,
  path,
  keywords = [],
}: {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
}): Metadata {
  const url = absoluteUrl(path);
  const socialTitle = `${title} | ${SITE_NAME}`;
  return {
    title,
    description,
    keywords: [...SEO_KEYWORDS, ...keywords],
    alternates: { canonical: url },
    openGraph: {
      title: socialTitle,
      description,
      url,
      siteName: SITE_NAME,
      type: "website",
      locale: "en_US",
      images: [{ url: absoluteUrl(OG_IMAGE), width: 1200, height: 630, alt: socialTitle }],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [absoluteUrl(OG_IMAGE)],
    },
  };
}

/** Serialize JSON-LD safely for a <script type="application/ld+json"> block. */
export function jsonLd(data: object): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
