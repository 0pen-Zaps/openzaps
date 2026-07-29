import { test as base, expect, type Page } from "@playwright/test";
import type { Address } from "viem";
import {
  handleWalletRequest,
  installInjectedWallet,
  type WalletHostState,
  type WalletRequestRecord,
  type WalletRpcRequest,
} from "../support/eip1193";
import {
  loadRunState,
  type ZapPadE2eRunState,
} from "../support/run-state";

export interface WalletHarness {
  account(): Address;
  count(method: string): number;
  requests(): readonly WalletRequestRecord[];
  setAccount(account: Address): Promise<void>;
  setChain(chainId: number): Promise<void>;
}

interface ZapPadFixtures {
  runState: ZapPadE2eRunState;
  wallet: WalletHarness;
}

async function emitAccount(page: Page, account: Address) {
  await page.evaluate((next) => {
    (
      window as Window & {
        __zappadTestWallet?: {
          emitAccountsChanged: (account: string) => void;
        };
      }
    ).__zappadTestWallet?.emitAccountsChanged(next);
  }, account);
}

export const test = base.extend<ZapPadFixtures>({
  runState: async ({}, provide) => {
    await provide(await loadRunState());
  },
  wallet: async ({ page, runState }, provide) => {
    const host: WalletHostState = {
      account: runState.accounts.creator,
      chainId: 1,
      connected: false,
      requests: [],
    };

    await page.exposeBinding(
      "__zappadWalletRpc",
      async (_source, request: WalletRpcRequest) =>
        handleWalletRequest(runState.rpcUrl, host, request),
    );
    await page.addInitScript(installInjectedWallet);

    await provide({
      account: () => host.account,
      count: (method) =>
        host.requests.filter((request) => request.method === method).length,
      requests: () => host.requests,
      setAccount: async (account) => {
        host.account = account;
        host.connected = true;
        await emitAccount(page, account);
      },
      setChain: async (chainId) => {
        host.chainId = chainId;
        await page.evaluate((next) => {
          (
            window as Window & {
              __zappadTestWallet?: {
                emitChainChanged: (chainId: number) => void;
              };
            }
          ).__zappadTestWallet?.emitChainChanged(next);
        }, chainId);
      },
    });
  },
});

export { expect };
