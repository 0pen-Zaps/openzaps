import { JsonLd } from "@/components/JsonLd";
import { LaunchStudio } from "@/components/zappad/launch-studio";
import { PageHero } from "@/components/zappad/page-hero";
import { ProtocolSnapshot } from "@/components/zappad/protocol-snapshot";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";

import styles from "./zappad.module.css";

export function ZapPadReleaseStatus(): React.JSX.Element {
  return (
    <div className="notice notice-warning" role="status">
      <strong>Source-ready, not deployed.</strong>{" "}
      No ZapPad launcher address is approved on Robinhood Chain. Reads and
      launches stay disabled until the external security, legal,
      infrastructure, canary, and exact-release gates are complete.
    </div>
  );
}

export const metadata = pageMetadata({
  title: STATIC_PAGE_SEO.launch.title,
  description: STATIC_PAGE_SEO.launch.description,
  path: STATIC_PAGE_SEO.launch.path,
  keywords: [
    "ZapPad",
    "Robinhood Chain token launchpad",
    "tokenized trading fees",
    "Uniswap v3 token launch",
  ],
  ogImage: STATIC_PAGE_SEO.launch.ogImage,
});

export default function ZapPadStudioPage(): React.JSX.Element {
  return (
    <main className={styles.screen} id="main" data-screen-label="ZapPad">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.launch),
            breadcrumbJsonLd("/launch", "ZapPad"),
          ],
        }}
      />
      <PageHero
        eyebrow="Launch studio · chain 4663"
        intro="Compose the token and its opening market as one bounded launch. ZapPad verifies token ordering, simulates the exact call, and enables submission only while that proof remains current."
        title={
          <>
            Launch a token.
            <br />
            <span>Tokenize its fees.</span>
          </>
        }
      />
      <ZapPadReleaseStatus />
      <ProtocolSnapshot />
      <LaunchStudio />
    </main>
  );
}
