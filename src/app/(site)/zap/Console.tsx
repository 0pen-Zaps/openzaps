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
  keccak256,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { BRIDGE_FUNDING_ENABLED } from "@/lib/bridge";
import { BridgeFundPanel } from "./BridgeFundPanel";
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
  parseRouterAmount,
  randomHex32,
  randomNonce,
  type SavedZapRecord,
} from "@/lib/openzap";
import {
  buildLivePolicy,
  decodeLivePolicyPlan,
  encodeLivePolicyPlan,
  quoteLivePolicy,
  resolveLivePolicyPlan,
  type ResolvedLivePolicy,
} from "@/lib/live-policy";
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
import { quoteCreationFee, type CreationFeeQuote } from "@/lib/route-quote";
import {
  OPENZAP_CREATION_FEE,
  OPENZAP_CREATION_FEE_CONTRACTS,
  OPENZAP_CONTRACTS,
  OPENZAP_V1_2_CONTRACTS,
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
  openZapV1_2Abi,
  openZapV1_2Configured,
  openZapV1_2CreationGatewayAbi,
  openZapV1_2FactoryAbi,
  optionalContractSetState,
  permit2NonceBitmapAbi,
  robinhoodChain,
  wethAbi,
  zapCreationFeePotAbi,
} from "@/lib/robinhood";
import {
  PERMIT2_SIGNATURE_TRANSFER,
  buildPermit2OwnerPull,
  buildOpenZapOneShotTypedData,
  isPermit2NonceConsumed,
} from "@/lib/permit2-owner-pull";
import {
  exactPermit2ApprovalPlan,
  oneShotFundingMode,
  type OneShotLineage,
} from "@/lib/owner-pull-execution";
import { protocolsForRouteKind } from "@/lib/protocols";
import type { TransactionLifecycleState } from "@/lib/transaction-lifecycle";
import { inspectOwnedLiveZap } from "@/lib/zap";
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

/**
 * What the on-screen estimate actually came from, per the route's real quote
 * source — not per `kind`. A stitched `swap-route` is two pool quotes and has no
 * vault in it, so the old swap/vault split announced it as a "Vault preview";
 * an LP route is a pool quote AND a vault preview, and says so.
 */
function quoteSourceLabel(route: Route | null): string {
  if (route === null) return "Quote";
  const source = route.quote.source;
  if (source === "v4" || source === "v4-route") return "Pool quote";
  if (source === "erc4626-deposit" || source === "erc4626-redeem") return "Vault preview";
  return "Pool quote + vault preview";
}

