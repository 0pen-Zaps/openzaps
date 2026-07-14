import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SiteNav } from "@/components/SiteNav";
import { SiteFooter } from "@/components/SiteFooter";
import { TOKEN } from "@/lib/config";

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

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://openzaps.vercel.app");

const title = "OpenZaps — bounded onchain execution for agents";
const description =
  "OpenZaps are tightly bounded policy capsules for agent-triggered DeFi: simulate, submit, monitor, and revoke without broad wallet authority.";

const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenZaps",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  url: siteUrl,
  description,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/PreOrder",
  },
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: "%s | OpenZaps",
  },
  description,
  keywords: [
    "OpenZaps",
    TOKEN.symbol,
    "0xZAPS",
    "pool.fans",
    "DeFi automation",
    "Hermes agent",
    "EIP-712 intents",
    "immutable zaps",
    "Base",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    title,
    description,
    url: "/",
    siteName: "OpenZaps",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `OpenZaps — ${TOKEN.symbol} launch` }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
  icons: {
    icon: [{ url: "/openzap-mark.svg", type: "image/svg+xml" }],
    shortcut: ["/openzap-mark.svg"],
  },
  manifest: "/manifest.webmanifest",
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <a href="#main" className="skipLink">
          Skip to content
        </a>
        <SiteNav />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
