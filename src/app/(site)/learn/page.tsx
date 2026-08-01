import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { LINKS } from "@/lib/config";
import {
  PUBLIC_CONTENT_CATALOG_DIGEST,
  PUBLIC_CONTENT_ITEMS,
} from "@/lib/marketing/public-content";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";

import styles from "./learn.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.learn,
  keywords: [
    "OpenZaps tutorials",
    "AI agent DeFi tutorials",
    "bounded DeFi automation",
    "DeFi build logs",
    "agent authority map",
  ],
});

const CHANNELS = [
  {
    label: "RSS",
    detail: "Every source-reviewed OpenZaps update in one machine-readable feed.",
    href: "/feed.xml",
    cta: "rss",
    external: false,
  },
  {
    label: "DeFi Tutorials",
    detail: "Long-form, human-reviewed walkthroughs published by Nodar.",
    href: LINKS.substack,
    cta: "substack",
    external: true,
  },
  {
    label: "Discord",
    detail: "Join the OpenZaps server for release notes and builder discussion.",
    href: LINKS.discord,
    cta: "discord",
    external: true,
  },
  {
    label: "X @0xzaps",
    detail: "Follow concise product updates and links to the underlying evidence.",
    href: LINKS.x,
    cta: "x",
    external: true,
  },
] as const;

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

const REQUEST_URL =
  "/request-a-zap?utm_source=openzaps&utm_medium=website&utm_campaign=request_a_zap&utm_content=learn_hub";

export default function LearnPage(): React.JSX.Element {
  return (
    <main
      className={styles.page}
      id="main"
      data-screen-label="Updates"
      data-publication-boundary="reviewed-feed-and-rss-confirmed"
      data-public-content-count={PUBLIC_CONTENT_ITEMS.length}
      data-public-content-digest={PUBLIC_CONTENT_CATALOG_DIGEST}
    >
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd({ ...STATIC_PAGE_SEO.learn, type: "CollectionPage" }),
            breadcrumbJsonLd("/learn", "Updates and tutorials"),
            {
              "@type": "ItemList",
              "@id": "https://www.0xzaps.com/learn#updates",
              name: "OpenZaps verified updates and tutorials",
              itemListElement: PUBLIC_CONTENT_ITEMS.map((item, index) => ({
                "@type": "ListItem",
                position: index + 1,
                url: item.canonicalUrl,
                name: item.title,
              })),
            },
          ],
        }}
      />

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span aria-hidden />
            OpenZaps Learn
          </p>
          <h1>Follow what shipped. Learn why the bounds matter.</h1>
          <p className={styles.lead}>
            Product updates, evidence-first build notes, and DeFi Tutorials that
            explain how an agent can hold the trigger without receiving broad
            wallet authority.
          </p>
          <div className={styles.actions}>
            <a className={styles.primaryAction} href="#latest">
              Read the latest
              <span aria-hidden>↓</span>
            </a>
            <Link
              className={styles.secondaryAction}
              href={REQUEST_URL}
              data-analytics-event="request_zap_clicked"
              data-analytics-cta="request_zap"
              data-analytics-content="learn_hub"
            >
              Request an authority map
            </Link>
          </div>
        </div>

        <aside className={styles.publicationRule} aria-label="Publication rule">
          <span>Publication rule</span>
          <strong>Public only after evidence.</strong>
          <p>
            Product rows come from the reviewed OpenZaps feed. Tutorials appear
            only after their title and canonical URL are confirmed in the public
            DeFi Tutorials RSS feed.
          </p>
          <ul>
            <li>
              Drafts and editor handoffs are withheld from this catalog until
              RSS confirmation.
            </li>
            <li>No post is evidence of an audit or partnership.</li>
            <li>Every workflow remains subject to its encoded limits.</li>
          </ul>
        </aside>
      </section>

      <section className={styles.channels} aria-labelledby="follow-heading">
        <header className={styles.sectionHeading}>
          <p>Choose your channel</p>
          <h2 id="follow-heading">One evidence stream, four ways to follow.</h2>
        </header>
        <div className={styles.channelGrid}>
          {CHANNELS.map((channel, index) => {
            const content = (
              <>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{channel.label}</strong>
                <p>{channel.detail}</p>
                <i aria-hidden>↗</i>
              </>
            );
            const analytics = {
              "data-analytics-event": "growth_link_clicked",
              "data-analytics-cta": channel.cta,
              "data-analytics-content": "learn_hub",
            } as const;
            return channel.external ? (
              <a
                className={styles.channelCard}
                href={channel.href}
                key={channel.label}
                target="_blank"
                rel="noreferrer noopener"
                {...analytics}
              >
                {content}
              </a>
            ) : (
              <Link
                className={styles.channelCard}
                href={channel.href}
                key={channel.label}
                {...analytics}
              >
                {content}
              </Link>
            );
          })}
        </div>
      </section>

      <section className={styles.latest} id="latest" aria-labelledby="latest-heading">
        <header className={styles.sectionHeading}>
          <p>Verified public catalog</p>
          <h2 id="latest-heading">Updates and tutorials</h2>
          <span>
            Sorted by publication evidence. A missing or unconfirmed item is
            withheld rather than rendered as public.
          </span>
        </header>

        <div className={styles.updateList}>
          {PUBLIC_CONTENT_ITEMS.map((item, index) => (
            <Reveal
              as="article"
              className={styles.updateCard}
              data-public-content-id={item.id}
              delay={(index % 3) * 45}
              key={item.id}
            >
              <div className={styles.updateMeta}>
                <span data-kind={item.kind}>
                  {item.kind === "tutorial" ? "Tutorial" : "Product update"}
                </span>
                <time dateTime={item.publishedAt}>{displayDate(item.publishedAt)}</time>
              </div>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
              <div className={styles.updateFoot}>
                <span>{item.sourceLabel}</span>
                {item.external ? (
                  <a
                    href={item.canonicalUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    data-analytics-event="content_update_opened"
                    data-analytics-cta={item.kind}
                    data-analytics-content="learn_hub"
                  >
                    Read tutorial <i aria-hidden>↗</i>
                  </a>
                ) : (
                  <Link
                    href={item.canonicalUrl}
                    data-analytics-event="content_update_opened"
                    data-analytics-cta={item.kind}
                    data-analytics-content="learn_hub"
                  >
                    Open evidence <i aria-hidden>→</i>
                  </Link>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className={styles.conversion}>
        <div>
          <p>Turn the next lesson into your workflow</p>
          <h2>Send one DeFi workflow. Get a bounded authority map.</h2>
          <span>
            Describe the trigger, target, assets, cadence, and limits. Never send
            a private key, seed phrase, signature, wallet balance, or signing
            authority.
          </span>
        </div>
        <Link
          href={REQUEST_URL}
          data-analytics-event="request_zap_clicked"
          data-analytics-cta="request_zap"
          data-analytics-content="learn_hub"
        >
          Request a Zap
          <span aria-hidden>→</span>
        </Link>
      </section>

      <p className={styles.disclosure}>
        <strong>Pre-audit software.</strong> Educational material and product
        updates are not an audit, deployment promise, or financial advice.
        Onchain actions use real funds and are irreversible.
      </p>
    </main>
  );
}
