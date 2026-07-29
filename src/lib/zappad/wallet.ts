"use client";

import { useCallback, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import { useWalletSession } from "@/components/WalletProvider";
import {
  ROBINHOOD_CHAIN_ID,
  getInjectedProvider,
  robinhoodChain,
} from "@/lib/robinhood";
import {
  accountFromWalletPayload,
  chainIdFromWalletPayload,
} from "@/lib/wallet-session";

/**
 * ZapPad reads only through OpenZaps' same-origin relay. This keeps RPC
 * credentials server-side and gives every feature route the same verified
 * Robinhood-chain view.
 */
export const zapPadPublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http("/api/launch/rpc", {
    retryCount: 2,
    timeout: 12_000,
  }),
});

export interface ZapPadWriteRequest {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gas?: bigint;
  nonce?: number;
  chainId?: number;
  account?: Address | { address: Address } | null;
}

async function assertLiveWalletAuthority(expectedAccount: Address) {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error("No injected wallet found in this browser.");
  }

  const [accountsPayload, chainPayload] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  const liveAccount = accountFromWalletPayload(accountsPayload);
  const liveChainId = chainIdFromWalletPayload(chainPayload);

  if (
    !liveAccount ||
    liveAccount.toLowerCase() !== expectedAccount.toLowerCase()
  ) {
    throw new Error(
      "The active wallet changed. Review the new account before continuing.",
    );
  }
  if (liveChainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      "The wallet is no longer on Robinhood Chain (4663). Switch back before continuing.",
    );
  }

  return provider;
}

/**
 * Adapts ZapPad to OpenZaps' single wallet authority. Every write re-reads the
 * injected account and chain immediately before opening the wallet prompt.
 * A stale React render therefore cannot sign from a different shell account.
 */
export function useZapPadWallet() {
  const session = useWalletSession();
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      return await session.connect();
    } finally {
      setConnecting(false);
    }
  }, [session]);

  const switchToRobinhood = useCallback(async () => {
    setSwitching(true);
    try {
      await session.switchToRobinhood();
    } finally {
      setSwitching(false);
    }
  }, [session]);

  const writeContract = useCallback(
    async (request: ZapPadWriteRequest): Promise<Hex> => {
      const expectedAccount = session.account;
      if (!expectedAccount || session.status !== "connected") {
        throw new Error("Connect the OpenZaps wallet before continuing.");
      }
      if (session.chainId !== ROBINHOOD_CHAIN_ID) {
        throw new Error(
          "Switch the OpenZaps wallet to Robinhood Chain (4663) before continuing.",
        );
      }
      if (
        request.chainId !== undefined &&
        request.chainId !== ROBINHOOD_CHAIN_ID
      ) {
        throw new Error("ZapPad writes are restricted to Robinhood Chain (4663).");
      }
      const requestedAccount =
        typeof request.account === "string"
          ? request.account
          : request.account?.address;
      if (
        requestedAccount &&
        requestedAccount.toLowerCase() !== expectedAccount.toLowerCase()
      ) {
        throw new Error(
          "The requested signer does not match the connected OpenZaps wallet.",
        );
      }

      const provider = await assertLiveWalletAuthority(expectedAccount);
      const wallet = createWalletClient({
        account: expectedAccount,
        chain: robinhoodChain,
        transport: custom(provider),
      });
      const {
        chainId: _chainId,
        account: _account,
        ...contractRequest
      } = request;
      void _chainId;
      void _account;
      return wallet.writeContract({
        ...contractRequest,
        account: expectedAccount,
        chain: robinhoodChain,
      } as never);
    },
    [session.account, session.chainId, session.status],
  );

  return useMemo(
    () => ({
      address: session.account,
      chainId: session.chainId,
      isConnected:
        session.status === "connected" && session.account !== null,
      providerAvailable: session.providerAvailable,
      publicClient: zapPadPublicClient,
      connecting,
      switching,
      connect,
      switchToRobinhood,
      disconnect: session.disconnect,
      writeContract,
    }),
    [
      connect,
      connecting,
      session.account,
      session.chainId,
      session.disconnect,
      session.providerAvailable,
      session.status,
      switchToRobinhood,
      switching,
      writeContract,
    ],
  );
}
