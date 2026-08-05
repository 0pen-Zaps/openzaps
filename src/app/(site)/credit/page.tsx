import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { TOKEN } from "@/lib/config";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";

import { CreditSimulator } from "./CreditSimulator";
import {
  ACTION_PERMIT_FIELDS,
  ARCHITECTURE,
  CURRENT_STATE,
  INVARIANTS,
  PILOT_PARAMETERS,
  PRODUCT_LAYERS,
  RESEARCH_SOURCES,
  ROLLOUT,
  STRATEGIES,
} from "./credit-data";
import { recursiveExposureMultiple } from "./credit-model";
import styles from "./credit.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.credit,
  keywords: [
    "agent credit",
    "agent lending",
    "Robinhood Chain lending",
    "Uniswap v4 agent pool",
    "ERC-8004 agent identity",
    "USDG lending",
    "0xZAPS collateral",
    "purpose-bound stablecoin credit",
  ],
});

const SECTION_LINKS = [
  { href: "#verdict", label: "Verdict" },
  { href: "#architecture", label: "Architecture" },
  { href: "#identity", label: "Identity + hook" },
  { href: "#credit", label: "Credit design" },
  { href: "#simulator", label: "Simulator" },
  { href: "#risk", label: "Risk policy" },
  { href: "#rollout", label: "Rollout" },
  { href: "#specification", label: "Specification" },
  { href: "#research", label: "Sources" },
] as const;

const THREAT_TESTS = [
  "Borrow, pump the pricing pool, and try to borrow again in the same transaction.",
  "Forge an agent ID in hookData or call PoolManager through an unapproved router.",
  "Replay one permit across another pool, chain, policy account, or nonce.",
  "Transfer the identity NFT or revoke the ERC-1271 policy while debt is open.",
  "Route proceeds through arbitrary approvals, Permit2, callbacks, or a malicious recipient.",
  "Create 100 identities controlled by one principal and test global exposure limits.",
  "Remove 25%, 50%, 75%, and 90% of liquidation depth while 0xZAPS falls.",
  "Hold a stale-high oracle through a sequencer outage and delayed liquidations.",
  "Move a concentrated LP entirely into 0xZAPS during a collapse.",
  "Attack the first lender deposit through ERC-4626 donation and rounding paths.",
] as const;

function ResearchLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <span aria-hidden>↗</span>
    </a>
  );
}

