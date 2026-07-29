import type { Metadata } from "next";

import { PageHero } from "@/components/zappad/page-hero";
import { PortfolioDashboard } from "@/components/zappad/portfolio-dashboard";
import { pageMetadata } from "@/lib/seo";

import styles from "../zappad.module.css";

export const metadata = {
  ...pageMetadata({
    title: "My ZapPad Fee Rights",
    description:
      "Connect a wallet to inspect ZapPad launches, transferable fee-share holdings, and claimable Uniswap LP fees on Robinhood Chain.",
    path: "/launch/portfolio",
    keywords: [
      "ZapPad portfolio",
      "tokenized fee rights",
      "claimable LP fees",
      "Robinhood Chain fee shares",
    ],
    ogImage: "/og/app.png",
  }),
  robots: {
    index: false,
    follow: true,
    googleBot: { index: false, follow: true },
  },
} satisfies Metadata;

export default function ZapPadPortfolioPage(): React.JSX.Element {
  return (
    <main className={styles.screen} id="main" data-screen-label="ZapPad">
      <PageHero
        eyebrow="Wallet portfolio"
        intro="See the launches you created, the fee-share tokens you hold, and the onchain revenue each position has accounted to your address."
        title={
          <>
            Your launches.
            <br />
            <span>Your fee rights.</span>
          </>
        }
      />
      <PortfolioDashboard />
    </main>
  );
}
