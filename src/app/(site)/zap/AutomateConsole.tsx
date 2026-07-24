"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { OpenZapMark } from "@/components/OpenZapMark";
import { trackEvent } from "@/lib/analytics";
import {
  INTERVAL_PRESETS,
  THRESHOLD_PRESETS,
  describeSeries,
  draftRecurringIntent,
  draftTriggerIntent,
  feedConditionForZapsMove,
  intentFileName,
  netFloorFromQuote,
  type AutomationMode,
} from "@/lib/automate";
import {
  EXEC_FEE_BPS,
  EXECUTOR_SHARE_BPS,
  buildRecurringTypedData,
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
import { BOUNDED_SWAP_IDS } from "@/lib/chains";
import { resolveRouteById, type Route } from "@/lib/routes";
import {
  OPENZAP_V3_CONTRACTS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_RPC_URL,
  ensureRobinhoodChain,
  erc20Abi,
  explorerAddress,
  getInjectedProvider,
  lotteryPotAbi,
  openZapFactoryV3Abi,
  openZapV3Abi,
  openZapV3Configured,
  priceSourceAbi,
  robinhoodChain,
  v4QuoterAbi,
} from "@/lib/robinhood";
import styles from "./app.module.css";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

const STORAGE_KEY = "openzap:v3:automations";
const MAX_SAVED_AUTOMATIONS = 5;

type BusyAction = "connect" | "create" | "fund" | "sign" | "cancel" | "recover" | "refresh" | "send" | null;

/** The reference daemon's localhost intake (executor/intake.mjs). Probed only after signing. */
const EXECUTOR_INTAKE_URL = "http://127.0.0.1:8477";
const INTAKE_TOKEN_STORAGE_KEY = "openzap:executor:intake-token";

interface ExecutorHealth {
  executing: boolean;
  chainId: number;
}

/** A signed automation, persisted locally. The intent file IS the artifact the executor consumes. */
interface AutomationRecord {
  address: Address;
  routeId: string;
  mode: AutomationMode;
  amountPerRun: string; // raw units, decimal string
  createdAt: string;
  policyHash: Hex;
  /** Recurring only: run count chosen at creation, the funding-math input until signing. */
  plannedRuns?: number;
  /** Human summary of the SIGNED terms (cadence/condition), set at signing. */
  terms?: string;
  /** Set once the standing intent is signed: the exact executor intent-file JSON. */
  intentFile?: string;
  /** Set once handed to a local executor, so the UI stops implying it still needs delivery. */
  deliveredTo?: string;
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
  const [account, setAccount] = useState<Address | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [mode, setMode] = useState<AutomationMode>("recurring");
  const [routeId, setRouteId] = useState<string>(BOUNDED_SWAP_IDS[0]);
  const [amount, setAmount] = useState("0.001");
  const [slippageBps, setSlippageBps] = useState(100);
  const [intervalId, setIntervalId] = useState("daily");
  const [maxRuns, setMaxRuns] = useState(10);
  const [thresholdId, setThresholdId] = useState("up10");
  const [validDays, setValidDays] = useState(30);

  const [records, setRecords] = useState<AutomationRecord[]>([]);
  const [selected, setSelected] = useState<Address | null>(null);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [pot, setPot] = useState<PotStatus | null>(null);
  const [executorHealth, setExecutorHealth] = useState<ExecutorHealth | null>(null);
  const [intakeToken, setIntakeToken] = useState("");
  const loadEpochRef = useRef(0);

  const configured = openZapV3Configured();
  const route: Route | null = resolveRouteById(routeId);
  const interval = INTERVAL_PRESETS.find((p) => p.id === intervalId) ?? INTERVAL_PRESETS[2];
  const threshold = THRESHOLD_PRESETS.find((p) => p.id === thresholdId) ?? THRESHOLD_PRESETS[1];

  const record =
    records.find((r) => selected && r.address.toLowerCase() === selected.toLowerCase()) ?? records[0] ?? null;
  const recordRoute = record ? resolveRouteById(record.routeId) : null;
  const perRunAmount = route ? parseAmountSafe(amount, route.tokenIn.decimals) : 0n;

  // Loaded chain state counts for the SELECTED capsule only; anything else is a stale response.
  const loadedForRecord = record && loaded && loaded.address === record.address ? loaded : null;
  const capsuleBalance = loadedForRecord ? loadedForRecord.balance : null;
  const status = loadedForRecord?.status ?? null;

  const remainingTarget = record ? remainingFundingTarget(record, status) : 0n;
  const balanceKnown = capsuleBalance !== null;
  const funded = record !== null && balanceKnown && capsuleBalance >= remainingTarget;
  const signed = record?.intentFile !== undefined;

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
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found. Install a wallet extension first.");
      await ensureRobinhoodChain(provider);
      const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
      const [address] = await wallet.requestAddresses();
      if (!address) throw new Error("The wallet returned no account.");
      const owner = getAddress(address);
      setAccount(owner);
      setRecords(readAutomations(owner));
      trackEvent("automate_connect");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const persist = useCallback(
    (next: AutomationRecord[]) => {
      setRecords(next);
      if (account) saveAutomations(account, next);
    },
    [account],
  );

  // ---- pot (protocol lottery) ----

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const round = await publicClient.readContract({
          address: OPENZAP_V3_CONTRACTS.lotteryPot,
          abi: lotteryPotAbi,
          functionName: "currentRound",
        });
        const [prize, totalTickets, tickets] = await Promise.all([
          publicClient.readContract({ address: OPENZAP_V3_CONTRACTS.lotteryPot, abi: lotteryPotAbi, functionName: "roundPrize", args: [round] }),
          publicClient.readContract({ address: OPENZAP_V3_CONTRACTS.lotteryPot, abi: lotteryPotAbi, functionName: "totalTickets", args: [round] }),
          account
            ? publicClient.readContract({ address: OPENZAP_V3_CONTRACTS.lotteryPot, abi: lotteryPotAbi, functionName: "tickets", args: [round, account] })
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
  }, [account, configured, notice]);

  // ---- actions ----

  const createCapsule = useCallback(async () => {
    setBusy("create");
    setError("");
    try {
      if (!configured) throw new Error("The v3 factory is not configured.");
      const owner = requireAccount(account);
      const activeRoute = route;
      if (!activeRoute) throw new Error("Route unavailable.");
      if (perRunAmount <= 0n) throw new Error("Enter a per-run amount first.");
      if (mode === "recurring" && (maxRuns < 1 || maxRuns > 1000)) throw new Error("Runs must be between 1 and 1000.");

      const wallet = await requireWallet(owner);
      const policy = buildRoutePolicy(owner, activeRoute, perRunAmount);
      const salt = randomHex32();
      const predicted = await publicClient.readContract({
        address: OPENZAP_V3_CONTRACTS.factory,
        abi: openZapFactoryV3Abi,
        functionName: "predict",
        args: [policy, salt],
      });
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: OPENZAP_V3_CONTRACTS.factory,
        abi: openZapFactoryV3Abi,
        functionName: "createZap",
        args: [policy, salt],
      });
      const hash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });

      // Verify the clone is byte-exact against the v3 implementation before anyone funds it.
      const [code, policyHash] = await Promise.all([
        publicClient.getCode({ address: predicted }),
        publicClient.readContract({ address: predicted, abi: openZapV3Abi, functionName: "policyHash" }),
      ]);
      if (code !== expectedCloneRuntime(OPENZAP_V3_CONTRACTS.implementation)) {
        throw new Error("Deployed capsule bytecode does not match the v3 implementation. Do not fund it.");
      }

      const next: AutomationRecord = {
        address: predicted,
        routeId: activeRoute.id,
        mode,
        amountPerRun: perRunAmount.toString(),
        createdAt: new Date().toISOString(),
        policyHash,
        plannedRuns: mode === "recurring" ? maxRuns : undefined,
      };
      persist([next, ...records].slice(0, MAX_SAVED_AUTOMATIONS));
      setSelected(predicted);
      setNotice(`v3 capsule created and verified at ${shortAddress(predicted)}. Fund it next.`);
      trackEvent("automate_create", { mode });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, configured, maxRuns, mode, perRunAmount, persist, records, route]);

  const fundCapsule = useCallback(async () => {
    setBusy("fund");
    setError("");
    try {
      const owner = requireAccount(account);
      if (!record || !recordRoute) throw new Error("Create a capsule first.");
      // Fresh reads, never React state: a stale balance here is a double-funding, not a stale pixel.
      const fresh = await loadAutomationStatus(record, recordRoute);
      if (fresh.balance === null) throw new Error("Capsule balance is unreadable right now. Try again.");
      const target = remainingFundingTarget(record, fresh.status);
      const missing = target - fresh.balance;
      if (missing <= 0n) {
        await applyLoad(record);
        setNotice("Capsule already holds everything the remaining runs can spend.");
        return;
      }
      const wallet = await requireWallet(owner);
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
      setNotice(`Funded ${formatToken(missing, recordRoute.tokenIn.decimals)} ${recordRoute.tokenIn.symbol} into the capsule.`);
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
      if (!record || !recordRoute) throw new Error("Create a capsule first.");
      if (recordRoute.quote.source !== "v4") throw new Error("Automation supports the bounded pool routes only.");
      const wallet = await requireWallet(owner);
      const perRun = BigInt(record.amountPerRun);

      // A fresh quote sets the per-run floor: slippage first, then the 1% executor fee, because
      // the capsule enforces the floor NET of that fee.
      const { result } = await publicClient.simulateContract({
        account: owner,
        address: ROBINHOOD_LIQUIDITY.v4Quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: recordRoute.quote.poolKey, zeroForOne: recordRoute.quote.zeroForOne, exactAmount: perRun, hookData: "0x" }],
      });
      const minOut = netFloorFromQuote(result[0], slippageBps);
      if (minOut <= 0n) throw new Error("The route quotes to zero output. Try a larger per-run amount.");

      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      let file: string;
      let terms: string;
      if (record.mode === "recurring") {
        const intent = draftRecurringIntent({
          zap: record.address,
          chainId: ROBINHOOD_CHAIN_ID,
          seriesId: randomNonce(),
          nowSec,
          interval: interval.seconds,
          maxRuns: runsInRecord(record),
          recipient: owner,
          policyHash: record.policyHash,
          outAsset: recordRoute.tokenOut.address,
          minOutPerRun: minOut,
        });
        const signature = await wallet.signTypedData({ account: owner, ...buildRecurringTypedData(intent) });
        file = serializeIntentFile("recurring", intent, signature);
        terms = `${interval.label} · ${runsInRecord(record)} runs`;
      } else {
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
        terms = `${threshold.label} · valid ${validDays}d`;
      }

      // Persisting swaps in a NEW record object, so the status effect reloads on its own.
      persist(records.map((r) => (r.address === record.address ? { ...r, intentFile: file, terms } : r)));
      setNotice("Standing intent signed. Export the intent file and hand it to an executor — the capsule enforces everything else.");
      trackEvent("automate_sign", { mode: record.mode });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, interval, persist, record, recordRoute, records, slippageBps, threshold, validDays]);

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
      await publicClient.waitForTransactionReceipt({ hash });
      await applyLoad(record);
      setNotice("Automation cancelled on-chain. The signed intent can never execute again.");
      trackEvent("automate_cancel");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, applyLoad, record]);

  const recoverFunds = useCallback(async () => {
    setBusy("recover");
    setError("");
    try {
      const owner = requireAccount(account);
      if (!record || !recordRoute) throw new Error("No capsule selected.");
      const wallet = await requireWallet(owner);
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: record.address,
        abi: openZapV3Abi,
        functionName: "emergencyExit",
        args: [[...recordRoute.trackedAssets]],
      });
      const hash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });
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

  const stepLabel = !account
    ? "1. Connect wallet"
    : !record
      ? "2. Create capsule"
      : !funded
        ? "3. Fund capsule"
        : !signed
          ? "4. Sign standing intent"
          : "Automation armed";

  const feePct = Number(EXEC_FEE_BPS) / 100;
  const executorPct = Number(EXECUTOR_SHARE_BPS) / 100;

  const fundingDetail = !record || !recordRoute
    ? "Transfer exactly what the automation will spend. Nothing else can leave the capsule."
    : capsuleBalance === null
      ? "Capsule balance is unavailable — refresh before funding. Funding is disabled until the balance reads."
      : `Remaining target ${formatToken(remainingTarget, recordRoute.tokenIn.decimals)} ${recordRoute.tokenIn.symbol} — holds ${formatToken(capsuleBalance, recordRoute.tokenIn.decimals)}.`;

  return (
    <main className={styles.page} id="main">
      <section className={`container ${styles.statusBar}`} aria-label="v3 protocol status">
        <span className={configured ? styles.statusLive : styles.statusPreview} role="status">
          {configured ? "v3 live · unaudited" : "v3 unavailable"}
        </span>
        <p>
          {configured ? (
            <>
              Recurring and price-triggered capsules run through factory{" "}
              <a href={explorerAddress(OPENZAP_V3_CONTRACTS.factory)} target="_blank" rel="noreferrer">
                {shortAddress(OPENZAP_V3_CONTRACTS.factory)}
              </a>
              . Each run pays a {feePct}% protocol fee from output — {executorPct}% of the fee to the executor that
              submits it, the rest to the 0xZAPS lottery pot. The v3 contracts have not been externally audited.
              Depositing funds can result in total loss.
            </>
          ) : (
            <>The v3 contract set is not configured. Automation is disabled.</>
          )}
        </p>
      </section>

      <section className={`container ${styles.appHead}`}>
        <div className={styles.titleRow}>
          <OpenZapMark className={styles.headMark} />
          <div>
            <span className="eyebrow">Automate</span>
            <h1>Sign once. The chain keeps the terms.</h1>
            <p>
              A v3 capsule executes your frozen route on a cadence or on a price move — the interval and the
              threshold are enforced by the contract, so any executor can submit a run that is owed and none can
              submit one that is not. Runs land only when an executor submits them: the capsule enforces the terms,
              executors provide the liveness.
            </p>
          </div>
        </div>
        <div className={styles.wallet}>
          {account ? (
            <a className={styles.addr} href={explorerAddress(account)} target="_blank" rel="noreferrer">
              {shortAddress(account)}
            </a>
          ) : (
            <button data-busy={busy === "connect"} className="btn btnPrimary" disabled={busy !== null} onClick={() => void connectWallet()} type="button">
              {busy === "connect" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </section>

      <div className={`container ${styles.notice}`} role="status">{notice}</div>
      {error && <div className={`container ${styles.error}`} role="alert">{error}</div>}

      <section className={`container ${styles.metrics}`} aria-label="Automation metrics">
        <Metric label="Execution type" value={record ? (record.mode === "recurring" ? "Recurring" : "Price trigger") : mode === "recurring" ? "Recurring" : "Price trigger"} />
        <Metric label="Current step" value={stepLabel} />
        <Metric label="Lottery round" value={pot ? `#${pot.round.toString()} · ${formatToken(pot.prize)} 0xZAPS` : "—"} />
        <Metric label="Your tickets" value={pot && account ? formatToken(pot.tickets) : "—"} />
      </section>

      <section className={`container ${styles.workspace}`}>
        <section className={styles.builder} aria-label="Configure the automation">
          <div className={styles.builderTop}>
            <div>
              <span className={styles.cardHead}>Automation builder</span>
              <h2>{(record?.mode ?? mode) === "recurring" ? "Repeat a bounded swap on a cadence" : "Fire a bounded swap on a price move"}</h2>
              <p>
                The capsule holds ONE frozen swap on the pinned aeWETH ⇄ 0xZAPS pool. Automation adds only timing:
                route, amounts, recipient, and the net output floor stay signed and immutable.
              </p>
            </div>
            <span className={styles.liveBadge}>onchain</span>
          </div>

          <div className={styles.segment} role="group" aria-label="Execution type">
            <button type="button" className={mode === "recurring" ? styles.segOn : styles.seg} onClick={() => setMode("recurring")} disabled={busy !== null || record !== null}>
              Recurring
              <em>every X time, N runs</em>
            </button>
            <button type="button" className={mode === "trigger" ? styles.segOn : styles.seg} onClick={() => setMode("trigger")} disabled={busy !== null || record !== null}>
              Price trigger
              <em>fires once at ±X%</em>
            </button>
          </div>

          <div className={styles.segment} role="group" aria-label="Direction">
            {BOUNDED_SWAP_IDS.map((id) => {
              const r = resolveRouteById(id);
              if (!r) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className={routeId === id ? styles.segOn : styles.seg}
                  onClick={() => setRouteId(id)}
                  disabled={busy !== null || record !== null}
                >
                  {r.tokenIn.symbol} → {r.tokenOut.symbol}
                  <em>{id === BOUNDED_SWAP_IDS[0] ? "accumulate 0xZAPS" : "take profit to aeWETH"}</em>
                </button>
              );
            })}
          </div>

          <div className={styles.formGrid}>
            <Field label={`Per-run amount (${route?.tokenIn.symbol ?? ""})`}>
              <input
                className={styles.input}
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(sanitizeDecimal(event.target.value))}
                disabled={busy !== null || record !== null}
              />
            </Field>
            <Field label={`Slippage tolerance (${(slippageBps / 100).toFixed(2)}%)`}>
              <input
                className={styles.range}
                type="range"
                min={10}
                max={500}
                step={10}
                value={slippageBps}
                onChange={(event) => setSlippageBps(Number(event.target.value))}
                disabled={busy !== null || signed}
              />
            </Field>
            {mode === "recurring" ? (
              <>
                <Field label="Cadence">
                  <select className={styles.input} value={intervalId} onChange={(event) => setIntervalId(event.target.value)} disabled={busy !== null || signed}>
                    {INTERVAL_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`Total runs (${maxRuns})`}>
                  <input
                    className={styles.range}
                    type="range"
                    min={1}
                    max={100}
                    step={1}
                    value={maxRuns}
                    onChange={(event) => setMaxRuns(Number(event.target.value))}
                    disabled={busy !== null || record !== null}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="Condition (0xZAPS price move)">
                  <select className={styles.input} value={thresholdId} onChange={(event) => setThresholdId(event.target.value)} disabled={busy !== null || signed}>
                    {THRESHOLD_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`Valid for (${validDays} days)`}>
                  <input
                    className={styles.range}
                    type="range"
                    min={1}
                    max={90}
                    step={1}
                    value={validDays}
                    onChange={(event) => setValidDays(Number(event.target.value))}
                    disabled={busy !== null || signed}
                  />
                </Field>
              </>
            )}
          </div>

          <div className={styles.flow}>
            <FlowStep number="1" title="Connect wallet" detail="Robinhood Chain (4663), injected wallet." done={account !== null}>
              {!account && (
                <button data-busy={busy === "connect"} className="btn btnPrimary" disabled={busy !== null} onClick={() => void connectWallet()} type="button">
                  {busy === "connect" ? "Connecting…" : "Connect"}
                </button>
              )}
            </FlowStep>

            <FlowStep
              number="2"
              title="Create the v3 capsule"
              detail="Deploys an immutable clone from the v3 factory and verifies its bytecode before anything is funded."
              done={record !== null}
            >
              {!record && (
                <button
                  data-busy={busy === "create"}
                  className="btn btnPrimary"
                  disabled={busy !== null || !account || !configured || perRunAmount <= 0n}
                  onClick={() => void createCapsule()}
                  type="button"
                >
                  {busy === "create" ? "Creating…" : "Create capsule"}
                </button>
              )}
            </FlowStep>

            <FlowStep number="3" title="Fund the capsule" detail={fundingDetail} done={record !== null && funded}>
              {record && balanceKnown && !funded && (
                <button data-busy={busy === "fund"} className="btn btnPrimary" disabled={busy !== null} onClick={() => void fundCapsule()} type="button">
                  {busy === "fund" ? "Funding…" : "Fund"}
                </button>
              )}
              {record && !balanceKnown && (
                <button data-busy={busy === "refresh"} className="btn btnGhost" disabled={busy !== null} onClick={() => void refresh()} type="button">
                  {busy === "refresh" ? "Reading…" : "Retry balance read"}
                </button>
              )}
            </FlowStep>

            <FlowStep
              number="4"
              title="Sign the standing intent"
              detail={
                (record?.mode ?? mode) === "recurring"
                  ? "One EIP-712 signature authorizes the whole series. The capsule enforces the interval and the run count."
                  : "One EIP-712 signature arms the trigger. The baseline price is read at signing time, and the capsule re-reads the market itself on every attempt."
              }
              done={signed}
            >
              {record && funded && !signed && (
                <button data-busy={busy === "sign"} className="btn btnPrimary" disabled={busy !== null} onClick={() => void signIntent()} type="button">
                  {busy === "sign" ? "Awaiting wallet…" : "Sign intent"}
                </button>
              )}
              {signed && (
                <>
                  <button className="btn btnPrimary" onClick={exportIntent} type="button">Download intent file</button>
                  <button className="btn btnGhost" onClick={() => void copyIntent()} type="button">Copy JSON</button>
                </>
              )}
            </FlowStep>
          </div>

          {signed && executorHealth && (
            <div className={styles.formGrid}>
              <Field label={`Local executor detected${executorHealth.executing ? "" : " (watch-only — it will simulate, not broadcast)"}`}>
                <input
                  className={styles.input}
                  type="password"
                  placeholder="intake token — from `node executor/index.mjs status`"
                  value={intakeToken}
                  onChange={(event) => updateIntakeToken(event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <div className={styles.flowActions}>
                <button
                  data-busy={busy === "send"}
                  className="btn btnPrimary"
                  disabled={busy !== null || !intakeToken.trim()}
                  onClick={() => void sendToExecutor()}
                  type="button"
                >
                  {busy === "send" ? "Delivering…" : record?.deliveredTo ? "Send again" : "Send to executor"}
                </button>
                {record?.deliveredTo && <span className={styles.utilStatus}>✓ delivered to your local executor</span>}
              </div>
            </div>
          )}

          {signed && (
            <p className={styles.utilStatus}>
              {executorHealth
                ? "Or hand the file to any other executor: "
                : "Drop the file into an executor's intent store (reference daemon: "}
              <code>~/.openzaps/executor/intents/</code>
              {executorHealth
                ? "."
                : "). Running the daemon on this machine (in a Chromium browser)? A Send button appears here automatically; Safari and Firefox block a page from reaching localhost, so use the file drop there."}{" "}
              Any executor can submit runs the capsule owes; the executor cannot change what runs — and if no
              executor serves this file, nothing runs. Cancel any time below; cancellation is on-chain and final.
            </p>
          )}
        </section>

        <aside className={styles.review} aria-label="Automation status">
          <span className={styles.cardHead}>Status</span>
          {record ? (
            <div className={styles.verifyList}>
              <VerifyRow label="Capsule" value={shortAddress(record.address)} href={explorerAddress(record.address)} ok />
              <VerifyRow
                label="Terms"
                value={
                  record.terms ??
                  (record.mode === "recurring"
                    ? `Recurring · ${runsInRecord(record)} runs · cadence set when you sign`
                    : "Price trigger · condition set when you sign")
                }
                ok
              />
              <VerifyRow
                label="Funding"
                value={
                  !recordRoute
                    ? "—"
                    : capsuleBalance === null
                      ? "balance unavailable — refresh"
                      : `${formatToken(capsuleBalance, recordRoute.tokenIn.decimals)} / ${formatToken(remainingTarget, recordRoute.tokenIn.decimals)} ${recordRoute.tokenIn.symbol} remaining`
                }
                ok={funded}
              />
              {status?.kind === "recurring" && (
                <VerifyRow
                  label="Series"
                  value={status.consumed ? "finished or cancelled" : describeSeries(status.runs, status.lastRun, status.intent, status.nowSec)}
                  ok={!status.consumed}
                />
              )}
              {status?.kind === "trigger" && (
                <VerifyRow
                  label="Trigger"
                  value={status.consumed ? "fired or cancelled" : status.armed ? "ARMED — condition met, awaiting an executor" : "waiting for the signed move"}
                  ok={!status.consumed}
                />
              )}
              <div className={styles.flowActions}>
                <button data-busy={busy === "refresh"} className="btn btnGhost" disabled={busy !== null} onClick={() => void refresh()} type="button">
                  {busy === "refresh" ? "Refreshing…" : "Refresh"}
                </button>
                {signed && status && !status.consumed && (
                  <button data-busy={busy === "cancel"} className="btn btnGhost" disabled={busy !== null} onClick={() => void cancelAutomation()} type="button">
                    {busy === "cancel" ? "Cancelling…" : "Cancel automation"}
                  </button>
                )}
                <button data-busy={busy === "recover"} className="btn btnGhost" disabled={busy !== null} onClick={() => void recoverFunds()} type="button">
                  {busy === "recover" ? "Recovering…" : "Recover funds"}
                </button>
              </div>
            </div>
          ) : (
            <p className={styles.empty}>No automation yet. Configure one on the left — the capsule, not the executor, holds every bound.</p>
          )}

          <span className={styles.cardHead}>Protocol lottery</span>
          <p className={styles.utilStatus}>
            Every automated run pays a {feePct}% fee from output: {executorPct}% of it to the executor that
            submitted the run, the rest to the lottery pot, where a permissionless keeper call converts it to
            0xZAPS. Fees buy tickets automatically — round {pot ? `#${pot.round.toString()}` : "—"} holds{" "}
            {pot ? formatToken(pot.prize) : "—"} 0xZAPS
            {pot && account ? ` and this wallet holds ${formatToken(pot.tickets)} of ${formatToken(pot.totalTickets)} tickets` : ""}
            . Winner selection is governance-gated until a randomness design lands; payouts can only ever go to
            ticket holders, only in 0xZAPS.{" "}
            <Link href="/docs#automation">How the executor economy works →</Link>
          </p>

          {records.length > 1 && (
            <>
              <span className={styles.cardHead}>Your automations</span>
              <div className={styles.savedZaps}>
                {records.map((r) => (
                  <button
                    key={r.address}
                    type="button"
                    className={record?.address === r.address ? styles.savedZapActive : undefined}
                    onClick={() => setSelected(r.address)}
                  >
                    {r.mode === "recurring" ? "⟳" : "⚡"} {shortAddress(r.address)}
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}

// ---- module helpers (mirror Console.tsx conventions) ----

function runsInRecord(record: AutomationRecord): number {
  if (record.mode === "trigger") return 1;
  if (record.intentFile) {
    const parsed = parseIntentFile(record.intentFile);
    if (parsed?.kind === "recurring") return (parsed.intent as RecurringIntent).maxRuns;
  }
  return record.plannedRuns ?? 1;
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
    if ((parsed.kind !== "recurring" && parsed.kind !== "trigger") || !parsed.intent) return null;
    const i = parsed.intent;
    const big = (key: string) => BigInt(String(i[key]));
    const addr = (key: string) => getAddress(String(i[key]));
    if (parsed.kind === "recurring") {
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
        minOutPerRun: big("minOutPerRun"),
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

function saveAutomations(owner: Address, records: AutomationRecord[]): void {
  try {
    window.localStorage.setItem(`${STORAGE_KEY}:${owner.toLowerCase()}`, JSON.stringify(records));
  } catch {
    // Persistence is optional; on-chain state stays authoritative.
  }
}

function readAutomations(owner: Address): AutomationRecord[] {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}:${owner.toLowerCase()}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const r = value as Record<string, unknown>;
      if (typeof r.address !== "string" || typeof r.routeId !== "string" || typeof r.amountPerRun !== "string") return [];
      if (r.mode !== "recurring" && r.mode !== "trigger") return [];
      if (typeof r.policyHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.policyHash)) return [];
      try {
        if (BigInt(r.amountPerRun) <= 0n) return [];
        return [{
          address: getAddress(r.address),
          routeId: r.routeId,
          mode: r.mode,
          amountPerRun: r.amountPerRun,
          createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
          policyHash: r.policyHash as Hex,
          plannedRuns: typeof r.plannedRuns === "number" && r.plannedRuns >= 1 ? Math.trunc(r.plannedRuns) : undefined,
          terms: typeof r.terms === "string" ? r.terms : undefined,
          intentFile: typeof r.intentFile === "string" ? r.intentFile : undefined,
          deliveredTo: typeof r.deliveredTo === "string" ? r.deliveredTo : undefined,
        } satisfies AutomationRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
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
