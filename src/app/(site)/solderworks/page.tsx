import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { TOKEN } from "@/lib/config";
import styles from "./solderworks.module.css";

// Unlisted design preview: reachable by direct link, but deliberately kept out
// of the nav and the sitemap, and marked noindex, until the mechanics have had
// the counsel review the adversarial design review requires before any season
// runs. Everything here is framed as a design, never as a live product.
export const metadata = {
  ...pageMetadata({
    title: "SOLDERWORKS — a design preview",
    description:
      "SOLDERWORKS is a designed, not-yet-built crafting and progression layer for the OpenZaps builder. Deterministic by construction, no randomness, no live token program. This page describes a design, not a deployment.",
    path: "/solderworks",
    keywords: ["OpenZaps SOLDERWORKS", "0xZAPS utility design"],
  }),
  robots: { index: false, follow: true },
};

const mechanics = [
  {
    n: "01",
    name: "Blueprints",
    body: "A deployed policy's normalized pattern — its adapters, input tokens, and step data, never the owner or the amounts — is a keccak hash. The first deployment of a novel pattern would mint an onchain First Print, with numbered reprints after it, under a commit-reveal mint because deterministic races are front-runnable too.",
    role: (
      <>
        <b>{TOKEN.symbol}:</b> burned to etch a Blueprint; scrapping an old one discounts the next
        etch. A sink, paid in performed work.
      </>
    ),
  },
  {
    n: "02",
    name: "Counted runs",
    body: "The deployed contracts have no execution counter, and nonce storage can be flipped for free by design — so the design counts only executions a stateless, discretion-free relay itself submitted and watched succeed. The relay holds nothing, decides nothing, and can be bypassed at will. It is a scorekeeper, not an operator.",
    role: (
      <>
        <b>{TOKEN.symbol}:</b> a small burn to advance a forge level. Levels gate cosmetics only —
        never any payout.
      </>
    ),
  },
  {
    n: "03",
    name: "Print Run seasons",
    body: "A season would exist only after someone publicly escrows a fixed 0xZAPS budget onchain. The contract refuses to start unless that budget is at or below what the cheapest possible farming of it would cost in real gas and fees, and unless enough distinct participants have real counted runs. No escrow, no season — the UI shows nothing but an empty state.",
    role: (
      <>
        <b>{TOKEN.symbol}:</b> streamed to participants in proportion to counted runs, from a
        pre-escrowed fixed budget. Compensates performed executions, not balances held.
      </>
    ),
  },
  {
    n: "04",
    name: "Pattern Author Award",
    body: "The most-executed pattern in a season would pay a fixed share of the escrowed budget to that pattern's First Print author — eligibility derived from onchain adoption only, never from any paid action, and conditioned on the author's own participation that season. It is a contest award for authorship, not passive income on a transferable asset.",
    role: (
      <>
        <b>{TOKEN.symbol}:</b> a fixed slice of an already-escrowed season budget. Snapshot-bound, so
        buying the NFT never buys someone else&apos;s earned award.
      </>
    ),
  },
] as const;

const kept = [
  "Supply earned only through verifiable product use.",
  "Incentives paid to the people who actually build and run things.",
  "Irrevocable, escrow-first pre-commitments as the trust primitive.",
] as const;

const deleted = [
  "Randomness of any kind — no draws, no packs, no random traits.",
  "Any mechanic that puts principal at chance-based risk.",
  "Anything a filter, rather than the chain, would have to adjudicate.",
] as const;

const gates = [
  "The full 0xZAPS supply distribution is published before any burn mechanic ships.",
  "The season and author-award mechanics get a jurisdiction-specific counsel review before any season runs — a gate, not a footnote.",
  "Every public activity figure labels incentivized runs distinctly, or is not published at all.",
  "No randomness, ever: any future mechanic containing a draw, a pack, or a random trait is rejected at design review.",
  "No forward-looking emission promises — “designed, not scheduled” holds until an escrow exists onchain.",
] as const;

