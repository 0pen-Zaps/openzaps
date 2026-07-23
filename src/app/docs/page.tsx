import Link from "next/link";
import { CHAIN, CONTRACTS, LINKS, STATUS, TOKEN, explorer } from "@/lib/config";
import { POLICY_TEMPLATES } from "@/lib/policy";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd, SITE_URL } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "./docs.module.css";

export const metadata = pageMetadata({
  title: "Developer docs & security",
  description:
    "How an OpenZaps policy capsule is drafted, simulated, signed as an EIP-712 intent, submitted, and revoked — and what the capsule refuses to do, what an executor could still try, and what has not been reviewed. One bounded route is live on Robinhood Chain. The contracts are not externally audited.",
  path: "/docs",
  ogImage: "/og/docs.png",
  keywords: [
    "OpenZaps docs",
    "policy capsule docs",
    "simulation API",
    "EIP-712 intent docs",
    "OpenZaps security",
    "DeFi threat model",
    "smart contract security architecture",
  ],
});

const lifecycle = [
  ["1", "Draft policy", "Pick a template and fill the draft fields: authority model, spend ceiling, cadence, adapter, recipient, submitter, and postconditions."],
  ["2", "Simulate", "Deterministic checks run before any wallet prompt. A blocked policy does not proceed. A warned policy proceeds only after review."],
  ["3", "Review signature", "The typed intent binds chain, owner, recipient, nonce, deadline, policy hash, min-out, relayer fee cap, and gas price. None of them can change after signing."],
  ["4", "Submit", "The owner submits from their own wallet. The v1.1 policy cannot bind a submitter, so whoever executes chooses the mempool path."],
  ["5", "Monitor and revoke", "Receipts, allowance checks, balance deltas, alerts, and the owner's revoke and exit paths stay attached to the capsule. Its page at /zaps/<address> reports what the contract stores and what its own logs say, and nothing else."],
] as const;

// The security model used to be its own page; it now lives here as the last
// cluster of sections. The arrays below are lifted verbatim from it so the
// text a reader saw at /security is unchanged, only relocated.
const controls = [
  ["No arbitrary calls", "The capsule calls an allowlisted adapter with the selector the policy names. There is no field for an arbitrary target plus calldata, so there is nothing to point at one."],
  ["Nonce consumed first", "The authorization is consumed before any external call. A reentrant call back into the capsule finds the nonce already spent."],
  ["Exact approvals", "The approval is the exact step amount, and it is reset to zero on the success path and the revert path. No standing allowance is left for anyone to draw on later."],
  ["Balance-delta checks", "After the adapter returns, the capsule asserts the tracked output asset, the recipient, the minimum output, and that no allowance remains. A failed assertion reverts the whole execution."],
  ["Submitter is not bound", "The v1.1 policy has no submitter field, so whoever executes the capsule chooses the mempool path. The live bounded route is submitted from the owner's own wallet."],
  ["Owner revoke", "The owner can pause, invalidate nonce space, or emergency-exit without an agent. The withdraw and revoke path is unconditional and needs no one else's cooperation."],
] as const;

const threats = [
  ["MEV / sandwiching", "A searcher who sees the pending execution can move the pool price against it. The signed minimum output and the ten-minute intent deadline bound what that is worth; the capsule cannot hide the transaction, because the policy cannot bind a submitter."],
  ["Approval leakage", "An adapter that kept an allowance could spend from the capsule again later. The approval is the exact step amount and is reset to zero on both paths, and a residual allowance fails the postcondition."],
  ["Scope drift", "A submitter who edits a policy field before broadcasting produces a different policy hash, and the capsule rejects the intent. A chain-aware nonce and the typed-data domain make an intent signed elsewhere useless here."],
  ["Relayer optionality", "A relayer can delay, censor, or pick a bad moment inside the signed limits. It cannot take a fee on the live route: the policy commits a relayer fee cap of zero. The owner can always submit the transaction themselves."],
  ["Oracle manipulation", "The v1.1 policy has no oracle precondition, so a design that depends on a price band is not enforced by it. Protective exits stay blocked in v1 for that reason."],
] as const;

const gates = [
  ["External audit", "Independent review of factory, clone init, EIP-712/1271 verification, approval reset, and adapter boundaries."],
  ["Formal checks", "A prover run over the authorization, approval-reset, call-surface, recipient, isolation, and token-allowlist invariants."],
  ["Adapter governance", "Safe plus timelock ownership, adapter bytecode manifests, and a rollback process."],
  ["Testnet soak", "Public testnet with real wallet review, alerts, receipts, and revoke drills."],
  ["Incident runbook", "Emergency pause, disclosure process, chain-monitor alerts, and postmortem template."],
] as const;

