import Link from "next/link";
import { CHAIN, CONTRACTS, LINKS, TOKEN } from "@/lib/config";
import { POLICY_TEMPLATES } from "@/lib/policy";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd, SITE_URL } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "./docs.module.css";

export const metadata = pageMetadata({
  title: "Developer docs",
  description:
    "OpenZaps developer docs for bounded policy capsules, simulation review, EIP-712 intents, revocation, and the simulation API.",
  path: "/docs",
  ogImage: "/og/docs.png",
  keywords: ["OpenZaps docs", "policy capsule docs", "simulation API", "EIP-712 intent docs"],
});

const lifecycle = [
  ["1", "Draft policy", "Select a template, authority model, spend ceiling, cadence, adapter, recipient, submitter, and postconditions."],
  ["2", "Simulate", "Run deterministic checks before any wallet prompt. Blocked policies cannot proceed; warned policies require review."],
  ["3", "Review signature", "Bind chain, owner, recipient, nonce, deadline, policy hash, min-out, relayer fee cap, and postconditions."],
  ["4", "Submit", "The owner submits from their own wallet within signed limits today; Hermes-assisted and private submission are planned."],
  ["5", "Monitor and revoke", "Receipts, allowance checks, balance deltas, alerts, and owner revoke paths stay attached to the capsule."],
] as const;

export default function DocsPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/docs", "Developer docs") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Developer docs</span>
          <h1>Build with bounded execution, not broad wallet authority.</h1>
          <p>
            OpenZaps are policy capsules for agent-triggered DeFi. The current interface exposes a deterministic
            simulation API, review artifacts, and open bounded creation on Robinhood Chain; scope deposits remain
            pre-external-audit, so explicit funds-at-risk warnings apply.
          </p>
          <div className={styles.heroActions}>
            <Link className="btn btnPrimary btnLg" href="/app">
              Open policy console
            </Link>
            <a className="btn btnGhost btnLg" href={LINKS.contractSource} target="_blank" rel="noreferrer">
              Contract source
            </a>
          </div>
        </div>
        <aside className={styles.heroCard}>
          <span>Robinhood Chain factory</span>
          <strong>{CONTRACTS.factory}</strong>
        </aside>
      </section>

      <section className={`container ${styles.grid}`}>
        <nav className={styles.toc} aria-label="Documentation sections">
          <a href="#quickstart">Quickstart</a>
          <a href="#policy">Policy schema</a>
          <a href="#api">Simulation API</a>
          <a href="#templates">Templates</a>
          <a href="#lifecycle">Execution lifecycle</a>
          <a href="#sdk">SDK surface</a>
        </nav>

        <div className={styles.content}>
          <section className={styles.callout}>
            <span>Production status</span>
            <strong>Bounded creation is live pre-audit; deposits carry explicit funds-at-risk warnings.</strong>
            <p>
              The v1.1 contracts are live on {CHAIN.name} with one bounded route (aeWETH ↔ 0xZAPS). 63 Foundry tests
              pass and 9 internal findings were fixed, but no external audit, formal checks, adapter governance,
              testnet soak, or live wallet review has completed. Deposit only what you can afford to lose.
            </p>
          </section>

          <section className={styles.section} id="quickstart">
            <h2>Quickstart</h2>
            <p>
              Use the policy console for a visual flow, or call the local simulation API from an agent, backend, or
              Farcaster Mini App. Simulation never broadcasts a transaction and never asks for wallet authority.
            </p>
            <div className={styles.codeBlock}>
              <pre>{`curl -X POST ${SITE_URL}/api/policies/simulate \\
  -H "content-type: application/json" \\
  -d '{
    "templateId": "recurring-dca",
    "authorityModel": "deposit",
    "tokenIn": "USDC",
    "tokenOut": "WETH",
    "amount": "250",
    "maxSpend": "1000",
    "frequency": "weekly",
    "slippageBps": 50,
    "privateSubmission": true,
    "humanApproval": false
  }'`}</pre>
            </div>
          </section>

          <section className={styles.section} id="policy">
            <h2>Policy schema</h2>
            <p>
              The signed object is deliberately boring. Every field that could expand execution authority is present in
              the user-visible policy before a relayer can act.
            </p>
            <div className={styles.table}>
              {[
                ["authorityModel", "deposit, intent, Safe/ERC-1271, or future session-key mode."],
                ["recipient", "The only address allowed to receive tracked output assets."],
                ["amount / maxSpend / frequency", "Spend and cadence ceilings. No unlimited looping."],
                ["adapter", "A governed, allowlisted adapter. No arbitrary target plus calldata."],
                ["allowedSubmitters", "Hermes, owner self-submit, or explicitly named relayers."],
                ["postconditions", "Balance deltas, allowance reset, recipient, and tracked-asset assertions."],
              ].map(([field, detail], i) => (
                <Reveal className={styles.row} delay={i * 45} key={field}>
                  <strong>{field}</strong>
                  <p>{detail}</p>
                </Reveal>
              ))}
            </div>
          </section>

          <section className={styles.section} id="api">
            <h2>Simulation API</h2>
            <p>
              The API returns the normalized policy, policy hash, check status, deterministic quote estimate, relayer fee
              cap, gas envelope, and broadcast flag. The route is suitable for CI, docs, and agent preflight checks.
            </p>
            <div className={styles.codeBlock}>
              <pre>{`type SimulationResponse = {
  policy: PolicyDraft
  simulation: {
    status: "pass" | "warn" | "block"
    policyHash: string
    estimatedOut: string
    relayerFee: string
    gasEstimate: string
    checks: Array<{
      label: string
      detail: string
      status: "pass" | "warn" | "block"
    }>
  }
  broadcast: false
}`}</pre>
            </div>
          </section>

          <section className={styles.section} id="templates">
            <h2>Policy templates</h2>
            <div className={styles.twoCol}>
              {POLICY_TEMPLATES.map((template) => (
                <article key={template.id}>
                  <h3>{template.name}</h3>
                  <p>{template.description}</p>
                  <p>
                    <strong>Status:</strong> {template.production.replace("-", " ")}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.section} id="lifecycle">
            <h2>Execution lifecycle</h2>
            <div className={styles.timeline}>
              {lifecycle.map(([n, title, body], i) => (
                <Reveal className={styles.phase} delay={i * 45} key={n}>
                  <span>{n}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </section>

          <section className={styles.section} id="sdk">
            <h2>SDK surface</h2>
            <p>
              The eventual SDK should stay small: normalize policy input, simulate, prepare EIP-712 typed data, submit
              through an approved channel, and monitor receipts. Current local functions are already split so they can
              graduate into a package.
            </p>
            <div className={styles.codeBlock}>
              <pre>{`import { buildPolicyDraft, simulatePolicy } from "@openzaps/sdk"

const policy = buildPolicyDraft({
  templateId: "recurring-dca",
  tokenIn: "USDC",
  tokenOut: "WETH",
  amount: "250",
  maxSpend: "1000",
})

const review = simulatePolicy(policy)
if (review.status === "block") throw new Error("policy blocked")`}</pre>
            </div>
            <p>
              Until the package is published, see <a href={LINKS.contractSource}>the verified contract source</a> and the
              live console for the reference behavior. {TOKEN.symbol} is not required to simulate or inspect policies.
            </p>
          </section>
        </div>
      </section>
    </main>
  );
}
