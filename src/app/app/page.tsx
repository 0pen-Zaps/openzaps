"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  zeroAddress,
  zeroHash,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { OpenZapMark } from "@/components/OpenZapMark";
import { trackEvent } from "@/lib/analytics";
import {
  MAX_EXECUTION_FEE_PER_GAS,
  MAX_EXECUTION_GAS,
  assetsForDirection,
  buildRobinhoodPolicy,
  inspectOwnedZap,
  parseRouterAmount,
  randomHex32,
  randomNonce,
  type SavedZapRecord,
  type ZapDirection,
} from "@/lib/openzap";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_RPC_URL,
  erc20Abi,
  ensureRobinhoodChain,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  openZapAbi,
  openZapFactoryAbi,
  openZapProtocolConfigured,
  robinhoodChain,
  robinhoodPoolKey,
  v4QuoterAbi,
  watchZapsAsset,
  wethAbi,
} from "@/lib/robinhood";
import styles from "./app.module.css";

type BusyAction =
  | "connect"
  | "quote"
  | "create"
  | "wrap"
  | "fund"
  | "execute"
  | "recover"
  | "load"
  | "watch"
  | null;

type TransactionRecord = {
  hash: Hex;
  label: string;
  status: "confirmed" | "failed";
  confirmedAt: string;
};

type HealthState = "checking" | "ready" | "degraded";
type ObservableProvider = EIP1193Provider & {
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 10_000 }),
});
const LEGACY_STORAGE_KEY = "openzaps:robinhood-live-zap:v1";
const ZAP_STORAGE_KEY = "openzaps:robinhood-live-zaps:v2";
const TX_STORAGE_KEY = "openzaps:robinhood-transactions:v1";

