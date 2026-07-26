import Link from "next/link";

import { BlockGlyph } from "./BlockGlyph";
import styles from "./workspace.module.css";

const ROUTE = "robinhood-v4-weth-zaps";

const OPTIONS = [
  {
    number: "01",
    glyph: "bolt",
    label: "Zap now",
    title: "Zap in with one bounded authorization",
    detail: "Create the capsule, fund it, review the exact output floor, then sign and Zap.",
    meta: "v1.1 · one-time nonce",
    href: `/zap?view=sign&route=${ROUTE}`,
    accent: "instant",
  },
  {
    number: "02",
    glyph: "repeat",
    label: "Recurring",
    title: "Repeat a fixed amount on schedule",
    detail: "Choose cadence, total Zaps, expiry, and slippage. The capsule enforces every Zap.",
    meta: "v3.1 · replaceable series",
    href: `/zap?view=automate&src=build&mode=recurring&route=${ROUTE}&amount=0.01&bps=100&interval=daily&runs=10`,
    accent: "recurring",
  },
  {
    number: "03",
    glyph: "band",
    label: "Price trigger",
    title: "Fire once after a one-sided move",
    detail: "Set rises or falls, threshold, validity window, and a net output floor before signing.",
    meta: "v3 · revocable nonce",
    href: `/zap?view=automate&src=build&mode=trigger&route=${ROUTE}&amount=0.01&bps=100&threshold=up10&days=30`,
    accent: "trigger",
  },
  {
    number: "04",
    glyph: "split",
    label: "Compose",
    title: "Build the route and its execution policy",
    detail: "Connect the route, add gas, gas-price, and executor controls as one stack, then review the resolved bounds before handoff.",
    meta: "atomic policy stack · one-step undo",
    href: "/zap?view=design",
    accent: "compose",
  },
] as const;

export function ZapLauncher(): React.JSX.Element {
  return (
    <main className={styles.launcher} id="main">
      <section className={`container ${styles.launchHero}`}>
        <div>
          <span className="eyebrow">New zap</span>
          <h1>Start with the outcome.<br />Lock the rules after.</h1>
          <p>
            Choose how you want to Zap. Every path resolves to a capsule with an immutable route,
            a wallet-owned recipient, and reviewable execution bounds.
          </p>
        </div>
        <aside className={styles.profilePrompt}>
          <BlockGlyph name="wallet" className={styles.promptGlyph} />
          <div>
            <span>Your control room</span>
            <strong>History, live automations, revocations, and recoveries.</strong>
          </div>
          <Link href="/profile">Open profile →</Link>
        </aside>
      </section>

      <section className={`container ${styles.intentSection}`} aria-labelledby="intent-heading">
        <header className={styles.sectionHead}>
          <span className="eyebrow">How should it run?</span>
          <h2 id="intent-heading">One route. Four execution shapes.</h2>
          <p>Nothing is submitted from this screen. Pick a shape, then review every bound before your wallet acts.</p>
        </header>

        <div className={styles.intentGrid}>
          {OPTIONS.map((option) => (
            <Link
              href={option.href}
              className={styles.intentCard}
              data-accent={option.accent}
              key={option.label}
            >
              <span className={styles.cardNumber}>{option.number}</span>
              <span className={styles.cardGlyph}><BlockGlyph name={option.glyph} /></span>
              <div className={styles.cardCopy}>
                <span>{option.label}</span>
                <h3>{option.title}</h3>
                <p>{option.detail}</p>
              </div>
              <div className={styles.cardFoot}>
                <code>{option.meta}</code>
                <span aria-hidden>↗</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className={`container ${styles.truthStrip}`} aria-label="Zap lifecycle">
        <div><span>1</span><strong>Choose intent</strong><small>Zap now, recur, trigger, compose</small></div>
        <i aria-hidden />
        <div><span>2</span><strong>Review policy</strong><small>route, amount, floor, recipient</small></div>
        <i aria-hidden />
        <div><span>3</span><strong>Confirm wallet</strong><small>creation, funding, signature</small></div>
        <i aria-hidden />
        <div><span>4</span><strong>Track onchain</strong><small>profile shows confirmed state</small></div>
      </section>
    </main>
  );
}
