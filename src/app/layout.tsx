import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://openzaps.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "OpenZaps — Immutable intent lockers for agent-triggered DeFi",
    template: "%s | OpenZaps",
  },
  description:
    "OpenZaps are immutable, ERC-20-first policy capsules for bounded Hermes-triggered DeFi execution without discretionary wallet authority.",
  keywords: [
    "OpenZaps",
    "DeFi automation",
    "Hermes agent",
    "EIP-712 intents",
    "ERC-1271",
    "immutable zaps",
    "agent-triggered DeFi",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "OpenZaps — Immutable intent lockers for agent-triggered DeFi",
    description:
      "Narrow policy capsules that let Hermes simulate, submit, monitor, and revoke pre-authorized DeFi workflows.",
    url: "/",
    siteName: "OpenZaps",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenZaps — Immutable intent lockers for agent-triggered DeFi",
    description:
      "Pre-committed, tightly bounded authority for fixed DeFi action graphs triggered by Hermes.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <html lang="en" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
