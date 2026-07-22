import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { SiteNav } from "@/components/SiteNav";
import { SiteFooter } from "@/components/SiteFooter";
import { JsonLd } from "@/components/JsonLd";
import { LINKS, TOKEN, TOKEN_LAUNCH, X_HANDLE } from "@/lib/config";
import {
  SITE_URL,
  SITE_NAME,
  DEFAULT_TITLE,
  DEFAULT_DESCRIPTION,
  SEO_KEYWORDS,
  OG_IMAGE,
  absoluteUrl,
} from "@/lib/seo";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  category: "finance",
  creator: SITE_NAME,
  publisher: SITE_NAME,
  keywords: SEO_KEYWORDS,
  alternates: { canonical: "/" },
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
        alt: `${SITE_NAME} — $${TOKEN.symbol} live on ${TOKEN_LAUNCH.venue}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
    creator: X_HANDLE,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: [OG_IMAGE],
  },
  icons: {
    icon: [{ url: "/openzap-mark.svg", type: "image/svg+xml" }],
    shortcut: ["/openzap-mark.svg"],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
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

export const viewport: Viewport = {
  colorScheme: "dark",
};

const siteGraph = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl("/openzap-mark.svg"),
      },
      sameAs: [LINKS.github, LINKS.x],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: DEFAULT_DESCRIPTION,
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: "en",
    },
    {
      "@type": "Product",
      "@id": `${SITE_URL}/#token`,
      name: `${TOKEN.name} (${TOKEN.symbol})`,
      alternateName: `$${TOKEN.symbol}`,
      description: `${TOKEN.symbol} is the OpenZaps community and operator coordination token, live on ${TOKEN_LAUNCH.venue} on ${TOKEN_LAUNCH.network}.`,
      url: TOKEN_LAUNCH.tradeUrl,
      brand: { "@id": `${SITE_URL}/#organization` },
      additionalProperty: [
        { "@type": "PropertyValue", name: "Contract address", value: TOKEN_LAUNCH.contract },
        { "@type": "PropertyValue", name: "Network", value: TOKEN_LAUNCH.network },
        { "@type": "PropertyValue", name: "Launch venue", value: TOKEN_LAUNCH.venue },
      ],
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      <body>
        <JsonLd data={siteGraph} />
        <a href="#main" className="skipLink">
          Skip to content
        </a>
        <SiteNav />
        {children}
        <SiteFooter />
        <Analytics />
      </body>
    </html>
  );
}
