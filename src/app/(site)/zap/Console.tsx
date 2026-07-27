"use client";

import Link from "next/link";
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
  type Hex,
} from "viem";
import { useWalletSession } from "@/components/WalletProvider";
import { BlockGlyph } from "./BlockGlyph";
import { CreationWorkspace } from "./CreationWorkspace";
import { TransactionLifecycle } from "./TransactionLifecycle";
import { trackEvent } from "@/lib/analytics";
import {
  ACTIVITY_FROM_BLOCK,
  assetDecimalsFor,
  assetSymbolFor,
  emergencyExitEvent,
  executedEvent,
} from "@/lib/activity";
import {
  MAX_RECEIPT_RETENTION,
  QUOTE_AUTO_REFRESH_MS,
  autoRefreshQuotes,
  canExportReceipts,
  holderTierFor,
  receiptLimitFor,
  savedZapLimitFor,
  tierLabel,
  type HolderTier,
} from "@/lib/holder";
import {
  buildRoutePolicy,
  inspectOwnedZap,
  parseRouterAmount,
  randomHex32,
  randomNonce,
  type SavedZapRecord,
} from "@/lib/openzap";
import {
  MAX_EXECUTION_FEE_GWEI,
  MAX_EXECUTION_GAS_UNITS,
  MIN_EXECUTION_FEE_GWEI,
  MIN_EXECUTION_GAS_UNITS,
  readExecutionPolicyParams,
  type ExecutionPolicy,
} from "@/lib/execution-policy";
import {
  BOUNDED_SWAP_IDS,
} from "@/lib/chains";
import {
  deployedRoutes,
  resolveOfferedRoutes,
  resolveRouteById,
  type Route,
} from "@/lib/routes";
import { quoteCreationFee, quoteRoute, type CreationFeeQuote } from "@/lib/route-quote";
import {
  OPENZAP_CREATION_FEE,
  OPENZAP_CREATION_FEE_CONTRACTS,
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_RPC_URL,
  erc20Abi,
  ensureRobinhoodChain,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  openZapAbi,
  openZapCreationFeeConfigured,
  openZapCreationGatewayAbi,
  openZapFactoryAbi,
  openZapProtocolConfigured,
  robinhoodChain,
  wethAbi,
} from "@/lib/robinhood";
import { protocolsForRouteKind } from "@/lib/protocols";
import type { TransactionLifecycleState } from "@/lib/transaction-lifecycle";
import { ProtocolStack } from "@/components/ProtocolLogo";
import styles from "./app.module.css";

/** The route the console opens on: the bounded aeWETH → 0xZAPS buy. */
const DEFAULT_ROUTE_ID = BOUNDED_SWAP_IDS[0];

/** One honest phrase per deployed route kind — shown beside its protocol marks. */
const ROUTE_KIND_LABEL: Record<Route["kind"], string> = {
  swap: "Uniswap v4",
  "swap-route": "two pools, one step",
  "vault-deposit": "vault deposit",
  "vault-redeem": "vault redeem",
  "lp-deposit": "Zap in to liquidity",
  "lp-withdraw": "Zap out of liquidity",
};

type BusyAction =
  | "connect"
  | "quote"
  | "create"
  | "wrap"
  | "fund"
  | "execute"
  | "recover"
  | "load"
  | null;

type TransactionRecord = {
  hash: Hex;
  label: string;
  status: "confirmed" | "failed";
  confirmedAt: string;
};

type HealthState = "checking" | "ready" | "degraded";
type ZapHistoryEntry = {
  label: string;
  txHash: Hex;
  amount: bigint;
  assetSymbol: string;
  assetDecimals: number;
};
type ZapHistoryState = "loading" | "unavailable" | ZapHistoryEntry[];
type CreatedZapResult = SavedZapRecord & { createTx: Hex };

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 10_000 }),
});
const LEGACY_STORAGE_KEY = "openzaps:robinhood-live-zap:v1";
const ZAP_STORAGE_KEY = "openzaps:robinhood-live-zaps:v2";
const TX_STORAGE_KEY = "openzaps:robinhood-transactions:v1";
const CREATION_WORKSPACE_KEY = "openzaps:creation-workspace:v1";

