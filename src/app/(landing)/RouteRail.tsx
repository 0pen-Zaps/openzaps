"use client";

import { useState } from "react";
import type { Rail } from "./data";
import styles from "./landing.module.css";

/**
 * One action, many protocols: the deployable routes drawn as rails. A yellow
 * pulse travels stop to stop; switching intent swaps the rail. All gas and
 * step figures arrive precompiled from the server out of the real catalogs.
 */
export function RouteRail({ rails }: { rails: Rail[] }): React.JSX.Element {
  const [activeId, setActiveId] = useState(rails[0]?.id ?? "");
  const active = rails.find((rail) => rail.id === activeId) ?? rails[0];

  if (!active) return <></>;

  return (
    <div className={styles.rail}>
      {/* Deliberately not the ARIA tabs pattern: only the active panel is
          mounted, so toggle buttons with aria-pressed are the honest,
          keyboard-simple semantics here. */}
      <div className={styles.railTabs} role="group" aria-label="Example intents">
        {rails.map((rail) => (
          <button
            key={rail.id}
            type="button"
            aria-pressed={rail.id === active.id}
            className={styles.railTab}
            onClick={() => setActiveId(rail.id)}
          >
            {rail.intent}
          </button>
        ))}
      </div>

      <div key={active.id} className={styles.railPanel}>
        <ol className={styles.railTrack}>
          {active.stops.map((stop, i) => (
            <li
              key={`${stop.label}-${i}`}
              className={stop.kind === "asset" ? styles.railAsset : styles.railHop}
              style={{ "--i": i } as React.CSSProperties}
            >
              {stop.kind === "asset" ? (
                <>
                  <span className={styles.railAssetDot} aria-hidden="true" />
                  <span className={styles.railAssetLabel}>{stop.label}</span>
                </>
              ) : (
                <>
                  <span className={styles.railHopLabel}>{stop.label}</span>
                  {stop.sublabel ? (
                    <span className={`${styles.railHopSub} mono`}>{stop.sublabel}</span>
                  ) : null}
                </>
              )}
            </li>
          ))}
          <span className={styles.railLine} aria-hidden="true">
            <span className={styles.railPulse} />
          </span>
        </ol>

        <dl className={`${styles.railMeta} mono`}>
          <div>
            <dt>Blocks composed</dt>
            <dd>{active.blockCount}</dd>
          </div>
          <div>
            <dt>Signed steps</dt>
            <dd>1</dd>
          </div>
          <div>
            <dt>Manual actions replaced</dt>
            <dd>{active.manualActions}</dd>
          </div>
          <div>
            <dt>Gas constant</dt>
            <dd>{active.gas.toLocaleString("en-US")}</dd>
          </div>
          {active.slippageBps !== null ? (
            <div>
              <dt>Slippage cap</dt>
              <dd>{active.slippageBps} bps</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
