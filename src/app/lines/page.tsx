import type { Metadata } from "next";
import Link from "next/link";
import { ZapLinesMark } from "@/components/ZapLinesMark";
import { CopyButton } from "@/components/CopyButton";
import { CONTRACTS, TOKEN, TOKEN_LAUNCH, buyUrl, explorer } from "@/lib/config";
import { LinesIntro } from "./LinesIntro";
import { LinesFooter, LinesNav, LinesRibbon } from "./LinesChrome";
import { AUTHORITY, BOLT_LINES, BOUNDS, HERO, STATS, STEPS } from "./content";
import styles from "./lines.module.css";

export const metadata: Metadata = {
  title: "LINES — alternative identity preview",
  description:
    "A preview of an alternative OpenZaps identity: one accent, ruled layout, and a bolt drawn entirely out of lines.",
};

export default function LinesPage(): React.JSX.Element {
  return (
    <>
      {/* The intro lives only on this page. The guard script in the root layout
          keys on the pathname `/lines` for exactly that reason. */}
      <LinesIntro />
      <LinesRibbon />
      <LinesNav />

      <main id="main" className={styles.shell}>
        <section className={styles.hero}>
          <div>
            <p className={styles.mono}>{HERO.eyebrow}</p>
            <h1 className={styles.display}>
              {HERO.headline.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </h1>
            <p className={styles.lede}>{HERO.body}</p>
            <div className={styles.actions}>
              <Link className={styles.btn} href="/lines/build">
                See the builder
              </Link>
              <Link className={styles.btnGhost} href="/lines/security">
                Read the bounds
              </Link>
            </div>
          </div>

          <div className={styles.heroBolt}>
            <ZapLinesMark className={styles.bolt} lines={BOLT_LINES} weight={0.62} motion="both" />
          </div>
        </section>

        <section className={styles.stats} aria-label="At a glance">
          {STATS.map((stat) => (
            <div key={stat.label} className={styles.stat}>
              <div className={styles.statN}>{stat.n}</div>
              <div className={styles.statLabel}>{stat.label}</div>
              <div className={styles.statNote}>{stat.note}</div>
            </div>
          ))}
        </section>

        <section id="bounds" className={styles.band}>
          <div className={styles.sectionHead}>
            <p className={styles.mono}>The line</p>
            <h2 className={styles.h2}>What it refuses to do.</h2>
          </div>
          <div className={styles.boundsGrid}>
            {BOUNDS.map((bound) => (
              <p key={bound} className={styles.bound}>
                <span className={styles.tick} aria-hidden="true" />
                <span>{bound}</span>
              </p>
            ))}
          </div>
        </section>

        <section id="flow" className={styles.band}>
          <div className={styles.sectionHead}>
            <p className={styles.mono}>Four moves</p>
            <h2 className={styles.h2}>Draw it, read it, sign it, check it.</h2>
          </div>
          {STEPS.map((step) => (
            <article key={step.n} className={styles.step}>
              <span className={styles.stepN}>{step.n}</span>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepBody}>{step.body}</p>
              <span className={styles.stepTag}>{step.tag}</span>
            </article>
          ))}
        </section>

        <section id="authority" className={styles.band}>
          <div className={styles.sectionHead}>
            <p className={styles.mono}>Authority</p>
            <h2 className={styles.h2}>Three ways to say yes once.</h2>
          </div>
          <div className={styles.authority}>
            {AUTHORITY.map((model) => (
              <article key={model.n} className={styles.auth}>
                <p className={styles.mono}>
                  {model.n} / {model.kind}
                </p>
                <h3 className={styles.authTitle}>{model.title}</h3>
                <p className={styles.authBody}>{model.body}</p>
                <span className={styles.authWho}>{model.who}</span>
              </article>
            ))}
          </div>
        </section>

        <section id="token" className={styles.token}>
          <div>
            <p className={styles.mono}>The token</p>
            <h2 className={styles.h2}>${TOKEN.symbol} is already live.</h2>
            <p className={styles.lede}>
              Paired with aeWETH on {TOKEN_LAUNCH.network} through {TOKEN_LAUNCH.venue} {TOKEN_LAUNCH.version}. It is
              the asset on the one bounded route the live contracts implement.
            </p>
            <div className={styles.actions}>
              <a className={styles.btn} href={buyUrl()} target="_blank" rel="noreferrer">
                Trade on {TOKEN_LAUNCH.venue}
              </a>
              <Link className={styles.btnGhost} href="/lines/token">
                Token details
              </Link>
            </div>
          </div>

          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.mono}>Pair</dt>
              <dd className={styles.factV}>{TOKEN_LAUNCH.pair}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.mono}>Network</dt>
              <dd className={styles.factV}>
                {TOKEN_LAUNCH.network} · {TOKEN_LAUNCH.chainId}
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.mono}>Supply</dt>
              <dd className={styles.factV}>{Number(TOKEN.totalSupply).toLocaleString("en-US")}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.mono}>Token</dt>
              <dd className={styles.factV}>
                <a href={TOKEN_LAUNCH.contractUrl} target="_blank" rel="noreferrer">
                  {TOKEN_LAUNCH.contract}
                </a>{" "}
                <CopyButton value={TOKEN_LAUNCH.contract} label="Copy" title="Copy token address" />
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.mono}>Factory</dt>
              <dd className={styles.factV}>
                <a href={explorer(CONTRACTS.factory)} target="_blank" rel="noreferrer">
                  {CONTRACTS.factory}
                </a>
              </dd>
            </div>
          </dl>
        </section>
      </main>

      <LinesFooter />
    </>
  );
}
