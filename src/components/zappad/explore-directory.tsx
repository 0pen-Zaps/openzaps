"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readableError } from "@/lib/zappad/launch-math";
import {
  readLaunchPage,
  type LaunchRecord,
} from "@/lib/zappad/read-chain";
import { RequestScopeGate } from "@/lib/zappad/request-scope";
import { zapPadPublicClient } from "@/lib/zappad/wallet";
import { LaunchCard } from "./launch-card";
import { useRuntimeConfig } from "./runtime-config-provider";

const PAGE_SIZE = 24;
const EMPTY_LAUNCHES: LaunchRecord[] = [];

function mergeLaunches(current: LaunchRecord[], incoming: LaunchRecord[]) {
  const launches = new Map(
    current.map((launch) => [launch.token.toLowerCase(), launch]),
  );
  for (const launch of incoming) {
    launches.set(launch.token.toLowerCase(), launch);
  }
  return Array.from(launches.values());
}

export function ExploreDirectory() {
  const { config, loading: configLoading } = useRuntimeConfig();
  const launcherAddress = config?.readEnabled
    ? config.launcherAddress
    : null;
  const client = zapPadPublicClient;
  const [launches, setLaunches] = useState<LaunchRecord[]>([]);
  const [count, setCount] = useState<bigint>(0n);
  const [nextOffset, setNextOffset] = useState(0);
  const [snapshotBlock, setSnapshotBlock] = useState<bigint | null>(null);
  const [loadedScope, setLoadedScope] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "weth" | "usdg">("all");
  const requestGate = useRef(new RequestScopeGate());
  const snapshotBlockRef = useRef<bigint | null>(null);
  const launcherScope = launcherAddress?.toLowerCase() ?? "";

  useLayoutEffect(() => {
    requestGate.current.activate(launcherScope);
    snapshotBlockRef.current = null;
  }, [launcherScope]);

  const load = useCallback(async (offset: number, replace: boolean) => {
    if (!client || !launcherAddress) {
      setLoading(false);
      return;
    }
    const request = requestGate.current.begin(launcherScope);
    setLoading(true);
    setError("");
    try {
      const result = await readLaunchPage(
        client,
        launcherAddress,
        offset,
        PAGE_SIZE,
        replace ? undefined : snapshotBlockRef.current ?? undefined,
      );
      if (!requestGate.current.isCurrent(request)) return;
      snapshotBlockRef.current = result.snapshotBlock;
      setCount(result.count);
      setNextOffset(result.nextOffset);
      setSnapshotBlock(result.snapshotBlock);
      setLaunches((current) =>
        replace ? result.launches : mergeLaunches(current, result.launches),
      );
      setLoadedScope(launcherScope);
    } catch (reason) {
      if (requestGate.current.isCurrent(request)) {
        setError(readableError(reason));
      }
    } finally {
      if (requestGate.current.isCurrent(request)) {
        setLoading(false);
      }
    }
  }, [client, launcherAddress, launcherScope]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(0, true), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const scopeLoaded = loadedScope === launcherScope;
  const visibleLaunches = scopeLoaded ? launches : EMPTY_LAUNCHES;
  const visibleCount = scopeLoaded ? count : 0n;
  const visibleNextOffset = scopeLoaded ? nextOffset : 0;
  const visibleSnapshotBlock = scopeLoaded ? snapshotBlock : null;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleLaunches.filter((launch) => {
      const matchesQuery =
        !needle ||
        launch.name.toLowerCase().includes(needle) ||
        launch.symbol.toLowerCase().includes(needle) ||
        launch.token.toLowerCase().includes(needle);
      const pairSymbol =
        config?.pairedAssets
          .find(
            (asset) =>
              asset.address.toLowerCase() === launch.pairedAsset.toLowerCase(),
          )
          ?.symbol.toLowerCase() ?? "";
      return matchesQuery && (filter === "all" || pairSymbol === filter);
    });
  }, [config?.pairedAssets, filter, query, visibleLaunches]);

  if (!configLoading && !launcherAddress) {
    return (
      <div className="empty-panel" role="status">
        <span>Launch directory offline</span>
        <h2>No launcher is configured yet.</h2>
        <p>
          ZapPad will read the directory directly from the deployed launcher as
          soon as its runtime address is published.
        </p>
      </div>
    );
  }

  return (
    <section className="directory-shell" aria-busy={loading}>
      <div className="directory-toolbar">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, symbol or address"
            type="search"
            value={query}
          />
        </label>
        <div className="filter-pills" aria-label="Filter by paired asset">
          {(["all", "weth", "usdg"] as const).map((value) => (
            <button
              className={filter === value ? "active" : ""}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {value === "all" ? "All pairs" : value.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          className="refresh-button"
          disabled={loading}
          onClick={() => void load(0, true)}
          type="button"
        >
          Refresh ↻
        </button>
      </div>

      <div className="directory-meta">
        <span>
          <strong>{visibleCount.toString()}</strong> onchain launch
          {visibleCount === 1n ? "" : "es"}
        </span>
        <span>
          {visibleNextOffset.toLocaleString()} scanned · newest first · direct
          contract reads
          {visibleSnapshotBlock === null
            ? ""
            : ` · block ${visibleSnapshotBlock.toLocaleString()}`}
        </span>
      </div>

      {error && (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      )}
      {loading && visibleLaunches.length === 0 ? (
        <div
          aria-label="Loading onchain launches"
          className="card-grid"
          role="status"
        >
          <span className="sr-only">Loading onchain launches…</span>
          {Array.from({ length: 6 }).map((_, index) => (
            <div className="launch-card skeleton-card" key={index} />
          ))}
        </div>
      ) : error && !scopeLoaded ? (
        <div className="empty-panel">
          <span>Directory scan incomplete</span>
          <h2>No launch was omitted or marked as scanned.</h2>
          <p>Retry the pinned onchain read before relying on this directory.</p>
        </div>
      ) : visible.length > 0 ? (
        <div className="card-grid">
          {visible.map((launch) => (
            <LaunchCard key={launch.token} launch={launch} />
          ))}
        </div>
      ) : (
        <div className="empty-panel">
          <span>No matching launches</span>
          <h2>The latest onchain page is quiet.</h2>
          <p>Clear the filters, refresh the chain, or be the first to launch.</p>
        </div>
      )}
      {BigInt(visibleNextOffset) < visibleCount && (
        <div className="pagination-row">
          <span>
            Showing the newest {visibleNextOffset.toLocaleString()} of{" "}
            {visibleCount.toString()} launches.
          </span>
          <button
            className="button button-secondary"
            disabled={loading}
            onClick={() => void load(visibleNextOffset, false)}
            type="button"
          >
            {loading ? "Loading older launches…" : "Load older launches"}
          </button>
        </div>
      )}
    </section>
  );
}
