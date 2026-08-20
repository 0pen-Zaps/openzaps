import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";
import {
  FEESHARE_INSTRUMENTS,
  FEESHARE_WRAP_MANIFEST,
  feeShareWrapDeployment,
} from "@/lib/feeshare-wrap";
import styles from "./feeshare.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.feeshare,
  keywords: [
    "0xZAPS fee-share wrappers",
    "tokenized fee shares",
    "fee-share term wrap",
    "WETH auto-compounder",
    "Robinhood Chain",
  ],
});

const MANIFEST = FEESHARE_WRAP_MANIFEST;

// Disclosure copy kept as single-line constants: these sentences are the
// surface's fail-closed / no-yield boundary and are pinned verbatim by the
// page test, so JSX line-wrapping must never fragment them.
const DOES_NOT_PROMISE =
  "No yield or APR. Reward is whatever the fee shares’ trading fees produce, which may be zero — it is not a return, and holding 0xZAPS earns nothing on its own.";
const AUDIT_STATUS =
  "When the wrappers go live, transactions put funds at risk and are irreversible once confirmed.";

function explorer(address: string): string {
  return `${MANIFEST.explorerUrl}/address/${address}`;
}

// Middle-truncate like every other address surface in the app (0x1234…5678):
// the distinguishing tail is what a reader compares when verifying a contract.
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const REFERENCES = [
  { label: "Reward asset", value: MANIFEST.reward.symbol, address: MANIFEST.reward.address },
  { label: "Route target", value: MANIFEST.zaps.symbol, address: MANIFEST.zaps.address },
  { label: "Fee-share vault", value: "Live campaign vault", address: MANIFEST.feeShareVault },
] as const;

export default function FeeShareWrapPage(): React.JSX.Element {
  // Deployment state is the fail-closed switch. Until both wrappers arrive as a
  // reviewed release (address + verified runtime hash), the manifest reports
  // "absent" and this surface reads nothing from the chain and signs nothing.
  const deployment = feeShareWrapDeployment();
  const live = deployment === "configured";

  return (
    <main className={styles.screen} id="main" data-screen-label="Fee wrappers">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.feeshare),
            breadcrumbJsonLd("/feeshare", "Fee-share wrappers"),
          ],
        }}
      />

      <header className={styles.hero}>
        <span className={styles.eyebrow}>FEE-SHARE WRAPPERS</span>
        <h1 className={styles.title}>Time wrappers and automations for 0xZAPS fee shares</h1>
        <p className={styles.lede}>
          Two bounded, immutable instruments over the same tokenized Clanker fee
          shares the live campaign uses. Every term is a constructor parameter;
          there is no owner, pause, or upgrade, and every surface here inherits
          the same fail-closed, no-yield boundary the campaign already states.
        </p>
        <p className={styles.lineage} data-live={live || undefined}>
          {live ? "Live · verified onchain" : "Source-ready · not deployed"}
        </p>
      </header>

      {!live ? (
        <section className={styles.notice} aria-labelledby="feeshare-status">
          <h2 id="feeshare-status">Not live yet</h2>
          <p>
            The wrapper contracts are merged to <code>main</code> and hardened
            across internal adversarial review, but they are not deployed. This
            surface fails closed: there is nothing to read from the chain and
            nothing to sign. When the wrappers deploy as a reviewed release,
            their verified addresses and live term state appear here. No funds
            are at risk today because there is nothing to interact with yet.
          </p>
        </section>
      ) : null}

      <section className={styles.instruments} aria-label="Instruments">
        {FEESHARE_INSTRUMENTS.map((inst) => (
          <article key={inst.id} className={styles.card}>
            <header className={styles.cardHead}>
              <span className={styles.cardKicker}>{inst.contract}</span>
              <h2 className={styles.cardName}>{inst.name}</h2>
              <p className={styles.cardTagline}>{inst.tagline}</p>
            </header>
            <ul className={styles.points}>
              {inst.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <dl className={styles.terms}>
              {inst.terms.map((term) => (
                <div key={term.label} className={styles.termRow}>
                  <dt>{term.label}</dt>
                  <dd>{term.value}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </section>

      <section className={styles.boundary} aria-labelledby="feeshare-boundary">
        <h2 id="feeshare-boundary">What these do not promise</h2>
        <p>{DOES_NOT_PROMISE}</p>
        <p>{AUDIT_STATUS}</p>
      </section>

      <section className={styles.reference} aria-labelledby="feeshare-reference">
        <h2 id="feeshare-reference">Reference</h2>
        <p className={styles.referenceNote}>
          These deployed addresses are the context the wrappers wrap and route
          into. The wrapper addresses themselves appear here once deployed.
        </p>
        <dl className={styles.refList}>
          {REFERENCES.map((ref) => (
            <div key={ref.label} className={styles.refRow}>
              <dt>{ref.label}</dt>
              <dd>
                <span>{ref.value}</span>
                <a
                  className={styles.refLink}
                  href={explorer(ref.address)}
                  target="_blank"
                  rel="noreferrer"
                  title={ref.address}
                  aria-label={`${ref.label} contract ${ref.address} on the block explorer`}
                >
                  {shortAddress(ref.address)}
                </a>
              </dd>
            </div>
          ))}
        </dl>
        <p className={styles.referenceNote}>
          The live fee campaign these compose with is on <Link href="/rewards">/rewards</Link>.
        </p>
      </section>
    </main>
  );
}
