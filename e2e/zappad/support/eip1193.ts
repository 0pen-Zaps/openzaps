import type { Address } from "viem";

export interface WalletRequestRecord {
  method: string;
  params: unknown[];
}

export interface WalletRpcRequest {
  method: string;
  params?: unknown[];
}

export interface WalletHostState {
  account: Address;
  chainId: number;
  connected: boolean;
  requests: WalletRequestRecord[];
}

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

const FORWARDED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendTransaction",
]);

function providerError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

export async function handleWalletRequest(
  rpcUrl: string,
  state: WalletHostState,
  request: WalletRpcRequest,
) {
  const params = Array.isArray(request.params) ? request.params : [];
  state.requests.push({ method: request.method, params });

  switch (request.method) {
    case "eth_accounts":
      return state.connected ? [state.account] : [];
    case "eth_requestAccounts":
      state.connected = true;
      return [state.account];
    case "eth_chainId":
      return `0x${state.chainId.toString(16)}`;
    case "net_version":
      return String(state.chainId);
    case "wallet_getPermissions":
      return state.connected
        ? [{ parentCapability: "eth_accounts", caveats: [] }]
        : [];
    case "wallet_requestPermissions":
      state.connected = true;
      return [{ parentCapability: "eth_accounts", caveats: [] }];
    case "wallet_switchEthereumChain": {
      const target = (params[0] as { chainId?: unknown } | undefined)?.chainId;
      if (typeof target !== "string" || !/^0x[0-9a-f]+$/i.test(target)) {
        throw providerError(-32602, "Invalid chainId.");
      }
      const next = Number.parseInt(target, 16);
      if (next !== 4_663) {
        throw providerError(4_902, "Only Robinhood Chain is available.");
      }
      state.chainId = next;
      return null;
    }
    case "wallet_addEthereumChain": {
      const target = (params[0] as { chainId?: unknown } | undefined)?.chainId;
      if (target !== "0x1237") {
        throw providerError(4_902, "Only Robinhood Chain is available.");
      }
      state.chainId = 4_663;
      return null;
    }
    default:
      break;
  }

  if (!FORWARDED_METHODS.has(request.method)) {
    throw providerError(4_200, `Wallet method ${request.method} is not supported.`);
  }
  if (request.method === "eth_sendTransaction") {
    if (!state.connected) throw providerError(4_100, "Connect the wallet first.");
    const transaction = params[0] as { from?: unknown } | undefined;
    if (
      transaction?.from !== undefined &&
      (typeof transaction.from !== "string" ||
        transaction.from.toLowerCase() !== state.account.toLowerCase())
    ) {
      throw providerError(4_100, "Transaction sender is not the active account.");
    }
    params[0] = { ...transaction, from: state.account };
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: request.method,
      params,
    }),
  });
  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    throw providerError(
      payload.error.code ?? -32_603,
      payload.error.message ?? "Loopback wallet RPC failed.",
    );
  }
  return payload.result;
}

export function installInjectedWallet() {
  type Listener = (...args: unknown[]) => void;
  type TestWindow = Window & {
    __zappadWalletRpc: (request: WalletRpcRequest) => Promise<unknown>;
    __zappadTestWallet?: {
      emitAccountsChanged: (account: string) => void;
      emitChainChanged: (chainId: number) => void;
    };
    ethereum?: unknown;
  };

  const target = window as unknown as TestWindow;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const provider = {
    isMetaMask: false,
    isConnected: () => true,
    request: async ({
      method,
      params,
    }: {
      method: string;
      params?: unknown[] | object;
    }) => {
      const normalized = Array.isArray(params)
        ? params
        : params === undefined
          ? []
          : [params];
      const result = await target.__zappadWalletRpc({
        method,
        params: normalized,
      });
      if (method === "eth_requestAccounts") {
        emit("connect", { chainId: await target.__zappadWalletRpc({ method: "eth_chainId" }) });
        emit("accountsChanged", result);
      } else if (
        method === "wallet_switchEthereumChain" ||
        method === "wallet_addEthereumChain"
      ) {
        emit("chainChanged", await target.__zappadWalletRpc({ method: "eth_chainId" }));
      }
      return result;
    },
    on: (event: string, listener: Listener) => {
      const bucket = listeners.get(event) ?? new Set<Listener>();
      bucket.add(listener);
      listeners.set(event, bucket);
      return provider;
    },
    removeListener: (event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  };

  Object.defineProperty(target, "ethereum", {
    configurable: false,
    enumerable: true,
    value: provider,
    writable: false,
  });
  target.__zappadTestWallet = {
    emitAccountsChanged: (account) => emit("accountsChanged", [account]),
    emitChainChanged: (chainId) => emit("chainChanged", `0x${chainId.toString(16)}`),
  };

  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: {
            uuid: "1f91352d-ec09-4f3a-a0cb-7e2f61d6876a",
            name: "ZapPad Loopback Wallet",
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
            rdns: "app.zappad.e2e",
          },
          provider,
        },
      }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  queueMicrotask(announce);
}
