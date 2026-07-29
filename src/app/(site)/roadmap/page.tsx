import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";

import {
  CONTRIBUTION_ALLOCATION,
  FLYWHEELS,
  FOUNDATION_STATES,
  NON_NEGOTIABLES,
  NORTH_STAR_METRICS,
  ROADMAP_SYSTEMS,
  STATUS_LEGEND,
  type RoadmapStatus,
  type RoadmapSystem,
} from "./roadmap-data";
import styles from "./roadmap.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.roadmap,
  keywords: [
    "OpenZaps roadmap",
    "DeFi agent roadmap",
    "Zap marketplace",
    "agent skill registry",
    "0xZAPS utility",
    "DeFi agent competition",
  ],
});

const SECTION_LINKS = [
  { href: "#vision", label: "Vision" },
  { href: "#foundation", label: "Foundation" },
  { href: "#systems", label: "Eight systems" },
  { href: "#economics", label: "Economics" },
  { href: "#flywheels", label: "Flywheels" },
  { href: "#guardrails", label: "Guardrails" },
  { href: "#metrics", label: "Metrics" },
] as const;

function StatusPill({ status }: { status: RoadmapStatus }): React.JSX.Element {
  return (
    <span className={styles.status} data-tone={status.tone}>
      <span className={styles.statusDot} aria-hidden />
      {status.label}
    </span>
  );
}

