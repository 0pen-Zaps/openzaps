import type { Metadata, Viewport } from "next";
import { DM_Sans, JetBrains_Mono, Newsreader } from "next/font/google";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { Spotlight } from "@/components/Spotlight";
import { MotionControl } from "@/components/MotionControl";
import { JsonLd } from "@/components/JsonLd";
import { ThemeProvider } from "@/components/ThemeProvider";
import { WalletProvider } from "@/components/WalletProvider";
import { LINKS, TOKEN, TOKEN_LAUNCH, X_HANDLE } from "@/lib/config";
import { MOTION_STORAGE_KEY } from "@/lib/motion-preference";
import { DEFAULT_THEME, THEME_BG, THEME_GUARD, THEME_SCHEME } from "@/lib/theme";
import {
  SITE_URL,
  SITE_NAME,
  DEFAULT_TITLE,
  DEFAULT_DESCRIPTION,
  SEO_KEYWORDS,
  OG_IMAGE,
  absoluteUrl,
} from "@/lib/seo";

/**
 * Three families, three jobs.
 *
 * Newsreader carries screen titles and section headings; DM Sans carries
 * everything else; JetBrains Mono keeps every number, address and hash, as it
 * did before. Inter is gone.
 *
 * The variables are named by ROLE, not by typeface — `--font-sans`, not
 * `--font-dm-sans` — so the next change of mind is one line here instead of a
 * find-and-replace across forty stylesheets. globals.css maps the two former
 * names onto these, because an unresolved font variable does not warn: it
 * silently falls through to system sans and the page just looks slightly off.
 */
const newsreader = Newsreader({
  variable: "--font-serif",
  subsets: ["latin"],
  display: "swap",
});

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

const GOOGLE_SITE_VERIFICATION = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION;
const BING_SITE_VERIFICATION = process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  category: "finance",
  classification: "DeFi intent and execution infrastructure",
  authors: [{ name: "Nodar Janashia", url: `${SITE_URL}/#founder` }],
  creator: "Nodar Janashia",
  publisher: SITE_NAME,
  keywords: SEO_KEYWORDS,
  alternates: {
    canonical: "/",
    types: {
      "application/rss+xml": "/feed.xml",
    },
  },
  openGraph: {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: "/",
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: DEFAULT_TITLE,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
    creator: X_HANDLE,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: [{ url: OG_IMAGE, alt: DEFAULT_TITLE }],
  },
  icons: {
    icon: [{ url: "/openzap-mark.svg", type: "image/svg+xml" }],
    shortcut: ["/openzap-mark.svg"],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
  verification: {
    ...(GOOGLE_SITE_VERIFICATION ? { google: GOOGLE_SITE_VERIFICATION } : {}),
    ...(BING_SITE_VERIFICATION ? { other: { "msvalidate.01": BING_SITE_VERIFICATION } } : {}),
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

/**
 * The pre-JS answer, and it is not a guess: a visitor with nothing stored gets
 * DEFAULT_THEME whatever their OS prefers, so this is simply that theme's own
 * `--bg`. Keying it off `prefers-color-scheme` instead would paint a light
 * chrome band above a black page for every light-OS first-timer.
 *
 * The real, per-theme value is written client-side by ThemeProvider once the
 * picked theme is known — metadata cannot know which of five was chosen.
 * `manifest.webmanifest` carries its own `theme_color`; an installed PWA keeps
 * whatever that says.
 */
export const viewport: Viewport = {
  colorScheme: THEME_SCHEME[DEFAULT_THEME],
  themeColor: THEME_BG[DEFAULT_THEME],
};

const siteGraph = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      logo: {
        "@type": "ImageObject",
        "@id": `${SITE_URL}/#logo`,
        url: absoluteUrl("/icon-512.png"),
        contentUrl: absoluteUrl("/icon-512.png"),
        width: 512,
        height: 512,
      },
      founder: { "@id": `${SITE_URL}/#founder` },
      sameAs: [
        LINKS.x,
        LINKS.farcaster,
        LINKS.discord,
        LINKS.substack,
        "https://github.com/0pen-Zaps/openzaps",
        TOKEN_LAUNCH.tradeUrl,
      ],
    },
    {
      "@type": "Person",
      "@id": `${SITE_URL}/#founder`,
      name: "Nodar Janashia",
      url: `${SITE_URL}/#founder`,
      sameAs: ["https://github.com/nodar", "https://warpcast.com/nodes", "https://x.com/NodarJ"],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: DEFAULT_DESCRIPTION,
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: "en-US",
      potentialAction: {
        "@type": "SearchAction",
        target: `${SITE_URL}/explore/{search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "Product",
      "@id": `${SITE_URL}/#token`,
      name: `${TOKEN.name} (${TOKEN.symbol})`,
      alternateName: `$${TOKEN.symbol}`,
      description: `${TOKEN.symbol} is the ERC-20 paired with aeWETH in OpenZaps' first bounded live route, live on ${TOKEN_LAUNCH.network} through ${TOKEN_LAUNCH.venue}.`,
      url: absoluteUrl("/token"),
      image: absoluteUrl(TOKEN.logoPath),
      category: "Cryptocurrency",
      sku: TOKEN_LAUNCH.contract,
      brand: { "@id": `${SITE_URL}/#organization` },
      sameAs: [LINKS.clanker, LINKS.dexscreener, LINKS.tokenExplorer],
      additionalProperty: [
        { "@type": "PropertyValue", name: "Contract address", value: TOKEN_LAUNCH.contract },
        { "@type": "PropertyValue", name: "Network", value: TOKEN_LAUNCH.network },
        { "@type": "PropertyValue", name: "Chain ID", value: TOKEN_LAUNCH.chainId },
        { "@type": "PropertyValue", name: "Launch venue", value: TOKEN_LAUNCH.venue },
        { "@type": "PropertyValue", name: "Decimals", value: TOKEN.decimals },
        { "@type": "PropertyValue", name: "Total supply", value: TOKEN.totalSupply },
        { "@type": "PropertyValue", name: "Dexscreener market", value: LINKS.dexscreener },
      ],
    },
  ],
};

