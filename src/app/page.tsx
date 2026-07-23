import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import { BoltIntro } from "@/components/BoltIntro";
import { BuyButton } from "@/components/BuyButton";
import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { CountUp } from "@/components/CountUp";
import { CopyButton } from "@/components/CopyButton";
import { TOKEN, TOKEN_LAUNCH, LINKS, CHAIN, CONTRACTS, contractsLive, explorer } from "@/lib/config";
import { POLICY_TEMPLATES } from "@/lib/policy";
import {
  BLOCKS,
  RECIPES,
  SHAPE_COLOR,
  SHAPE_LABEL,
  CATEGORY_LABEL,
  getBlock,
  type BlockCategory,
  type FlowShape,
  type LegoBlock,
} from "@/lib/blocks";
import { absoluteUrl } from "@/lib/seo";
import styles from "./page.module.css";

/* ---------------------------------------------------------------------------
   Everything the builder copy below counts or names is READ FROM THE CATALOG,
   never typed. A block added to `BLOCKS` or a blueprint added to `RECIPES`
   updates this page by itself, so the marketing claim cannot drift away from
   the thing it describes.
   --------------------------------------------------------------------------- */

const SHAPES = Object.keys(SHAPE_COLOR) as FlowShape[];

/** Category → how many blocks live in it, in catalog order. */
const CATEGORY_COUNTS = (Object.keys(CATEGORY_LABEL) as BlockCategory[])
  .map((category) => ({ category, count: BLOCKS.filter((block) => block.category === category).length }))
  .filter((entry) => entry.count > 0);

/** What a block does to the value passing through it, in connector language. */
function shapeLine(block: LegoBlock): string {
  if (block.kind === "guard") return "binds the policy";
  const inbound = block.accepts ? SHAPE_LABEL[block.accepts] : "start";
  const outbound = block.emits ? SHAPE_LABEL[block.emits] : "settled";
  return `${inbound} → ${outbound}`;
}

/**
 * The blueprint drawn on the right of the builder band, as real catalog blocks.
 *
 * `wire` is carried forward the same way `shapeBefore` carries it: a guard
 * constrains the chain without transforming it, so the connector running past a
 * guard stays the colour of whatever is still on it. Only the guard's own stud
 * goes neutral, which is precisely the rule the copy underneath states.
 */
const DEMO_RECIPE = RECIPES[0];
const DEMO_ROWS = (() => {
  let flowing: FlowShape | null = null;
  return DEMO_RECIPE.blocks.flatMap(([id]) => {
    const block = getBlock(id);
    if (!block) return [];
    // Only a block that actually emits changes what is on the wire. Keying
    // this on "not a guard" instead let a sink blank the connector, which is
    // invisible today only because the last row's wire is not drawn.
    if (block.emits) flowing = block.emits;
    const own = block.kind === "guard" ? null : (block.emits ?? block.accepts);
    return [
      {
        block,
        stud: own ? SHAPE_COLOR[own] : "var(--muted)",
        wire: flowing ? SHAPE_COLOR[flowing] : "var(--muted)",
      },
    ];
  });
})();

const stats = [
  { v: "0", k: "Broad wallet approvals" },
  { v: String(BLOCKS.length), k: "Typed blocks in the builder" },
  { v: String(RECIPES.length), k: "Blueprints to start from" },
  { v: "1", k: "Route the live contracts can deploy" },
] as const;

const authorityModels = [
  {
    label: "01 / Deposit",
    title: "Pre-funded immutable zap",
    body: "The assets sit in the capsule instead of your wallet. The capsule runs the step its policy already commits to and nothing else. The owner keeps an unconditional withdraw and revocation path.",
    grade: "One signed step",
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
    body: "Contract wallets sign the same typed policy. Hermes stays a submitter, simulator, and monitor. It holds no discretion over what executes.",
    grade: "Power users",
  },
] as const;

