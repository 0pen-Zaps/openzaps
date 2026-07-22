import Link from "next/link";
import { CHAIN, CONTRACTS, LINKS, STATUS, explorer } from "@/lib/config";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  title: "Security architecture",
  description:
    "OpenZaps security architecture, threat model, production-readiness gates, revocation controls, adapter governance, and audit status.",
  path: "/security",
  ogImage: "/og/security.png",
  keywords: ["OpenZaps security", "DeFi threat model", "smart contract security architecture"],
});

const controls = [
  ["No arbitrary calls", "Execution is restricted to governed adapters and known selectors; not a universal router."],
  ["Nonce consumed first", "Authorization is consumed before external calls to narrow replay and reentrancy surfaces."],
  ["Exact approvals", "Approvals are scoped to the exact step amount and reset to zero on success and revert paths."],
  ["Balance-delta checks", "Postconditions assert tracked output assets, recipient, min-out, and residual allowance."],
  ["Private submission", "Price-sensitive routes can use private orderflow after late-block simulation."],
  ["Owner revoke", "The owner can pause, invalidate nonce space, or emergency-exit without Hermes."],
] as const;

const gates = [
  ["External audit", "Independent review of factory, clone init, EIP-712/1271 verification, approval reset, and adapter boundaries."],
  ["Formal checks", "Certora or equivalent prover run for AUTH, APPR, SURF, REC, ISO, and TOK invariants."],
  ["Adapter governance", "Safe plus timelock ownership, adapter bytecode manifests, and rollback process."],
  ["Testnet soak", "Public testnet with real wallet review, alerts, receipts, and revoke drills."],
  ["Incident runbook", "Emergency pause, disclosure process, chain-monitor alerts, and postmortem template."],
] as const;

const threats = [
  ["MEV / sandwiching", "Private submission, strict min-out, short deadlines, and public receipt review."],
  ["Approval leakage", "Exact approvals, zero reset, post-exec allowance checks, and emergency exit."],
  ["Scope drift", "Policy hash, adapter allowlist, chain-aware nonce, and typed intent domain."],
  ["Relayer optionality", "Fee caps, allowed submitters, self-submit fallback, and human approval gates."],
  ["Oracle manipulation", "Liquidity floors, TWAP sanity checks, and blocked protective zaps until review."],
] as const;

export default function SecurityPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/security", "Security architecture") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Security architecture</span>
          <h1>The product is the boundary.</h1>
          <p>
            OpenZaps does not sell invisible autonomy. It sells explicit execution limits: fixed adapters, spend caps,
            postconditions, private submission, wallet-reviewed policies, and owner revoke paths.
          </p>
          <div className={styles.heroActions}>
            <Link className="btn btnPrimary btnLg" href="/app">
              Test policy flow
            </Link>
            <a className="btn btnGhost btnLg" href={LINKS.github} target="_blank" rel="noreferrer">
              Read contracts
            </a>
          </div>
        </div>
        <aside className={styles.heroCard}>
          <span>Security status</span>
          <strong>{STATUS.preAudit ? "Pre-audit, gated" : "Audit-cleared"}</strong>
        </aside>
      </section>

      <section className={`container ${styles.grid}`}>
        <nav className={styles.toc} aria-label="Security sections">
          <a href="#architecture">Architecture</a>
          <a href="#controls">Controls</a>
          <a href="#threats">Threat model</a>
          <a href="#gates">Production gates</a>
          <a href="#contracts">Contracts</a>
        </nav>

        <div className={styles.content}>
          <section className={styles.callout}>
            <span>Current posture</span>
            <strong>Contracts are deployed on {CHAIN.name}, but real-fund creation is not production-cleared.</strong>
            <p>
              The repo contains a reference implementation and tests. Production use still needs external audit,
              formal verification, adapter governance, and a monitored launch path.
            </p>
          </section>

          <section className={styles.section} id="architecture">
            <h2>Architecture</h2>
            <p>
              A user or Safe creates a per-policy capsule through the factory. The capsule holds funds and accepts only
              owner-signed intents that match the frozen policy hash. Hermes can simulate, submit, monitor, and alert,
              but cannot choose arbitrary targets, recipients, assets, or calldata.
            </p>
            <div className={styles.codeBlock}>
              <pre>{`User / Safe
  -> OpenZapFactory
  -> OpenZap clone with frozen policy
  -> allowlisted adapter
  -> recipient-bound postcondition

Hermes:
  simulate -> submit -> monitor -> alert -> revoke escalation
  no discretionary custody
  no arbitrary calldata`}</pre>
            </div>
          </section>

          <section className={styles.section} id="controls">
            <h2>Controls</h2>
            <div className={styles.table}>
              {controls.map(([name, detail]) => (
                <div className={styles.row} key={name}>
                  <strong>{name}</strong>
                  <p>{detail}</p>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.section} id="threats">
            <h2>Threat model</h2>
            <div className={styles.table}>
              {threats.map(([name, detail]) => (
                <div className={styles.row} key={name}>
                  <strong>{name}</strong>
                  <p>{detail}</p>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.section} id="gates">
            <h2>Production gates</h2>
            <p>
              Production-ready means the system fails closed across contract, interface, relayer, governance, monitoring,
              and incident-response layers. These gates are intentionally visible in the product.
            </p>
            <div className={styles.timeline}>
              {gates.map(([name, body], index) => (
                <article className={styles.phase} key={name}>
                  <span>P{index}</span>
                  <div>
                    <h3>{name}</h3>
                    <p>{body}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.section} id="contracts">
            <h2>Contracts</h2>
            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span>Factory</span>
                <strong>{CONTRACTS.factory.slice(0, 8)}...</strong>
              </div>
              <div className={styles.metric}>
                <span>Adapter registry</span>
                <strong>{CONTRACTS.adapterRegistry.slice(0, 8)}...</strong>
              </div>
              <div className={styles.metric}>
                <span>Token allowlist</span>
                <strong>{CONTRACTS.tokenAllowlist.slice(0, 8)}...</strong>
              </div>
            </div>
            <div className={styles.heroActions}>
              <a className="btn btnGhost" href={explorer(CONTRACTS.factory)} target="_blank" rel="noreferrer">
                View factory
              </a>
              <a className="btn btnGhost" href={`${LINKS.github}/tree/main/contracts`} target="_blank" rel="noreferrer">
                Contract source
              </a>
              <a className="btn btnGhost" href={`${LINKS.github}/blob/main/docs/invariant-spec.md`} target="_blank" rel="noreferrer">
                Invariant spec
              </a>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