export default function SolderworksPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/solderworks", "SOLDERWORKS") }} />

      <section className={`container ${styles.hero}`}>
        <span className="badge">Design preview</span>
        <h1 className={styles.title}>
          <span className="gradientText">SOLDERWORKS</span>
        </h1>
        <p className={styles.lead}>
          A crafting-and-progression layer where the zap builder is the game board: deployed policies become
          collectible Blueprints, real executions become provable progress, and {TOKEN.symbol} pays the people who
          actually design and run zaps — while the part that holds your funds stays exactly as boring, deterministic,
          and token-ungated as it is today.
        </p>
        <div className={styles.notLive} role="note">
          <strong>Not live · designed, not scheduled</strong>
          <p>
            None of the contracts described here are deployed. There is no live token program, no season, and no date
            for one. This page explains a design so it can be reviewed in the open — the same way the roadmap describes
            work that is not built. Nothing here is a promise, and nothing here pays a return.
          </p>
        </div>
      </section>

      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">The one rule</span>
          <h2>The custody layer is never gamified.</h2>
        </header>
        <div className={styles.ruleCard}>
          <strong>Zap deployment, funding, execution, and recovery stay deterministic and token-free.</strong>
          <p>
            Every game element lives in a separate layer that can read the contracts but can never hold your principal,
            delay a withdrawal, or add a new action a zap can take. A game that gambled with funds would refute the one
            claim OpenZaps is built on — that a zap cannot do anything it was not signed to do. So it doesn&apos;t.
          </p>
        </div>
      </section>

      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">Lineage</span>
          <h2>What we studied, and what we deleted.</h2>
          <p>
            The study object was Fake World Assets — a randomized NFT protocol whose token launched by paying people to
            use the product. In July 2026 an attacker steered its random draw and took a six-figure NFT. We kept the
            parts that survive with chance removed, and removed the chance.
          </p>
        </header>
        <div className={styles.lineageGrid}>
          <div className={`${styles.lineageCol} ${styles.kept}`}>
            <h3>Kept</h3>
            <ul>
              {kept.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          </div>
          <div className={`${styles.lineageCol} ${styles.deleted}`}>
            <h3>Deleted</h3>
            <ul>
              {deleted.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">The mechanics</span>
          <h2>Four moving parts, each provable onchain.</h2>
          <p>
            Every state transition below is something the chain can prove from frozen, publicly readable policy data —
            not from a database, and not from anything a player self-reports.
          </p>
        </header>
        <div className={styles.grid}>
          {mechanics.map((m, i) => (
            <Reveal as="article" className={`${styles.card} spotlight`} delay={i * 70} key={m.n}>
              <span className={styles.cardNum}>{m.n}</span>
              <h3>{m.name}</h3>
              <p>{m.body}</p>
              <p className={styles.role}>{m.role}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">What {TOKEN.symbol} does here</span>
          <h2>Sinks and incentives for performed actions — nothing else.</h2>
          <p>
            {TOKEN.symbol} would gain burn sinks and a way to compensate real executions. It would gain no governance,
            no revenue share, no protocol access, and no claim on any asset — exactly as today. Creating, funding,
            executing, and recovering a zap never require holding it.
          </p>
        </header>
        <div className={styles.flows}>
          <div className={styles.flow}>
            <span>Sink</span>
            <strong>Blueprint etch fees</strong>
            <p>Burned to the dead address on every mint, verifiable onchain.</p>
          </div>
          <div className={styles.flow}>
            <span>Sink</span>
            <strong>Forge level flux</strong>
            <p>A small burn to advance a level. Levels are cosmetic status only.</p>
          </div>
          <div className={styles.flow}>
            <span>Incentive</span>
            <strong>Season streaming</strong>
            <p>From a pre-escrowed fixed budget, in proportion to counted runs.</p>
          </div>
          <div className={styles.flow}>
            <span>Incentive</span>
            <strong>Author award</strong>
            <p>A fixed slice of the same escrowed budget, snapshot-bound to authorship.</p>
          </div>
        </div>
      </section>

      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">Before anything ships</span>
          <h2>The gates this design holds itself to.</h2>
        </header>
        <ol className={styles.gateList}>
          {gates.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ol>
      </section>

      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">Read it plainly</span>
          <h2>What this page is, and is not.</h2>
        </header>
        <p className={styles.disclosure}>
          <strong>Every outcome in SOLDERWORKS is deterministic.</strong> Nothing is random, nothing is drawn, and no
          result depends on chance. Any future payment would compensate executed onchain actions; it would not be yield,
          interest, or a return on holding any token. This page describes a design under review — not a live product,
          not an offer, and not financial advice. {TOKEN.symbol} is an ERC-20 with no claim on revenue, yield, or
          assets. Onchain actions are irreversible, and the OpenZap contracts have not been externally audited.
        </p>
        <div className={styles.actions}>
          <Link className="btn btnGhost btnLg" href="/zap">
            Open the builder
          </Link>
          <Link className="btn btnGhost btnLg" href="/roadmap">
            See the roadmap
          </Link>
          <Link className="btn btnGhost btnLg" href="/token">
            {TOKEN.symbol} today
          </Link>
        </div>
        <p className={styles.footerNote}>
          The full mechanics specification — including the adversarial security, tokenomics, and regulatory review this
          design passed, and the exact contract responsibilities — lives in the project repository as
          <code> docs/solderworks-design.md</code>. This preview is intentionally unlisted while that review continues.
        </p>
      </section>
    </main>
  );
}
