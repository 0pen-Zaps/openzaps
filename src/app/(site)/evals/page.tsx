import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { ExecutorScorecardLookup } from "./ExecutorScorecardLookup";
import styles from "../docs/docs.module.css";
import evalStyles from "./evals.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.evals,
  keywords: ["OpenZaps evals", "DeFi executor scorecard", "onchain execution reliability"],
});

const releaseChecks = [
  [
    "Web",
    "872 Vitest checks passed; lint, TypeScript, and the production Next.js build completed.",
  ],
  [
    "Executor + SDK + MCP",
    "148 Node checks passed across execution, receipts, relay intake, private submission, adapter provenance, notifications, SDK typed-data safety, MCP protocol, and package safety.",
  ],
  [
    "Contracts",
    "422 Foundry checks passed with five explicitly opt-in skips; the hermetic CI partition passed 335 with four skips.",
  ],
  [
    "Live forks",
    "87 fixed-block Base and Robinhood fork checks passed, plus four explicitly enabled Robinhood end-to-end gates.",
  ],
  [
    "Storage + supply chain",
    "The PostgreSQL 16 migration/concurrency harness, production dependency audit, and full-history secret scan passed.",
  ],
] as const;

export default function EvalsPage(): React.JSX.Element {
  const sourceCommit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "local build";
  return (
    <main className={styles.reader} id="main" data-screen-label="Evals">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.evals), breadcrumbJsonLd("/evals", "Evals")],
        }}
      />

      <h1 className={styles.title}>Evidence, with the coverage boundary left on.</h1>
      <p className={styles.lede}>
        Release checks prove specific code paths and executor scorecards summarize independently verified receipts.
        Neither is a promise of future execution, a security audit, or authority for an agent to act.
      </p>
      <div className={styles.actions}>
        <Link className={styles.primaryBtn} href="/docs#security">
          Read the security model
        </Link>
        <span className={styles.metaChip}>
          <b>Rendered commit</b>
          {sourceCommit}
        </span>
      </div>

      <section className={styles.section} aria-labelledby="release-evaluation">
        <h2 className={styles.h2} id="release-evaluation">Release-candidate evaluation</h2>
        <p className={styles.prose}>
          Recorded 29 July 2026 for the release candidate that produced this page. The rendered commit above binds
          the deployment to its source revision. Commands are reproducible from the repository; opt-in fork checks
          are reported separately so a hermetic pass is never misrepresented as live-chain coverage.
        </p>
        <div className={styles.steps}>
          {releaseChecks.map(([label, body]) => (
            <div className={`${styles.step} ${styles.stepPhased} ${evalStyles.releaseStep}`} key={label}>
              <span className={`${styles.stepTag} ${evalStyles.releaseTag}`}>Pass · {label}</span>
              <p className={styles.stepBody}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="executor-evaluation">
        <h2 className={styles.h2} id="executor-evaluation">Receipt-backed executor scorecard</h2>
        <p className={styles.prose}>
          Look up an executor address. The result counts only finalized or reverted executions nominated to the
          reference receipt pipeline and re-verified against canonical factory-created Zaps. It is not a global
          reputation oracle, identity proof, or permission grant.
        </p>
        <ExecutorScorecardLookup />
      </section>

      <section className={styles.section} aria-labelledby="interpretation">
        <h2 className={styles.h2} id="interpretation">How to interpret this</h2>
        <ul className={styles.list}>
          <li>A passing release check establishes only the named command and scope at the recorded revision.</li>
          <li>Reliability is finalized attempts divided by all recorded attempts, expressed in basis points.</li>
          <li>Missing receipts mean missing coverage, not evidence that an executor did or did not act.</li>
          <li>Scorecard reads are public and have <code>authorityScope: none</code>.</li>
        </ul>
      </section>
    </main>
  );
}
