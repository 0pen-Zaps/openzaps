import Link from "next/link";
import {
  FEE_TIERS,
  PAIR_ASSETS,
  explorerAddress,
} from "@/lib/zappad/chain";
import { shortAddress } from "@/lib/zappad/launch-math";
import type { LaunchRecord } from "@/lib/zappad/read-chain";

export function LaunchCard({ launch }: { launch: LaunchRecord }) {
  const pair =
    PAIR_ASSETS.find(
      (asset) =>
        asset.address.toLowerCase() === launch.pairedAsset.toLowerCase(),
    )?.displaySymbol ?? shortAddress(launch.pairedAsset);
  const fee =
    FEE_TIERS.find((tier) => tier.fee === launch.feeTier)?.label ??
    `${launch.feeTier / 10_000}%`;

  return (
    <article className="launch-card">
      <div className="launch-card-head">
        <div className="token-placeholder">{launch.symbol.slice(0, 1)}</div>
        <div>
          <h3>{launch.name}</h3>
          <span>${launch.symbol}</span>
        </div>
        <span className="live-pill">LIVE</span>
      </div>
      <dl>
        <div>
          <dt>Pool</dt>
          <dd>
            {launch.symbol}/{pair}
          </dd>
        </div>
        <div>
          <dt>Fee tier</dt>
          <dd>{fee}</dd>
        </div>
        <div>
          <dt>Fee shares</dt>
          <dd className="positive">Active</dd>
        </div>
      </dl>
      <div className="launch-card-address">
        <span>{shortAddress(launch.token, 9, 7)}</span>
        <a href={explorerAddress(launch.token)} rel="noreferrer" target="_blank">
          Explorer ↗
        </a>
      </div>
      <Link className="launch-card-link" href={`/launch/token/${launch.token}`}>
        Open token console <span>→</span>
      </Link>
    </article>
  );
}
