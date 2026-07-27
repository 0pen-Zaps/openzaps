import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { TOKEN, TOKEN_LAUNCH } from "@/lib/config";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { OverdrawTable } from "./OverdrawTable";
import styles from "./overdraw.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.overdraw,
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
    body: `Every seat costs the same in ${TOKEN.symbol}. You pick a draw — a percentage of the round's capacity you intend to take — and submit only its hash. Nobody can read it, including this site, until you open it yourself.`,
  },
  {
    n: "02",
    title: "Open it, or forfeit it",
    body: "When the commit window closes you have a reveal window to open your draw. A seat that is never opened forfeits its entry into the pot. Without that rule a sealed bid would bind nobody — you would simply stay quiet whenever the table went against you.",
  },
  {
    n: "03",
    title: "The bus serves the modest first",
    body: "Revealed draws are sorted ascending, ties broken by who revealed first. Each is paid in full while the remaining current covers it. The first draw the bus cannot cover is cut — and so is every draw behind it, because they all asked for at least as much.",
  },
  {
    n: "04",
    title: "What is not delivered stays charged",
    body: "Current the bus does not hand out is not refunded and not swept. It becomes the opening pot of the next round. A table that collectively under-draws is handing its own restraint to whoever plays next.",
  },
] as const;

const RISKS = [
  {
    title: "Losing is the normal outcome for a greedy draw",
    body: "A draw the bus cannot serve pays exactly zero and the entry is not returned. Across the table this is a negative-sum game — the rake and the keeper reward leave the pot every round — so any individual edge has to come from out-guessing the other players, not from the mechanism.",
  },
  {
    title: "Lose the salt, lose the entry",
    body: "Your draw is sealed with a random salt stored in your browser. Clearing this site's data before you reveal makes the seat unopenable, and an unopened seat forfeits. The page shows you an exportable copy of every live seal for exactly this reason; take it if you might return in another browser.",
  },
  {
    title: "The entry fee is the only anti-sybil cost",
    body: "One address is one seat, but addresses are free. A player willing to pay several entries can occupy several seats and shape the spread of draws. No contract can fix this; read the seat count before you play a round.",
  },
  {
    title: "Pre-audit code holding real funds",
    body: "The contract is unit-, fuzz- and invariant-tested and has no admin, no pause and no upgrade path — which also means no rescue path. It has not had a third-party audit. Onchain actions are irreversible.",
  },
  {
    title: `${TOKEN.symbol} is not changed by this game`,
    body: `Playing does not create yield, revenue share, governance, or any claim on the protocol. ${TOKEN.symbol} remains an ERC-20 on ${TOKEN_LAUNCH.network} whose price is a market observation, not a promise.`,
  },
] as const;

export default function OverdrawPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.overdraw), breadcrumbJsonLd("/overdraw", "OVERDRAW")],
        }}
      />

      <header className={`container ${styles.hero}`}>
        <p className={styles.eyebrow}>Game · Robinhood Chain {TOKEN_LAUNCH.chainId}</p>
        <h1 className={styles.title}>OVERDRAW</h1>
        <p className={styles.lead}>
          One shared bus, limited current, and a table full of people deciding in secret how much of it to take.{" "}
          <strong>The modest are served first.</strong> Draw more than the bus can still deliver and you are cut —
          along with everyone greedier than you.
        </p>
        <p className={styles.lead}>
          There is no dealer, no die and no oracle. The only thing you are betting against is the judgement of the
          other players, and every outcome is a pure function of the draws they opened.
        </p>
      </header>

      <div className="container">
        <OverdrawTable />
      </div>

      <Reveal as="section" className="container">
        <h2 className={styles.sectionTitle}>How a round works</h2>
        <div className={styles.rules}>
          {RULES.map((rule) => (
            <div key={rule.n} className={styles.rule}>
              <p className={styles.ruleN}>{rule.n}</p>
              <h3 className={styles.ruleTitle}>{rule.title}</h3>
              <p className={styles.ruleBody}>{rule.body}</p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal as="section" className={`container ${styles.lastSection}`}>
        <h2 className={styles.sectionTitle}>What can go wrong</h2>
        <div className={styles.risks}>
          {RISKS.map((risk) => (
            <div key={risk.title} className={styles.risk}>
              <p className={styles.riskTitle}>{risk.title}</p>
              <p className={styles.riskBody}>{risk.body}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </main>
  );
}
