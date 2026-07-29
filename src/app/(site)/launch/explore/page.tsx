import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { ExploreDirectory } from "@/components/zappad/explore-directory";
import { PageHero } from "@/components/zappad/page-hero";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";

import styles from "../zappad.module.css";

export const metadata = pageMetadata({
  title: STATIC_PAGE_SEO.launchExplore.title,
  description: STATIC_PAGE_SEO.launchExplore.description,
  path: STATIC_PAGE_SEO.launchExplore.path,
  keywords: [
    "ZapPad token directory",
    "Robinhood Chain tokens",
    "tokenized fee vaults",
    "onchain token launches",
  ],
  ogImage: STATIC_PAGE_SEO.launchExplore.ogImage,
});

export default function ZapPadExplorePage(): React.JSX.Element {
  return (
    <main className={styles.screen} id="main" data-screen-label="ZapPad">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd({
              ...STATIC_PAGE_SEO.launchExplore,
              type: "CollectionPage",
            }),
            breadcrumbJsonLd("/launch/explore", "Explore ZapPad"),
          ],
        }}
      />
      <PageHero
        actions={
          <Link className="button button-primary" href="/launch">
            Launch a token →
          </Link>
        }
        eyebrow="Onchain launch directory"
        intro="No editorial listings and no hidden database. This directory is reconstructed from the canonical launcher’s current contract state."
        title={
          <>
            Every launch.
            <br />
            <span>One source of truth.</span>
          </>
        }
      />
      <ExploreDirectory />
    </main>
  );
}
