import Link from "next/link";

import { BuyButton } from "./BuyButton";
import { TOKEN } from "@/lib/config";
import styles from "./TokenUtilityPanel.module.css";

type TokenUtilityPanelProps = {
  className?: string;
  id?: string;
};

/**
 * One reusable, factual account of the token's live roles. Keeping the copy in
 * one component prevents landing/docs/explore surfaces from inventing utility
 * that the contracts or app do not provide.
 */
export function TokenUtilityPanel({ className = "", id }: TokenUtilityPanelProps): React.JSX.Element {
  return (
    <section className={`${styles.panel} ${className}`.trim()} id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className={styles.copy}>
        <span className={styles.eyebrow}>Live {TOKEN.symbol} utility</span>
        <h2 id={id ? `${id}-title` : undefined}>Trade it. Build with it. Unlock conveniences.</h2>
        <p>
          OpenZaps can buy {TOKEN.symbol} through its pinned aeWETH → {TOKEN.symbol} route. A connected wallet holding
          100,000+ {TOKEN.symbol} also gets auto-refreshing quotes, more saved zaps and receipts, and receipt JSON
          export. Every capsule created by the current app also converts its visible 0.00001 ETH creation fee into
          {" "}{TOKEN.symbol} atomically. Every core workflow remains open without pre-holding the token.
        </p>
        <div className={styles.actions}>
          <BuyButton destination="openzaps" label={`Zap in to ${TOKEN.symbol}`} />
          <BuyButton label="Clanker market" variant="ghost" />
          <Link href="/token#utilities">Token details →</Link>
        </div>
      </div>

      <div className={styles.utility} aria-label={`${TOKEN.symbol} utility levels`}>
        <div>
          <span>Live route</span>
          <strong>aeWETH → {TOKEN.symbol}</strong>
          <p>Pinned Uniswap v4 pool, one bounded policy execution.</p>
        </div>
        <div>
          <span>Every creation</span>
          <strong>Fee → {TOKEN.symbol}</strong>
          <p>0.00001 ETH, converted atomically with a reviewed floor or the whole creation reverts.</p>
        </div>
        <div>
          <span>100,000+</span>
          <strong>Holder conveniences</strong>
          <p>Auto-refresh quotes, 50 saved zaps, 100 receipts, JSON export.</p>
        </div>
        <div>
          <span>1,000,000+</span>
          <strong>Operator convenience</strong>
          <p>Raises the app&apos;s saved-zap limit to 100.</p>
        </div>
      </div>

      <p className={styles.disclaimer}>
        App conveniences only. No governance, staking, fee share, revenue, yield, equity, or return is represented.
      </p>
    </section>
  );
}
