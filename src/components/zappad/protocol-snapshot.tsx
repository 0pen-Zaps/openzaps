"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { LAUNCHER_ABI } from "@/lib/zappad/contracts";
import { zapPadPublicClient } from "@/lib/zappad/wallet";
import { useRuntimeConfig } from "./runtime-config-provider";

export function protocolSnapshotScope(launcher: Address | null) {
  return launcher?.toLowerCase() ?? "unavailable";
}

export function ProtocolSnapshot() {
  const { config, loading } = useRuntimeConfig();
  const launcherAddress = config?.readEnabled
    ? config.launcherAddress
    : null;

  return (
    <ScopedProtocolSnapshot
      key={protocolSnapshotScope(launcherAddress)}
      launcherAddress={launcherAddress}
      launchEnabled={Boolean(config?.launchEnabled)}
      loading={loading}
      readEnabled={Boolean(config?.readEnabled)}
    />
  );
}

/**
 * Keying this reader by the verified launcher makes a deployment change a new
 * state scope. Launcher A's count can never paint under launcher B (or under an
 * unavailable runtime), including an A → B → A sequence.
 */
function ScopedProtocolSnapshot({
  launcherAddress,
  launchEnabled,
  loading,
  readEnabled,
}: {
  launcherAddress: Address | null;
  launchEnabled: boolean;
  loading: boolean;
  readEnabled: boolean;
}) {
  const client = zapPadPublicClient;
  const [count, setCount] = useState<bigint | null>(null);

  useEffect(() => {
    if (!client || !launcherAddress) return;
    let active = true;
    client
      .readContract({
        address: launcherAddress,
        abi: LAUNCHER_ABI,
        functionName: "tokenCount",
      })
      .then((value) => {
        if (active) setCount(value);
      })
      .catch(() => {
        if (active) setCount(null);
      });
    return () => {
      active = false;
    };
  }, [client, launcherAddress]);

  return (
    <div className="protocol-snapshot" aria-live="polite">
      <div>
        <span>Network</span>
        <strong>Robinhood Chain</strong>
      </div>
      <div>
        <span>Launches</span>
        <strong>{count === null ? (loading ? "…" : "—") : count.toString()}</strong>
      </div>
      <div>
        <span>Liquidity</span>
        <strong>Uniswap v3</strong>
      </div>
      <div>
        <span>Status</span>
        <strong className={launchEnabled ? "positive" : "muted"}>
          {launchEnabled
            ? "Launches live"
            : readEnabled
              ? "Read-only"
              : loading
                ? "Checking"
                : "Unavailable"}
        </strong>
      </div>
    </div>
  );
}