const security = [
  "Fixed adapters only — no arbitrary target or calldata",
  "Exact approvals, reset to zero on every path",
  "Authorization consumed before any external call",
  "Measured balance-delta postconditions",
  "Unconditional owner emergency exit",
  "ERC-1271 contract-wallet signatures",
] as const;

const flow = [
  {
    label: "01 / Compose",
    title: "Snap the chain together",
    body: `Drag ${BLOCKS.length} typed blocks — or open one of ${RECIPES.length} blueprints — and they only seat where the shape flowing out matches the shape the next block expects.`,
    grade: "Visual builder",
  },
  {
    label: "02 / Review",
    title: "Read the compiled verdict",
    body: "Connector fit, block maturity, the governing slippage cap, guard coverage, and a gas estimate, compiled from the chain you drew. No wallet is asked for anything at this point.",
    grade: "No wallet yet",
  },
  {
    label: "03 / Deploy",
    title: "Only the bounded route leaves the canvas",
    body: "A design that reduces to the one route the live contracts implement hands the app a prefilled direction, amount, and slippage cap. You create, fund, and sign it there. Every other design stays a design and cannot be deployed today.",
    grade: "aeWETH ↔ 0xZAPS",
  },
  {
    label: "04 / Verify",
    title: "Read the capsule back onchain",
    body: "Each deployed capsule has its own page: factory provenance, clone integrity, a policy that rehashes to its committed hash, and every execution its logs actually contain.",
    grade: "Per-capsule page",
  },
] as const;

/** The provenance gate a per-capsule page runs before it claims anything. */
const capsuleProof = [
  {
    title: "Factory provenance",
    body: "The canonical factory's own ZapCreated log has to name the address. Nothing else puts a capsule on this site.",
  },
  {
    title: "Clone integrity",
    body: "The EIP-1167 runtime has to match the canonical implementation it claims to be a minimal proxy for.",
  },
  {
    title: "Policy match",
    body: "The stored policy has to rehash to the policyHash the capsule committed to before it could ever run.",
  },
] as const;

const capsuleNevers = ["USD value", "Token price", "PnL", "APY", "Success rate"] as const;

