import type { Metadata } from "next";
import Link from "next/link";
import { Space_Grotesk } from "next/font/google";
import { BoltIntro } from "@/components/BoltIntro";
import { pageMetadata } from "@/lib/seo";
import { CHAIN } from "@/lib/config";
import { CountUp } from "@/components/CountUp";
import { Reveal } from "@/components/Reveal";
import { compileChain, makeNode } from "@/lib/blocks";
import { MAX_POLICY_STEPS } from "@/lib/chains";
import { AgentIntent } from "./AgentIntent";
import { Atmosphere } from "./Atmosphere";
import { Collapse } from "./Collapse";
import { Cursor } from "./Cursor";
import { DevPanel } from "./DevPanel";
import { ExecutionDemo } from "./ExecutionDemo";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import { Problem } from "./Problem";
import { ProtocolGraph } from "./ProtocolGraph";
import { RouteRail } from "./RouteRail";
import { SecurityPanel } from "./SecurityPanel";
import { ShareLinks } from "./ShareLinks";
import { VelocityFx } from "./VelocityFx";
import { ZapCards } from "./ZapCards";
import { ZapCore } from "./ZapCore";
import {
  agentPlans,
  landingCards,
  landingMetrics,
  landingRails,
  protocolGraph,
  shareableCards,
} from "./data";
import styles from "./landing.module.css";

/**
 * The landing experience: a cinematic journey from "DeFi, in one action"
 * down to a single point of light. Dark obsidian ground, OpenZaps yellow as
 * the only energy in the system. All numbers and route facts on this page
 * derive from the same libs that power the builder — nothing is invented.
 */

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-display",
  display: "swap",
});

const GITHUB_URL = "https://github.com/0pen-Zaps/openzaps";

export const metadata: Metadata = pageMetadata({
  title: "DeFi, in one action",
  description:
    "OpenZaps turns a multi-protocol DeFi workflow into a single permissionless transaction. Design the route, sign a bounded policy capsule, and execute — live on " +
    `${CHAIN.name}. The contracts are not externally audited.`,
  path: "/",
});

