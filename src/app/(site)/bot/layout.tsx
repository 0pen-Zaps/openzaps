import type { Metadata } from "next";

import { STATIC_PAGE_SEO, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  ...STATIC_PAGE_SEO.bot,
  keywords: [
    "Uniswap Instant Launch bot",
    "token launch sniper",
    "Robinhood Chain DeFi",
    "automated token buying",
    "launch analytics",
    "early buyer detection",
    "DeFi trading bot",
  ],
});

export default function BotLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}