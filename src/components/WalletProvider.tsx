"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Address, type EIP1193Provider } from "viem";

import {
  ROBINHOOD_CHAIN_ID,
  ensureRobinhoodChain,
  getInjectedProvider,
} from "@/lib/robinhood";
import {
  accountFromWalletPayload,
  chainIdFromWalletPayload,
  shouldResetAccountScope,
  type WalletSessionStatus,
} from "@/lib/wallet-session";

type ObservableProvider = EIP1193Provider & {
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

export interface WalletSessionValue {
  account: Address | null;
  chainId: number | null;
  status: WalletSessionStatus;
  providerAvailable: boolean;
  isRobinhoodChain: boolean;
  connect: () => Promise<Address>;
  switchToRobinhood: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletSessionContext = createContext<WalletSessionValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState<WalletSessionStatus>("checking");
  const [providerAvailable, setProviderAvailable] = useState(false);
  const accountRef = useRef<Address | null>(null);
  // Preserve an in-progress form on the first connection, but remount the
  // routed subtree whenever a real account departs. That synchronously drops
  // balances, receipts, and browser-local records owned by the old address.
  const [sessionRevision, setSessionRevision] = useState(0);

  const commitAccount = useCallback((value: unknown): Address | null => {
    const next = accountFromWalletPayload(value);
    const previous = accountRef.current;
    if (shouldResetAccountScope(previous, next)) {
      setSessionRevision((revision) => revision + 1);
    }
    accountRef.current = next;
    setAccount(next);
    setStatus(next ? "connected" : "disconnected");
    if (!next) setChainId(null);
    return next;
  }, []);

  const commitChain = useCallback((value: unknown): number | null => {
    const next = chainIdFromWalletPayload(value);
    setChainId(next);
    return next;
  }, []);

  useEffect(() => {
    const provider = getInjectedProvider() as ObservableProvider | null;
    if (!provider) {
      queueMicrotask(() => {
        setProviderAvailable(false);
        setStatus("disconnected");
      });
      return;
    }

    let cancelled = false;
    const updateAccounts = (value: unknown): void => {
      if (!cancelled) commitAccount(value);
    };
    const updateChain = (value: unknown): void => {
      if (!cancelled) commitChain(value);
    };
    const disconnected = (): void => {
      if (cancelled) return;
      commitAccount([]);
      commitChain(null);
    };

    provider.on?.("accountsChanged", updateAccounts);
    provider.on?.("chainChanged", updateChain);
    provider.on?.("disconnect", disconnected);

    void Promise.allSettled([
      provider.request({ method: "eth_accounts" }),
      provider.request({ method: "eth_chainId" }),
    ]).then(([accountsResult, chainResult]) => {
      if (cancelled) return;
      setProviderAvailable(true);
      commitAccount(accountsResult.status === "fulfilled" ? accountsResult.value : []);
      commitChain(chainResult.status === "fulfilled" ? chainResult.value : null);
    });

    return () => {
      cancelled = true;
      provider.removeListener?.("accountsChanged", updateAccounts);
      provider.removeListener?.("chainChanged", updateChain);
      provider.removeListener?.("disconnect", disconnected);
    };
  }, [commitAccount, commitChain]);

  const connect = useCallback(async (): Promise<Address> => {
    const provider = getInjectedProvider();
    if (!provider) throw new Error("No injected wallet found. Open MetaMask, Rabby, or another EIP-1193 wallet.");
    setProviderAvailable(true);
    const payload = await provider.request({ method: "eth_requestAccounts" });
    const owner = commitAccount(payload);
    if (!owner) throw new Error("The wallet returned no valid account.");
    try {
      await ensureRobinhoodChain(provider);
      const nextChain = await provider.request({ method: "eth_chainId" });
      if (commitChain(nextChain) !== ROBINHOOD_CHAIN_ID) {
        throw new Error("The wallet did not switch to Robinhood Chain (4663).");
      }
      if (accountRef.current !== owner) {
        throw new Error("The active wallet changed while connecting. Review the new account before continuing.");
      }
    } catch (cause) {
      commitChain(null);
      throw cause;
    }
    return owner;
  }, [commitAccount, commitChain]);

  const switchToRobinhood = useCallback(async (): Promise<void> => {
    const provider = getInjectedProvider();
    if (!provider) throw new Error("No injected wallet found in this browser.");
    try {
      await ensureRobinhoodChain(provider);
      const nextChain = await provider.request({ method: "eth_chainId" });
      if (commitChain(nextChain) !== ROBINHOOD_CHAIN_ID) {
        throw new Error("The wallet did not switch to Robinhood Chain (4663).");
      }
    } catch (cause) {
      commitChain(null);
      throw cause;
    }
  }, [commitChain]);

  const disconnect = useCallback(async (): Promise<void> => {
    const provider = getInjectedProvider();
    try {
      await provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Permission revocation is not part of every wallet. The local session is
      // still cleared; a full reload may reconnect if the wallet retains access.
    }
    commitAccount([]);
    commitChain(null);
  }, [commitAccount, commitChain]);

  const value = useMemo<WalletSessionValue>(() => ({
    account,
    chainId,
    status,
    providerAvailable,
    isRobinhoodChain: chainId === ROBINHOOD_CHAIN_ID,
    connect,
    switchToRobinhood,
    disconnect,
  }), [account, chainId, connect, disconnect, providerAvailable, status, switchToRobinhood]);

  return (
    <WalletSessionContext.Provider value={value}>
      <Fragment key={sessionRevision}>{children}</Fragment>
    </WalletSessionContext.Provider>
  );
}

export function useWalletSession(): WalletSessionValue {
  const value = useContext(WalletSessionContext);
  if (!value) throw new Error("useWalletSession must be used inside WalletProvider.");
  return value;
}
