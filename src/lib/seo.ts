import type { Metadata } from "next";
import { TOKEN, TOKEN_LAUNCH, CHAIN, X_HANDLE } from "@/lib/config";

// Canonical production origin. www is canonical: 0xzaps.com 308-redirects to www.0xzaps.com.
// Hardcoded default so canonicals never regress to a *.vercel.app alias when the env var is
// missing at build time; NEXT_PUBLIC_SITE_URL remains the override for previews.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.0xzaps.com").replace(/\/+$/, "");

export const SITE_NAME = "OpenZaps";
export const OG_IMAGE = "/og.png";

export const DEFAULT_TITLE = "OpenZaps — bounded onchain execution for agents";

export const DEFAULT_DESCRIPTION =
  "OpenZaps are tightly bounded policy capsules for agent-triggered DeFi: simulate, submit, monitor, and revoke without broad wallet authority. " +
  `${TOKEN.symbol} is live on ${TOKEN_LAUNCH.venue} on ${TOKEN_LAUNCH.network}.`;

export const SEO_KEYWORDS = [
  "OpenZaps",
  TOKEN.symbol,
  `${TOKEN.symbol} token`,
  "0xzaps.com",
  TOKEN_LAUNCH.venue,
  `${TOKEN_LAUNCH.venue} ${TOKEN_LAUNCH.version}`,
  TOKEN_LAUNCH.network,
  TOKEN_LAUNCH.contract,
  "Dexscreener Robinhood Chain",
  "DeFi automation",
  "onchain automation",
  "policy capsules",
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
  ogImage = OG_IMAGE,
}: {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
  /** Route-specific 1200x630 poster under public/; defaults to the site-wide og.png. */
  ogImage?: string;
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
      images: [{ url: absoluteUrl(ogImage), width: 1200, height: 630, alt: socialTitle }],
    },
    twitter: {
      card: "summary_large_image",
      site: X_HANDLE,
      creator: X_HANDLE,
      title: socialTitle,
      description,
      images: [absoluteUrl(ogImage)],
    },
  };
}

/** BreadcrumbList JSON-LD for a subpage; pair with a JsonLd component in the route. */
export function breadcrumbJsonLd(path: string, name: string): object {
  return {
    "@type": "BreadcrumbList",
    "@id": absoluteUrl(`${path}#breadcrumbs`),
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
      { "@type": "ListItem", position: 2, name, item: absoluteUrl(path) },
    ],
  };
}

/** Serialize JSON-LD safely for a <script type="application/ld+json"> block. */
export function jsonLd(data: object): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
