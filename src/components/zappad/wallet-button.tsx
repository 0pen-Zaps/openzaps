"use client";

import { useState } from "react";
import { ROBINHOOD_CHAIN_ID } from "@/lib/zappad/chain";
import { readableError, shortAddress } from "@/lib/zappad/launch-math";
import { useZapPadWallet } from "@/lib/zappad/wallet";

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const {
    address,
    isConnected,
    chainId,
    connecting,
    switching,
    connect: connectSharedWallet,
    disconnect,
    switchToRobinhood,
  } = useZapPadWallet();
  const [error, setError] = useState("");
  const wrongChain = isConnected && chainId !== ROBINHOOD_CHAIN_ID;

  async function connect() {
    setError("");
    try {
      await connectSharedWallet();
    } catch (reason) {
      setError(readableError(reason));
    }
  }

  async function switchNetwork() {
    setError("");
    try {
      await switchToRobinhood();
    } catch (reason) {
      setError(readableError(reason));
    }
  }

  if (!isConnected) {
    return (
      <span className="wallet-wrap">
        <button
          className="button button-small button-primary"
          disabled={connecting}
          onClick={connect}
          type="button"
        >
          {connecting ? "Connecting…" : compact ? "Connect" : "Connect wallet"}
        </button>
        {error && (
          <span className="wallet-error" role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }

  if (wrongChain) {
    return (
      <span className="wallet-wrap">
        <button
          className="button button-small button-warning"
          disabled={switching}
          onClick={switchNetwork}
          type="button"
        >
          {switching ? "Switching…" : "Switch network"}
        </button>
        {error && (
          <span className="wallet-error" role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <details className="wallet-menu">
      <summary className="wallet-address">
        <span className="status-dot" aria-hidden="true" />
        {address ? shortAddress(address) : "Connected"}
      </summary>
      <div className="wallet-popover">
        <span>Robinhood Chain</span>
        <button onClick={() => void disconnect()} type="button">
          Disconnect
        </button>
      </div>
    </details>
  );
}
