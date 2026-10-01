import { feeRewards3Deployment } from "@/lib/rewards3";
import { CampaignHeader } from "./CampaignHeader";
import styles from "./campaign2.module.css";

const NOT_LIVE =
  "Campaign 3 is prepared but not deployed. This panel reads nothing from the chain and requests no wallet connection or signature; staking, withdrawal, claims, and operator actions stay hidden until both contracts and runtime hashes are verified in a reviewed release.";
const DEPLOYMENT_NOT_ENABLED =
  "Deployment data is present, but Campaign 3 live reads and wallet actions are not enabled in this release. Do not stake or fund until those surfaces are independently verified.";
const WINDOW_NOTE =
  "Campaign 2 ran for 14 days. Campaign 3 uses the explicitly requested October 3–31 UTC window (29 days); all per-leg share allocations and HookBlocks buy controls remain unchanged.";
const NO_YIELD =
  "No yield or APR. Rewards are whatever the pool's real trading fees produce during the window, which may be zero; the staking leg splits them by time-weighted stake.";
const AUDIT_STATUS =
  "Campaign transactions put funds at risk and are irreversible once confirmed.";

const LEGS = [
  {
    name: "Staker rewards",
    share: "50 of 100 fee shares",
    tagline: "WETH rewards for staked 0xZAPS, if the fee stream produces them.",
    points: [
      "Same staking and reward-allocation mechanics as Campaign 2.",
      "Rewards split by time-weighted stake; holding 0xZAPS alone earns nothing.",
    ],
    contract: "OXZAPSFeeCampaignV1 · deployment pending",
  },
  {
    name: "HookBlocks",
    share: "50 of 100 fee shares",
    tagline: "Permissionless, bounded $HOOKR buys followed by an immediate transfer to DEAD.",
    points: [
      "97% same-block spot floor; at most 0.05 ETH per buy and one buy per block.",
      "The transfer removes HOOKR from circulation; it does not reduce totalSupply.",
    ],
    contract: "HookBlocks · deployment pending",
  },
] as const;

/** Campaign 3 announcement: deliberately read-only until a reviewed release. */
export function Campaign3Panel(): React.JSX.Element {
  const deployment = feeRewards3Deployment();
  const status =
    deployment === "configured"
      ? "Deployment recorded · controls disabled"
      : deployment === "partial"
        ? "Release error"
        : "Prepared — not live";
  const notice =
    deployment === "configured"
      ? DEPLOYMENT_NOT_ENABLED
      : deployment === "partial"
        ? "Release error: only part of the Campaign 3 deployment manifest is configured. No live workspace is enabled."
        : NOT_LIVE;

  return (
    <section className={styles.panel} aria-labelledby="campaign3-title">
      <CampaignHeader
        campaign="Campaign 3"
        status={status}
        live={false}
        window="Oct 3–31, 2026 UTC · 29 days"
        titleId="campaign3-title"
        titleLevel={1}
        title="Split fee shares between 0xZAPS stakers and HookBlocks."
        description="Campaign 3 assigns 50 of the vault's 100 fee shares to 0xZAPS stakers and 50 to the HookBlocks buy-and-burn leg. It is scheduled for October 3 through October 31 in UTC."
      />

      <p className={styles.notice} role={deployment === "partial" ? "alert" : undefined}>
        {notice}
      </p>

      <div className={styles.legs}>
        {LEGS.map((leg) => (
          <article key={leg.name} className={styles.leg} aria-label={leg.name}>
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
          <dd>Oct 3, 00:00 UTC → Nov 1, 00:00 UTC · 29 days</dd>
        </div>
        <div>
          <dt>Share split</dt>
          <dd>50 shares for stakers + 50 shares for HookBlocks</dd>
        </div>
        <div>
          <dt>Buy bounds</dt>
          <dd>97% same-block spot floor · 0.0005–0.05 ETH per buy</dd>
        </div>
        <div>
          <dt>After the window</dt>
          <dd>Both legs return principal to the sponsor; claims and recovery retain a 30-day tail</dd>
        </div>
      </dl>

      <p className={styles.boundary}>{WINDOW_NOTE}</p>
      <p className={styles.boundary}>{NO_YIELD}</p>
      <p className={styles.boundary}>{AUDIT_STATUS}</p>
    </section>
  );
}
