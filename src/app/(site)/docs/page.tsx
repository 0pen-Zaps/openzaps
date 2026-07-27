import Link from "next/link";
import { CHAIN, CONTRACTS, LINKS, STATUS, TOKEN, explorer } from "@/lib/config";
import { POLICY_TEMPLATES } from "@/lib/policy";
import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, SITE_URL, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import { TokenUtilityPanel } from "@/components/TokenUtilityPanel";
import { BlockGlyph } from "../zap/BlockGlyph";
import { DocsToc } from "./DocsToc";
import styles from "./docs.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.docs,
  keywords: [
    "OpenZaps docs",
    "policy capsule docs",
    "simulation API",
    "EIP-712 intent docs",
    "OpenZaps security",
    "execution policy blocks",
    "DeFi policy composer",
    "DeFi threat model",
    "smart contract security architecture",
  ],
});

/**
 * The three authorities, kept apart. This is the shape of the whole product in
 * three rows, which is why it now opens the page rather than being implied by
 * the sections underneath it.
 */
const authorities = [
  ["Creation", "Stays with your wallet or Safe. Only you bring a Zap into existence."],
  ["Execution", "Lives inside the immutable policy, or an EIP-712 typed intent. Not in an app, not in a key."],
  ["Submission", "A courier. It picks the moment and nothing else."],
] as const;

const lifecycle = [
  ["1", "Draft policy", "Pick a template and fill the draft fields: authority model, spend ceiling, cadence, adapter, recipient, submitter, and postconditions."],
  ["2", "Simulate", "Deterministic checks run before any wallet prompt. A blocked policy does not proceed. A warned policy proceeds only after review."],
  ["3", "Review signature", "The typed intent binds chain, owner, recipient, nonce, deadline, policy hash, min-out, execution gas, gas-price ceiling, and executor access where the contract supports it. None can change after signing."],
  ["4", "Submit", "The owner submits from their own wallet. The v1.1 policy cannot bind a submitter, so whoever executes chooses the mempool path."],
  ["5", "Monitor and recover", "Receipts, allowance checks, balance deltas, alerts, nonce invalidation, and the owner's emergency-exit path stay attached to the Zap. Its page at /explore/<address> reports what the contract stores and what its own logs say, and nothing else."],
] as const;

const executionPolicies = [
  [
    "Execution gas limit",
    "maxGas",
    "Zap now + Automate",
    "Caps gas available to a Zap. If a design contains more than one gas-limit block, the lowest valid cap wins.",
  ],
  [
    "Gas price cap",
    "maxFeePerGas",
    "Zap now + Automate",
    "Rejects a Zap above the signed fee-per-gas ceiling. Multiple blocks resolve to the lowest valid price.",
  ],
  [
    "Executor access",
    "executor",
    "Automate (v3/v3.1)",
    "Keeps execution open to anyone or restricts it to the owner. Owner only is the tighter result when blocks are combined.",
  ],
] as const;

// The security model used to be its own page; it now lives here as the last
// cluster of sections. The arrays below are lifted verbatim from it so the
// text a reader saw at /security is unchanged, only relocated.
const controls = [
  ["No arbitrary calls", "The Zap calls an allowlisted adapter with the selector the policy names. There is no field for an arbitrary target plus calldata, so there is nothing to point at one."],
  ["Nonce consumed first", "The authorization is consumed before any external call. A reentrant call back into the Zap finds the nonce already spent."],
  ["Exact approvals", "The approval is the exact step amount, and it is reset to zero on the success path and the revert path. No standing allowance is left for anyone to draw on later."],
  ["Balance-delta checks", "After the adapter returns, the Zap asserts the tracked output asset, the recipient, the minimum output, and that no allowance remains. A failed assertion reverts the whole execution."],
  ["Submitter is not bound", "The v1.1 policy has no submitter field, so whoever executes the Zap chooses the mempool path. The live bounded route is submitted from the owner's own wallet."],
  ["Owner recovery controls", "The owner can invalidate unused intent nonces or emergency-exit tracked assets without an agent. The live v1.1 Zap has no generic pause function; its deployed policy remains immutable."],
] as const;