export default function AppPage(): React.JSX.Element {
  const configured = openZapProtocolConfigured();
  const [account, setAccount] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [protocolHealth, setProtocolHealth] = useState<HealthState>("checking");
  const [direction, setDirection] = useState<ZapDirection>("buy");
  const [amount, setAmount] = useState("0.001");
  const [slippageBps, setSlippageBps] = useState(100);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteGas, setQuoteGas] = useState<bigint | null>(null);
  const [zap, setZap] = useState<SavedZapRecord | null>(null);
  const [savedZaps, setSavedZaps] = useState<SavedZapRecord[]>([]);
  const [executedZap, setExecutedZap] = useState<Address | null>(null);
  const [manualZap, setManualZap] = useState("");
  const [walletWethBalance, setWalletWethBalance] = useState(0n);
  const [walletZapsBalance, setWalletZapsBalance] = useState(0n);
  const [zapWethBalance, setZapWethBalance] = useState(0n);
  const [zapZapsBalance, setZapZapsBalance] = useState(0n);
  const [zapNativeBalance, setZapNativeBalance] = useState(0n);
  const [nativeBalance, setNativeBalance] = useState(0n);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  // Wallet event handlers and the async restore flow need the freshest values
  // without re-subscribing; refs bridge them across stale closures.
  const accountRef = useRef<Address | null>(null);
  const zapRef = useRef<SavedZapRecord | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  useEffect(() => {
    zapRef.current = zap;
  }, [zap]);

  const assets = assetsForDirection(direction);
  const { inputSymbol, outputSymbol } = assets;
  const amountIn = useMemo(() => parseOptionalRouterAmount(amount), [amount]);
  const requiredAmount = zap ? BigInt(zap.amountIn) : amountIn;
  const walletInputBalance = direction === "buy" ? walletWethBalance : walletZapsBalance;
  const walletOutputBalance = direction === "buy" ? walletZapsBalance : walletWethBalance;
  const zapInputBalance = direction === "buy" ? zapWethBalance : zapZapsBalance;
  const recoverableBalance = zapWethBalance + zapZapsBalance + zapNativeBalance;
  const funded = zap !== null && requiredAmount > 0n && zapInputBalance >= requiredAmount;
  const executionComplete = zap !== null && executedZap === zap.address;
  const minOut = quote === null ? null : (quote * BigInt(10_000 - slippageBps)) / 10_000n;
  const protocolReady = configured && protocolHealth === "ready";

  const refreshBalances = useCallback(async (): Promise<void> => {
    if (!account) return;
    try {
      const [weth, zaps, native, zapWeth, zapZaps, zapNative] = await Promise.all([
        publicClient.readContract({ address: ROBINHOOD_ASSETS.weth, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: ROBINHOOD_ASSETS.zaps, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        publicClient.getBalance({ address: account }),
        zap
          ? publicClient.readContract({ address: ROBINHOOD_ASSETS.weth, abi: erc20Abi, functionName: "balanceOf", args: [zap.address] })
          : Promise.resolve(0n),
        zap
          ? publicClient.readContract({ address: ROBINHOOD_ASSETS.zaps, abi: erc20Abi, functionName: "balanceOf", args: [zap.address] })
          : Promise.resolve(0n),
        zap
          ? publicClient.getBalance({ address: zap.address })
          : Promise.resolve(0n),
      ]);
      setWalletWethBalance(weth);
      setWalletZapsBalance(zaps);
      setNativeBalance(native);
      setZapWethBalance(zapWeth);
      setZapZapsBalance(zapZaps);
      setZapNativeBalance(zapNative);
    } catch (cause) {
      setError(readableError(cause));
    }
  }, [account, zap]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshBalances();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshBalances]);

  useEffect(() => {
    let cancelled = false;
    const checkHealth = async (): Promise<void> => {
      try {
        const [response, implementation, version, factoryCode, adapterCode, registryCode, allowlistCode] = await Promise.all([
          fetch("/api/health", { cache: "no-store" }),
          publicClient.readContract({
            address: OPENZAP_CONTRACTS.factory,
            abi: openZapFactoryAbi,
            functionName: "implementation",
          }),
          publicClient.readContract({ address: OPENZAP_CONTRACTS.factory, abi: openZapFactoryAbi, functionName: "VERSION" }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.factory }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.adapter }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.adapterRegistry }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.tokenAllowlist }),
        ]);
        const body = (await response.json()) as {
          chain?: { id?: number };
          status?: { contractsLive?: boolean; tokenLive?: boolean; preAudit?: boolean };
        };
        const apiReady = response.ok
          && body.chain?.id === ROBINHOOD_CHAIN_ID
          && body.status?.contractsLive === true
          && body.status?.tokenLive === true
          && body.status?.preAudit === true;
        const rpcReady = version === "1.1.0"
          && isAddressEqual(implementation, OPENZAP_CONTRACTS.implementation)
          && Boolean(factoryCode && adapterCode && registryCode && allowlistCode);
        if (!cancelled) setProtocolHealth(apiReady && rpcReady ? "ready" : "degraded");
      } catch {
        if (!cancelled) setProtocolHealth("degraded");
      }
    };
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const provider = getInjectedProvider() as ObservableProvider | null;
    if (!provider) return;
    let cancelled = false;

    const updateAccounts = (value: unknown): void => {
      if (cancelled || !Array.isArray(value)) return;
      const next = value.find((item): item is string => typeof item === "string");
      const nextAccount = next ? getAddress(next) : null;
      // Some wallets re-emit accountsChanged with the same account on focus;
      // wiping state then would strand the user mid-flow with nothing to re-run
      // the [account] restore effect.
      if (nextAccount === accountRef.current) return;
      setAccount(nextAccount);
      if (!nextAccount) setWalletChainId(null);
      resetSessionState();
    };
    const updateChain = (value: unknown): void => {
      if (cancelled || typeof value !== "string") return;
      setWalletChainId(Number.parseInt(value, 16));
    };
    const handleDisconnect = (): void => {
      if (cancelled) return;
      setAccount(null);
      setWalletChainId(null);
      resetSessionState();
    };

    provider.on?.("accountsChanged", updateAccounts);
    provider.on?.("chainChanged", updateChain);
    provider.on?.("disconnect", handleDisconnect);
    void provider.request({ method: "eth_accounts" }).then(updateAccounts).catch(() => undefined);
    void provider.request({ method: "eth_chainId" }).then(updateChain).catch(() => undefined);

    return () => {
      cancelled = true;
      provider.removeListener?.("accountsChanged", updateAccounts);
      provider.removeListener?.("chainChanged", updateChain);
      provider.removeListener?.("disconnect", handleDisconnect);
    };
  }, []);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const restore = async (): Promise<void> => {
      const records = readSavedZaps(account);
      const checks = await Promise.allSettled(
        records.map(async (record) => {
          const verified = await inspectOwnedZap(publicClient, record.address, account);
          return {
            ...record,
            direction: verified.direction,
            amountIn: verified.amountIn.toString(),
            policyHash: verified.policyHash,
          } satisfies SavedZapRecord;
        }),
      );
      if (cancelled) return;
      const verified = new Map<string, SavedZapRecord>();
      let sawFailure = false;
      checks.forEach((check, index) => {
        if (check.status === "fulfilled") verified.set(records[index].address, check.value);
        else sawFailure = true;
      });
      // A rejected check can mean the zap failed verification OR the RPC was
      // unreachable. Only prune records when the RPC provably works — a
      // transient outage must never erase the saved record of a funded zap.
      let rpcHealthy = true;
      if (sawFailure) {
        rpcHealthy = await publicClient
          .getBytecode({ address: OPENZAP_CONTRACTS.factory })
          .then((code) => Boolean(code))
          .catch(() => false);
      }
      if (cancelled) return;
      // Merge against storage as it exists NOW: records added while the checks
      // were in flight (Create zap / Load verified zap) must survive.
      const current = readSavedZaps(account);
      const seen = new Set(current.map((record) => record.address));
      const base = [...current, ...records.filter((record) => !seen.has(record.address))];
      const merged = base.flatMap((record) => {
        const check = verified.get(record.address);
        if (check) return [check];
        const wasChecked = records.some((candidate) => candidate.address === record.address);
        if (!wasChecked) return [record];
        return rpcHealthy ? [] : [record];
      });
      saveZapList(account, merged);
      setSavedZaps(merged);
      setTransactions(readTransactions(account));
      if (!rpcHealthy) setNotice("Saved zaps could not be verified right now — Robinhood RPC is unreachable. They remain saved.");
      const firstVerified = merged.find((record) => verified.has(record.address));
      if (firstVerified && zapRef.current === null) selectZap(firstVerified);
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [account]);

  async function connectWallet(): Promise<void> {
    setBusy("connect");
    clearMessages();
    try {
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found. Install or open MetaMask, Rabby, or another EIP-1193 wallet.");
      const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
      const addresses = await wallet.requestAddresses();
      if (!addresses[0]) throw new Error("The wallet did not return an account.");
      await ensureRobinhoodChain(provider);
      const nextAccount = getAddress(addresses[0]);
      setAccount(nextAccount);
      setWalletChainId(ROBINHOOD_CHAIN_ID);
      setNotice("Wallet connected to Robinhood Chain.");
      trackEvent("robinhood_wallet_connected", { account: nextAccount });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function requestQuote(): Promise<bigint | null> {
    setBusy("quote");
    clearMessages();
    try {
      const exactAmount = parseRouterAmount(amount);
      const { result } = await publicClient.simulateContract({
        account: account ?? zeroAddress,
        address: ROBINHOOD_LIQUIDITY.v4Quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: robinhoodPoolKey,
            zeroForOne: assets.zeroForOne,
            exactAmount,
            hookData: "0x",
          },
        ],
      });
      setQuote(result[0]);
      setQuoteGas(result[1]);
      setNotice("Live pool quote loaded. The signed minimum is enforced after the adapter returns.");
      return result[0];
    } catch (cause) {
      setQuote(null);
      setQuoteGas(null);
      setError(`Quote unavailable: ${readableError(cause)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createZap(): Promise<void> {
    setBusy("create");
    clearMessages();
    try {
      const owner = requireAccount(account);
      requireProtocolReady(protocolReady);
      const exactAmount = parseRouterAmount(amount);
      const wallet = await requireWallet(owner);
      const policy = buildRobinhoodPolicy(owner, direction, exactAmount);
      const salt = randomHex32();
      const predicted = await publicClient.readContract({
        address: OPENZAP_CONTRACTS.factory,
        abi: openZapFactoryAbi,
        functionName: "predict",
        args: [policy, salt],
      });
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: OPENZAP_CONTRACTS.factory,
        abi: openZapFactoryAbi,
        functionName: "createZap",
        args: [policy, salt],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(owner, hash, "Create immutable zap", receipt.status);
      if (receipt.status !== "success") throw new Error("Factory transaction reverted.");

      const verified = await inspectOwnedZap(publicClient, predicted, owner);
      const nextZap: SavedZapRecord = {
        address: verified.address,
        direction: verified.direction,
        amountIn: verified.amountIn.toString(),
        createTx: hash,
        createdAt: new Date().toISOString(),
        policyHash: verified.policyHash,
      };
      rememberZap(owner, nextZap);
      selectZap(nextZap);
      setNotice(`Immutable zap created at ${shortAddress(predicted)}. Fund it before execution.`);
      trackEvent("robinhood_zap_created", { zap: predicted, direction });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function wrapEth(): Promise<void> {
    setBusy("wrap");
    clearMessages();
    try {
      const owner = requireAccount(account);
      const exactAmount = parseRouterAmount(amount);
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: ROBINHOOD_ASSETS.weth,
        abi: wethAbi,
        functionName: "deposit",
        value: exactAmount,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(owner, hash, "Wrap ETH to aeWETH", receipt.status);
      if (receipt.status !== "success") throw new Error("WETH deposit reverted.");
      setNotice(`Wrapped ${formatToken(exactAmount)} ETH into aeWETH.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function fundZap(): Promise<void> {
    setBusy("fund");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a zap first.");
      requireProtocolReady(protocolReady);
      const verifiedZap = await inspectOwnedZap(publicClient, zap.address, owner);
      const verifiedAssets = assetsForDirection(verifiedZap.direction);
      const current = await publicClient.readContract({
        address: verifiedAssets.tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      const target = verifiedZap.amountIn;
      if (current >= target) {
        setNotice("Zap is already funded for this execution.");
        return;
      }
      const missing = target - current;
      const balance = await publicClient.readContract({
        address: verifiedAssets.tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      if (balance < missing) throw new Error(`Insufficient ${verifiedAssets.inputSymbol}. ${formatToken(missing)} required.`);
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: verifiedAssets.tokenIn,
        abi: erc20Abi,
        functionName: "transfer",
        args: [verifiedZap.address, missing],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(owner, hash, `Fund zap with ${verifiedAssets.inputSymbol}`, receipt.status);
      if (receipt.status !== "success") throw new Error("Funding transfer reverted.");
      const verified = await publicClient.readContract({
        address: verifiedAssets.tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      if (verified < target) throw new Error("Zap balance did not reach the policy amount after confirmation.");
      setNotice(`Zap funded with ${formatToken(target)} ${verifiedAssets.inputSymbol}.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function executeZap(): Promise<void> {
    setBusy("execute");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a zap first.");
      requireProtocolReady(protocolReady);
      const verifiedZap = await inspectOwnedZap(publicClient, zap.address, owner);
      const verifiedAssets = assetsForDirection(verifiedZap.direction);
      const liveInputBalance = await publicClient.readContract({
        address: verifiedAssets.tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      if (liveInputBalance < verifiedZap.amountIn) throw new Error("Fund the zap before execution.");

      // The signed minOut derives from a click-time re-quote; require a quote
      // the user actually reviewed, and abort when the market has moved below
      // the minimum that was on screen — never sign a floor the user never saw.
      if (quote === null || minOut === null) throw new Error("Request a live quote first to review the minimum output you are signing.");
      const freshQuote = await quoteExactInput(verifiedZap.direction, verifiedZap.amountIn, owner);
      if (freshQuote < minOut) {
        setQuote(freshQuote);
        setQuoteGas(null);
        throw new Error("The live price moved below your displayed minimum. Review the refreshed quote before signing.");
      }
      const signedMinOut = (freshQuote * BigInt(10_000 - slippageBps)) / 10_000n;
      if (signedMinOut <= 0n) throw new Error("The live quote is too small for a safe minimum output.");
      setQuote(freshQuote);
      setQuoteGas(null);

      const now = Math.floor(Date.now() / 1_000);
      const nonce = randomNonce();
      const intent = {
        zap: verifiedZap.address,
        chainId: BigInt(ROBINHOOD_CHAIN_ID),
        nonce,
        validAfter: BigInt(Math.max(0, now - 5)),
        deadline: BigInt(now + 10 * 60),
        recipient: owner,
        relayer: zeroAddress,
        maxRelayerFee: 0n,
        maxGas: MAX_EXECUTION_GAS,
        maxFeePerGas: MAX_EXECUTION_FEE_PER_GAS,
        policyHash: verifiedZap.policyHash,
        outAsset: verifiedAssets.tokenOut,
        minOut: signedMinOut,
      } as const;

      const wallet = await requireWallet(owner);
      const signature = await wallet.signTypedData({
        account: owner,
        domain: { name: "OpenZap", version: "1", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: verifiedZap.address },
        primaryType: "OpenZapIntent",
        types: {
          OpenZapIntent: [
            { name: "zap", type: "address" },
            { name: "chainId", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "validAfter", type: "uint64" },
            { name: "deadline", type: "uint64" },
            { name: "recipient", type: "address" },
            { name: "relayer", type: "address" },
            { name: "maxRelayerFee", type: "uint256" },
            { name: "maxGas", type: "uint256" },
            { name: "maxFeePerGas", type: "uint256" },
            { name: "policyHash", type: "bytes32" },
            { name: "outAsset", type: "address" },
            { name: "minOut", type: "uint256" },
          ],
        },
        message: intent,
      });

      const outputBefore = await publicClient.readContract({
        address: verifiedAssets.tokenOut,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: verifiedZap.address,
        abi: openZapAbi,
        functionName: "execute",
        args: [intent, signature],
        gas: MAX_EXECUTION_GAS,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(owner, hash, `${verifiedAssets.inputSymbol} → ${verifiedAssets.outputSymbol} zap`, receipt.status);
      if (receipt.status !== "success") throw new Error("Zap execution reverted.");

      const [outputAfter, nonceUsed] = await Promise.all([
        publicClient.readContract({ address: verifiedAssets.tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        publicClient.readContract({ address: verifiedZap.address, abi: openZapAbi, functionName: "nonceUsed", args: [nonce] }),
      ]);
      if (!nonceUsed || outputAfter <= outputBefore) throw new Error("Receipt confirmed but output or nonce verification failed.");
      const received = outputAfter - outputBefore;
      setExecutedZap(verifiedZap.address);
      setNotice(`Zap executed: received ${formatToken(received)} ${verifiedAssets.outputSymbol}.`);
      // Success disables the still-focused execute button; hand focus to the
      // announcement instead of letting it fall to <body>.
      queueMicrotask(() => noticeRef.current?.focus());
      trackEvent("robinhood_zap_executed", { zap: verifiedZap.address, direction: verifiedZap.direction, tx: hash });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function recoverFunds(): Promise<void> {
    setBusy("recover");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a zap first.");
      const verifiedZap = await inspectOwnedZap(publicClient, zap.address, owner);
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: verifiedZap.address,
        abi: openZapAbi,
        functionName: "emergencyExit",
        args: [[ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps]],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(owner, hash, "Emergency asset recovery", receipt.status);
      if (receipt.status !== "success") throw new Error("Recovery transaction reverted.");
      setNotice("Tracked aeWETH and 0xZAPS balances returned to the zap owner.");
      trackEvent("robinhood_zap_recovered", { zap: verifiedZap.address, tx: hash });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function loadExistingZap(): Promise<void> {
    setBusy("load");
    clearMessages();
    try {
      const owner = requireAccount(account);
      requireProtocolReady(protocolReady);
      const address = getAddress(manualZap.trim());
      const verified = await inspectOwnedZap(publicClient, address, owner);
      const record: SavedZapRecord = {
        address: verified.address,
        direction: verified.direction,
        amountIn: verified.amountIn.toString(),
        createdAt: new Date().toISOString(),
        policyHash: verified.policyHash,
      };
      rememberZap(owner, record);
      selectZap(record);
      setNotice(`Loaded verified zap ${shortAddress(address)}.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function watchToken(): Promise<void> {
    setBusy("watch");
    clearMessages();
    try {
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found.");
      await ensureRobinhoodChain(provider);
      const added = await watchZapsAsset(provider, new URL("/0xzaps-token.png", window.location.origin).href);
      setNotice(added ? "0xZAPS was added to your wallet." : "Wallet closed the add-token request.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function copyTokenAddress(): Promise<void> {
    clearMessages();
    try {
      await navigator.clipboard.writeText(ROBINHOOD_ASSETS.zaps);
      setNotice("0xZAPS contract address copied.");
    } catch {
      setError("Clipboard access was unavailable. Copy the address from the token page.");
    }
  }

  function exportCurrentZap(): void {
    if (!zap) return;
    const payload = JSON.stringify(
      {
        schema: "openzaps.robinhood.zap.v1",
        chainId: ROBINHOOD_CHAIN_ID,
        factory: OPENZAP_CONTRACTS.factory,
        adapter: OPENZAP_CONTRACTS.adapter,
        zap,
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openzap-${zap.address}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function disconnect(): Promise<void> {
    const provider = getInjectedProvider();
    try {
      await provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Not all EIP-1193 wallets support permission revocation; local state still disconnects.
    }
    setAccount(null);
    setWalletChainId(null);
    resetSessionState();
    clearMessages();
  }

  function resetSessionState(): void {
    setZap(null);
    setSavedZaps([]);
    setExecutedZap(null);
    setQuote(null);
    setQuoteGas(null);
    setTransactions([]);
    setManualZap("");
  }

  function recordTransaction(owner: Address, hash: Hex, label: string, status: "success" | "reverted"): void {
    setTransactions((current) => {
      const next = [
        {
          hash,
          label,
          status: status === "success" ? "confirmed" as const : "failed" as const,
          confirmedAt: new Date().toISOString(),
        },
        ...current.filter((transaction) => transaction.hash !== hash),
      ].slice(0, 20);
      saveTransactions(owner, next);
      return next;
    });
  }

  function clearMessages(): void {
    setNotice("");
    setError("");
  }

  function changeDirection(nextDirection: ZapDirection): void {
    setDirection(nextDirection);
    setQuote(null);
    setQuoteGas(null);
  }

  function changeAmount(nextAmount: string): void {
    setAmount(nextAmount);
    setQuote(null);
    setQuoteGas(null);
  }

  function selectZap(record: SavedZapRecord): void {
    setZap(record);
    setDirection(record.direction);
    setAmount(formatUnits(BigInt(record.amountIn), 18));
    setQuote(null);
    setQuoteGas(null);
    setExecutedZap(null);
  }

  function rememberZap(owner: Address, record: SavedZapRecord): void {
    setSavedZaps((current) => {
      const next = [record, ...current.filter((candidate) => candidate.address !== record.address)].slice(0, 20);
      saveZapList(owner, next);
      return next;
    });
  }

  function startNewZap(): void {
    setZap(null);
    setExecutedZap(null);
    setQuote(null);
    setQuoteGas(null);
    setManualZap("");
    clearMessages();
  }

  const wrongNetwork = walletChainId !== null && walletChainId !== ROBINHOOD_CHAIN_ID;
  const stepLabel = !account
    ? "1. Connect wallet"
    : wrongNetwork
      ? "2. Switch network"
      : !zap
        ? "2. Create zap"
        : executionComplete
          ? "Execution confirmed"
          : !funded
            ? "3. Fund zap"
            : "4. Sign & execute";

  return (
    <main className={styles.page} id="main">
      <section className={`container ${styles.statusBar}`} aria-label="Protocol status">
        <span className={protocolReady ? styles.statusLive : styles.statusPreview} role="status">
          {protocolHealth === "checking" ? "Checking contracts" : protocolReady ? "Live · pre-audit" : "Transactions paused"}
        </span>
        <p>
          {protocolReady ? (
            <>
              Bounded aeWETH ↔ 0xZAPS creation is open through factory{" "}
              <a href={explorerAddress(OPENZAP_CONTRACTS.factory)} target="_blank" rel="noreferrer">
                {shortAddress(OPENZAP_CONTRACTS.factory)}
              </a>
              . Contracts are live but not externally audited. Depositing funds can result in total loss.
            </>
          ) : (
            <>Contract health is unavailable or configuration is incomplete. Creation, funding, and execution are disabled.</>
          )}
        </p>
      </section>

      <section className={`container ${styles.appHead}`}>
        <div className={styles.titleRow}>
          <OpenZapMark className={styles.headMark} />
          <div>
            <span className="eyebrow">Live zap console</span>
            <h1>One policy. One bounded swap.</h1>
            <p>Create an immutable capsule, fund only its exact input, sign the output floor, and execute on Robinhood Chain.</p>
          </div>
        </div>
        <div className={styles.wallet}>
          {account ? (
            <>
              <a className={styles.addr} href={explorerAddress(account)} target="_blank" rel="noreferrer">
                {shortAddress(account)}
              </a>
              {wrongNetwork && (
                <button className="btn btnPrimary" disabled={busy !== null} onClick={() => void connectWallet()} type="button">
                  {busy === "connect" ? "Switching…" : "Switch network"}
                </button>
              )}
              <button className="btn btnGhost" onClick={() => void disconnect()} type="button">Disconnect</button>
            </>
          ) : (
            <button className="btn btnPrimary" disabled={busy !== null} onClick={() => void connectWallet()} type="button">
              {busy === "connect" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </section>

      <div className={`container ${styles.notice}`} ref={noticeRef} role="status" tabIndex={-1}>{notice}</div>
      {error && <div className={`container ${styles.error}`} role="alert">{error}</div>}

      <section className={`container ${styles.metrics}`} aria-label="Live protocol metrics">
        <Metric label="Network" value={wrongNetwork ? `Wrong chain · ${walletChainId ?? "?"}` : "Robinhood 4663"} />
        <Metric label="Pool" value="v4 · 2% hook" />
        <Metric label="Wallet input" value={`${formatToken(walletInputBalance)} ${inputSymbol}`} />
        <Metric label="Current step" value={stepLabel} />
      </section>

      <section className={`container ${styles.tokenTools}`} aria-label="0xZAPS token tools">
        <div>
          <span>Live token · Robinhood Chain</span>
          <strong>0xZAPS</strong>
          <code>{ROBINHOOD_ASSETS.zaps}</code>
        </div>
        <div className={styles.tokenActions}>
          <button className="btn btnGhost" onClick={() => void copyTokenAddress()} type="button">Copy address</button>
          <button className="btn btnGhost" disabled={busy !== null} onClick={() => void watchToken()} type="button">
            {busy === "watch" ? "Opening wallet…" : "Add to wallet"}
          </button>
          <a className="btn btnGhost" href={explorerAddress(ROBINHOOD_ASSETS.zaps)} target="_blank" rel="noreferrer">View token ↗</a>
        </div>
      </section>

      <section className={`container ${styles.workspace}`}>
        <section className={styles.builder} aria-label="Build a live zap">
          <div className={styles.builderTop}>
            <div>
              <span className={styles.cardHead}>Policy builder</span>
              <h2>Fixed-input Robinhood swap</h2>
              <p>The adapter is pool-bound: it cannot route to another token, spender, hook, or DEX.</p>
            </div>
            <span className={styles.liveBadge}>onchain</span>
          </div>

          <div className={styles.auditWarning} role="note">
            <strong>Pre-audit funds-at-risk warning.</strong>
            <span>Creation is open for this bounded route. Fund only what you can lose; contracts have not completed an external audit.</span>
          </div>

          <div className={styles.segment}>
            <button className={direction === "buy" ? styles.segOn : styles.seg} onClick={() => changeDirection("buy")} disabled={zap !== null} type="button">
              Buy 0xZAPS <em>aeWETH → 0xZAPS</em>
            </button>
            <button className={direction === "sell" ? styles.segOn : styles.seg} onClick={() => changeDirection("sell")} disabled={zap !== null} type="button">
              Sell 0xZAPS <em>0xZAPS → aeWETH</em>
            </button>
          </div>

          <div className={styles.formGrid}>
            <Field label={`Exact input (${inputSymbol})`}>
              <input className={styles.input} inputMode="decimal" value={amount} onChange={(event) => changeAmount(sanitizeDecimal(event.target.value))} disabled={zap !== null} />
            </Field>
            <Field label={`Signed max slippage (${(slippageBps / 100).toFixed(2)}%)`}>
              <input className={styles.range} min="10" max="500" step="10" type="range" value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} />
            </Field>
          </div>

          <div className={styles.quoteBox}>
            <div><span>Live quote</span><strong>{quote === null ? "Not requested" : `${formatToken(quote)} ${outputSymbol}`}</strong></div>
            <div><span>Signed minimum</span><strong>{minOut === null ? "—" : `${formatToken(minOut)} ${outputSymbol}`}</strong></div>
            <div><span>Quoter gas</span><strong>{quoteGas === null ? "—" : quoteGas.toLocaleString()}</strong></div>
            <button className="btn btnGhost" data-testid="quote-button" disabled={busy !== null || amountIn <= 0n} onClick={() => void requestQuote()} type="button">
              {busy === "quote" ? "Quoting…" : quote === null ? "Get live quote" : "Refresh quote"}
            </button>
          </div>

          <div className={styles.flow}>
            <FlowStep number="1" title="Create immutable zap" detail="Policy binds owner, recipient, adapter, spender, input token, and exact amount." done={zap !== null}>
              <button className="btn btnPrimary" data-testid="create-zap" disabled={!account || !protocolReady || wrongNetwork || zap !== null || busy !== null || amountIn <= 0n} onClick={() => void createZap()} type="button">
                {busy === "create" ? "Creating…" : "Create zap"}
              </button>
              {zap && <button className="btn btnGhost" disabled={busy !== null} onClick={startNewZap} type="button">Build another</button>}
            </FlowStep>
            <FlowStep number="2" title={`Fund with ${inputSymbol}`} detail="Direct ERC-20 transfer only. No standing wallet allowance is created." done={funded}>
              {direction === "buy" && (
                <button className="btn btnGhost" disabled={!account || busy !== null || amountIn <= 0n || nativeBalance < amountIn} onClick={() => void wrapEth()} type="button">
                  {busy === "wrap" ? "Wrapping…" : "Wrap ETH"}
                </button>
              )}
              <button className="btn btnPrimary" disabled={!zap || !protocolReady || funded || busy !== null} onClick={() => void fundZap()} type="button">
                {busy === "fund" ? "Funding…" : "Fund zap"}
              </button>
            </FlowStep>
            <FlowStep number="3" title="Sign and execute" detail="Requires a reviewed live quote; execution aborts if the price drops below your displayed minimum. The EIP-712 intent expires in ten minutes and caps gas and fee price." done={executionComplete}>
              <button className="btn btnPrimary" disabled={!protocolReady || !funded || quote === null || busy !== null || executionComplete} onClick={() => void executeZap()} type="button">
                {busy === "execute" ? "Executing…" : executionComplete ? "Execution confirmed" : "Sign & execute"}
              </button>
            </FlowStep>
          </div>
        </section>

        <aside className={styles.review} aria-label="Live verification">
          <span className={styles.cardHead}>Verification</span>
          <h2>Nothing hidden.</h2>
          <div className={styles.verifyList}>
            <VerifyRow label="Factory health" value={protocolReady ? "RPC reads ready" : protocolHealth} href={configured ? explorerAddress(OPENZAP_CONTRACTS.factory) : undefined} ok={protocolReady} />
            <VerifyRow label="Pool-bound adapter" value={shortAddress(OPENZAP_CONTRACTS.adapter)} href={configured ? explorerAddress(OPENZAP_CONTRACTS.adapter) : undefined} ok={configured} />
            <VerifyRow label="Pool ID" value={`${ROBINHOOD_LIQUIDITY.poolId.slice(0, 10)}…${ROBINHOOD_LIQUIDITY.poolId.slice(-6)}`} ok />
            <VerifyRow label="Router allowance" value="Cleared after every swap" ok />
            <VerifyRow label="Permit2 allowance" value="Cleared after every swap" ok />
            <VerifyRow label="Output protection" value="Signed minOut in OpenZap" ok />
          </div>

          <div className={styles.currentZap}>
            <span>Current zap</span>
            {zap ? (
              <>
                <a href={explorerAddress(zap.address)} target="_blank" rel="noreferrer">{zap.address}</a>
                <div><small>Required</small><strong>{formatToken(requiredAmount)} {inputSymbol}</strong></div>
                <div><small>Zap aeWETH</small><strong>{formatToken(zapWethBalance)} aeWETH</strong></div>
                <div><small>Zap 0xZAPS</small><strong>{formatToken(zapZapsBalance)} 0xZAPS</strong></div>
                <div><small>Zap native</small><strong>{formatToken(zapNativeBalance)} ETH</strong></div>
                <div><small>Wallet output</small><strong>{formatToken(walletOutputBalance)} {outputSymbol}</strong></div>
                <button className="btn btnGhost" disabled={busy !== null} onClick={exportCurrentZap} type="button">Export public config</button>
                <button className="btn btnGhost" disabled={busy !== null || recoverableBalance === 0n} onClick={() => void recoverFunds()} type="button">
                  {busy === "recover" ? "Recovering…" : "Emergency recover"}
                </button>
              </>
            ) : <p>No zap loaded.</p>}
          </div>

          <div className={styles.loadZap}>
            <label htmlFor="load-zap">Resume or recover an owned canonical zap</label>
            <input id="load-zap" className={styles.input} placeholder="0x…" value={manualZap} onChange={(event) => setManualZap(event.target.value)} />
            <button className="btn btnGhost" disabled={!account || !protocolReady || busy !== null || manualZap.length !== 42} onClick={() => void loadExistingZap()} type="button">
              {busy === "load" ? "Loading…" : "Load verified zap"}
            </button>
          </div>

          {savedZaps.length > 0 && (
            <div aria-label="Verified zap history" className={styles.savedZaps} role="group">
              <span aria-hidden="true">Verified zap history</span>
              {savedZaps.map((record) => {
                const active = zap?.address === record.address;
                return (
                  <button
                    aria-pressed={active}
                    className={active ? styles.savedZapActive : styles.savedZap}
                    disabled={busy !== null}
                    key={record.address}
                    onClick={() => selectZap(record)}
                    type="button"
                  >
                    <strong>{active ? "✓ " : ""}{record.direction === "buy" ? "Buy 0xZAPS" : "Sell 0xZAPS"}</strong>
                    <code>{shortAddress(record.address)}</code>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      </section>

      <section className={`container ${styles.receipts}`} aria-label="Transaction receipts">
        <div className={styles.receiptHead}>
          <div><span className="eyebrow">Receipts</span><h2>Confirmed wallet activity.</h2></div>
          <a href={ROBINHOOD_EXPLORER_URL} target="_blank" rel="noreferrer">Open Robinhood Blockscout ↗</a>
        </div>
        {transactions.length === 0 ? (
          <p className={styles.empty}>Transactions appear here only after a successful Robinhood RPC receipt.</p>
        ) : (
          <div className={styles.txList}>
            {transactions.map((transaction) => (
              <a href={explorerTransaction(transaction.hash)} target="_blank" rel="noreferrer" key={transaction.hash}>
                <span data-status={transaction.status}>{transaction.status}</span>
                <strong>{transaction.label}</strong>
                <code>{shortHash(transaction.hash)} · {formatReceiptTime(transaction.confirmedAt)}</code>
              </a>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

async function quoteExactInput(direction: ZapDirection, amountIn: bigint, account: Address): Promise<bigint> {
  const assets = assetsForDirection(direction);
  const { result } = await publicClient.simulateContract({
    account,
    address: ROBINHOOD_LIQUIDITY.v4Quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{
      poolKey: robinhoodPoolKey,
      zeroForOne: assets.zeroForOne,
      exactAmount: amountIn,
      hookData: "0x",
    }],
  });
  return result[0];
}

async function requireWallet(account: Address) {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("Wallet provider disconnected.");
  await ensureRobinhoodChain(provider);
  const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
  const [active] = await wallet.getAddresses();
  if (!active || active.toLowerCase() !== account.toLowerCase()) {
    throw new Error("Connected wallet account changed. Reconnect before submitting.");
  }
  return wallet;
}

function requireAccount(account: Address | null): Address {
  if (!account) throw new Error("Connect a wallet first.");
  return account;
}

function requireProtocolReady(ready: boolean): void {
  if (!ready) throw new Error("OpenZap contract health is unavailable. Transactions are paused.");
}

function saveZapList(owner: Address, records: SavedZapRecord[]): void {
  try {
    window.localStorage.setItem(`${ZAP_STORAGE_KEY}:${owner.toLowerCase()}`, JSON.stringify(records));
  } catch {
    // Persistence is optional; verified onchain state remains authoritative.
  }
}

function readSavedZaps(owner: Address): SavedZapRecord[] {
  const currentKey = `${ZAP_STORAGE_KEY}:${owner.toLowerCase()}`;
  const legacyKey = `${LEGACY_STORAGE_KEY}:${owner.toLowerCase()}`;
  try {
    const current = parseStoredJson(window.localStorage.getItem(currentKey));
    const candidates = Array.isArray(current) ? current : [];
    const parsed = candidates.flatMap((candidate) => {
      const record = normalizeZapRecord(candidate);
      return record ? [record] : [];
    });
    if (parsed.length > 0) return parsed.sort(newestFirst);

    const legacy = normalizeZapRecord(parseStoredJson(window.localStorage.getItem(legacyKey)));
    if (!legacy) return [];
    window.localStorage.removeItem(legacyKey);
    saveZapList(owner, [legacy]);
    return [legacy];
  } catch {
    try {
      window.localStorage.removeItem(currentKey);
    } catch {
      // Storage access is blocked entirely (private mode / embedded webview).
    }
    return [];
  }
}

function normalizeZapRecord(value: unknown): SavedZapRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawAddress = typeof record.address === "string" ? record.address : record.zapAddress;
  if (typeof rawAddress !== "string" || (record.direction !== "buy" && record.direction !== "sell")) return null;
  if (typeof record.amountIn !== "string" || typeof record.createdAt !== "string") return null;
  try {
    if (BigInt(record.amountIn) <= 0n) return null;
    const policyHash = typeof record.policyHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.policyHash)
      ? record.policyHash as Hex
      : zeroHash;
    const createTx = typeof record.createTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.createTx)
      ? record.createTx as Hex
      : undefined;
    return {
      address: getAddress(rawAddress),
      direction: record.direction,
      amountIn: record.amountIn,
      createdAt: record.createdAt,
      policyHash,
      createTx,
    };
  } catch {
    return null;
  }
}

function saveTransactions(owner: Address, records: TransactionRecord[]): void {
  try {
    window.localStorage.setItem(`${TX_STORAGE_KEY}:${owner.toLowerCase()}`, JSON.stringify(records));
  } catch {
    // Receipt persistence is optional.
  }
}

function readTransactions(owner: Address): TransactionRecord[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(`${TX_STORAGE_KEY}:${owner.toLowerCase()}`);
  } catch {
    return [];
  }
  const parsed = parseStoredJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    if (
      typeof record.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(record.hash) ||
      typeof record.label !== "string" ||
      (record.status !== "confirmed" && record.status !== "failed") ||
      typeof record.confirmedAt !== "string"
    ) return [];
    return [{
      hash: record.hash as Hex,
      label: record.label,
      status: record.status,
      confirmedAt: record.confirmedAt,
    } satisfies TransactionRecord];
  }).slice(0, 20);
}

function parseStoredJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function newestFirst(a: SavedZapRecord, b: SavedZapRecord): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function parseOptionalRouterAmount(value: string): bigint {
  if (!value || value === ".") return 0n;
  try {
    return parseRouterAmount(value);
  } catch {
    return 0n;
  }
}

function sanitizeDecimal(value: string): string {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}

function formatToken(value: bigint): string {
  const formatted = Number(formatUnits(value, 18));
  if (!Number.isFinite(formatted)) return "—";
  if (formatted === 0) return "0";
  if (formatted < 0.000001) return formatted.toExponential(3);
  return formatted.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function shortAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

function formatReceiptTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function readableError(cause: unknown): string {
  if (cause instanceof Error) {
    const firstLine = cause.message.split("\n")[0];
    return firstLine.replace("User rejected the request.", "Wallet request rejected.");
  }
  return "Unknown wallet or RPC error.";
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className={styles.metric}><strong>{value}</strong><span>{label}</span></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function FlowStep({ number, title, detail, done, children }: {
  number: string;
  title: string;
  detail: string;
  done: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.flowStep} data-done={done}>
      <span>{done ? "✓" : number}</span>
      <div><strong>{title}</strong><p>{detail}</p><div className={styles.flowActions}>{children}</div></div>
    </div>
  );
}

function VerifyRow({ label, value, href, ok }: { label: string; value: string; href?: string; ok: boolean }): React.JSX.Element {
  return (
    <div className={styles.verifyRow}>
      <span>{ok ? "✓" : "!"}</span>
      <div><small>{label}</small>{href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : <strong>{value}</strong>}</div>
    </div>
  );
}