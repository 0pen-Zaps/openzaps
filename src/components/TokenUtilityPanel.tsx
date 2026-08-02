import Link from "next/link";

import { BuyButton } from "./BuyButton";
import { ProtocolLogo } from "./ProtocolLogo";
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
        <h2 id={id ? `${id}-title` : undefined}>Trade it. Use the app. Opt into one fixed fee campaign.</h2>
        <p>
          OpenZaps can buy {TOKEN.symbol} through its pinned aeWETH → {TOKEN.symbol} route. Every Zap contract created
          by the current app converts its visible 0.00001 ETH creation fee into {TOKEN.symbol} atomically. A connected
          wallet holding 100,000+ {TOKEN.symbol} also gets auto-refreshing quotes, more saved Zaps and receipts, and
          receipt JSON export. A separate seven-day campaign holds 50 tokenized Clanker fee shares and distributes
          campaign-accounted WETH to wallets that deliberately stake {TOKEN.symbol}. Its configured harvest path
          collects Clanker fees, while direct WETH transfers can also be synchronized. Every core workflow stays
          open without holding or staking the token.
        </p>
        <div className={styles.actions}>
          <BuyButton destination="openzaps" label={`Zap in to ${TOKEN.symbol}`} />
          <BuyButton label="Buy on Clanker" variant="ghost" />
          <Link href="/rewards">Fee campaign →</Link>
          <Link href="/token#utilities">Token details →</Link>
        </div>
      </div>

      <div className={styles.utility} aria-label={`Where ${TOKEN.symbol} is used and what holding it unlocks`}>
        <div>
          <span className={styles.protocolLabel}>
            <ProtocolLogo protocol="uniswap-v4" size={20} />
            <em>Live route</em>
          </span>
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
          <p>Auto-refresh quotes, 50 saved Zaps, 100 receipts, JSON export.</p>
        </div>
        <div>
          <span>1,000,000+</span>
          <strong>Operator convenience</strong>
          <p>Raises the app&apos;s saved-zap limit to 100.</p>
        </div>
        <div>
          <span>50 / 100 fee shares</span>
          <strong>Fixed staking campaign</strong>
          <p>Configured for Clanker fees; this site never asks for or spends sponsor-wallet WETH.</p>
        </div>
      </div>

      <p className={styles.disclaimer}>
        Ownership alone grants no governance, automatic staking benefit, fee right, revenue claim, yield, equity, or
        return. Campaign benefits require a deliberate deposit into the separately identified fixed contract.
      </p>
    </section>
  );
}