const threats = [
  ["MEV / sandwiching", "A searcher who sees the pending execution can move the pool price against it. The signed minimum output and the ten-minute intent deadline bound what that is worth; the Zap cannot hide the transaction, because the policy cannot bind a submitter."],
  ["Approval leakage", "An adapter that kept an allowance could spend from the Zap again later. The approval is the exact step amount and is reset to zero on both paths, and a residual allowance fails the postcondition."],
  ["Scope drift", "A submitter who edits a policy field before broadcasting produces a different policy hash, and the Zap rejects the intent. A chain-aware nonce and the typed-data domain make an intent signed elsewhere useless here."],
  ["Relayer optionality", "A relayer can delay, censor, or pick a bad moment inside the signed limits. It cannot take a fee on the live route: the policy commits a relayer fee cap of zero. The owner can always submit the transaction themselves."],
  ["Oracle manipulation", "The v1.1 policy has no oracle precondition, so a design that depends on a price band is not enforced by it. Protective exits stay blocked in v1 for that reason."],
] as const;

const gates = [
  ["External audit", "Independent review of factory, clone init, EIP-712/1271 verification, approval reset, and adapter boundaries."],
  ["Formal checks", "A prover run over the authorization, approval-reset, call-surface, recipient, isolation, and token-allowlist invariants."],
  ["Adapter governance", "Safe plus timelock ownership, adapter bytecode manifests, and a rollback process."],
  ["Testnet soak", "Public testnet with real wallet review, alerts, receipts, and recovery drills."],
  ["Incident runbook", "Emergency-control review, disclosure process, chain-monitor alerts, and postmortem template."],
] as const;

/** Three states, three colours. `deferred` is muted rather than red: it is not
 *  a warning, it is a thing nobody has started. */
function chipFor(production: (typeof POLICY_TEMPLATES)[number]["production"]): string {
  if (production === "ready-preview") return styles.chipOk;
  if (production === "requires-review") return styles.chipWarn;
  return styles.chipMuted;
}

