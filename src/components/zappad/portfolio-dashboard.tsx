"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getAddress, isAddress } from "viem";
import {
  formatTokenAmount,
  readableError,
  shortAddress,
} from "@/lib/zappad/launch-math";
import {
  readPortfolioLaunchPage,
  type PortfolioPosition,
} from "@/lib/zappad/portfolio-data";
import { readLaunchPage, type LaunchRecord } from "@/lib/zappad/read-chain";
import { RequestScopeGate } from "@/lib/zappad/request-scope";
import { useZapPadWallet } from "@/lib/zappad/wallet";
import { useRuntimeConfig } from "./runtime-config-provider";
import { WalletButton } from "./wallet-button";

const PAGE_SIZE = 24;

export function hasLoadedPortfolioScope(
  loadedScope: string,
  launcherAddress: string | null | undefined,
  accountAddress: string | null | undefined,
): boolean {
  if (!launcherAddress || !accountAddress) return false;
  return (
    loadedScope ===
    `${launcherAddress.toLowerCase()}|${accountAddress.toLowerCase()}`
  );
}

export function portfolioErrorForScope(
  error: { scope: string; message: string } | null,
  scope: string,
): string {
  return error?.scope === scope ? error.message : "";
}

function mergePositions(
  current: PortfolioPosition[],
  incoming: PortfolioPosition[],
) {
  const positions = new Map(
    current.map((position) => [
      position.launch.feeVault.toLowerCase(),
      position,
    ]),
  );
  for (const position of incoming) {
    positions.set(position.launch.feeVault.toLowerCase(), position);
  }
  return Array.from(positions.values());
}

function mergeCreated(current: LaunchRecord[], incoming: LaunchRecord[]) {
  const launches = new Map(
    current.map((launch) => [launch.token.toLowerCase(), launch]),
  );
  for (const launch of incoming) {
    launches.set(launch.token.toLowerCase(), launch);
  }
  return Array.from(launches.values());
}

