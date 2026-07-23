import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import type { RecipeCard } from "./data";
import styles from "./landing.module.css";

/**
 * Example Zaps as live transaction objects. The front face carries the
 * outcome; hovering (or focusing) peels it back to expose the block chain and
 * the protocols underneath. Every card is one link into the real builder,
 * pre-loaded with this exact chain via its share token.
 */
export function ZapCards({ cards }: { cards: RecipeCard[] }): React.JSX.Element {
  return (
    <div className={styles.cardGrid} data-reveal-group>
      {cards.map((card, index) => (
        <Reveal
          key={card.id}
          delay={index * 70}
          className={styles.cardShell}
        >
          <Link
            href={card.builderHref}
            className={styles.card}
            data-cursor="card"
            style={{ "--card-accent": card.accentColor } as React.CSSProperties}
            aria-label={`${card.name} — open this Zap in the builder`}
          >
            <div className={styles.cardFront}>
              <div className={styles.cardTop}>
                <span
                  className={`${styles.cardStatus} mono`}
                  data-live={card.deployable || undefined}
                >
                  {card.deployable ? "live route" : "design"}
                </span>
                <span className={`${styles.cardOutput} mono`}>{card.outputLabel}</span>
              </div>
              <h3 className={styles.cardName}>{card.name}</h3>
              <p className={styles.cardTagline}>{card.tagline}</p>
              <dl className={`${styles.cardMeta} mono`}>
                <div>
                  <dt>blocks</dt>
                  <dd>{card.deployable ? `${card.blockCount} → 1` : `${card.blockCount} · design`}</dd>
                </div>
                <div>
                  <dt>gas const</dt>
                  <dd>{Math.round(card.gas / 1000)}k</dd>
                </div>
                <div>
                  <dt>guards</dt>
                  <dd>{card.guardScore}/100</dd>
                </div>
              </dl>
            </div>

            <div className={styles.cardReveal} aria-hidden="true">
              <span className={`${styles.cardRevealKicker} mono`}>under the hood</span>
              <ol className={styles.cardSteps}>
                {card.steps.map((step, i) => (
                  <li key={i} className={styles.cardStep}>
                    <span
                      className={styles.cardStepDot}
                      style={
                        step.shape
                          ? ({ "--dot": card.accentColor } as React.CSSProperties)
                          : undefined
                      }
                    />
                    <span className={styles.cardStepLabel}>{step.label}</span>
                    {step.protocols.length > 0 ? (
                      <span className={`${styles.cardStepVia} mono`}>
                        via {step.protocols.join(" + ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
              <span className={`${styles.cardOpen} mono`}>open in builder →</span>
            </div>
          </Link>
        </Reveal>
      ))}
    </div>
  );
}
