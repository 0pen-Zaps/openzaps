import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { TOKEN, TOKEN_LAUNCH } from "@/lib/config";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { ZapDrawTable } from "./ZapDrawTable";
import styles from "./zapdraw.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.zapdraw,
  keywords: [
    "0xZAPS game",
    "onchain game Robinhood Chain",
    "commit reveal game",
    "sealed bid onchain",
    "web3 game pay to play token",
  ],
});

const RULES = [
  {
    n: "01",
    title: "Pay the entry, seal a draw",
    body: "Every seat costs the same. You pick a percentage of the round's capacity and submit only its hash.",
  },
  {
    n: "02",
    title: "Open it, or forfeit it",
    body: "A seat never opened forfeits its entry into the pot. Without that, a sealed bid would bind nobody.",
  },
  {
    n: "03",
    title: "The bus serves the modest first",
    body: "Draws are sorted ascending and paid in full while the current covers them. Ties break on a hash fixed before the round opens — never on who revealed first.",
  },
  {
    n: "04",
    title: "Undelivered current drains slowly",
    body: "It is not refunded and not swept — it returns to a carry pool later rounds draw on, capped at the rake they pay. A slow rebate, not a jackpot.",
  },
] as const;

/**
 * Six disclosures, not the mock's four.
 *
 * The prototype draws four rows because four fit the picture. This contract
 * takes real money and has not been audited, so the anti-sybil cost and the
 * carry-pool cap stay on the page: they are the two things a player is most
 * likely to guess wrong about, and neither is stated anywhere else on the
 * screen. The pre-audit row is last and tinted because it is the one that
 * cannot be mitigated by playing well.
 */
const RISKS = [
  {
    title: "Losing is the normal outcome for a greedy draw",
    body: "A draw the bus cannot serve pays exactly zero and the entry is not returned. Across the table this is negative-sum — the rake and keeper reward leave every round.",
  },
  {
    title: "Lose the salt, lose the entry",
    body: "Clearing this site's data before you reveal makes the seat unopenable. Export the seal if you might return in another browser.",
  },
  {
    title: "The entry fee is the only anti-sybil cost",
    body: "One address is one seat, but addresses are free. A player willing to pay several entries can occupy several seats and shape the spread of draws. No contract can fix this; read the seat count before you play a round.",
  },
  {
    title: "There is no single right draw",
    body: "Any split summing to 100% is stable, including very unequal ones. The seat count is public while commits are open — the last to commit knows it better than the first did.",
  },
  {
    title: "The carry pool is a slow rebate, not a jackpot",
    body: "Undelivered capacity accumulates, but a round can only draw on it up to the rake that round pays. That cap is deliberate: it is exactly what makes buying every seat break-even at best instead of a way to walk off with the pool. It also means a large pool will not produce a large round.",
  },
  {
    title: "Pre-audit code holding real funds",
    body: "Unit-, fuzz- and invariant-tested, with no admin, no pause and no upgrade path — which also means no rescue path. No third-party audit. Onchain actions are irreversible.",
    tone: "danger",
  },
] as const;

export default function ZapDrawPage(): React.JSX.Element {
  return (
    <main className={styles.screen} id="main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.zapdraw), breadcrumbJsonLd("/zapdraw", "ZapDraw")],
        }}
      />

      <header className={styles.head}>
        <div>
          <span className={styles.eyebrow}>Game · Robinhood Chain {TOKEN_LAUNCH.chainId}</span>
          <h1 className={styles.title}>ZapDraw</h1>
          <p className={styles.lead}>
            One shared bus, limited current, and a table full of people deciding in secret how much of it to take.{" "}
            <strong>The modest are served first.</strong> Draw more than the bus can still deliver and you are cut —
            along with everyone greedier than you.
          </p>
          <p className={styles.lead}>
            No dealer, no die, no oracle. The only thing you bet against is the judgement of the other players.
          </p>
        </div>
        <aside className={styles.newHere}>
          <span className={styles.newHereTag}>NEW HERE</span>
          <strong className={styles.newHereLine}>
            Sealed draws, opened together, paid smallest first.
          </strong>
          <Link href="/zapdraw/how" className={styles.newHereLink}>
            Watch a round play out &rarr;
          </Link>
        </aside>
      </header>

      <ZapDrawTable />

      <Reveal as="section">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>How a round works</h2>
          <span className={styles.sectionSub}>These are the contract&apos;s rules, not a description of them.</span>
        </div>
        <div className={styles.rules}>
          {RULES.map((rule) => (
            <div key={rule.n} className={styles.rule}>
              <span className={styles.ruleN}>{rule.n}</span>
              <h3 className={styles.ruleTitle}>{rule.title}</h3>
              <p className={styles.ruleBody}>{rule.body}</p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal as="section">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>What can go wrong</h2>
          <span className={styles.sectionSub}>Read this before you sit down.</span>
        </div>
        <div className={styles.risks}>
          {RISKS.map((risk) => (
            <div
              key={risk.title}
              className={styles.risk}
              data-tone={"tone" in risk ? risk.tone : undefined}
            >
              <strong className={styles.riskTitle}>{risk.title}</strong>
              <span className={styles.riskBody}>{risk.body}</span>
            </div>
          ))}
        </div>
        <p className={styles.disclaimer}>
          Playing does not create yield, revenue share, governance, or any claim on the protocol. {TOKEN.symbol}{" "}
          remains an ERC-20 on {TOKEN_LAUNCH.network} whose price is a market observation, not a promise.
        </p>
      </Reveal>
    </main>
  );
}
