import type { Metadata } from "next";
import { TOKEN, TOKEN_LAUNCH, CHAIN, X_HANDLE } from "@/lib/config";

// Canonical production origin. www is canonical: 0xzaps.com 308-redirects to www.0xzaps.com.
// Hardcoded so production and preview builds never emit a *.vercel.app canonical.
export const SITE_URL = "https://www.0xzaps.com";

export const SITE_NAME = "OpenZaps";
export const OG_IMAGE = "/og.png";

type StaticPageSeo = {
  title: string;
  description: string;
  path: string;
  ogImage: string;
  changeFrequency: "daily" | "weekly" | "monthly";
  priority: number;
};

/**
 * Single source of truth for indexable routes. Route metadata, JSON-LD, sitemap entries, and
 * regression tests all consume this map so titles, canonicals, and crawl discovery cannot drift.
 *
 * Indexable is the whole membership test: `/profile` and `/solderworks` set
 * `robots: { index: false }` in their own metadata, so they are deliberately absent here and
 * therefore absent from the sitemap. The app shell's sidebar carries its own link list — that is
 * navigation, not crawl discovery — so a route can legitimately appear in one and not the other.
 */
export const STATIC_PAGE_SEO = {
  home: {
    title: "Bounded DeFi Zaps for Agents",
    description:
      "Compose bounded DeFi Zaps whose supported hops settle atomically after required approval, creation, and funding confirmations. Live on Robinhood Chain.",
    path: "/",
    ogImage: OG_IMAGE,
    changeFrequency: "weekly",
    priority: 1,
  },
  zap: {
    title: "Build Bounded DeFi Zaps",
    description:
      "Design, simulate, sign, and run bounded DeFi Zaps on Robinhood Chain. Supported route hops and settlement execute atomically after required setup confirmations.",
    path: "/zap",
    ogImage: "/og/app.png",
    changeFrequency: "weekly",
    priority: 0.95,
  },
  explore: {
    title: "Explore DeFi Zaps on Robinhood Chain",
    description:
      "Explore verified Zaps — the immutable policy capsules the factory deploys — with owners, routes, execution history, and lifecycle read from Robinhood Chain.",
    path: "/explore",
    ogImage: OG_IMAGE,
    changeFrequency: "daily",
    priority: 0.9,
  },
  docs: {
    title: "DeFi Zap Developer Docs & Security",
    description:
      "Build with OpenZaps: policy schemas, EIP-712 intents, simulation APIs, execution lifecycle, smart contract controls, threat model, and security status.",
    path: "/docs",
    ogImage: "/og/docs.png",
    changeFrequency: "weekly",
    priority: 0.85,
  },
  agentKit: {
    title: "Agent Kit for Bounded DeFi Automation",
    description:
      "Connect AI agents to OpenZaps with a read-only MCP server and SDK that prepares exact policy and unsigned EIP-712 artifacts without signing or broadcasting.",
    path: "/agent-kit",
    ogImage: "/og/docs.png",
    changeFrequency: "weekly",
    priority: 0.85,
  },
  learn: {
    title: "OpenZaps Tutorials & Product Updates",
    description:
      "Read verified OpenZaps product updates and RSS-confirmed DeFi Tutorials, then request a human-reviewed authority map for your own bounded workflow.",
    path: "/learn",
    ogImage: "/og/docs.png",
    changeFrequency: "weekly",
    priority: 0.75,
  },
  requestZap: {
    title: "Request a Bounded DeFi Zap",
    description:
      "Submit one DeFi workflow for a human-reviewed policy sketch covering targets, assets, triggers, limits, and agent authority—without sharing wallet secrets.",
    path: "/request-a-zap",
    ogImage: OG_IMAGE,
    changeFrequency: "weekly",
    priority: 0.9,
  },
  roadmap: {
    title: "Executable DeFi Intelligence Roadmap",
    description:
      "See how OpenZaps plans to turn bounded Zaps into agent skills, funded requests, contribution rewards, reproducible competitions, and safer strategies.",
    path: "/roadmap",
    ogImage: "/og/roadmap.png",
    changeFrequency: "monthly",
    priority: 0.65,
  },
  evals: {
    title: "OpenZaps Release Evals & Executor Scorecards",
    description:
      "Inspect reproducible OpenZaps release checks and receipt-backed executor scorecards, with explicit evidence scope, coverage limits, and no delegated authority.",
    path: "/evals",
    ogImage: "/og/docs.png",
    changeFrequency: "weekly",
    priority: 0.7,
  },
  token: {
    title: `${TOKEN.symbol} Token: Contract, Utility & Market`,
    description:
      `Verify the ${TOKEN.symbol} token contract, utility, ${TOKEN_LAUNCH.venue} market, and ${CHAIN.name} details. Ownership alone grants no automatic revenue, equity, or fee right.`,
    path: "/token",
    ogImage: "/og/token.png",
    changeFrequency: "weekly",
    priority: 0.8,
  },
  rewards: {
    title: "0xZAPS Fee Rewards Campaign",
    description:
      "Stake 0xZAPS in a fixed seven-day campaign and claim a proportional share of WETH accounted by its tokenized Clanker fee campaign.",
    path: "/rewards",
    ogImage: "/og/token.png",
    changeFrequency: "daily",
    priority: 0.85,
  },
  pot: {
    title: "0xZAPS Automation Fee Pot",
    description:
      "Inspect the OpenZaps automation fee pot, live 0xZAPS conversion balance, participant credits, prize rounds, and source-backed onchain evidence.",
    path: "/pot",
    ogImage: "/og/app.png",
    changeFrequency: "daily",
    priority: 0.7,
  },
  virtualTrading: {
    title: "Virtual DeFi Trading for Agents",
    description:
      "Practice 0xZAPS and aeWETH routes with 10,000 virtual USDG, canonical Robinhood Chain quotes, and a browser-local ledger—no wallet or real funds.",
    path: "/virtual-trading",
    ogImage: "/og/app.png",
    changeFrequency: "daily",
    priority: 0.75,
  },
  legal: {
    title: "Security Risks & Token Disclosures",
    description:
      `Review OpenZaps smart contract, wallet, execution, and ${TOKEN.symbol} token risks before using the live ${CHAIN.name} protocol. The contracts are unaudited.`,
    path: "/legal",
    ogImage: "/og/legal.png",
    changeFrequency: "monthly",
    priority: 0.55,
  },
} as const satisfies Record<string, StaticPageSeo>;