export default function LandingPage(): React.JSX.Element {
  const graph = protocolGraph();
  const plans = agentPlans();
  const metrics = landingMetrics();
  const shareable = shareableCards();

  // The dev panel's verdict is compiled from the exact chain the snippet
  // shows, so the output can never drift from the code.
  const devChain = [
    makeNode("wallet-balance", "src", { asset: "USDG", amount: "25" }),
    makeNode("guard-slippage", "cap", { bps: 50 }),
    makeNode("swap", "leg", { into: "0xZAPS" }),
    makeNode("send", "out"),
  ];
  const devCompiled = compileChain(devChain);
  const devVerdict = {
    status: devCompiled.status,
    gas: devCompiled.gas,
    guardScore: devCompiled.guardScore,
    hash: devCompiled.hash,
    steps: devCompiled.steps,
  };

  return (
    <div id="landing-root" className={`${styles.landing} ${displayFont.variable}`}>
      <BoltIntro />
      <Atmosphere />
      <div className={styles.grain} aria-hidden="true" />
      <VelocityFx />
      <Cursor />
      <LandingNav githubUrl={GITHUB_URL} />

      <main id="main">
        {/* ============================== HERO ============================== */}
        <section className={`container ${styles.hero}`} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.kicker} style={{ "--enter-delay": "0ms" } as React.CSSProperties}>
              <span className={styles.heroEnter}>Open execution infrastructure</span>
            </p>
            <h1 id="hero-title" className={styles.heroTitle}>
              <span className={styles.heroLine} style={{ "--enter-delay": "60ms" } as React.CSSProperties}>
                <span>DeFi,</span>
              </span>
              <span className={styles.heroLine} style={{ "--enter-delay": "150ms" } as React.CSSProperties}>
                <span>in one</span>
              </span>
              <span className={styles.heroLine} style={{ "--enter-delay": "240ms" } as React.CSSProperties}>
                <span className={styles.heroAccent}>action.</span>
              </span>
            </h1>
            <p
              className={`${styles.heroLead} ${styles.heroEnter}`}
              style={{ "--enter-delay": "360ms" } as React.CSSProperties}
            >
              OpenZaps turns a multi-protocol workflow into a single permissionless
              transaction. Design the route, sign a bounded policy, and execute —
              swap, provide, exit, and compose without walking five interfaces to
              do it.
            </p>
            <div
              className={`${styles.heroActions} ${styles.heroEnter}`}
              style={{ "--enter-delay": "460ms" } as React.CSSProperties}
            >
              <Link href="/use" className="btn btnPrimary btnLg" data-magnetic>
                <span>Launch OpenZaps</span>
              </Link>
              <a href="#zaps" className="btn btnGhost btnLg" data-magnetic>
                <span>Explore Zaps</span>
              </a>
            </div>
            <div
              className={`${styles.heroMicro} ${styles.heroEnter}`}
              style={{ "--enter-delay": "560ms" } as React.CSSProperties}
            >
              <span className={styles.heroChip}>One transaction. Any protocol.</span>
              <span className={styles.heroChip}>
                <span className={styles.heroMicroDot} aria-hidden="true" />
                Live on {CHAIN.name} · {CHAIN.id}
              </span>
              <span className={styles.heroChip}>
                <Link href="/legal" className={styles.heroChipLink}>
                  Pre-audit — read the disclosures
                </Link>
              </span>
            </div>
          </div>
          <div className={styles.heroVisual}>
            <ZapCore />
          </div>
          <div className={styles.scrollCue} aria-hidden="true">
            Scroll
          </div>
        </section>

        {/* ======================= WHAT IS A ZAP ============================ */}
        <Collapse />

        {/* ======================== THE PROBLEM ============================= */}
        <Problem />

        {/* ================= ONE ACTION, MANY PROTOCOLS ===================== */}
        <section className={styles.section} aria-labelledby="routes-title">
          <span className={styles.ghostWord} data-depth="1.2" style={{ top: "4%", left: "44%" }} aria-hidden="true">
            ROUTE
          </span>
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>One action, many protocols</p>
              <h2 id="routes-title" className={styles.sectionTitle}>
                Start from an intent. The route does the walking.
              </h2>
              <p className={styles.sectionLead}>
                A Zap begins with what you hold and what you want. OpenZaps
                composes the pools, vaults, and settlement underneath into a
                single bounded policy — inspectable before it is signed.
              </p>
            </Reveal>
            <RouteRail rails={landingRails()} />
          </div>
        </section>

        {/* ========================= EXAMPLE ZAPS =========================== */}
        <section id="zaps" className={styles.section} aria-labelledby="zaps-title">
          <span className={styles.ghostWord} data-depth="1.35" style={{ top: "2%", left: "6%" }} aria-hidden="true">
            COMPOSE
          </span>
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Example Zaps</p>
              <h2 id="zaps-title" className={styles.sectionTitle}>
                Executable paths through DeFi.
              </h2>
              <p className={styles.sectionLead}>
                Six blueprints from the catalog. Hover a card to see the blocks
                and protocols underneath; open one and the builder loads this
                exact chain — live routes sign and run today, designs compile
                and save.
              </p>
            </Reveal>
            <ZapCards cards={landingCards()} />
          </div>
        </section>

        {/* ========================== LIVE DEMO ============================= */}
        <section id="demo" className={styles.section} aria-labelledby="demo-title">
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Preview an execution</p>
              <h2 id="demo-title" className={styles.sectionTitle}>
                Compile a route. Watch it check itself.
              </h2>
              <p className={styles.sectionLead}>
                The same compiler that powers the builder, running here. Pick an
                intent, set an amount, and preview the simulation a capsule runs
                before anything is signed.
              </p>
            </Reveal>
            <ExecutionDemo />
          </div>
        </section>

        {/* ======================== WHY OPENZAPS ============================ */}
        <section className={styles.section} aria-labelledby="why-title">
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Why OpenZaps</p>
              <h2 id="why-title" className={styles.sectionTitle}>
                Built like infrastructure, not an interface.
              </h2>
            </Reveal>
            <ol className={styles.whyGrid} data-reveal-group>
              {WHY.map((item, index) => (
                <Reveal as="li" key={item.title} delay={index * 70} className={styles.whyCell}>
                  <span className={`${styles.whyIndex} ${styles.display}`}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className={styles.whyTitle}>{item.title}</h3>
                  <p className={styles.whyDetail}>{item.detail}</p>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* ==================== PROTOCOL INTEGRATIONS ======================= */}
        <section id="integrations" className={styles.section} aria-labelledby="integrations-title">
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Protocol integrations</p>
              <h2 id="integrations-title" className={styles.sectionTitle}>
                OpenZaps does not replace protocols. It makes them easier to
                compose.
              </h2>
              <p className={styles.sectionLead}>
                Bright nodes carry deployed, bounded routes today. Dim nodes are
                typed into the catalog — designs compile against them now and
                deploy when their adapters ship.
              </p>
            </Reveal>
            <ProtocolGraph {...graph} />
          </div>
        </section>

        {/* ========================= DEVELOPERS ============================= */}
        <section id="developers" className={styles.section} aria-labelledby="developers-title">
          <span
            className={styles.ghostWord}
            data-depth="1.25"
            style={{ top: "0%", right: "2%" }}
            aria-hidden="true"
          >
            BUILD
          </span>
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Developers</p>
              <h2 id="developers-title" className={styles.sectionTitle}>
                Build on top of every protocol at once.
              </h2>
              <p className={styles.sectionLead}>
                The block catalog, compiler, and share-token codec are MIT
                TypeScript — the same modules rendering this page. Compose a
                chain, compile a verdict, ship a link.
              </p>
            </Reveal>
            <DevPanel verdict={devVerdict} />
            <div className={styles.devCtas}>
              <Link href="/docs" className="btn btnGhost" data-magnetic>
                <span>Read the docs</span>
              </Link>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="btn btnGhost"
                data-magnetic
              >
                <span>View GitHub ↗</span>
              </a>
            </div>
          </div>
        </section>

        {/* =========================== AGENTS =============================== */}
        <section className={styles.section} aria-labelledby="agents-title">
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Agent execution</p>
              <h2 id="agents-title" className={styles.sectionTitle}>
                Agents should express intent, not assemble transactions.
              </h2>
              <p className={styles.sectionLead}>
                A capsule is the contract between you and your agent: it can
                decide when to execute, and nothing else. Built for a world
                where software holds triggers.
              </p>
            </Reveal>
            <AgentIntent plans={plans} />
          </div>
        </section>

        {/* ========================== SECURITY ============================== */}
        <section id="security" className={styles.section} aria-labelledby="security-title">
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Security &amp; transparency</p>
              <h2 id="security-title" className={styles.sectionTitle}>
                Every abstraction remains verifiable.
              </h2>
            </Reveal>
            <SecurityPanel />
          </div>
        </section>

        {/* =========================== METRICS ============================== */}
        <section className={styles.section} aria-labelledby="metrics-title">
          <div className="container">
            <h2 id="metrics-title" className={styles.srOnly}>
              System metrics
            </h2>
            <div className={styles.metricsFeature}>
              <span className={`${styles.metricsBig} ${styles.display}`}>
                <CountUp value={String(metrics.maxCompression.blocks)} /> blocks
              </span>
              <span className={styles.metricsArrow} aria-hidden="true">
                →
              </span>
              <span className={`${styles.metricsBig} ${styles.metricsBigAccent} ${styles.display}`}>
                1 signed step
              </span>
            </div>
            <p className={`${styles.metricsCaption} mono`}>
              deepest deployable blueprint: {metrics.maxCompression.recipe}
            </p>
            <dl className={styles.metricsGrid}>
              {[
                { value: String(metrics.blocks), label: "typed blocks" },
                { value: String(metrics.adapters), label: "adapter contracts live on chain 4663" },
                { value: String(metrics.blueprints), label: "blueprints in the catalog" },
                { value: String(metrics.deployableBlueprints), label: "deployable today" },
                { value: String(metrics.routeKinds), label: "route kinds" },
                { value: String(MAX_POLICY_STEPS), label: "policy step ceiling" },
              ].map((stat) => (
                <div key={stat.label} className={styles.metricsCell}>
                  <dt className={`${styles.metricsLabel} mono`}>{stat.label}</dt>
                  <dd className={styles.metricsValue}>
                    <CountUp value={stat.value} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ========================= SHARE ZAPS ============================= */}
        <section className={styles.section} aria-labelledby="share-title">
          <div className="container">
            <Reveal as="header" className={styles.sectionHead}>
              <p className={styles.kicker}>Social Zaps</p>
              <h2 id="share-title" className={styles.sectionTitle}>
                Every strategy becomes a link.
              </h2>
              <p className={styles.sectionLead}>
                A designed chain encodes into a URL-safe token. Send it to
                anyone: the builder decodes it, compiles it, and — if it
                reduces to a live route — signs and runs it.
              </p>
            </Reveal>
            <ShareLinks cards={shareable} />
          </div>
        </section>

        {/* ========================== FINAL CTA ============================= */}
        <section className={styles.finalCta} aria-labelledby="final-title">
          <span className={styles.ghostWord} data-depth="1.1" style={{ top: "8%", left: "30%" }} aria-hidden="true">
            SETTLE
          </span>
          <div className={`container ${styles.finalInner}`}>
            <span className={styles.finalPoint} aria-hidden="true" />
            <h2 id="final-title" className={`${styles.finalTitle} ${styles.display}`}>
              One action is enough.
            </h2>
            <p className={styles.finalLead}>
              Execute across DeFi without navigating every layer beneath it.
            </p>
            <div className={styles.finalActions}>
              <Link href="/use?view=sign" className="btn btnPrimary btnLg" data-magnetic>
                <span>Launch OpenZaps</span>
              </Link>
              <Link href="/use" className="btn btnGhost btnLg" data-magnetic>
                <span>Build a Zap</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter githubUrl={GITHUB_URL} />
    </div>
  );
}

const WHY = [
  {
    title: "One transaction",
    detail: "A multi-protocol route executes as a single signed step — approvals, hops, and settlement included.",
  },
  {
    title: "Permissionless",
    detail:
      "Anyone designs, shares, and executes Zaps — creation is open to any caller, and no signature but yours can move funds. Routes run only through governance-allowlisted adapters and tokens.",
  },
  {
    title: "Composable",
    detail: "Typed blocks snap into chains; shapes must match, so what compiles is what can execute.",
  },
  {
    title: "Transparent",
    detail: "Every capsule's policy, provenance, and executions are public and re-verifiable on /zaps.",
  },
  {
    title: "Bounded",
    detail: "Target, recipient, calldata, amounts, gas: fixed at signing. Execution cannot exceed the policy.",
  },
  {
    title: "Open",
    detail: "MIT-licensed end to end — the builder, the compiler, and the contracts behind it.",
  },
] as const;
