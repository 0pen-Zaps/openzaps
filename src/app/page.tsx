import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import { BuyButton } from "@/components/BuyButton";
import { JsonLd } from "@/components/JsonLd";
import { TOKEN, TOKEN_LAUNCH, LINKS, CHAIN, CONTRACTS, contractsLive, explorer } from "@/lib/config";
import { POLICY_TEMPLATES } from "@/lib/policy";
import { absoluteUrl } from "@/lib/seo";
import styles from "./page.module.css";

const stats = [
  { v: "0", k: "Broad wallet approvals" },
  { v: "4", k: "Policy templates" },
  { v: "63 / 0", k: "Contract tests passing / failing" },
  { v: "9 / 9", k: "Internal findings fixed" },
] as const;

const authorityModels = [
  {
    label: "01 / Deposit",
    title: "Pre-funded immutable zap",
    body: "Assets sit inside a narrow policy capsule. Hermes triggers only the frozen action graph; you keep an unconditional withdraw and revocation path.",
    grade: "Recurring automation",
  },
  {
    label: "02 / Signature",
    title: "EIP-712 typed intent",
    body: "One-shot authority binds chain, zap, nonce, deadline, recipient, fee cap, gas, and policy hash before any relayer touches it.",
    grade: "Infrequent execution",
  },
  {
    label: "03 / Wallet-native",
    title: "Safe / ERC-1271 signer",
    body: "Contract wallets sign the same typed policy. Hermes stays a submitter, simulator, and monitor — never an operator with discretion.",
    grade: "Power users",
  },
] as const;

const security = [
  "No arbitrary target + calldata — fixed adapters only",
  "Exact approvals, reset to zero on every path",
  "Authorization consumed before any external call",
  "Measured balance-delta postconditions",
  "Unconditional owner emergency exit",
  "ERC-1271 contract-wallet signatures",
] as const;

const flow = [
  {
    label: "01 / Draft",
    title: "Choose a reusable policy template",
    body: "Start from DCA, pool deposit, claim-and-compound, or a gated guarded-exit design. Every template has explicit production status.",
    grade: "Policy versioning",
  },
  {
    label: "02 / Simulate",
    title: "Review checks before signing",
    body: "See slippage, spend ceilings, postconditions, submitter scope, human approval gates, and simulation diffs before any wallet prompt.",
    grade: "Wallet checkpoint",
  },
  {
    label: "03 / Operate",
    title: "Monitor, pause, revoke, and export",
    body: "Each capsule exposes onchain receipts, consumed nonces, scoped balances, and an owner-only recovery path.",
    grade: "Audit trail",
  },
] as const;

const faqs = [
  {
    q: "What is OpenZaps?",
    a: "OpenZaps turn approved DeFi workflows into sealed policy capsules. A Hermes agent can simulate, submit, monitor, and revoke them, but it cannot choose arbitrary targets, recipients, assets, or calldata.",
  },
  {
    q: "How is this different from giving an agent my wallet?",
    a: "The agent never holds broad approvals or custody. Authority is bound inside an EIP-712-signed policy — chain, spend ceiling, recipient, deadline, and postconditions — and the owner always keeps an unconditional revoke and exit path.",
  },
  {
    q: `Is the ${TOKEN.symbol} token live?`,
    a: `Yes. ${TOKEN.symbol} is live on ${TOKEN_LAUNCH.network} through a creator-verified ${TOKEN_LAUNCH.venue} ${TOKEN_LAUNCH.version} market. Verify the contract address published on this site before trading.`,
  },
  {
    q: `Do I need ${TOKEN.symbol} to use the protocol?`,
    a: "No — nothing is token-gated. The token aligns the community and operators around the execution layer. Robinhood mainnet actions remain wallet-confirmed and the v1.1 contracts are pre-external-audit.",
  },
  {
    q: "Are the contracts audited?",
    a: "The v1.1 contracts are a complete, internally reviewed reference implementation — 63 passing tests, 9 internal findings fixed — but are pre-external-audit. Treat anything onchain accordingly.",
  },
] as const;

// Derived from the same `faqs` array that renders the visible FAQ, so the structured data
// can never drift from on-page copy (a Google FAQPage requirement).
const homeFaqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": absoluteUrl("/#faq"),
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

const agentLoop = [
  "Discover registry events",
  "Verify signatures + bytecode",
  "Simulate latest state",
  "Submit privately when sensitive",
  "Monitor receipts + approvals",
  "Revoke or escalate anomalies",
] as const;