export const HOME_FAQS = [
  {
    question: "What is a DeFi zap?",
    answer:
      "A DeFi zap packages multiple supported protocol steps into one wallet transaction. OpenZaps executes only routes backed by allowlisted adapters and tokens; approval, Zap creation, and funding can require separate wallet confirmations.",
  },
  {
    question: "Does every OpenZap require only one transaction?",
    answer:
      "The bounded route executes its protocol hops and settlement atomically in one transaction after setup. Token approval, Zap creation, and funding can each require a separate wallet confirmation.",
  },
  {
    question: "Can an AI agent change my OpenZap policy?",
    answer:
      "No. The user wallet or Safe creates the authority and signs the policy. An eligible executor can submit only the transaction permitted by those immutable targets, assets, recipients, amounts, calldata constraints, and deadlines.",
  },
  {
    question: "How can an owner stop or recover from an intent?",
    answer:
      "Recovery is lineage-specific. Live v1.1, v3, and v3.1 owners can invalidate unused signed authority and use the supported emergency-exit path for tracked assets; the v3.2 deployed candidate additionally exposes a one-way permanent policy halt. No control can undo a confirmed execution.",
  },
  {
    question: "Does OpenZaps support every DeFi protocol?",
    answer:
      "No. Live execution is limited to source-backed routes whose adapters and tokens are explicitly allowlisted. Additional protocols require reviewed adapters and tests before they can carry funds.",
  },
  {
    question: "Are OpenZaps contracts externally audited?",
    answer:
      "No external audit is currently published for the live OpenZaps contracts. The software is pre-audit, deposited funds are at risk, and onchain actions are irreversible.",
  },
] as const;

export function brandedTitle(title: string): string {
  return title.endsWith(`| ${SITE_NAME}`) ? title : `${title} | ${SITE_NAME}`;
}

export const DEFAULT_TITLE = brandedTitle(STATIC_PAGE_SEO.home.title);
export const DEFAULT_DESCRIPTION = STATIC_PAGE_SEO.home.description;

export const SEO_KEYWORDS = [
  "OpenZaps",
  "DeFi zaps",
  "one-transaction DeFi",
  "DeFi intent execution",
  "agent DeFi infrastructure",
  "bounded DeFi automation",
  "onchain intents",
  "DeFi workflow builder",
  TOKEN.symbol,
  `${TOKEN.symbol} token`,
  "0xzaps.com",
  TOKEN_LAUNCH.venue,
  `${TOKEN_LAUNCH.venue} ${TOKEN_LAUNCH.version}`,
  TOKEN_LAUNCH.network,
  "policy capsules",
  "EIP-712 intents",
  "ERC-1271",
  "immutable zaps",
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
  const socialTitle = brandedTitle(title);
  return {
    title,
    description,
    keywords: [...new Set([...SEO_KEYWORDS, ...keywords])],
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
      images: [{ url: absoluteUrl(ogImage), width: 1200, height: 630, alt: socialTitle }],
    },
  };
}

/** Schema.org WebPage node shared by every indexable route. */
export function webPageJsonLd({
  title,
  description,
  path,
  ogImage = OG_IMAGE,
  type = "WebPage",
}: Pick<StaticPageSeo, "title" | "description" | "path"> & {
  ogImage?: string;
  type?: "WebPage" | "CollectionPage";
}): object {
  const url = absoluteUrl(path);
  return {
    "@type": type,
    "@id": absoluteUrl(`${path}#webpage`),
    url,
    name: brandedTitle(title),
    description,
    inLanguage: "en-US",
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    primaryImageOfPage: {
      "@type": "ImageObject",
      url: absoluteUrl(ogImage),
      width: 1200,
      height: 630,
    },
    ...(path === "/" ? {} : { breadcrumb: { "@id": absoluteUrl(`${path}#breadcrumbs`) } }),
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
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
