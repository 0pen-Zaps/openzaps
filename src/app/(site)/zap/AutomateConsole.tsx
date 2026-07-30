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
  isAddressEqual,
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
  STACK_PRESETS,
  THRESHOLD_PRESETS,
  automationModeForIntentKind,
  defaultSlippageBps,
  describeSeries,
  draftRecurringRelativeIntent,
  draftRecurringStackIntent,
  draftTriggerIntent,
  feedConditionForZapsMove,
  fundingReadiness,
  intentFileName,
  isRecurringIntentKind,
  netFloorFromQuote,
  planWethFunding,
  projectedRelativeFloor,
  projectedStackRecipientFloor,
  readAutomationHandoff,
  verifyFundingConfirmation,
  type AutomationIntentKind,
  type AutomationMode,
} from "@/lib/automate";
import {
  MAX_SAVED_AUTOMATIONS,
  parseAutomationIntent,
  readAutomationRecords,
  saveAutomationRecords,
  type AutomationRecord,
} from "@/lib/automation-records";
import { matchesCreationGatewayProvenance } from "@/lib/creation-gateway-provenance";
import {
  automationFeeLineageKey,
  matchesAutomationFactoryProvenance,
} from "@/lib/automation-factory-provenance";
import {
  POLICY_HALT_CONFIRMATION,
  type PolicyHaltStatus,
} from "@/lib/policy-halt";
import { consumeIntent, publishIntent, type RelaySubmission } from "@/lib/relay";
import {
  EXEC_FEE_BPS,
  EXECUTOR_SHARE_BPS,
  buildRecurringRelativeTypedData,
  buildRecurringStackTypedData,
  buildTriggerTypedData,
  isTriggerArmed,
  serializeIntentFile,
  slippageClearsFee,
  triggerBoundX96,
} from "@/lib/executions";
import {
  buildRoutePolicy,
  expectedCloneRuntime,
  hashRobinhoodPolicy,
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
  OPENZAP_CONTRACTS,
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  OPENZAP_V3_2_CONTRACTS,
  openZapV3_1Configured,
  openZapV3_2Configured,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_RPC_URL,
  allowlistReadAbi,
  ensureRobinhoodChain,
  erc20Abi,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  lotteryPotAbi,
  openZapCreationFeeConfigured,
  openZapCreationGatewayAbi,
  openZapFactoryV3Abi,
  openZapPolicyHaltAbi,
  openZapStackCreationGatewayAbi,
  openZapV3Abi,
  openZapV3_2ProvenanceAbi,
  openZapV3Configured,
  orientedPriceSourceAbi,
  priceSourceAbi,
  ROBINHOOD_ASSETS,
  zapCreationFeePotAbi,
  wethAbi,
  robinhoodChain,
  v4QuoterAbi,
} from "@/lib/robinhood";
import styles from "./automate.module.css";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

// ETH left unwrapped so the wrap + transfer can still pay for gas. Robinhood Chain is an L2 with
// cheap gas; 0.0005 ETH covers both txs comfortably while staying negligible against a real deposit.
const WRAP_GAS_RESERVE = 500_000_000_000_000n; // 0.0005 ETH

type BusyAction =
  | "connect"
  | "create"
  | "fund"
  | "sign"
  | "cancel"
  | "recover"
  | "halt"
  | "refresh"
  | "publish"
  | null;
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

interface SeriesStatus {
  kind: "recurring";
  runs: number;
  lastRun: bigint;
  consumed: boolean;
  intent: { maxRuns: number; interval: bigint };
  /** Clock captured at load time, so render stays pure. */
  nowSec: bigint;
}

interface TriggerStatus {
  kind: "trigger";
  consumed: boolean;
  armed: boolean;
  priceX96: bigint;
  boundX96: bigint;
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
  policyHalt: AutomationPolicyHaltState;
}

interface AutomationPolicyHaltState {
  status: PolicyHaltStatus;
  policyHalted: boolean | null;
  owner: Address | null;
  blockNumber: bigint | null;
}

interface PotStatus {
  round: bigint;
  prize: bigint;
  tickets: bigint;
  totalTickets: bigint;
}

