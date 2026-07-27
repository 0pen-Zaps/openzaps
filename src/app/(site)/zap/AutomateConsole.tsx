"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  isAddress,
  http,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { useWalletSession } from "@/components/WalletProvider";
import { BlockGlyph } from "./BlockGlyph";
import { trackEvent } from "@/lib/analytics";
import {
  INTERVAL_PRESETS,
  THRESHOLD_PRESETS,
  defaultSlippageBps,
  describeSeries,
  draftRecurringRelativeIntent,
  draftTriggerIntent,
  feedConditionForZapsMove,
  fundingReadiness,
  intentFileName,
  netFloorFromQuote,
  planWethFunding,
  projectedRelativeFloor,
  readAutomationHandoff,
  type AutomationMode,
} from "@/lib/automate";
import {
  MAX_SAVED_AUTOMATIONS,
  readAutomationRecords,
  saveAutomationRecords,
  type AutomationRecord,
} from "@/lib/automation-records";
import { consumeIntent, publishIntent, type RelaySubmission } from "@/lib/relay";
import {
  EXEC_FEE_BPS,
  EXECUTOR_SHARE_BPS,
  buildRecurringRelativeTypedData,
  buildTriggerTypedData,
  isTriggerArmed,
  serializeIntentFile,
  triggerBoundX96,
  type RecurringIntent,
  type TriggerIntent,
} from "@/lib/executions";
import {
  buildRoutePolicy,
  expectedCloneRuntime,
  parseRouterAmount,
  randomHex32,
  randomNonce,
} from "@/lib/openzap";
import {
  MAX_EXECUTION_FEE_GWEI,
  MAX_EXECUTION_GAS_UNITS,
  MIN_EXECUTION_FEE_GWEI,
  MIN_EXECUTION_GAS_UNITS,
  type ExecutorAccess,
} from "@/lib/execution-policy";
import { BOUNDED_SWAP_IDS } from "@/lib/chains";
import { quoteCreationFee, type CreationFeeQuote } from "@/lib/route-quote";
import { resolveRouteById, type Route } from "@/lib/routes";
import {
  OPENZAP_CREATION_FEE,
  OPENZAP_CREATION_FEE_CONTRACTS,
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  openZapV3_1Configured,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_RPC_URL,
  ensureRobinhoodChain,
  erc20Abi,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  lotteryPotAbi,
  openZapCreationFeeConfigured,
  openZapCreationGatewayAbi,
  openZapFactoryV3Abi,
  openZapV3Abi,
  openZapV3Configured,
  orientedPriceSourceAbi,
  priceSourceAbi,
  ROBINHOOD_ASSETS,
  wethAbi,
  robinhoodChain,
  v4QuoterAbi,
} from "@/lib/robinhood";
import styles from "./automate.module.css";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

// ETH left unwrapped so the wrap + transfer can still pay for gas. Robinhood Chain is an L2 with
// cheap gas; 0.0005 ETH covers both txs comfortably while staying negligible against a real deposit.
const WRAP_GAS_RESERVE = 500_000_000_000_000n; // 0.0005 ETH

type BusyAction = "connect" | "create" | "fund" | "sign" | "cancel" | "recover" | "refresh" | "send" | "publish" | null;
type ExecutorMode = ExecutorAccess | "custom";
type StepState = "done" | "current" | "pending";

/**
 * Who may submit. Explanatory cards rather than a <select>, because the choice
 * that used to read "Custom executor" is the one people got wrong: it decides
 * who races, and nothing about what a submitter is allowed to do.
 */
const ACCESS_OPTIONS: readonly { id: ExecutorMode; title: string; copy: string }[] = [
  { id: "anyone", title: "Anyone", copy: "Executors compete. Fastest is fine." },
  { id: "owner-only", title: "Owner only", copy: "You submit every Zap yourself." },
  { id: "custom", title: "Pinned", copy: "One executor address you name." },
];

const CHAIN_ENFORCES: readonly string[] = [
  "Nothing Zaps early, twice, or past the end",
  "The recipient stays your wallet, forever",
  "You can revoke the nonce and withdraw at any time",
];

/** The reference daemon's localhost intake (executor/intake.mjs). Probed only after signing. */
const EXECUTOR_INTAKE_URL = "http://127.0.0.1:8477";
const INTAKE_TOKEN_STORAGE_KEY = "openzap:executor:intake-token";

interface ExecutorHealth {
  executing: boolean;
  chainId: number;
}

interface SeriesStatus {
  kind: "recurring";
  runs: number;
  lastRun: bigint;
  consumed: boolean;
  intent: RecurringIntent;
  /** Clock captured at load time, so render stays pure. */
  nowSec: bigint;
}

interface TriggerStatus {
  kind: "trigger";
  consumed: boolean;
  armed: boolean;
  priceX96: bigint;
  boundX96: bigint;
  intent: TriggerIntent;
}

type AutomationStatus = SeriesStatus | TriggerStatus;
type CreatedAutomationResult = AutomationRecord & { createTx: Hex };

const AUTOMATION_CREATION_WORKSPACE_KEY = "openzaps:automation-creation-workspace:v1";

/**
 * Everything the status panel knows about ONE capsule, tagged with its address so a slow
 * response for capsule A can never render under capsule B. `balance: null` means the read
 * failed or has not landed — an explicit unavailable state, never a fake zero.
 */
interface LoadedState {
  address: Address;
  balance: bigint | null;
  status: AutomationStatus | null;
}

interface PotStatus {
  round: bigint;
  prize: bigint;
  tickets: bigint;
  totalTickets: bigint;
}

/**
 * The Automate surface: the two v3 execution types. A capsule is created against the v3 factory,
 * funded, and armed with ONE owner signature — a standing intent whose cadence or price condition
 * the capsule enforces on-chain. The signed intent exports as a JSON file for any zap executor;
 * executors earn 80% of the 1% protocol fee, the other 20% accrues to the 0xZAPS lottery pot.
 */