export default function DocsPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/docs", "Developer docs") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Developer docs</span>
          <h1>Everything an execution can do is fixed before you sign it.</h1>
          <p>
            An OpenZap is a contract that holds funds and executes one policy its owner signed. This page documents the
            policy fields, the simulation API, and the execution lifecycle. The contracts have not been externally
            audited. Onchain actions are irreversible, so deposit only what you can afford to lose.
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
          <a href="#security">Security model</a>
          <a href="#controls">Controls</a>
          <a href="#threats">Threat model</a>
          <a href="#gates">Production gates</a>
        </nav>

        <div className={styles.content}>
          <section className={styles.callout}>
            <span>Audit status</span>
            <strong>The contracts have not been externally audited.</strong>
            <p>
              The v1.1 contracts are live on {CHAIN.name} and carry two bounded routes — single-step swaps through
              pinned aeWETH ↔ 0xZAPS and aeWETH ↔ USDG pools — with the recipient forced to the owner and the relayer
              fee cap set to zero. The owner keeps an
              unconditional withdraw and revoke path. No external audit, formal verification, adapter governance,
              testnet soak, or live wallet review has completed. Deposited funds are at risk.
            </p>
          </section>

          <section className={styles.section} id="quickstart">
            <h2>Quickstart</h2>
            <p>
              The visual builder is at /build. It compiles a design and names every guard the live policy does not
              bind. A design that reduces to the live route hands /app a prefilled direction, amount, and slippage cap.
              Anything else saves as a design and cannot be deployed today. An agent, a backend, or a Mini App can call
              the simulation API instead. Simulation never broadcasts a transaction and never asks for wallet
              authority.
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
              The signed object is small on purpose. Any field that could widen what an execution may do is in the
              policy the owner reads before signing. A field that is not in the policy is not enforced by the contract.
            </p>
            <div className={styles.table}>
              {[
                ["authorityModel", "deposit, intent, or Safe/ERC-1271. Session keys are not enabled; the simulator blocks them."],
                ["recipient", "The only address allowed to receive tracked output assets. On the live route it is forced to the owner."],
                ["amount / maxSpend / frequency", "Draft spend and cadence fields. The v1.1 capsule binds the single step amount and tracks no cumulative budget or schedule."],
                ["adapter", "An allowlisted adapter. There is no field for an arbitrary target plus calldata, so there is nothing to point at one."],
                ["allowedSubmitters", "A draft field. The v1.1 policy cannot bind a submitter, so whoever executes the capsule chooses the path."],
                ["postconditions", "Balance-delta, allowance-reset, recipient, and tracked-asset assertions, checked after the adapter returns. A failed assertion reverts the execution."],
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
              The endpoint returns the normalized policy, a hash, the check results, an estimated output, a relayer fee
              cap, a gas envelope, and broadcast: false. It never submits anything, so it is safe to run in CI or as an
              agent preflight. The hash is a local checksum that tells two drafts apart; it is not the onchain policy
              hash. The estimate is computed from fixed rates held in this app, not read from a pool, so it is not a
              price.
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
              There is no published package. The import below does not resolve today; it shows the surface the local
              functions expose: normalize policy input, simulate, prepare EIP-712 typed data, submit through an
              approved channel, and monitor receipts.
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
              What actually executes is the deployed contract, not this surface. Read{" "}
              <a href={LINKS.contractSource}>the verified source</a> before signing anything. {TOKEN.symbol} is not
              required to simulate or inspect a policy.
            </p>
          </section>

          {/* ---- Security model (folded in from the former /security page) ---- */}
          <section className={styles.section} id="security">
            <h2>Security model</h2>
            <p>
              A capsule holds funds and accepts owner-signed intents that rehash to the policy frozen at creation. The
              adapter, the spender, the recipient, the input token, and the exact amount are fixed at that moment. An
              executor picks the moment and nothing else. The status card below is read from config: the contracts are{" "}
              <strong>{STATUS.preAudit ? "live and not externally audited" : "externally audited"}</strong>.
            </p>
            <p>
              Bounded aeWETH ↔ 0xZAPS creation is open on {CHAIN.name}, and the funds a capsule holds are real.
              Production use still needs external audit, formal verification, adapter governance, and a monitored
              launch path. Onchain actions are irreversible: once an execution lands, nothing here can undo it. The
              owner keeps an unconditional withdraw and revoke path. Deposit only what you can afford to lose.
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