/**
 * The Automate surface: the three standing-authorization lineages. A capsule is created against
 * its pinned factory,
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
  /**
   * The agent a `?agent=` link proposes to pin.
   *
   * Deliberately NOT part of `readAutomationHandoff`: that function validates the
   * signed policy's fields, and a proposed executor is neither signed nor part of
   * the policy. It only prefills the "Pinned" input below, which the user still
   * sees and still has to sign over.
   */
  const proposedAgent = useMemo(() => {
    const raw = searchParams.get("agent");
    return raw && isAddress(raw) ? getAddress(raw) : null;
  }, [searchParams]);
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
  const [creationFeeQuoteState, setCreationFeeQuoteState] = useState<{
    lineageKey: string;
    quote: CreationFeeQuote | null;
    error: string;
  } | null>(null);

  const [intentKind, setIntentKind] = useState<AutomationIntentKind>(
    handoff?.mode === "trigger" ? "trigger" : "recurring-relative",
  );
  const mode = automationModeForIntentKind(intentKind);
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
  // A proposed agent means the user came from Connect having chosen "pin one
  // agent", so open on that option with the address filled in — but as a
  // prefill, never a commitment: it is visible, editable, and still signed over.
  const [executorMode, setExecutorMode] = useState<ExecutorMode>(
    proposedAgent ? "custom" : (handoff?.executionPolicy.executorAccess ?? "anyone"),
  );
  const [customExecutor, setCustomExecutor] = useState(proposedAgent ?? "");

  /** Switch exact lineage and reset slippage to a valid default for that lineage. */
  const selectIntentKind = useCallback(
    (next: AutomationIntentKind) => {
      if (next === intentKind) return;
      setIntentKind(next);
      setSlippageBps(defaultSlippageBps(automationModeForIntentKind(next)));
    },
    [intentKind],
  );
  const [intervalId, setIntervalId] = useState(handoff?.intervalId ?? "daily");
  const [maxRuns, setMaxRuns] = useState(handoff?.maxRuns ?? 10);
  const [stackBps, setStackBps] = useState(STACK_PRESETS[1].bps);
  const [recurringValidDays, setRecurringValidDays] = useState<number | null>(
    handoff?.mode === "recurring" ? handoff.validDays : null,
  );
  const [thresholdId, setThresholdId] = useState(handoff?.thresholdId ?? "up10");
  const [validDays, setValidDays] = useState(handoff?.mode === "trigger" ? handoff.validDays ?? 30 : 30);

  const [records, setRecords] = useState<AutomationRecord[]>([]);
  const [creationResult, setCreationResult] = useState<CreatedAutomationResult | null>(null);
  const [selected, setSelected] = useState<Address | null>(null);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [haltConfirmation, setHaltConfirmation] = useState("");
  const [pot, setPot] = useState<PotStatus | null>(null);
  /** Oriented price-source spot, read for the relative-floor preview. null = unreadable → render "—". */
  const [spot, setSpot] = useState<{ priceX96: bigint; currency0: Address; currency1: Address } | null>(null);
  /** Connected wallet's balance of the funding asset, TAGGED with the token it was read for — so a
   *  balance for the previous route can never be compared against a new route's need (cf. LoadedState
   *  .address). null = not read → "unknown" preflight. */
  const [walletBalance, setWalletBalance] = useState<{ token: Address; balance: bigint } | null>(null);
  /** Connected wallet's native ETH balance — lets the app wrap ETH→aeWETH to fund an aeWETH zap. */
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
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
  const activeStackBps = record?.stackBps ?? stackBps;
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
  const activeIntentKind: AutomationIntentKind = record?.intentKind ?? intentKind;
  const activeMode: AutomationMode = automationModeForIntentKind(activeIntentKind);
  const activeContracts =
    activeIntentKind === "recurring-stack"
      ? OPENZAP_V3_2_CONTRACTS
      : activeIntentKind === "recurring-relative"
        ? OPENZAP_V3_1_CONTRACTS
        : OPENZAP_V3_CONTRACTS;

  // Each lineage gates only on the immutable stack it actually uses. v3.2 includes its dedicated
  // stack-only creation gateway and creation pot in the same seven-address fail-closed set.
  const configured =
    activeIntentKind === "recurring-stack"
      ? openZapV3_2Configured()
      : activeIntentKind === "recurring-relative"
        ? openZapV3Configured() && openZapV3_1Configured()
        : openZapV3Configured();
  const activeCreationFeeContracts =
    activeIntentKind === "recurring-stack"
      ? {
          gateway: OPENZAP_V3_2_CONTRACTS.creationGateway,
          pot: OPENZAP_V3_2_CONTRACTS.creationFeePot,
        }
      : OPENZAP_CREATION_FEE_CONTRACTS;
  const activePriceSource =
    activeIntentKind === "recurring-stack"
      ? OPENZAP_V3_2_CONTRACTS.orientedPriceSource
      : activeIntentKind === "recurring-relative"
        ? OPENZAP_V3_1_CONTRACTS.orientedPriceSource
        : OPENZAP_V3_CONTRACTS.poolPriceSource;
  // Bind every asynchronous readiness/quote result to the exact lineage it proved. A render that
  // switches lineages computes a different key immediately, so a previously verified gateway can
  // never transiently enable creation while the replacement lineage is still being read.
  const feeProvenanceKey = automationFeeLineageKey({
    intentKind: activeIntentKind,
    factory: activeContracts.factory,
    implementation: activeContracts.implementation,
    priceSourceRegistry: activeContracts.priceSourceRegistry,
    lotteryPot: activeContracts.lotteryPot,
    activePriceSource,
    creationGateway: activeCreationFeeContracts.gateway,
    creationPot: activeCreationFeeContracts.pot,
  });
  const feeConfigPresent =
    activeIntentKind === "recurring-stack" ? openZapV3_2Configured() : openZapCreationFeeConfigured();
  const [feeGatewayProof, setFeeGatewayProof] = useState<{ lineageKey: string; ready: boolean } | null>(null);
  const feeGatewayReady =
    feeGatewayProof?.lineageKey === feeProvenanceKey && feeGatewayProof.ready;
  const feeConfigured = feeConfigPresent && feeGatewayReady;
  const creationFeeQuote =
    creationFeeQuoteState?.lineageKey === feeProvenanceKey ? creationFeeQuoteState.quote : null;
  const creationFeeError =
    creationFeeQuoteState?.lineageKey === feeProvenanceKey ? creationFeeQuoteState.error : "";
  const creationFeeQuoteEpochRef = useRef(0);

  // Loaded chain state counts for the SELECTED capsule only; anything else is a stale response.
  const loadedForRecord = record && loaded && loaded.address === record.address ? loaded : null;
  const capsuleBalance = loadedForRecord ? loadedForRecord.balance : null;
  const status = loadedForRecord?.status ?? null;
  const policyHalt = loadedForRecord?.policyHalt ?? (
    record?.intentKind === "recurring-stack"
      ? { status: "unavailable" as const, policyHalted: null, owner: null, blockNumber: null }
      : { status: "unsupported" as const, policyHalted: null, owner: null, blockNumber: null }
  );
  const policyExecutionBlocked =
    policyHalt.status === "halted"
    || (record?.intentKind === "recurring-stack" && policyHalt.status === "unavailable");

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
  const projectedRecipientFloor =
    activeIntentKind === "recurring-stack"
      ? projectedStackRecipientFloor(projectedFloor, activeStackBps)
      : projectedFloor;

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
        setLoaded({
          address: target.address,
          balance: result.balance,
          status: result.status,
          policyHalt: result.policyHalt,
        });
      }
    } catch {
      // Fail closed: unavailable, never a fake zero.
      if (loadEpochRef.current === epoch) {
        setLoaded({
          address: target.address,
          balance: null,
          status: null,
          policyHalt: target.intentKind === "recurring-stack"
            ? { status: "unavailable", policyHalted: null, owner: null, blockNumber: null }
            : { status: "unsupported", policyHalted: null, owner: null, blockNumber: null },
        });
      }
    }
  }, []);

  useEffect(() => {
    // Deferred through a microtask so every setState happens in an async continuation, never
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => applyLoad(record));
  }, [record, applyLoad]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setHaltConfirmation("");
    });
    return () => {
      cancelled = true;
    };
  }, [record?.address]);

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

  // ---- creation-gateway provenance ----
  // Non-zero env values are not enough: a stale or miswired gateway would still prompt a wallet.
  // Read back bytecode, fee, pot binding, version, and the exact immutable factory before enabling
  // creation. This is especially load-bearing for v3.2, whose stack-only gateway is a new lineage.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      if (!feeConfigPresent || !configured) {
        if (!cancelled) setFeeGatewayProof({ lineageKey: feeProvenanceKey, ready: false });
        return;
      }
      try {
        const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
        const expectedFactoryVersion =
          activeIntentKind === "recurring-stack"
            ? "3.2.0-candidate"
            : activeIntentKind === "recurring-relative"
              ? "3.1.0-candidate"
              : "3.0.0-candidate";
        const [
          factoryCode,
          implementationCode,
          adapterRegistryCode,
          tokenAllowlistCode,
          priceSourceRegistryCode,
          lotteryPotCode,
          activePriceSourceCode,
          activePriceSourceAllowed,
          factoryImplementation,
          factoryImplementationHash,
          factoryVersion,
          factoryAdapters,
          factoryTokens,
          factoryPriceSources,
          factoryLotteryPot,
          implementationFactory,
          implementationAdapters,
          implementationTokens,
          implementationPriceSources,
          implementationLotteryPot,
        ] = await Promise.all([
          publicClient.getBytecode({ address: activeContracts.factory, blockNumber }),
          publicClient.getBytecode({ address: activeContracts.implementation, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.adapterRegistry, blockNumber }),
          publicClient.getBytecode({ address: OPENZAP_CONTRACTS.tokenAllowlist, blockNumber }),
          publicClient.getBytecode({ address: activeContracts.priceSourceRegistry, blockNumber }),
          publicClient.getBytecode({ address: activeContracts.lotteryPot, blockNumber }),
          publicClient.getBytecode({ address: activePriceSource, blockNumber }),
          publicClient.readContract({
            address: activeContracts.priceSourceRegistry,
            abi: allowlistReadAbi,
            functionName: "isAllowed",
            args: [activePriceSource],
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.factory,
            abi: openZapFactoryV3Abi,
            functionName: "implementation",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.factory,
            abi: openZapFactoryV3Abi,
            functionName: "implCodeHash",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.factory,
            abi: openZapFactoryV3Abi,
            functionName: "VERSION",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.factory,
            abi: openZapFactoryV3Abi,
            functionName: "adapters",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.factory,
            abi: openZapFactoryV3Abi,
            functionName: "tokens",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.factory,
            abi: openZapFactoryV3Abi,
            functionName: "priceSources",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.factory,
            abi: openZapFactoryV3Abi,
            functionName: "lotteryPot",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.implementation,
            abi: openZapV3Abi,
            functionName: "FACTORY",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.implementation,
            abi: openZapV3Abi,
            functionName: "ADAPTERS",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.implementation,
            abi: openZapV3Abi,
            functionName: "TOKENS",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.implementation,
            abi: openZapV3Abi,
            functionName: "PRICE_SOURCES",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeContracts.implementation,
            abi: openZapV3Abi,
            functionName: "LOTTERY_POT",
            blockNumber,
          }),
        ]);
        const stackImplementationBindings =
          activeIntentKind === "recurring-stack"
            ? await Promise.all([
                publicClient.readContract({
                  address: activeContracts.implementation,
                  abi: openZapV3_2ProvenanceAbi,
                  functionName: "ZAPS",
                  blockNumber,
                }),
                publicClient.readContract({
                  address: activeContracts.implementation,
                  abi: openZapV3_2ProvenanceAbi,
                  functionName: "ZAPS_ADAPTER",
                  blockNumber,
                }),
                publicClient.getBytecode({ address: ROBINHOOD_ASSETS.zaps, blockNumber }),
                publicClient.getBytecode({ address: OPENZAP_CONTRACTS.adapter, blockNumber }),
                publicClient.readContract({
                  address: OPENZAP_CONTRACTS.tokenAllowlist,
                  abi: allowlistReadAbi,
                  functionName: "isAllowed",
                  args: [ROBINHOOD_ASSETS.zaps],
                  blockNumber,
                }),
                publicClient.readContract({
                  address: OPENZAP_CONTRACTS.adapterRegistry,
                  abi: allowlistReadAbi,
                  functionName: "isAllowed",
                  args: [OPENZAP_CONTRACTS.adapter],
                  blockNumber,
                }),
              ])
            : null;
        const factoryReady = matchesAutomationFactoryProvenance(
          {
            factory: activeContracts.factory,
            implementation: activeContracts.implementation,
            version: expectedFactoryVersion,
            adapterRegistry: OPENZAP_CONTRACTS.adapterRegistry,
            tokenAllowlist: OPENZAP_CONTRACTS.tokenAllowlist,
            priceSourceRegistry: activeContracts.priceSourceRegistry,
            lotteryPot: activeContracts.lotteryPot,
            stack:
              activeIntentKind === "recurring-stack"
                ? {
                    zaps: ROBINHOOD_ASSETS.zaps,
                    zapsAdapter: OPENZAP_CONTRACTS.adapter,
                  }
                : null,
          },
          {
            factoryCode,
            implementationCode,
            adapterRegistryCode,
            tokenAllowlistCode,
            priceSourceRegistryCode,
            lotteryPotCode,
            activePriceSourceCode,
            activePriceSourceAllowed,
            factoryImplementation,
            factoryImplementationHash,
            factoryVersion,
            factoryAdapters,
            factoryTokens,
            factoryPriceSources,
            factoryLotteryPot,
            implementationFactory,
            implementationAdapters,
            implementationTokens,
            implementationPriceSources,
            implementationLotteryPot,
            stack:
              stackImplementationBindings === null
                ? null
                : {
                    implementationZaps: stackImplementationBindings[0],
                    implementationZapsAdapter: stackImplementationBindings[1],
                    zapsCode: stackImplementationBindings[2],
                    zapsAdapterCode: stackImplementationBindings[3],
                    zapsAllowed: stackImplementationBindings[4],
                    zapsAdapterAllowed: stackImplementationBindings[5],
                  },
          },
        );
        const [gatewayCode, potCode, potGateway, potZaps] = await Promise.all([
          publicClient.getBytecode({ address: activeCreationFeeContracts.gateway, blockNumber }),
          publicClient.getBytecode({ address: activeCreationFeeContracts.pot, blockNumber }),
          publicClient.readContract({
            address: activeCreationFeeContracts.pot,
            abi: zapCreationFeePotAbi,
            functionName: "gateway",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeCreationFeeContracts.pot,
            abi: zapCreationFeePotAbi,
            functionName: "ZAPS",
            blockNumber,
          }),
        ]);
        const provenanceGatewayAbi =
          activeIntentKind === "recurring-stack"
            ? openZapStackCreationGatewayAbi
            : openZapCreationGatewayAbi;
        const [gatewayWeth, gatewayZaps, gatewayAdapter] = await Promise.all([
          publicClient.readContract({
            address: activeCreationFeeContracts.gateway,
            abi: provenanceGatewayAbi,
            functionName: "AEWETH",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeCreationFeeContracts.gateway,
            abi: provenanceGatewayAbi,
            functionName: "ZAPS",
            blockNumber,
          }),
          publicClient.readContract({
            address: activeCreationFeeContracts.gateway,
            abi: provenanceGatewayAbi,
            functionName: "CREATION_ADAPTER",
            blockNumber,
          }),
        ]);

        let gatewayPot: Address;
        let gatewayFee: bigint;
        let gatewayFactory: Address;
        let gatewayVersion: string;
        if (activeIntentKind === "recurring-stack") {
          [gatewayPot, gatewayFee, gatewayFactory, gatewayVersion] = await Promise.all([
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapStackCreationGatewayAbi,
              functionName: "CREATION_POT",
              blockNumber,
            }),
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapStackCreationGatewayAbi,
              functionName: "CREATION_FEE",
              blockNumber,
            }),
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapStackCreationGatewayAbi,
              functionName: "STACK_FACTORY",
              blockNumber,
            }),
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapStackCreationGatewayAbi,
              functionName: "VERSION",
              blockNumber,
            }),
          ]);
        } else {
          const lineage = activeIntentKind === "trigger" ? 1 : 2;
          [gatewayPot, gatewayFee, gatewayFactory, gatewayVersion] = await Promise.all([
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapCreationGatewayAbi,
              functionName: "CREATION_POT",
              blockNumber,
            }),
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapCreationGatewayAbi,
              functionName: "CREATION_FEE",
              blockNumber,
            }),
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapCreationGatewayAbi,
              functionName: "lineageFactory",
              args: [lineage],
              blockNumber,
            }),
            publicClient.readContract({
              address: activeCreationFeeContracts.gateway,
              abi: openZapCreationGatewayAbi,
              functionName: "VERSION",
              blockNumber,
            }),
          ]);
        }

        const ready = factoryReady && matchesCreationGatewayProvenance(
          {
            gateway: activeCreationFeeContracts.gateway,
            pot: activeCreationFeeContracts.pot,
            factory: activeContracts.factory,
            weth: ROBINHOOD_ASSETS.weth,
            zaps: ROBINHOOD_ASSETS.zaps,
            adapter: OPENZAP_CONTRACTS.adapter,
            fee: OPENZAP_CREATION_FEE,
            version: "1.0.0-candidate",
          },
          {
            gatewayCode,
            potCode,
            gatewayPot,
            potGateway,
            potZaps,
            gatewayFactory,
            gatewayWeth,
            gatewayZaps,
            gatewayAdapter,
            fee: gatewayFee,
            version: gatewayVersion,
          },
        );
        if (!cancelled) setFeeGatewayProof({ lineageKey: feeProvenanceKey, ready });
      } catch {
        if (!cancelled) setFeeGatewayProof({ lineageKey: feeProvenanceKey, ready: false });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    activeContracts.factory,
    activeContracts.implementation,
    activeContracts.lotteryPot,
    activeContracts.priceSourceRegistry,
    activeCreationFeeContracts.gateway,
    activeCreationFeeContracts.pot,
    activeIntentKind,
    activePriceSource,
    configured,
    feeConfigPresent,
    feeProvenanceKey,
    notice,
  ]);

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
    if (configured) {
      void load();
    } else {
      void Promise.resolve().then(() => {
        if (!cancelled) setPot(null);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [account, configured, notice, activePot]);

  // ---- oriented spot (relative-floor preview) ----
  // Read the active relative/stack price source, so the create form can show the
  // concrete per-run floor a chosen slippage implies at today's price. Read once on mount and after
  // each action (notice); the capsule always recomputes from live spot, so a slightly stale preview
  // is honest as long as it is labelled indicative. Fails closed to null → the UI renders "—".
  const orientedSource =
    activeIntentKind === "recurring-stack"
      ? OPENZAP_V3_2_CONTRACTS.orientedPriceSource
      : OPENZAP_V3_1_CONTRACTS.orientedPriceSource;
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
    if (isRecurringIntentKind(activeIntentKind) && configured) {
      void load();
    } else {
      void Promise.resolve().then(() => {
        if (!cancelled) setSpot(null);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [activeIntentKind, configured, notice, orientedSource]);

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
    const quoteEpoch = ++creationFeeQuoteEpochRef.current;
    if (!feeConfigured) {
      setCreationFeeQuoteState({
        lineageKey: feeProvenanceKey,
        quote: null,
        error: feeConfigPresent
          ? "Creation-fee gateway provenance is not verified. New automation creation is paused."
          : "Creation-fee gateway is not configured. New automation creation is paused.",
      });
      return null;
    }
    try {
      const next = await quoteCreationFee(publicClient, account ?? zeroAddress);
      if (quoteEpoch !== creationFeeQuoteEpochRef.current) return null;
      setCreationFeeQuoteState({ lineageKey: feeProvenanceKey, quote: next, error: "" });
      return next;
    } catch (cause) {
      if (quoteEpoch !== creationFeeQuoteEpochRef.current) return null;
      setCreationFeeQuoteState({
        lineageKey: feeProvenanceKey,
        quote: null,
        error: `Creation-fee quote unavailable: ${readableError(cause)}`,
      });
      return null;
    }
  }, [account, feeConfigPresent, feeConfigured, feeProvenanceKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCreationFeeQuote(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshCreationFeeQuote]);

  // ---- actions ----

  const createCapsule = useCallback(async () => {
    setBusy("create");
    setError("");
    try {
      if (!configured) throw new Error(`The ${automationLineageLabel(intentKind)} contract set is not configured.`);
      if (!feeConfigured || activeCreationFeeContracts.gateway === zeroAddress) {
        throw new Error("Creation-fee gateway is not configured and verified. New automation creation is paused.");
      }
      if (!creationFeeQuote) throw new Error("Review a creation-fee conversion quote before creating this automation.");
      const owner = requireAccount(account);
      const activeRoute = route;
      if (!activeRoute) throw new Error("Route unavailable.");
      if (perRunAmount <= 0n) throw new Error("Enter a per-Zap amount first.");
      if (isRecurringIntentKind(intentKind) && (maxRuns < 1 || maxRuns > 1000)) {
        throw new Error("Total Zaps must be between 1 and 1000.");
      }

      const contractSet =
        intentKind === "recurring-stack"
          ? OPENZAP_V3_2_CONTRACTS
          : intentKind === "recurring-relative"
            ? OPENZAP_V3_1_CONTRACTS
            : OPENZAP_V3_CONTRACTS;
      const wallet = await requireWallet(owner);
      const policy = buildRoutePolicy(owner, activeRoute, perRunAmount);
      const salt = randomHex32();
      const predicted = await publicClient.readContract({
        address: contractSet.factory,
        abi: openZapFactoryV3Abi,
        functionName: "predict",
        args: [policy, salt],
      });
      let hash: Hex;
      if (intentKind === "recurring-stack") {
        const { request } = await publicClient.simulateContract({
          account: owner,
          address: activeCreationFeeContracts.gateway,
          abi: openZapStackCreationGatewayAbi,
          functionName: "createZap",
          args: [policy, salt, creationFeeQuote.minZapsOut],
          value: OPENZAP_CREATION_FEE,
        });
        hash = await wallet.writeContract(request);
      } else {
        const { request } = await publicClient.simulateContract({
          account: owner,
          address: activeCreationFeeContracts.gateway,
          abi: openZapCreationGatewayAbi,
          functionName: "createZap",
          args: [intentKind === "recurring-relative" ? 2 : 1, policy, salt, creationFeeQuote.minZapsOut],
          value: OPENZAP_CREATION_FEE,
        });
        hash = await wallet.writeContract(request);
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Creation gateway transaction reverted.");

      // Verify the clone, owner, factory, and frozen policy at the receipt block
      // before persisting or offering a funding action.
      const expectedPolicyHash = hashRobinhoodPolicy(policy);
      const [
        code,
        policyHash,
        capsuleOwner,
        capsuleRecipient,
        capsuleFactory,
        capsuleStepCount,
        policyHalted,
      ] = await Promise.all([
        publicClient.getCode({ address: predicted, blockNumber: receipt.blockNumber }),
        publicClient.readContract({
          address: predicted,
          abi: openZapV3Abi,
          functionName: "policyHash",
          blockNumber: receipt.blockNumber,
        }),
        publicClient.readContract({
          address: predicted,
          abi: openZapV3Abi,
          functionName: "owner",
          blockNumber: receipt.blockNumber,
        }),
        publicClient.readContract({
          address: predicted,
          abi: openZapV3Abi,
          functionName: "recipient",
          blockNumber: receipt.blockNumber,
        }),
        publicClient.readContract({
          address: predicted,
          abi: openZapV3Abi,
          functionName: "FACTORY",
          blockNumber: receipt.blockNumber,
        }),
        publicClient.readContract({
          address: predicted,
          abi: openZapV3Abi,
          functionName: "stepCount",
          blockNumber: receipt.blockNumber,
        }),
        intentKind === "recurring-stack"
          ? publicClient.readContract({
              address: predicted,
              abi: openZapPolicyHaltAbi,
              functionName: "policyHalted",
              blockNumber: receipt.blockNumber,
            })
          : Promise.resolve(null),
      ]);
      if (
        code?.toLowerCase() !== expectedCloneRuntime(contractSet.implementation).toLowerCase()
        || policyHash.toLowerCase() !== expectedPolicyHash.toLowerCase()
        || !isAddressEqual(capsuleOwner, owner)
        || !isAddressEqual(capsuleRecipient, owner)
        || !isAddressEqual(capsuleFactory, contractSet.factory)
        || capsuleStepCount !== BigInt(policy.steps.length)
        || policyHalted === true
      ) {
        throw new Error(
          "The confirmed Zap did not match the intended canonical factory, owner, policy, or active state. Do not fund it.",
        );
      }

      const next: CreatedAutomationResult = {
        address: predicted,
        routeId: activeRoute.id,
        mode,
        intentKind,
        amountPerRun: perRunAmount.toString(),
        createdAt: new Date().toISOString(),
        policyHash,
        createTx: hash,
        plannedRuns: isRecurringIntentKind(intentKind) ? maxRuns : undefined,
        stackBps: intentKind === "recurring-stack" ? stackBps : undefined,
      };
      persist([next, ...records].slice(0, MAX_SAVED_AUTOMATIONS));
      rememberAutomationCreationWorkspace(owner, predicted);
      setCreationResult(next);
      setSelected(predicted);
      setNotice(
        `${automationLineageLabel(intentKind)} Zap created and verified at ${shortAddress(predicted)}. The ${formatToken(OPENZAP_CREATION_FEE, 18)} ETH fee converted with the reviewed ${formatToken(creationFeeQuote.minZapsOut, 18)} 0xZAPS floor. Fund it next.`,
      );
      trackEvent("automate_create", { mode, fee: OPENZAP_CREATION_FEE.toString() });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [
    account,
    activeCreationFeeContracts.gateway,
    configured,
    creationFeeQuote,
    feeConfigured,
    intentKind,
    maxRuns,
    mode,
    perRunAmount,
    persist,
    records,
    route,
    stackBps,
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
      `Lineage: ${automationLineageLabel(creationResult.intentKind)}`,
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
      requirePolicyExecutionAvailable(fresh.policyHalt, record.intentKind);
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      await verifyFundingConfirmation({
        receiptStatus: receipt.status,
        receiptBlockNumber: receipt.blockNumber,
        target,
        readBalance: (blockNumber) => publicClient.readContract({
          address: recordRoute.tokenIn.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [record.address],
          blockNumber,
        }),
      });
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
      const fresh = await loadAutomationStatus(record, recordRoute);
      requirePolicyExecutionAvailable(fresh.policyHalt, record.intentKind);
      if (recordRoute.quote.source !== "v4") throw new Error("Automation supports the bounded pool routes only.");
      const wallet = await requireWallet(owner);
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      let file: string;
      let terms: string;
      if (record.intentKind === "recurring-stack") {
        if (!slippageClearsFee(slippageBps)) {
          throw new Error("Stacking slippage must be above the 1% protocol fee.");
        }
        const intent = draftRecurringStackIntent({
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
          priceSource: OPENZAP_V3_2_CONTRACTS.orientedPriceSource,
          maxSlippageBps: slippageBps,
          stackPriceSource: isAddressEqual(recordRoute.tokenOut.address, ROBINHOOD_ASSETS.zaps)
            ? null
            : OPENZAP_V3_2_CONTRACTS.orientedPriceSource,
          zaps: ROBINHOOD_ASSETS.zaps,
          stackBps: activeStackBps,
        });
        const signature = await wallet.signTypedData({ account: owner, ...buildRecurringStackTypedData(intent) });
        file = serializeIntentFile("recurring-stack", intent, signature);
        terms = `${interval.label} · ${runsInRecord(record)} Zaps · stacks ${(activeStackBps / 100).toFixed(1)}% into 0xZAPS · ${recurringValidDays ? `expires ${recurringValidDays}d` : "auto expiry"} · ≤${(slippageBps / 100).toFixed(1)}% slip · ${maxExecutionGas.toLocaleString("en-US")} gas · ≤${maxFeePerGasGwei} gwei · ${executorMode === "anyone" ? "open executor" : executorMode === "owner-only" ? "owner only" : "pinned executor"}`;
      } else if (record.intentKind === "recurring-relative") {
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
    activeStackBps,
    threshold,
    validDays,
  ]);

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
    anchor.download = intentFileName(record.intentKind, record.address);
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
      const parsed = parseAutomationIntent(record.intentFile);
      if (!parsed) throw new Error("Stored intent is unreadable.");
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: record.address,
        abi: openZapV3Abi,
        functionName: "invalidateNonce",
        args: [parsed.authorizationId],
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

  const permanentlyHaltPolicy = useCallback(async () => {
    setBusy("halt");
    setError("");
    try {
      const owner = requireAccount(account);
      if (!record || record.intentKind !== "recurring-stack") {
        throw new Error("The one-way policy stop is available only on configured v3.2 capsules.");
      }
      if (!openZapV3_2Configured()) {
        throw new Error("The canonical v3.2 contract set is not configured.");
      }
      if (haltConfirmation !== POLICY_HALT_CONFIRMATION) {
        throw new Error(`Type ${POLICY_HALT_CONFIRMATION} exactly to confirm the permanent stop.`);
      }

      // Re-prove the byte-exact v3.2 clone, factory, immutable policy hash,
      // owner, and current halt bit at one fresh block before opening a wallet.
      const before = await loadAutomationStatus(record, recordRoute);
      if (before.policyHalt.status === "halted") {
        throw new Error("This execution policy is already permanently halted.");
      }
      if (
        before.policyHalt.status !== "active"
        || !before.policyHalt.owner
        || !isAddressEqual(before.policyHalt.owner, owner)
      ) {
        throw new Error("The canonical v3.2 policy-halt state or owner could not be reverified.");
      }

      const wallet = await requireWallet(owner);
      const simulation = await publicClient.simulateContract({
        account: owner,
        address: record.address,
        abi: openZapPolicyHaltAbi,
        functionName: "haltPolicy",
      });
      const hash = await wallet.writeContract(simulation.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("The halt transaction reverted. The execution policy remains active.");
      }

      // Receipt success is not the final claim. Re-read the canonical clone at
      // a new pinned block and require the one-way bit to be true.
      const after = await loadAutomationStatus(record, recordRoute);
      if (after.policyHalt.status !== "halted" || after.policyHalt.policyHalted !== true) {
        throw new Error("Receipt confirmed, but the canonical policyHalted bit did not read back true.");
      }
      setLoaded({
        address: record.address,
        balance: after.balance,
        status: after.status,
        policyHalt: after.policyHalt,
      });
      setHaltConfirmation("");
      setNotice(
        "Execution policy permanently halted onchain. This capsule cannot be reactivated; nonce revocation and owner recovery remain available.",
      );
      trackEvent("automate_policy_halt");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, haltConfirmation, record, recordRoute]);

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
      : policyHalt.status === "halted"
        ? "Policy permanently halted"
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
    : policyHalt.status === "halted"
      ? { label: "policy halted", tone: styles.chipDanger }
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
    : policyHalt.status === "halted"
      ? "permanent stop — execution cannot resume"
      : record.intentKind === "recurring-stack" && policyHalt.status === "unavailable"
        ? "halt state unavailable — execution controls paused"
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
                  {automationLineageLabel(creationResult.intentKind)}
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
                  <dd>{automationLineageDescription(creationResult.intentKind)}</dd>
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
                    {`${formatToken(BigInt(creationResult.amountPerRun), creationResultRoute?.tokenIn.decimals ?? 18)} ${creationResultRoute?.tokenIn.symbol ?? "tokens"}${creationResult.mode === "recurring" ? ` · ${creationResult.plannedRuns ?? 1} Zaps planned${creationResult.intentKind === "recurring-stack" && creationResult.stackBps ? ` · ${(creationResult.stackBps / 100).toFixed(1)}% stack` : ""}` : " · one trigger"}`}
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
                className={activeIntentKind === "recurring-relative" ? styles.modeOn : styles.mode}
                onClick={() => selectIntentKind("recurring-relative")}
                disabled={busy !== null || record !== null}
              >
                <BlockGlyph name="repeat" className={styles.modeGlyph} />
                Recurring
              </button>
              {openZapV3_2Configured() || activeIntentKind === "recurring-stack" ? (
                <button
                  type="button"
                  className={activeIntentKind === "recurring-stack" ? styles.modeOn : styles.mode}
                  onClick={() => selectIntentKind("recurring-stack")}
                  disabled={busy !== null || record !== null || !openZapV3_2Configured()}
                >
                  <BlockGlyph name="coins" className={styles.modeGlyph} />
                  Stack 0xZAPS
                </button>
              ) : null}
              <button
                type="button"
                className={activeMode === "trigger" ? styles.modeOn : styles.mode}
                onClick={() => selectIntentKind("trigger")}
                disabled={busy !== null || record !== null}
              >
                <BlockGlyph name="band" className={styles.modeGlyph} />
                Price trigger
              </button>
              <span className={styles.stepChip} aria-live="polite">{stepLabel}</span>
              <span className={styles.versionChip}>
                {activeIntentKind === "recurring-stack"
                  ? "v3.2 · live floor + signed 0xZAPS slice"
                  : activeIntentKind === "recurring-relative"
                    ? "v3.1 · per-Zap floor from live spot"
                    : "v3 · floor from a fresh quote at signing"}
              </span>
            </div>

            <div className={styles.body}>
              <p className={styles.summary} aria-live="polite">
                {activeIntentKind === "recurring-stack" ? (
                  recurringRuns === 1 ? (
                    <>
                      Zap <strong>{summaryAmount} {inSymbol}</strong> into <strong>{outSymbol}</strong> once, stack{" "}
                      <strong>{(activeStackBps / 100).toFixed(1)}%</strong> into 0xZAPS, and never settle worse than{" "}
                      <strong>{slipPct}%</strong> off spot.
                    </>
                  ) : (
                    <>
                      Zap <strong>{summaryAmount} {inSymbol}</strong> into <strong>{outSymbol}</strong>,{" "}
                      <strong>{interval.label.toLowerCase()}</strong>, <strong>{recurringRuns} times</strong>; stack{" "}
                      <strong>{(activeStackBps / 100).toFixed(1)}%</strong> of every post-fee run into 0xZAPS, never
                      worse than <strong>{slipPct}%</strong> off spot.
                    </>
                  )
                ) : activeMode === "recurring" ? (
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
                    {activeIntentKind === "recurring-stack" ? (
                      <Field label="Stack into 0xZAPS">
                        <select
                          className={styles.input}
                          value={activeStackBps}
                          onChange={(event) => setStackBps(Number(event.target.value))}
                          disabled={busy !== null || record !== null}
                        >
                          {STACK_PRESETS.map((preset) => (
                            <option key={preset.id} value={preset.bps}>{preset.label}</option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
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
                      min={activeIntentKind === "recurring-stack" ? 105 : 5}
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
                    ) : projectedRecipientFloor > 0n && route ? (
                      activeIntentKind === "recurring-stack" ? (
                        <>
                          Each run first pays the 1% protocol fee, then converts your signed{" "}
                          <strong>{(activeStackBps / 100).toFixed(1)}%</strong> slice into 0xZAPS and credits your
                          lottery tickets. The recipient leg, and the conversion leg when one exists, use the live
                          oriented source and your {slipPct}% band. At today&apos;s spot, the recipient floor after
                          the slice is{" "}
                          <strong>
                            {formatToken(projectedRecipientFloor, route.tokenOut.decimals)} {route.tokenOut.symbol}
                          </strong>
                          .
                        </>
                      ) : (
                        <>
                          Each run&apos;s floor is recomputed from live spot at the moment it lands, minus your{" "}
                          {slipPct}% — at today&apos;s spot that is at least{" "}
                          <strong>
                            {formatToken(projectedRecipientFloor, route.tokenOut.decimals)} {route.tokenOut.symbol}
                          </strong>
                          , so a series signed today protects its last run as tightly as its first.
                        </>
                      )
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
                  title={`Create the ${automationLineageLabel(activeIntentKind)} Zap`}
                  detail="The exact-lineage fee gateway creates the capsule and converts the separate native fee in one transaction; the app then verifies clone bytecode before anything is funded."
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
                              <a href={explorerAddress(activeCreationFeeContracts.gateway)} rel="noreferrer" target="_blank">
                                Fee gateway
                              </a>
                              <a href={explorerAddress(activeCreationFeeContracts.pot)} rel="noreferrer" target="_blank">
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
                      disabled={
                        wrongNetwork
                        || busy !== null
                        || funding.status === "short"
                        || policyExecutionBlocked
                      }
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
                    activeIntentKind === "recurring-stack"
                      ? `One EIP-712 signature authorizes the series and the ${(activeStackBps / 100).toFixed(1)}% post-fee 0xZAPS slice. The Zap enforces both.`
                      : activeMode === "recurring"
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
                        disabled={
                          wrongNetwork
                          || busy !== null
                          || policyExecutionBlocked
                          || !executorValid
                          || (activeMode === "recurring" && !recurringWindowSufficient)
                          || (activeIntentKind === "recurring-stack" && !slippageClearsFee(slippageBps))
                        }
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
                  {automationLineageLabel(activeIntentKind)} configured
                </span>
              ) : (
                <span className={styles.execIdle}>{automationLineageLabel(activeIntentKind)} unavailable</span>
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

          {/* This page never handles the local daemon's intake token. That token is a chmod-600
              capability on the user's own machine; this is a public HTTPS origin, so holding it here
              — even in sessionStorage — put it inside the blast radius of any XSS on the page. The
              local MCP server reads it in its own process instead, which is why the delivery button
              that used to live here is now a pointer. */}
          {signed ? (
            <section className={styles.card} aria-label="Running your own executor">
              <div className={styles.localExecHead}>
                <h2 className={styles.execTitle}>Running your own executor?</h2>
              </div>
              <div className={styles.localExecBody}>
                <p className={styles.localExecNote}>
                  Hand this signed intent to the daemon on your machine through the local MCP server:
                  its <code>deliver_intent_local</code> tool reads the intake token off disk in its own
                  process, so the token never reaches a browser. Setup is in{" "}
                  <Link href="/zap?view=connect">Connect</Link>, and the full tool list is in{" "}
                  <code>mcp/README.md</code>. Delivery moves an intent you already signed — it grants
                  no authority the signature did not already give.
                  <span className={styles.localExecAlt}>
                    No MCP server? <strong>Download file</strong> above writes the same JSON; drop it in{" "}
                    <code>~/.openzaps/executor/intents/</code> and the daemon picks it up.
                  </span>
                </p>
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
                      name={record.intentKind === "recurring-stack" ? "coins" : record.mode === "recurring" ? "repeat" : "band"}
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
                    (record.intentKind === "recurring-stack"
                      ? `0xZAPS stack · ${runsInRecord(record)} Zaps · ${(record.stackBps ?? activeStackBps) / 100}% slice`
                      : record.mode === "recurring"
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
                <RailRow
                  label="Policy execution"
                  ok={policyHalt.status !== "halted" && policyHalt.status !== "unavailable"}
                >
                  {policyHalt.status === "halted"
                    ? "permanently halted — cannot be reactivated"
                    : policyHalt.status === "active"
                      ? `active · one-way stop available${policyHalt.blockNumber ? ` · block ${policyHalt.blockNumber}` : ""}`
                      : policyHalt.status === "unavailable"
                        ? "state unavailable — no active/halted claim"
                        : `unsupported on ${automationLineageLabel(record.intentKind)}`}
                </RailRow>

                {record.intentKind === "recurring-stack" && policyHalt.status !== "halted" ? (
                  <div className={styles.haltBox} role="group" aria-label="Permanently halt policy">
                    <strong>Permanent policy stop</strong>
                    <p>
                      Stops every present and future signed execution for this capsule. It cannot be undone or
                      reactivated. Owner recovery and nonce revocation remain available.
                    </p>
                    <input
                      className={`${styles.input} ${styles.inputMono}`}
                      value={haltConfirmation}
                      onChange={(event) => setHaltConfirmation(event.target.value)}
                      placeholder={`Type ${POLICY_HALT_CONFIRMATION}`}
                      spellCheck={false}
                      disabled={busy !== null || policyHalt.status !== "active"}
                    />
                    <button
                      data-busy={busy === "halt"}
                      className={styles.btnDanger}
                      disabled={
                        wrongNetwork
                        || busy !== null
                        || policyHalt.status !== "active"
                        || haltConfirmation !== POLICY_HALT_CONFIRMATION
                      }
                      onClick={() => void permanentlyHaltPolicy()}
                      type="button"
                    >
                      {busy === "halt" ? "Halting permanently…" : "Permanently halt policy"}
                    </button>
                  </div>
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
                    <BlockGlyph
                      name={r.intentKind === "recurring-stack" ? "coins" : r.mode === "recurring" ? "repeat" : "band"}
                      className={styles.railItemGlyph}
                    />
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
              0xZAPS. Fees — and, for Stack, the owner-signed post-fee slice — buy tickets automatically. Round{" "}
              {pot ? `#${pot.round.toString()}` : "—"} holds{" "}
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

function automationLineageLabel(kind: AutomationIntentKind): string {
  if (kind === "recurring-stack") return "v3.2 stacking";
  if (kind === "recurring-relative") return "v3.1 recurring";
  return "v3 price-trigger";
}

function automationLineageDescription(kind: AutomationIntentKind): string {
  if (kind === "recurring-stack") return "v3.2 · recurring series with signed 0xZAPS stack";
  if (kind === "recurring-relative") return "v3.1 · recurring series";
  return "v3 · price trigger";
}

function runsInRecord(record: AutomationRecord): number {
  if (record.mode === "trigger") return 1;
  if (record.intentFile) {
    const parsed = parseAutomationIntent(record.intentFile);
    if (parsed?.mode === "recurring" && parsed.maxRuns !== null) return parsed.maxRuns;
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

/** All chain reads for the status panel, off the render path. Pure with respect to React. */
async function loadAutomationStatus(
  record: AutomationRecord | null,
  recordRoute: Route | null,
): Promise<{
  balance: bigint | null;
  status: AutomationStatus | null;
  policyHalt: AutomationPolicyHaltState;
}> {
  const unsupported: AutomationPolicyHaltState = {
    status: "unsupported",
    policyHalted: null,
    owner: null,
    blockNumber: null,
  };
  if (!record) return { balance: null, status: null, policyHalt: unsupported };
  const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
  const policyHaltPromise = loadAutomationPolicyHalt(record, blockNumber);
  let balance: bigint | null = null;
  if (recordRoute) {
    balance = await publicClient.readContract({
      address: recordRoute.tokenIn.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [record.address],
      blockNumber,
    });
  }
  const policyHalt = await policyHaltPromise;
  if (!record.intentFile) return { balance, status: null, policyHalt };
  const parsed = parseAutomationIntent(record.intentFile);
  if (!parsed) return { balance, status: null, policyHalt };

  if (parsed.mode === "recurring" && parsed.maxRuns !== null && parsed.interval !== null) {
    const [[runs, lastRun], consumed] = await Promise.all([
      publicClient.readContract({
        address: record.address,
        abi: openZapV3Abi,
        functionName: "series",
        args: [parsed.authorizationId],
        blockNumber,
      }),
      publicClient.readContract({
        address: record.address,
        abi: openZapV3Abi,
        functionName: "nonceUsed",
        args: [parsed.authorizationId],
        blockNumber,
      }),
    ]);
    return {
      balance,
      policyHalt,
      status: {
        kind: "recurring",
        runs: Number(runs),
        lastRun: BigInt(lastRun),
        consumed,
        intent: { maxRuns: parsed.maxRuns, interval: parsed.interval },
        nowSec: BigInt(Math.floor(Date.now() / 1000)),
      },
    };
  }
  if (
    parsed.mode !== "trigger"
    || parsed.priceSource === null
    || parsed.baselinePriceX96 === null
    || parsed.thresholdBps === null
    || parsed.above === null
  ) return { balance, status: null, policyHalt };
  const [consumed, priceX96] = await Promise.all([
    publicClient.readContract({
      address: record.address,
      abi: openZapV3Abi,
      functionName: "nonceUsed",
      args: [parsed.authorizationId],
      blockNumber,
    }),
    publicClient.readContract({
      address: parsed.priceSource,
      abi: priceSourceAbi,
      functionName: "priceX96",
      blockNumber,
    }),
  ]);
  return {
    balance,
    policyHalt,
    status: {
      kind: "trigger",
      consumed,
      armed: isTriggerArmed(priceX96, parsed.baselinePriceX96, parsed.thresholdBps, parsed.above),
      priceX96,
      boundX96: triggerBoundX96(parsed.baselinePriceX96, parsed.thresholdBps, parsed.above),
    },
  };
}

/**
 * Prove the v3.2 halt bit against the configured immutable identity at one
 * pinned block. Historical v3/v3.1 records return unsupported without ever
 * probing the selector.
 */
async function loadAutomationPolicyHalt(
  record: AutomationRecord,
  blockNumber: bigint,
): Promise<AutomationPolicyHaltState> {
  if (record.intentKind !== "recurring-stack") {
    return {
      status: "unsupported",
      policyHalted: null,
      owner: null,
      blockNumber,
    };
  }
  if (!openZapV3_2Configured()) {
    return {
      status: "unavailable",
      policyHalted: null,
      owner: null,
      blockNumber,
    };
  }

  const [runtime, factory, owner, policyHash, policyHalted] = await Promise.all([
    publicClient.getCode({ address: record.address, blockNumber }),
    publicClient.readContract({
      address: record.address,
      abi: openZapPolicyHaltAbi,
      functionName: "FACTORY",
      blockNumber,
    }),
    publicClient.readContract({
      address: record.address,
      abi: openZapPolicyHaltAbi,
      functionName: "owner",
      blockNumber,
    }),
    publicClient.readContract({
      address: record.address,
      abi: openZapPolicyHaltAbi,
      functionName: "policyHash",
      blockNumber,
    }),
    publicClient.readContract({
      address: record.address,
      abi: openZapPolicyHaltAbi,
      functionName: "policyHalted",
      blockNumber,
    }),
  ]);
  if (
    runtime?.toLowerCase() !== expectedCloneRuntime(OPENZAP_V3_2_CONTRACTS.implementation).toLowerCase()
    || !isAddressEqual(factory, OPENZAP_V3_2_CONTRACTS.factory)
    || policyHash.toLowerCase() !== record.policyHash.toLowerCase()
  ) {
    throw new Error("Stored automation is not the canonical configured v3.2 clone and policy.");
  }
  return {
    status: policyHalted ? "halted" : "active",
    policyHalted,
    owner: getAddress(owner),
    blockNumber,
  };
}

function requirePolicyExecutionAvailable(
  policyHalt: AutomationPolicyHaltState,
  intentKind: AutomationIntentKind,
): void {
  if (policyHalt.status === "halted") {
    throw new Error("This capsule's execution policy is permanently halted.");
  }
  if (intentKind === "recurring-stack" && policyHalt.status !== "active") {
    throw new Error("The canonical v3.2 policy-halt state is unavailable. Execution controls stay paused.");
  }
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