export default function AppPage(): React.JSX.Element {
  const configured = openZapProtocolConfigured();
  const feeConfigured = openZapCreationFeeConfigured();
  const {
    account,
    chainId: walletChainId,
    connect: connectSession,
    disconnect: disconnectSession,
    switchToRobinhood,
  } = useWalletSession();
  const [protocolHealth, setProtocolHealth] = useState<HealthState>("checking");
  const [routeId, setRouteId] = useState<string>(DEFAULT_ROUTE_ID);
  // The routes the console may OFFER for a NEW zap: deployed swaps always, and a
  // vault route only once its vault is seeded (totalSupply > 0). Seeded via an
  // RPC read below; the initial value is the seed-free swap set so the selector
  // is never empty. An already-created zap can still be managed off this list.
  const [offeredRoutes, setOfferedRoutes] = useState<Route[]>(() =>
    deployedRoutes().filter((route) => !route.requiresSeededVault),
  );
  /** True once the async seeded-vault read has settled (success or failure). */
  const [offeredReady, setOfferedReady] = useState(false);
  const [amount, setAmount] = useState("0.001");
  const [slippageBps, setSlippageBps] = useState(100);
  // The two disclosures on the signing card. Both start closed: the card's job
  // is to show the one route being signed, and ten route cards on first paint
  // buries it. "Change route" is in the header, next to what it changes.
  const [routeOpen, setRouteOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maxExecutionGas, setMaxExecutionGas] = useState(MAX_EXECUTION_GAS_UNITS);
  const [maxFeePerGasGwei, setMaxFeePerGasGwei] = useState(MAX_EXECUTION_FEE_GWEI);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteGas, setQuoteGas] = useState<bigint | null>(null);
  const [creationFeeQuote, setCreationFeeQuote] = useState<CreationFeeQuote | null>(null);
  const [creationFeeError, setCreationFeeError] = useState("");
  // The quote the user explicitly requested and reviewed. Silent auto-refresh
  // updates `quote` for display but never this — the execute-time abort guard
  // compares against the floor the user actually acknowledged.
  const [reviewedQuote, setReviewedQuote] = useState<bigint | null>(null);
  const [autoRefreshedAt, setAutoRefreshedAt] = useState<string | null>(null);
  const [zap, setZap] = useState<SavedZapRecord | null>(null);
  const [savedZaps, setSavedZaps] = useState<SavedZapRecord[]>([]);
  const [creationResult, setCreationResult] = useState<CreatedZapResult | null>(null);
  const [executedZap, setExecutedZap] = useState<Address | null>(null);
  const [manualZap, setManualZap] = useState("");
  // Balances for the SELECTED route's tokens. When a zap is selected the route
  // tracks the zap's route (selectZap keeps them in sync), so these double as
  // the capsule's own balances.
  const [walletInBalance, setWalletInBalance] = useState(0n);
  const [walletOutBalance, setWalletOutBalance] = useState(0n);
  // Route-INDEPENDENT: the connected wallet's 0xZAPS balance, read for the
  // holder tier even on a route (USDG/vault) that never touches 0xZAPS.
  const [walletZapsBalance, setWalletZapsBalance] = useState(0n);
  const [zapInBalance, setZapInBalance] = useState(0n);
  const [zapOutBalance, setZapOutBalance] = useState(0n);
  const [zapNativeBalance, setZapNativeBalance] = useState(0n);
  const [nativeBalance, setNativeBalance] = useState(0n);
  const [busy, setBusy] = useState<BusyAction>(null);
  /** True for the whole "Fund & run" chain, including the gap between its two legs where `busy`
   *  briefly returns to null — without it that gap would re-enable the button mid-flight. */
  const [chainedRun, setChainedRun] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [transactionLifecycle, setTransactionLifecycle] = useState<TransactionLifecycleState | null>(null);
  const [zapHistory, setZapHistory] = useState<ZapHistoryState>([]);
  const zapRef = useRef<SavedZapRecord | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const holderTierRef = useRef<HolderTier>("none");
  const autoQuoteRef = useRef<(() => void) | null>(null);
  // Bumped whenever direction/amount/zap context changes so an in-flight
  // quote response for the old context can never land on the new one.
  const quoteEpochRef = useRef(0);
  // Whether this page load came from the builder handoff, and whether the
  // handoff was usable. Read by the saved-zap restore below, which must not
  // auto-select an old capsule over an explicit "build this one" intent.
  const builderImportRef = useRef<"applied" | "rejected" | null>(null);


  useEffect(() => {
    zapRef.current = zap;
  }, [zap]);

  const resetQuoteState = useCallback((): void => {
    quoteEpochRef.current += 1;
    setQuote(null);
    setQuoteGas(null);
    setReviewedQuote(null);
    setAutoRefreshedAt(null);
  }, []);

  const selectZap = useCallback((record: SavedZapRecord): void => {
    setZap(record);
    setRouteId(record.routeId);
    // Format the stored raw amount at the ROUTE's real decimals — 6 for USDG,
    // 9 for ozUSDG — or the input box shows a value ~10^12x off.
    const record_route = resolveRouteById(record.routeId);
    setAmount(formatUnits(BigInt(record.amountIn), record_route?.tokenIn.decimals ?? 18));
    resetQuoteState();
    setExecutedZap(null);
  }, [resetQuoteState]);


  useEffect(() => {
    const address = zap?.address;
    let cancelled = false;
    const loadHistory = async (): Promise<void> => {
      if (!address) {
        setZapHistory([]);
        return;
      }
      setZapHistory("loading");
      try {
        const [executedLogs, exitLogs] = await Promise.all([
          publicClient.getLogs({ address, event: executedEvent, fromBlock: ACTIVITY_FROM_BLOCK }),
          publicClient.getLogs({ address, event: emergencyExitEvent, fromBlock: ACTIVITY_FROM_BLOCK }),
        ]);
        if (cancelled) return;
        const entries: (ZapHistoryEntry & { block: bigint })[] = [
          ...executedLogs.flatMap((log) =>
            log.args.outAsset && log.args.amountOut !== undefined
              ? [{
                  label: "Executed",
                  txHash: log.transactionHash,
                  amount: log.args.amountOut,
                  assetSymbol: assetSymbolFor(log.args.outAsset),
                  assetDecimals: assetDecimalsFor(log.args.outAsset),
                  block: log.blockNumber,
                }]
              : [],
          ),
          ...exitLogs.flatMap((log) =>
            log.args.asset && log.args.amount !== undefined
              ? [{
                  label: "Recovered",
                  txHash: log.transactionHash,
                  amount: log.args.amount,
                  assetSymbol: assetSymbolFor(log.args.asset),
                  assetDecimals: assetDecimalsFor(log.args.asset),
                  block: log.blockNumber,
                }]
              : [],
          ),
        ];
        entries.sort((a, b) => (a.block < b.block ? 1 : -1));
        setZapHistory(entries.map((entry) => ({
          label: entry.label,
          txHash: entry.txHash,
          amount: entry.amount,
          assetSymbol: entry.assetSymbol,
          assetDecimals: entry.assetDecimals,
        })));
      } catch {
        if (!cancelled) setZapHistory("unavailable");
      }
    };
    queueMicrotask(() => {
      if (!cancelled) void loadHistory();
    });
    return () => {
      cancelled = true;
    };
    // transactions is a dependency so the history refetches after any
    // confirmed receipt (execute, recover) for the selected zap.
  }, [zap?.address, executedZap, transactions]);

  // The active route — the single source of tokens, decimals, pool/vault, and
  // Step.data encoding for everything below. When a zap is selected, selectZap
  // sets routeId to the zap's route, so `route` is also the capsule's route.
  const route = useMemo(() => resolveRouteById(routeId), [routeId]);
  const inDecimals = route?.tokenIn.decimals ?? 18;
  const inputSymbol = route?.tokenIn.symbol ?? "";
  const outputSymbol = route?.tokenOut.symbol ?? "";
  const outDecimals = route?.tokenOut.decimals ?? 18;
  const routeOffered = offeredRoutes.some((candidate) => candidate.id === routeId);
  const canWrapInput = route !== null && isAddressEqual(route.tokenIn.address, ROBINHOOD_ASSETS.weth);
  const venueLabel =
    route === null
      ? "—"
      : route.kind === "swap"
        ? "Uniswap v4 pool"
        : route.kind === "swap-route"
          ? "Uniswap v4, two pools stitched"
          : route.kind === "lp-deposit"
            ? "Full-range v4 LP vault deposit"
            : route.kind === "lp-withdraw"
              ? "Full-range v4 LP vault withdraw"
              : route.kind === "vault-deposit"
                ? "ERC-4626 vault deposit"
                : "ERC-4626 vault redeem";
  const routePairLabel = route === null ? "—" : `${route.tokenIn.symbol} → ${route.tokenOut.symbol}`;
  const settlementLabel =
    route === null
      ? "—"
      : route.quote.source === "v4"
        ? `${routePairLabel} · Uniswap v4`
        : route.quote.source === "v4-route"
          ? `${routePairLabel} · via aeWETH, one signed step`
          : `Vault ${shortAddress(route.quote.vault)}`;
  const amountIn = useMemo(() => parseOptionalRouterAmount(amount, inDecimals), [amount, inDecimals]);
  const requiredAmount = zap ? BigInt(zap.amountIn) : amountIn;
  const walletInputBalance = walletInBalance;
  const walletOutputBalance = walletOutBalance;
  const zapInputBalance = zapInBalance;
  const recoverableBalance = zapInBalance + zapOutBalance + zapNativeBalance;
  const funded = zap !== null && requiredAmount > 0n && zapInputBalance >= requiredAmount;
  const executionComplete = zap !== null && executedZap === zap.address;
  const minOut = quote === null ? null : (quote * BigInt(10_000 - slippageBps)) / 10_000n;
  const protocolReady = configured && protocolHealth === "ready";
  // App-level holder utilities: unlocked by connected-wallet 0xZAPS balance.
  // Route-INDEPENDENT — reads 0xZAPS even on a USDG/vault route. Never token-gated.
  const holderTier: HolderTier = account ? holderTierFor(walletZapsBalance) : "none";

  const clearMessages = useCallback((): void => {
    setNotice("");
    setError("");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => autoQuoteRef.current?.(), QUOTE_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const refreshBalances = useCallback(async (): Promise<void> => {
    if (!account || !route) return;
    const tokenIn = route.tokenIn.address;
    const tokenOut = route.tokenOut.address;
    try {
      const [walletIn, walletOut, walletZaps, native, zapIn, zapOut, zapNative] = await Promise.all([
        publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        // Always the 0xZAPS balance, regardless of route — it drives the holder tier.
        publicClient.readContract({ address: ROBINHOOD_ASSETS.zaps, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        publicClient.getBalance({ address: account }),
        zap
          ? publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [zap.address] })
          : Promise.resolve(0n),
        zap
          ? publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [zap.address] })
          : Promise.resolve(0n),
        zap
          ? publicClient.getBalance({ address: zap.address })
          : Promise.resolve(0n),
      ]);
      setWalletInBalance(walletIn);
      setWalletOutBalance(walletOut);
      setWalletZapsBalance(walletZaps);
      setNativeBalance(native);
      setZapInBalance(zapIn);
      setZapOutBalance(zapOut);
      setZapNativeBalance(zapNative);
    } catch (cause) {
      setError(readableError(cause));
    }
  }, [account, zap, route]);

  // The offered set: deployed swaps plus any vault route whose vault is seeded.
  // Read once on mount; an unseeded vault route stays out of the selector and
  // the create flow (fail closed). `offeredReady` marks the read as settled —
  // the builder-import effect must not pass its final verdict on a vault route
  // against the pre-read set, which never contains one.
  useEffect(() => {
    let cancelled = false;
    void resolveOfferedRoutes(publicClient)
      .then((routes) => {
        if (!cancelled) setOfferedRoutes(routes);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setOfferedReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      if (!feeConfigured) {
        if (!cancelled) setProtocolHealth("degraded");
        return;
      }
      try {
        const [
          response,
          implementation,
          version,
          factoryCode,
          adapterCode,
          registryCode,
          allowlistCode,
          gatewayCode,
          potCode,
          gatewayVersion,
          gatewayFee,
          gatewayFactory,
          gatewayPot,
        ] = await Promise.all([
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
          publicClient.getBytecode({ address: OPENZAP_CREATION_FEE_CONTRACTS.gateway }),
          publicClient.getBytecode({ address: OPENZAP_CREATION_FEE_CONTRACTS.pot }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "VERSION",
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "CREATION_FEE",
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "lineageFactory",
            args: [0],
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "CREATION_POT",
          }),
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
          && gatewayVersion === "1.0.0-candidate"
          && gatewayFee === OPENZAP_CREATION_FEE
          && isAddressEqual(gatewayFactory, OPENZAP_CONTRACTS.factory)
          && isAddressEqual(gatewayPot, OPENZAP_CREATION_FEE_CONTRACTS.pot)
          && Boolean(factoryCode && adapterCode && registryCode && allowlistCode && gatewayCode && potCode);
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
  }, [feeConfigured]);


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
            routeId: verified.route.id,
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
      const receiptAddress = readCreationWorkspace(account);
      const receipt = receiptAddress
        ? merged.find((record) => record.address === receiptAddress && record.createTx !== undefined)
        : undefined;
      if (receipt?.createTx) setCreationResult({ ...receipt, createTx: receipt.createTx });
      // Always read at maximum retention: the holder tier may not be known yet
      // (balance still loading), and a truncating read followed by a persisting
      // write would permanently destroy a holder's extended history.
      setTransactions(readTransactions(account, MAX_RECEIPT_RETENTION));
      if (!rpcHealthy) setNotice("Saved zaps could not be verified right now — Robinhood RPC is unreachable. They remain saved.");
      const firstVerified = merged.find((record) => verified.has(record.address));
      // An import from the builder is an explicit "start a new zap" — selecting
      // a saved capsule here would overwrite the imported direction and amount
      // with an older policy's and re-disable the controls, silently.
      if (firstVerified && zapRef.current === null && builderImportRef.current !== "applied") {
        selectZap(firstVerified);
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [account, selectZap]);

  async function connectWallet(): Promise<void> {
    setBusy("connect");
    clearMessages();
    try {
      const nextAccount = await connectSession();
      setNotice("Wallet connected to Robinhood Chain.");
      trackEvent("robinhood_wallet_connected", { account: nextAccount });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function switchWalletNetwork(): Promise<void> {
    setBusy("connect");
    clearMessages();
    try {
      await switchToRobinhood();
      setNotice("Wallet switched to Robinhood Chain.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function requestQuote(options?: { silent?: boolean }): Promise<bigint | null> {
    const silent = options?.silent === true;
    const epoch = quoteEpochRef.current;
    if (!silent) {
      setBusy("quote");
      clearMessages();
    }
    try {
      if (!route) throw new Error("Select a deployed route first.");
      const exactAmount = parseRouterAmount(amount, route.tokenIn.decimals);
      // Swap: the v4 quoter for this route's OWN pool key. Vault: the ERC-4626
      // preview — no pool, no gas estimate, and a zero preview means "would revert".
      const { amountOut, gasEstimate } = await quoteRoute(publicClient, route, exactAmount, account ?? zeroAddress);
      // The route/amount/zap context changed while this quote was in flight; its
      // result belongs to the old context and must be dropped.
      if (epoch !== quoteEpochRef.current) return null;
      setQuote(amountOut);
      setQuoteGas(gasEstimate);
      if (silent) {
        setAutoRefreshedAt(new Date().toLocaleTimeString("en-US"));
      } else {
        setReviewedQuote(amountOut);
        setAutoRefreshedAt(null);
        setNotice(
          route.kind === "swap"
            ? "Live pool quote loaded. The signed minimum is enforced after the adapter returns."
            : "Vault preview loaded. The signed minimum output is enforced by OpenZap after the vault call.",
        );
      }
      return amountOut;
    } catch (cause) {
      // A failed silent refresh keeps the last quote on screen; the
      // execute-time reviewed-floor guard still protects the signed minimum.
      if (!silent && epoch === quoteEpochRef.current) {
        setQuote(null);
        setQuoteGas(null);
        setReviewedQuote(null);
        setError(`Quote unavailable: ${readableError(cause)}`);
      }
      return null;
    } finally {
      if (!silent) setBusy(null);
    }
  }

  // Latest-callback pattern: the 20s interval always invokes the current
  // render's closure, so auto-refresh sees fresh state without re-arming.
  useEffect(() => {
    holderTierRef.current = holderTier;
    autoQuoteRef.current = () => {
      if (!autoRefreshQuotes(holderTier)) return;
      if (busy !== null || quote === null || executionComplete || amountIn <= 0n) return;
      void requestQuote({ silent: true });
    };
  });

  const refreshCreationFeeQuote = useCallback(async (): Promise<CreationFeeQuote | null> => {
    if (!feeConfigured) {
      setCreationFeeQuote(null);
      setCreationFeeError("Creation-fee gateway is not configured. New zap creation is paused.");
      return null;
    }
    try {
      const next = await quoteCreationFee(publicClient, account ?? zeroAddress);
      setCreationFeeQuote(next);
      setCreationFeeError("");
      return next;
    } catch (cause) {
      setCreationFeeQuote(null);
      setCreationFeeError(`Creation-fee quote unavailable: ${readableError(cause)}`);
      return null;
    }
  }, [account, feeConfigured]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCreationFeeQuote(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshCreationFeeQuote]);

  /**
   * Keep the transaction hash visible while receipt polling is in flight.
   * A wallet rejection is explicitly "not submitted"; an RPC interruption
   * preserves the hash as "unknown" so the explorer, not a local spinner,
   * remains the source of truth.
   */
  async function submitAndConfirm(
    owner: Address,
    label: string,
    submit: () => Promise<Hex>,
  ): Promise<{ hash: Hex; status: "success" | "reverted" }> {
    setTransactionLifecycle({ label, stage: "wallet", updatedAt: new Date().toISOString() });

    let hash: Hex;
    try {
      hash = await submit();
    } catch (cause) {
      setTransactionLifecycle({ label, stage: "not-submitted", updatedAt: new Date().toISOString() });
      throw cause;
    }

    setTransactionLifecycle({ label, stage: "submitted", hash, updatedAt: new Date().toISOString() });
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(owner, hash, label, receipt.status);
      setTransactionLifecycle({
        label,
        stage: receipt.status === "success" ? "confirmed" : "reverted",
        hash,
        updatedAt: new Date().toISOString(),
      });
      return { hash, status: receipt.status };
    } catch (cause) {
      setTransactionLifecycle({ label, stage: "unknown", hash, updatedAt: new Date().toISOString() });
      throw cause;
    }
  }

  async function createZap(): Promise<void> {
    setBusy("create");
    clearMessages();
    try {
      const owner = requireAccount(account);
      requireProtocolReady(protocolReady);
      if (!feeConfigured || OPENZAP_CREATION_FEE_CONTRACTS.gateway === zeroAddress) {
        throw new Error("Creation-fee gateway is not configured. New zap creation is paused.");
      }
      if (!creationFeeQuote) throw new Error("Review a creation-fee conversion quote before creating this zap.");
      if (!route) throw new Error("Select a deployed route first.");
      // Fail closed: never create a capsule for a route that is not offered —
      // an undeployed adapter, or a vault whose totalSupply is 0 (grief-able).
      if (!routeOffered) {
        throw new Error(
          "This route is not currently offered. Every route needs a deployed adapter, and a vault route needs a seeded vault (totalSupply > 0).",
        );
      }
      const exactAmount = parseRouterAmount(amount, route.tokenIn.decimals);
      const wallet = await requireWallet(owner);
      // Bounded swap + both vault adapters take Step.data 0x; the USDG pool
      // adapter takes abi.encode(uint256 minOut). buildRoutePolicy emits the
      // right shape from route.data — minOut 0 here (no stale frozen floor); the
      // binding slippage floor is the owner-signed intent.minOut at execute time.
      const policy = buildRoutePolicy(owner, route, exactAmount);
      const salt = randomHex32();
      const predicted = await publicClient.readContract({
        address: OPENZAP_CONTRACTS.factory,
        abi: openZapFactoryAbi,
        functionName: "predict",
        args: [policy, salt],
      });
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
        abi: openZapCreationGatewayAbi,
        functionName: "createZap",
        args: [0, policy, salt, creationFeeQuote.minZapsOut],
        value: OPENZAP_CREATION_FEE,
      });
      const { hash, status } = await submitAndConfirm(
        owner,
        "Create the Zap + convert fee",
        () => wallet.writeContract(request),
      );
      if (status !== "success") throw new Error("Creation gateway transaction reverted.");

      const verified = await inspectOwnedZap(publicClient, predicted, owner);
      const nextZap: CreatedZapResult = {
        address: verified.address,
        routeId: verified.route.id,
        amountIn: verified.amountIn.toString(),
        createTx: hash,
        createdAt: new Date().toISOString(),
        policyHash: verified.policyHash,
      };
      rememberZap(owner, nextZap);
      rememberCreationWorkspace(owner, nextZap.address);
      setCreationResult(nextZap);
      selectZap(nextZap);
      setNotice(
        `Immutable Zap created at ${shortAddress(predicted)}. The ${formatToken(OPENZAP_CREATION_FEE, 18)} ETH creation fee converted atomically with the reviewed ${formatToken(creationFeeQuote.minZapsOut, 18)} 0xZAPS floor. Fund the Zap before execution.`,
      );
      trackEvent("robinhood_zap_created", {
        zap: predicted,
        route: route.id,
        fee: OPENZAP_CREATION_FEE.toString(),
      });
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
      // Wrapping is only meaningful when the route's input token is aeWETH; ETH
      // is 18 decimals so a plain 18-decimal parse is correct here.
      const exactAmount = parseRouterAmount(amount, 18);
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: ROBINHOOD_ASSETS.weth,
        abi: wethAbi,
        functionName: "deposit",
        value: exactAmount,
      });
      const { status } = await submitAndConfirm(owner, "Wrap ETH to aeWETH", () => wallet.writeContract(request));
      if (status !== "success") throw new Error("WETH deposit reverted.");
      setNotice(`Wrapped ${formatToken(exactAmount, 18)} ETH into aeWETH.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  /** Returns true when the zap is funded to its policy amount — so "Fund & run" can chain on it. */
  async function fundZap(): Promise<boolean> {
    setBusy("fund");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a Zap first.");
      requireProtocolReady(protocolReady);
      const verifiedZap = await inspectOwnedZap(publicClient, zap.address, owner);
      const tokenIn = verifiedZap.route.tokenIn;
      const current = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      const target = verifiedZap.amountIn;
      if (current >= target) {
        setNotice("Zap is already funded for this execution.");
        return true;
      }
      const missing = target - current;
      const balance = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      if (balance < missing) throw new Error(`Insufficient ${tokenIn.symbol}. ${formatToken(missing, tokenIn.decimals)} required.`);
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [verifiedZap.address, missing],
      });
      const { status } = await submitAndConfirm(
        owner,
        `Fund the Zap with ${tokenIn.symbol}`,
        () => wallet.writeContract(request),
      );
      if (status !== "success") throw new Error("Funding transfer reverted.");
      const verified = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      if (verified < target) throw new Error("Zap balance did not reach the policy amount after confirmation.");
      setNotice(`Zap funded with ${formatToken(target, tokenIn.decimals)} ${tokenIn.symbol}.`);
      return true;
    } catch (cause) {
      setError(readableError(cause));
      return false;
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  /**
   * Fund, then immediately use the zap — the funding step's own "and run it" path, so a funded zap
   * is never left sitting idle behind a second click. Chains only on a real funding success; the
   * execute leg re-verifies the balance and the reviewed quote on its own, exactly as a manual
   * Sign & execute would. `chainedRun` keeps both buttons disabled across the gap between the two
   * legs, where `busy` is momentarily null.
   */
  async function fundAndRun(): Promise<void> {
    setChainedRun(true);
    try {
      if (!(await fundZap())) return;
      await executeZap();
    } finally {
      setChainedRun(false);
    }
  }

  async function executeZap(): Promise<boolean> {
    setBusy("execute");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a Zap first.");
      requireProtocolReady(protocolReady);
      const verifiedZap = await inspectOwnedZap(publicClient, zap.address, owner);
      const zapRoute = verifiedZap.route;
      const tokenIn = zapRoute.tokenIn;
      const tokenOut = zapRoute.tokenOut;
      const liveInputBalance = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      if (liveInputBalance < verifiedZap.amountIn) throw new Error("Fund the Zap before execution.");

      // The signed minOut derives from a click-time re-quote (a swap pool quote,
      // or an ERC-4626 preview for a vault route); require a quote the user
      // explicitly reviewed, and abort when the market/preview has moved below
      // THAT floor — a silent auto-refresh must never lower the acknowledged
      // threshold.
      if (reviewedQuote === null) throw new Error("Request a live quote first to review the minimum output you are signing.");
      const reviewedFloor = (reviewedQuote * BigInt(10_000 - slippageBps)) / 10_000n;
      const freshQuote = (await quoteRoute(publicClient, zapRoute, verifiedZap.amountIn, owner)).amountOut;
      if (freshQuote < reviewedFloor) {
        setQuote(freshQuote);
        setQuoteGas(null);
        throw new Error("The live price moved below your reviewed minimum. Refresh the quote and review the new minimum before signing.");
      }
      const signedMinOut = (freshQuote * BigInt(10_000 - slippageBps)) / 10_000n;
      if (signedMinOut <= 0n) throw new Error("The live quote is too small for a safe minimum output.");
      setQuote(freshQuote);
      setQuoteGas(null);

      const now = unixNowSeconds();
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
        maxGas: BigInt(maxExecutionGas),
        maxFeePerGas: BigInt(maxFeePerGasGwei) * 1_000_000_000n,
        policyHash: verifiedZap.policyHash,
        outAsset: tokenOut.address,
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
        address: tokenOut.address,
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
        gas: BigInt(maxExecutionGas),
      });
      const { hash, status } = await submitAndConfirm(
        owner,
        `${tokenIn.symbol} → ${tokenOut.symbol} zap`,
        () => wallet.writeContract(request),
      );
      if (status !== "success") throw new Error("Zap execution reverted.");

      const [outputAfter, nonceUsed] = await Promise.all([
        publicClient.readContract({ address: tokenOut.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        publicClient.readContract({ address: verifiedZap.address, abi: openZapAbi, functionName: "nonceUsed", args: [nonce] }),
      ]);
      if (!nonceUsed || outputAfter <= outputBefore) throw new Error("Receipt confirmed but output or nonce verification failed.");
      const received = outputAfter - outputBefore;
      setExecutedZap(verifiedZap.address);
      setNotice(`Zap executed: received ${formatToken(received, tokenOut.decimals)} ${tokenOut.symbol}.`);
      // Success disables the still-focused execute button; hand focus to the
      // announcement instead of letting it fall to <body>.
      queueMicrotask(() => noticeRef.current?.focus());
      trackEvent("robinhood_zap_executed", { zap: verifiedZap.address, route: zapRoute.id, tx: hash });
      return true;
    } catch (cause) {
      setError(readableError(cause));
      return false;
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
      if (!zap) throw new Error("Create or load a Zap first.");
      const verifiedZap = await inspectOwnedZap(publicClient, zap.address, owner);
      const wallet = await requireWallet(owner);
      // Sweep the ZAP's OWN tracked assets — not a hardcoded [aeWETH, 0xZAPS],
      // which for a USDG/vault capsule would move assets it never held and
      // strand the real USDG/ozUSDG.
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: verifiedZap.address,
        abi: openZapAbi,
        functionName: "emergencyExit",
        args: [[...verifiedZap.route.trackedAssets]],
      });
      const { hash, status } = await submitAndConfirm(
        owner,
        "Emergency asset recovery",
        () => wallet.writeContract(request),
      );
      if (status !== "success") throw new Error("Recovery transaction reverted.");
      setNotice(
        `Tracked ${verifiedZap.route.tokenIn.symbol} and ${verifiedZap.route.tokenOut.symbol} balances returned to the zap owner.`,
      );
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
        routeId: verified.route.id,
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

  /** Funding is a plain transfer from any wallet, so the address is the whole
   *  instruction — and it is the one string on this screen nobody should retype. */
  async function copyZapAddress(): Promise<void> {
    if (!zap) return;
    clearMessages();
    try {
      await navigator.clipboard.writeText(zap.address);
      setNotice("Zap address copied.");
    } catch {
      setError("Clipboard access was unavailable. Copy the address from the Zap panel instead.");
    }
  }

  function exportCurrentZap(): void {
    if (!zap) return;
    // Export the zap's REAL adapter/route, not a hardcoded original one — a
    // USDG/vault config would otherwise name the wrong adapter.
    const exportedRoute = resolveRouteById(zap.routeId);
    const payload = JSON.stringify(
      {
        schema: "openzaps.robinhood.zap.v1",
        chainId: ROBINHOOD_CHAIN_ID,
        factory: OPENZAP_CONTRACTS.factory,
        routeId: zap.routeId,
        adapter: exportedRoute?.adapter ?? OPENZAP_CONTRACTS.adapter,
        tokenIn: exportedRoute?.tokenIn.address,
        tokenOut: exportedRoute?.tokenOut.address,
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
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function disconnect(): Promise<void> {
    clearMessages();
    await disconnectSession();
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
      ].slice(0, Math.max(current.length, receiptLimitFor(holderTierRef.current)));
      saveTransactions(owner, next);
      return next;
    });
  }

  function exportReceipts(): void {
    const owner = account;
    if (!owner || transactions.length === 0 || !canExportReceipts(holderTier)) return;
    const payload = JSON.stringify(
      {
        schema: "openzaps.robinhood.receipts.v1",
        chainId: ROBINHOOD_CHAIN_ID,
        account: owner,
        exportedAt: new Date().toISOString(),
        receipts: transactions,
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openzaps-receipts-${owner}.json`;
    anchor.click();
    // Safari aborts the download if the blob URL is revoked synchronously.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // These two and `startNewZap` below are memoised so the builder-import
  // effect can list them as dependencies honestly and still run exactly once.
  // They are the only route into direction/amount/zap state that keeps the
  // quote epoch in step.
  const changeRoute = useCallback((nextRouteId: string): void => {
    setRouteId(nextRouteId);
    resetQuoteState();
  }, [resetQuoteState]);

  const changeAmount = useCallback((nextAmount: string): void => {
    setAmount(nextAmount);
    resetQuoteState();
  }, [resetQuoteState]);

  function rememberZap(owner: Address, record: SavedZapRecord): void {
    setSavedZaps((current) => {
      // A tier downgrade caps future growth but must never destructively
      // prune existing records — they can point at funded capsules.
      const limit = Math.max(current.length, savedZapLimitFor(holderTierRef.current));
      const next = [record, ...current.filter((candidate) => candidate.address !== record.address)].slice(0, limit);
      saveZapList(owner, next);
      return next;
    });
  }

  const startNewZap = useCallback((): void => {
    if (account) clearCreationWorkspace(account);
    setCreationResult(null);
    setZap(null);
    setExecutedZap(null);
    resetQuoteState();
    setManualZap("");
    clearMessages();
  }, [account, clearMessages, resetQuoteState]);

  async function copyCreationResult(): Promise<void> {
    if (!creationResult) return;
    const resultRoute = resolveRouteById(creationResult.routeId);
    const summary = [
      "OpenZaps creation receipt",
      `Zap: ${creationResult.address}`,
      `Transaction: ${creationResult.createTx}`,
      `Policy: ${creationResult.policyHash}`,
      `Route: ${resultRoute ? `${resultRoute.tokenIn.symbol} -> ${resultRoute.tokenOut.symbol}` : creationResult.routeId}`,
      `Exact input: ${formatToken(BigInt(creationResult.amountIn), resultRoute?.tokenIn.decimals ?? 18)} ${resultRoute?.tokenIn.symbol ?? "tokens"}`,
      `Created: ${creationResult.createdAt}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(summary);
      setNotice("Creation receipt copied. The Zap address, transaction, policy, and route are included.");
    } catch {
      setError("The browser blocked clipboard access. Use the explorer links in the creation receipt instead.");
    }
  }

  /**
   * One-shot handoff from the Design view (and, via the /build and /app 308s,
   * from every pre-merge deploy link): ?view=sign&src=build&route=…&amount=….
   *
   * This fills in the same three controls a person would type and then stops.
   * It never creates, funds, or signs: a URL parameter is not consent for an
   * onchain write, and the whole point of the create step is that a human read
   * the numbers first.
   */
  useEffect(() => {
    if (builderImportRef.current !== null) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("src") !== "build") return;

    // The handoff carries `route` (a registry adapter id) as the route identity.
    // `dir` is kept only for backward-compat with older bounded-pair links that
    // carry no route id.
    const rawRoute = params.get("route");
    const rawDirection = params.get("dir");
    const rawAmount = (params.get("amount") ?? "").trim();
    const executionPolicy = readExecutionPolicyParams(params);
    const resolvedRouteId =
      rawRoute && resolveRouteById(rawRoute)
        ? rawRoute
        : rawDirection === "buy"
          ? BOUNDED_SWAP_IDS[0]
          : rawDirection === "sell"
            ? BOUNDED_SWAP_IDS[1]
            : null;
    const candidateRoute = resolvedRouteId ? resolveRouteById(resolvedRouteId) : null;

    // A vault-backed route cannot be judged against the pre-read offered set —
    // that set NEVER contains one, so a mount-time verdict would reject every
    // LP and vault handoff regardless of the vault's real seeded state. Leave
    // the one-shot ref unset and let the effect re-run once the seeding read
    // settles; everything else is decidable right now.
    if (candidateRoute?.requiresSeededVault && !offeredReady) return;
    builderImportRef.current = "rejected";

    // Fail closed: only import a route that is deployed AND currently offered.
    // A vault route is offered only while its vault is seeded; an unseeded or
    // undeployed route is rejected exactly like an invalid import.
    const offered = resolvedRouteId !== null && offeredRoutes.some((candidate) => candidate.id === resolvedRouteId);
    let imported: { routeId: string; route: Route; amount: string; bps: number; executionPolicy: ExecutionPolicy } | null = null;
    if (candidateRoute && offered && resolvedRouteId && executionPolicy) {
      try {
        // Validate the amount at the ROUTE's real decimals (USDG 6, ozUSDG 9).
        parseRouterAmount(rawAmount, candidateRoute.tokenIn.decimals);
        // A missing key reads as null and Number(null) is 0 — finite, so an
        // absent bps would snap to the 10 bps floor and quietly sign a 0.10%
        // cap. Anything that is not a real number has to reach the default.
        const parsedBps = Number(params.get("bps"));
        imported = {
          routeId: resolvedRouteId,
          route: candidateRoute,
          amount: rawAmount,
          // Snapped to the slider's own min/max/step below.
          // 100 is the same 1.00% the slider starts on when nobody touches it.
          bps: Number.isFinite(parsedBps) ? Math.min(500, Math.max(10, Math.round(parsedBps / 10) * 10)) : 100,
          executionPolicy,
        };
      } catch {
        imported = null;
      }
    }
    // Set synchronously: the saved-zap restore effect reads this marker to keep
    // itself from selecting an older capsule over the import.
    if (imported) builderImportRef.current = "applied";

    // Deferred out of the effect body: this page's lint rules treat a
    // synchronous setState in an effect as a hard error, and the rest of the
    // file already hands its post-mount work to a microtask for the same reason.
    queueMicrotask(() => {
      // Drop the handoff params so a refresh cannot replay the import over work
      // the user has since done by hand — but KEEP `view=sign`: the surface
      // derives the visible view from the query, and Next's patched
      // replaceState syncs useSearchParams, so stripping the whole query would
      // flip the page back to Design one microtask after the import landed and
      // unmount this console with everything it just applied. Deferred with the
      // rest: the App Router patches history.replaceState in an ancestor
      // effect, and React runs child passive effects first, so calling it in
      // this body would hit the raw API and wipe the router's history state.
      // The one-shot ref above is already set, so the replay guard is unaffected.
      window.history.replaceState(null, "", `${window.location.pathname}?view=sign${window.location.hash}`);
      if (!imported) {
        setError(
          "That builder link did not carry a deployed, offered route with a valid amount, so nothing was imported. A vault route needs a seeded vault. Set the route and amount here instead.",
        );
        return;
      }
      // Route, amount, and Create are all disabled while a zap is selected, so
      // the import has to start from a clean slate or it would land nowhere.
      startNewZap();
      changeRoute(imported.routeId);
      changeAmount(imported.amount);
      setSlippageBps(imported.bps);
      setMaxExecutionGas(imported.executionPolicy.maxGas);
      setMaxFeePerGasGwei(imported.executionPolicy.maxFeePerGasGwei);
      setNotice(
        `Imported from the builder: ${imported.route.tokenIn.symbol} → ${imported.route.tokenOut.symbol}, ${imported.amount} ${imported.route.tokenIn.symbol}, ${(imported.bps / 100).toFixed(2)}% max slippage, ${imported.executionPolicy.maxGas.toLocaleString("en-US")} gas, and ${imported.executionPolicy.maxFeePerGasGwei} gwei. Nothing has been created — check the numbers, then press Create zap.`,
      );
      trackEvent("robinhood_builder_import", { route: imported.routeId });
    });
  }, [changeAmount, changeRoute, startNewZap, offeredRoutes, offeredReady]);

  const wrongNetwork = account !== null && walletChainId !== ROBINHOOD_CHAIN_ID;
  const creationResultRoute = creationResult ? resolveRouteById(creationResult.routeId) : null;
  const creationResultActive = creationResult !== null && zap?.address === creationResult.address;
  const creationResultFunded = creationResultActive && funded;
  const creationResultExecuted = creationResultActive && executionComplete;
  /**
   * The four steps of getting a Zap onchain, as state rather than as a label.
   *
   * "Switch network" is not a fifth step: it is step 1 unfinished. Folding it
   * in here is what keeps the wrong-chain case from being a screen where every
   * button is disabled and nothing says why — the step expands with the
   * warning and the switch button in it.
   */
  const stepIndex = !account || wrongNetwork ? 1 : !zap ? 2 : !funded ? 3 : 4;
  const stepDone: readonly boolean[] = [
    account !== null && !wrongNetwork,
    zap !== null,
    funded,
    executionComplete,
  ];
  const stepStateFor = (step: number): StepState =>
    executionComplete || stepDone[step - 1] ? "done" : step === stepIndex ? "current" : "future";

  // Fail-closed rail: a row only exists when there is something real to check.
  // "Zap balance" appears with the Zap, never as a pre-emptive zero.
  const verifications: readonly VerifyCheck[] = [
    {
      label: "Factory health",
      value: protocolReady ? "RPC reads ready" : protocolHealth,
      href: configured ? explorerAddress(OPENZAP_CONTRACTS.factory) : undefined,
      ok: protocolReady,
    },
    {
      label: "Pool-bound adapter",
      value: route ? shortAddress(route.adapter) : "—",
      href: route ? explorerAddress(route.adapter) : undefined,
      ok: route !== null,
    },
    { label: "Settles through", value: settlementLabel, ok: route !== null },
    { label: "Router allowance", value: "Cleared after every call", ok: true },
    { label: "Permit2 allowance", value: "Cleared after every swap", ok: true },
    { label: "Output protection", value: "Signed minOut in OpenZap", ok: true },
    ...(zap
      ? [{
          label: "Zap balance",
          // A drained balance is the expected end state, not a failure — the
          // row only reads red while funding is still owed.
          value: executionComplete
            ? `${formatToken(zapInBalance, inDecimals)} ${inputSymbol} — input spent`
            : `${formatToken(zapInBalance, inDecimals)} ${inputSymbol} — ${funded ? "funded" : "not funded"}`,
          ok: funded || executionComplete,
        }]
      : []),
  ];
  const passCount = verifications.filter((check) => check.ok).length;
  const allChecksPass = passCount === verifications.length;

  // A frozen policy has nothing to pick, so the disclosure closes with it.
  const routeVisible = routeOpen && zap === null;
  const slippagePresets = [50, 100, 200] as const;
  const customSlippage = !slippagePresets.includes(slippageBps as 50 | 100 | 200);

  return (
    <main className={styles.screen} id="main" data-screen-label="Zap now">
      <section className={styles.statusBar} aria-label="Protocol status">
        <span className={protocolReady ? styles.statusLive : styles.statusPreview} role="status">
          {protocolHealth === "checking" ? "Checking contracts" : protocolReady ? "Live" : "Transactions paused"}
        </span>
        <p>
          {protocolReady ? (
            <>
              Pool-bound {routePairLabel} creation is open through factory{" "}
              <a href={explorerAddress(OPENZAP_CONTRACTS.factory)} target="_blank" rel="noreferrer">
                {shortAddress(OPENZAP_CONTRACTS.factory)}
              </a>
              . Depositing funds can result in total loss.
            </>
          ) : (
            <>Contract health is unavailable or configuration is incomplete. Creation, funding, and execution are disabled.</>
          )}
        </p>
      </section>

      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Zap now</h1>
          <p className={styles.lede}>
            Create an immutable Zap, fund only its exact input, sign the output floor, and execute. A Zap cannot do
            anything it was not signed to do.
          </p>
        </div>
        <div className={styles.headAside}>
          <span className={styles.lineageChip}>v1.1 · one-time nonce</span>
          {holderTier !== "none" && <span className={styles.holderChip}>{tierLabel(holderTier)}</span>}
          {account && (
            <>
              <a className={styles.addr} href={explorerAddress(account)} target="_blank" rel="noreferrer">
                {shortAddress(account)}
              </a>
              <button className={styles.headGhost} onClick={() => void disconnect()} type="button">Disconnect</button>
            </>
          )}
        </div>
      </div>

      {/* The link is conditional on the notice so the live region still
          collapses to nothing (`.notice:empty`) when there is no message. */}
      <div className={styles.notice} ref={noticeRef} role="status" tabIndex={-1}>
        {notice}
        {notice && zap ? (
          <>
            {" "}
            {/* Global `a` inherits its colour, so the underline is what separates
                the link from the notice text it sits inside. */}
            <Link href={`/explore/${zap.address}`} style={{ textDecoration: "underline" }}>
              Open this Zap&apos;s onchain page →
            </Link>
          </>
        ) : null}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <BlockGlyph name="alert" className={styles.bannerGlyph} />
          {error}
        </div>
      )}

      {creationResult ? (
        <CreationWorkspace
          eyebrow="Creation receipt · v1.1"
          title="Your immutable Zap is live."
          detail="The gateway transaction confirmed, the Zap's owner and bytecode were verified through Robinhood RPC, and the reviewed creation-fee floor settled atomically. Funding and execution are separate wallet-confirmed steps."
          facts={[
            {
              label: "Zap",
              value: shortAddress(creationResult.address),
              href: explorerAddress(creationResult.address),
              mono: true,
            },
            {
              label: "Creation transaction",
              value: shortHash(creationResult.createTx),
              href: explorerTransaction(creationResult.createTx),
              mono: true,
            },
            {
              label: "Policy hash",
              value: shortHash(creationResult.policyHash),
              mono: true,
            },
            {
              label: "Bounded route",
              value: creationResultRoute
                ? `${creationResultRoute.tokenIn.symbol} → ${creationResultRoute.tokenOut.symbol}`
                : creationResult.routeId,
            },
            {
              label: "Exact input",
              value: `${formatToken(BigInt(creationResult.amountIn), creationResultRoute?.tokenIn.decimals ?? 18)} ${creationResultRoute?.tokenIn.symbol ?? "tokens"}`,
            },
            {
              label: "Created",
              value: formatReceiptTime(creationResult.createdAt),
            },
          ]}
          stages={[
            {
              label: "Created",
              detail: "Confirmed and bytecode-verified.",
              status: "done",
            },
            {
              label: "Fund",
              detail: creationResultFunded
                ? "Exact input is held by the Zap."
                : creationResultActive
                  ? "Transfer only the route's exact input."
                  : "Re-open this Zap to continue.",
              status: creationResultFunded ? "done" : creationResultActive ? "current" : "pending",
            },
            {
              label: "Execute",
              detail: creationResultExecuted
                ? "Signed execution confirmed."
                : creationResultFunded
                  ? "Review the quote, then sign once."
                  : "Available after funding.",
              status: creationResultExecuted ? "done" : creationResultFunded ? "current" : "pending",
            },
          ]}
        >
          {!creationResultActive ? (
            <button className="btn btnPrimary" disabled={busy !== null} onClick={() => selectZap(creationResult)} type="button">
              Open in console
            </button>
          ) : !creationResultExecuted ? (
            <a className="btn btnPrimary" href="#zap-lifecycle">
              {creationResultFunded ? "Continue to execution" : "Continue to funding"}
            </a>
          ) : null}
          <Link className="btn btnGhost" href={`/explore/${creationResult.address}`}>Onchain page</Link>
          <Link className="btn btnGhost" href="/profile">View profile</Link>
          <button className="btn btnGhost" onClick={() => void copyCreationResult()} type="button">Copy receipt</button>
          <button className={creationResultExecuted ? "btn btnPrimary" : "btn btnGhost"} disabled={busy !== null || chainedRun} onClick={startNewZap} type="button">
            Create another
          </button>
        </CreationWorkspace>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.col}>
          <section className={`${styles.card} ${styles.signingCard}`} aria-label="Build a live zap">
            <div className={styles.cardBar}>
              <h2 className={styles.cardTitle}>What you are signing</h2>
              <span className={styles.cardNote}>— frozen at creation, enforced by the Zap</span>
              <button
                className={`${styles.cardAction} ${styles.cardActionEnd}`}
                disabled={zap !== null}
                onClick={() => setRouteOpen(!routeVisible)}
                title={zap !== null ? "Route is frozen once the Zap exists" : undefined}
                type="button"
              >
                {routeVisible ? "Hide routes" : "Change route"}
              </button>
              <button
                data-busy={busy === "quote"}
                className={styles.cardAction}
                data-testid="quote-button"
                disabled={busy !== null || amountIn <= 0n}
                onClick={() => void requestQuote()}
                type="button"
              >
                {busy === "quote" ? "Quoting…" : quote === null ? "Get live quote" : "Refresh quote"}
              </button>
            </div>

            {routeVisible && (
              <div className={styles.routeOptions}>
                {offeredRoutes.map((offered) => (
                  <button
                    key={offered.id}
                    className={routeId === offered.id ? styles.routeOptionOn : styles.routeOption}
                    onClick={() => changeRoute(offered.id)}
                    disabled={zap !== null}
                    type="button"
                  >
                    {offered.tokenIn.symbol} → {offered.tokenOut.symbol}
                    <em>
                      <ProtocolStack protocols={protocolsForRouteKind(offered.kind)} size={12} />{" "}
                      {ROUTE_KIND_LABEL[offered.kind]}
                    </em>
                  </button>
                ))}
              </div>
            )}

            <div className={styles.route}>
              <div className={styles.leg}>
                <span className={styles.legLabel}>YOU SEND — EXACTLY</span>
                <div className={styles.amountRow}>
                  <input
                    className={styles.amountInput}
                    inputMode="decimal"
                    aria-label={`Exact input in ${inputSymbol}`}
                    value={amount}
                    onChange={(event) => changeAmount(sanitizeDecimal(event.target.value))}
                    disabled={zap !== null}
                  />
                  <span className={styles.tokenTag}>
                    <i className={styles.tokenDot} aria-hidden="true" />
                    {inputSymbol}
                  </span>
                </div>
                {/* Gated on a connected account. `walletInBalance` initialises
                    to 0n, so ungated this reads "Wallet holds 0 aeWETH" to
                    someone who has not connected — a statement about a balance
                    nothing has read. The same reason the rest of this console
                    prints "—" rather than a zero. */}
                <span className={styles.legHint}>
                  {account
                    ? `Wallet holds ${formatToken(walletInputBalance, inDecimals)} ${inputSymbol}`
                    : `Connect a wallet to see your ${inputSymbol} balance`}
                </span>
              </div>

              <div className={styles.arrow} aria-hidden="true">
                <BlockGlyph name="boltFill" className={styles.arrowGlyph} />
              </div>

              <div className={styles.leg}>
                <span className={styles.legLabel}>YOU RECEIVE — AT LEAST</span>
                <div className={styles.floorRow}>
                  {/* An em dash, never a zero. A zero here would be a price
                      claim nothing has read. */}
                  <strong className={minOut === null ? `${styles.floor} ${styles.floorPending}` : styles.floor}>
                    {minOut === null ? "—" : formatToken(minOut, outDecimals)}
                  </strong>
                  <span className={styles.floorSymbol}>{outputSymbol}</span>
                </div>
                <span className={styles.legHintLive}>
                  {quote === null
                    ? "Request a live quote to see the floor you would sign."
                    : `${route?.kind === "swap" ? "Quote" : "Vault preview"} ${formatToken(quote, outDecimals)} · floor is what the Zap enforces`}
                </span>
                {autoRefreshedAt && (
                  <span className={styles.legHint}>
                    Auto-updated {autoRefreshedAt} — your signed floor stays at the quote you last requested.
                  </span>
                )}
              </div>
            </div>

            <div className={styles.bounds}>
              <span className={styles.boundsLabel} id="slippage-label">Slippage you sign</span>
              <div className={styles.segTrack} role="group" aria-labelledby="slippage-label">
                {slippagePresets.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={slippageBps === preset}
                    className={slippageBps === preset ? styles.segOptionOn : styles.segOption}
                    onClick={() => setSlippageBps(preset)}
                  >
                    {(preset / 100).toFixed(2)}%
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={customSlippage}
                  aria-expanded={advancedOpen}
                  className={customSlippage ? styles.segOptionOn : styles.segOption}
                  onClick={() => setAdvancedOpen(true)}
                >
                  {customSlippage ? `${(slippageBps / 100).toFixed(2)}%` : "Custom…"}
                </button>
              </div>
              <span className={styles.boundsHint}>Tighter is safer, but more Zaps revert.</span>
              <span className={styles.pillRow}>
                {/* The real signed bounds, not a design mock: these are the two
                    values the EIP-712 intent actually caps. */}
                <button className={styles.pillButton} onClick={() => setAdvancedOpen(true)} type="button">
                  ≤{maxExecutionGas.toLocaleString("en-US")} gas
                </button>
                <button className={styles.pillButton} onClick={() => setAdvancedOpen(true)} type="button">
                  ≤{maxFeePerGasGwei} gwei
                </button>
                <span className={styles.pill}>owner-signed</span>
                {quoteGas !== null && (
                  <span className={styles.pill}>quoter {quoteGas.toLocaleString("en-US")} gas</span>
                )}
              </span>
            </div>

            {advancedOpen && (
              <div className={styles.advanced}>
                <div className={styles.advField}>
                  <label className={styles.advLabel} htmlFor="slippage-range">
                    Signed max slippage ({(slippageBps / 100).toFixed(2)}%)
                  </label>
                  <input
                    id="slippage-range"
                    className={styles.range}
                    min="10"
                    max="500"
                    step="10"
                    type="range"
                    value={slippageBps}
                    onChange={(event) => setSlippageBps(Number(event.target.value))}
                  />
                </div>
                <div className={styles.advField}>
                  <label className={styles.advLabel} htmlFor="gas-range">
                    Signed gas limit ({maxExecutionGas.toLocaleString("en-US")})
                  </label>
                  <input
                    id="gas-range"
                    className={styles.range}
                    type="range"
                    min={MIN_EXECUTION_GAS_UNITS}
                    max={MAX_EXECUTION_GAS_UNITS}
                    step={50_000}
                    value={maxExecutionGas}
                    onChange={(event) => setMaxExecutionGas(Number(event.target.value))}
                    disabled={busy !== null}
                  />
                </div>
                <div className={styles.advField}>
                  <label className={styles.advLabel} htmlFor="fee-range">
                    Signed gas price cap ({maxFeePerGasGwei} gwei)
                  </label>
                  <input
                    id="fee-range"
                    className={styles.range}
                    type="range"
                    min={MIN_EXECUTION_FEE_GWEI}
                    max={MAX_EXECUTION_FEE_GWEI}
                    step={1}
                    value={maxFeePerGasGwei}
                    onChange={(event) => setMaxFeePerGasGwei(Number(event.target.value))}
                    disabled={busy !== null}
                  />
                </div>
              </div>
            )}
          </section>

          <section className={`${styles.card} ${styles.stepsCard}`} id="zap-lifecycle" aria-label="Getting it onchain">
            <div className={styles.cardBar}>
              <h2 className={styles.cardTitle}>Getting it onchain</h2>
              <span className={styles.progress}>
                {[1, 2, 3, 4].map((step) => {
                  const state = stepStateFor(step);
                  return (
                    <i
                      key={step}
                      aria-hidden="true"
                      className={`${styles.pip} ${state === "done" ? styles.pipDone : state === "current" ? styles.pipCurrent : styles.pipPending}`}
                    />
                  );
                })}
                <span className={styles.progressCount}>
                  {executionComplete ? "Zap confirmed" : `step ${stepIndex} of 4`}
                </span>
              </span>
            </div>

            <Step
              index={1}
              state={stepStateFor(1)}
              title={stepStateFor(1) === "done" ? "Wallet connected" : "Connect wallet"}
              detail={
                account && !wrongNetwork
                  ? `${shortAddress(account)} · chain ${ROBINHOOD_CHAIN_ID}`
                  : "The wallet that connects here is the owner the policy is bound to."
              }
            >
              {wrongNetwork ? (
                <>
                  <p className={styles.stepBody}>
                    This wallet is on chain {walletChainId ?? "unknown"}. Every OpenZap contract lives on Robinhood
                    Chain {ROBINHOOD_CHAIN_ID}, so creation, funding and execution all stay disabled until you switch.
                  </p>
                  <div className={styles.stepActions}>
                    <button
                      data-busy={busy === "connect"}
                      className="btn btnPrimary"
                      disabled={busy !== null}
                      onClick={() => void switchWalletNetwork()}
                      type="button"
                    >
                      {busy === "connect" ? "Switching…" : "Switch network"}
                    </button>
                    <span className={styles.actionNote}>≈ 1 wallet confirmation</span>
                  </div>
                </>
              ) : (
                <>
                  <p className={styles.stepBody}>
                    Connecting only reads addresses and balances. Nothing is created, approved or signed by it.
                  </p>
                  <div className={styles.stepActions}>
                    <button
                      data-busy={busy === "connect"}
                      className="btn btnPrimary"
                      disabled={busy !== null}
                      onClick={() => void connectWallet()}
                      type="button"
                    >
                      {busy === "connect" ? "Connecting…" : "Connect wallet"}
                    </button>
                  </div>
                </>
              )}
            </Step>

            <Step
              index={2}
              state={stepStateFor(2)}
              title={zap ? "Zap created" : "Create the Zap"}
              detail={
                zap
                  ? `${shortAddress(zap.address)} · fee ${formatToken(OPENZAP_CREATION_FEE, 18)} ETH paid`
                  : "The factory deploys one contract with the policy above frozen into it."
              }
              link={
                zap?.createTx ? (
                  <a
                    className={styles.cardLinkSm}
                    href={explorerTransaction(zap.createTx)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Creation tx ↗
                  </a>
                ) : undefined
              }
            >
              <p className={styles.stepBody}>
                The policy binds owner, recipient, adapter, spender, input token, and exact amount. The separate fee
                converts only if creation succeeds; any conversion-floor failure reverts the whole transaction.
              </p>

              <div className={styles.creationFeeBox} data-ready={creationFeeQuote !== null} role="note">
                <div>
                  <span>App creation fee</span>
                  <strong>{formatToken(OPENZAP_CREATION_FEE, 18)} ETH</strong>
                </div>
                <div>
                  <span>Atomic 0xZAPS conversion</span>
                  <strong>
                    {creationFeeQuote
                      ? `est. ${formatToken(creationFeeQuote.amountOut, 18)} · min ${formatToken(creationFeeQuote.minZapsOut, 18)} 0xZAPS`
                      : creationFeeError || "Reading the pinned aeWETH → 0xZAPS route…"}
                  </strong>
                  {feeConfigured ? (
                    <small>
                      <a href={explorerAddress(OPENZAP_CREATION_FEE_CONTRACTS.gateway)} rel="noreferrer" target="_blank">
                        Fee gateway
                      </a>
                      {" · "}
                      <a href={explorerAddress(OPENZAP_CREATION_FEE_CONTRACTS.pot)} rel="noreferrer" target="_blank">
                        0xZAPS pot
                      </a>
                    </small>
                  ) : null}
                </div>
                {creationFeeError ? (
                  <button className="btn btnGhost" type="button" onClick={() => void refreshCreationFeeQuote()}>
                    Retry fee quote
                  </button>
                ) : null}
              </div>

              <div className={styles.stepActions}>
                <button
                  data-busy={busy === "create"}
                  className="btn btnPrimary"
                  data-testid="create-zap"
                  disabled={!account || !protocolReady || !feeConfigured || creationFeeQuote === null || wrongNetwork || zap !== null || busy !== null || chainedRun || amountIn <= 0n}
                  onClick={() => void createZap()}
                  type="button"
                >
                  {busy === "create" ? "Creating…" : "Create the Zap"}
                </button>
                <span className={styles.actionNote}>≈ 1 wallet confirmation</span>
              </div>
            </Step>

            <Step
              index={3}
              state={stepStateFor(3)}
              title={funded || executionComplete ? "Zap funded" : "Fund the Zap"}
              detail={
                // After a confirmed execution the input is gone, so reading the
                // live balance back would print "0 aeWETH held" under a tick.
                executionComplete
                  ? `${formatToken(requiredAmount, inDecimals)} ${inputSymbol} spent by the execution`
                  : funded
                    ? `${formatToken(zapInBalance, inDecimals)} ${inputSymbol} held by the Zap`
                    : "Direct ERC-20 transfer only. No standing wallet allowance is created."
              }
            >
              <p className={styles.stepBody}>
                Send exactly <strong>{formatToken(requiredAmount, inDecimals)} {inputSymbol}</strong> to the Zap. It can
                only spend that input on the route above — nothing else, no approvals to widen. With a reviewed quote in
                hand, Fund &amp; Zap does the transfer and the signed execution back to back, so a funded Zap never sits
                idle.
              </p>
              <div className={styles.stepActions}>
                {canWrapInput && (
                  <button
                    data-busy={busy === "wrap"}
                    className="btn btnGhost"
                    disabled={!account || wrongNetwork || busy !== null || chainedRun || amountIn <= 0n || nativeBalance < amountIn}
                    onClick={() => void wrapEth()}
                    type="button"
                  >
                    {busy === "wrap" ? "Wrapping…" : "Wrap ETH"}
                  </button>
                )}
                <button
                  data-busy={chainedRun}
                  className="btn btnPrimary"
                  data-testid="fund-and-run"
                  disabled={!zap || !protocolReady || wrongNetwork || funded || busy !== null || chainedRun || reviewedQuote === null || executionComplete}
                  onClick={() => void fundAndRun()}
                  type="button"
                  title={reviewedQuote === null ? "Request a live quote first — Zapping signs against the minimum you reviewed." : undefined}
                >
                  <BlockGlyph name="bolt" className={styles.btnGlyph} />
                  {chainedRun ? (busy === "execute" ? "Zapping…" : "Funding…") : "Fund & Zap"}
                </button>
                <button
                  data-busy={busy === "fund"}
                  className="btn btnGhost"
                  disabled={!zap || !protocolReady || wrongNetwork || funded || busy !== null || chainedRun}
                  onClick={() => void fundZap()}
                  type="button"
                >
                  {busy === "fund" && !chainedRun ? "Funding…" : "Fund only"}
                </button>
                <button className="btn btnGhost" disabled={!zap} onClick={() => void copyZapAddress()} type="button">
                  Copy Zap address
                </button>
                <span className={styles.actionNote}>≈ 1 wallet confirmation</span>
              </div>
            </Step>

            <Step
              index={4}
              state={stepStateFor(4)}
              title={executionComplete ? "Zap confirmed" : "Sign the floor and Zap"}
              detail={
                executionComplete
                  ? "signed, submitted, and receipt-verified"
                  : "EIP-712 over the reviewed minimum output, then anyone can submit it."
              }
            >
              <p className={styles.stepBody}>
                EIP-712 over the reviewed minimum output, then anyone can submit it. The Zap reverts if the price drops
                below your displayed minimum; the intent expires in ten minutes and caps gas and fee price.
              </p>
              <div className={styles.stepActions}>
                <button
                  data-busy={busy === "execute"}
                  className="btn btnPrimary"
                  disabled={!protocolReady || wrongNetwork || !funded || reviewedQuote === null || busy !== null || chainedRun || executionComplete}
                  onClick={() => void executeZap()}
                  type="button"
                >
                  {busy === "execute" ? "Zapping…" : executionComplete ? "Zap confirmed" : "Sign & Zap"}
                </button>
                <span className={styles.actionNote}>≈ 1 wallet signature + 1 confirmation</span>
              </div>
            </Step>
          </section>

          <section className={`${styles.card} ${styles.logCard}`} aria-label="This Zap's log">
            <div className={styles.cardBar}>
              <h2 className={styles.cardTitle}>This Zap&apos;s log</h2>
              {zap && (
                <Link className={styles.cardLink} href={`/explore/${zap.address}`}>
                  Open in Explore ↗
                </Link>
              )}
            </div>

            {zap === null ? (
              <p className={styles.logEmpty}>
                No Zap loaded — create one above, or open an existing Zap from the rail.
              </p>
            ) : (
              <>
                <div className={styles.logRow}>
                  <span className={styles.logChipOk}>created</span>
                  <span className={styles.logText}>
                    Policy frozen behind hash <code>{shortHash(zap.policyHash)}</code>
                  </span>
                  <code className={styles.logMeta}>{formatReceiptTime(zap.createdAt)}</code>
                  {zap.createTx ? (
                    <a
                      className={styles.logLink}
                      href={explorerTransaction(zap.createTx)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      tx ↗
                    </a>
                  ) : (
                    <span />
                  )}
                </div>

                {/* The chip states are the three real ones. "waiting" after a
                    confirmed execution would be a lie about a spent Zap. */}
                <div className={styles.logRow}>
                  <span className={executionComplete ? styles.logChipNeutral : funded ? styles.logChipOk : styles.logChipWarn}>
                    {executionComplete ? "spent" : funded ? "funded" : "waiting"}
                  </span>
                  <span className={styles.logText}>
                    Zap balance {formatToken(zapInBalance, inDecimals)} {inputSymbol}
                    {executionComplete
                      ? " — the input was spent by the confirmed execution"
                      : funded
                        ? " — exact input held"
                        : " — nothing can execute until it is funded"}
                  </span>
                  <code className={styles.logMeta}>read just now</code>
                  <span />
                </div>

                {zapHistory === "loading" && <p className={styles.logEmpty}>Reading Zap logs…</p>}
                {zapHistory === "unavailable" && (
                  <div className={styles.logRow}>
                    <span className={styles.logChipDanger}>unavailable</span>
                    <span className={styles.logText}>History unavailable — the RPC log query failed.</span>
                    <span />
                    <span />
                  </div>
                )}
                {Array.isArray(zapHistory) && zapHistory.length === 0 && (
                  <p className={styles.logEmpty}>No executions or recoveries yet.</p>
                )}
                {Array.isArray(zapHistory) &&
                  zapHistory.map((entry) => (
                    <div className={styles.logRow} key={`${entry.txHash}:${entry.label}:${entry.assetSymbol}`}>
                      <span className={entry.label === "Executed" ? styles.logChipOk : styles.logChipNeutral}>
                        {entry.label.toLowerCase()}
                      </span>
                      <span className={styles.logText}>
                        {formatToken(entry.amount, entry.assetDecimals)} {entry.assetSymbol}
                      </span>
                      <span />
                      <a
                        className={styles.logLink}
                        href={explorerTransaction(entry.txHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        tx ↗
                      </a>
                    </div>
                  ))}
              </>
            )}
          </section>
        </div>

        <div className={styles.col}>
          <section className={`${styles.card} ${styles.verifyCard}`} aria-label="Live verification">
            <div className={`${styles.cardBar} ${styles.cardBarTight}`}>
              <h2 className={styles.cardTitle}>Verification</h2>
              <span className={allChecksPass ? styles.verifyCount : styles.verifyCountFail}>
                {passCount} of {verifications.length} pass
              </span>
            </div>
            <div className={styles.verifyList}>
              {verifications.map((check) => (
                <VerifyRow key={check.label} {...check} />
              ))}
            </div>
          </section>

          <section className={`${styles.card} ${styles.factsCard}`} aria-label="Zap facts">
            <div className={`${styles.cardBar} ${styles.cardBarTight}`}>
              <h2 className={styles.cardTitle}>Zap</h2>
            </div>
            {zap === null ? (
              <p className={styles.logEmpty}>No Zap loaded.</p>
            ) : (
              <>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Address</span>
                  <a className={styles.factValue} href={explorerAddress(zap.address)} target="_blank" rel="noreferrer">
                    {shortAddress(zap.address)} ↗
                  </a>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Policy hash</span>
                  <code className={styles.factValue}>{shortHash(zap.policyHash)}</code>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Lineage</span>
                  <code className={styles.factValue}>v1.1 · one-shot nonce</code>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Venue</span>
                  <span className={styles.factValue}>{venueLabel}</span>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Owner withdraw</span>
                  <span className={styles.factOk}>always available</span>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Required</span>
                  <code className={styles.factValue}>{formatToken(requiredAmount, inDecimals)} {inputSymbol}</code>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Zap {inputSymbol}</span>
                  <code className={styles.factValue}>{formatToken(zapInBalance, inDecimals)} {inputSymbol}</code>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Zap {outputSymbol}</span>
                  <code className={styles.factValue}>{formatToken(zapOutBalance, outDecimals)} {outputSymbol}</code>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Zap native</span>
                  <code className={styles.factValue}>{formatToken(zapNativeBalance, 18)} ETH</code>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Wallet output</span>
                  <code className={styles.factValue}>{formatToken(walletOutputBalance, outDecimals)} {outputSymbol}</code>
                </div>
                <div className={styles.railActions}>
                  <Link className={styles.ghostFull} href={`/explore/${zap.address}`}>
                    Onchain Zap page →
                  </Link>
                  <button className={styles.ghostFull} disabled={busy !== null} onClick={exportCurrentZap} type="button">
                    Export public config
                  </button>
                  <button
                    data-busy={busy === "recover"}
                    className={styles.ghostFull}
                    disabled={wrongNetwork || busy !== null || recoverableBalance === 0n}
                    onClick={() => void recoverFunds()}
                    type="button"
                  >
                    {busy === "recover" ? "Recovering…" : "Emergency recover"}
                  </button>
                </div>
              </>
            )}
          </section>

          <section className={`${styles.card} ${styles.zapsCard}`}>
            <div className={`${styles.cardBar} ${styles.cardBarTight}`}>
              <h2 className={styles.cardTitle}>Your Zaps</h2>
            </div>
            {savedZaps.length > 0 ? (
              <div aria-label="Verified zap history" className={styles.zapList} role="group">
                {savedZaps.map((record) => {
                  const active = zap?.address === record.address;
                  const recordRoute = resolveRouteById(record.routeId);
                  const recordLabel = recordRoute
                    ? `${recordRoute.tokenIn.symbol} → ${recordRoute.tokenOut.symbol}`
                    : "Unknown route";
                  return (
                    // Two controls, not one: selecting a Zap for this console and
                    // opening its public page are different intents, and a link
                    // cannot live inside the button.
                    <div className={styles.zapRow} key={record.address}>
                      <button
                        aria-pressed={active}
                        className={active ? styles.zapItemOn : styles.zapItem}
                        disabled={busy !== null}
                        onClick={() => selectZap(record)}
                        type="button"
                      >
                        <strong className={styles.zapItemName}>{active ? "✓ " : ""}{recordLabel}</strong>
                        <code className={styles.zapItemMeta}>{shortAddress(record.address)}</code>
                      </button>
                      <Link
                        aria-label={`Open the onchain page for zap ${record.address}`}
                        className={styles.zapItemLink}
                        href={`/explore/${record.address}`}
                      >
                        ↗
                      </Link>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={styles.logEmpty}>No verified Zaps saved in this browser yet.</p>
            )}

            <div className={styles.loadRow}>
              <label className={styles.loadLabel} htmlFor="load-zap">
                Resume or recover an owned canonical Zap
              </label>
              <input
                id="load-zap"
                className={styles.loadInput}
                placeholder="0x…"
                value={manualZap}
                onChange={(event) => setManualZap(event.target.value)}
              />
              <button
                data-busy={busy === "load"}
                className={styles.ghostFull}
                disabled={!account || !protocolReady || busy !== null || manualZap.length !== 42}
                onClick={() => void loadExistingZap()}
                type="button"
              >
                {busy === "load" ? "Loading…" : "Load verified zap"}
              </button>
            </div>
          </section>

          <section className={`${styles.sunkCard} ${styles.reuseCard}`}>
            <h2 className={styles.sunkTitle}>Do it again, later</h2>
            <p className={styles.sunkNote}>Everything above is a design you can keep. Reuse it without rebuilding.</p>
            <div className={styles.reuseList}>
              <button
                className={styles.reuseRow}
                disabled={busy !== null || chainedRun}
                onClick={startNewZap}
                type="button"
              >
                <BlockGlyph name="copy" className={styles.reuseGlyph} />
                Duplicate as a new Zap
              </button>
              {/* Labelled for what it is. There is no template store behind
                  this — it is the same public-config JSON download. */}
              <button className={styles.reuseRow} disabled={!zap} onClick={exportCurrentZap} type="button">
                <BlockGlyph name="download" className={styles.reuseGlyph} />
                Save this design (JSON)
              </button>
              <Link
                className={styles.reuseRow}
                href={`/zap?view=automate&route=${routeId}&amount=${amount}&bps=${slippageBps}`}
              >
                <BlockGlyph name="repeat" className={styles.reuseGlyph} />
                Make this recurring
              </Link>
            </div>
          </section>

          <section className={`${styles.sunkCard} ${styles.holderCard}`} aria-label="Holder conveniences">
            <h2 className={styles.sunkTitle}>Holder conveniences</h2>
            <p className={styles.sunkNote}>
              {!account
                ? "Holding 100,000+ 0xZAPS turns on app conveniences: auto-refreshing quotes, more saved zaps and receipts, and receipt JSON export."
                : holderTier === "none"
                  ? "Hold 100,000+ 0xZAPS in this wallet to turn on auto-refreshing quotes, more saved zaps and receipts, and receipt JSON export."
                  : `${tierLabel(holderTier)} conveniences active: auto-refreshing quotes, more saved zaps and receipts, and receipt JSON export.`}
              {" "}
              <Link href="/token#utilities">Details →</Link>
            </p>
          </section>
        </div>
      </div>

      <section id="receipts" className={styles.receipts} aria-label="Transaction receipts">
        <div className={styles.receiptHead}>
          <h2 className={styles.receiptsTitle}>Receipts</h2>
          <div className={styles.receiptLinks}>
            <button
              className="btn btnGhost"
              disabled={!canExportReceipts(holderTier) || transactions.length === 0}
              onClick={exportReceipts}
              title={canExportReceipts(holderTier) ? undefined : "Needs 100,000+ 0xZAPS in the connected wallet"}
              type="button"
            >
              Export receipts (JSON)
            </button>
            <Link href="/explore">Protocol-wide activity →</Link>
            <a href={ROBINHOOD_EXPLORER_URL} target="_blank" rel="noreferrer">Open Robinhood Blockscout ↗</a>
          </div>
        </div>
        <TransactionLifecycle activity={transactionLifecycle} />
        {transactions.length === 0 ? (
          <p className={styles.empty}>Transactions appear here only after Robinhood RPC returns a receipt.</p>
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

function creationWorkspaceKey(owner: Address): string {
  return `${CREATION_WORKSPACE_KEY}:${owner.toLowerCase()}`;
}

function rememberCreationWorkspace(owner: Address, zap: Address): void {
  try {
    window.sessionStorage.setItem(creationWorkspaceKey(owner), zap);
  } catch {
    // The in-memory receipt still survives until this route unmounts.
  }
}

function readCreationWorkspace(owner: Address): Address | null {
  try {
    const value = window.sessionStorage.getItem(creationWorkspaceKey(owner));
    return value ? getAddress(value) : null;
  } catch {
    return null;
  }
}

function clearCreationWorkspace(owner: Address): void {
  try {
    window.sessionStorage.removeItem(creationWorkspaceKey(owner));
  } catch {
    // The in-memory result is cleared by the caller either way.
  }
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
  if (typeof rawAddress !== "string") return null;
  if (typeof record.amountIn !== "string" || typeof record.createdAt !== "string") return null;
  // routeId is the primary route identity. A legacy record carries only a
  // buy/sell `direction`, which maps to the bounded pair's two route ids —
  // round-tripped so old saved zaps keep working.
  const routeId =
    typeof record.routeId === "string" && resolveRouteById(record.routeId)
      ? record.routeId
      : record.direction === "buy"
        ? BOUNDED_SWAP_IDS[0]
        : record.direction === "sell"
          ? BOUNDED_SWAP_IDS[1]
          : null;
  if (routeId === null) return null;
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
      routeId,
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

function readTransactions(owner: Address, limit = 20): TransactionRecord[] {
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
  }).slice(0, limit);
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

function parseOptionalRouterAmount(value: string, decimals: number): bigint {
  if (!value || value === ".") return 0n;
  try {
    return parseRouterAmount(value, decimals);
  } catch {
    return 0n;
  }
}

function sanitizeDecimal(value: string): string {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}

function formatToken(value: bigint, decimals: number = 18): string {
  const formatted = Number(formatUnits(value, decimals));
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

type StepState = "done" | "current" | "future";

type VerifyCheck = {
  label: string;
  value: string;
  href?: string;
  ok: boolean;
};

function unixNowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/**
 * One row of "Getting it onchain".
 *
 * A finished step collapses to a single line — its mark, its name, and the one
 * fact that proves it happened — because a wall of four fully expanded panels
 * is what made the old flow impossible to read at a glance. Only the step the
 * user can actually act on gets the body copy and the buttons, and nothing
 * that is not `current` renders its actions at all: a disabled Create button
 * sitting under a finished Create step is noise that reads as a failure.
 */
function Step({ index, state, title, detail, link, children }: {
  index: number;
  state: StepState;
  title: string;
  /** Mono evidence when the step is done, plain prose when it is still ahead. */
  detail?: string;
  /** Trailing link on a completed step (e.g. the creation transaction). */
  link?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  if (state === "current") {
    return (
      <div className={styles.stepCurrent}>
        <span className={styles.stepBadge} aria-hidden="true">{index}</span>
        <div>
          <strong className={styles.stepTitle}>{title}</strong>
          {children}
        </div>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className={styles.stepDone}>
        <span className={styles.stepMarkOk} aria-hidden="true">
          <BlockGlyph name="tick" className={styles.stepMarkGlyph} />
        </span>
        <strong className={styles.stepDoneLabel}>{title}</strong>
        {detail ? <code className={styles.stepDetail}>{detail}</code> : null}
        {link}
      </div>
    );
  }

  return (
    <div className={styles.stepFuture}>
      <span className={styles.stepNumeral} aria-hidden="true">{index}</span>
      <strong className={styles.stepFutureTitle}>{title}</strong>
      {detail ? <span className={styles.stepFutureDetail}>{detail}</span> : null}
    </div>
  );
}

function VerifyRow({ label, value, href, ok }: VerifyCheck): React.JSX.Element {
  return (
    // data-ok drives the failed state: every mark used to render in the same pass colour, so a check
    // that did NOT pass looked exactly like one that did.
    <div className={styles.verifyRow} data-ok={ok}>
      <span>
        <BlockGlyph name={ok ? "tick" : "alert"} className={styles.rowGlyph} />
      </span>
      <div><small>{label}</small>{href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : <strong>{value}</strong>}</div>
    </div>
  );
}
