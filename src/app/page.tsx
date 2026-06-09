import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import { BuyButton } from "@/components/BuyButton";
import { TOKEN, LINKS, CHAIN, CONTRACTS, contractsLive, explorer } from "@/lib/config";
import styles from "./page.module.css";

const stats = [
  { v: TOKEN.symbol, k: "Launching on pool.fans" },
  { v: "0", k: "Discretionary approvals" },
  { v: "47 / 0", k: "Tests passing / failing" },
  { v: "9 / 9", k: "Audit findings fixed" },
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
          <span className="badge">⚡ Launching {TOKEN.symbol} on pool.fans</span>
          <h1 className={styles.title}>
            <span>Bounded onchain</span>
            <span>automation, with a</span>
            <span className="gradientText">token to match.</span>
          </h1>
          <p className={styles.lead}>
            OpenZaps turn approved DeFi workflows into sealed, immutable policy capsules a Hermes agent can
            simulate, submit, monitor, and revoke — without ever holding discretionary wallet authority.{" "}
            <strong>{TOKEN.symbol}</strong> is the token for it.
          </p>
          <div className={styles.actions}>
            <BuyButton size="lg" />
            <Link href="/app" className="btn btnGhost btnLg">
              Open the app
            </Link>
          </div>
          <div className={styles.proof}>
            <span>ERC-20 first</span>
            <span>EIP-712 intents</span>
            <span>ERC-1271 ready</span>
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
              <strong>0xzap.execute()</strong>
              <span className={styles.live}>{contractsLive() ? "live" : "preview"}</span>
            </div>
            <pre>{`verify(policyHash)        ✓
consume(nonce)            ✓
approveExact → swap → 0   ✓
assert(minOut, recipient) ✓
submit(privateChannel)    ⧗
monitor(receipt)`}</pre>
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
            One token aligns the people who run, secure, and build zaps. Launching fair on the{" "}
            <strong>pool.fans</strong> tokenizer — no private allocation games.
          </p>
          <div className={styles.tokenActions}>
            <BuyButton />
            <Link href="/token" className="btn btnGhost">
              Tokenomics →
            </Link>
          </div>
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

      {/* ---------------- security ---------------- */}
      <section className={`container ${styles.section} ${styles.security}`} id="security">
        <div>
          <span className="eyebrow">Security posture</span>
          <h2>Narrow policy beats universal routing.</h2>
          <p>
            The v1 contracts are a complete, internally-reviewed reference implementation: 47 passing tests, an
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
            Read the contracts + audit on GitHub ↗
          </a>
          {contractsLive() && (
            <p className={styles.deployed}>
              <span className={styles.liveDot} aria-hidden /> v1 contracts live on {CHAIN.name} mainnet ·{" "}
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

      {/* ---------------- final CTA ---------------- */}
      <section className={`container ${styles.cta}`}>
        <div className={styles.ctaInner}>
          <OpenZapMark className={styles.ctaMark} />
          <h2>
            Get <span className="gradientText">{TOKEN.symbol}</span>. Run the zaps.
          </h2>
          <p>Buy on pool.fans, then open the app to build your first immutable intent locker.</p>
          <div className={styles.actions}>
            <BuyButton size="lg" />
            <Link href="/app" className="btn btnGhost btnLg">
              Open the app
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
