import styles from "./page.module.css";

const authorityModels = [
  {
    label: "01 / Deposit",
    title: "Pre-funded immutable zap",
    body: "Assets sit inside a narrow policy capsule. Hermes can trigger only the frozen action graph; the user keeps withdraw and revocation paths defined by policy.",
    grade: "Recurring automation",
  },
  {
    label: "02 / Signature",
    title: "EIP-712 typed intent",
    body: "One-shot authority binds chain, zap, nonce, deadline, recipient, fee cap, policy hash, inputs, and outputs before any relayer touches it.",
    grade: "Infrequent execution",
  },
  {
    label: "03 / Wallet-native",
    title: "Safe / ERC-4337 policy",
    body: "Smart-account validation enforces the policy while Hermes acts as submitter, simulator, monitor, and escalation layer — not an operator with discretion.",
    grade: "Power users",
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

const agentLoop = [
  "Discover registry events",
  "Verify signatures + bytecode",
  "Simulate latest state",
  "Submit privately when sensitive",
  "Monitor receipts + approvals",
  "Revoke or escalate anomalies",
] as const;

function OpenZapMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id="openzap-ring" x1="96" y1="64" x2="416" y2="448" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8EA0FF" />
          <stop offset="0.5" stopColor="#6B5CFF" />
          <stop offset="1" stopColor="#21D07A" />
        </linearGradient>
        <linearGradient id="openzap-bolt" x1="305" y1="108" x2="188" y2="410" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F7F8F8" />
          <stop offset="0.48" stopColor="#C8D0FF" />
          <stop offset="1" stopColor="#37F09A" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="#08090A" />
      <path
        d="M257 74C357.516 74 439 155.484 439 256C439 356.516 357.516 438 257 438C156.484 438 75 356.516 75 256C75 175.835 126.851 107.779 198.866 83.521"
        stroke="url(#openzap-ring)"
        strokeWidth="38"
        strokeLinecap="round"
      />
      <path d="M342 68L407 111" stroke="#08090A" strokeWidth="54" strokeLinecap="round" />
      <path
        d="M302 104L169 277H244L207 410L346 223H265L302 104Z"
        fill="url(#openzap-bolt)"
        stroke="#08090A"
        strokeWidth="18"
        strokeLinejoin="round"
      />
      <path
        d="M302 104L169 277H244L207 410L346 223H265L302 104Z"
        stroke="rgba(255,255,255,0.72)"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <circle cx="141" cy="142" r="10" fill="#37F09A" />
      <circle cx="374" cy="365" r="7" fill="#8EA0FF" />
    </svg>
  );
}

export default function Home(): React.JSX.Element {
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="Primary navigation">
        <a className={styles.brand} href="#top" aria-label="OpenZaps home">
          <OpenZapMark className={styles.brandMark} />
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

      <section id="top" className={`${styles.container} ${styles.hero}`}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>Hermes-triggered DeFi execution</div>
          <h1 aria-label="Immutable intent lockers for agent-triggered DeFi.">
            <span>Immutable intent</span>{" "}
            <span>lockers for</span>{" "}
            <span>agent-triggered DeFi.</span>
          </h1>
          <p className={styles.heroLead}>
            OpenZaps convert user-approved workflows into sealed policy capsules. Hermes can simulate, submit,
            monitor, and revoke — without gaining discretionary wallet authority.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryButton} href="#model">Study the model</a>
            <a className={styles.secondaryButton} href="#safety">Threat matrix</a>
          </div>
          <div className={styles.proofStrip} aria-label="OpenZaps design constraints">
            <span>ERC-20 first</span>
            <span>EIP-712 intents</span>
            <span>ERC-1271 ready</span>
            <span>Private orderflow by default</span>
          </div>
        </div>

        <div className={styles.heroVisual} aria-label="OpenZap execution preview">
          <div className={styles.logoOrbit}>
            <OpenZapMark className={styles.heroMark} />
            <span className={styles.orbitNodeOne}>policy hash</span>
            <span className={styles.orbitNodeTwo}>zero residual approvals</span>
          </div>
          <div className={styles.terminalCard}>
            <div className={styles.terminalTop}>
              <OpenZapMark className={styles.terminalMark} />
              <strong>execution-gate.ts</strong>
            </div>
            <pre>{`verify(policyHash)
simulate(latestBlock)
assert(minOut && recipient)
submit(privateChannel)
monitor(receipt)
revoke(ifAnomaly)`}</pre>
            <div className={styles.routeGraph}>
              <span>User</span>
              <i />
              <span>Zap</span>
              <i />
              <span>Allowed protocols</span>
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.container} ${styles.principleBand}`}>
        <div className={styles.principleMark}>
          <OpenZapMark />
        </div>
        <p>
          Not “approval-free.” <strong>Pre-committed, tightly bounded authority</strong> for a fixed action graph. That is
          the product and the security boundary.
        </p>
      </section>

      <section id="model" className={`${styles.container} ${styles.section}`}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Authority model</div>
          <h2>Execution authority must live somewhere explicit.</h2>
          <p>
            OpenZaps split creation authority, execution authority, and submission authority so users can walk away
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

      <section id="safety" className={`${styles.container} ${styles.section} ${styles.splitSection}`}>
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

      <section id="hermes" className={`${styles.container} ${styles.agentSection}`}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Hermes role</div>
          <h2>A bounded execution and safety agent, not an autonomous trader.</h2>
          <p>
            Hermes discovers eligible zaps, validates policy, simulates exact calldata, submits through the safest channel,
            monitors settlement, and escalates when policy or market state diverges.
          </p>
        </div>
        <div className={styles.agentLoop}>
          {agentLoop.map((item, index) => (
            <div className={styles.loopNode} key={item}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </div>
      </section>

      <section id="roadmap" className={`${styles.container} ${styles.section}`}>
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

      <footer className={`${styles.container} ${styles.footer}`}>
        <div className={styles.footerBrand}>
          <OpenZapMark className={styles.footerMark} />
          <div>
            <strong>OpenZaps</strong>
            <p>Immutable intent capsules for Hermes-triggered DeFi.</p>
          </div>
        </div>
        <p>Built from the OpenZaps research report. No live protocol, token, TVL, or audit claims are implied.</p>
      </footer>
    </main>
  );
}