const faqs = [
  {
    q: "What is OpenZaps?",
    a: "An OpenZaps capsule is a DeFi action with its choices already made: the target, the recipient, the asset, and the calldata are fixed when the owner signs the policy. Whatever executes the capsule cannot change any of those four fields, because changing one changes the policy hash the capsule committed to. Today the owner submits every transaction from their own wallet.",
  },
  {
    q: "How is this different from giving an agent my wallet?",
    a: "A wallet approval lets whoever holds it spend up to the allowance on anything it can reach. An OpenZaps policy is signed with EIP-712 and binds the chain, the exact input amount, the recipient, the deadline, and the postconditions before anything can execute. The agent holds no broad approval and no custody, and the owner keeps an unconditional revoke and exit path.",
  },
  {
    q: "Can a chain I design in the builder actually be deployed?",
    a: "Only if the design reduces to the single bounded route the live v1.1 contracts implement: a one-step aeWETH ↔ 0xZAPS swap on Robinhood Chain, with the recipient forced to the capsule owner and the relayer fee cap at zero. Such a design hands the app a prefilled direction, amount, and slippage cap. You still create, fund, and sign the capsule yourself; nothing is auto-submitted. Multi-step routes, lending, liquidity, bridges, and loops compile, simulate, and save as designs, but cannot be deployed today. The canvas says which one you have.",
  },
  {
    q: `Is the ${TOKEN.symbol} token live?`,
    a: `Yes. ${TOKEN.symbol} is live on ${TOKEN_LAUNCH.network} through a creator-verified ${TOKEN_LAUNCH.venue} ${TOKEN_LAUNCH.version} market. Verify the contract address published on this site before trading.`,
  },
  {
    q: `Do I need ${TOKEN.symbol} to use the protocol?`,
    a: "No. Every core workflow — create, fund, execute, recover — works without holding it. 0xZAPS is the ERC-20 paired with aeWETH in the first bounded live route, and it carries no claim on revenue, yield, or assets. Holding 100,000 or more turns on app-level conveniences: auto-refreshing quotes, extended history, and receipt export.",
  },
  {
    q: "Are the contracts audited?",
    a: "No. The v1.1 contracts have not been externally audited. They are deployed on Robinhood Chain and their source is verified on the block explorer, so you can read what you are signing before you sign it. Onchain actions are irreversible and deposited funds are at risk.",
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
  "Submit within owner-signed limits",
  "Monitor receipts + approvals",
  "Revoke or escalate anomalies",
] as const;

export default function Home(): React.JSX.Element {
  return (
    <>
      {/* The entrance runs only here. The guard script in the root layout
          keys on the "/" pathname for exactly that reason. */}
      <BoltIntro />
      <main className={styles.page} id="main">
      {/* ---------------- hero ---------------- */}
      <section className={`container ${styles.hero}`} id="top">
        <div className={styles.heroCopy}>
          <span className="badge">Bounded execution on {CHAIN.name}</span>
          <h1 className={styles.title}>
            <span>A zap cannot do</span>
            <span>anything it was</span>
            <span className="gradientText">not signed to do.</span>
          </h1>
          <p className={styles.lead}>
            A zap is a DeFi action with the choices already made: the target, the recipient, the asset, and the
            calldata are fixed when the owner signs the policy. Nothing that executes it can change the four. Today
            the owner submits every transaction from their own wallet.
          </p>
          {/* The builder is the most engaging surface we have, so it takes the
              single primary slot. Dashboard was demoted out of the row entirely
              — it is one tap away in the nav — to keep this at four controls
              that wrap cleanly on a 375px screen. */}
          <div className={styles.actions}>
            <Link href="/build" className="btn btnPrimary btnLg">
              Open the builder
            </Link>
            <Link href="/use" className="btn btnGhost btnLg">
              Use OpenZaps
            </Link>
            <Link href="/docs" className="btn btnGhost btnLg">
              Read docs
            </Link>
            <BuyButton size="lg" variant="ghost" />
          </div>
          <div className={styles.launchNotice} aria-label={`${TOKEN.symbol} live token details`}>
            <strong>${TOKEN.symbol} live</strong>
            <span>
              {TOKEN_LAUNCH.venue} {TOKEN_LAUNCH.version} · {TOKEN_LAUNCH.network}
            </span>
            {/* Copying the address is the single most common action on this
                block — make it one click instead of a select-and-drag. */}
            <CopyButton
              label={`CA ${TOKEN_LAUNCH.contract}`}
              title={`Copy the ${TOKEN.symbol} contract address`}
              value={TOKEN_LAUNCH.contract}
            />
            <a href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
              Explorer ↗
            </a>
          </div>
          <div className={styles.proof}>
            <span>ERC-20 first</span>
            <span>EIP-712 intents</span>
            <span>ERC-1271 ready</span>
            <span>Revocable policies</span>
            <span>RPC-verified receipts</span>
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
              <span className={styles.live}>{contractsLive() ? "live" : "preview"}</span>
            </div>
            <pre>
              {[
                "draft(template)           pass",
                "simulate(latestBlock)     pass",
                "diff(policyVersion)       pass",
                "bind(spend, recipient)    pass",
                "submit(ownerWallet)       live",
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
        {stats.map((s, i) => (
          <Reveal className={styles.stat} delay={i * 70} key={s.k}>
            <strong>
              <CountUp value={s.v} />
            </strong>
            <span>{s.k}</span>
          </Reveal>
        ))}
      </section>

      {/* ---------------- visual builder ---------------- */}
      <section className={`container ${styles.section}`} id="builder">
        <Reveal as="header" className={styles.head}>
          <span className="eyebrow">Visual builder</span>
          <h2>Blocks that only seat where the shapes match.</h2>
          <p>
            Every DeFi action is a piece with a typed stud: it declares the shape of value it consumes and the shape
            it emits. A gauge stake only seats under something that emits an LP position; a harvest only seats under
            something claimable. {BLOCKS.length} blocks across {CATEGORY_COUNTS.length} categories and{" "}
            {RECIPES.length} blueprints, all governed by the same connector rule the policy compiler enforces before
            anything is signed.
          </p>
        </Reveal>

        <div className={styles.builderGrid}>
          <Reveal className={styles.builderPanel}>
            <div className={styles.legend}>
              {SHAPES.map((shape) => (
                <span className={styles.legendItem} key={shape}>
                  <i style={{ background: SHAPE_COLOR[shape] }} />
                  {SHAPE_LABEL[shape]}
                </span>
              ))}
            </div>
            <p className={styles.legendNote}>
              {/* Explicit space: the JSX transform swallows the one that would
                  otherwise sit between the closing tag and the next word. */}
              {SHAPES.length} shapes move along the connectors, and the colour <em>is</em>{" "}
              the shape — on the canvas, and again on a deployed capsule&apos;s own page. Drag runs on pointer
              events, so the same chain assembles with a thumb; tap-to-add and per-block arrow buttons reach
              every block without a pointer at all.
            </p>

            <div className={styles.catRow}>
              {CATEGORY_COUNTS.map(({ category, count }) => (
                <span className={styles.cat} key={category}>
                  {CATEGORY_LABEL[category]} <b>{count}</b>
                </span>
              ))}
            </div>

            <div className={styles.builderActions}>
              <Link href="/build" className="btn btnPrimary btnLg">
                Open the builder
              </Link>
            </div>

            <p className={styles.honesty}>
              <strong>The canvas designs zaps — it does not deploy them.</strong> Every chain here compiles and
              simulates, but the only one the live contracts can carry today is a single-step aeWETH ↔ 0xZAPS swap.
              Anything else saves as a design, and the readout names which one you have.
            </p>
          </Reveal>

          <Reveal className={styles.chainCard} delay={90}>
            <div className={styles.chainHead}>
              <strong>{DEMO_RECIPE.name}</strong>
              <span>blueprint</span>
            </div>
            <ol className={styles.chain}>
              {DEMO_ROWS.map(({ block, stud, wire }, i) => (
                <li
                  className={styles.chainRow}
                  key={`${block.id}-${i}`}
                  style={{ "--stud": stud, "--wire": wire, "--row-i": i } as React.CSSProperties}
                >
                  <span className={styles.chainName}>{block.name}</span>
                  <span className={styles.chainShape}>{shapeLine(block)}</span>
                </li>
              ))}
            </ol>
            <p className={styles.chainFoot}>
              Guards are transparent to the connector maths — they constrain the chain without changing what flows, so
              they seat anywhere below the source.
            </p>
          </Reveal>
        </div>

        <div className={styles.blueprints}>
          {RECIPES.map((recipe, i) => (
            <Reveal
              className={styles.blueprint}
              delay={i * 70}
              key={recipe.id}
              style={{ "--accent": SHAPE_COLOR[recipe.accent] } as React.CSSProperties}
            >
              <strong>{recipe.name}</strong>
              <span>{recipe.tagline}</span>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- token band ---------------- */}
      <section className={`container ${styles.tokenBand}`}>
        <div className={styles.tokenMark}>
          <OpenZapMark />
          <span className={styles.tokenTicker}>{TOKEN.symbol}</span>
        </div>
        <div>
          <p className={styles.tokenLead}>
            ${TOKEN.symbol} is the ERC-20 paired with aeWETH in the one bounded route the live contracts carry. It
            trades through a creator-verified {TOKEN_LAUNCH.venue} {TOKEN_LAUNCH.version} market on{" "}
            {TOKEN_LAUNCH.network}. It has no claim on revenue, yield, or assets, it is not equity, and every core
            OpenZaps workflow runs without holding it.
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
        <Reveal as="header" className={styles.head}>
          <span className="eyebrow">Product flow</span>
          <h2>Draw it. Read it. Deploy what is bounded. Verify it onchain.</h2>
          <p>
            The builder composes, the readout compiles a verdict, the app signs the one route the live contracts
            implement, and the capsule&apos;s own page reports what actually happened. The steps are separate on
            purpose. Nothing skips ahead of the review, and nothing on this site submits a transaction for you.
          </p>
        </Reveal>
        <div className={`${styles.modelGrid} ${styles.flowGrid}`}>
          {flow.map((step, i) => (
            <Reveal
              as="article"
              className={`${styles.modelCard} spotlight`}
              delay={i * 90}
              key={step.title}
              style={{ "--sheen-delay": `${-i * 2.6}s` } as React.CSSProperties}
            >
              <span className={styles.modelLabel}>{step.label}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <strong>{step.grade}</strong>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- deployed capsules ---------------- */}
      <section className={`container ${styles.section} ${styles.capsules}`} id="capsules">
        <div>
          <span className="eyebrow">Deployed capsules</span>
          <h2>A capsule page reports reads, not estimates.</h2>
          <p>
            Each address the factory created gets its own page, read from {CHAIN.name}{" "}
            at a single pinned block. Provenance is the gate: three things have to hold before the page claims
            anything at all. Only then is the deployed policy drawn back as a lego chain in the builder&apos;s own
            vocabulary, from the policy&apos;s real fields rather than a template.
          </p>
          <ol className={styles.proofList}>
            {capsuleProof.map((item, i) => (
              <Reveal as="li" className={styles.proofItem} delay={i * 70} key={item.title}>
                <b>{String(i + 1).padStart(2, "0")}</b>
                <span>
                  {item.title}
                  <em>{item.body}</em>
                </span>
              </Reveal>
            ))}
          </ol>
          <div className={styles.builderActions}>
            <Link href="/zaps" className="btn btnPrimary btnLg">
              Browse deployed zaps
            </Link>
          </div>
          <p className={styles.capsuleNote}>
            This page does not state how many capsules exist. The number changes onchain and this page is statically
            rendered, so it is counted where it can be counted: from the factory&apos;s own ZapCreated logs, on /zaps.
          </p>
        </div>

        <aside className={styles.neverCard}>
          <div className={styles.agentHead}>A capsule page never shows</div>
          {capsuleNevers.map((item) => (
            <Reveal className={styles.never} key={item}>
              <i aria-hidden>✕</i>
              <strong>{item}</strong>
            </Reveal>
          ))}
          <p className={styles.neverNote}>
            A reverted execution emits no log, so any success rate computed from logs would be unfalsifiable. A failed
            RPC read renders as an explicit unavailable state rather than a zero. Reporting no executions when the read
            simply failed would be a false claim about a blockchain.
          </p>
        </aside>
      </section>

      {/* ---------------- protocol ---------------- */}
      <section className={`container ${styles.section}`} id="protocol">
        <Reveal as="header" className={styles.head}>
          <span className="eyebrow">Authority model</span>
          <h2>Execution authority must live somewhere explicit.</h2>
          <p>
            OpenZaps split creation, execution, and submission authority so you can walk away without handing an
            agent broad approvals or custody. Pick the surface that fits the workflow.
          </p>
        </Reveal>
        <div className={styles.modelGrid}>
          {authorityModels.map((m, i) => (
            <Reveal
              as="article"
              className={`${styles.modelCard} spotlight`}
              delay={i * 90}
              key={m.title}
              style={{ "--sheen-delay": `${-i * 3.1}s` } as React.CSSProperties}
            >
              <span className={styles.modelLabel}>{m.label}</span>
              <h3>{m.title}</h3>
              <p>{m.body}</p>
              <strong>{m.grade}</strong>
            </Reveal>
          ))}
        </div>
      </section>

      <section className={`container ${styles.section}`} id="templates">
        <Reveal as="header" className={styles.head}>
          <span className="eyebrow">Reusable templates</span>
          <h2>Start narrow. Expand only after the controls hold.</h2>
          <p>
            The live route is one pinned Robinhood pool and one fixed adapter. None of the templates below reduces to
            it, so none of them can be deployed today. Each one carries its own production status, and a template
            widens only once an adapter and a token allowlist exist for it onchain.
          </p>
        </Reveal>
        <div className={styles.modelGrid}>
          {POLICY_TEMPLATES.map((template, i) => (
            <Reveal
              as="article"
              className={`${styles.modelCard} spotlight`}
              delay={i * 90}
              key={template.id}
              style={{ "--sheen-delay": `${-i * 2.2}s` } as React.CSSProperties}
            >
              <span className={styles.modelLabel}>{template.production.replace("-", " ")}</span>
              <h3>{template.name}</h3>
              <p>{template.description}</p>
              <strong>{template.category}</strong>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- security ---------------- */}
      <section className={`container ${styles.section} ${styles.security}`} id="security">
        <div>
          <span className="eyebrow">Security posture</span>
          <h2>A narrow contract has fewer things an attacker can ask it to do.</h2>
          <p>
            The v1.1 contracts have not been externally audited. The source is verified on the block explorer and
            linked below; read it before you sign anything. One route is live: a single-step aeWETH ↔ 0xZAPS swap,
            with the recipient forced to the capsule owner and the relayer fee cap set to zero. The multi-block designs
            you can assemble in the builder cannot be deployed today. Onchain actions are irreversible. The owner keeps
            an unconditional withdraw and revoke path.
          </p>
          <div className={styles.checkGrid}>
            {security.map((c, i) => (
              <Reveal className={styles.check} delay={i * 60} key={c}>
                <span>✓</span>
                {c}
              </Reveal>
            ))}
          </div>
          <a className={styles.repoLink} href={LINKS.contractSource} target="_blank" rel="noreferrer">
            Read the verified contract source ↗
          </a>
          <br />
          <Link className={styles.repoLink} href="/docs#security">
            Security model →
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
          <div className={styles.agentHead}>Designed agent loop</div>
          <p className={styles.agentNote}>
            None of this runs today. The owner submits every transaction from their own wallet. These are the six
            steps an agent would be confined to, and the reason each one is safe to hand over is that the policy has
            already fixed what it may touch.
          </p>
          {agentLoop.map((item, i) => (
            <Reveal className={styles.loopRow} delay={i * 70} key={item}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <strong>{item}</strong>
            </Reveal>
          ))}
        </aside>
      </section>

      {/* ---------------- faq ---------------- */}
      <section className={`container ${styles.section}`} id="faq">
        <JsonLd data={homeFaqJsonLd} />
        <Reveal as="header" className={styles.head}>
          <span className="eyebrow">FAQ</span>
          <h2>Straight answers.</h2>
        </Reveal>
        <div className={styles.faqs}>
          {faqs.map((f, i) => (
            <Reveal as="details" className={styles.faq} delay={i * 60} key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- final CTA ---------------- */}
      <section className={`container ${styles.cta}`}>
        <div className={styles.ctaInner}>
          <OpenZapMark className={styles.ctaMark} />
          <h2>
            Bound the agent before you fund it.
          </h2>
          <p>Connect a wallet to quote, deploy, fund, sign, execute, verify, and recover a bounded zap.</p>
          <div className={styles.actions}>
            <Link href="/use" className="btn btnGhost btnLg">
              Use OpenZaps
            </Link>
            <Link href="/roadmap" className="btn btnPrimary btnLg">
              Roadmap
            </Link>
          </div>
          <p className={styles.ctaNote}>
            Not financial advice. {TOKEN.symbol} is an ERC-20. It has no claim on revenue, yield, or assets, and no
            return is implied. Onchain actions are irreversible. The contracts have not been externally audited.
          </p>
        </div>
      </section>
    </main>
    </>
  );
}
