import { Reveal } from "@/components/Reveal";
import styles from "./landing.module.css";

/**
 * The fragmentation section. Grayscale interface shards drift apart behind
 * the copy — approvals, tabs, network prompts — the day-to-day debris of
 * manual DeFi. Deliberately the only section with no yellow in it until the
 * closing line, where one thread of accent light leads into the routing rail.
 */

const PAINS = [
  "Too many tabs",
  "Repeated approvals",
  "Fragmented liquidity",
  "Inconsistent interfaces",
  "Manual routing",
  "Unnecessary gas",
  "Hidden execution complexity",
  "Poor discoverability",
] as const;

const SHARDS = [
  { text: "Approve USDG spending?", sub: "unlimited allowance", x: "6%", y: "8%", depth: 0.5, delay: 0 },
  { text: "Switch network to continue", sub: "wrong chain detected", x: "64%", y: "2%", depth: 0.9, delay: -2.2 },
  { text: "Tab 7 of 12", sub: "pool interface", x: "82%", y: "38%", depth: 0.6, delay: -4.1 },
  { text: "Set slippage tolerance", sub: "0.1% · 0.5% · custom", x: "12%", y: "62%", depth: 1.0, delay: -1.3 },
  { text: "Sign transaction 3 of 5", sub: "waiting for wallet…", x: "58%", y: "70%", depth: 0.7, delay: -3.4 },
  { text: "Quote expired", sub: "refresh to re-route", x: "36%", y: "30%", depth: 0.8, delay: -5.2 },
] as const;

export function Problem(): React.JSX.Element {
  return (
    <section className={`${styles.section} ${styles.problem}`} aria-labelledby="problem-title">
      <div className={styles.problemShards} aria-hidden="true">
        {SHARDS.map((shard) => (
          <div
            key={shard.text}
            className={styles.problemShard}
            data-depth={shard.depth}
            style={
              {
                left: shard.x,
                top: shard.y,
                "--float-delay": `${shard.delay}s`,
              } as React.CSSProperties
            }
          >
            <span className={styles.problemShardText}>{shard.text}</span>
            <span className={`${styles.problemShardSub} mono`}>{shard.sub}</span>
          </div>
        ))}
      </div>

      <div className={`container ${styles.problemInner}`}>
        <Reveal as="header" className={styles.sectionHead}>
          <p className={styles.kicker}>The problem</p>
          <h2 id="problem-title" className={styles.sectionTitle}>
            DeFi is composable.
            <br />
            Its interfaces are not.
          </h2>
          <p className={styles.sectionLead}>
            Every protocol works. Composing them by hand is the part that does
            not: allowances, quotes, tabs, and settlement scattered across
            surfaces that were never designed to be one workflow.
          </p>
        </Reveal>

        <ul className={styles.problemList} data-reveal-group>
          {PAINS.map((pain, index) => (
            <Reveal as="li" key={pain} delay={index * 60} className={styles.problemItem}>
              <span className={`${styles.problemIndex} mono`}>
                {String(index + 1).padStart(2, "0")}
              </span>
              {pain}
            </Reveal>
          ))}
        </ul>

        <Reveal className={styles.problemThread}>
          <p className={styles.problemResolve}>
            OpenZaps threads them back together —{" "}
            <span className={styles.problemResolveAccent}>one route, one signature.</span>
          </p>
          <span className={styles.problemThreadLine} aria-hidden="true" />
        </Reveal>
      </div>
    </section>
  );
}
