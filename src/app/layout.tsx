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

const title = `OpenZaps — ${TOKEN.symbol} launching on pool.fans`;
const description = `OpenZaps are immutable, ERC-20-first intent lockers for agent-triggered DeFi. ${TOKEN.symbol} is launching on pool.fans — bounded onchain automation with no discretionary wallet authority.`;

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
    "token launch",
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