export default function DocsPage(): React.JSX.Element {
  return (
    <main className={styles.screen} id="main" data-screen-label="Docs">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.docs), breadcrumbJsonLd("/docs", "Developer docs")],
        }}
      />

      <DocsToc />

      <article className={styles.article}>
        <h1 className={styles.title}>A Zap cannot do anything it was not signed to do.</h1>
        <p className={styles.lede}>
          An OpenZap is a contract that holds funds and executes one policy its owner signed. This page documents the
          policy fields, the simulation API, and the execution lifecycle. Onchain actions are irreversible, so deposit
          only what you can afford to lose.
        </p>
        <div className={styles.actions}>
          <Link className={styles.primaryBtn} href="/zap">
            Launch OpenZaps
          </Link>
          <a className={styles.ghostBtn} href={LINKS.contractSource} target="_blank" rel="noreferrer">
            Contract source
          </a>
          <span className={styles.metaChip}>
            <b>{CHAIN.name} factory</b>
            {CONTRACTS.factory}
          </span>
        </div>

        {/* Above every section, not below them. The prototype puts the audit
            disclosure at the end of the article; this one is about live funds
            in unaudited contracts, so it stays where it cannot be scrolled
            past. */}
        <section className={styles.warn}>
          <BlockGlyph name="alert" className={styles.warnIcon} />
          <p className={styles.warnCopy}>
            <span className={styles.warnEyebrow}>Audit status</span>
            <strong className={styles.warnTitle}>The contracts have not been externally audited.</strong>
            The contracts are live on {CHAIN.name} and carry bounded swaps through pinned aeWETH ↔ 0xZAPS and aeWETH ↔
            USDG pools, a stitched USDG → 0xZAPS route, aeWETH/USDG liquidity, and the v3 recurring and price-triggered
            execution types — with the recipient forced to the owner and the relayer fee cap set to zero. The owner
            keeps an unconditional withdraw and revoke path. No external audit, formal verification, adapter
            governance, testnet soak, or live wallet review has completed. Deposited funds are at risk.
          </p>
        </section>

        <section className={styles.section} id="authorities">
          <h2 className={styles.h2}>Three authorities, kept apart</h2>
          <div className={styles.defs}>
            {authorities.map(([name, detail], i) => (
              <Reveal className={styles.def} delay={i * 45} key={name}>
                <strong className={styles.defTerm}>{name}</strong>
                <p className={styles.defBody}>{detail}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.section} id="quickstart">
          <h2 className={styles.h2}>Quickstart</h2>
          <p className={styles.prose}>
            The product lives at /zap: Compose is the visual builder, Zap now creates and executes v1.1 Zaps, and
            Automate creates v3/v3.1 recurring or price-triggered Zaps. The builder compiles a design and names every
            guard the selected contract does not bind. A deployed route carries its amount, slippage, execution gas,
            and gas-price cap into Zap now. Automatable designs also carry cadence, Zap count, trigger terms, and
            executor access into Automate. Anything else saves as a design and cannot deploy today. Simulation never
            broadcasts a transaction or asks for wallet authority.
          </p>
          <div className={styles.code}>
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

        <section className={styles.section} id="composer">
          <h2 className={styles.h2}>Execution policy composer</h2>
          <p className={styles.prose}>
            The block catalog now has three live execution-policy controls. The builder can insert every missing
            control as one stack, in one history checkpoint. One Undo restores the chain that existed before the stack
            was added. Each card stays independently editable after insertion.
          </p>
          <div className={styles.defs}>
            {executionPolicies.map(([block, field, surface, behavior], index) => (
              <Reveal className={styles.def} delay={index * 45} key={field}>
                <strong className={styles.defTerm}>{block}</strong>
                <p className={styles.defBody}>
                  <code>{field}</code> · {surface}. {behavior}
                </p>
              </Reveal>
            ))}
          </div>
          <div className={styles.code}>
            <pre>{`Wallet balance
  → Execution gas limit   3,000,000 gas
  → Gas price cap         10 gwei
  → Executor access       Anyone | Owner only
  → Swap
  → Send

Zap now handoff:
  maxGas=3000000&maxFeeGwei=10

Automate handoff:
  maxGas=3000000&maxFeeGwei=10&executor=owner`}</pre>
          </div>
          <p className={styles.prose}>
            Gas limit and gas price cap are signed in v1.1 one-shot intents and v3/v3.1 standing intents. Owner-only
            executor access is enforced by v3/v3.1. The v1.1 one-shot Zap has no submitter restriction, so the builder
            leaves that field out of its Zap now handoff and shows the limitation before the user proceeds. Invalid or
            out-of-range handoff values fail closed instead of falling back silently.
          </p>
          <div className={styles.actions}>
            <Link className={styles.primaryBtn} href="/zap?view=design">
              Open the composer
            </Link>
          </div>
        </section>

        <TokenUtilityPanel id="token" className={styles.tokenPanel} />

        <section className={styles.section} id="policy">
          <h2 className={styles.h2}>Policy schema</h2>
          <p className={styles.prose}>
            The signed object is small on purpose. Any field that could widen what an execution may do is in the policy
            the owner reads before signing. A field that is not in the policy is not enforced by the contract.
          </p>
          <div className={styles.defs}>
            {[
              ["authorityModel", "deposit, intent, or Safe/ERC-1271. Session keys are not enabled; the simulator blocks them."],
              ["recipient", "The only address allowed to receive tracked output assets. On the live route it is forced to the owner."],
              ["amount / maxSpend / frequency", "Draft spend and cadence fields. The v1.1 Zap binds the single step amount and tracks no cumulative budget or schedule."],
              ["adapter", "An allowlisted adapter. There is no field for an arbitrary target plus calldata, so there is nothing to point at one."],
              ["allowedSubmitters", "A draft field. The v1.1 policy cannot bind a submitter, so whoever executes the Zap chooses the path."],
              ["maxGas / maxFeePerGas", "Signed execution ceilings carried from the composer into one-shot and standing intents. A run outside either cap reverts."],
              ["executor", "A v3/v3.1 standing-intent field. Zero address leaves submission open; owner-only pins the connected owner wallet. v1.1 does not bind a submitter."],
              ["postconditions", "Balance-delta, allowance-reset, recipient, and tracked-asset assertions, checked after the adapter returns. A failed assertion reverts the execution."],
            ].map(([field, detail], i) => (
              <Reveal className={styles.def} delay={i * 45} key={field}>
                <strong className={styles.defTermMono}>{field}</strong>
                <p className={styles.defBody}>{detail}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.section} id="api">
          <h2 className={styles.h2}>Simulation API</h2>
          <p className={styles.prose}>
            The endpoint returns the normalized policy, a hash, the check results, an estimated output, a relayer fee
            cap, a gas envelope, and broadcast: false. It never submits anything, so it is safe to run in CI or as an
            agent preflight. The hash is a local checksum that tells two drafts apart; it is not the onchain policy
            hash. The estimate is computed from fixed rates held in this app, not read from a pool, so it is not a
            price.
          </p>
          <div className={styles.code}>
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
          <h2 className={styles.h2}>Policy templates</h2>
          <div className={styles.cards}>
            {POLICY_TEMPLATES.map((template) => (
              <article className={styles.card} key={template.id}>
                <h3 className={styles.cardTitle}>{template.name}</h3>
                <p className={styles.cardBody}>{template.description}</p>
                <span className={`${styles.chip} ${chipFor(template.production)}`}>
                  {template.production.replace("-", " ")}
                </span>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} id="automation">
          <h2 className={styles.h2}>Automation &amp; the executor economy (v3)</h2>
          <p className={styles.prose}>
            The v3 Zap adds two standing execution types to the one-shot policy. Both are owner-signed once and
            condition-gated <em>by the contract</em>, so an eligible executor can submit a run the Zap owes, and the
            chain rejects every run it does not.
          </p>
          <div className={styles.cards}>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>Recurring</h3>
              <p className={styles.cardBody}>
                One EIP-712 signature authorizes up to <code>maxRuns</code> Zaps over the frozen route, at least{" "}
                <code>interval</code> seconds apart, inside a signed window. Submitting early reverts
                (<code>IntervalNotElapsed</code>); exhaustion consumes the series; <code>invalidateNonce</code> cancels
                it at any time.
              </p>
              <p className={styles.cardBody}>
                A series signs no absolute floor. Under v3.1 the owner signs an allowlisted price source and a
                slippage band, and the Zap derives each run&apos;s minimum output from that source&apos;s spot{" "}
                <em>at execution</em> — so a floor agreed weeks ago still protects the run happening now, and a series
                does not carry a stale floor into its next run.
              </p>
            </article>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>Price trigger</h3>
              <p className={styles.cardBody}>
                One signature arms one execution against an allowlisted onchain price source. Until the market moves
                past the signed threshold the Zap reverts (<code>TriggerNotMet</code>); the submitter cannot supply a
                price. The spot threshold is an arming condition, not a fair-value oracle — the signed net-output floor
                still bounds every run.
              </p>
            </article>
          </div>
          <p className={styles.prose}>
            <strong>Fees.</strong> Each automated Zap pays 1% of its measured output at settlement: 80% to the executor
            that submitted it, 20% to the protocol lottery pot, converted to 0xZAPS through the pinned bounded adapter
            by a later, permissionless keeper call. Floors are enforced <em>net</em> of the fee — both the absolute
            minimum-out a price trigger signs and the per-run floor a recurring Zap derives from spot. Every fee
            contribution credits lottery tickets to the Zap&apos;s owner; the pot pays prizes only in 0xZAPS and only
            to ticket holders — there is no owner drain. Winner selection is a deferred, governance-gated decision
            until a randomness ADR lands.
          </p>
          <p className={styles.prose}>
            <strong>Creation fee.</strong> Every Zap created by the current app — one-shot, recurring, or triggered —
            separately pays exactly 0.00001 ETH. The fee gateway calls the existing lineage factory, wraps the fee to
            aeWETH, and converts it through the pinned aeWETH → 0xZAPS adapter in the same transaction. The wallet
            reviews both the fixed fee and a fresh minimum 0xZAPS output before signing; if factory creation or
            conversion misses that floor, the whole transaction reverts. The old immutable factories remain callable
            directly, so this is an app-enforced creation path rather than a retroactive change to already-deployed
            factory bytecode.
          </p>
          <p className={styles.prose}>
            Compose one in <Link href="/zap?view=design">Compose</Link>, then review it in{" "}
            <Link href="/zap?view=automate">Automate</Link>. The signed intent exports as a JSON file an eligible
            executor can serve; the reference executor daemon lives in <code>executor/</code> in the repository. The v3
            contracts are live on Robinhood Chain.
          </p>
        </section>

        <section className={styles.section} id="lifecycle">
          <h2 className={styles.h2}>Execution lifecycle</h2>
          <div className={styles.steps}>
            {lifecycle.map(([n, title, body], i) => (
              <Reveal className={styles.step} delay={i * 45} key={n}>
                <span className={styles.stepNum}>{n}</span>
                <div>
                  <h3 className={styles.stepTitle}>{title}</h3>
                  <p className={styles.stepBody}>{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.section} id="sdk">
          <h2 className={styles.h2}>SDK surface</h2>
          <p className={styles.prose}>
            There is no published package. The import below does not resolve today; it shows the surface the local
            functions expose: normalize policy input, simulate, prepare EIP-712 typed data, submit through an approved
            channel, and monitor receipts.
          </p>
          <div className={styles.code}>
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
          <p className={styles.prose}>
            What actually executes is the deployed contract, not this surface. Read{" "}
            <a href={LINKS.contractSource}>the verified source</a> before signing anything. {TOKEN.symbol} is not
            required to simulate or inspect a policy.
          </p>
        </section>

        {/* ---- Security model (folded in from the former /security page) ---- */}
        <section className={styles.section} id="security">
          <h2 className={styles.h2}>Security model</h2>
          <p className={styles.prose}>
            A Zap — the immutable policy capsule the factory deploys — holds funds and accepts owner-signed intents
            that rehash to the policy frozen at creation. The adapter, the spender, the recipient, the input token, and
            the exact amount are fixed at that moment. An executor picks the moment and nothing else. The status card
            below is read from config: the contracts are{" "}
            <strong>{STATUS.preAudit ? "live and not externally audited" : "externally audited"}</strong>.
          </p>
          <p className={styles.prose}>
            Bounded aeWETH ↔ 0xZAPS creation is open on {CHAIN.name}, and the funds a Zap holds are real. Production
            use still needs external audit, formal verification, adapter governance, and a monitored launch path.
            Onchain actions are irreversible: once an execution lands, nothing here can undo it. The owner keeps an
            unconditional withdraw and revoke path. Deposit only what you can afford to lose.
          </p>
          <div className={styles.code}>
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
          <h2 className={styles.h2}>Controls</h2>
          <div className={styles.defs}>
            {controls.map(([name, detail], i) => (
              <Reveal className={styles.def} delay={i * 45} key={name}>
                <strong className={styles.defTerm}>{name}</strong>
                <p className={styles.defBody}>{detail}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.section} id="threats">
          <h2 className={styles.h2}>Threat model</h2>
          <div className={styles.defs}>
            {threats.map(([name, detail], i) => (
              <Reveal className={styles.def} delay={i * 45} key={name}>
                <strong className={styles.defTerm}>{name}</strong>
                <p className={styles.defBody}>{detail}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.section} id="gates">
          <h2 className={styles.h2}>Production gates</h2>
          <p className={styles.prose}>
            None of the following has completed. Each one is a precondition for calling the contracts
            production-cleared. Until they have, the only thing standing behind a failure in the contract, the
            interface, the relayer path, or the adapter registry is the owner&apos;s exit.
          </p>
          <div className={styles.steps}>
            {gates.map(([name, body], index) => (
              <Reveal className={styles.step} delay={index * 45} key={name}>
                <span className={styles.stepTag}>P{index}</span>
                <div>
                  <h3 className={styles.stepTitle}>{name}</h3>
                  <p className={styles.stepBody}>{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className={styles.facts}>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Factory</span>
              <strong className={styles.factValue}>{CONTRACTS.factory.slice(0, 8)}...</strong>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Adapter registry</span>
              <strong className={styles.factValue}>{CONTRACTS.adapterRegistry.slice(0, 8)}...</strong>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Token allowlist</span>
              <strong className={styles.factValue}>{CONTRACTS.tokenAllowlist.slice(0, 8)}...</strong>
            </div>
          </div>
          <div className={styles.actions}>
            <a className={styles.ghostBtn} href={explorer(CONTRACTS.factory)} target="_blank" rel="noreferrer">
              View factory
            </a>
            <a className={styles.ghostBtn} href={LINKS.contractSource} target="_blank" rel="noreferrer">
              Contract source
            </a>
          </div>
        </section>
      </article>
    </main>
  );
}