export default function Home(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      {/* ---------------- hero ---------------- */}
      <section className={`container ${styles.hero}`} id="top">
        <div className={styles.heroCopy}>
          <span className="badge">Bounded execution for agent-native DeFi</span>
          <h1 className={styles.title}>
            <span>Policy capsules</span>
            <span>for agents that</span>
            <span className="gradientText">cannot freelance.</span>
          </h1>
          <p className={styles.lead}>
            OpenZaps turn approved DeFi workflows into sealed policy capsules. Hermes can simulate, submit,
            monitor, alert, and revoke, but it cannot choose arbitrary targets, recipients, assets, or calldata.
          </p>
          <div className={styles.actions}>
            <Link href="/app" className="btn btnGhost btnLg">
              Open policy console
            </Link>
            <Link href="/docs" className="btn btnPrimary btnLg">
              Read docs
            </Link>
            <BuyButton size="lg" variant="ghost" />
          </div>
          <div className={styles.launchNotice} aria-label={`${TOKEN.symbol} live token details`}>
            <strong>${TOKEN.symbol} live</strong>
            <span>
              {TOKEN_LAUNCH.venue} {TOKEN_LAUNCH.version} · {TOKEN_LAUNCH.network}
            </span>
            <a href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
              CA {TOKEN_LAUNCH.contract} ↗
            </a>
          </div>
          <div className={styles.proof}>
            <span>ERC-20 first</span>
            <span>EIP-712 intents</span>
            <span>ERC-1271 ready</span>
            <span>Revocable policies</span>
            <span>Private orderflow</span>
          </div>
        </div>

        <div className={styles.heroVisual} aria-hidden="true">
          <div className={styles.orbit}>
            <OpenZapMark className={styles.orbitMark} />
            <span className={styles.node1}>policy hash</span>
            <span className={styles.node2}>zero residual approvals</span>
          </div>
          <div className={styles.execCard}>
            <div className={styles.execTop}>
              <OpenZapMark className={styles.execMark} />
              <strong>policy.review()</strong>
              <span className={styles.live}>{contractsLive() ? "gated" : "preview"}</span>
            </div>
            <pre>
              {[
                "draft(template)           pass",
                "simulate(latestBlock)     pass",
                "diff(policyVersion)       pass",
                "bind(spend, recipient)    pass",
                "submit(privateChannel)    gated",
                "revoke(ownerPath)         ready",
              ].map((line) => (
                <span className={styles.execLine} key={line}>
                  {line}
                </span>
              ))}
              <span className={styles.caret} aria-hidden />
            </pre>
            <div className={styles.route}>
              <span>You</span>
              <i />
              <span>Zap</span>
              <i />
              <span>Allowed protocols</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- live fact ticker ---------------- */}
      <div className={styles.ticker} aria-hidden="true">
        <div className={styles.tickerTrack}>
          {[0, 1].map((n) => (
            <div className={styles.tickerGroup} key={n}>
              <span>${TOKEN.symbol} live</span>
              <i>⚡</i>
              <span>
                {TOKEN_LAUNCH.venue} {TOKEN_LAUNCH.version}
              </span>
              <i>⚡</i>
              <span>{TOKEN_LAUNCH.network}</span>
              <i>⚡</i>
              <span className={styles.tickerCa}>CA {TOKEN_LAUNCH.contract}</span>
              <i>⚡</i>
              <span>Zero discretionary approvals</span>
              <i>⚡</i>
              <span>Simulate → submit → monitor → revoke</span>
              <i>⚡</i>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- stat strip ---------------- */}
      <section className={`container ${styles.statStrip}`}>
        {stats.map((s) => (
          <div className={styles.stat} key={s.k}>
            <strong>{s.v}</strong>
            <span>{s.k}</span>
          </div>
        ))}
      </section>

      {/* ---------------- token band ---------------- */}
      <section className={`container ${styles.tokenBand}`}>
        <div className={styles.tokenMark}>
          <OpenZapMark />
          <span className={styles.tokenTicker}>{TOKEN.symbol}</span>
        </div>
        <div>
          <p className={styles.tokenLead}>
            ${TOKEN.symbol} is live through a creator-verified Clanker V4 market on {TOKEN_LAUNCH.network}. It is the
            community and operator coordination token for OpenZaps; the protocol remains usable without treating the
            token as yield, equity, or a fee claim.
          </p>
          <div className={styles.tokenActions}>
            <BuyButton />
            <a href={LINKS.dexscreener} className="btn btnGhost" target="_blank" rel="noreferrer">
              Dexscreener ↗
            </a>
            <a href={LINKS.tokenExplorer} className="btn btnGhost" target="_blank" rel="noreferrer">
              View contract ↗
            </a>
            <Link href="/token" className="btn btnGhost">
              Tokenomics →
            </Link>
          </div>
        </div>
      </section>

      <section className={`container ${styles.section}`} id="workflow">
        <header className={styles.head}>
          <span className="eyebrow">Product flow</span>
          <h2>Every useful automation starts as a reviewable policy.</h2>
          <p>
            The app is a production review console first: template selection, bounded policy design, simulation checks,
            audit history, and revoke controls before the wallet integration is allowed to touch mainnet funds.
          </p>
        </header>
        <div className={styles.modelGrid}>
          {flow.map((step) => (
            <article className={styles.modelCard} key={step.title}>
              <span className={styles.modelLabel}>{step.label}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <strong>{step.grade}</strong>
            </article>
          ))}
        </div>
      </section>

      {/* ---------------- protocol ---------------- */}
      <section className={`container ${styles.section}`} id="protocol">
        <header className={styles.head}>
          <span className="eyebrow">Authority model</span>
          <h2>Execution authority must live somewhere explicit.</h2>
          <p>
            OpenZaps split creation, execution, and submission authority so you can walk away without handing an
            agent broad approvals or custody. Pick the surface that fits the workflow.
          </p>
        </header>
        <div className={styles.modelGrid}>
          {authorityModels.map((m) => (
            <article className={styles.modelCard} key={m.title}>
              <span className={styles.modelLabel}>{m.label}</span>
              <h3>{m.title}</h3>
              <p>{m.body}</p>
              <strong>{m.grade}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className={`container ${styles.section}`} id="templates">
        <header className={styles.head}>
          <span className="eyebrow">Reusable templates</span>
          <h2>Start narrow. Expand only after the controls hold.</h2>
          <p>
            The live route starts with one exact Robinhood pool and a fixed adapter. Broader templates remain gated
            until their adapters and tokens receive the same review and fork coverage.
          </p>
        </header>
        <div className={styles.modelGrid}>
          {POLICY_TEMPLATES.map((template) => (
            <article className={styles.modelCard} key={template.id}>
              <span className={styles.modelLabel}>{template.production.replace("-", " ")}</span>
              <h3>{template.name}</h3>
              <p>{template.description}</p>
              <strong>{template.category}</strong>
            </article>
          ))}
        </div>
      </section>

      {/* ---------------- security ---------------- */}
      <section className={`container ${styles.section} ${styles.security}`} id="security">
        <div>
          <span className="eyebrow">Security posture</span>
          <h2>Narrow policy beats universal routing.</h2>
          <p>
            The v1.1 contracts are a complete, internally-reviewed reference implementation: 63 passing tests, an
            adversarial multi-agent review, and 9 internal findings fixed — including a critical clone-hijack
            (all documented in the linked repo). Not externally audited; we say so plainly.
          </p>
          <div className={styles.checkGrid}>
            {security.map((c) => (
              <div className={styles.check} key={c}>
                <span>✓</span>
                {c}
              </div>
            ))}
          </div>
          <a className={styles.repoLink} href={LINKS.github} target="_blank" rel="noreferrer">
            Read the contracts + internal review on GitHub ↗
          </a>
          <br />
          <Link className={styles.repoLink} href="/security">
            Security architecture →
          </Link>
          {contractsLive() && (
            <p className={styles.deployed}>
              <span className={styles.liveDot} aria-hidden /> v1.1 production contracts deployed on {CHAIN.name} ·{" "}
              <a href={explorer(CONTRACTS.factory)} target="_blank" rel="noreferrer">
                factory {CONTRACTS.factory.slice(0, 6)}…{CONTRACTS.factory.slice(-4)} ↗
              </a>
            </p>
          )}
        </div>
        <aside className={styles.agentCard}>
          <div className={styles.agentHead}>Hermes execution loop</div>
          {agentLoop.map((item, i) => (
            <div className={styles.loopRow} key={item}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </aside>
      </section>

      {/* ---------------- faq ---------------- */}
      <section className={`container ${styles.section}`} id="faq">
        <JsonLd data={homeFaqJsonLd} />
        <header className={styles.head}>
          <span className="eyebrow">FAQ</span>
          <h2>Straight answers.</h2>
        </header>
        <div className={styles.faqs}>
          {faqs.map((f) => (
            <details className={styles.faq} key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ---------------- final CTA ---------------- */}
      <section className={`container ${styles.cta}`}>
        <div className={styles.ctaInner}>
          <OpenZapMark className={styles.ctaMark} />
          <h2>
            Build the policy first. Let agents act second.
          </h2>
          <p>Connect a wallet to quote, deploy, fund, sign, execute, verify, and recover a bounded zap.</p>
          <div className={styles.actions}>
            <Link href="/app" className="btn btnGhost btnLg">
              Open policy console
            </Link>
            <Link href="/roadmap" className="btn btnPrimary btnLg">
              Roadmap
            </Link>
          </div>
          <p className={styles.ctaNote}>
            Not financial advice. {TOKEN.symbol} is a community token with no claim on revenue, yield, or
            assets; onchain actions are irreversible and the protocol is pre-external-audit.
          </p>
        </div>
      </section>
    </main>
  );
}