function ContributionAllocation(): React.JSX.Element {
  return (
    <figure className={styles.allocation}>
      <figcaption>
        <span>Proposed default allocation</span>
        <strong>40 / 40 / 20</strong>
      </figcaption>
      <div className={styles.allocationBar} aria-hidden>
        {CONTRIBUTION_ALLOCATION.map((item) => (
          <span key={item.label} style={{ flex: item.percentage }} />
        ))}
      </div>
      <ol className={styles.allocationLegend}>
        {CONTRIBUTION_ALLOCATION.map((item) => (
          <li key={item.label}>
            <strong>{item.percentage}%</strong>
            <span>
              <b>{item.label}</b>
              {item.detail}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function RoadmapSystemCard({ system, delay }: { system: RoadmapSystem; delay: number }): React.JSX.Element {
  return (
    <Reveal
      as="article"
      className={styles.systemCard}
      data-roadmap-system={system.number}
      delay={delay}
      id={system.id}
    >
      <header className={styles.systemHeader}>
        <span className={styles.systemNumber}>{system.number}</span>
        <div>
          <span className={styles.systemGroup}>{system.group}</span>
          <h3>{system.title}</h3>
        </div>
      </header>

      <div className={styles.statusRow} aria-label={`${system.title} statuses`}>
        {system.statuses.map((status) => (
          <StatusPill key={status.label} status={status} />
        ))}
      </div>

      <p className={styles.systemSummary}>{system.summary}</p>

      {system.paragraphs?.map((paragraph) => (
        <p className={styles.systemBody} key={paragraph}>
          {paragraph}
        </p>
      ))}

      {system.formula ? (
        <div className={styles.formula}>
          <span>Creator compensation signal</span>
          <strong>{system.formula}</strong>
        </div>
      ) : null}

      {system.bullets?.length ? (
        <div className={styles.systemListBlock}>
          <h4>{system.bulletLabel}</h4>
          <ul className={styles.systemList}>
            {system.bullets.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {system.id === "contribution-router" ? <ContributionAllocation /> : null}

      {system.details?.length ? (
        <div className={styles.detailStack}>
          {system.details.map((detail) => (
            <details className={styles.detail} key={detail.title}>
              <summary>
                <span>{detail.title}</span>
                <span className={styles.detailMark} aria-hidden>
                  +
                </span>
              </summary>
              <div className={styles.detailBody}>
                {detail.intro ? <p>{detail.intro}</p> : null}
                <ul>
                  {detail.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </details>
          ))}
        </div>
      ) : null}

      {system.progression?.length ? (
        <div className={styles.progression} aria-label="Strategy graduation path">
          <span className={styles.progressionLabel}>Graduation path</span>
          <ol>
            {system.progression.map((step, index) => (
              <li key={step}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {system.note ? <p className={styles.systemNote}>{system.note}</p> : null}
    </Reveal>
  );
}

function Flywheel({ label, nodes, delay }: (typeof FLYWHEELS)[number] & { delay: number }): React.JSX.Element {
  return (
    <Reveal as="article" className={styles.flywheel} delay={delay}>
      <div className={styles.flywheelHead}>
        <span>Loop</span>
        <h3>{label}</h3>
      </div>
      <ol aria-label={label}>
        {nodes.map((node, index) => (
          <li key={node}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{node}</strong>
            {index < nodes.length - 1 ? <i aria-hidden>→</i> : <i aria-hidden>↻</i>}
          </li>
        ))}
      </ol>
    </Reveal>
  );
}

export default function RoadmapPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main" data-screen-label="Roadmap">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.roadmap), breadcrumbJsonLd("/roadmap", "Roadmap")],
        }}
      />

      <section className={styles.hero} id="vision">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span aria-hidden />
            OpenZaps ecosystem roadmap
          </p>
          <h1>Executable DeFi intelligence should compound.</h1>
          <p className={styles.heroLead}>
            OpenZaps becomes an evolutionary market where ideas become Zaps, useful Zaps become agent skills, usage
            buys 0xZAPS, contributors receive rewards, and competitions produce better strategies.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/zap?view=start">
              Build a live Zap
              <span aria-hidden>→</span>
            </Link>
            <Link className={styles.secondaryAction} href="/docs">
              Read protocol docs
            </Link>
          </div>
        </div>

        <aside className={styles.heroPosture} aria-label="Roadmap posture">
          <span className={styles.heroPostureLabel}>Roadmap posture</span>
          <strong>Direction, not a release promise.</strong>
          <p>
            The live protocol and release-ready source are identified below. Everything beyond them can be reordered,
            narrowed, or dropped if evidence or safety requires it.
          </p>
          <ul>
            <li>Core execution stays token-ungated.</li>
            <li>Capital progression always requires explicit user signing.</li>
            <li>New incentive contracts require independent review.</li>
          </ul>
        </aside>

        <div className={styles.visionLoop} aria-label="OpenZaps vision loop">
          {["Ideas", "Zaps", "Agent skills", "Usage", "0xZAPS", "Rewards", "Better strategies"].map((node, index) => (
            <div key={node}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{node}</strong>
              {index < 6 ? <i aria-hidden>→</i> : <i aria-hidden>↻</i>}
            </div>
          ))}
        </div>
      </section>

      <div className={styles.roadmapLayout}>
        <nav className={styles.sectionNav} aria-label="Roadmap sections">
          <span className={styles.sectionNavLabel}>On this page</span>
          {SECTION_LINKS.map((item) => (
            <a href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className={styles.roadmapContent}>
          <section className={styles.section} id="foundation">
            <header className={styles.sectionHead}>
              <p>Current truth</p>
              <h2>Start from what is real.</h2>
              <span>
                The ecosystem roadmap builds on bounded execution already in the product. Release-ready source is not
                described as live, and hosted or credentialed systems remain off until their production gates pass.
              </span>
            </header>

            <div className={styles.legend} aria-label="Roadmap status legend">
              {STATUS_LEGEND.map((status) => (
                <div key={status.label}>
                  <StatusPill status={status} />
                  <p>{status.description}</p>
                </div>
              ))}
            </div>

            <div className={styles.foundationGrid}>
              {FOUNDATION_STATES.map((item, index) => (
                <Reveal as="article" className={styles.foundationCard} delay={(index % 2) * 55} key={item.title}>
                  <StatusPill status={item.status} />
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </Reveal>
              ))}
            </div>

            <div className={styles.auditNotice}>
              <strong>Pre-audit software</strong>
              <p>
                OpenZaps is experimental infrastructure. Onchain actions are irreversible. Review the{" "}
                <Link href="/docs#security">security model</Link>, <Link href="/evals">public evals</Link>, and{" "}
                <Link href="/legal">risk disclosures</Link> before signing.
              </p>
            </div>
          </section>

          <section className={styles.section} id="systems">
            <header className={styles.sectionHead}>
              <p>Roadmap architecture</p>
              <h2>Eight systems. One compounding loop.</h2>
              <span>
                These systems move from bounded experiments to reusable skills, transparent contribution, and
                adversarial strategy improvement. A roadmap badge never implies a deployed contract or active reward.
              </span>
            </header>

            <div className={styles.systemGrid}>
              {ROADMAP_SYSTEMS.map((system, index) => (
                <RoadmapSystemCard delay={(index % 2) * 55} key={system.id} system={system} />
              ))}
            </div>
          </section>

          <section className={styles.section} id="economics">
            <header className={styles.sectionHead}>
              <p>Economic boundary</p>
              <h2>Reward work. Never sell authority.</h2>
              <span>
                The proposed market pays for verified contribution while keeping custody, recovery, and execution
                authority outside token mechanics.
              </span>
            </header>

            <div className={styles.economicsGrid}>
              <article>
                <span className={styles.economicsIndex}>Now</span>
                <h3>Existing obligations stay intact</h3>
                <p>
                  The live automated-execution fee keeps its 80% executor share and current protocol-pot obligations.
                  No existing pot balance is redirected by this roadmap.
                </p>
                <Link href="/pot">Inspect the live pot →</Link>
              </article>
              <article>
                <span className={styles.economicsIndex}>Future</span>
                <h3>Migration is explicit and bounded</h3>
                <p>
                  Only future, explicitly migrated fee flows may fund rate-limited 0xZAPS purchases and the proposed
                  40 / 40 / 20 contribution allocation.
                </p>
                <Link href="/token">See current token utility →</Link>
              </article>
              <article className={styles.economicsNever}>
                <span className={styles.economicsIndex}>Never</span>
                <h3>0xZAPS does not control user Zaps</h3>
                <p>
                  No passive revenue right, user-fund authority, token-gated recovery, or governance over another
                  owner&apos;s Zap is introduced. Payment may buy review; it never buys approval.
                </p>
                <Link href="/legal">Read risk disclosures →</Link>
              </article>
            </div>
          </section>

          <section className={styles.section} id="flywheels">
            <header className={styles.sectionHead}>
              <p>Compounding loops</p>
              <h2>Usage improves both product and intelligence.</h2>
              <span>
                The product loop funds useful work. The intelligence loop makes strategy promotion harder, more
                reproducible, and more accountable over time.
              </span>
            </header>
            <div className={styles.flywheelGrid}>
              {FLYWHEELS.map((flywheel, index) => (
                <Flywheel delay={index * 55} key={flywheel.label} {...flywheel} />
              ))}
            </div>
          </section>

          <section className={styles.section} id="guardrails">
            <header className={styles.sectionHead}>
              <p>Non-negotiables</p>
              <h2>Authority never compounds.</h2>
              <span>
                Better strategies may earn more use. They do not earn broader wallet permissions, uncapped budgets, or
                an automatic path into live capital.
              </span>
            </header>
            <ol className={styles.guardrailGrid}>
              {NON_NEGOTIABLES.map((item, index) => (
                <Reveal as="li" delay={(index % 2) * 45} key={item}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <p>{item}</p>
                </Reveal>
              ))}
            </ol>
          </section>

          <section className={styles.section} id="metrics">
            <header className={styles.sectionHead}>
              <p>Measurement plan</p>
              <h2>Measure retention, safety, and improvement—not spectacle.</h2>
              <span>
                These are the intended north stars once the corresponding instrumentation exists. The page does not
                fabricate zeroes or imply that unbuilt systems already produce data.
              </span>
            </header>
            <div className={styles.metricGrid}>
              {NORTH_STAR_METRICS.map((metric, index) => (
                <Reveal as="article" delay={(index % 3) * 40} key={metric}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <p>{metric}</p>
                </Reveal>
              ))}
            </div>
          </section>

          <section className={styles.finalCta}>
            <div>
              <p>Build what exists. Evaluate what comes next.</p>
              <h2>One Zap at a time.</h2>
            </div>
            <div>
              <Link className={styles.primaryAction} href="/zap?view=start">
                Start a Zap
                <span aria-hidden>→</span>
              </Link>
              <Link className={styles.secondaryAction} href="/evals">
                View evidence
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
