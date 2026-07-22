import { ZapLinesMark } from "@/components/ZapLinesMark";
import styles from "./lines.module.css";

/**
 * The rendering vocabulary every interior LINES page is built from.
 *
 * Pages supply content, never markup. That is what keeps six pages looking like
 * one site: a heading cannot drift a size, a list cannot pick a different rule
 * weight, and adding a page cannot quietly introduce a seventh kind of card.
 * The four block kinds below are the whole set on purpose — each encodes
 * something true about its content rather than decorating it, so `steps` is
 * only ever used where the order actually carries meaning.
 */

export type Step = { n: string; title: string; body: string; tag?: string };
export type Card = { kicker?: string; title: string; body: string; tag?: string };
export type Fact = { label: string; value: string; mono?: boolean };

export type Section =
  | { kind: "steps"; heading: string; kicker: string; intro?: string; steps?: Step[] }
  | { kind: "bounds"; heading: string; kicker: string; intro?: string; bounds?: string[] }
  | { kind: "facts"; heading: string; kicker: string; intro?: string; facts?: Fact[] }
  | { kind: "cards"; heading: string; kicker: string; intro?: string; cards?: Card[] };

export type PageContent = {
  kicker: string;
  title: string;
  lede: string;
  sections: Section[];
};

export function PageHero({
  kicker,
  title,
  lede,
  children,
}: {
  kicker: string;
  title: string;
  lede: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={styles.pageHero}>
      <div>
        <p className={styles.mono}>{kicker}</p>
        <h1 className={styles.pageTitle}>{title}</h1>
        <p className={styles.lede}>{lede}</p>
        {children}
      </div>
      <ZapLinesMark className={styles.pageBolt} lines={20} weight={0.6} motion="charge" />
    </section>
  );
}

function SectionHead({ kicker, heading, intro }: { kicker: string; heading: string; intro?: string }): React.JSX.Element {
  return (
    <div className={styles.sectionHead}>
      <p className={styles.mono}>{kicker}</p>
      <h2 className={styles.h2}>{heading}</h2>
      {intro ? <p className={styles.lede}>{intro}</p> : null}
    </div>
  );
}

export function LinesSection({ section }: { section: Section }): React.JSX.Element {
  return (
    <section className={styles.band}>
      <SectionHead kicker={section.kicker} heading={section.heading} intro={section.intro} />

      {section.kind === "steps" &&
        (section.steps ?? []).map((step) => (
          <article key={step.n + step.title} className={styles.step}>
            <span className={styles.stepN}>{step.n}</span>
            <h3 className={styles.stepTitle}>{step.title}</h3>
            <p className={styles.stepBody}>{step.body}</p>
            {step.tag ? <span className={styles.stepTag}>{step.tag}</span> : <span />}
          </article>
        ))}

      {section.kind === "bounds" && (
        <div className={styles.boundsGrid}>
          {(section.bounds ?? []).map((bound) => (
            <p key={bound} className={styles.bound}>
              <span className={styles.tick} aria-hidden="true" />
              <span>{bound}</span>
            </p>
          ))}
        </div>
      )}

      {section.kind === "cards" && (
        <div className={styles.authority}>
          {(section.cards ?? []).map((card) => (
            <article key={card.title} className={styles.auth}>
              {card.kicker ? <p className={styles.mono}>{card.kicker}</p> : null}
              <h3 className={styles.authTitle}>{card.title}</h3>
              <p className={styles.authBody}>{card.body}</p>
              {card.tag ? <span className={styles.authWho}>{card.tag}</span> : null}
            </article>
          ))}
        </div>
      )}

      {section.kind === "facts" && (
        <dl className={styles.facts}>
          {(section.facts ?? []).map((fact) => (
            <div key={fact.label} className={styles.fact}>
              <dt className={styles.mono}>{fact.label}</dt>
              <dd className={styles.factV}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
