import {
  CAMPAIGN_2_LEGS,
  FEE_REWARDS_2_MANIFEST,
  feeRewards2Deployment,
} from "@/lib/rewards2";
import { Campaign2Operator } from "./Campaign2Operator";
import styles from "./campaign2.module.css";

const MANIFEST = FEE_REWARDS_2_MANIFEST;

// Boundary copy kept as single-line constants: these sentences are the
// surface's fail-closed / no-yield / audit boundary and are pinned verbatim
// by the page test, so JSX line-wrapping must never fragment them.
const NOT_LIVE =
  "Campaign 2 is not live yet. This panel reads nothing from the chain and asks for no signature until the campaign contracts arrive as a reviewed release with verified addresses.";
const NO_YIELD =
  "No yield or APR. Rewards are whatever the pool's real trading fees produce during the window, which may be zero; the staking leg splits them by time-weighted stake.";
const AUDIT_STATUS =
  "These contracts have not been externally audited. When campaign 2 goes live, transactions put funds at risk and are irreversible once confirmed.";
const RELEASE_ERROR =
  "Release error: campaign 2 is partially configured. No workspace is shown for a half-released campaign.";

function explorer(address: string): string {
  return `${MANIFEST.explorerUrl}/address/${address}`;
}

// Middle-truncate like every other address surface in the app (0x1234…5678):
// the distinguishing tail is what a reader compares when verifying.
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const REFERENCES = [
  { label: "Fee-share vault", value: "100 fixed shares", address: MANIFEST.vault.address },
  { label: "Staking token", value: "0xZAPS", address: MANIFEST.token },
  { label: "Bond target", value: "$HOOKR", address: MANIFEST.hookr },
  { label: "Pool manager", value: "ETH/HOOKR pool host", address: MANIFEST.hookrPool.poolManager },
] as const;

/**
 * The campaign-2 announcement panel on /rewards. Fail-closed off the
 * manifest, never RPC: while `deployment` is null it renders the reviewed
 * mechanics and an honest not-live notice, and the moment the release fills
 * the manifest this panel is superseded by a live campaign-2 workspace in
 * that same reviewed change.
 */
export function Campaign2Panel(): React.JSX.Element {
  const deployment = feeRewards2Deployment();

  return (
    <section className={styles.panel} aria-labelledby="campaign2-title">
      <header className={styles.head}>
        <span className={styles.eyebrow}>
          <i aria-hidden data-live={deployment === "configured" ? "" : undefined} />
          Campaign 2 · announced
        </span>
        <span className={styles.window}>14 days · 100% of fees</span>
      </header>

      <h2 id="campaign2-title" className={styles.title}>
        Every trade pays stakers and bonds $HOOKR.
      </h2>
      <p className={styles.lede}>
        The second staking campaign commits the whole tokenized fee stream for a fixed
        14-day window: all 100 vault shares work, 50 to each leg, so 50% of the WETH
        trading fees stream to 0xZAPS stakers while the other 50% market-buys $HOOKR and
        bonds it permanently into Hook Blocks.
      </p>

      {deployment === "partial" ? (
        <p className={styles.notice} role="alert">
          {RELEASE_ERROR}
        </p>
      ) : (
        <p className={styles.notice}>{NOT_LIVE}</p>
      )}

      <div className={styles.legs}>
        {CAMPAIGN_2_LEGS.map((leg) => (
          <article key={leg.id} className={styles.leg} aria-label={leg.name}>
            <header>
              <strong>{leg.name}</strong>
              <span>{leg.share}</span>
            </header>
            <p className={styles.tagline}>{leg.tagline}</p>
            <ul>
              {leg.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <footer>{leg.contract}</footer>
          </article>
        ))}
      </div>

      <dl className={styles.terms}>
        <div>
          <dt>Window</dt>
          <dd>14 days, immutable start and end</dd>
        </div>
        <div>
          <dt>Split</dt>
          <dd>50 + 50 of the vault&apos;s 100 fee shares</dd>
        </div>
        <div>
          <dt>Bond floor</dt>
          <dd>97% of same-block spot, ≤0.05 ETH per bond, one bond per block</dd>
        </div>
        <div>
          <dt>After the window</dt>
          <dd>Both legs return their shares to the sponsor; bonded HOOKR stays</dd>
        </div>
      </dl>

      <ul className={styles.references}>
        {REFERENCES.map((reference) => (
          <li key={reference.label}>
            <span>{reference.label}</span>
            <span>{reference.value}</span>
            <a href={explorer(reference.address)} target="_blank" rel="noreferrer">
              {shortAddress(reference.address)}
            </a>
          </li>
        ))}
      </ul>

      <p className={styles.boundary}>{NO_YIELD}</p>
      <p className={styles.boundary}>{AUDIT_STATUS}</p>

      <Campaign2Operator />
    </section>
  );
}