export default function AgentCreditPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main" data-screen-label="Agent Credit">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.credit),
            breadcrumbJsonLd("/credit", "Agent Credit"),
            {
              "@type": "TechArticle",
              headline: "Purpose-bound agent credit on Robinhood Chain",
              description: STATIC_PAGE_SEO.credit.description,
              dateModified: "2026-07-29",
              author: { "@type": "Organization", name: "OpenZaps" },
            },
          ],
        }}
      />

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span aria-hidden />
            OpenZaps protocol research · 29 July 2026
          </p>
          <h1>Purpose-bound credit for onchain agents.</h1>
          <p className={styles.heroLead}>
            Registered agents lock {TOKEN.symbol}, borrow existing USDG into a policy account, and can use it only for
            pre-committed strategies whose outputs stay locked. Identity controls access. Collateral and first-loss
            capital control risk.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryAction} href="#simulator">
              Run the stress model
              <span aria-hidden>↓</span>
            </a>
            <Link className={styles.secondaryAction} href="/roadmap">
              Ecosystem roadmap
            </Link>
          </div>
        </div>

        <aside className={styles.heroPosture} aria-label="Research status">
          <span className={styles.heroPostureLabel}>Status</span>
          <strong>Refined proposal. Nothing here is deployed.</strong>
          <p>
            OpenZaps has live bounded execution on Robinhood Chain. It does not currently have an agent identity
            registry, lending controller, credit vault, or agent-gated pool.
          </p>
          <ul>
            <li>Use canonical USDG; do not issue a new stablecoin first.</li>
            <li>Keep debt proceeds out of arbitrary agent wallets.</li>
            <li>Independent pricing and liquidation depth are launch blockers.</li>
          </ul>
        </aside>

        <div className={styles.heroFlow} aria-label="Purpose-bound agent credit loop">
          {["Lock 0xZAPS", "Verify account", "Borrow USDG", "Execute one policy", "Lock output", "Repay or liquidate"].map(
            (step, index) => (
              <div key={step}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{step}</strong>
                {index < 5 ? <i aria-hidden>→</i> : null}
              </div>
            ),
          )}
        </div>
      </section>

      <div className={styles.layout}>
        <nav className={styles.sectionNav} aria-label="Agent Credit sections">
          <span>On this page</span>
          {SECTION_LINKS.map((item) => (
            <a href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
          <Link href="/docs">Live protocol docs</Link>
        </nav>

        <div className={styles.content}>
          <section className={styles.section} id="verdict">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Research verdict</span>
              <h2>Keep access, credit, and stablecoin issuance separate.</h2>
              <p>
                The original loop is compelling, but three corrections make it defensible: authenticate a canonical
                policy account rather than a hook callback address, contain debt inside an isolated market, and use the
                dollar asset Robinhood Chain already has.
              </p>
            </header>

            <div className={styles.stateGrid}>
              {CURRENT_STATE.map((item, index) => (
                <Reveal as="article" className={styles.stateCard} data-tone={item.tone} delay={index * 45} key={item.title}>
                  <span>{item.label}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </Reveal>
              ))}
            </div>

            <div className={styles.decisionBanner}>
              <span>Recommended product</span>
              <strong>OpenZaps Agent Credit Lane</strong>
              <p>
                A purpose-bound USDG credit rail for registered, policy-constrained agent accounts—not a new
                stablecoin, not unsecured credit, and not a way to recursively finance {TOKEN.symbol} demand.
              </p>
            </div>

            <div className={styles.layerGrid}>
              {PRODUCT_LAYERS.map((layer) => (
                <article key={layer.number}>
                  <span>{layer.number}</span>
                  <h3>{layer.title}</h3>
                  <p>{layer.summary}</p>
                  <small>{layer.decision}</small>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.section} id="architecture">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>System architecture</span>
              <h2>One bounded account sits between identity and capital.</h2>
              <p>
                The principal owns the collateral, recovery path, and debt. The agent receives a revocable session key
                for typed actions. This preserves OpenZaps&apos; core rule: automation can choose when to submit, never
                what authority exists.
              </p>
            </header>

            <div className={styles.architectureMap} aria-label="Agent Credit contract flow">
              <div className={styles.archIdentity}>
                <span>Access</span>
                <strong>ERC-8004-compatible identity</strong>
                <small>current wallet binding + qualification policy</small>
              </div>
              <i aria-hidden>↓</i>
              <div className={styles.archCore}>
                <span>Authority</span>
                <strong>Principal-owned AgentCreditAccount</strong>
                <small>typed permit · fixed recipient · nonce · deadline · policy hash</small>
              </div>
              <i aria-hidden>↓</i>
              <div className={styles.archSplit}>
                <div>
                  <span>Execution</span>
                  <strong>AgentRouter → v4 AgentGateHook</strong>
                  <small>BUY_AND_LOCK or ADD_LIQUIDITY_AND_LOCK</small>
                </div>
                <div>
                  <span>Credit</span>
                  <strong>CreditController ← USDGLenderVault</strong>
                  <small>isolated caps · interest · health · reserve</small>
                </div>
              </div>
              <i aria-hidden>↓</i>
              <div className={styles.archRisk}>
                <span>Risk reduction stays open</span>
                <strong>OracleGuard · repay · top up · unwind · permissionless liquidation</strong>
              </div>
            </div>

            <div className={styles.componentGrid}>
              {ARCHITECTURE.map((component, index) => (
                <Reveal as="article" delay={(index % 4) * 40} key={component.name}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <h3>{component.name}</h3>
                  <p>{component.role}</p>
                  <small>{component.trust}</small>
                </Reveal>
              ))}
            </div>
          </section>

          <section className={styles.section} id="identity">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Identity + Uniswap v4</span>
              <h2>The hook cannot identify an agent from sender alone.</h2>
              <p>
                In a normal v4 swap, the callback&apos;s sender is usually the router that called PoolManager. The hook
                itself is called by PoolManager. A simple registry lookup on sender would authenticate infrastructure,
                not the ultimate agent.
              </p>
            </header>

            <div className={styles.callTrace}>
              <div>
                <span>01</span>
                <strong>Agent wallet</strong>
                <small>signs exact action</small>
              </div>
              <i aria-hidden>→</i>
              <div>
                <span>02</span>
                <strong>AgentRouter</strong>
                <small>verifies signer + nonce</small>
              </div>
              <i aria-hidden>→</i>
              <div>
                <span>03</span>
                <strong>PoolManager</strong>
                <small>passes router as sender</small>
              </div>
              <i aria-hidden>→</i>
              <div>
                <span>04</span>
                <strong>AgentGateHook</strong>
                <small>consumes action digest</small>
              </div>
            </div>

            <div className={styles.twoCol}>
              <article className={styles.proseCard}>
                <span className={styles.kicker}>Authenticate this</span>
                <h3>Canonical account + one-use permit</h3>
                <ul>
                  <li>Factory-deployed policy-account bytecode.</li>
                  <li>Current registry wallet binding checked on every risk-increasing action.</li>
                  <li>EIP-712 for EOAs or ERC-1271 for smart-account signatures.</li>
                  <li>Approved router plus same-transaction action consumption.</li>
                  <li>Identity transfer freezes new actions but never moves the loan.</li>
                </ul>
              </article>
              <article className={styles.proseCard}>
                <span className={styles.kicker}>Do not claim this</span>
                <h3>“Only AI can use the pool”</h3>
                <ul>
                  <li>Onchain identity cannot prove software is autonomous.</li>
                  <li>Permissionless registration does not prevent Sybil identities.</li>
                  <li>Reputation does not prove solvency or honest control.</li>
                  <li>The accurate claim is “registered, policy-constrained agent accounts.”</li>
                  <li>Global caps remain necessary even with per-agent limits.</li>
                </ul>
              </article>
            </div>

            <aside className={styles.precedent}>
              <div>
                <span>Closest industry precedent · released 23 July 2026</span>
                <strong>Uniswap Permissioned Pools</strong>
              </div>
              <p>
                The official design uses approved wrappers and routers, hook checks on every swap and liquidity add,
                non-transferable LP NFTs, and an explicit unwind route. OpenZaps should adapt those enforcement
                boundaries to agent eligibility.
              </p>
              <ResearchLink href="https://developers.uniswap.org/docs/protocols/v4/permissioned-pools/architecture">
                Read the architecture
              </ResearchLink>
            </aside>
          </section>

          <section className={styles.section} id="credit">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Credit + stable asset</span>
              <h2>Borrow USDG. Keep it inside the position.</h2>
              <p>
                A normal ERC-20 cannot be purpose-restricted after it reaches an arbitrary wallet. The CreditController
                must send borrowed USDG directly to an atomic execution adapter, fix every recipient to the indebted
                account, and verify the locked output before the transaction completes.
              </p>
            </header>

            <div className={styles.stableDecision}>
              <div>
                <span>Use now</span>
                <strong>Canonical USDG on Robinhood Chain</strong>
                <p>
                  USDG already has native issuance, an official contract address, external redemption and reserve
                  infrastructure, and a live lending use case through Robinhood Earn and Morpho.
                </p>
              </div>
              <div>
                <span>Defer</span>
                <strong>A new OpenZaps stablecoin</strong>
                <p>
                  A closed-loop token spendable only on {TOKEN.symbol} or one LP is protocol credit—not a credible
                  general stablecoin. Issuance would add peg, reserve, redemption, bad-debt, legal, and shutdown systems.
                </p>
              </div>
            </div>

            <div className={styles.strategyGrid}>
              {STRATEGIES.map((item, index) => (
                <article key={item.id}>
                  <span>{index === 0 ? "Higher reflexivity" : "Preferred productive path"}</span>
                  <h3>{item.title}</h3>
                  <p>{item.flow}</p>
                  <small>{item.posture}</small>
                </article>
              ))}
            </div>

            <div className={styles.recursion}>
              <div>
                <span className={styles.kicker}>Why financed collateral gets a 0% factor</span>
                <h3>Recursive borrowing manufactures leverage, not creditworthiness.</h3>
                <p>
                  If debt-funded {TOKEN.symbol} can be posted again at LTV λ, theoretical exposure compounds to{" "}
                  <code>original collateral ÷ (1 − λ)</code> before slippage and price impact.
                </p>
              </div>
              <dl>
                {[20, 40, 50, 70].map((ltv) => (
                  <div key={ltv}>
                    <dt>{ltv}% recursive LTV</dt>
                    <dd>{recursiveExposureMultiple(ltv).toFixed(2)}× exposure</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className={styles.flywheelGrid}>
              <article data-tone="healthy">
                <span>Productive loop</span>
                <ol>
                  <li>Agents lock externally acquired {TOKEN.symbol}.</li>
                  <li>Bounded USDG enters locked liquidity.</li>
                  <li>Real swaps produce fees.</li>
                  <li>Fees repay interest and principal first.</li>
                  <li>Safe capacity grows from observed repayment.</li>
                </ol>
              </article>
              <article data-tone="danger">
                <span>Loop to reject</span>
                <ol>
                  <li>Borrow stablecoins.</li>
                  <li>Buy {TOKEN.symbol}.</li>
                  <li>Count the purchase as fresh collateral.</li>
                  <li>Borrow again and farm rewards.</li>
                  <li>Liquidations unwind the same manufactured demand.</li>
                </ol>
              </article>
            </div>
          </section>

          <section className={styles.section} id="simulator">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Interactive simulations</span>
              <h2>Make the reflexivity and lender risk visible.</h2>
              <p>
                This tested model compares buy-and-lock against a full-range locked LP, sweeps 0xZAPS shocks from −80%
                to +25%, marks USDG depegs, applies oracle and liquidation haircuts, and calculates health, equity,
                impermanent loss, and bad debt.
              </p>
            </header>
            <CreditSimulator />
          </section>

          <section className={styles.section} id="risk">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Pilot risk policy</span>
              <h2>Debt capacity follows stressed executable value.</h2>
              <p>
                Market capitalization and a same-pool spot quote are not liquidation capacity. The controller should
                lend against the minimum of haircutted oracle value, stressed exit depth, the per-agent cap, and the
                remaining global ceiling.
              </p>
            </header>

            <div className={styles.formula}>
              <span>Maximum debt</span>
              <code>min(LTV × stressed executable value, agent cap, remaining global cap)</code>
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.parameterTable}>
                <caption className="srOnly">Illustrative parameters for a tiny Agent Credit pilot</caption>
                <thead>
                  <tr>
                    <th scope="col">Control</th>
                    <th scope="col">Research starting point</th>
                    <th scope="col">Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {PILOT_PARAMETERS.map(([name, value, detail]) => (
                    <tr key={name}>
                      <th scope="row">{name}</th>
                      <td>{value}</td>
                      <td>{detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.riskGrid}>
              <article>
                <span>Oracle</span>
                <h3>Independent and fail-closed</h3>
                <p>
                  Multiple observations, conservative windows, staleness and divergence limits, USDG peg checks,
                  sequencer status, and executable-depth haircuts. If no defensible {TOKEN.symbol} price exists, mainnet
                  borrowing remains disabled.
                </p>
              </article>
              <article>
                <span>Liquidation</span>
                <h3>Open to anyone</h3>
                <p>
                  Liquidators do not need agent identity. They repay USDG and seize or unwind locked assets through a
                  dedicated adapter. A hook pause cannot block repayment, top-ups, or risk reduction.
                </p>
              </article>
              <article>
                <span>Underwriting</span>
                <h3>First-loss capital before reputation</h3>
                <p>
                  Later undercollateralized limits require a sponsor to stake USDG and absorb defaults before passive
                  lenders. Protocol-generated repayment history can tune terms but never override the solvency floor.
                </p>
              </article>
              <article>
                <span>Incentives</span>
                <h3>Pay realized value, not financed volume</h3>
                <p>
                  Credit-funded buys, self-trades, and LP notional earn no marketplace or league score. Rewards use net
                  realized value after funding, slippage, losses, and liquidation expense.
                </p>
              </article>
            </div>

            <details className={styles.threats}>
              <summary>
                <span>Mandatory adversarial simulation set</span>
                <span aria-hidden>+</span>
              </summary>
              <ol>
                {THREAT_TESTS.map((test) => (
                  <li key={test}>{test}</li>
                ))}
              </ol>
            </details>
          </section>

          <section className={styles.section} id="rollout">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Phased rollout</span>
              <h2>Prove the gate, then shadow the debt, then cap the capital.</h2>
              <p>
                Every phase has a terminal gate. Progress depends on executable evidence—not a date, token price, agent
                count, or emissions schedule.
              </p>
            </header>

            <ol className={styles.timeline}>
              {ROLLOUT.map((phase, index) => (
                <Reveal as="li" delay={(index % 3) * 40} key={phase.phase}>
                  <div>
                    <span>{phase.phase}</span>
                    <small>{phase.gate}</small>
                  </div>
                  <div>
                    <h3>{phase.name}</h3>
                    <p>{phase.detail}</p>
                  </div>
                </Reveal>
              ))}
            </ol>
          </section>

          <section className={styles.section} id="specification">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Technical specification</span>
              <h2>The implementation is a set of invariants, not a permissive router.</h2>
              <p>
                The contracts may change, but these properties cannot. They should become stateful fuzz tests,
                invariant suites, deployment canaries, monitoring rules, and incident-runbook checks.
              </p>
            </header>

            <div className={styles.specGrid}>
              <article>
                <span>Typed action permit</span>
                <h3>Every strategy request binds</h3>
                <ul>
                  {ACTION_PERMIT_FIELDS.map((field) => (
                    <li key={field}>{field}</li>
                  ))}
                </ul>
              </article>
              <article>
                <span>Protocol invariants</span>
                <h3>Every implementation preserves</h3>
                <ol>
                  {INVARIANTS.map((invariant) => (
                    <li key={invariant}>{invariant}</li>
                  ))}
                </ol>
              </article>
            </div>

            <div className={styles.docCta}>
              <div>
                <span>Repository documentation</span>
                <strong>Architecture, accounting, formulas, interfaces, launch gates, and test plan</strong>
              </div>
              <a href="https://github.com/0pen-Zaps/openzaps/blob/main/docs/agent-credit-design.md">
                Read the full design document
                <span aria-hidden>↗</span>
              </a>
            </div>
          </section>

          <section className={styles.section} id="research">
            <header className={styles.sectionHead}>
              <span className={styles.kicker}>Industry research</span>
              <h2>Primary sources behind the refinement.</h2>
              <p>
                Reviewed 29 July 2026. Draft standards, deployment addresses, protocol integrations, and product status
                can change; they must be re-verified before implementation or deployment.
              </p>
            </header>

            <ol className={styles.sources}>
              {RESEARCH_SOURCES.map((source, index) => (
                <li key={source.url}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{source.title}</strong>
                    <small>{source.publisher}</small>
                    <p>{source.finding}</p>
                  </div>
                  <ResearchLink href={source.url}>Source</ResearchLink>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.finalCallout}>
            <span>North star</span>
            <strong>
              OpenZaps gives registered agents bounded working capital for productive onchain execution while every
              permission, debt, output, and loss remains attributable and enforceable onchain.
            </strong>
            <p>
              Research and simulation only. Not an offer, lending product, stablecoin, promise of yield, or financial
              advice. Any live credit system would require independent security, oracle, economic, legal, and
              operational review.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
