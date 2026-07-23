import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { Reveal } from "@/components/Reveal";
import { absoluteUrl } from "@/lib/seo";
import type { RecipeCard } from "./data";
import styles from "./landing.module.css";

/**
 * Shareable Zaps. The chips are real: each carries the actual `?d=` token the
 * builder decodes, so copying one shares an executable strategy today. The
 * only future-tense sentence — attribution — is labelled as roadmap.
 */
export function ShareLinks({ cards }: { cards: RecipeCard[] }): React.JSX.Element {
  return (
    <div className={styles.share}>
      <ol className={styles.shareFlow} aria-label="How sharing works">
        {["Design a chain", "Encode it into a link", "Share it anywhere", "Anyone executes it"].map(
          (step, i) => (
            <li key={step} className={styles.shareFlowStep}>
              <span className="mono">{String(i + 1).padStart(2, "0")}</span>
              {step}
            </li>
          ),
        )}
      </ol>

      <div className={styles.shareChips} data-reveal-group>
        {cards.map((card, index) => (
          <Reveal key={card.id} delay={index * 60} className={styles.shareChip}>
            <div className={styles.shareChipHead}>
              <span className={styles.shareChipName}>{card.name}</span>
              <span
                className={`${styles.cardStatus} mono`}
                data-live={card.deployable || undefined}
              >
                {card.deployable ? "live" : "design"}
              </span>
            </div>
            <span className={`${styles.shareChipToken} mono`}>
              /zap?d={card.shareToken.slice(0, 18)}…
            </span>
            <div className={styles.shareChipActions}>
              <CopyButton
                value={absoluteUrl(card.builderHref)}
                label="Copy link"
                className={styles.shareCopy}
              />
              <Link href={card.builderHref} className={`${styles.shareOpen} mono`}>
                open →
              </Link>
            </div>
          </Reveal>
        ))}
      </div>

      <p className={styles.shareNote}>
        Attribution and fee-sharing for published Zaps are on the{" "}
        <Link href="/roadmap">roadmap</Link> — links themselves work today.
      </p>
    </div>
  );
}
