import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import { CONTRACTS, LINKS } from "@/lib/config";
import styles from "./landing.module.css";

/**
 * The trust section. Motion nearly stops here on purpose: a strong grid,
 * verification language, and the pre-audit disclosure kept in plain sight.
 * Every claim maps to something the code actually does; the one thing the
 * product cannot claim — an external audit — is stated, not styled away.
 */

const GUARANTEES = [
  {
    title: "Owner-submitted execution",
    detail:
      "Every transaction is signed and sent from the owner's wallet. Nothing executes custodially.",
  },
  {
    title: "Policy fixed before signing",
    detail:
      "Target, recipient, asset, and calldata shape are welded into the capsule. Execution cannot redirect them.",
  },
  {
    title: "Deterministic simulation first",
    detail:
      "Every design compiles through the same checks before signing — fit, caps, guard coverage, gas constants.",
  },
  {
    title: "Minimum-out enforced onchain",
    detail:
      "The slippage cap (10–500 bps) sets the minimum output signed into each execution intent — the capsule reverts the trade if net output lands below it.",
  },
  {
    title: "Bounded amounts and gas",
    detail:
      "Amounts are capped at uint128; execution carries a 3,000,000 gas ceiling and a 10 gwei fee cap.",
  },
  {
    title: "Recovery path",
    detail:
      "Funds stranded in a capsule are recoverable by the owner at any time — no permission needed.",
  },
] as const;

const INSPECTIONS = [
  { step: "Factory log check", detail: "the capsule was created by the canonical factory" },
  { step: "EIP-1167 runtime match", detail: "bytecode is the expected minimal clone" },
  { step: "Policy rehash", detail: "stored hash matches the recomputed policy" },
  { step: "Route comparison", detail: "steps checked against the live route registry" },
  { step: "Deviation report", detail: "anything nonstandard is listed, not hidden" },
] as const;

export function SecurityPanel(): React.JSX.Element {
  return (
    <div className={styles.security}>
      <div className={styles.securityGrid} data-reveal-group>
        {GUARANTEES.map((item, index) => (
          <Reveal as="article" key={item.title} delay={index * 60} className={styles.securityCell}>
            <span className={styles.securityLight} aria-hidden="true" />
            <h3 className={styles.securityTitle}>{item.title}</h3>
            <p className={styles.securityDetail}>{item.detail}</p>
          </Reveal>
        ))}
      </div>

      <aside className={styles.securityAside}>
        <div className={styles.securityInspect}>
          <span className={`${styles.demoRouteKicker} mono`}>
            what /explore verifies per capsule
          </span>
          <ol className={styles.securityInspectList}>
            {INSPECTIONS.map((item, i) => (
              <li key={item.step}>
                <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{item.step}</strong>
                  <span>{item.detail}</span>
                </div>
              </li>
            ))}
          </ol>
          <p className={`${styles.securityContracts} mono`}>
            factory {CONTRACTS.factory.slice(0, 10)}… ·{" "}
            <a href={LINKS.contractSource} target="_blank" rel="noreferrer noopener">
              verified source ↗
            </a>
          </p>
        </div>

        <div className={styles.securityAudit}>
          <span className={`${styles.securityAuditFlag} mono`}>pre-audit</span>
          <p>
            The contracts are <strong>not externally audited</strong>. Guard
            blocks beyond the slippage cap are policy-layer checks, not onchain
            enforcement. Size positions accordingly.
          </p>
          <div className={styles.securityAuditLinks}>
            <Link href="/legal">Risk disclosures</Link>
            <Link href="/docs#security">Security model</Link>
          </div>
        </div>
      </aside>
    </div>
  );
}