/**
 * Decides, before the LINES overlay is painted, whether its intro plays.
 *
 * This has to run ahead of first paint rather than from an effect. The overlay
 * is an opaque full-viewport panel, so hiding it after the first paint would
 * flash black on every repeat visit — a strobe worse than the intro it is
 * suppressing. A `beforeInteractive` script is the only placement Next
 * supports for that, and Next only honours it in the root layout, which is why
 * a rule about the home page lives here and gates itself on the pathname.
 *
 * `?intro` forces a replay: a once-per-session intro is otherwise nearly
 * impossible to demo to anyone.
 *
 * Storage access throws outright in some embedded and hardened-privacy
 * contexts. The right failure there is a replayed intro, not a page that dies
 * before rendering, hence the blanket catch.
 */
const INTRO_GUARD = `(function(){try{
if(location.pathname!=="/")return;
var k="oz-intro-seen";
if(new URLSearchParams(location.search).has("intro")){sessionStorage.setItem(k,"1");return}
if(sessionStorage.getItem(k)){document.documentElement.dataset.introSeen="1";return}
sessionStorage.setItem(k,"1")}catch(e){}})()`;

/**
 * Resolve the saved/OS motion preference before first paint. CSS and every
 * JS-driven motion component consume the resulting `data-motion` value, so a
 * Calm visit never flashes a cinematic first frame while React hydrates.
 */
const MOTION_GUARD = `(function(){try{
var reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
var saved=null;try{saved=localStorage.getItem("${MOTION_STORAGE_KEY}")}catch(e){}
document.documentElement.dataset.motion=(reduced||saved==="calm")?"calm":"cinematic"
}catch(e){document.documentElement.dataset.motion="calm"}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    // The guard script above stamps `data-intro-seen` onto this element before
    // React hydrates, so the live DOM legitimately carries an attribute the
    // server never rendered. Without this, React reports that difference as a
    // hydration mismatch on every repeat visit.
    <html
      lang="en-US"
      className={`${dmSans.variable} ${newsreader.variable} ${jetBrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="search" type="application/opensearchdescription+xml" href="/opensearch.xml" title={SITE_NAME} />
        <link rel="alternate" type="text/plain" href="/llms.txt" title={`${SITE_NAME} for AI systems`} />
      </head>
      <body>
        {/* First, before either of the others: the theme decides what colour
            everything else is painted, and Voltage flashing on an Ivory
            visitor is worse than having no themes at all. */}
        <Script id="theme-guard" strategy="beforeInteractive">
          {THEME_GUARD}
        </Script>
        <Script id="motion-guard" strategy="beforeInteractive">
          {MOTION_GUARD}
        </Script>
        <Script id="intro-guard" strategy="beforeInteractive">
          {INTRO_GUARD}
        </Script>
        <JsonLd data={siteGraph} />
        <a href="#main" className="skipLink">
          Skip to content
        </a>
        <ThemeProvider>
          <WalletProvider>{children}</WalletProvider>
        </ThemeProvider>
        <Spotlight />
        <MotionControl />
        <Analytics />
      </body>
    </html>
  );
}