export function PortfolioDashboard() {
  const router = useRouter();
  const { address, isConnected, publicClient: client } = useZapPadWallet();
  const { config, loading: configLoading } = useRuntimeConfig();
  const launcherAddress = config?.readEnabled
    ? config.launcherAddress
    : null;
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [created, setCreated] = useState<LaunchRecord[]>([]);
  const [count, setCount] = useState(0n);
  const [nextOffset, setNextOffset] = useState(0);
  const [snapshotBlock, setSnapshotBlock] = useState<bigint | null>(null);
  const [loadedScope, setLoadedScope] = useState("");
  const [loading, setLoading] = useState(false);
  const [scopedError, setScopedError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const [tokenLookup, setTokenLookup] = useState("");
  const [tokenLookupError, setTokenLookupError] = useState("");
  const requestGate = useRef(new RequestScopeGate());
  const snapshotBlockRef = useRef<bigint | null>(null);
  const scopeKey = `${launcherAddress?.toLowerCase() ?? ""}|${address?.toLowerCase() ?? ""}`;

  useLayoutEffect(() => {
    requestGate.current.activate(scopeKey);
    snapshotBlockRef.current = null;
  }, [scopeKey]);

  const load = useCallback(async (offset: number, replace: boolean) => {
    if (!client || !launcherAddress || !address) return;
    const request = requestGate.current.begin(scopeKey);
    setLoading(true);
    setScopedError(null);
    try {
      const directory = await readLaunchPage(
        client,
        launcherAddress,
        offset,
        PAGE_SIZE,
        replace ? undefined : snapshotBlockRef.current ?? undefined,
      );
      const page = await readPortfolioLaunchPage(
        client,
        address,
        directory.launches,
        directory.snapshotBlock,
      );
      if (!requestGate.current.isCurrent(request)) return;
      setCount(directory.count);
      setNextOffset(directory.nextOffset);
      snapshotBlockRef.current = directory.snapshotBlock;
      setSnapshotBlock(directory.snapshotBlock);
      setCreated((current) =>
        replace ? page.created : mergeCreated(current, page.created),
      );
      setPositions((current) =>
        replace ? page.positions : mergePositions(current, page.positions),
      );
      setLoadedScope(scopeKey);
    } catch (reason) {
      if (requestGate.current.isCurrent(request)) {
        setScopedError({ scope: scopeKey, message: readableError(reason) });
      }
    } finally {
      if (requestGate.current.isCurrent(request)) {
        setLoading(false);
      }
    }
  }, [address, client, launcherAddress, scopeKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(0, true), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  function openToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = tokenLookup.trim();
    if (!isAddress(candidate)) {
      setTokenLookupError("Enter a valid ZapPad token address.");
      return;
    }
    setTokenLookupError("");
    router.push(`/launch/token/${getAddress(candidate)}`);
  }

  if (configLoading) {
    return (
      <div className="empty-panel" role="status">
        <span>Checking portfolio runtime</span>
        <h2>Verifying Robinhood Chain reads.</h2>
        <p>
          ZapPad is confirming the configured launcher before asking for a
          wallet.
        </p>
      </div>
    );
  }

  if (!launcherAddress) {
    return (
      <div className="empty-panel" role="status">
        <span>Portfolio offline</span>
        <h2>The launcher is not configured.</h2>
        <p>
          Runtime contract configuration is required before holdings can load.
        </p>
      </div>
    );
  }

  if (!isConnected || !address) {
    return (
      <div className="wallet-gate">
        <div className="vault-art" aria-hidden="true">
          <span>20</span>
          <span>80</span>
          <b>ZF</b>
        </div>
        <div>
          <div className="eyebrow">Wallet required</div>
          <h2>Bring your fee rights into view.</h2>
          <p>
            Connect the wallet that launched a token or holds ZapPad fee shares.
            Reads stay local to the current onchain state.
          </p>
          <WalletButton />
        </div>
      </div>
    );
  }

  const scopeLoaded = hasLoadedPortfolioScope(
    loadedScope,
    launcherAddress,
    address,
  );
  const error = portfolioErrorForScope(scopedError, scopeKey);
  const portfolioChecking = loading || !scopeLoaded;
  const initialScanFailed = Boolean(error) && !scopeLoaded;
  const visiblePositions = scopeLoaded ? positions : [];
  const visibleCreated = scopeLoaded ? created : [];
  const visibleCount = scopeLoaded ? count : 0n;
  const visibleNextOffset = scopeLoaded ? nextOffset : 0;
  const visibleSnapshotBlock = scopeLoaded ? snapshotBlock : null;
  const hasMore = BigInt(visibleNextOffset) < visibleCount;
  const totalClaims = visiblePositions.reduce(
    (total, position) =>
      total + position.claims.filter((claim) => claim.amount > 0n).length,
    0,
  );

  return (
    <section
      className="portfolio-shell"
      aria-busy={portfolioChecking && !error}
    >
      <div className="portfolio-summary">
        <div>
          <span>Fee-share positions</span>
          <strong>
            {initialScanFailed
              ? "—"
              : portfolioChecking
                ? "…"
                : visiblePositions.length}
          </strong>
        </div>
        <div>
          <span>Claimable assets</span>
          <strong>
            {initialScanFailed ? "—" : portfolioChecking ? "…" : totalClaims}
          </strong>
        </div>
        <div>
          <span>Created launches</span>
          <strong>
            {initialScanFailed
              ? "—"
              : portfolioChecking
                ? "…"
                : visibleCreated.length}
          </strong>
        </div>
        <button
          className="button button-secondary"
          disabled={portfolioChecking && !error}
          onClick={() => void load(0, true)}
          type="button"
        >
          Refresh chain ↻
        </button>
      </div>

      {error && (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      )}

      <div className="portfolio-section">
        <div className="section-title-row">
          <div>
            <div className="eyebrow">Fee rights</div>
            <h2>Positions you can claim.</h2>
          </div>
          <form className="portfolio-lookup" onSubmit={openToken}>
            <label>
              <span className="sr-only">ZapPad token address</span>
              <input
                autoComplete="off"
                onChange={(event) => setTokenLookup(event.target.value)}
                placeholder="Open token address 0x…"
                spellCheck={false}
                value={tokenLookup}
              />
            </label>
            <button className="button button-quiet button-small" type="submit">
              Open
            </button>
          </form>
        </div>
        <div className="portfolio-scan-note">
          <span>
            {scopeLoaded
              ? `${visibleNextOffset.toLocaleString()} of ${visibleCount.toString()} launches scanned at block ${visibleSnapshotBlock?.toLocaleString() ?? "—"}, newest first.`
              : error
                ? "Launch scan incomplete; no portfolio totals are confirmed."
                : "Scanning the newest launches…"}
          </span>
          {tokenLookupError && (
            <span className="vault-transfer-error" role="alert">
              {tokenLookupError}
            </span>
          )}
        </div>
        {error && !scopeLoaded ? (
          <div className="empty-panel compact">
            <span>Portfolio scan incomplete</span>
            <h2>No launch was omitted or marked as scanned.</h2>
            <p>
              Retry the pinned onchain read before relying on holdings or
              retained claims.
            </p>
          </div>
        ) : portfolioChecking && !scopeLoaded ? (
          <div className="position-list">
            <div className="position-row skeleton-block" />
            <div className="position-row skeleton-block" />
          </div>
        ) : visiblePositions.length > 0 ? (
          <div className="position-list">
            {visiblePositions.map((position) => {
              const percentage =
                position.totalShares > 0n
                  ? Number(
                      (position.feeShares * 1_000_000n) / position.totalShares,
                    ) / 10_000
                  : 0;
              return (
                <article className="position-row" key={position.launch.feeVault}>
                  <div className="position-token">
                    <div className="token-placeholder">
                      {position.launch.symbol.slice(0, 1)}
                    </div>
                    <div>
                      <strong>{position.launch.name}</strong>
                      <span>${position.launch.symbol}</span>
                    </div>
                  </div>
                  <div>
                    <span>Vault ownership</span>
                    <strong>{percentage.toLocaleString()}%</strong>
                  </div>
                  <div className="position-claims">
                    <span>Claimable now</span>
                    <strong>
                      {position.claims.every((claim) => claim.amount === 0n)
                        ? "No synced fees"
                        : position.claims
                            .map(
                              (claim) =>
                                `${formatTokenAmount(
                                  claim.amount,
                                  claim.decimals,
                                  4,
                                )} ${claim.symbol}`,
                            )
                            .join(" + ")}
                    </strong>
                  </div>
                  <Link
                    className="button button-secondary button-small"
                    href={`/launch/token/${position.launch.token}`}
                  >
                    Manage fees →
                  </Link>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-panel compact">
            <span>No fee rights found</span>
            <h2>
              This wallet has no shares or retained claims in the launches
              scanned so far.
            </h2>
            <p>
              Fee shares are transferable ERC-20 balances; accrued claims remain
              with the prior holder.
            </p>
          </div>
        )}
        {hasMore && (
          <div className="pagination-row">
            <span>
              Scan older launches to find earlier fee shares, retained claims,
              and creator history.
            </span>
            <button
              className="button button-secondary"
              disabled={loading}
              onClick={() => void load(visibleNextOffset, false)}
              type="button"
            >
              {loading ? "Scanning older launches…" : "Scan older launches"}
            </button>
          </div>
        )}
      </div>

      <div className="portfolio-section">
        <div className="section-title-row">
          <div>
            <div className="eyebrow">Creator history</div>
            <h2>Tokens launched by this wallet.</h2>
          </div>
        </div>
        {error && !scopeLoaded ? (
          <p className="muted-copy">
            Creator history is unavailable until the launch scan succeeds.
          </p>
        ) : portfolioChecking && !scopeLoaded ? (
          <p className="muted-copy" role="status">
            Scanning creator history…
          </p>
        ) : visibleCreated.length > 0 ? (
          <div className="created-list">
            {visibleCreated.map((launch) => (
              <Link href={`/launch/token/${launch.token}`} key={launch.token}>
                <span className="token-placeholder">
                  {launch.symbol.slice(0, 1)}
                </span>
                <span>
                  <strong>{launch.name}</strong>
                  <small>${launch.symbol}</small>
                </span>
                <code>{shortAddress(launch.token, 8, 6)}</code>
                <b>→</b>
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted-copy">
            No creator launches in the records scanned so far.
          </p>
        )}
      </div>
    </section>
  );
}