export default function AutomateConsole(): React.JSX.Element {
  const searchParams = useSearchParams();
  const handoff = useMemo(
    () => readAutomationHandoff(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const {
    account,
    chainId: walletChainId,
    connect: connectSession,
    switchToRobinhood,
  } = useWalletSession();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [notice, setNotice] = useState(
    handoff
      ? "Builder settings imported. Review the route, cadence or trigger, fee, and funding total before creating."
      : "",
  );
  const [error, setError] = useState("");
  const [creationFeeQuote, setCreationFeeQuote] = useState<CreationFeeQuote | null>(null);
  const [creationFeeError, setCreationFeeError] = useState("");

  const [mode, setMode] = useState<AutomationMode>(handoff?.mode ?? "recurring");
  const [routeId, setRouteId] = useState<string>(handoff?.routeId ?? BOUNDED_SWAP_IDS[0]);
  const [amount, setAmount] = useState(handoff?.amount ?? "0.001");
  const [slippageBps, setSlippageBps] = useState(
    handoff?.slippageBps ?? defaultSlippageBps(handoff?.mode ?? "recurring"),
  );
  const [maxExecutionGas, setMaxExecutionGas] = useState(
    handoff?.executionPolicy.maxGas ?? MAX_EXECUTION_GAS_UNITS,
  );
  const [maxFeePerGasGwei, setMaxFeePerGasGwei] = useState(
    handoff?.executionPolicy.maxFeePerGasGwei ?? MAX_EXECUTION_FEE_GWEI,
  );
  const [executorMode, setExecutorMode] = useState<ExecutorMode>(
    handoff?.executionPolicy.executorAccess ?? "anyone",
  );
  const [customExecutor, setCustomExecutor] = useState("");

  /** Switch execution type AND reset slippage to that mode's default (recurring needs a wider band).
   *  No-op when the mode is unchanged, so re-clicking the active tab never clobbers a manual slider. */
  const selectMode = useCallback(
    (next: AutomationMode) => {
      if (next === mode) return;
      setMode(next);
      setSlippageBps(defaultSlippageBps(next));
    },
    [mode],
  );
  const [intervalId, setIntervalId] = useState(handoff?.intervalId ?? "daily");
  const [maxRuns, setMaxRuns] = useState(handoff?.maxRuns ?? 10);
  const [recurringValidDays, setRecurringValidDays] = useState<number | null>(
    handoff?.mode === "recurring" ? handoff.validDays : null,
  );
  const [thresholdId, setThresholdId] = useState(handoff?.thresholdId ?? "up10");
  const [validDays, setValidDays] = useState(handoff?.mode === "trigger" ? handoff.validDays ?? 30 : 30);

  const [records, setRecords] = useState<AutomationRecord[]>([]);
  const [creationResult, setCreationResult] = useState<CreatedAutomationResult | null>(null);
  const [selected, setSelected] = useState<Address | null>(null);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [pot, setPot] = useState<PotStatus | null>(null);
  /** Oriented price-source spot, read for the relative-floor preview. null = unreadable → render "—". */
  const [spot, setSpot] = useState<{ priceX96: bigint; currency0: Address; currency1: Address } | null>(null);
  /** Connected wallet's balance of the funding asset, TAGGED with the token it was read for — so a
   *  balance for the previous route can never be compared against a new route's need (cf. LoadedState
   *  .address). null = not read → "unknown" preflight. */
  const [walletBalance, setWalletBalance] = useState<{ token: Address; balance: bigint } | null>(null);
  /** Connected wallet's native ETH balance — lets the app wrap ETH→aeWETH to fund an aeWETH zap. */
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
  const [executorHealth, setExecutorHealth] = useState<ExecutorHealth | null>(null);
  const [intakeToken, setIntakeToken] = useState("");
  const loadEpochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Passive restoration reads only existing permissions (`eth_accounts`) in
    // the provider. Populate this account's local automations without opening
    // a wallet prompt.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const next = account ? readAutomationRecords(account) : [];
      setRecords(next);
      const receiptAddress = account ? readAutomationCreationWorkspace(account) : null;
      const receipt = receiptAddress
        ? next.find((candidate) => candidate.address === receiptAddress && candidate.createTx !== undefined)
        : undefined;
      if (receipt?.createTx) setCreationResult({ ...receipt, createTx: receipt.createTx });
    });
    return () => {
      cancelled = true;
    };
  }, [account]);

  const route: Route | null = useMemo(() => resolveRouteById(routeId), [routeId]);
  const interval = INTERVAL_PRESETS.find((p) => p.id === intervalId) ?? INTERVAL_PRESETS[2];
  const threshold = THRESHOLD_PRESETS.find((p) => p.id === thresholdId) ?? THRESHOLD_PRESETS[1];

  const record = useMemo(
    () =>
      selected
        ? records.find((r) => r.address.toLowerCase() === selected.toLowerCase()) ?? null
        : null,
    [records, selected],
  );
  const recordRoute = useMemo(() => (record ? resolveRouteById(record.routeId) : null), [record]);
  const perRunAmount = route ? parseAmountSafe(amount, route.tokenIn.decimals) : 0n;
  const recurringRuns = record ? runsInRecord(record) : maxRuns;
  const recurringWindowSufficient =
    recurringValidDays === null
    || interval.seconds * BigInt(Math.max(recurringRuns - 1, 0)) <= BigInt(recurringValidDays) * 86_400n;

  // The EFFECTIVE execution type: once a zap is selected, everything the user sees AND signs must
  // follow the record's mode, never the transient tab state (which can't change while a record is
  // selected). Using this everywhere the UI branches keeps the shown controls, tab highlight, pot,
  // factory, and the signed intent all in agreement — so a user can never sign terms for a type
  // whose controls were never rendered.
  const activeMode: AutomationMode = record?.mode ?? mode;
  const activeContracts = activeMode === "recurring" ? OPENZAP_V3_1_CONTRACTS : OPENZAP_V3_CONTRACTS;

  // Recurring needs the v3.1 stack; a pure-trigger surface needs only v3. Gate each on what it uses
  // so a malformed v3.1 env override can't disable the (v3-only) trigger flow.
  const configured =
    openZapV3Configured() && (activeMode === "recurring" ? openZapV3_1Configured() : true);
  const feeConfigured = openZapCreationFeeConfigured();

  // Loaded chain state counts for the SELECTED capsule only; anything else is a stale response.
  const loadedForRecord = record && loaded && loaded.address === record.address ? loaded : null;
  const capsuleBalance = loadedForRecord ? loadedForRecord.balance : null;
  const status = loadedForRecord?.status ?? null;

  const remainingTarget = record ? remainingFundingTarget(record, status) : 0n;
  const balanceKnown = capsuleBalance !== null;
  const funded = record !== null && balanceKnown && capsuleBalance >= remainingTarget;
  const signed = record?.intentFile !== undefined;

  // The per-run floor a relative recurring zap would enforce at the spot last read — the same number
  // the v3.1 capsule computes on-chain each run. 0n whenever any input is degenerate (see the lib fn),
  // so the preview can render an explicit "—" instead of a misleading figure. Memoized to keep the
  // `route` read bounded to its own reactive scope (the React Compiler otherwise cannot preserve the
  // manual memoization on the create-capsule callback that also closes over `route`).
  const projectedFloor = useMemo(
    () =>
      spot && route
        ? projectedRelativeFloor({
            amountIn: perRunAmount,
            outAsset: route.tokenOut.address,
            currency0: spot.currency0,
            currency1: spot.currency1,
            priceX96: spot.priceX96,
            maxSlippageBps: slippageBps,
          })
        : 0n,
    [spot, route, perRunAmount, slippageBps],
  );

  // Funding preflight: the token the Fund step transfers, how much this step would move (remaining
  // target minus what the capsule already holds), and whether the connected wallet can cover it.
  const fundingTokenAddress = (recordRoute ?? route)?.tokenIn.address ?? null;
  const fundingNeeded =
    record && balanceKnown && capsuleBalance !== null && remainingTarget > capsuleBalance
      ? remainingTarget - capsuleBalance
      : 0n;
  // Trust the wallet balance only if it was read for the token we're about to fund with; otherwise a
  // record switch (routes have opposite tokenIn) could momentarily grade the wrong balance.
  const walletBalanceForToken =
    walletBalance && fundingTokenAddress && walletBalance.token === fundingTokenAddress ? walletBalance.balance : null;
  // aeWETH deposits can be funded straight from native ETH: the app wraps the gap on the user's
  // behalf, so the preflight grades aeWETH + wrappable ETH together. Every other asset is aeWETH-blind.
  const isWethFunding =
    fundingTokenAddress !== null && fundingTokenAddress.toLowerCase() === ROBINHOOD_ASSETS.weth.toLowerCase();
  // A pinned executor must be a real address or the signed intent would name a
  // submitter that can never match, silently bricking the series.
  const executorPin = executorMode === "owner-only"
    ? account ?? ""
    : executorMode === "custom"
      ? customExecutor.trim()
      : "";
  const executorValid = executorMode === "anyone"
    || (executorMode === "owner-only" ? account !== null : isAddress(executorPin));
  const executorForIntent = executorMode !== "anyone" && isAddress(executorPin) ? getAddress(executorPin) : null;
  const maxFeePerGas = BigInt(maxFeePerGasGwei) * 1_000_000_000n;

  const funding = isWethFunding
    ? planWethFunding({ needed: fundingNeeded, wethBalance: walletBalanceForToken, ethBalance, gasReserve: WRAP_GAS_RESERVE })
    : { ...fundingReadiness(walletBalanceForToken, fundingNeeded), wrapEth: 0n };

  /** The one loader. Epoch-guarded: only the newest in-flight load may write state. */
  const applyLoad = useCallback(async (target: AutomationRecord | null) => {
    const epoch = ++loadEpochRef.current;
    if (!target) {
      await Promise.resolve(); // stay async so no setState runs synchronously inside effects
      if (loadEpochRef.current === epoch) setLoaded(null);
      return;
    }
    try {
      const result = await loadAutomationStatus(target, resolveRouteById(target.routeId));
      if (loadEpochRef.current === epoch) {
        setLoaded({ address: target.address, balance: result.balance, status: result.status });
      }
    } catch {
      // Fail closed: unavailable, never a fake zero.
      if (loadEpochRef.current === epoch) setLoaded({ address: target.address, balance: null, status: null });
    }
  }, []);

  useEffect(() => {
    // Deferred through a microtask so every setState happens in an async continuation, never
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => applyLoad(record));
  }, [record, applyLoad]);

  // ---- wallet ----

  const connectWallet = useCallback(async () => {
    setBusy("connect");
    setError("");
    try {
      await connectSession();
      trackEvent("automate_connect");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [connectSession]);

  const switchWalletNetwork = useCallback(async (): Promise<void> => {
    setBusy("connect");
    setError("");
    try {
      await switchToRobinhood();
      setNotice("Wallet switched to Robinhood Chain.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [switchToRobinhood]);

  const persist = useCallback(
    (next: AutomationRecord[]) => {
      setRecords(next);
      if (account) saveAutomationRecords(account, next);
    },
    [account],
  );

  // ---- pot (protocol lottery) ----

  const activePot = activeContracts.lotteryPot;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const round = await publicClient.readContract({ address: activePot, abi: lotteryPotAbi, functionName: "currentRound" });
        const [prize, totalTickets, tickets] = await Promise.all([
          publicClient.readContract({ address: activePot, abi: lotteryPotAbi, functionName: "roundPrize", args: [round] }),
          publicClient.readContract({ address: activePot, abi: lotteryPotAbi, functionName: "totalTickets", args: [round] }),
          account
            ? publicClient.readContract({ address: activePot, abi: lotteryPotAbi, functionName: "tickets", args: [round, account] })
            : Promise.resolve(0n),
        ]);
        if (!cancelled) setPot({ round, prize, tickets, totalTickets });
      } catch {
        if (!cancelled) setPot(null); // explicit "—", never fake zeros
      }
    };
    if (configured) void load();
    return () => {
      cancelled = true;
    };
  }, [account, configured, notice, activePot]);

  // ---- oriented spot (relative-floor preview) ----
  // Read the v3.1 price source the recurring flow signs against, so the create form can show the
  // concrete per-run floor a chosen slippage implies at today's price. Read once on mount and after
  // each action (notice); the capsule always recomputes from live spot, so a slightly stale preview
  // is honest as long as it is labelled indicative. Fails closed to null → the UI renders "—".
  const orientedSource = OPENZAP_V3_1_CONTRACTS.orientedPriceSource;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [priceX96, currency0, currency1] = await Promise.all([
          publicClient.readContract({ address: orientedSource, abi: orientedPriceSourceAbi, functionName: "priceX96" }),
          publicClient.readContract({ address: orientedSource, abi: orientedPriceSourceAbi, functionName: "currency0" }),
          publicClient.readContract({ address: orientedSource, abi: orientedPriceSourceAbi, functionName: "currency1" }),
        ]);
        if (!cancelled) setSpot({ priceX96, currency0, currency1 });
      } catch {
        if (!cancelled) setSpot(null); // explicit unavailable, never a fake price
      }
    };
    if (openZapV3_1Configured()) void load();
    return () => {
      cancelled = true;
    };
  }, [notice, orientedSource]);

  // ---- wallet balance (funding preflight) ----
  // Read the connected wallet's balance of the funding asset so the Fund step can warn BEFORE a
  // doomed transfer. Re-reads on account/token change and after each action (notice). Fails closed to
  // null → the preflight reports "unknown" and never blocks; the on-chain transfer still checks.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.resolve(); // keep setState off the synchronous effect path (matches applyLoad)
      if (cancelled) return;
      if (!account || !fundingTokenAddress) {
        setWalletBalance(null);
        setEthBalance(null);
        return;
      }
      try {
        // aeWETH balance AND native ETH together, so the preflight can count ETH the app can wrap.
        const [bal, eth] = await Promise.all([
          publicClient.readContract({ address: fundingTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
          publicClient.getBalance({ address: account }),
        ]);
        if (!cancelled) {
          setWalletBalance({ token: fundingTokenAddress, balance: bal });
          setEthBalance(eth);
        }
      } catch {
        if (!cancelled) {
          setWalletBalance(null); // explicit unknown, never a fake zero
          setEthBalance(null);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [account, fundingTokenAddress, notice]);

  const refreshCreationFeeQuote = useCallback(async (): Promise<CreationFeeQuote | null> => {
    if (!feeConfigured) {
      setCreationFeeQuote(null);
      setCreationFeeError("Creation-fee gateway is not configured. New automation creation is paused.");
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

  // ---- actions ----

  const createCapsule = useCallback(async () => {
    setBusy("create");
    setError("");
    try {
      if (!configured) throw new Error("The v3 factory is not configured.");
      if (!feeConfigured || OPENZAP_CREATION_FEE_CONTRACTS.gateway === zeroAddress) {
        throw new Error("Creation-fee gateway is not configured. New automation creation is paused.");
      }
      if (!creationFeeQuote) throw new Error("Review a creation-fee conversion quote before creating this automation.");
      const owner = requireAccount(account);
      const activeRoute = route;
      if (!activeRoute) throw new Error("Route unavailable.");
      if (perRunAmount <= 0n) throw new Error("Enter a per-Zap amount first.");
      if (mode === "recurring" && (maxRuns < 1 || maxRuns > 1000)) throw new Error("Total Zaps must be between 1 and 1000.");

      // recurring → v3.1 (relative floor); trigger → v3. Same factory ABI (identical Policy tuple).
      const stack = mode === "recurring" ? OPENZAP_V3_1_CONTRACTS : OPENZAP_V3_CONTRACTS;
      const wallet = await requireWallet(owner);
      const policy = buildRoutePolicy(owner, activeRoute, perRunAmount);
      const salt = randomHex32();
      const predicted = await publicClient.readContract({
        address: stack.factory,
        abi: openZapFactoryV3Abi,
        functionName: "predict",
        args: [policy, salt],
      });
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: OPENZAP_CREATION_FEE_CONTRACTS.gateway,
        abi: openZapCreationGatewayAbi,
        functionName: "createZap",
        args: [mode === "recurring" ? 2 : 1, policy, salt, creationFeeQuote.minZapsOut],
        value: OPENZAP_CREATION_FEE,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Creation gateway transaction reverted.");

      // Verify the clone is byte-exact against the intended implementation before anyone funds it.
      const [code, policyHash] = await Promise.all([
        publicClient.getCode({ address: predicted }),
        publicClient.readContract({ address: predicted, abi: openZapV3Abi, functionName: "policyHash" }),
      ]);
      if (code !== expectedCloneRuntime(stack.implementation)) {
        throw new Error("Deployed Zap bytecode does not match the expected implementation. Do not fund it.");
      }

      const next: CreatedAutomationResult = {
        address: predicted,
        routeId: activeRoute.id,
        mode,
        amountPerRun: perRunAmount.toString(),
        createdAt: new Date().toISOString(),
        policyHash,
        createTx: hash,
        plannedRuns: mode === "recurring" ? maxRuns : undefined,
      };
      persist([next, ...records].slice(0, MAX_SAVED_AUTOMATIONS));
      rememberAutomationCreationWorkspace(owner, predicted);
      setCreationResult(next);
      setSelected(predicted);
      setNotice(
        `${mode === "recurring" ? "v3.1" : "v3"} Zap created and verified at ${shortAddress(predicted)}. The ${formatToken(OPENZAP_CREATION_FEE, 18)} ETH fee converted with the reviewed ${formatToken(creationFeeQuote.minZapsOut, 18)} 0xZAPS floor. Fund it next.`,
      );
      trackEvent("automate_create", { mode, fee: OPENZAP_CREATION_FEE.toString() });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [
    account,
    configured,
    creationFeeQuote,
    feeConfigured,
    maxRuns,
    mode,
    perRunAmount,
    persist,
    records,
    route,
  ]);

  const startAnotherAutomation = useCallback((): void => {
    if (account) clearAutomationCreationWorkspace(account);
    setCreationResult(null);
    setSelected(null);
    setLoaded(null);
    setNotice("");
    setError("");
  }, [account]);

  const copyCreationResult = useCallback(async (): Promise<void> => {
    if (!creationResult) return;
    const resultRoute = resolveRouteById(creationResult.routeId);
    const summary = [
      "OpenZaps automation creation receipt",
      `Zap: ${creationResult.address}`,
      `Transaction: ${creationResult.createTx}`,
      `Policy: ${creationResult.policyHash}`,
      `Lineage: ${creationResult.mode === "recurring" ? "v3.1 recurring" : "v3 price trigger"}`,
      `Route: ${resultRoute ? `${resultRoute.tokenIn.symbol} -> ${resultRoute.tokenOut.symbol}` : creationResult.routeId}`,
      `Per Zap: ${formatToken(BigInt(creationResult.amountPerRun), resultRoute?.tokenIn.decimals ?? 18)} ${resultRoute?.tokenIn.symbol ?? "tokens"}`,
      `Created: ${creationResult.createdAt}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(summary);
      setNotice("Automation creation receipt copied with its Zap address, transaction, policy, and terms.");
    } catch {
      setError("The browser blocked clipboard access. Use the explorer links in the creation receipt instead.");
    }
  }, [creationResult]);

  const fundCapsule = useCallback(async () => {
    setBusy("fund");
    setError("");
    try {
      const owner = requireAccount(account);
      if (!record || !recordRoute) throw new Error("Create a Zap first.");
      // Fresh reads, never React state: a stale balance here is a double-funding, not a stale pixel.
      const fresh = await loadAutomationStatus(record, recordRoute);
      if (fresh.balance === null) throw new Error("Zap balance is unreadable right now. Try again.");
      const target = remainingFundingTarget(record, fresh.status);
      const missing = target - fresh.balance;
      if (missing <= 0n) {
        await applyLoad(record);
        setNotice("This Zap already holds everything its remaining runs can spend.");
        return;
      }
      const wallet = await requireWallet(owner);

      // Straight-from-ETH deposits: if this zap funds with aeWETH and the wallet is short on aeWETH,
      // wrap exactly the gap from native ETH first (deposit() mints 1:1), so the user never has to
      // pre-wrap. Fresh reads — a stale balance would mis-size a real wrap. If the wrap lands but the
      // transfer below fails, the aeWETH is safely in the wallet and a retry just transfers it.
      const tokenIn = recordRoute.tokenIn.address;
      if (tokenIn.toLowerCase() === ROBINHOOD_ASSETS.weth.toLowerCase()) {
        const walletWeth = await publicClient.readContract({
          address: tokenIn,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        });
        if (walletWeth < missing) {
          const toWrap = missing - walletWeth;
          const eth = await publicClient.getBalance({ address: owner });
          if (eth < toWrap + WRAP_GAS_RESERVE) {
            throw new Error(
              `Not enough ETH to wrap: this deposit needs ${formatToken(toWrap)} more aeWETH than the wallet holds, but only ${formatToken(eth)} ETH is available (keeping ${formatToken(WRAP_GAS_RESERVE)} for gas).`,
            );
          }
          const wrapSim = await publicClient.simulateContract({
            account: owner,
            address: tokenIn,
            abi: wethAbi,
            functionName: "deposit",
            value: toWrap,
          });
          const wrapHash = await wallet.writeContract(wrapSim.request);
          // waitForTransactionReceipt resolves (not throws) on a reverted tx, so check status: a
          // reverted deposit mints no aeWETH and must not read as "Wrapped" before a confusing transfer.
          const wrapReceipt = await publicClient.waitForTransactionReceipt({ hash: wrapHash });
          if (wrapReceipt.status !== "success") {
            throw new Error("The ETH wrap reverted — no aeWETH was minted and nothing was deposited. Try again.");
          }
          setNotice(`Wrapped ${formatToken(toWrap)} ETH → aeWETH. Confirm the deposit next.`);
        }
      }

      const { request } = await publicClient.simulateContract({
        account: owner,
        address: recordRoute.tokenIn.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [record.address, missing],
      });
      const hash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });
      await applyLoad(record);
      setNotice(`Funded ${formatToken(missing, recordRoute.tokenIn.decimals)} ${recordRoute.tokenIn.symbol} into the Zap.`);
      trackEvent("automate_fund");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, applyLoad, record, recordRoute]);

  const signIntent = useCallback(async () => {
    setBusy("sign");
    setError("");
    try {
      const owner = requireAccount(account);
      if (!record || !recordRoute) throw new Error("Create a Zap first.");
      if (recordRoute.quote.source !== "v4") throw new Error("Automation supports the bounded pool routes only.");
      const wallet = await requireWallet(owner);
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      let file: string;
      let terms: string;
      if (record.mode === "recurring") {
        // Relative floor — NO quote. The v3.1 capsule reads the oriented price source's spot on
        // every run and floors the output maxSlippageBps below it, so the floor is always current
        // and a multi-run series can never go stale. The user's slippage % IS the signed tolerance.
        const intent = draftRecurringRelativeIntent({
          executor: executorForIntent,
          maxGas: BigInt(maxExecutionGas),
          maxFeePerGas,
          zap: record.address,
          chainId: ROBINHOOD_CHAIN_ID,
          seriesId: randomNonce(),
          nowSec,
          interval: interval.seconds,
          maxRuns: runsInRecord(record),
          validDays: recurringValidDays,
          recipient: owner,
          policyHash: record.policyHash,
          outAsset: recordRoute.tokenOut.address,
          priceSource: OPENZAP_V3_1_CONTRACTS.orientedPriceSource,
          maxSlippageBps: slippageBps,
        });
        const signature = await wallet.signTypedData({ account: owner, ...buildRecurringRelativeTypedData(intent) });
        file = serializeIntentFile("recurring-relative", intent, signature);
        terms = `${interval.label} · ${runsInRecord(record)} Zaps · ${recurringValidDays ? `expires ${recurringValidDays}d` : "auto expiry"} · ≤${(slippageBps / 100).toFixed(1)}% slip · ${maxExecutionGas.toLocaleString("en-US")} gas · ≤${maxFeePerGasGwei} gwei · ${executorMode === "anyone" ? "open executor" : executorMode === "owner-only" ? "owner only" : "pinned executor"}`;
      } else {
        // Trigger is one-shot in a bounded window, so it still signs an absolute minOut from a
        // fresh quote (slippage, then the 1% fee, since the capsule floors NET of the fee).
        const perRun = BigInt(record.amountPerRun);
        const { result } = await publicClient.simulateContract({
          account: owner,
          address: ROBINHOOD_LIQUIDITY.v4Quoter,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey: recordRoute.quote.poolKey, zeroForOne: recordRoute.quote.zeroForOne, exactAmount: perRun, hookData: "0x" }],
        });
        const minOut = netFloorFromQuote(result[0], slippageBps);
        if (minOut <= 0n) throw new Error("The route quotes to zero output. Try a larger per-Zap amount.");

        // The baseline is read AT SIGNING TIME — the signed condition anchors to the price the
        // user sees now, not one fetched when the page loaded.
        const baseline = await publicClient.readContract({
          address: OPENZAP_V3_CONTRACTS.poolPriceSource,
          abi: priceSourceAbi,
          functionName: "priceX96",
        });
        // The feed is 0xZAPS-per-aeWETH and FALLS when 0xZAPS rises; this converts the
        // user-facing move into the feed-side condition (see feedConditionForZapsMove).
        const condition = feedConditionForZapsMove(threshold.moveBps, threshold.rises);
        const intent = draftTriggerIntent({
          executor: executorForIntent,
          maxGas: BigInt(maxExecutionGas),
          maxFeePerGas,
          zap: record.address,
          chainId: ROBINHOOD_CHAIN_ID,
          nonce: randomNonce(),
          nowSec,
          validDays,
          priceSource: OPENZAP_V3_CONTRACTS.poolPriceSource,
          baselinePriceX96: baseline,
          thresholdBps: condition.thresholdBps,
          above: condition.above,
          recipient: owner,
          policyHash: record.policyHash,
          outAsset: recordRoute.tokenOut.address,
          minOut,
        });
        const signature = await wallet.signTypedData({ account: owner, ...buildTriggerTypedData(intent) });
        file = serializeIntentFile("trigger", intent, signature);
        terms = `${threshold.label} · valid ${validDays}d · ${maxExecutionGas.toLocaleString("en-US")} gas · ≤${maxFeePerGasGwei} gwei · ${executorMode === "anyone" ? "open executor" : executorMode === "owner-only" ? "owner only" : "pinned executor"}`;
      }

      // Auto-publish to the shared relay so the owner never has to move a file. Best-effort: if the
      // relay is down or not yet configured, the intent is still signed and the manual publish /
      // file-export / local-executor fallbacks below still work.
      let deliveredTo: string | undefined;
      let relayId: string | undefined;
      try {
        const published = await publishIntent(JSON.parse(file) as RelaySubmission);
        deliveredTo = "relay";
        relayId = published.id;
      } catch {
        // Relay unavailable — fall through to the fallbacks.
      }
      // Persisting swaps in a NEW record object, so the status effect reloads on its own.
      persist(records.map((r) => (
        r.address === record.address ? { ...r, intentFile: file, terms, deliveredTo, relayId } : r
      )));
      setNotice(
        deliveredTo === "relay"
          ? executorMode === "anyone"
            ? "Signed and published to the executor network — any executor can Zap it now. Nothing else to do."
            : "Signed and published. This Zap will accept runs only from the executor bound in this intent."
          : "Standing intent signed. Publish it to the executor network, or download the file for an executor you run.",
      );
      trackEvent("automate_sign", { mode: record.mode, published: deliveredTo === "relay" });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [
    account,
    executorForIntent,
    executorMode,
    interval,
    maxExecutionGas,
    maxFeePerGas,
    maxFeePerGasGwei,
    persist,
    record,
    recordRoute,
    records,
    recurringValidDays,
    slippageBps,
    threshold,
    validDays,
  ]);

  // ---- local executor intake (reference daemon on this machine) ----

  // Probe once signed, then KEEP probing every few seconds until a daemon answers — the realistic
  // flow is "sign, then start the daemon", so a one-shot probe on the `signed` edge would never
  // notice a daemon that comes up later. Stops polling once detected. A failed probe is the NORMAL
  // case (no local daemon) and renders as nothing.
  useEffect(() => {
    if (!signed || executorHealth) return;
    let live = true;
    const probe = async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 1_500);
      try {
        const res = await fetch(`${EXECUTOR_INTAKE_URL}/health`, { signal: abort.signal });
        const body = res.ok ? ((await res.json()) as { ok?: boolean; executing?: boolean; chainId?: number }) : null;
        if (live && body?.ok) setExecutorHealth({ executing: body.executing === true, chainId: Number(body.chainId) });
      } catch {
        // No daemon reachable (the common case, and on Safari/Firefox where https→http localhost is
        // blocked) — leave it null and try again on the next tick.
      } finally {
        clearTimeout(timer);
      }
    };
    void probe();
    const interval = setInterval(() => void probe(), 5_000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [signed, executorHealth]);

  useEffect(() => {
    try {
      // sessionStorage, not localStorage: the intake token is a local-machine capability, and
      // scoping it to the tab session keeps an XSS on the public origin from exfiltrating a durable
      // one. The small cost is re-pasting it in a new session.
      const saved = window.sessionStorage.getItem(INTAKE_TOKEN_STORAGE_KEY);
      if (saved) Promise.resolve().then(() => setIntakeToken(saved));
    } catch {
      // Storage unavailable — the field just starts empty.
    }
  }, []);

  const updateIntakeToken = useCallback((value: string) => {
    setIntakeToken(value);
    try {
      window.sessionStorage.setItem(INTAKE_TOKEN_STORAGE_KEY, value);
    } catch {
      // Storage unavailable — the value lives only in component state.
    }
  }, []);

  const sendToExecutor = useCallback(async () => {
    setBusy("send");
    setError("");
    try {
      if (!record?.intentFile) throw new Error("Sign the intent first.");
      if (!intakeToken.trim()) throw new Error("Paste the intake token (run `node executor/index.mjs status` to see it).");
      if (executorHealth && executorHealth.chainId !== ROBINHOOD_CHAIN_ID) {
        throw new Error(`Local executor is on chain ${executorHealth.chainId}, not ${ROBINHOOD_CHAIN_ID}. It would reject this intent.`);
      }
      // Bounded like the probe: a wedged daemon must not pin `busy` and freeze every other button.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 5_000);
      let res: Response;
      try {
        res = await fetch(`${EXECUTOR_INTAKE_URL}/intents`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${intakeToken.trim()}` },
          body: record.intentFile,
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401) throw new Error("The executor rejected the token — copy it from `node executor/index.mjs status`.");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Executor refused the intent (HTTP ${res.status}).`);
      }
      const body = (await res.json()) as { stored: string };
      persist(records.map((r) => (r.address === record.address ? { ...r, deliveredTo: "local-executor" } : r)));
      setNotice(`Intent delivered to your local executor (${body.stored}) — it takes over from here.`);
      trackEvent("automate_send_executor");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("The local executor did not respond in time. Is the daemon healthy?");
      } else {
        setError(readableError(cause));
      }
    } finally {
      setBusy(null);
    }
  }, [executorHealth, intakeToken, persist, record, records]);

  /** Manual retry of the auto-publish (e.g. the relay was down at signing time). */
  const publishToRelay = useCallback(async () => {
    setBusy("publish");
    setError("");
    try {
      if (!record?.intentFile) throw new Error("Sign the intent first.");
      const published = await publishIntent(JSON.parse(record.intentFile) as RelaySubmission);
      persist(records.map((r) => (
        r.address === record.address ? { ...r, deliveredTo: "relay", relayId: published.id } : r
      )));
      setNotice("Published to the executor network — any executor can Zap it now.");
      trackEvent("automate_publish_relay");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [persist, record, records]);

  const exportIntent = useCallback(() => {
    if (!record?.intentFile) return;
    const blob = new Blob([record.intentFile], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = intentFileName(record.mode, record.address);
    anchor.click();
    URL.revokeObjectURL(url);
    trackEvent("automate_export");
  }, [record]);

  const copyIntent = useCallback(async () => {
    if (!record?.intentFile) return;
    try {
      await navigator.clipboard.writeText(record.intentFile);
      setNotice("Intent file copied to the clipboard.");
    } catch {
      setError("Clipboard unavailable — use Download instead.");
    }
  }, [record]);

  const refresh = useCallback(async () => {
    setBusy("refresh");
    setError("");
    try {
      await applyLoad(record); // never throws; a failed read renders as "unavailable"
    } finally {
      setBusy(null);
    }
  }, [applyLoad, record]);

  const cancelAutomation = useCallback(async () => {
    setBusy("cancel");
    setError("");
    try {
      const owner = requireAccount(account);
      if (!record?.intentFile) throw new Error("Nothing signed to cancel.");
      const parsed = parseIntentFile(record.intentFile);
      if (!parsed) throw new Error("Stored intent is unreadable.");
      const id = parsed.kind === "recurring" ? (parsed.intent as RecurringIntent).seriesId : (parsed.intent as TriggerIntent).nonce;
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: record.address,
        abi: openZapV3Abi,
        functionName: "invalidateNonce",
        args: [id],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("The cancellation transaction reverted. The automation remains valid.");
      }
      if (record.relayId) await consumeIntent(record.relayId, "").catch(() => false);
      const revoked: AutomationRecord = {
        ...record,
        revokedAt: new Date().toISOString(),
        revocationTx: hash,
      };
      persist(records.map((candidate) => candidate.address === record.address ? revoked : candidate));
      await applyLoad(record);
      setNotice("Automation cancelled onchain. The signed intent can never execute again.");
      trackEvent("automate_cancel");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, applyLoad, persist, record, records]);

  const recoverFunds = useCallback(async () => {
    setBusy("recover");
    setError("");
    try {
      const owner = requireAccount(account);
      if (!record || !recordRoute) throw new Error("No Zap selected.");
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: record.address,
        abi: openZapV3Abi,
        functionName: "emergencyExit",
        args: [[...recordRoute.trackedAssets]],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("The recovery transaction reverted. No funds were recovered.");
      }
      await applyLoad(record);
      setNotice("Emergency exit complete — every tracked asset returned to the owner wallet.");
      trackEvent("automate_recover");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, applyLoad, record, recordRoute]);

  // ---- render ----

  const wrongNetwork = account !== null && walletChainId !== ROBINHOOD_CHAIN_ID;
  const creationResultRoute = creationResult ? resolveRouteById(creationResult.routeId) : null;
  const creationResultActive = creationResult !== null && record?.address === creationResult.address;
  const creationResultFunded = creationResultActive && funded;
  const creationResultSigned = creationResultActive && signed;
  const stepLabel = !account
    ? "1. Connect wallet"
    : wrongNetwork
      // Unnumbered on purpose: switching networks is the wrong-network banner's
      // action, not one of the four numbered lifecycle steps.
      ? "Switch network"
    : !record
      ? "2. Create Zap"
      : !funded
        ? "3. Fund Zap"
        : !signed
          ? "4. Sign standing intent"
          : "Automation armed";

  const feePct = Number(EXEC_FEE_BPS) / 100;
  const executorPct = Number(EXECUTOR_SHARE_BPS) / 100;

  const fundingDetail = !record || !recordRoute
    ? "Transfer exactly what the automation will spend. Nothing else can leave the Zap."
    : capsuleBalance === null
      ? "Zap balance is unavailable — refresh before funding. Funding is disabled until the balance reads."
      : `Remaining target ${formatToken(remainingTarget, recordRoute.tokenIn.decimals)} ${recordRoute.tokenIn.symbol} — holds ${formatToken(capsuleBalance, recordRoute.tokenIn.decimals)}.`;

  // The plain-English restatement of the form. It is the reason the execution
  // bounds can sit behind a disclosure, so it has to be generated from live
  // state — a static sentence here would be a claim about terms nobody set.
  const summaryRoute = recordRoute ?? route;
  const inSymbol = summaryRoute?.tokenIn.symbol ?? "—";
  const outSymbol = summaryRoute?.tokenOut.symbol ?? "—";
  // A deployed Zap's per-Zap amount is frozen in its policy; `amount` is only a
  // draft until then, and after a reload it has fallen back to the default. Read
  // the record first so the sentence describes the contract, not the form.
  const recordPerRun = record ? parseRecordAmount(record) : null;
  const summaryAmount = record
    ? recordPerRun === null
      ? "—"
      : formatToken(recordPerRun, summaryRoute?.tokenIn.decimals ?? 18)
    : amount || "—";
  const slipPct = (slippageBps / 100).toFixed(1);

  // Which lifecycle step is live. `current` is the first one that is not done,
  // so exactly one step is ever expanded.
  const stepDone: readonly boolean[] = [
    account !== null,
    record !== null,
    record !== null && funded,
    signed,
  ];
  const currentStepIndex = stepDone.findIndex((done) => !done);
  const stepStateAt = (index: number): StepState =>
    stepDone[index] ? "done" : index === currentStepIndex ? "current" : "pending";

  // Zaps this automation still owes. Fails closed to "—": a zero where the read
  // failed would be a claim that nothing is pending.
  const zapsOwed = !record || !status
    ? "—"
    : status.kind === "recurring"
      ? status.consumed
        ? "0"
        : String(Math.max(runsInRecord(record) - status.runs, 0))
      : status.consumed
        ? "0"
        : "1";

  const railState = !record
    ? { label: "", tone: styles.chipMuted }
    : record.revokedAt
      ? { label: "cancelled", tone: styles.chipDanger }
      : !signed
        ? { label: "draft", tone: styles.chipMuted }
        : status === null
          ? { label: "state unavailable", tone: styles.chipMuted }
          : status.kind === "recurring"
            ? status.consumed
              ? { label: "finished", tone: styles.chipMuted }
              : { label: "live", tone: styles.chipOk }
            : status.consumed
              ? { label: "fired", tone: styles.chipMuted }
              : status.armed
                ? { label: "armed", tone: styles.chipWarn }
                : { label: "waiting", tone: styles.chipMuted };

  const railMeta = !record
    ? ""
    : !signed
      ? "created — fund and sign to arm"
      : status === null
        ? "state unavailable — refresh"
        : status.kind === "recurring"
          ? status.consumed
            ? "finished or cancelled"
            : describeSeries(status.runs, status.lastRun, status.intent, status.nowSec)
          : status.consumed
            ? "fired or cancelled"
            : status.armed
              ? "ARMED — condition met, awaiting an executor"
              : "waiting for the signed move";

  // A 100-Zap series would draw hairlines, so the bar is capped and the mono
  // meta line below it stays the authoritative count.
  const progressTotal =
    record && status?.kind === "recurring" && !status.consumed
      ? Math.min(Math.max(runsInRecord(record), 1), 24)
      : 0;
  const progressFilled =
    progressTotal > 0 && record && status?.kind === "recurring"
      ? Math.min(progressTotal, Math.round((status.runs / runsInRecord(record)) * progressTotal))
      : 0;

  const otherRecords = records.filter((candidate) => candidate.address !== record?.address);

  return (
    <main className={styles.screen} id="main">
      <header className={styles.head}>
        <h1 className={styles.title}>Automate</h1>
        <p className={styles.lede}>
          One signature authorizes a whole series. The Zap enforces the interval and the count onchain, so
          nothing can run early, twice, or past the end.
        </p>
      </header>

      {!configured ? (
        <p className={`${styles.banner} ${styles.bannerWarn}`} role="status">
          The v3 contract set is not configured. Automation is disabled.
        </p>
      ) : null}

      {wrongNetwork ? (
        <div className={`${styles.banner} ${styles.bannerWarn}`} role="status">
          <span>This wallet is on chain {walletChainId}. Robinhood Chain {ROBINHOOD_CHAIN_ID} is required.</span>
          <button
            data-busy={busy === "connect"}
            className={`${styles.btnGhost} ${styles.bannerAction}`}
            disabled={busy !== null}
            onClick={() => void switchWalletNetwork()}
            type="button"
          >
            {busy === "connect" ? "Switching…" : "Switch network"}
          </button>
        </div>
      ) : null}

      {/* Stays mounted while empty so the live region is announced on change. */}
      <div className={`${styles.banner} ${styles.bannerNotice}`} role="status">{notice}</div>

      {error ? (
        <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
          <BlockGlyph name="alert" className={styles.bannerGlyph} />
          {error}
        </div>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.col}>
          {creationResult ? (
            <section className={styles.card} aria-label="Creation receipt">
              <div className={styles.receiptHead}>
                <span className={styles.receiptChip}>
                  <BlockGlyph name="check" className={styles.receiptChipGlyph} />
                  Confirmed
                </span>
                <h2 className={styles.receiptTitle}>Your automation Zap is live.</h2>
                <span className={styles.receiptLineage}>
                  {creationResult.mode === "recurring" ? "v3.1" : "v3"}
                </span>
              </div>
              <p className={styles.receiptDetail}>
                The gateway transaction confirmed and the clone runtime matched the expected implementation
                before funding. The Zap now holds the immutable route; funding and the standing EIP-712
                authorization remain separate wallet actions.
              </p>
              <dl className={styles.facts}>
                <div className={styles.fact}>
                  <dt>Zap</dt>
                  <dd className={styles.factMono}>
                    <a href={explorerAddress(creationResult.address)} target="_blank" rel="noreferrer">
                      {shortAddress(creationResult.address)}
                    </a>
                  </dd>
                </div>
                <div className={styles.fact}>
                  <dt>Creation transaction</dt>
                  <dd className={styles.factMono}>
                    <a href={explorerTransaction(creationResult.createTx)} target="_blank" rel="noreferrer">
                      {shortHex(creationResult.createTx)}
                    </a>
                  </dd>
                </div>
                <div className={styles.fact}>
                  <dt>Policy hash</dt>
                  <dd className={styles.factMono}>{shortHex(creationResult.policyHash)}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Lineage</dt>
                  <dd>{creationResult.mode === "recurring" ? "v3.1 · recurring series" : "v3 · price trigger"}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Bounded route</dt>
                  <dd>
                    {creationResultRoute
                      ? `${creationResultRoute.tokenIn.symbol} → ${creationResultRoute.tokenOut.symbol}`
                      : creationResult.routeId}
                  </dd>
                </div>
                <div className={styles.fact}>
                  <dt>Per Zap</dt>
                  <dd>
                    {`${formatToken(BigInt(creationResult.amountPerRun), creationResultRoute?.tokenIn.decimals ?? 18)} ${creationResultRoute?.tokenIn.symbol ?? "tokens"}${creationResult.mode === "recurring" ? ` · ${creationResult.plannedRuns ?? 1} Zaps planned` : " · one trigger"}`}
                  </dd>
                </div>
              </dl>
              <div className={styles.receiptActions}>
                {!creationResultActive ? (
                  <button
                    className={styles.btnPrimary}
                    disabled={busy !== null}
                    onClick={() => setSelected(creationResult.address)}
                    type="button"
                  >
                    Re-open this Zap
                  </button>
                ) : !creationResultSigned ? (
                  <a className={styles.btnPrimary} href="#automation-lifecycle">
                    {creationResultFunded ? "Continue to authorization" : "Continue to funding"}
                  </a>
                ) : null}
                <Link className={styles.btnGhost} href={`/explore/${creationResult.address}`}>Onchain page</Link>
                <Link className={styles.btnGhost} href="/profile">View profile</Link>
                <button className={styles.btnGhost} onClick={() => void copyCreationResult()} type="button">
                  Copy receipt
                </button>
                <button
                  className={creationResultSigned ? styles.btnPrimary : styles.btnGhost}
                  disabled={busy !== null}
                  onClick={startAnotherAutomation}
                  type="button"
                >
                  Create another
                </button>
              </div>
            </section>
          ) : null}

          <section className={`${styles.card} ${styles.cardLift}`} aria-label="Configure the automation">
            <div className={styles.modeBar} role="group" aria-label="Execution type">
              <button
                type="button"
                className={activeMode === "recurring" ? styles.modeOn : styles.mode}
                onClick={() => selectMode("recurring")}
                disabled={busy !== null || record !== null}
              >
                <BlockGlyph name="repeat" className={styles.modeGlyph} />
                Recurring
              </button>
              <button
                type="button"
                className={activeMode === "trigger" ? styles.modeOn : styles.mode}
                onClick={() => selectMode("trigger")}
                disabled={busy !== null || record !== null}
              >
                <BlockGlyph name="band" className={styles.modeGlyph} />
                Price trigger
              </button>
              <span className={styles.stepChip} aria-live="polite">{stepLabel}</span>
              <span className={styles.versionChip}>
                {activeMode === "recurring"
                  ? "v3.1 · per-Zap floor from live spot"
                  : "v3 · floor from a fresh quote at signing"}
              </span>
            </div>

            <div className={styles.body}>
              <p className={styles.summary} aria-live="polite">
                {activeMode === "recurring" ? (
                  // A one-run series has no cadence to state: the interval never gates a
                  // series that ends on its first run, and "every day, 1 times" is neither
                  // true nor English.
                  recurringRuns === 1 ? (
                    <>
                      Zap <strong>{summaryAmount} {inSymbol}</strong> into <strong>{outSymbol}</strong> once, never
                      worse than <strong>{slipPct}%</strong> off spot.
                    </>
                  ) : (
                    <>
                      Zap <strong>{summaryAmount} {inSymbol}</strong> into <strong>{outSymbol}</strong>,{" "}
                      <strong>{interval.label.toLowerCase()}</strong>, <strong>{recurringRuns} times</strong>, never
                      worse than <strong>{slipPct}%</strong> off spot.
                    </>
                  )
                ) : (
                  <>
                    Zap <strong>{summaryAmount} {inSymbol}</strong> into <strong>{outSymbol}</strong> once, when{" "}
                    <strong>{threshold.label}</strong>, valid{" "}
                    <strong>{validDays} {validDays === 1 ? "day" : "days"}</strong>, never worse than{" "}
                    <strong>{slipPct}%</strong> off the quote.
                  </>
                )}
              </p>

              <div className={styles.routeSeg} role="group" aria-label="Direction">
                {BOUNDED_SWAP_IDS.map((id) => {
                  const r = resolveRouteById(id);
                  if (!r) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={routeId === id ? styles.routeSegOn : styles.routeSegBtn}
                      onClick={() => setRouteId(id)}
                      disabled={busy !== null || record !== null}
                    >
                      {r.tokenIn.symbol} → {r.tokenOut.symbol}
                    </button>
                  );
                })}
              </div>

              <div className={styles.fields}>
                <Field label={`Amount per Zap (${route?.tokenIn.symbol ?? ""})`}>
                  <input
                    className={`${styles.input} ${styles.inputMono}`}
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(sanitizeDecimal(event.target.value))}
                    disabled={busy !== null || record !== null}
                  />
                </Field>
                {activeMode === "recurring" ? (
                  <>
                    <Field label="Cadence">
                      <select
                        className={styles.input}
                        value={intervalId}
                        onChange={(event) => setIntervalId(event.target.value)}
                        disabled={busy !== null || signed}
                      >
                        {INTERVAL_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Total Zaps">
                      <input
                        className={`${styles.input} ${styles.inputMono}`}
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={maxRuns}
                        // Clamped on change: a blank number input parses to NaN and would
                        // otherwise surface as a create-time revert instead of a disabled button.
                        onChange={(event) => setMaxRuns(clampInt(event.target.value, 1, 100))}
                        onFocus={(event) => event.currentTarget.select()}
                        disabled={busy !== null || record !== null}
                      />
                    </Field>
                    <Field label="Expires after">
                      <select
                        className={styles.input}
                        value={recurringValidDays === null ? "auto" : String(recurringValidDays)}
                        onChange={(event) =>
                          setRecurringValidDays(event.target.value === "auto" ? null : Number(event.target.value))
                        }
                        disabled={busy !== null || signed}
                      >
                        <option value="auto">Auto · schedule + headroom</option>
                        <option value="7">7 days</option>
                        <option value="30">30 days</option>
                        <option value="90">90 days</option>
                      </select>
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="Condition (0xZAPS price move)">
                      <select
                        className={styles.input}
                        value={thresholdId}
                        onChange={(event) => setThresholdId(event.target.value)}
                        disabled={busy !== null || signed}
                      >
                        {THRESHOLD_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Valid for (days)">
                      <input
                        className={`${styles.input} ${styles.inputMono}`}
                        type="number"
                        min={1}
                        max={90}
                        step={1}
                        value={validDays}
                        onChange={(event) => setValidDays(clampInt(event.target.value, 1, 90))}
                        onFocus={(event) => event.currentTarget.select()}
                        disabled={busy !== null || signed}
                      />
                    </Field>
                  </>
                )}
              </div>

              <div className={styles.access}>
                <div className={styles.accessHead}>
                  <strong className={styles.accessTitle}>Who may Zap it</strong>
                  <span className={styles.accessHint}>
                    This only decides who races — never what they can do.
                  </span>
                </div>
                <div className={styles.accessGrid}>
                  {ACCESS_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={executorMode === option.id ? `${styles.accessOpt} ${styles.accessOptOn}` : styles.accessOpt}
                      aria-pressed={executorMode === option.id}
                      onClick={() => setExecutorMode(option.id)}
                      disabled={busy !== null || signed}
                    >
                      <strong>{option.title}</strong>
                      <span>{option.copy}</span>
                    </button>
                  ))}
                </div>
                {executorMode === "custom" ? (
                  <label className={styles.pinnedField}>
                    <span className={styles.fieldLabel}>Executor address</span>
                    <input
                      className={`${styles.input} ${styles.inputMono}`}
                      value={customExecutor}
                      onChange={(event) => setCustomExecutor(event.target.value)}
                      placeholder="0x…"
                      spellCheck={false}
                      disabled={busy !== null || signed}
                      aria-invalid={!executorValid}
                    />
                  </label>
                ) : null}
                <p className={styles.note} aria-live="polite">
                  {executorMode === "anyone" ? (
                    <>
                      Anyone · any executor may submit a run this Zap owes, and earns 80% of the 1% fee for it. The
                      Zap still refuses every run it does not owe.
                    </>
                  ) : executorMode === "owner-only" && account ? (
                    <>
                      Owner only · the intent binds <code>{account}</code>. Every other submitter reverts, so no
                      executor network can keep the automation live for you.
                    </>
                  ) : executorMode === "owner-only" ? (
                    <>Connect the owner wallet before signing an owner-only execution policy.</>
                  ) : executorValid ? (
                    <>
                      Pinned · only <code>{executorPin.trim()}</code> may submit; every other submitter reverts. If
                      it stops submitting, nothing runs until it resumes — Anyone is the more reliable choice unless
                      this is an executor you control.
                    </>
                  ) : (
                    <>That is not a valid address. Signing would name a submitter no wallet can match, so nothing could ever run.</>
                  )}
                </p>
              </div>

              <details className={styles.advanced}>
                <summary className={styles.advancedSummary}>
                  <BlockGlyph name="chevronDown" className={styles.advancedChevron} />
                  Execution bounds
                </summary>
                <div className={styles.advancedGrid}>
                  <Field label={`Slippage tolerance (${(slippageBps / 100).toFixed(2)}%)`}>
                    <input
                      className={styles.range}
                      type="range"
                      min={5}
                      max={500}
                      step={5}
                      value={slippageBps}
                      onChange={(event) => setSlippageBps(Number(event.target.value))}
                      disabled={busy !== null || signed}
                    />
                  </Field>
                  <Field label={`Execution gas limit (${maxExecutionGas.toLocaleString("en-US")})`}>
                    <input
                      className={styles.range}
                      type="range"
                      min={MIN_EXECUTION_GAS_UNITS}
                      max={MAX_EXECUTION_GAS_UNITS}
                      step={50_000}
                      value={maxExecutionGas}
                      onChange={(event) => setMaxExecutionGas(Number(event.target.value))}
                      disabled={busy !== null || signed}
                    />
                  </Field>
                  <Field label={`Gas price cap (${maxFeePerGasGwei} gwei)`}>
                    <input
                      className={styles.range}
                      type="range"
                      min={MIN_EXECUTION_FEE_GWEI}
                      max={MAX_EXECUTION_FEE_GWEI}
                      step={1}
                      value={maxFeePerGasGwei}
                      onChange={(event) => setMaxFeePerGasGwei(Number(event.target.value))}
                      disabled={busy !== null || signed}
                    />
                  </Field>
                  <p className={styles.advancedNote}>
                    The Zap also rejects any run submitted with more than{" "}
                    {maxExecutionGas.toLocaleString("en-US")} gas, or above {maxFeePerGasGwei} gwei.
                  </p>
                </div>
              </details>

              {activeMode === "recurring" && !recurringWindowSufficient ? (
                <p className={styles.noteWarn} role="alert">
                  This expiry ends before all {recurringRuns} Zaps can become due. Choose a longer window, fewer
                  Zaps, or a shorter cadence.
                </p>
              ) : null}

              {activeMode === "recurring" ? (
                <div className={styles.floorNote} aria-live="polite">
                  <BlockGlyph name="clock" className={styles.floorGlyph} />
                  <p className={styles.floorText}>
                    {spot === null ? (
                      <>
                        Projected floor · spot is unavailable right now — the Zap still enforces your slippage band
                        onchain on every run.
                      </>
                    ) : projectedFloor > 0n && route ? (
                      <>
                        Each run&apos;s floor is recomputed from live spot at the moment it lands, minus your{" "}
                        {slipPct}% — at today&apos;s spot that is at least{" "}
                        <strong>
                          {formatToken(projectedFloor, route.tokenOut.decimals)} {route.tokenOut.symbol}
                        </strong>
                        , so a series signed today protects its last run as tightly as its first.
                      </>
                    ) : (
                      <>Projected floor · enter a per-Zap amount to preview each run&apos;s guaranteed minimum.</>
                    )}
                  </p>
                </div>
              ) : null}

              <div className={styles.steps} id="automation-lifecycle">
                <Step
                  index={1}
                  glyph="plug"
                  title="Connect wallet"
                  detail={`Robinhood Chain (${ROBINHOOD_CHAIN_ID}), injected wallet.`}
                  state={stepStateAt(0)}
                >
                  {!account ? (
                    <button
                      data-busy={busy === "connect"}
                      className={styles.btnPrimary}
                      disabled={busy !== null}
                      onClick={() => void connectWallet()}
                      type="button"
                    >
                      {busy === "connect" ? "Connecting…" : "Connect"}
                    </button>
                  ) : null}
                </Step>

                <Step
                  index={2}
                  glyph="lock"
                  title={`Create the ${activeMode === "recurring" ? "v3.1" : "v3"} Zap`}
                  detail="The fee gateway calls the existing lineage factory, atomically converts the separate native fee, then the app verifies clone bytecode before anything is funded."
                  state={stepStateAt(1)}
                >
                  {!record ? (
                    <>
                      <button
                        data-busy={busy === "create"}
                        className={styles.btnPrimary}
                        disabled={busy !== null || !account || wrongNetwork || !configured || !feeConfigured || creationFeeQuote === null || perRunAmount <= 0n}
                        onClick={() => void createCapsule()}
                        type="button"
                      >
                        {busy === "create" ? "Creating…" : "Create Zap"}
                      </button>
                      <div className={styles.feeNote} data-ready={creationFeeQuote !== null} role="note">
                        <div className={styles.feeCell}>
                          <span>App creation fee</span>
                          <strong className={styles.feeMono}>{formatToken(OPENZAP_CREATION_FEE, 18)} ETH</strong>
                        </div>
                        <div className={styles.feeCell}>
                          <span>Atomic 0xZAPS conversion</span>
                          <strong className={creationFeeQuote ? styles.feeMono : undefined}>
                            {creationFeeQuote
                              ? `est. ${formatToken(creationFeeQuote.amountOut, 18)} · min ${formatToken(creationFeeQuote.minZapsOut, 18)} 0xZAPS`
                              : creationFeeError || "Reading the pinned aeWETH → 0xZAPS route…"}
                          </strong>
                          {feeConfigured ? (
                            <span className={styles.feeLinks}>
                              <a href={explorerAddress(OPENZAP_CREATION_FEE_CONTRACTS.gateway)} rel="noreferrer" target="_blank">
                                Fee gateway
                              </a>
                              <a href={explorerAddress(OPENZAP_CREATION_FEE_CONTRACTS.pot)} rel="noreferrer" target="_blank">
                                0xZAPS pot
                              </a>
                            </span>
                          ) : null}
                        </div>
                        {creationFeeError ? (
                          <button className={styles.btnGhost} type="button" onClick={() => void refreshCreationFeeQuote()}>
                            Retry fee quote
                          </button>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </Step>

                <Step index={3} glyph="coins" title="Fund the Zap" detail={fundingDetail} state={stepStateAt(2)}>
                  {record && recordRoute && balanceKnown && !funded ? (
                    <p
                      className={funding.status === "short" ? `${styles.preflight} ${styles.preflightShort}` : styles.preflight}
                      aria-live="polite"
                    >
                      {funding.status === "short" ? (
                        <>
                          Wallet holds{" "}
                          <strong>
                            {formatToken(walletBalanceForToken ?? 0n, recordRoute.tokenIn.decimals)} {recordRoute.tokenIn.symbol}
                          </strong>
                          {isWethFunding && ethBalance !== null ? <> + {formatToken(ethBalance)} ETH</> : null} — short{" "}
                          {formatToken(funding.shortfall, recordRoute.tokenIn.decimals)}{" "}
                          {isWethFunding ? "ETH" : recordRoute.tokenIn.symbol} of the{" "}
                          {formatToken(fundingNeeded, recordRoute.tokenIn.decimals)} this step transfers. Add{" "}
                          {isWethFunding ? "ETH or aeWETH" : recordRoute.tokenIn.symbol} first.
                        </>
                      ) : funding.status === "sufficient" && funding.wrapEth > 0n ? (
                        <>
                          Wallet holds{" "}
                          <strong>
                            {formatToken(walletBalanceForToken ?? 0n, recordRoute.tokenIn.decimals)} {recordRoute.tokenIn.symbol}
                          </strong>{" "}
                          — this deposit wraps{" "}
                          <strong>{formatToken(funding.wrapEth)} ETH → {recordRoute.tokenIn.symbol}</strong> to cover the{" "}
                          {formatToken(fundingNeeded, recordRoute.tokenIn.decimals)} it transfers. One extra signature
                          wraps it — no need to hold {recordRoute.tokenIn.symbol} first.
                        </>
                      ) : funding.status === "sufficient" && walletBalanceForToken !== null ? (
                        <>
                          Wallet holds{" "}
                          <strong>
                            {formatToken(walletBalanceForToken, recordRoute.tokenIn.decimals)} {recordRoute.tokenIn.symbol}
                          </strong>{" "}
                          — covers the {formatToken(fundingNeeded, recordRoute.tokenIn.decimals)}{" "}
                          {recordRoute.tokenIn.symbol} this step transfers.
                        </>
                      ) : (
                        <>Wallet balance unavailable — the funding transfer will still verify onchain.</>
                      )}
                    </p>
                  ) : null}
                  {record && balanceKnown && !funded ? (
                    <button
                      data-busy={busy === "fund"}
                      className={styles.btnPrimary}
                      disabled={wrongNetwork || busy !== null || funding.status === "short"}
                      onClick={() => void fundCapsule()}
                      type="button"
                    >
                      {busy === "fund" ? "Funding…" : "Fund"}
                    </button>
                  ) : null}
                  {record && !balanceKnown ? (
                    <button
                      data-busy={busy === "refresh"}
                      className={styles.btnGhost}
                      disabled={busy !== null}
                      onClick={() => void refresh()}
                      type="button"
                    >
                      {busy === "refresh" ? "Reading…" : "Retry balance read"}
                    </button>
                  ) : null}
                </Step>

                <Step
                  index={4}
                  glyph="hand"
                  title="Sign the standing intent"
                  detail={
                    activeMode === "recurring"
                      ? "One EIP-712 signature authorizes the whole series. The Zap enforces the interval and the total run count."
                      : "One EIP-712 signature arms the trigger. The baseline price is read at signing time, and the Zap re-reads the market itself on every attempt."
                  }
                  state={stepStateAt(3)}
                >
                  {record && funded && !signed ? (
                    <>
                      <button
                        data-busy={busy === "sign"}
                        className={styles.btnPrimary}
                        disabled={wrongNetwork || busy !== null || !executorValid || (activeMode === "recurring" && !recurringWindowSufficient)}
                        onClick={() => void signIntent()}
                        type="button"
                      >
                        {busy === "sign" ? "Awaiting wallet…" : "Sign intent"}
                      </button>
                      <span className={styles.stepCaption}>
                        Signing publishes it to the shared executor network automatically — no files, no setup.
                      </span>
                    </>
                  ) : null}
                  {signed ? (
                    <>
                      {record?.deliveredTo === "relay" ? (
                        <span className={styles.okStatus}>
                          <BlockGlyph name="check" className={styles.okGlyph} />
                          published to the executor network — nothing else to do
                        </span>
                      ) : (
                        <button
                          data-busy={busy === "publish"}
                          className={styles.btnPrimary}
                          disabled={busy !== null}
                          onClick={() => void publishToRelay()}
                          type="button"
                        >
                          {busy === "publish" ? "Publishing…" : "Publish to network"}
                        </button>
                      )}
                      <button className={styles.btnGhost} onClick={exportIntent} type="button">Download file</button>
                      <button className={styles.btnGhost} onClick={() => void copyIntent()} type="button">Copy JSON</button>
                    </>
                  ) : null}
                </Step>
              </div>

              {signed ? (
                <p className={styles.note}>
                  Signing publishes your intent to the shared executor network automatically — no files, no setup.
                  The buttons in step 4 are fallbacks: run your own executor and point it at the network, or hand the
                  file to any executor directly. Any executor can submit the runs this Zap owes; none can change what
                  those runs do, and if no executor serves it, nothing runs. Cancel any time from Your automations;
                  cancellation is onchain and final.
                </p>
              ) : null}
            </div>
          </section>

          <section className={styles.card} aria-label="The executor network">
            <div className={styles.execHead}>
              <h2 className={styles.execTitle}>The executor network</h2>
              {configured ? (
                <span className={styles.execLive}>
                  <i className={styles.execDot} aria-hidden />
                  v3 live
                </span>
              ) : (
                <span className={styles.execIdle}>v3 unavailable</span>
              )}
              <span className={styles.execMeta}>
                factory{" "}
                <a href={explorerAddress(activeContracts.factory)} target="_blank" rel="noreferrer">
                  {shortAddress(activeContracts.factory)}
                </a>
              </span>
            </div>
            <div className={styles.stats}>
              <div className={styles.stat}>
                <strong className={styles.statValue}>{feePct.toFixed(1)}%</strong>
                <span className={styles.statLabel}>protocol fee per automated Zap</span>
              </div>
              <div className={styles.stat}>
                <strong className={styles.statValue}>{executorPct} / {100 - executorPct}</strong>
                <span className={styles.statLabel}>submitter share · lottery pot</span>
              </div>
              <div className={styles.stat}>
                <strong className={styles.statValue}>{zapsOwed}</strong>
                <span className={styles.statLabel}>Zaps owed right now</span>
              </div>
              <div className={styles.stat}>
                <strong className={styles.statValue}>{pot ? `#${pot.round.toString()}` : "—"}</strong>
                <span className={styles.statLabel}>lottery round</span>
              </div>
              <div className={styles.stat}>
                <strong className={styles.statValue}>{pot ? formatToken(pot.prize) : "—"}</strong>
                <span className={styles.statLabel}>0xZAPS in the pot</span>
              </div>
              <div className={styles.stat}>
                <strong className={styles.statValue}>{pot && account ? formatToken(pot.tickets) : "—"}</strong>
                <span className={styles.statLabel}>your tickets</span>
              </div>
            </div>
            <p className={styles.execFoot}>
              The executor pool is untrusted. Every field an executor submits is re-verified onchain, so the worst a
              bad actor can do is waste their own gas.
              <span className={styles.execRisk}>Depositing funds can result in total loss.</span>
            </p>
          </section>

          {signed && executorHealth ? (
            <section className={styles.card} aria-label="Local executor">
              <div className={styles.localExecHead}>
                <h2 className={styles.execTitle}>Local executor detected</h2>
                {!executorHealth.executing ? (
                  <span className={styles.localExecChip}>watch-only</span>
                ) : null}
              </div>
              <div className={styles.localExecBody}>
                <label className={styles.localExecField}>
                  <span className={styles.fieldLabel}>Intake token</span>
                  <input
                    className={styles.input}
                    type="password"
                    placeholder="intake token — from `node executor/index.mjs status`"
                    value={intakeToken}
                    onChange={(event) => updateIntakeToken(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  data-busy={busy === "send"}
                  className={styles.btnPrimary}
                  disabled={busy !== null || !intakeToken.trim()}
                  onClick={() => void sendToExecutor()}
                  type="button"
                >
                  {busy === "send" ? "Delivering…" : record?.deliveredTo === "local-executor" ? "Send again" : "Send to executor"}
                </button>
                {record?.deliveredTo === "local-executor" ? (
                  <span className={styles.okStatus}>
                    <BlockGlyph name="check" className={styles.okGlyph} />
                    delivered to your local executor
                  </span>
                ) : null}
                {/* The chip alone says "watch-only" and nothing about what that costs you.
                    A daemon with no key simulates every run and broadcasts none, so an
                    intent delivered to it never executes. */}
                {!executorHealth.executing ? (
                  <span className={styles.stepCaption}>
                    Watch-only: no executor key is configured, so this daemon simulates runs and never broadcasts
                    one. It will hold the intent, not execute it.
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>

        <div className={styles.col}>
          <section className={styles.card} aria-label="Your automations">
            <div className={styles.railHead}>
              <h2 className={styles.railTitle}>Your automations</h2>
              {/* The visible word is one glance-sized "All"; the label spells out where
                  it goes, for anyone reading the link list out of context. */}
              <Link href="/profile" className={styles.railAll} aria-label="All automations in your profile">
                All
              </Link>
            </div>

            {record ? (
              <>
                <div className={styles.railItem}>
                  <div className={styles.railItemTop}>
                    <BlockGlyph
                      name={record.mode === "recurring" ? "repeat" : "band"}
                      className={styles.railItemGlyph}
                    />
                    <strong className={styles.railItemName}>{shortAddress(record.address)}</strong>
                    <span className={`${styles.railChip} ${railState.tone}`}>{railState.label}</span>
                  </div>
                  {progressTotal > 0 ? (
                    <div className={styles.progress} aria-hidden>
                      {Array.from({ length: progressTotal }, (_, i) => (
                        <i key={i} className={i < progressFilled ? `${styles.seg} ${styles.segOn}` : styles.seg} />
                      ))}
                    </div>
                  ) : null}
                  <span className={styles.railMeta}>{railMeta}</span>
                </div>

                <RailRow label="Zap" ok>
                  <a
                    className={styles.railRowMono}
                    href={explorerAddress(record.address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(record.address)}
                  </a>
                </RailRow>
                <RailRow label="Terms" ok>
                  {record.terms ??
                    (record.mode === "recurring"
                      ? `Recurring · ${runsInRecord(record)} Zaps · cadence set when you sign`
                      : "Price trigger · condition set when you sign")}
                </RailRow>
                <RailRow label="Funding" ok={funded}>
                  {!recordRoute
                    ? "—"
                    : capsuleBalance === null
                      ? "balance unavailable — refresh"
                      : `${formatToken(capsuleBalance, recordRoute.tokenIn.decimals)} / ${formatToken(remainingTarget, recordRoute.tokenIn.decimals)} ${recordRoute.tokenIn.symbol} remaining`}
                </RailRow>
                {status?.kind === "recurring" ? (
                  <RailRow label="Series" ok={!status.consumed}>
                    {status.consumed
                      ? "finished or cancelled"
                      : describeSeries(status.runs, status.lastRun, status.intent, status.nowSec)}
                  </RailRow>
                ) : null}
                {status?.kind === "trigger" ? (
                  <RailRow label="Trigger" ok={!status.consumed}>
                    {status.consumed
                      ? "fired or cancelled"
                      : status.armed
                        ? "ARMED — condition met, awaiting an executor"
                        : "waiting for the signed move"}
                  </RailRow>
                ) : null}

                <div className={styles.railActions}>
                  <button
                    data-busy={busy === "refresh"}
                    className={styles.btnGhost}
                    disabled={busy !== null}
                    onClick={() => void refresh()}
                    type="button"
                  >
                    {busy === "refresh" ? "Refreshing…" : "Refresh"}
                  </button>
                  {signed && status && !status.consumed ? (
                    <button
                      data-busy={busy === "cancel"}
                      className={styles.btnDanger}
                      disabled={wrongNetwork || busy !== null}
                      onClick={() => void cancelAutomation()}
                      type="button"
                    >
                      {busy === "cancel" ? "Cancelling…" : "Cancel automation"}
                    </button>
                  ) : null}
                  <button
                    data-busy={busy === "recover"}
                    className={styles.btnDanger}
                    disabled={wrongNetwork || busy !== null}
                    onClick={() => void recoverFunds()}
                    type="button"
                  >
                    {busy === "recover" ? "Recovering…" : "Recover funds"}
                  </button>
                </div>
              </>
            ) : (
              <p className={styles.railEmpty}>
                No automation yet. Create one and its state shows up here — the Zap, not the executor, holds every
                bound.
              </p>
            )}

            {otherRecords.length > 0 ? (
              <div className={styles.railList}>
                {otherRecords.map((r) => (
                  <button
                    key={r.address}
                    type="button"
                    className={styles.railItemBtn}
                    onClick={() => setSelected(r.address)}
                  >
                    {/* Geometry, not emoji: U+26A1 renders as full-colour Apple/Segoe emoji and broke
                        the monochrome list. BlockGlyph inherits the row's currentColor. */}
                    <BlockGlyph name={r.mode === "recurring" ? "repeat" : "band"} className={styles.railItemGlyph} />
                    {shortAddress(r.address)}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          <section className={styles.railSunk}>
            <h2 className={styles.railSunkTitle}>What the chain enforces</h2>
            <div className={styles.enforce}>
              {CHAIN_ENFORCES.map((line) => (
                <div className={styles.enforceRow} key={line}>
                  <BlockGlyph name="check" className={styles.enforceCheck} />
                  <span className={styles.enforceText}>{line}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.railSunk}>
            <h2 className={styles.railSunkTitle}>Protocol lottery</h2>
            <p className={styles.railProse}>
              Every automated Zap pays a {feePct}% fee from output: {executorPct}% of it to the executor that
              submitted it, the rest to the lottery pot, where a permissionless keeper call converts it to
              0xZAPS. Fees buy tickets automatically — round {pot ? `#${pot.round.toString()}` : "—"} holds{" "}
              {pot ? formatToken(pot.prize) : "—"} 0xZAPS
              {pot && account ? ` and this wallet holds ${formatToken(pot.tickets)} of ${formatToken(pot.totalTickets)} tickets` : ""}
              . Winner selection is governance-gated until a randomness design lands; payouts can only ever go to
              ticket holders, only in 0xZAPS.{" "}
              <Link href="/docs#automation" className={styles.railLink}>How the executor economy works →</Link>
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

// ---- module helpers (mirror Console.tsx conventions) ----

function automationCreationWorkspaceKey(owner: Address): string {
  return `${AUTOMATION_CREATION_WORKSPACE_KEY}:${owner.toLowerCase()}`;
}

function rememberAutomationCreationWorkspace(owner: Address, zap: Address): void {
  try {
    window.sessionStorage.setItem(automationCreationWorkspaceKey(owner), zap);
  } catch {
    // The in-memory receipt still survives until this route unmounts.
  }
}

function readAutomationCreationWorkspace(owner: Address): Address | null {
  try {
    const value = window.sessionStorage.getItem(automationCreationWorkspaceKey(owner));
    return value ? getAddress(value) : null;
  } catch {
    return null;
  }
}

function clearAutomationCreationWorkspace(owner: Address): void {
  try {
    window.sessionStorage.removeItem(automationCreationWorkspaceKey(owner));
  } catch {
    // The in-memory receipt is cleared by the caller either way.
  }
}

function shortHex(value: Hex): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function runsInRecord(record: AutomationRecord): number {
  if (record.mode === "trigger") return 1;
  if (record.intentFile) {
    const parsed = parseIntentFile(record.intentFile);
    if (parsed?.kind === "recurring") return (parsed.intent as RecurringIntent).maxRuns;
  }
  return record.plannedRuns ?? 1;
}

/** The record's frozen per-Zap amount, or null when the stored string is junk. */
function parseRecordAmount(record: AutomationRecord): bigint | null {
  try {
    return BigInt(record.amountPerRun);
  } catch {
    return null;
  }
}

/**
 * Number inputs hand back "" and "-" while you type, both of which parse to
 * NaN. Clamping here is what keeps `createCapsule`'s 1..1000 guard from
 * surfacing as an error toast instead of a disabled button.
 */
function clampInt(raw: string, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function parseAmountSafe(value: string, decimals: number): bigint {
  try {
    return parseRouterAmount(value, decimals);
  } catch {
    return 0n;
  }
}

/**
 * What the capsule still needs to hold for every run that can still happen: per-run amount times
 * REMAINING runs. Executed runs have already spent their share — counting them again would make
 * the Fund step demand money nothing will ever spend.
 */
function remainingFundingTarget(record: AutomationRecord, status: AutomationStatus | null): bigint {
  let perRun: bigint;
  try {
    perRun = BigInt(record.amountPerRun);
  } catch {
    return 0n;
  }
  if (record.mode === "trigger") {
    if (status?.kind === "trigger" && status.consumed) return 0n;
    return perRun;
  }
  const total = runsInRecord(record);
  if (status?.kind === "recurring") {
    if (status.consumed) return 0n;
    const left = total - status.runs;
    return left > 0 ? perRun * BigInt(left) : 0n;
  }
  return perRun * BigInt(total);
}

function parseIntentFile(raw: string): { kind: AutomationMode; intent: RecurringIntent | TriggerIntent } | null {
  try {
    const parsed = JSON.parse(raw) as { kind?: string; intent?: Record<string, string | boolean> };
    const isRecurring = parsed.kind === "recurring" || parsed.kind === "recurring-relative";
    if ((!isRecurring && parsed.kind !== "trigger") || !parsed.intent) return null;
    const i = parsed.intent;
    const big = (key: string) => BigInt(String(i[key]));
    const addr = (key: string) => getAddress(String(i[key]));
    if (isRecurring) {
      // Both recurring kinds share the series shape the status panel needs (seriesId/interval/
      // maxRuns). The relative kind has no minOutPerRun; use 0n — status reads never consult it.
      const intent: RecurringIntent = {
        zap: addr("zap"),
        chainId: big("chainId"),
        seriesId: big("seriesId"),
        validAfter: big("validAfter"),
        deadline: big("deadline"),
        interval: big("interval"),
        maxRuns: Number(i.maxRuns),
        recipient: addr("recipient"),
        executor: addr("executor"),
        maxGas: big("maxGas"),
        maxFeePerGas: big("maxFeePerGas"),
        policyHash: String(i.policyHash) as Hex,
        outAsset: addr("outAsset"),
        minOutPerRun: "minOutPerRun" in i ? big("minOutPerRun") : 0n,
      };
      return { kind: "recurring", intent };
    }
    const intent: TriggerIntent = {
      zap: addr("zap"),
      chainId: big("chainId"),
      nonce: big("nonce"),
      validAfter: big("validAfter"),
      deadline: big("deadline"),
      priceSource: addr("priceSource"),
      baselinePriceX96: big("baselinePriceX96"),
      thresholdBps: Number(i.thresholdBps),
      above: i.above === true,
      recipient: addr("recipient"),
      executor: addr("executor"),
      maxGas: big("maxGas"),
      maxFeePerGas: big("maxFeePerGas"),
      policyHash: String(i.policyHash) as Hex,
      outAsset: addr("outAsset"),
      minOut: big("minOut"),
    };
    return { kind: "trigger", intent };
  } catch {
    return null;
  }
}

/** All chain reads for the status panel, off the render path. Pure with respect to React. */
async function loadAutomationStatus(
  record: AutomationRecord | null,
  recordRoute: Route | null,
): Promise<{ balance: bigint | null; status: AutomationStatus | null }> {
  if (!record) return { balance: null, status: null };
  let balance: bigint | null = null;
  if (recordRoute) {
    balance = await publicClient.readContract({
      address: recordRoute.tokenIn.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [record.address],
    });
  }
  if (!record.intentFile) return { balance, status: null };
  const parsed = parseIntentFile(record.intentFile);
  if (!parsed) return { balance, status: null };

  if (parsed.kind === "recurring") {
    const intent = parsed.intent as RecurringIntent;
    const [[runs, lastRun], consumed] = await Promise.all([
      publicClient.readContract({ address: record.address, abi: openZapV3Abi, functionName: "series", args: [intent.seriesId] }),
      publicClient.readContract({ address: record.address, abi: openZapV3Abi, functionName: "nonceUsed", args: [intent.seriesId] }),
    ]);
    return {
      balance,
      status: {
        kind: "recurring",
        runs: Number(runs),
        lastRun: BigInt(lastRun),
        consumed,
        intent,
        nowSec: BigInt(Math.floor(Date.now() / 1000)),
      },
    };
  }
  const intent = parsed.intent as TriggerIntent;
  const [consumed, priceX96] = await Promise.all([
    publicClient.readContract({ address: record.address, abi: openZapV3Abi, functionName: "nonceUsed", args: [intent.nonce] }),
    publicClient.readContract({ address: intent.priceSource, abi: priceSourceAbi, functionName: "priceX96" }),
  ]);
  return {
    balance,
    status: {
      kind: "trigger",
      consumed,
      armed: isTriggerArmed(priceX96, intent.baselinePriceX96, intent.thresholdBps, intent.above),
      priceX96,
      boundX96: triggerBoundX96(intent.baselinePriceX96, intent.thresholdBps, intent.above),
      intent,
    },
  };
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

function readableError(cause: unknown): string {
  if (cause instanceof Error) {
    const firstLine = cause.message.split("\n")[0];
    return firstLine.replace("User rejected the request.", "Wallet request rejected.");
  }
  return "Unknown wallet or RPC error.";
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

/**
 * One lifecycle step.
 *
 * Only the step you are on expands. The prototype collapses create/fund/sign
 * into a single "Sign intent" button, which this flow cannot do — they are four
 * separate wallet actions — but showing all four in full turns the console into
 * a wall, so the ones behind and ahead of you stay one line each.
 */
function Step({ index, glyph, title, detail, state, children }: {
  index: number;
  /** BlockGlyph name — the step's meaning at a glance, beside the counter. */
  glyph: string;
  title: string;
  detail: string;
  state: StepState;
  children?: React.ReactNode;
}): React.JSX.Element {
  const hasActions = Array.isArray(children) ? children.some((child) => Boolean(child)) : Boolean(children);
  // A step you cannot reach yet stays a one-liner even when its controls would
  // render: a disabled "Create Zap" under a greyed row is an invitation to
  // click the thing that cannot work.
  const showActions = hasActions && state !== "pending";
  return (
    <div className={styles.step} data-state={state}>
      <span className={styles.stepMark}>
        {state === "done" ? <BlockGlyph name="check" className={styles.stepCheck} /> : index}
      </span>
      <div className={styles.stepBody}>
        <span className={styles.stepTitle}>
          <BlockGlyph name={glyph} className={styles.stepGlyph} />
          {title}
        </span>
        {state === "current" ? <p className={styles.stepDetail}>{detail}</p> : null}
        {showActions ? <div className={styles.stepActions}>{children}</div> : null}
      </div>
    </div>
  );
}

function RailRow({ label, ok, children }: {
  label: string;
  ok: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  // data-ok drives the failed state: every value used to render in the same
  // colour, so a check that did NOT pass looked exactly like one that did.
  return (
    <div className={styles.railRow} data-ok={ok}>
      <span className={styles.railRowLabel}>{label}</span>
      <span className={styles.railRowValue}>{children}</span>
    </div>
  );
}
