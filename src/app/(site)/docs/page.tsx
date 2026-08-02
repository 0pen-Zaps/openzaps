import Link from "next/link";

import { mcpClientSnippet, OPENZAPS_AGENT_KIT_PUBLISHED } from "@/lib/agent-kit";
import { CHAIN, CONTRACTS, LINKS, STATUS, TOKEN, explorer } from "@/lib/config";
import { EXACT_POLICY_QUICKSTART_JSON } from "@/lib/policy-exact-example";
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
  ["5", "Monitor and recover", "Receipts, allowance checks, balance deltas, nonce invalidation, and the owner's emergency-exit path stay attached to the Zap. Nothing watches it for you and no alert is delivered. Its page at /explore/<address> reports what the contract stores and what its own logs say, and nothing else."],
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
    "Automate (v3/v3.1 live)",
    "Keeps execution open to anyone or restricts it to the owner. Owner only is the tighter result when blocks are combined.",
  ],
] as const;

const releaseStates = [
  {
    status: "Live · pre-audit",
    tone: "live",
    title: "v1.1 / v3 / v3.1",
    body:
      "The current one-shot, recurring, and price-triggered lineages are live on Robinhood Chain. v3.1 derives a recurring run floor from an allowlisted spot source at execution.",
  },
  {
    status: "Live · pre-audit",
    tone: "live",
    title: "v3.2 recurring stack",
    body:
      "The isolated stack contracts are live on Robinhood Chain: creation, execution, and permanent-halt canaries passed with onchain receipts, and the app, relay, and executor lanes are open. The contracts remain unaudited.",
  },
  {
    status: "Source-ready · not deployed",
    tone: "source",
    title: "v1.2 exact owner pull",
    body:
      "The reviewed source path adds exact Permit2 owner pull and an irreversible policy halt. Governance deployment and independent post-deployment canaries have not happened.",
  },
  {
    status: "Public product paths",
    tone: "live",
    title: "Practice, request, or connect",
    body:
      "Virtual Trading is browser-local and wallet-free. Request a Zap starts a human authority review. Connect pins one executor only inside terms the owner later signs.",
  },
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
  ["Relayer optionality", "A relayer can delay, censor, or pick a bad moment inside the signed limits. Every deployed policy commits a relayer fee cap of zero, so no submitter can bill the Zap through the policy; a v3/v3.1 automated run instead pays a fixed 1% of its measured output, 80% of it to the executor that submitted it. The owner can always submit the transaction themselves."],
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

function releaseChip(tone: (typeof releaseStates)[number]["tone"]): string {
  // "candidate" left this union when v3.2 was promoted to live (2026-08-02);
  // "source" (source-ready, not deployed) stays muted.
  if (tone === "live") return styles.chipOk;
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
        {/* "A Zap", matching the h1 directly above it. This read "An OpenZap",
            which named the same object a third way in consecutive sentences —
            after the title said Zap and before §Security model defines it as
            the policy capsule the factory deploys. OpenZap stays the contract's
            name in the source (openzap.ts, OpenZapV3_1); the prose has one word
            for it. */}
        <p className={styles.lede}>
          A Zap is a contract that holds funds and executes one policy its owner signed. This page documents the policy
          fields, current release state, the simulation API, and the execution lifecycle. Onchain actions are
          irreversible, so deposit only what you can afford to lose.
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
            USDG pools, a stitched USDG → 0xZAPS route, aeWETH/USDG liquidity, and the live v3/v3.1 recurring and
            price-triggered execution types — with the recipient forced to the owner and the relayer fee cap set to
            zero. Recovery is lineage-specific: owners can invalidate unused signed authority and recover tracked
            assets where the deployed lineage supports it. No control can undo a confirmed execution. No external
            audit, formal verification, adapter governance, testnet soak, or live wallet review has completed.
            Deposited funds are at risk.
          </p>
        </section>

        <section className={styles.section} id="release">
          <h2 className={styles.h2}>Current release map</h2>
          <p className={styles.prose}>
            Status belongs to a contract lineage or product path, not to the repository as a whole. Live, deployed
            candidate, and source-ready are separate states.
          </p>
          <div className={styles.cards}>
            {releaseStates.map((item, index) => (
              <Reveal as="article" className={styles.card} delay={index * 45} key={item.title}>
                <h3 className={styles.cardTitle}>{item.title}</h3>
                <p className={styles.cardBody}>{item.body}</p>
                <span className={`${styles.chip} ${releaseChip(item.tone)}`}>{item.status}</span>
              </Reveal>
            ))}
          </div>
          <div className={styles.actions}>
            <Link
              className={styles.ghostBtn}
              href="/virtual-trading"
              data-analytics-event="virtual_trading_clicked"
              data-analytics-cta="virtual_trading"
              data-analytics-content="docs_release"
            >
              Practice without a wallet
            </Link>
            <Link
              className={styles.ghostBtn}
              href="/request-a-zap"
              data-analytics-event="request_zap_clicked"
              data-analytics-cta="request_zap"
              data-analytics-content="docs_release"
            >
              Request a Zap
            </Link>
            <Link
              className={styles.ghostBtn}
              href="/roadmap#foundation"
              data-analytics-event="growth_link_clicked"
              data-analytics-cta="release_map"
              data-analytics-content="docs_release"
            >
              Full release map
            </Link>
          </div>
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
            The product lives at /zap in five surfaces: Start chooses an outcome, Compose builds the route and policy,
            Zap now creates and executes live v1.1 Zaps, Automate creates live v3/v3.1 recurring or price-triggered
            Zaps, and Connect prepares an executor address for terms the owner later signs. The builder compiles a
            design and names every guard the selected contract does not bind. A deployed route carries its amount,
            slippage, execution gas, and gas-price cap into Zap now. Automatable designs also carry cadence, Zap count,
            trigger terms, and executor access into Automate. The v3.2 stacking path remains a deployed candidate;
            anything else saves as a design and cannot deploy today. Simulation never broadcasts a transaction or
            asks for wallet authority.
          </p>
          <p className={styles.prose}>
            A copied <code>?d=</code>{" "}share link carries only the designed chain into Compose. The builder treats that
            payload as untrusted: it bounds its size and node count, keeps only recognized blocks and valid parameter
            values, then recompiles what survives against the current catalog. The link grants no wallet authority.
            Design mode never prompts for wallet access, approval, funding, a signature, or a transaction. A supported
            live route still requires the receiver to review the selected lineage&apos;s enforced bounds and confirm the
            required wallet signature or transaction; anything outside the supported routes remains a design-only
            blueprint.
          </p>
          <div className={styles.code}>
            <pre>{`curl -X POST ${SITE_URL}/api/policies/simulate \\
  -H "content-type: application/json" \\
  -d '${EXACT_POLICY_QUICKSTART_JSON}'`}</pre>
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
            Gas limit and gas price cap are signed in v1.1 one-shot intents and standing intents. Owner-only executor
            access is live in v3/v3.1; v3.2 uses the same field but remains a deployed candidate. The v1.1 one-shot Zap
            has no submitter restriction, so the builder leaves that field out of its Zap now handoff and shows the
            limitation before the user proceeds. Invalid or out-of-range handoff values fail closed instead of falling
            back silently.
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
              ["executor", "A standing-intent field: live in v3/v3.1 and present in the v3.2 deployed candidate. Zero address leaves submission open; a nonzero address pins one eligible submitter. v1.1 does not bind a submitter."],
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
            The chain-exact endpoint pins every required read and route quote to one canonical Robinhood Chain block.
            It returns the block identity, live adapter and token allowlists, runtime code hashes, a seeded-vault proof
            when the route requires one, the block-pinned quote and minimum output, the Solidity-exact policy hash, an
            unsigned EIP-712 draft, and an ephemeral factory <code>eth_call</code>. Stress-quote failures stay explicit
            and produce a warning instead of synthetic output. The endpoint never signs or broadcasts. In production
            it fails closed unless both the exact-policy API and durable-quota gates are active; an unavailable response
            is not a simulated pass.
          </p>
          <div className={styles.code}>
            <pre>{`type ExactPolicyArtifact = {
  status: "pass" | "warn"
  mode: "chain-exact"
  chain: {
    chainId: 4663
    blockNumber: string
    blockHash: \`0x\${string}\`
    rpcStatus: "verified"
  }
  allowlists: { adapterAllowed: true; tokens: Array<{ allowed: true }> }
  runtimeCode: { factory: object; implementation: object; adapters: object[] }
  quote: { amountIn: string; amountOut: string; minOut: string; blockNumber: string }
  compiled: {
    policyHash: \`0x\${string}\`
    predictedZap: \`0x\${string}\`
    unsignedEip712: object
  }
  ethCall: { method: "eth_call"; broadcast: false }
  stressCases: Array<{ status: "quoted" | "rpc-failure" }>
  authority: { signed: false; broadcast: false }
}`}</pre>
          </div>
        </section>

        <section className={styles.section} id="templates">
          <h2 className={styles.h2}>Policy templates</h2>
          <p className={styles.prose}>
            The cards below are built-in draft starters. The public registry is readable only when configured;
            wallet-attributed publication and exact-version subscriptions are separate production-gated writes. A
            subscription is convenience metadata, not execution authority, reputation, or permission to follow an
            unreviewed latest version.
          </p>
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
          <h2 className={styles.h2}>Automation &amp; the executor economy (v3 / v3.1)</h2>
          <p className={styles.prose}>
            The v3 Zap adds two standing execution types to the one-shot policy. Both are owner-signed once and
            condition-gated <em>by the contract</em>, so an eligible executor can submit a run the Zap owes, and the
            chain rejects every run it does not.
          </p>
          <p className={styles.prose}>
            v3.2 adds an owner-signed post-fee output slice that stacks 0xZAPS, two spot-derived floors, and a one-way
            permanent policy halt. Its contracts are deployed and pre-audit, but the lineage remains a candidate until
            its production creation, execution, halt, and evidence canaries pass.
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
            Build one in <Link href="/zap?view=design">Compose</Link>, then review it in{" "}
            <Link href="/zap?view=automate">Automate</Link>. The signed intent exports as a JSON file an eligible
            executor can serve; the reference executor daemon lives in <code>executor/</code> in the repository. The v3
            and v3.1 contracts are live on Robinhood Chain.
          </p>
        </section>

        <section className={styles.section} id="agents">
          <h2 className={styles.h2}>Connecting an agent</h2>
          <p className={styles.prose}>
            An agent is connected to a Zap when you sign a standing intent naming that agent&rsquo;s address in the
            intent&rsquo;s <code>executor</code> field. The capsule reverts <code>ExecutorMismatch</code> for anyone
            else. There is no credential to issue, store, or steal &mdash; the connection is one field of your own
            signature, and nothing off-chain is trusted to enforce it.
          </p>
          <p className={styles.prose}>
            That bounds the blast radius exactly. A fully compromised agent can submit a run the capsule already owes,
            or refuse to submit one. It cannot change the recipient, amount, cadence, or output floor; cannot run early,
            twice, or past the end; and cannot create, fund, or drain a capsule. Leaving the executor unset
            (<code>0x0</code>) keeps the authorization open to any submitter, which maximises liveness; pinning one
            address trades that for exclusivity, and a pinned agent going offline stalls the series until you submit it
            yourself or sign new terms.
          </p>
          <p className={styles.prose}>
            The read-only Agent Kit can discover capsules and request exact policy simulations. It holds no key and
            reads public chain data; it has no credential that could be mistaken for execution authority. Its scoped
            npm release is live; point your client at it, ask the agent for its public address, then pin that address in{" "}
            <Link href="/zap?view=connect">Connect</Link>.
          </p>
          {OPENZAPS_AGENT_KIT_PUBLISHED ? (
            <div className={styles.code}>
              <pre>{mcpClientSnippet()}</pre>
            </div>
          ) : (
            <p className={styles.prose}>
              The packages are published, but this deployment has not explicitly enabled the install snippet.
            </p>
          )}
          <p className={styles.prose}>
            Pinning is public: the executor address is inside the signed intent and in the chain&rsquo;s logs, so anyone
            can see which agent runs your Zap. To revoke, stop the agent (the series stalls, costing no transaction),
            invalidate the authorization id onchain, or sign fresh terms under a new series id.
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
            The published <code>@openzaps/sdk@0.1.0</code> source lives in <code>packages/sdk</code>. It compiles the
            Solidity policy tuple and prepares unsigned EIP-712 data; its client exposes the exact simulation endpoint
            and has no signing or broadcast method.
          </p>
          <div className={styles.code}>
            <pre>{`import { OpenZapsClient } from "@openzaps/sdk"

const openzaps = new OpenZapsClient()
const artifact = await openzaps.simulatePolicy({
  routeId: "robinhood-v4-weth-zaps",
  owner: "0xYourAddress",
  amount: "0.01",
  slippageBps: 150,
})

// Live allowlists + code hashes + quote + policy hash,
// unsigned EIP-712 draft + eth_call. Never a transaction.
if (artifact.status === "warn") reviewStressCases(artifact)`}</pre>
          </div>
          <p className={styles.prose}>
            Every chain-dependent field is pinned to one block. An RPC failure stays labelled unavailable; the client
            never substitutes a fixed token price. What actually executes is the deployed contract, not this surface. Read{" "}
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
            the exact amount are fixed at that moment. An executor picks the moment and nothing else. The status here is
            read from config, not written by hand: the contracts are{" "}
            <strong>{STATUS.preAudit ? "live and not externally audited" : "externally audited"}</strong>.
          </p>
          <p className={styles.prose}>
            Bounded aeWETH ↔ 0xZAPS creation is open on {CHAIN.name}, and the funds a Zap holds are real. Production
            use still needs external audit, formal verification, adapter governance, and a monitored launch path.
            Onchain actions are irreversible: once an execution lands, nothing here can undo it. Owners retain
            lineage-specific nonce or series invalidation and tracked-asset recovery controls; the v3.2 candidate also
            exposes a one-way permanent policy halt. Deposit only what you can afford to lose.
          </p>
          <div className={styles.code}>
            <pre>{`User / Safe
  -> OpenZapFactory
  -> OpenZap clone with frozen policy
  -> allowlisted adapter
  -> recipient-bound postcondition

Agent / executor:
  discover -> simulate -> eligible submission -> public evidence
  no wallet key or signing authority
  no arbitrary calldata or automatic revoke right`}</pre>
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
