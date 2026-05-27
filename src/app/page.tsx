import styles from "./page.module.css";

const authorityModels = [
  {
    label: "Deposit-based",
    title: "Pre-funded immutable zap",
    body: "Assets sit inside a narrow policy capsule. Hermes can trigger only the frozen action graph; the user keeps the ability to withdraw or revoke by policy.",
    grade: "Best for recurring automation",
  },
  {
    label: "Signature-based",
    title: "EIP-712 typed intent",
    body: "One-shot signed authority binds chain, zap, nonce, deadline, recipient, fee cap, policy hash, inputs, and outputs.",
    grade: "Best for infrequent execution",
  },
  {
    label: "Wallet-native",
    title: "Safe / ERC-4337 policy",
    body: "Smart-account validation enforces policy while Hermes acts as submitter, simulator, and monitor rather than a discretionary operator.",
    grade: "Best for power users",
  },
] as const;

const safetyChecks = [
  "No arbitrary target + calldata",
  "Fixed adapters and selectors",
  "Exact approvals with zero reset",
  "Nonce consumed before external calls",
  "Private submission for AMM routes",
  "Balance-delta postconditions",
  "ERC-1271 contract-wallet signatures",
  "Revocation and withdrawal paths",
] as const;

const roadmap = [
  ["P0", "Freeze authority model", "Pick deposit, signed-intent, or wallet-native as the first execution surface."],
  ["P0", "ERC-20 only", "Avoid NFT operator approvals, safe-transfer callbacks, and multi-asset accounting in v1."],
  ["P0", "Compile fixed adapters", "Preserve immutability by making every call target and selector knowable before deploy."],
  ["P1", "Private submission", "Route price-sensitive execution through private orderflow after late-block simulation."],
  ["P2", "Invariant proof pack", "SMTChecker, fuzz invariants, bytecode hash manifests, and audit-ready postconditions."],
] as const;

const threatRows = [
  ["MEV / sandwiching", "Private submission, strict min-out, short deadlines"],
  ["Replay / scope drift", "EIP-712 domains, consumed digests, chain-aware nonces"],
  ["Approval leakage", "Exact approvals, immediate zero reset, residual allowance checks"],
  ["Oracle manipulation", "TWAP / external sanity bounds, liquidity floors, circuit breakers"],
  ["Relayer optionality", "Fee caps, allowed relayers, self-submit fallback, escalation rules"],
] as const;

export default function Home(): React.JSX.Element {
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="Primary navigation">
        <a className={styles.brand} href="#top" aria-label="OpenZaps home">
          <span className={styles.brandMark}>OZ</span>
          <span>OpenZaps</span>
        </a>
        <div className={styles.navLinks}>
          <a href="#model">Model</a>
          <a href="#safety">Safety</a>
          <a href="#hermes">Hermes</a>
          <a href="#roadmap">Roadmap</a>
        </div>
        <a className={styles.navCta} href="#roadmap">Prototype scope</a>
      </nav>

      <section id="top" className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>Hermes-triggered DeFi execution</div>
          <h1>Immutable intent lockers for agent-triggered DeFi.</h1>
          <p className={styles.heroLead}>
            OpenZaps turn user-approved DeFi workflows into narrow, immutable policy capsules that agents can simulate,
            submit, monitor, and revoke without ever gaining discretionary wallet authority.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryButton} href="#model">Study the model</a>
            <a className={styles.secondaryButton} href="#safety">Threat matrix</a>
          </div>
          <div className={styles.proofStrip}>
            <span>ERC-20 first</span>
            <span>EIP-712 intents</span>
            <span>ERC-1271 ready</span>
            <span>Private orderflow by default</span>
          </div>
        </div>

        <div className={styles.terminalCard} aria-label="OpenZap execution preview">
          <div className={styles.terminalTop}>
            <span />
            <span />
            <span />
            <strong>policy-preview.json</strong>
          </div>
          <pre>{`{
  "zap": "immutable-clone",
  "authority": "pre-committed",
  "agent": "submitter + simulator",
  "adapters": "fixed",
  "arbitraryCalls": false,
  "postconditions": ["minOut", "recipient", "zeroApproval"],
  "submission": "private-if-price-sensitive"
}`}</pre>
          <div className={styles.routeGraph}>
            <span>User</span>
            <i />
            <span>Factory</span>
            <i />
            <span>Zap</span>
            <i />
            <span>Allowed protocols</span>
          </div>
        </div>
      </section>

      <section className={styles.statement}>
        <p>
          The product is not “approval-free.” The product is <strong>pre-committed, tightly bounded authority</strong> for a
          fixed action graph. That clarity is the security boundary.
        </p>
      </section>

      <section id="model" className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Authority model</div>
          <h2>Execution authority must live somewhere explicit.</h2>
          <p>
            OpenZaps split creation authority, execution authority, and submission authority so the user can walk away
            without handing Hermes broad approvals or custody.
          </p>
        </div>
        <div className={styles.modelGrid}>
          {authorityModels.map((model) => (
            <article className={styles.modelCard} key={model.title}>
              <span>{model.label}</span>
              <h3>{model.title}</h3>
              <p>{model.body}</p>
              <strong>{model.grade}</strong>
            </article>
          ))}
        </div>
      </section>

      <section id="safety" className={`${styles.section} ${styles.splitSection}`}>
        <div>
          <div className={styles.eyebrow}>Safety posture</div>
          <h2>Narrow policy beats universal routing.</h2>
          <p>
            The strongest v1 is not a generic execution engine. It is an ERC-20-first policy capsule with frozen adapters,
            selectors, recipients, tracked assets, nonce rules, and postconditions.
          </p>
          <div className={styles.checkGrid}>
            {safetyChecks.map((check) => (
              <div className={styles.check} key={check}>
                <span>✓</span>
                {check}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.matrixCard}>
          <div className={styles.cardHeader}>Threat model</div>
          {threatRows.map(([threat, mitigation]) => (
            <div className={styles.threatRow} key={threat}>
              <span>{threat}</span>
              <p>{mitigation}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="hermes" className={styles.agentSection}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Hermes role</div>
          <h2>A bounded execution and safety agent, not an autonomous trader.</h2>
          <p>
            Hermes discovers eligible zaps, validates policy, simulates exact calldata, submits through the safest channel,
            monitors settlement, and escalates when policy or market state diverges.
          </p>
        </div>
        <div className={styles.agentLoop}>
          {[
            "Discover registry events",
            "Verify signatures + bytecode",
            "Simulate latest state",
            "Submit privately when sensitive",
            "Monitor receipts + approvals",
            "Revoke or escalate anomalies",
          ].map((item, index) => (
            <div className={styles.loopNode} key={item}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </div>
      </section>

      <section id="roadmap" className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Prototype checklist</div>
          <h2>Reduce scope until the security story is legible.</h2>
          <p>
            A credible first slice: immutable clone instances, fixed adapters, EIP-712 + ERC-1271 support, no arbitrary
            calls, private submission by default, and invariant-driven tests.
          </p>
        </div>
        <div className={styles.roadmap}>
          {roadmap.map(([priority, title, detail]) => (
            <div className={styles.roadmapRow} key={title}>
              <span>{priority}</span>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <div>
          <strong>OpenZaps</strong>
          <p>Immutable intent capsules for Hermes-triggered DeFi.</p>
        </div>
        <p>Built from the OpenZaps research report. No live protocol, token, TVL, or audit claims are implied.</p>
      </footer>
    </main>
  );
}