type BusyAction =
  | "connect"
  | "quote"
  | "create"
  | "wrap"
  | "fund"
  | "execute"
  | "recover"
  | "halt"
  | "revoke-permit2"
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
type LiveZapRecord = SavedZapRecord & {
  policyToken?: string;
  /** Display/persistence hint only; every action re-derives this from chain. */
  lineage?: OneShotLineage;
  /** Last chain-verified halt state; every action re-reads it. */
  policyHalted?: boolean;
};
type CreatedZapResult = LiveZapRecord & { createTx: Hex };

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
  const v1_2Configured = openZapV1_2Configured();
  const v1_2ConfigState = optionalContractSetState(OPENZAP_V1_2_CONTRACTS);
  const {
    account,
    chainId: walletChainId,
    connect: connectSession,
    disconnect: disconnectSession,
    switchToRobinhood,
  } = useWalletSession();
  const [protocolHealth, setProtocolHealth] = useState<HealthState>("checking");
  const [v1_2Health, setV1_2Health] = useState<HealthState>("checking");
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
  /** Null is the editable single-route form; a value freezes an imported or verified ordered plan. */
  const [policyToken, setPolicyToken] = useState<string | null>(null);
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
  const [zap, setZap] = useState<LiveZapRecord | null>(null);
  const [savedZaps, setSavedZaps] = useState<LiveZapRecord[]>([]);
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
  const [zapHasRecoverableBalance, setZapHasRecoverableBalance] = useState(false);
  const [permit2Allowance, setPermit2Allowance] = useState<bigint | null>(null);
  const [nativeBalance, setNativeBalance] = useState(0n);
  const [busy, setBusy] = useState<BusyAction>(null);
  /** True for the whole "Fund & run" chain, including the gap between its two legs where `busy`
   *  briefly returns to null — without it that gap would re-enable the button mid-flight. */
  const [chainedRun, setChainedRun] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [haltConfirmation, setHaltConfirmation] = useState("");
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [transactionLifecycle, setTransactionLifecycle] = useState<TransactionLifecycleState | null>(null);
  const [zapHistory, setZapHistory] = useState<ZapHistoryState>([]);
  const zapRef = useRef<LiveZapRecord | null>(null);
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

  const selectZap = useCallback((record: LiveZapRecord): void => {
    setPermit2Allowance(null);
    setZap(record);
    setPolicyToken(record.policyToken ?? null);
    setRouteId(record.routeId);
    // Format the stored raw amount at the ROUTE's real decimals — 6 for USDG,
    // 9 for ozUSDG — or the input box shows a value ~10^12x off.
    const record_route = resolveRouteById(record.routeId);
    setAmount(formatUnits(BigInt(record.amountIn), record_route?.tokenIn.decimals ?? 18));
    resetQuoteState();
    setExecutedZap(null);
    setHaltConfirmation("");
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

  // The selected route stays the first/funding route. An imported or verified
  // multi-step token resolves the final settlement route separately.
  const route = useMemo(() => resolveRouteById(routeId), [routeId]);
  const resolvedPolicy = useMemo((): ResolvedLivePolicy | null => {
    try {
      const decoded = policyToken ? decodeLivePolicyPlan(policyToken) : null;
      return resolveLivePolicyPlan(
        decoded ?? { version: 1, steps: [{ routeId, amountIn: amount }] },
      );
    } catch {
      return null;
    }
  }, [amount, policyToken, routeId]);
  const outputRoute = resolvedPolicy?.outputRoute ?? route;
  const policyStepCount = resolvedPolicy?.steps.length ?? 1;
  const inDecimals = route?.tokenIn.decimals ?? 18;
  const inputSymbol = route?.tokenIn.symbol ?? "";
  const outputSymbol = outputRoute?.tokenOut.symbol ?? "";
  const outDecimals = outputRoute?.tokenOut.decimals ?? 18;
  const routeOffered = resolvedPolicy !== null
    && resolvedPolicy.steps.every((step) => offeredRoutes.some((candidate) => candidate.id === step.route.id));
  const canWrapInput = route !== null && isAddressEqual(route.tokenIn.address, ROBINHOOD_ASSETS.weth);
  const venueLabel =
    policyStepCount > 1
      ? `${policyStepCount} ordered, allowlisted adapters`
      :
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
  const routePairLabel =
    route === null || outputRoute === null
      ? "—"
      : `${route.tokenIn.symbol} → ${outputRoute.tokenOut.symbol}${policyStepCount > 1 ? ` · ${policyStepCount} fixed steps` : ""}`;
  const settlementLabel =
    route === null || outputRoute === null
      ? "—"
      : policyStepCount > 1
        ? `${routePairLabel} · ordered one-shot policy`
      : route.quote.source === "v4"
        ? `${routePairLabel} · Uniswap v4`
        : route.quote.source === "v4-route"
          ? `${routePairLabel} · via aeWETH, one signed step`
          : `Vault ${shortAddress(route.quote.vault)}`;
  const amountIn = resolvedPolicy?.steps[0].amountIn
    ?? parseOptionalRouterAmount(amount, inDecimals);
  const requiredAmount = zap ? BigInt(zap.amountIn) : amountIn;
  const walletInputBalance = walletInBalance;
  const walletOutputBalance = walletOutBalance;
  const zapInputBalance = zapInBalance;
  const hasRecoverableBalance = zapHasRecoverableBalance || zapNativeBalance > 0n;
  const funded = zap !== null && requiredAmount > 0n && zapInputBalance >= requiredAmount;
  const partiallyFunded =
    zap !== null
    && requiredAmount > 0n
    && zapInputBalance > 0n
    && zapInputBalance < requiredAmount;
  const executionComplete = zap !== null && executedZap === zap.address;
  const selectedLineage: OneShotLineage = zap?.lineage ?? "v1.1";
  const policyHalted = zap?.policyHalted === true;
  const ownerPullAvailable =
    zap !== null
    && selectedLineage === "v1.2"
    && !policyHalted
    && requiredAmount > 0n
    && zapInputBalance === 0n;
  const fundingReady = funded || ownerPullAvailable;
  const minOut = quote === null ? null : (quote * BigInt(10_000 - slippageBps)) / 10_000n;
  const protocolReady = configured && protocolHealth === "ready";
  const creationLineage: OneShotLineage = v1_2Configured ? "v1.2" : "v1.1";
  const creationGatewayConfigured =
    creationLineage === "v1.2" ? v1_2Configured : feeConfigured;
  const creationFactory =
    creationLineage === "v1.2"
      ? OPENZAP_V1_2_CONTRACTS.factory
      : OPENZAP_CONTRACTS.factory;
  const creationProtocolReady =
    protocolReady
    && v1_2ConfigState !== "partial"
    && (!v1_2Configured || v1_2Health === "ready");
  // App-level holder utilities: unlocked by connected-wallet 0xZAPS balance.
  // Route-INDEPENDENT — reads 0xZAPS even on a USDG/vault route. Never token-gated.
  const holderTier: HolderTier = account ? holderTierFor(walletZapsBalance) : "none";
  const permit2AllowanceOutstanding =
    selectedLineage === "v1.2"
    && permit2Allowance !== null
    && permit2Allowance > 0n;

  const clearMessages = useCallback((): void => {
    setNotice("");
    setError("");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => autoQuoteRef.current?.(), QUOTE_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const refreshBalances = useCallback(async (): Promise<void> => {
    if (!account || !route || !outputRoute) {
      setPermit2Allowance(null);
      return;
    }
    const tokenIn = route.tokenIn.address;
    const tokenOut = outputRoute.tokenOut.address;
    const recoveryAssets = resolvedPolicy?.trackedAssets ?? route.trackedAssets;
    try {
      const [
        walletIn,
        walletOut,
        walletZaps,
        native,
        zapIn,
        zapOut,
        zapNative,
        trackedBalances,
        currentPermit2Allowance,
      ] = await Promise.all([
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
        zap
          ? Promise.all(
              recoveryAssets.map((asset) =>
                publicClient.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [zap.address] }),
              ),
            )
          : Promise.resolve([]),
        zap && selectedLineage === "v1.2"
          ? publicClient.readContract({
              address: tokenIn,
              abi: erc20Abi,
              functionName: "allowance",
              args: [account, PERMIT2_SIGNATURE_TRANSFER],
            })
          : Promise.resolve(null),
      ]);
      setWalletInBalance(walletIn);
      setWalletOutBalance(walletOut);
      setWalletZapsBalance(walletZaps);
      setNativeBalance(native);
      setZapInBalance(zapIn);
      setZapOutBalance(zapOut);
      setZapNativeBalance(zapNative);
      setZapHasRecoverableBalance(trackedBalances.some((balance) => balance > 0n));
      setPermit2Allowance(currentPermit2Allowance);
    } catch (cause) {
      setError(readableError(cause));
    }
  }, [account, outputRoute, resolvedPolicy, route, selectedLineage, zap]);

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
        const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
        const [
          response,
          implementation,
          version,
          implementationHash,
          factoryCode,
          implementationCode,
          adapterCode,
          registryCode,
          allowlistCode,
          gatewayCode,
          potCode,
          gatewayVersion,
          gatewayFee,
          gatewayFactory,
          gatewayPot,
          gatewayWeth,
          gatewayZaps,
          gatewayAdapter,
          potGateway,
          potZaps,
        ] = await Promise.all([
          fetch("/api/health", { cache: "no-store" }),
          publicClient.readContract({
            address: OPENZAP_CONTRACTS.factory,
            abi: openZapFactoryAbi,
            functionName: "implementation",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CONTRACTS.factory,
            abi: openZapFactoryAbi,
            functionName: "VERSION",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CONTRACTS.factory,
            abi: openZapFactoryAbi,
            functionName: "implCodeHash",
            blockNumber,
          }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.factory, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.implementation, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.adapter, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.adapterRegistry, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.tokenAllowlist, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CREATION_FEE_CONTRACTS.gateway, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CREATION_FEE_CONTRACTS.pot, blockNumber }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "VERSION",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "CREATION_FEE",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "lineageFactory",
            args: [0],
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "CREATION_POT",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "AEWETH",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "ZAPS",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
            abi: openZapCreationGatewayAbi,
            functionName: "CREATION_ADAPTER",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.pot,
            abi: zapCreationFeePotAbi,
            functionName: "gateway",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_CREATION_FEE_CONTRACTS.pot,
            abi: zapCreationFeePotAbi,
            functionName: "ZAPS",
            blockNumber,
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
          && Boolean(implementationCode)
          && keccak256(implementationCode as Hex).toLowerCase() === implementationHash.toLowerCase()
          && gatewayVersion === "1.0.0-candidate"
          && gatewayFee === OPENZAP_CREATION_FEE
          && isAddressEqual(gatewayFactory, OPENZAP_CONTRACTS.factory)
          && isAddressEqual(gatewayPot, OPENZAP_CREATION_FEE_CONTRACTS.pot)
          && isAddressEqual(gatewayWeth, ROBINHOOD_ASSETS.weth)
          && isAddressEqual(gatewayZaps, ROBINHOOD_ASSETS.zaps)
          && isAddressEqual(gatewayAdapter, OPENZAP_CONTRACTS.adapter)
          && isAddressEqual(potGateway, OPENZAP_CREATION_FEE_CONTRACTS.gateway)
          && isAddressEqual(potZaps, ROBINHOOD_ASSETS.zaps)
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
    let cancelled = false;
    const checkV1_2Health = async (): Promise<void> => {
      if (v1_2ConfigState === "absent") {
        if (!cancelled) setV1_2Health("ready");
        return;
      }
      if (v1_2ConfigState === "partial") {
        if (!cancelled) setV1_2Health("degraded");
        return;
      }
      try {
        const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
        const [
          factoryCode,
          configuredImplementationCode,
          gatewayCode,
          potCode,
          adapterRegistryCode,
          tokenAllowlistCode,
          permit2Code,
          implementation,
          implementationHash,
          version,
          adapters,
          tokens,
          implementationFactory,
          implementationPermit2,
          gatewayVersion,
          gatewayFactory,
          gatewayFee,
          gatewayPot,
          gatewayWeth,
          gatewayZaps,
          gatewayAdapter,
          potGateway,
          potZaps,
        ] = await Promise.all([
          publicClient.getBytecode({ address: OPENZAP_V1_2_CONTRACTS.factory, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_V1_2_CONTRACTS.implementation, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_V1_2_CONTRACTS.creationGateway, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_V1_2_CONTRACTS.creationFeePot, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.adapterRegistry, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.tokenAllowlist, blockNumber }),
          publicClient.getBytecode({ address: PERMIT2_SIGNATURE_TRANSFER, blockNumber }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.factory,
            abi: openZapV1_2FactoryAbi,
            functionName: "implementation",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.factory,
            abi: openZapV1_2FactoryAbi,
            functionName: "implCodeHash",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.factory,
            abi: openZapV1_2FactoryAbi,
            functionName: "VERSION",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.factory,
            abi: openZapV1_2FactoryAbi,
            functionName: "adapters",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.factory,
            abi: openZapV1_2FactoryAbi,
            functionName: "tokens",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.implementation,
            abi: openZapV1_2Abi,
            functionName: "FACTORY",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.implementation,
            abi: openZapV1_2Abi,
            functionName: "PERMIT2",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationGateway,
            abi: openZapV1_2CreationGatewayAbi,
            functionName: "VERSION",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationGateway,
            abi: openZapV1_2CreationGatewayAbi,
            functionName: "V1_2_FACTORY",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationGateway,
            abi: openZapV1_2CreationGatewayAbi,
            functionName: "CREATION_FEE",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationGateway,
            abi: openZapV1_2CreationGatewayAbi,
            functionName: "CREATION_POT",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationGateway,
            abi: openZapV1_2CreationGatewayAbi,
            functionName: "AEWETH",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationGateway,
            abi: openZapV1_2CreationGatewayAbi,
            functionName: "ZAPS",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationGateway,
            abi: openZapV1_2CreationGatewayAbi,
            functionName: "CREATION_ADAPTER",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationFeePot,
            abi: zapCreationFeePotAbi,
            functionName: "gateway",
            blockNumber,
          }),
          publicClient.readContract({
            address: OPENZAP_V1_2_CONTRACTS.creationFeePot,
            abi: zapCreationFeePotAbi,
            functionName: "ZAPS",
            blockNumber,
          }),
        ]);
        const ready =
          version === "1.2.0-candidate"
          && gatewayVersion === "1.0.0-candidate"
          && Boolean(
            factoryCode
            && configuredImplementationCode
            && gatewayCode
            && potCode
            && adapterRegistryCode
            && tokenAllowlistCode
            && permit2Code
          )
          && isAddressEqual(implementation, OPENZAP_V1_2_CONTRACTS.implementation)
          && keccak256(configuredImplementationCode as Hex).toLowerCase()
            === implementationHash.toLowerCase()
          && isAddressEqual(adapters, OPENZAP_CONTRACTS.adapterRegistry)
          && isAddressEqual(tokens, OPENZAP_CONTRACTS.tokenAllowlist)
          && isAddressEqual(implementationFactory, OPENZAP_V1_2_CONTRACTS.factory)
          && isAddressEqual(implementationPermit2, PERMIT2_SIGNATURE_TRANSFER)
          && isAddressEqual(gatewayFactory, OPENZAP_V1_2_CONTRACTS.factory)
          && gatewayFee === OPENZAP_CREATION_FEE
          && isAddressEqual(gatewayPot, OPENZAP_V1_2_CONTRACTS.creationFeePot)
          && isAddressEqual(gatewayWeth, ROBINHOOD_ASSETS.weth)
          && isAddressEqual(gatewayZaps, ROBINHOOD_ASSETS.zaps)
          && isAddressEqual(gatewayAdapter, OPENZAP_CONTRACTS.adapter)
          && isAddressEqual(potGateway, OPENZAP_V1_2_CONTRACTS.creationGateway)
          && isAddressEqual(potZaps, ROBINHOOD_ASSETS.zaps);
        if (!cancelled) setV1_2Health(ready ? "ready" : "degraded");
      } catch {
        if (!cancelled) setV1_2Health("degraded");
      }
    };
    void checkV1_2Health();
    const timer = window.setInterval(() => void checkV1_2Health(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [v1_2ConfigState]);


  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const restore = async (): Promise<void> => {
      const records = readSavedZaps(account);
      const checks = await Promise.allSettled(
        records.map(async (record) => {
          const verified = await inspectOwnedLiveZap(
            publicClient,
            record.address,
            account,
            { requireExecutable: false },
          );
          return {
            ...record,
            routeId: verified.resolved.inputRoute.id,
            amountIn: verified.resolved.steps[0].amountIn.toString(),
            policyHash: verified.policyHash,
            policyToken: verified.policyToken,
            lineage: verified.lineage,
            policyHalted: verified.policyHalted,
          } satisfies LiveZapRecord;
        }),
      );
      if (cancelled) return;
      const verified = new Map<string, LiveZapRecord>();
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
      if (!rpcHealthy) setNotice("Saved Zaps could not be verified right now — Robinhood RPC is unreachable. They remain saved.");
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
      if (!route || !resolvedPolicy) throw new Error("Select a valid deployed policy first.");
      // Quote every frozen amount independently. No output is invented as the
      // next step's input: an under-producing intermediate quote blocks.
      const { amountOut, gasEstimate } = await quoteLivePolicy(
        publicClient,
        resolvedPolicy,
        account ?? zeroAddress,
      );
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
          `${policyStepCount > 1 ? `${policyStepCount}-step policy quote` : quoteSourceLabel(route)} loaded. Intermediate amounts are fixed in the policy; the final signed minimum is enforced after the last adapter returns.`,
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
    if (!creationGatewayConfigured) {
      setCreationFeeQuote(null);
      setCreationFeeError("Creation-fee gateway is not configured. New Zap creation is paused.");
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
  }, [account, creationGatewayConfigured]);

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
      requireProtocolReady(creationProtocolReady);
      if (v1_2ConfigState === "partial") {
        throw new Error("The optional v1.2 contract set is incomplete. New Zap creation is paused.");
      }
      if (
        creationLineage === "v1.1"
        && (!feeConfigured || OPENZAP_CREATION_FEE_CONTRACTS.gateway === zeroAddress)
      ) {
        throw new Error("The v1.1 creation-fee gateway is not configured. New Zap creation is paused.");
      }
      if (!creationFeeQuote) throw new Error("Review a creation-fee conversion quote before creating this Zap.");
      if (!route) throw new Error("Select a deployed route first.");
      // Fail closed: never create a capsule for a route that is not offered —
      // an undeployed adapter, or a vault whose totalSupply is 0 (grief-able).
      if (!routeOffered) {
        throw new Error(
          "This route is not currently offered. Every route needs a deployed adapter, and a vault route needs a seeded vault (totalSupply > 0).",
        );
      }
      const wallet = await requireWallet(owner);
      // Every intermediate adapter binds the next frozen step amount in its
      // own calldata; the final minimum stays fresh in the signed intent.
      const policy = buildLivePolicy(owner, resolvedPolicy);
      const salt = randomHex32();
      const predicted =
        creationLineage === "v1.2"
          ? await publicClient.readContract({
              address: OPENZAP_V1_2_CONTRACTS.factory,
              abi: openZapV1_2FactoryAbi,
              functionName: "predict",
              args: [policy, salt],
            })
          : await publicClient.readContract({
              address: OPENZAP_CONTRACTS.factory,
              abi: openZapFactoryAbi,
              functionName: "predict",
              args: [policy, salt],
            });
      let hash: Hex;
      let status: "success" | "reverted";
      if (creationLineage === "v1.2") {
        const { request } = await publicClient.simulateContract({
          account: owner,
          address: OPENZAP_V1_2_CONTRACTS.creationGateway,
          abi: openZapV1_2CreationGatewayAbi,
          functionName: "createZap",
          args: [policy, salt, creationFeeQuote.minZapsOut],
          value: OPENZAP_CREATION_FEE,
        });
        ({ hash, status } = await submitAndConfirm(
          owner,
          "Create the v1.2 Zap + convert fee",
          () => wallet.writeContract(request),
        ));
      } else {
        const { request } = await publicClient.simulateContract({
          account: owner,
          address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
          abi: openZapCreationGatewayAbi,
          functionName: "createZap",
          args: [0, policy, salt, creationFeeQuote.minZapsOut],
          value: OPENZAP_CREATION_FEE,
        });
        ({ hash, status } = await submitAndConfirm(
          owner,
          "Create the v1.1 Zap + convert fee",
          () => wallet.writeContract(request),
        ));
      }
      if (status !== "success") throw new Error("Creation gateway transaction reverted.");

      const verified = await inspectOwnedLiveZap(publicClient, predicted, owner);
      const nextZap: CreatedZapResult = {
        address: verified.address,
        routeId: verified.resolved.inputRoute.id,
        amountIn: verified.resolved.steps[0].amountIn.toString(),
        createTx: hash,
        createdAt: new Date().toISOString(),
        policyHash: verified.policyHash,
        policyToken: verified.policyToken,
        lineage: verified.lineage,
        policyHalted: verified.policyHalted,
      };
      rememberZap(owner, nextZap);
      rememberCreationWorkspace(owner, nextZap.address);
      setCreationResult(nextZap);
      selectZap(nextZap);
      setNotice(
        `Immutable ${verified.lineage} Zap created at ${shortAddress(predicted)}. The ${formatToken(OPENZAP_CREATION_FEE, 18)} ETH creation fee converted atomically with the reviewed ${formatToken(creationFeeQuote.minZapsOut, 18)} 0xZAPS floor.${
          verified.lineage === "v1.2"
            ? " You can execute from your wallet through an exact, witnessed Permit2 pull or prefund it first."
            : " Fund the Zap before execution."
        }`,
      );
      trackEvent("robinhood_zap_created", {
        zap: predicted,
        route: resolvedPolicy.steps.map((step) => step.route.id).join(","),
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
      const verifiedZap = await inspectOwnedLiveZap(
        publicClient,
        zap.address,
        owner,
      );
      const firstStep = verifiedZap.resolved.steps[0];
      const tokenIn = firstStep.route.tokenIn;
      const current = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      const target = firstStep.amountIn;
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
    let ownerPullContext: {
      owner: Address;
      token: { address: Address; symbol: string; decimals: number };
    } | null = null;
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a Zap first.");
      requireProtocolReady(protocolReady);
      const verifiedZap = await inspectOwnedLiveZap(
        publicClient,
        zap.address,
        owner,
      );
      const zapPolicy = verifiedZap.resolved;
      const tokenIn = zapPolicy.inputRoute.tokenIn;
      const tokenOut = zapPolicy.outputRoute.tokenOut;
      const liveInputBalance = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [verifiedZap.address],
      });
      const fundingMode = oneShotFundingMode(
        verifiedZap.lineage,
        verifiedZap.policyHalted,
        liveInputBalance,
        zapPolicy.steps[0].amountIn,
      );
      if (fundingMode === "needs-funding") throw new Error("Fund the v1.1 Zap before execution.");
      if (fundingMode === "owner-pull") {
        ownerPullContext = { owner, token: tokenIn };
      }

      // The signed minOut derives from a click-time re-quote (a swap pool quote,
      // or an ERC-4626 preview for a vault route); require a quote the user
      // explicitly reviewed, and abort when the market/preview has moved below
      // THAT floor — a silent auto-refresh must never lower the acknowledged
      // threshold.
      if (reviewedQuote === null) throw new Error("Request a live quote first to review the minimum output you are signing.");
      const reviewedFloor = (reviewedQuote * BigInt(10_000 - slippageBps)) / 10_000n;
      const freshQuote = (await quoteLivePolicy(publicClient, zapPolicy, owner)).amountOut;
      if (freshQuote < reviewedFloor) {
        setQuote(freshQuote);
        setQuoteGas(null);
        throw new Error("The live price moved below your reviewed minimum. Refresh the quote and review the new minimum before signing.");
      }
      const signedMinOut = (freshQuote * BigInt(10_000 - slippageBps)) / 10_000n;
      if (signedMinOut <= 0n) throw new Error("The live quote is too small for a safe minimum output.");
      setQuote(freshQuote);
      setQuoteGas(null);

      const now = verifiedZap.blockTimestamp;
      const nonce = randomNonce();
      const intent = {
        zap: verifiedZap.address,
        chainId: BigInt(ROBINHOOD_CHAIN_ID),
        nonce,
        validAfter: now > 5n ? now - 5n : 0n,
        deadline: now + 10n * 60n,
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
      let ownerPull: ReturnType<typeof buildPermit2OwnerPull> | null = null;
      if (fundingMode === "owner-pull") {
        const [walletInput, currentAllowance] = await Promise.all([
          publicClient.readContract({
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
          }),
          publicClient.readContract({
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, PERMIT2_SIGNATURE_TRANSFER],
          }),
        ]);
        setPermit2Allowance(currentAllowance);
        if (walletInput < zapPolicy.steps[0].amountIn) {
          throw new Error(
            `Insufficient ${tokenIn.symbol}. ${formatToken(zapPolicy.steps[0].amountIn, tokenIn.decimals)} required for the exact owner pull.`,
          );
        }

        for (const approval of exactPermit2ApprovalPlan(
          currentAllowance,
          zapPolicy.steps[0].amountIn,
        )) {
          const { request } = await publicClient.simulateContract({
            account: owner,
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2_SIGNATURE_TRANSFER, approval],
          });
          const { status } = await submitAndConfirm(
            owner,
            approval === 0n
              ? `Reset ${tokenIn.symbol} Permit2 approval`
              : `Approve exact ${tokenIn.symbol} owner pull`,
            () => wallet.writeContract(request),
          );
          if (status !== "success") throw new Error("The exact Permit2 approval transaction reverted.");
          const allowanceAfter = await publicClient.readContract({
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, PERMIT2_SIGNATURE_TRANSFER],
          });
          if (allowanceAfter !== approval) {
            throw new Error("The token did not record the exact Permit2 allowance requested.");
          }
          setPermit2Allowance(allowanceAfter);
        }

        for (let attempt = 0; attempt < 5 && ownerPull === null; attempt += 1) {
          let permitNonce = randomNonce();
          if (permitNonce === nonce) permitNonce = randomNonce();
          const candidate = buildPermit2OwnerPull({
            intent,
            fundingStep: {
              token: tokenIn.address,
              amount: zapPolicy.steps[0].amountIn,
            },
            permitNonce,
            now,
          });
          const bitmap = await publicClient.readContract({
            address: PERMIT2_SIGNATURE_TRANSFER,
            abi: permit2NonceBitmapAbi,
            functionName: "nonceBitmap",
            args: [owner, candidate.nonceBitmap.wordPos],
          });
          if (!isPermit2NonceConsumed(bitmap, permitNonce)) ownerPull = candidate;
        }
        if (ownerPull === null) {
          throw new Error("Could not allocate an unused Permit2 nonce. No signature was requested.");
        }
      }

      const signature = await wallet.signTypedData({
        account: owner,
        ...buildOpenZapOneShotTypedData(intent),
      });
      const permitSignature =
        ownerPull === null
          ? null
          : await wallet.signTypedData({
              account: owner,
              ...ownerPull.permitTypedData,
            });

      const outputBefore = await publicClient.readContract({
        address: tokenOut.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      let hash: Hex;
      let status: "success" | "reverted";
      if (ownerPull !== null && permitSignature !== null) {
        const { request } = await publicClient.simulateContract({
          account: owner,
          address: verifiedZap.address,
          abi: openZapV1_2Abi,
          functionName: "executeWithPermit2",
          args: [intent, ownerPull.permit, signature, permitSignature],
          gas: BigInt(maxExecutionGas),
        });
        ({ hash, status } = await submitAndConfirm(
          owner,
          `${tokenIn.symbol} → ${tokenOut.symbol} owner-pull Zap`,
          () => wallet.writeContract(request),
        ));
      } else {
        const { request } = await publicClient.simulateContract({
          account: owner,
          address: verifiedZap.address,
          abi: openZapAbi,
          functionName: "execute",
          args: [intent, signature],
          gas: BigInt(maxExecutionGas),
        });
        ({ hash, status } = await submitAndConfirm(
          owner,
          `${tokenIn.symbol} → ${tokenOut.symbol} Zap`,
          () => wallet.writeContract(request),
        ));
      }
      if (status !== "success") throw new Error("Zap execution reverted.");

      const [outputAfter, nonceUsed] = await Promise.all([
        publicClient.readContract({ address: tokenOut.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        publicClient.readContract({ address: verifiedZap.address, abi: openZapAbi, functionName: "nonceUsed", args: [nonce] }),
      ]);
      if (!nonceUsed || outputAfter <= outputBefore) throw new Error("Receipt confirmed but output or nonce verification failed.");
      if (ownerPull !== null) {
        const [bitmapAfter, capsuleInputAfter, allowanceAfter] = await Promise.all([
          publicClient.readContract({
            address: PERMIT2_SIGNATURE_TRANSFER,
            abi: permit2NonceBitmapAbi,
            functionName: "nonceBitmap",
            args: [owner, ownerPull.nonceBitmap.wordPos],
          }),
          publicClient.readContract({
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [verifiedZap.address],
          }),
          publicClient.readContract({
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, PERMIT2_SIGNATURE_TRANSFER],
          }),
        ]);
        if (
          !isPermit2NonceConsumed(bitmapAfter, ownerPull.permit.nonce)
          || capsuleInputAfter !== 0n
          || allowanceAfter !== 0n
        ) {
          throw new Error(
            "Receipt confirmed but the Permit2 nonce, exact allowance, or capsule input readback did not settle cleanly.",
          );
        }
        setPermit2Allowance(allowanceAfter);
      }
      const received = outputAfter - outputBefore;
      setExecutedZap(verifiedZap.address);
      setNotice(
        `Zap executed${ownerPull ? " through an exact witnessed owner pull" : " from prefunded input"}: received ${formatToken(received, tokenOut.decimals)} ${tokenOut.symbol}.`,
      );
      // Success disables the still-focused execute button; hand focus to the
      // announcement instead of letting it fall to <body>.
      queueMicrotask(() => noticeRef.current?.focus());
      trackEvent("robinhood_zap_executed", {
        zap: verifiedZap.address,
        route: zapPolicy.steps.map((step) => step.route.id).join(","),
        tx: hash,
      });
      return true;
    } catch (cause) {
      let message = readableError(cause);
      if (ownerPullContext !== null) {
        try {
          const allowance = await publicClient.readContract({
            address: ownerPullContext.token.address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [ownerPullContext.owner, PERMIT2_SIGNATURE_TRANSFER],
          });
          setPermit2Allowance(allowance);
          if (allowance > 0n) {
            message += ` An exact ${formatToken(allowance, ownerPullContext.token.decimals)} ${ownerPullContext.token.symbol} ERC-20 allowance remains for canonical Permit2. It does not authorize an executor without your exact Permit2 signature; revoke it below before leaving if you do not want it retained.`;
          }
        } catch {
          setPermit2Allowance(null);
          message += " The canonical Permit2 token allowance could not be re-read; verify it onchain before leaving this flow.";
        }
      }
      setError(message);
      return false;
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function revokePermit2Allowance(): Promise<void> {
    setBusy("revoke-permit2");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a Zap first.");
      const verifiedZap = await inspectOwnedLiveZap(
        publicClient,
        zap.address,
        owner,
        { requireExecutable: false },
      );
      if (verifiedZap.lineage !== "v1.2") {
        throw new Error("The live v1.1 lineage does not use Permit2 owner-pull funding.");
      }
      const tokenIn = verifiedZap.resolved.inputRoute.tokenIn;
      const allowance = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, PERMIT2_SIGNATURE_TRANSFER],
      });
      setPermit2Allowance(allowance);
      if (allowance === 0n) {
        setNotice(`Canonical Permit2 already has zero ${tokenIn.symbol} allowance from this wallet.`);
        return;
      }

      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2_SIGNATURE_TRANSFER, 0n],
      });
      const { hash, status } = await submitAndConfirm(
        owner,
        `Revoke ${tokenIn.symbol} Permit2 approval`,
        () => wallet.writeContract(request),
      );
      if (status !== "success") throw new Error("Permit2 allowance revocation reverted.");
      const allowanceAfter = await publicClient.readContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, PERMIT2_SIGNATURE_TRANSFER],
      });
      setPermit2Allowance(allowanceAfter);
      if (allowanceAfter !== 0n) {
        throw new Error("Receipt confirmed but the Permit2 token allowance did not read back zero.");
      }
      setNotice(
        `Canonical Permit2's ${tokenIn.symbol} token allowance is now zero. No OpenZap policy or recovery authority changed.`,
      );
      trackEvent("robinhood_permit2_allowance_revoked", {
        zap: verifiedZap.address,
        tx: hash,
      });
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
      if (!zap) throw new Error("Create or load a Zap first.");
      const verifiedZap = await inspectOwnedLiveZap(
        publicClient,
        zap.address,
        owner,
        { requireExecutable: false },
      );
      const wallet = await requireWallet(owner);
      // Sweep the ZAP's OWN tracked assets — not a hardcoded [aeWETH, 0xZAPS],
      // which for a USDG/vault capsule would move assets it never held and
      // strand the real USDG/ozUSDG.
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: verifiedZap.address,
        abi: openZapAbi,
        functionName: "emergencyExit",
        args: [[...verifiedZap.resolved.trackedAssets]],
      });
      const { hash, status } = await submitAndConfirm(
        owner,
        "Emergency asset recovery",
        () => wallet.writeContract(request),
      );
      if (status !== "success") throw new Error("Recovery transaction reverted.");
      setNotice(
        `${verifiedZap.resolved.trackedAssets.length} tracked policy asset${verifiedZap.resolved.trackedAssets.length === 1 ? "" : "s"} returned to the Zap owner.`,
      );
      trackEvent("robinhood_zap_recovered", { zap: verifiedZap.address, tx: hash });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function haltPolicy(): Promise<void> {
    setBusy("halt");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a Zap first.");
      if (haltConfirmation.trim() !== "HALT") {
        throw new Error('Type "HALT" to confirm this irreversible policy shutdown.');
      }
      const verifiedZap = await inspectOwnedLiveZap(
        publicClient,
        zap.address,
        owner,
        { requireExecutable: false },
      );
      if (verifiedZap.lineage !== "v1.2") {
        throw new Error("The live v1.1 lineage has no policy-halt entry point.");
      }
      if (verifiedZap.policyHalted) {
        throw new Error("This Zap's execution policy is already permanently halted.");
      }
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: verifiedZap.address,
        abi: openZapV1_2Abi,
        functionName: "haltPolicy",
      });
      const { hash, status } = await submitAndConfirm(
        owner,
        "Permanently halt this Zap policy",
        () => wallet.writeContract(request),
      );
      if (status !== "success") throw new Error("Policy halt transaction reverted.");
      const halted = await publicClient.readContract({
        address: verifiedZap.address,
        abi: openZapV1_2Abi,
        functionName: "policyHalted",
      });
      if (!halted) throw new Error("Receipt confirmed but policyHalted did not read back true.");

      const applyHalted = (record: LiveZapRecord): LiveZapRecord =>
        record.address === verifiedZap.address
          ? { ...record, lineage: "v1.2", policyHalted: true }
          : record;
      setZap((current) => (current ? applyHalted(current) : current));
      setSavedZaps((current) => {
        const next = current.map(applyHalted);
        saveZapList(owner, next);
        return next;
      });
      setCreationResult((current) => (current ? applyHalted(current) as CreatedZapResult : current));
      setHaltConfirmation("");
      setNotice(
        "Execution is permanently halted for this Zap. Nonce invalidation and emergency asset recovery remain available.",
      );
      trackEvent("robinhood_zap_policy_halted", { zap: verifiedZap.address, tx: hash });
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
      const verified = await inspectOwnedLiveZap(
        publicClient,
        address,
        owner,
        { requireExecutable: false },
      );
      const record: LiveZapRecord = {
        address: verified.address,
        routeId: verified.resolved.inputRoute.id,
        amountIn: verified.resolved.steps[0].amountIn.toString(),
        createdAt: new Date().toISOString(),
        policyHash: verified.policyHash,
        policyToken: verified.policyToken,
        lineage: verified.lineage,
        policyHalted: verified.policyHalted,
      };
      rememberZap(owner, record);
      selectZap(record);
      setNotice(`Loaded verified Zap ${shortAddress(address)}.`);
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
      // Every address on this screen is truncated for reading, so "copy it from
      // the panel" is not an instruction anyone can follow. The explorer link is.
      setError("Clipboard access was unavailable. Open the Zap on the explorer and copy its address there.");
    }
  }

  async function exportCurrentZap(): Promise<void> {
    if (!zap) return;
    clearMessages();
    try {
      const owner = requireAccount(account);
      const verified = await inspectOwnedLiveZap(
        publicClient,
        zap.address,
        owner,
        { requireExecutable: false },
      );
      // Export the route and lineage re-derived from chain, not the browser
      // record that merely helped the user select this capsule.
      const exportedRoute = verified.resolved.inputRoute;
      const payload = JSON.stringify(
        {
          schema: "openzaps.robinhood.zap.v1",
          chainId: ROBINHOOD_CHAIN_ID,
          lineage: verified.lineage,
          factory:
            verified.lineage === "v1.2"
              ? OPENZAP_V1_2_CONTRACTS.factory
              : OPENZAP_CONTRACTS.factory,
          routeId: exportedRoute.id,
          adapter: exportedRoute.adapter,
          tokenIn: exportedRoute.tokenIn.address,
          tokenOut: verified.resolved.outputRoute.tokenOut.address,
          orderedPolicy: verified.resolved.plan,
          policyHalted: verified.policyHalted,
          zap: {
            address: verified.address,
            policyHash: verified.policyHash,
            amountIn: verified.resolved.steps[0].amountIn.toString(),
          },
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
    } catch (cause) {
      setError(`Could not export a verified Zap configuration: ${readableError(cause)}`);
    }
  }

  async function disconnect(): Promise<void> {
    clearMessages();
    setPermit2Allowance(null);
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
    setPermit2Allowance(null);
    setPolicyToken(null);
    setRouteId(nextRouteId);
    resetQuoteState();
  }, [resetQuoteState]);

  const changeAmount = useCallback((nextAmount: string): void => {
    setPolicyToken(null);
    setAmount(nextAmount);
    resetQuoteState();
  }, [resetQuoteState]);

  function rememberZap(owner: Address, record: LiveZapRecord): void {
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
    setPermit2Allowance(null);
    setExecutedZap(null);
    setHaltConfirmation("");
    resetQuoteState();
    setManualZap("");
    clearMessages();
  }, [account, clearMessages, resetQuoteState]);

  async function copyCreationResult(): Promise<void> {
    if (!creationResult) return;
    const resultRoute = resolveRouteById(creationResult.routeId);
    const decoded = creationResult.policyToken ? decodeLivePolicyPlan(creationResult.policyToken) : null;
    let resultPolicy: ResolvedLivePolicy | null = null;
    try {
      resultPolicy = decoded ? resolveLivePolicyPlan(decoded) : null;
    } catch {
      resultPolicy = null;
    }
    const resultOutputRoute = resultPolicy?.outputRoute ?? resultRoute;
    const summary = [
      "OpenZaps creation receipt",
      `Zap: ${creationResult.address}`,
      `Transaction: ${creationResult.createTx}`,
      `Policy: ${creationResult.policyHash}`,
      `Route: ${resultRoute && resultOutputRoute ? `${resultRoute.tokenIn.symbol} -> ${resultOutputRoute.tokenOut.symbol}${resultPolicy && resultPolicy.steps.length > 1 ? ` (${resultPolicy.steps.length} ordered steps)` : ""}` : creationResult.routeId}`,
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
    const rawPolicyToken = params.get("policy");
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
    let candidatePolicy: ResolvedLivePolicy | null = null;
    try {
      const decoded = rawPolicyToken ? decodeLivePolicyPlan(rawPolicyToken) : null;
      if (rawPolicyToken && !decoded) throw new Error("invalid ordered policy");
      candidatePolicy = resolveLivePolicyPlan(
        decoded ?? {
          version: 1,
          steps: resolvedRouteId ? [{ routeId: resolvedRouteId, amountIn: rawAmount }] : [],
        },
      );
      if (
        !candidateRoute
        || candidatePolicy.inputRoute.id !== candidateRoute.id
        || candidatePolicy.steps[0].amountIn !==
          parseRouterAmount(rawAmount, candidateRoute.tokenIn.decimals)
      ) {
        candidatePolicy = null;
      }
    } catch {
      candidatePolicy = null;
    }

    // A vault-backed route cannot be judged against the pre-read offered set —
    // that set NEVER contains one, so a mount-time verdict would reject every
    // LP and vault handoff regardless of the vault's real seeded state. Leave
    // the one-shot ref unset and let the effect re-run once the seeding read
    // settles; everything else is decidable right now.
    if (candidatePolicy?.steps.some((step) => step.route.requiresSeededVault) && !offeredReady) return;
    builderImportRef.current = "rejected";

    // Fail closed: only import a route that is deployed AND currently offered.
    // A vault route is offered only while its vault is seeded; an unseeded or
    // undeployed route is rejected exactly like an invalid import.
    const offered = candidatePolicy !== null
      && candidatePolicy.steps.every((step) => offeredRoutes.some((candidate) => candidate.id === step.route.id));
    let imported: {
      routeId: string;
      route: Route;
      amount: string;
      bps: number;
      executionPolicy: ExecutionPolicy;
      policyToken: string | null;
      stepCount: number;
      outputRoute: Route;
    } | null = null;
    if (candidateRoute && candidatePolicy && offered && resolvedRouteId && executionPolicy) {
      try {
        // Validate the amount at the ROUTE's real decimals (USDG 6, ozUSDG 9).
        parseRouterAmount(rawAmount, candidateRoute.tokenIn.decimals);
        // A missing key reads as null and Number(null) is 0 — finite, so an
        // absent bps would snap to the 10 bps floor and quietly sign a 0.10%
        // cap. Anything that is not a real number has to reach the default.
        const rawBps = params.get("bps");
        const parsedBps = rawBps === null || rawBps.trim() === "" ? Number.NaN : Number(rawBps);
        imported = {
          routeId: resolvedRouteId,
          route: candidateRoute,
          amount: candidatePolicy.plan.steps[0].amountIn,
          // Snapped to the slider's own min/max/step below.
          // 100 is the same 1.00% the slider starts on when nobody touches it.
          bps: Number.isFinite(parsedBps) ? Math.min(500, Math.max(10, Math.round(parsedBps / 10) * 10)) : 100,
          executionPolicy,
          policyToken: candidatePolicy.steps.length > 1
            ? encodeLivePolicyPlan(candidatePolicy.plan.steps)
            : null,
          stepCount: candidatePolicy.steps.length,
          outputRoute: candidatePolicy.outputRoute,
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
      setPolicyToken(imported.policyToken);
      setSlippageBps(imported.bps);
      setMaxExecutionGas(imported.executionPolicy.maxGas);
      setMaxFeePerGasGwei(imported.executionPolicy.maxFeePerGasGwei);
      setNotice(
        `Imported from the builder: ${imported.route.tokenIn.symbol} → ${imported.outputRoute.tokenOut.symbol}${imported.stepCount > 1 ? ` in ${imported.stepCount} exact ordered steps` : ""}, ${imported.amount} ${imported.route.tokenIn.symbol}, ${(imported.bps / 100).toFixed(2)}% max slippage, ${imported.executionPolicy.maxGas.toLocaleString("en-US")} gas, and ${imported.executionPolicy.maxFeePerGasGwei} gwei. Nothing has been created — check the numbers, then press Create the Zap.`,
      );
      trackEvent("robinhood_builder_import", { route: imported.routeId });
    });
  }, [changeAmount, changeRoute, startNewZap, offeredRoutes, offeredReady]);

  const wrongNetwork = account !== null && walletChainId !== ROBINHOOD_CHAIN_ID;
  const creationResultRoute = creationResult ? resolveRouteById(creationResult.routeId) : null;
  const creationResultPolicy = useMemo(() => {
    if (!creationResult?.policyToken) return null;
    const decoded = decodeLivePolicyPlan(creationResult.policyToken);
    if (!decoded) return null;
    try {
      return resolveLivePolicyPlan(decoded);
    } catch {
      return null;
    }
  }, [creationResult]);
  const creationResultOutputRoute = creationResultPolicy?.outputRoute ?? creationResultRoute;
  const creationResultActive = creationResult !== null && zap?.address === creationResult.address;
  const creationResultFunded = creationResultActive && funded;
  const creationResultFundingReady = creationResultActive && fundingReady;
  const creationResultExecuted = creationResultActive && executionComplete;
  /**
   * The four steps of getting a Zap onchain, as state rather than as a label.
   *
   * "Switch network" is not a fifth step: it is step 1 unfinished. Folding it
   * in here is what keeps the wrong-chain case from being a screen where every
   * button is disabled and nothing says why — the step expands with the
   * warning and the switch button in it.
   */
  const stepIndex = !account || wrongNetwork ? 1 : !zap ? 2 : !fundingReady ? 3 : 4;
  const stepDone: readonly boolean[] = [
    account !== null && !wrongNetwork,
    zap !== null,
    fundingReady,
    executionComplete,
  ];
  const stepStateFor = (step: number): StepState =>
    executionComplete || stepDone[step - 1] ? "done" : step === stepIndex ? "current" : "future";

  // Fail-closed rail: a row only exists when there is something real to check.
  // "Zap balance" appears with the Zap, never as a pre-emptive zero.
  const verifications: readonly VerifyCheck[] = [
    {
      // Not "Factory health": this row is the whole protocol check — the
      // factory version and implementation, bytecode at the adapter, registry,
      // allowlist, fee gateway and pot, and the gateway's own fee config.
      label: "Protocol health",
      value: creationProtocolReady
        ? `${creationLineage} contracts and gateway verified`
        : v1_2ConfigState === "partial"
          ? "partial v1.2 configuration"
          : protocolHealth,
      href: configured && creationFactory !== zeroAddress ? explorerAddress(creationFactory) : undefined,
      ok: creationProtocolReady,
    },
    {
      // A vault or LP route has no pool of its own, so this cannot claim to be
      // pool-bound. It is the adapter the selected route resolves to.
      label: "Route adapter",
      value: resolvedPolicy
        ? resolvedPolicy.steps.length === 1
          ? shortAddress(resolvedPolicy.steps[0].route.adapter)
          : `${resolvedPolicy.steps.length} current allowlisted adapters`
        : "—",
      href: route ? explorerAddress(route.adapter) : undefined,
      ok: resolvedPolicy !== null,
    },
    { label: "Settles through", value: settlementLabel, ok: route !== null },
    { label: "Adapter allowance", value: "Exact amount, reset to zero", ok: true },
    {
      label: "Owner Permit2 approval",
      value:
        selectedLineage === "v1.2"
          ? permit2Allowance === null
            ? "Allowance read unavailable"
            : permit2Allowance > 0n
              ? `${formatToken(permit2Allowance, inDecimals)} ${inputSymbol} to canonical Permit2; an exact signature is still required`
              : "Zero; exact frozen input is approved only when needed"
          : "Not used by prefunded v1.1",
      ok: selectedLineage !== "v1.2" || permit2Allowance !== null,
    },
    { label: "Output protection", value: "Signed minOut in OpenZap", ok: true },
    ...(zap
      ? [{
          label: "Zap balance",
          // A drained balance is the expected end state, not a failure — the
          // row only reads red while funding is still owed.
          value: executionComplete
            ? `${formatToken(zapInBalance, inDecimals)} ${inputSymbol} — input spent`
            : `${formatToken(zapInBalance, inDecimals)} ${inputSymbol} — ${
                funded
                  ? "prefunded"
                  : ownerPullAvailable
                    ? "empty; exact owner pull ready"
                    : partiallyFunded
                      ? "partially funded"
                      : "not funded"
              }`,
          ok: fundingReady || executionComplete,
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
          {creationProtocolReady ? (
            <>
              {/* Not "pool-bound": the offered set includes ERC-4626 vault and
                  full-range LP routes, which have no pool of their own. */}
              {routePairLabel} creation is open through the verified {creationLineage} factory{" "}
              <a href={explorerAddress(creationFactory)} target="_blank" rel="noreferrer">
                {shortAddress(creationFactory)}
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
            Create an immutable Zap contract, fund only its exact input, sign the output floor, and execute. A Zap
            cannot do anything it was not signed to do.
          </p>
        </div>
        <div className={styles.headAside}>
          <span className={styles.lineageChip}>
            {zap ? selectedLineage : creationLineage} · one-shot nonce
          </span>
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
          eyebrow={`Creation receipt · ${creationResult.lineage ?? "v1.1"}`}
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
              label: creationResultPolicy && creationResultPolicy.steps.length > 1 ? "Ordered policy" : "Bounded route",
              value: creationResultRoute && creationResultOutputRoute
                ? `${creationResultRoute.tokenIn.symbol} → ${creationResultOutputRoute.tokenOut.symbol}${creationResultPolicy && creationResultPolicy.steps.length > 1 ? ` · ${creationResultPolicy.steps.length} fixed steps` : ""}`
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
                : creationResultActive && creationResult.lineage === "v1.2"
                  ? "Exact witnessed owner-pull is available; prefunding remains optional."
                : creationResultActive
                  ? "Transfer only the route's exact input."
                  : "Re-open this Zap to continue.",
              status: creationResultFundingReady ? "done" : creationResultActive ? "current" : "pending",
            },
            {
              label: "Execute",
              detail: creationResultExecuted
                ? "Signed execution confirmed."
                : creationResultFundingReady
                  ? "Review the quote, then sign once."
                  : "Available after funding.",
              status: creationResultExecuted ? "done" : creationResultFundingReady ? "current" : "pending",
            },
          ]}
        >
          {!creationResultActive ? (
            <button className="btn btnPrimary" disabled={busy !== null} onClick={() => selectZap(creationResult)} type="button">
              Re-open this Zap
            </button>
          ) : !creationResultExecuted ? (
            <a className="btn btnPrimary" href="#zap-lifecycle">
              {creationResultFundingReady ? "Continue to execution" : "Continue to funding"}
            </a>
          ) : null}
          {/* The capsule address is already fixed, so an enabled, authenticated
              Across integration can fund it from Base. The panel also receives
              the route's own input token and refuses any asset mismatch. */}
          {creationResultActive && !creationResultFundingReady && creationResultRoute && BRIDGE_FUNDING_ENABLED ? (
            <BridgeFundPanel
              capsule={creationResult.address}
              fundingAsset={creationResultRoute.tokenIn.address}
              requiredAmount={BigInt(creationResult.amountIn)}
            />
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
          <section className={`${styles.card} ${styles.signingCard}`} aria-label="What you are signing">
            <div className={styles.cardBar}>
              <h2 className={styles.cardTitle}>What you are signing</h2>
              {/* Not "frozen at creation": the route and amount are, but the
                  slippage and gas bounds in this same card are signed per
                  execution and stay editable after the Zap exists. */}
              <span className={styles.cardNote}>— enforced by the Zap, not by this page</span>
              <button
                className={`${styles.cardAction} ${styles.cardActionEnd}`}
                disabled={zap !== null}
                onClick={() => setRouteOpen(!routeVisible)}
                title={
                  zap !== null
                    ? "Route is frozen once the Zap exists"
                    : policyStepCount > 1
                      ? "Choosing a single route replaces the imported ordered policy"
                      : undefined
                }
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
                      <ProtocolStack protocols={protocolsForRouteKind(offered.kind)} size={16} />{" "}
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
                    disabled={zap !== null || policyStepCount > 1}
                    title={policyStepCount > 1 ? "Edit exact intermediate amounts in Design, then hand the policy off again." : undefined}
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
                {resolvedPolicy && resolvedPolicy.steps.length > 1 ? (
                  <span className={styles.legHint}>
                    Ordered amounts:{" "}
                    {resolvedPolicy.steps
                      .map(
                        (step, index) =>
                          `${index + 1}. ${formatToken(step.amountIn, step.route.tokenIn.decimals)} ${step.route.tokenIn.symbol}`,
                      )
                      .join(" · ")}
                  </span>
                ) : null}
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
                    : `${policyStepCount > 1 ? `${policyStepCount}-step quote` : quoteSourceLabel(route)} ${formatToken(quote, outDecimals)} · floor is what the Zap enforces`}
                </span>
                {autoRefreshedAt && (
                  <span className={styles.legHint}>
                    Auto-updated {autoRefreshedAt} — signing takes a fresh quote and stops if it has fallen below the
                    minimum you reviewed.
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
                    Connecting reads addresses and balances, and asks your wallet to switch to Robinhood Chain{" "}
                    {ROBINHOOD_CHAIN_ID}. Nothing is created, approved or signed by it.
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
                // A Zap loaded by address carries no creation transaction of
                // ours, so claiming the app's creation fee was paid for it would
                // be a fact about a transaction this browser never saw.
                zap
                  ? zap.createTx
                    ? `${shortAddress(zap.address)} · fee ${formatToken(OPENZAP_CREATION_FEE, 18)} ETH paid`
                    : `${shortAddress(zap.address)} · verified onchain`
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
                The policy binds owner, recipient, every ordered adapter and spender, every fixed input amount, and
                all recovery assets. The separate fee converts only if creation succeeds; any conversion-floor
                failure reverts the whole transaction.
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
                  {creationProtocolReady ? (
                    <small>
                      <a
                        href={explorerAddress(
                          creationLineage === "v1.2"
                            ? OPENZAP_V1_2_CONTRACTS.creationGateway
                            : OPENZAP_CREATION_FEE_CONTRACTS.gateway,
                        )}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Fee gateway
                      </a>
                      {" · "}
                      <a
                        href={explorerAddress(
                          creationLineage === "v1.2"
                            ? OPENZAP_V1_2_CONTRACTS.creationFeePot
                            : OPENZAP_CREATION_FEE_CONTRACTS.pot,
                        )}
                        rel="noreferrer"
                        target="_blank"
                      >
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
                  disabled={!account || !creationProtocolReady || creationFeeQuote === null || wrongNetwork || zap !== null || busy !== null || chainedRun || amountIn <= 0n || resolvedPolicy === null || !routeOffered}
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
              title={
                executionComplete
                  ? "Input settled"
                  : policyHalted
                    ? "Execution halted"
                    : funded
                      ? "Zap prefunded"
                      : ownerPullAvailable
                        ? "Exact owner pull ready"
                        : "Fund the Zap"
              }
              detail={
                // After a confirmed execution the input is gone, so reading the
                // live balance back would print "0 aeWETH held" under a tick.
                executionComplete
                  ? `${formatToken(requiredAmount, inDecimals)} ${inputSymbol} spent by the execution`
                  : policyHalted
                    ? "No execution path can consume input; owner recovery remains available."
                  : funded
                    ? `${formatToken(zapInBalance, inDecimals)} ${inputSymbol} held by the Zap`
                    : ownerPullAvailable
                      ? "The empty v1.2 capsule can pull exactly one frozen input under two bounded signatures."
                      : partiallyFunded
                        ? "Partial prefunding disables owner-pull; top up or recover before execution."
                        : "Direct ERC-20 transfer only. No standing wallet allowance is created."
              }
            >
              <p className={styles.stepBody}>
                {selectedLineage === "v1.2" ? (
                  <>
                    Leave the capsule empty to use the witnessed owner-pull path, or send exactly{" "}
                    <strong>{formatToken(requiredAmount, inDecimals)} {inputSymbol}</strong> to prefund it. Owner-pull
                    binds canonical Permit2 to this capsule, this intent, and the frozen token/amount; a partial
                    capsule balance is refused rather than mixed with a pull.
                  </>
                ) : (
                  <>
                    Send exactly <strong>{formatToken(requiredAmount, inDecimals)} {inputSymbol}</strong> to the Zap.
                    It can only spend that input on the route above — nothing else, no approvals to widen. With a
                    reviewed quote in hand, Fund &amp; Zap does the transfer and signed execution back to back.
                  </>
                )}
              </p>
              {permit2AllowanceOutstanding ? (
                <p className={styles.stepBody} role="alert">
                  <strong>
                    Canonical Permit2 currently has a {formatToken(permit2Allowance ?? 0n, inDecimals)} {inputSymbol} token
                    allowance from this wallet.
                  </strong>{" "}
                  That allowance alone cannot execute this Zap; the exact witnessed Permit2 signature is still
                  required. Revoke it if you stop before execution. Revoking sets this token&apos;s shared Permit2
                  allowance to zero and can affect other pending Permit2 transfers.
                </p>
              ) : null}
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
                  disabled={!zap || !protocolReady || wrongNetwork || funded || busy !== null || chainedRun || reviewedQuote === null || executionComplete || policyHalted}
                  onClick={() => void fundAndRun()}
                  type="button"
                  title={reviewedQuote === null ? "Request a live quote first — Zapping signs against the minimum you reviewed." : undefined}
                >
                  <BlockGlyph name="bolt" className={styles.btnGlyph} />
                  {chainedRun
                    ? busy === "execute"
                      ? "Zapping…"
                      : "Funding…"
                    : selectedLineage === "v1.2"
                      ? "Prefund & Zap"
                      : "Fund & Zap"}
                </button>
                <button
                  data-busy={busy === "fund"}
                  className="btn btnGhost"
                  disabled={!zap || !protocolReady || wrongNetwork || funded || busy !== null || chainedRun || policyHalted}
                  onClick={() => void fundZap()}
                  type="button"
                >
                  {busy === "fund" && !chainedRun ? "Funding…" : "Fund only"}
                </button>
                <button className="btn btnGhost" disabled={!zap} onClick={() => void copyZapAddress()} type="button">
                  Copy Zap address
                </button>
                {/* Fund only is one confirmation; "Fund & Zap" runs the funding
                    transfer, the EIP-712 signature, and the execution. */}
                <span className={styles.actionNote}>
                  ≈ 1 wallet confirmation to prefund · the combined path adds the signature and one more confirmation
                </span>
              </div>
            </Step>

            <Step
              index={4}
              state={stepStateFor(4)}
              title={executionComplete ? "Zap confirmed" : "Sign the floor and Zap"}
              detail={
                executionComplete
                  ? "signed, submitted, and receipt-verified"
                  : policyHalted
                    ? "This policy can never execute again."
                    : ownerPullAvailable
                      ? "Two exact signatures, then one owner-pull execution transaction."
                      : "EIP-712 over the reviewed minimum output, then anyone can submit it."
              }
            >
              <p className={styles.stepBody}>
                {ownerPullAvailable ? (
                  <>
                    Sign the unchanged OpenZap intent and a Permit2 witness of its exact digest. The capsule is the
                    only spender and destination; the permit expires with the ten-minute intent and never later than
                    one hour. An exact ERC-20 approval to canonical Permit2 is requested first only when needed.
                  </>
                ) : (
                  <>
                    EIP-712 binds the reviewed minimum output. The Zap reverts if the price drops below that floor;
                    the intent expires in ten minutes and caps gas and fee price.
                  </>
                )}
              </p>
              <div className={styles.stepActions}>
                <button
                  data-busy={busy === "execute"}
                  className="btn btnPrimary"
                  disabled={!protocolReady || wrongNetwork || !fundingReady || reviewedQuote === null || busy !== null || chainedRun || executionComplete || policyHalted}
                  onClick={() => void executeZap()}
                  type="button"
                >
                  {busy === "execute"
                    ? "Zapping…"
                    : executionComplete
                      ? "Zap confirmed"
                      : ownerPullAvailable
                        ? "Sign exact pull & Zap"
                        : "Sign & Zap"}
                </button>
                <span className={styles.actionNote}>
                  {ownerPullAvailable
                    ? "2 wallet signatures + 1 execution confirmation; an exact Permit2 approval may be required first"
                    : "≈ 1 wallet signature + 1 confirmation"}
                </span>
              </div>
            </Step>
          </section>

          <section className={`${styles.card} ${styles.logCard}`} aria-label="This Zap's log">
            <div className={styles.cardBar}>
              <h2 className={styles.cardTitle}>This Zap&apos;s log</h2>
              {zap && (
                <Link className={styles.cardLink} href={`/explore/${zap.address}`}>
                  Open in Explore →
                </Link>
              )}
            </div>

            {/* "From the rail" would only be true on a wide screen: the two
                columns stack on a phone, where Your Zaps ends up below this. */}
            {zap === null ? (
              <p className={styles.logEmpty}>
                No Zap loaded — create one above, or pick one under Your Zaps.
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
                  <span
                    className={
                      executionComplete
                        ? styles.logChipNeutral
                        : fundingReady
                          ? styles.logChipOk
                          : styles.logChipWarn
                    }
                  >
                    {executionComplete ? "spent" : funded ? "funded" : ownerPullAvailable ? "pull ready" : "waiting"}
                  </span>
                  <span className={styles.logText}>
                    Zap balance {formatToken(zapInBalance, inDecimals)} {inputSymbol}
                    {executionComplete
                      ? " — the input was spent by the confirmed execution"
                      : funded
                        ? " — exact input held"
                        : ownerPullAvailable
                          ? " — empty by design; exact witnessed owner pull is ready"
                          : partiallyFunded
                            ? " — partial input; top up or recover before execution"
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
                  <code className={styles.factValue}>{selectedLineage} · one-shot nonce</code>
                </div>
                <div className={styles.factRow}>
                  <span className={styles.factLabel}>Execution policy</span>
                  <span className={policyHalted ? styles.factValue : styles.factOk}>
                    {policyHalted ? "permanently halted" : "active"}
                  </span>
                </div>
                {selectedLineage === "v1.2" ? (
                  <div className={styles.factRow}>
                    <span className={styles.factLabel}>Permit2 token allowance</span>
                    <span className={permit2AllowanceOutstanding ? styles.factValue : styles.factOk}>
                      {permit2Allowance === null
                        ? "read unavailable"
                        : `${formatToken(permit2Allowance, inDecimals)} ${inputSymbol}`}
                    </span>
                  </div>
                ) : null}
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
                  <button className={styles.ghostFull} disabled={busy !== null} onClick={() => void exportCurrentZap()} type="button">
                    Export public config
                  </button>
                  <button
                    data-busy={busy === "recover"}
                    className={styles.ghostFull}
                    disabled={wrongNetwork || busy !== null || !hasRecoverableBalance}
                    onClick={() => void recoverFunds()}
                    type="button"
                  >
                    {busy === "recover" ? "Recovering…" : "Emergency recover"}
                  </button>
                  {selectedLineage === "v1.2" && permit2AllowanceOutstanding ? (
                    <button
                      className={styles.ghostFull}
                      data-busy={busy === "revoke-permit2"}
                      disabled={wrongNetwork || busy !== null}
                      onClick={() => void revokePermit2Allowance()}
                      type="button"
                    >
                      {busy === "revoke-permit2" ? "Revoking…" : `Revoke ${inputSymbol} Permit2 allowance`}
                    </button>
                  ) : null}
                </div>
                {selectedLineage === "v1.2" ? (
                  <div className={styles.loadRow}>
                    <label className={styles.loadLabel} htmlFor="halt-confirmation">
                      Irreversible policy halt
                    </label>
                    <p className={styles.logEmpty}>
                      This permanently disables every execution path for this capsule. It cannot be undone.
                      Emergency recovery remains available.
                    </p>
                    <input
                      id="halt-confirmation"
                      className={styles.loadInput}
                      disabled={policyHalted || busy !== null}
                      placeholder={policyHalted ? "Policy already halted" : 'Type "HALT"'}
                      value={haltConfirmation}
                      onChange={(event) => setHaltConfirmation(event.target.value)}
                    />
                    <button
                      className={styles.ghostFull}
                      data-busy={busy === "halt"}
                      disabled={
                        policyHalted
                        || wrongNetwork
                        || busy !== null
                        || haltConfirmation.trim() !== "HALT"
                      }
                      onClick={() => void haltPolicy()}
                      type="button"
                    >
                      {busy === "halt" ? "Halting…" : policyHalted ? "Policy halted" : "Permanently halt policy"}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <section className={`${styles.card} ${styles.zapsCard}`}>
            <div className={`${styles.cardBar} ${styles.cardBarTight}`}>
              <h2 className={styles.cardTitle}>Your Zaps</h2>
            </div>
            {savedZaps.length > 0 ? (
              <div aria-label="Saved verified Zaps" className={styles.zapList} role="group">
                {savedZaps.map((record) => {
                  const active = zap?.address === record.address;
                  const recordLabel = describeZapRecord(record);
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
                        aria-label={`Open the onchain page for Zap ${record.address}`}
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
                {busy === "load" ? "Loading…" : "Load verified Zap"}
              </button>
            </div>
          </section>

          <section className={`${styles.sunkCard} ${styles.reuseCard}`}>
            <h2 className={styles.sunkTitle}>Do it again, later</h2>
            {/* Not "everything above": this card sits in the right-hand rail, so
                nothing is above it on a wide screen. Name the design instead. */}
            {/* Not "a Zap runs once": v1.1 consumes one NONCE per execution, so
                a refunded Zap can run again on a newly signed intent. */}
            <p className={styles.sunkNote}>
              One signature, one run. Start the next Zap on the same route, amount, and bounds, or keep this one&apos;s
              config for your records.
            </p>
            <div className={styles.reuseList}>
              {/* This clears the selected Zap and leaves the route, amount, and
                  bounds in place. It does not create anything — Create the Zap
                  still does that — so it cannot promise a duplicate. */}
              <button
                className={styles.reuseRow}
                disabled={busy !== null || chainedRun}
                onClick={startNewZap}
                type="button"
              >
                <BlockGlyph name="copy" className={styles.reuseGlyph} />
                Start a new Zap, same design
              </button>
              {/* Labelled for what it is. There is no template store behind
                  this — it is the same public-config JSON download as the Zap
                  panel's, and it needs a created Zap to have anything to write. */}
              <button className={styles.reuseRow} disabled={!zap} onClick={() => void exportCurrentZap()} type="button">
                <BlockGlyph name="download" className={styles.reuseGlyph} />
                Download this Zap&apos;s config (JSON)
              </button>
              {/* A real handoff, not three ignored params. `readAutomationHandoff`
                  rejects anything without `src=build` AND a `mode`, so the
                  previous href carried route/amount/bps that Automate silently
                  dropped — the one thing worse than not carrying a design over
                  is appearing to. It also only accepts BOUNDED_SWAP_IDS, so a
                  vault or LP route still lands on an empty Automate; that is the
                  same outcome as before, reached honestly. */}
              <Link
                className={styles.reuseRow}
                href={`/zap?view=automate&src=build&mode=recurring&route=${routeId}&amount=${amount}&bps=${slippageBps}&interval=daily&runs=10`}
              >
                <BlockGlyph name="repeat" className={styles.reuseGlyph} />
                Set up a recurring Zap
              </Link>
            </div>
          </section>

          <section className={`${styles.sunkCard} ${styles.holderCard}`} aria-label="Holder conveniences">
            <h2 className={styles.sunkTitle}>Holder conveniences</h2>
            <p className={styles.sunkNote}>
              {!account
                ? "Holding 100,000+ 0xZAPS turns on app conveniences: auto-refreshing quotes, more saved Zaps and receipts, and receipt JSON export."
                : holderTier === "none"
                  ? "Hold 100,000+ 0xZAPS in this wallet to turn on auto-refreshing quotes, more saved Zaps and receipts, and receipt JSON export."
                  : `${tierLabel(holderTier)} conveniences active: auto-refreshing quotes, more saved Zaps and receipts, and receipt JSON export.`}
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

function saveZapList(owner: Address, records: LiveZapRecord[]): void {
  try {
    window.localStorage.setItem(`${ZAP_STORAGE_KEY}:${owner.toLowerCase()}`, JSON.stringify(records));
  } catch {
    // Persistence is optional; verified onchain state remains authoritative.
  }
}

function readSavedZaps(owner: Address): LiveZapRecord[] {
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

function normalizeZapRecord(value: unknown): LiveZapRecord | null {
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
    const decodedPolicy =
      typeof record.policyToken === "string" ? decodeLivePolicyPlan(record.policyToken) : null;
    const normalizedPolicyToken = decodedPolicy ? encodeLivePolicyPlan(decodedPolicy.steps) : undefined;
    return {
      address: getAddress(rawAddress),
      routeId,
      amountIn: record.amountIn,
      createdAt: record.createdAt,
      policyHash,
      createTx,
      policyToken: normalizedPolicyToken,
      lineage: record.lineage === "v1.2" ? "v1.2" : "v1.1",
      policyHalted: record.policyHalted === true,
    };
  } catch {
    return null;
  }
}

function describeZapRecord(record: LiveZapRecord): string {
  const input = resolveRouteById(record.routeId);
  if (!input) return "Unknown route";
  if (!record.policyToken) return `${input.tokenIn.symbol} → ${input.tokenOut.symbol}`;
  const decoded = decodeLivePolicyPlan(record.policyToken);
  if (!decoded) return `${input.tokenIn.symbol} → ${input.tokenOut.symbol}`;
  try {
    const resolved = resolveLivePolicyPlan(decoded);
    return `${resolved.inputRoute.tokenIn.symbol} → ${resolved.outputRoute.tokenOut.symbol}${
      resolved.steps.length > 1 ? ` · ${resolved.steps.length} steps` : ""
    }`;
  } catch {
    return `${input.tokenIn.symbol} → ${input.tokenOut.symbol}`;
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
