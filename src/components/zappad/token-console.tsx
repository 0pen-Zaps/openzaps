"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  formatUnits,
  type Address,
} from "viem";
import {
  explorerAddress,
  FEE_TIERS,
  PAIR_ASSETS,
} from "@/lib/zappad/chain";
import { ERC20_ABI } from "@/lib/zappad/contracts";
import {
  formatTokenAmount,
  readableError,
  shortAddress,
} from "@/lib/zappad/launch-math";
import {
  LatestRequestGate,
  isSupersededRequest,
} from "@/lib/zappad/latest-request";
import { readLaunch, type LaunchRecord } from "@/lib/zappad/read-chain";
import {
  tokenConsoleScope,
  tokenConsoleSnapshotIsCurrent,
} from "@/lib/zappad/token-console-scope";
import { zapPadPublicClient } from "@/lib/zappad/wallet";
import { FeeVaultPanel } from "./fee-vault-panel";
import { useRuntimeConfig } from "./runtime-config-provider";

export function TokenConsole({ token }: { token: Address }) {
  const { config, loading: configLoading } = useRuntimeConfig();
  const launcherAddress = config?.readEnabled
    ? config.launcherAddress
    : null;
  const client = zapPadPublicClient;
  const [loadedLaunch, setLoadedLaunch] = useState<LaunchRecord | null>(null);
  const [totalSupply, setTotalSupply] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorScope, setErrorScope] = useState("");
  const [loadedScope, setLoadedScope] = useState("");
  const requestGate = useRef(new LatestRequestGate());
  const scope = tokenConsoleScope(launcherAddress, token);

  useLayoutEffect(() => {
    const gate = requestGate.current;
    gate.invalidate();
    return () => gate.invalidate();
  }, [scope]);

  const load = useCallback(async () => {
    if (!client || !launcherAddress) {
      setLoading(false);
      return;
    }
    const request = requestGate.current.begin();
    setLoading(true);
    setError("");
    setErrorScope(scope);
    try {
      const [record, supply] = await request.settle(
        Promise.all([
          readLaunch(client, launcherAddress, token),
          client.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "totalSupply",
          }),
        ]),
      );
      if (!record.exists) throw new Error("This address is not a ZapPad launch.");
      setLoadedLaunch(record);
      setTotalSupply(supply);
      setLoadedScope(scope);
    } catch (reason) {
      if (request.isCurrent() && !isSupersededRequest(reason)) {
        setLoadedLaunch(null);
        setTotalSupply(null);
        setLoadedScope("");
        setError(readableError(reason));
        setErrorScope(scope);
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [client, launcherAddress, scope, token]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const snapshotCurrent = tokenConsoleSnapshotIsCurrent({
    launcher: launcherAddress,
    token,
    loadedScope,
  });
  const launch = snapshotCurrent ? loadedLaunch : null;
  const visibleError = errorScope === scope ? error : "";

  if (
    configLoading ||
    (launcherAddress &&
      (loading || (!snapshotCurrent && !visibleError)))
  ) {
    return (
      <div
        aria-label="Loading token launch"
        className="token-console"
        role="status"
      >
        <span className="sr-only">Loading token launch…</span>
        <div className="token-console-head skeleton-block" />
        <div className="detail-grid">
          <div className="skeleton-block" />
          <div className="skeleton-block" />
        </div>
      </div>
    );
  }

  if (visibleError || !launch) {
    return (
      <div className="empty-panel" role="alert">
        <span>Token unavailable</span>
        <h2>This launch could not be verified.</h2>
        <p>
          {visibleError ||
            "The ZapPad launcher has not passed runtime verification for reads."}
        </p>
        <button className="button button-secondary" onClick={load} type="button">
          Retry chain read
        </button>
      </div>
    );
  }

  const pairMeta =
    PAIR_ASSETS.find(
      (asset) =>
        asset.address.toLowerCase() === launch.pairedAsset.toLowerCase(),
    );
  const pair = pairMeta?.displaySymbol ?? shortAddress(launch.pairedAsset);
  const fee =
    FEE_TIERS.find((tier) => tier.fee === launch.feeTier)?.label ??
    `${launch.feeTier / 10_000}%`;

  return (
    <div className="token-console">
      <section className="token-console-head">
        <div className="token-identity-large">
          <div className="token-placeholder">{launch.symbol.slice(0, 1)}</div>
          <div>
            <span className="live-pill">LIVE ON 4663</span>
            <h1>{launch.name}</h1>
            <p>${launch.symbol}</p>
          </div>
        </div>
        <div className="token-console-links">
          <a href={explorerAddress(token)} rel="noreferrer" target="_blank">
            Token contract ↗
          </a>
          <a href={explorerAddress(launch.pool)} rel="noreferrer" target="_blank">
            Pool contract ↗
          </a>
          <button className="button button-quiet" onClick={load} type="button">
            Refresh ↻
          </button>
        </div>
      </section>

      <section className="token-primary-stats">
        <div>
          <span>Pair</span>
          <strong>
            {launch.symbol}/{pair}
          </strong>
        </div>
        <div>
          <span>Uniswap fee</span>
          <strong>{fee}</strong>
        </div>
        <div>
          <span>Total supply</span>
          <strong>
            {totalSupply === null
              ? "—"
              : Number(formatUnits(totalSupply, 18)).toLocaleString()}
          </strong>
        </div>
        <div>
          <span>LP status</span>
          <strong className="positive">Locked</strong>
        </div>
      </section>

      <section className="detail-grid">
        <article className="detail-card">
          <div className="eyebrow">Launch record</div>
          <h2>Chain-native provenance</h2>
          <dl className="address-list">
            <div>
              <dt>Token</dt>
              <dd>
                <a href={explorerAddress(token)} rel="noreferrer" target="_blank">
                  {shortAddress(token, 10, 8)} ↗
                </a>
              </dd>
            </div>
            <div>
              <dt>Creator</dt>
              <dd>
                <a
                  href={explorerAddress(launch.creator)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {shortAddress(launch.creator, 10, 8)} ↗
                </a>
              </dd>
            </div>
            <div>
              <dt>Pool</dt>
              <dd>
                <a
                  href={explorerAddress(launch.pool)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {shortAddress(launch.pool, 10, 8)} ↗
                </a>
              </dd>
            </div>
            <div>
              <dt>Position NFT</dt>
              <dd>#{launch.positionId.toString()}</dd>
            </div>
            <div>
              <dt>Floor tick</dt>
              <dd>{launch.floorTick.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Config commitment</dt>
              <dd>
                <code title={launch.configHash}>
                  {shortAddress(launch.configHash, 10, 8)}
                </code>
              </dd>
            </div>
            <div>
              <dt>Included at</dt>
              <dd>
                {new Date(Number(launch.launchedAt) * 1000).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Creator first buy</dt>
              <dd>
                {launch.firstBuyAmountIn === 0n
                  ? "None"
                  : `${formatTokenAmount(
                      launch.firstBuyAmountIn,
                      pairMeta?.decimals ?? 18,
                      6,
                    )} ${pair} → ${formatTokenAmount(
                      launch.firstBuyAmountOut,
                      18,
                      4,
                    )} ${launch.symbol}`}
              </dd>
            </div>
          </dl>
        </article>

        <article className="detail-card fee-right-card">
          <div className="eyebrow">Composable economics</div>
          <h2>The fee right is a token.</h2>
          <p>
            Trading fees accrue in the vault’s revenue assets. Fee-share
            balances decide each account’s claim, including across transfers.
          </p>
          <div className="fee-right-diagram">
            <span>v3 pool</span>
            <b>→</b>
            <span>fee vault</span>
            <b>→</b>
            <span>shareholders</span>
          </div>
          <a
            href={explorerAddress(launch.feeVault)}
            rel="noreferrer"
            target="_blank"
          >
            Verify fee-share contract ↗
          </a>
        </article>
      </section>

      <FeeVaultPanel vault={launch.feeVault} />
    </div>
  );
}
