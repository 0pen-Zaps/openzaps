import Link from "next/link";
import { CHAIN, CONTRACTS, LINKS, STATUS, explorer } from "@/lib/config";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  title: "Security architecture",
  description:
    "What an OpenZaps capsule refuses to do, what an executor could still try, and what has not been reviewed. The v1.1 contracts are live on Robinhood Chain and have not been externally audited.",
  path: "/security",
  ogImage: "/og/security.png",
  keywords: ["OpenZaps security", "DeFi threat model", "smart contract security architecture"],
});

const controls = [
  ["No arbitrary calls", "The capsule calls an allowlisted adapter with the selector the policy names. There is no field for an arbitrary target plus calldata, so there is nothing to point at one."],
  ["Nonce consumed first", "The authorization is consumed before any external call. A reentrant call back into the capsule finds the nonce already spent."],
  ["Exact approvals", "The approval is the exact step amount, and it is reset to zero on the success path and the revert path. No standing allowance is left for anyone to draw on later."],
  ["Balance-delta checks", "After the adapter returns, the capsule asserts the tracked output asset, the recipient, the minimum output, and that no allowance remains. A failed assertion reverts the whole execution."],
  ["Submitter is not bound", "The v1.1 policy has no submitter field, so whoever executes the capsule chooses the mempool path. The live bounded route is submitted from the owner's own wallet."],
  ["Owner revoke", "The owner can pause, invalidate nonce space, or emergency-exit without an agent. The withdraw and revoke path is unconditional and needs no one else's cooperation."],
] as const;

const gates = [
  ["External audit", "Independent review of factory, clone init, EIP-712/1271 verification, approval reset, and adapter boundaries."],
  ["Formal checks", "A prover run over the authorization, approval-reset, call-surface, recipient, isolation, and token-allowlist invariants."],
  ["Adapter governance", "Safe plus timelock ownership, adapter bytecode manifests, and a rollback process."],
  ["Testnet soak", "Public testnet with real wallet review, alerts, receipts, and revoke drills."],
  ["Incident runbook", "Emergency pause, disclosure process, chain-monitor alerts, and postmortem template."],
] as const;

const threats = [
  ["MEV / sandwiching", "A searcher who sees the pending execution can move the pool price against it. The signed minimum output and the ten-minute intent deadline bound what that is worth; the capsule cannot hide the transaction, because the policy cannot bind a submitter."],
  ["Approval leakage", "An adapter that kept an allowance could spend from the capsule again later. The approval is the exact step amount and is reset to zero on both paths, and a residual allowance fails the postcondition."],
  ["Scope drift", "A submitter who edits a policy field before broadcasting produces a different policy hash, and the capsule rejects the intent. A chain-aware nonce and the typed-data domain make an intent signed elsewhere useless here."],
  ["Relayer optionality", "A relayer can delay, censor, or pick a bad moment inside the signed limits. It cannot take a fee on the live route: the policy commits a relayer fee cap of zero. The owner can always submit the transaction themselves."],
  ["Oracle manipulation", "The v1.1 policy has no oracle precondition, so a design that depends on a price band is not enforced by it. Protective exits stay blocked in v1 for that reason."],
] as const;

export default function SecurityPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/security", "Security architecture") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Security architecture</span>
          <h1>What an executor cannot choose.</h1>
          <p>
            A capsule holds funds and accepts owner-signed intents that rehash to the policy frozen at creation. The
            adapter, the spender, the recipient, the input token, and the exact amount are fixed at that moment. An
            executor picks the moment and nothing else. The contracts have not been externally audited.
          </p>
          <div className={styles.heroActions}>
            <Link className="btn btnPrimary btnLg" href="/app">
              Open the console
            </Link>
            <a className="btn btnGhost btnLg" href={LINKS.contractSource} target="_blank" rel="noreferrer">
              Read contracts
            </a>
          </div>
        </div>
        <aside className={styles.heroCard}>
          <span>Audit status</span>
          <strong>{STATUS.preAudit ? "Live, not externally audited" : "Externally audited"}</strong>
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
            <strong>The contracts have not been externally audited.</strong>
            <p>
              Bounded aeWETH ↔ 0xZAPS creation is open on {CHAIN.name}, and the funds a capsule holds are real.
              Production use still needs external audit, formal verification, adapter governance, and a monitored
              launch path. Onchain actions are irreversible: once an execution lands, nothing here can undo it. The
              owner keeps an unconditional withdraw and revoke path. Deposit only what you can afford to lose.
            </p>
          </section>

          <section className={styles.section} id="architecture">
            <h2>Architecture</h2>
            <p>
              A user or Safe creates a per-policy capsule through the factory. The capsule holds the funds. It accepts
              owner-signed intents, and only those that rehash to the policy hash frozen at creation. Whoever submits
              cannot choose the target, the recipient, the asset, or the calldata, because the policy already named
              them and any substitution changes the hash. Today that submitter is the owner, from their own wallet.
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
              {controls.map(([name, detail], i) => (
                <Reveal className={styles.row} delay={i * 45} key={name}>
                  <strong>{name}</strong>
                  <p>{detail}</p>
                </Reveal>
              ))}
            </div>
          </section>

          <section className={styles.section} id="threats">
            <h2>Threat model</h2>
            <div className={styles.table}>
              {threats.map(([name, detail], i) => (
                <Reveal className={styles.row} delay={i * 45} key={name}>
                  <strong>{name}</strong>
                  <p>{detail}</p>
                </Reveal>
              ))}
            </div>
          </section>

          <section className={styles.section} id="gates">
            <h2>Production gates</h2>
            <p>
              None of the following has completed. Each one is a precondition for calling the contracts
              production-cleared. Until they have, the only thing standing behind a failure in the contract, the
              interface, the relayer path, or the adapter registry is the owner&apos;s exit.
            </p>
            <div className={styles.timeline}>
              {gates.map(([name, body], index) => (
                <Reveal className={styles.phase} delay={index * 45} key={name}>
                  <span>P{index}</span>
                  <div>
                    <h3>{name}</h3>
                    <p>{body}</p>
                  </div>
                </Reveal>
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
              <a className="btn btnGhost" href={LINKS.contractSource} target="_blank" rel="noreferrer">
                Contract source
              </a>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
