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
  type Address,
  type Hex,
} from "viem";

import { useWalletSession } from "@/components/WalletProvider";
import { BlockGlyph } from "../zap/BlockGlyph";
import { PortfolioPanel, type PortfolioPanelStatus } from "./PortfolioPanel";
import { intentFileName } from "@/lib/automate";
import {
  automationIntentKey,
  automationRecordMatchesIntentKey,
  parseAutomationIntent,
  readAutomationRecords,
  saveAutomationRecords,
  type AutomationRecord,
  type ParsedAutomationIntent,
} from "@/lib/automation-records";
import {
  deriveAutomationLifecycle,
  type AutomationChainState,
  type AutomationLifecycleView,
} from "@/lib/automation-status";
import { consumeIntent, fetchOwnerIntents, type RelayRecord } from "@/lib/relay";
import type { WalletActivityEntry, WalletProfilePayload, WalletZapSummary } from "@/lib/profile";
import type { WalletPortfolioPayload } from "@/lib/profile-portfolio";
import { resolveRouteById } from "@/lib/routes";
import {
  ROBINHOOD_ASSETS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
  ensureRobinhoodChain,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  openZapV3Abi,
  priceSourceAbi,
  robinhoodChain,
} from "@/lib/robinhood";
import styles from "./profile.module.css";

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/** A segmented run bar stops being readable long before this many segments. */
const MAX_RUN_SEGMENTS = 24;

type ActivityFilter = "all" | "executions" | "automation" | "control";
type ConfirmAction = { kind: "revoke" | "recover"; key: string } | null;
type LocalAction = {
  id: string;
  label: string;
  zap: Address;
  status: "pending" | "failed";
  txHash: Hex | null;
  detail: string;
};

type LocalRecordSnapshot = {
  owner: Address;
  records: AutomationRecord[];
};

interface DashboardAutomation {
  key: string;
  zap: Address;
  parsed: ParsedAutomationIntent | null;
  local: AutomationRecord | null;
  relay: RelayRecord | null;
  createdAt: string;
  /** The exact signed artifact, when one exists. Never re-serialized for export. */
  intentJson: string | null;
}

interface DashboardAutomationView extends DashboardAutomation {
  state: AutomationLifecycleView;
  chain: AutomationChainState | null;
}

const ACTIVITY_LABELS: Record<WalletActivityEntry["kind"], string> = {
  created: "Created",
  executed: "Zapped",
  automated: "AutoZap",
  recovered: "Recovered",
  revoked: "Revoked",
  "series-finished": "Completed",
};

const ACTIVITY_GLYPHS: Record<WalletActivityEntry["kind"], string> = {
  created: "lock",
  // The filled silhouette, as the design draws an execution: a solid bolt reads
  // at 15px where the outline turns to mush.
  executed: "boltFill",
  automated: "repeat",
  recovered: "download",
  revoked: "shield",
  "series-finished": "check",
};

export function ProfileDashboard(): React.JSX.Element {
  const {
    account,
    chainId: walletChainId,
    connect: connectSession,
    switchToRobinhood,
  } = useWalletSession();
  const accountRef = useRef<Address | null>(null);
  const [profileData, setProfileData] = useState<WalletProfilePayload | null>(null);
  const [portfolioData, setPortfolioData] = useState<WalletPortfolioPayload | null>(null);
  const [portfolioStatus, setPortfolioStatus] = useState<PortfolioPanelStatus>("idle");
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [relayRecords, setRelayRecords] = useState<RelayRecord[]>([]);
  const [relayStatus, setRelayStatus] = useState<"idle" | "live" | "unavailable">("idle");
  // Keep the storage owner attached to the rows. accountsChanged renders the
  // new wallet before its async refresh completes; an unscoped array would
  // briefly expose the previous wallet's signed intents in the new profile.
  const [localRecordSnapshot, setLocalRecordSnapshot] = useState<LocalRecordSnapshot | null>(null);
  const [chainStates, setChainStates] = useState<Record<string, AutomationChainState | null>>({});
  const [chainStateReadAt, setChainStateReadAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [search, setSearch] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [localActions, setLocalActions] = useState<LocalAction[]>([]);
  const profile = account && profileData && isAddressEqual(profileData.owner, account) ? profileData : null;
  const portfolio = account && portfolioData && isAddressEqual(portfolioData.owner, account) ? portfolioData : null;

  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  const refreshDashboard = useCallback(async (): Promise<void> => {
    if (!account) return;
    const requestedAccount = account;
    setLoading(true);
    setError("");
    const local = readAutomationRecords(requestedAccount);
    setLocalRecordSnapshot({ owner: requestedAccount, records: local });
    const [profileResult, relayResult] = await Promise.allSettled([
      fetch(`/api/profile/${requestedAccount}`, { cache: "no-store" }).then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Profile read failed (HTTP ${response.status}).`);
        }
        return response.json() as Promise<WalletProfilePayload>;
      }),
      fetchOwnerIntents(requestedAccount),
    ]);
    if (!accountRef.current || !isAddressEqual(accountRef.current, requestedAccount)) return;
    if (profileResult.status === "fulfilled") {
      setProfileData(profileResult.value);
    } else {
      setProfileData(null);
      setError(profileResult.reason instanceof Error ? profileResult.reason.message : "Wallet activity is unavailable.");
    }
    if (relayResult.status === "fulfilled") {
      setRelayRecords(relayResult.value);
      setRelayStatus("live");
    } else {
      setRelayRecords([]);
      setRelayStatus("unavailable");
    }
    setLoading(false);
  }, [account]);

  const refreshPortfolio = useCallback(async (): Promise<void> => {
    if (!account) return;
    const requestedAccount = account;
    setPortfolioStatus("loading");
    setPortfolioError(null);
    try {
      const response = await fetch(`/api/profile/${requestedAccount}/portfolio`, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Portfolio read failed (HTTP ${response.status}).`);
      }
      const payload = await response.json() as WalletPortfolioPayload;
      if (!isAddressEqual(payload.owner, requestedAccount)) {
        throw new Error("Portfolio response owner did not match the connected wallet.");
      }
      if (!accountRef.current || !isAddressEqual(accountRef.current, requestedAccount)) return;
      setPortfolioData(payload);
      setPortfolioStatus("ready");
    } catch (cause) {
      if (!accountRef.current || !isAddressEqual(accountRef.current, requestedAccount)) return;
      setPortfolioData(null);
      setPortfolioStatus("unavailable");
      setPortfolioError(cause instanceof Error ? cause.message : "Wallet holdings are unavailable.");
    }
  }, [account]);

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([refreshDashboard(), refreshPortfolio()]);
  }, [refreshDashboard, refreshPortfolio]);

  useEffect(() => {
    if (!account) return;
    const frame = window.requestAnimationFrame(() => void refreshAll());
    return () => window.cancelAnimationFrame(frame);
  }, [account, refreshAll]);

  const localRecords = useMemo(() => (
    account && localRecordSnapshot && isAddressEqual(account, localRecordSnapshot.owner)
      ? localRecordSnapshot.records
      : []
  ), [account, localRecordSnapshot]);

  const automations = useMemo(
    () => mergeAutomations(account, localRecords, relayRecords),
    [account, localRecords, relayRecords],
  );

  useEffect(() => {
    let cancelled = false;
    if (automations.length === 0) return;
    void Promise.all(automations.map(async (automation) => [
      automation.key,
      await loadAutomationChainState(automation.parsed),
    ] as const)).then((rows) => {
      if (!cancelled) {
        setChainStates(Object.fromEntries(rows));
        setChainStateReadAt(Date.now());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [automations]);

  const automationViews = useMemo((): DashboardAutomationView[] => {
    const readAtMs = profile ? Date.parse(profile.updatedAt) : chainStateReadAt;
    const nowSec = readAtMs !== null && Number.isFinite(readAtMs)
      ? BigInt(Math.floor(readAtMs / 1000))
      : 0n;
    return automations.map((automation) => {
      const evidence = automationEvidence(profile, automation);
      const chain = chainStates[automation.key] ?? null;
      return {
        ...automation,
        chain,
        state: deriveAutomationLifecycle(automation.parsed, chain, evidence, nowSec),
      };
    });
  }, [automations, chainStateReadAt, chainStates, profile]);

  const connectWallet = useCallback(async (): Promise<void> => {
    setBusy("connect");
    setError("");
    try {
      await connectSession();
      setNotice("Wallet connected. History is being read from Robinhood Chain.");
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

  // The bytes the executor daemon consumes, handed back exactly as they were
  // signed. Re-serializing would change the JSON and break the signature.
  const exportIntent = useCallback((automation: DashboardAutomation): void => {
    if (!automation.intentJson) return;
    const blob = new Blob([automation.intentJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = intentFileName(automation.parsed?.mode ?? automation.local?.mode ?? "recurring", automation.zap);
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const submitRevoke = useCallback(async (automation: DashboardAutomationView): Promise<void> => {
    if (!account || !automation.parsed) return;
    const actionKey = `revoke:${automation.key}`;
    setBusy(actionKey);
    setError("");
    setNotice("");
    let localActionId: string | null = null;
    try {
      const wallet = await requireWallet(account);
      const { request } = await publicClient.simulateContract({
        account,
        address: automation.zap,
        abi: openZapV3Abi,
        functionName: "invalidateNonce",
        args: [automation.parsed.authorizationId],
      });
      const hash = await wallet.writeContract(request);
      localActionId = `${hash}:revoke`;
      setLocalActions((rows) => [{
        id: localActionId as string,
        label: "Revocation pending",
        zap: automation.zap,
        status: "pending",
        txHash: hash,
        detail: "Waiting for Robinhood Chain confirmation.",
      }, ...rows]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The revocation transaction reverted. The authorization remains live.");
      const relayId = automation.relay?.id ?? automation.local?.relayId;
      if (relayId) await consumeIntent(relayId, "").catch(() => false);
      const current = readAutomationRecords(account);
      saveAutomationRecords(account, current.map((record) =>
        automationRecordMatchesIntentKey(record, automation.key)
          ? { ...record, revokedAt: new Date().toISOString(), revocationTx: hash }
          : record,
      ));
      setLocalActions((rows) => rows.filter((row) => row.id !== localActionId));
      setConfirmAction(null);
      setNotice("Authorization revoked onchain. That signed nonce or series can never Zap again.");
      await refreshDashboard();
    } catch (cause) {
      const message = readableError(cause);
      setError(message);
      if (localActionId) {
        setLocalActions((rows) => rows.map((row) => row.id === localActionId
          ? { ...row, status: "failed", label: "Revocation failed", detail: message }
          : row));
      }
    } finally {
      setBusy(null);
    }
  }, [account, refreshDashboard]);

  const submitRecovery = useCallback(async (automation: DashboardAutomationView): Promise<void> => {
    if (!account) return;
    const zap = profile?.zaps.find((row) => isAddressEqual(row.address, automation.zap));
    if (!zap?.trackedAssets) {
      setError("Tracked-asset reads are unavailable for this Zap. Recovery is disabled rather than guessing the asset list.");
      return;
    }
    const actionKey = `recover:${automation.key}`;
    setBusy(actionKey);
    setError("");
    setNotice("");
    let localActionId: string | null = null;
    try {
      const wallet = await requireWallet(account);
      const { request } = await publicClient.simulateContract({
        account,
        address: automation.zap,
        abi: openZapV3Abi,
        functionName: "emergencyExit",
        args: [[...zap.trackedAssets]],
      });
      const hash = await wallet.writeContract(request);
      localActionId = `${hash}:recover`;
      setLocalActions((rows) => [{
        id: localActionId as string,
        label: "Recovery pending",
        zap: automation.zap,
        status: "pending",
        txHash: hash,
        detail: "Returning every tracked asset and native balance to the owner.",
      }, ...rows]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The recovery transaction reverted. No balance was reported as recovered.");
      setLocalActions((rows) => rows.filter((row) => row.id !== localActionId));
      setConfirmAction(null);
      setNotice("Recovery confirmed. The Zap returned its tracked assets and native balance to the owner.");
      await refreshDashboard();
    } catch (cause) {
      const message = readableError(cause);
      setError(message);
      if (localActionId) {
        setLocalActions((rows) => rows.map((row) => row.id === localActionId
          ? { ...row, status: "failed", label: "Recovery failed", detail: message }
          : row));
      }
    } finally {
      setBusy(null);
    }
  }, [account, profile, refreshDashboard]);

  const filteredActivity = useMemo(() => {
    if (!profile) return [];
    const needle = search.trim().toLowerCase();
    return profile.activity.filter((row) => {
      const inFilter =
        filter === "all" ||
        (filter === "executions" && (row.kind === "executed" || row.kind === "automated")) ||
        (filter === "automation" && (row.kind === "automated" || row.kind === "series-finished")) ||
        (filter === "control" && (row.kind === "created" || row.kind === "recovered" || row.kind === "revoked"));
      if (!inFilter) return false;
      if (!needle) return true;
      return `${row.kind} ${row.detail} ${row.zap} ${row.txHash} ${row.assetSymbol ?? ""}`.toLowerCase().includes(needle);
    });
  }, [filter, profile, search]);

  if (!account) {
    return (
      <main className={styles.screen} id="main" data-screen-label="My zaps">
        <div className={styles.connect}>
          <div>
            <h1 className={styles.connectTitle}>My zaps</h1>
            <p className={styles.connectLede}>
              Connect a wallet to read its balances plus every confirmed Zap event across v1.1, v3, and v3.1 — then
              inspect, revoke, replace, or recover the automations it signed.
            </p>
            <div className={styles.connectActions}>
              <button className={styles.primaryBtn} data-busy={busy === "connect"} disabled={busy !== null} onClick={() => void connectWallet()} type="button">
                {busy === "connect" ? "Connecting…" : "Connect wallet"}
              </button>
              <Link className={styles.ghostBtn} href="/zap">New zap</Link>
            </div>
            {error ? <p className={styles.connectError} role="alert">{error}</p> : null}
          </div>
          <div className={styles.connectPreview} aria-label="What this screen shows">
            <PreviewRow glyph="coins" label="Holdings" value="balances · priced subtotal · sources" />
            <PreviewRow glyph="clock" label="History" value="creations · Zaps · recoveries" />
            <PreviewRow glyph="repeat" label="AutoZaps" value="recurring · price triggers" />
            <PreviewRow glyph="shield" label="Control" value="revoke · replace · recover" />
            <p className={styles.previewNote}>
              OpenZaps keeps no profile database. The connected address only selects public balances, chain logs,
              onchain quotes, and the executor-relay records it already published.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const totalRuns = (profile?.stats.oneShotExecutions ?? 0) + (profile?.stats.automatedRuns ?? 0);
  const activeAutomations = automationViews.filter((automation) => automation.state.cancelable).length;
  const chainMismatch = walletChainId !== ROBINHOOD_CHAIN_ID;
  const reading = loading || portfolioStatus === "loading";

  return (
    <main className={styles.screen} id="main" data-screen-label="My zaps">
      <header className={styles.head}>
        <div className={styles.identity}>
          <span className={styles.identicon} aria-hidden>{account.slice(2, 4)}</span>
          <div className={styles.identityText}>
            <h1 className={styles.title}>My zaps</h1>
            <code className={styles.address}>{account}</code>
          </div>
        </div>
        <div className={styles.headActions}>
          <a className={styles.ghostBtn} href={explorerAddress(account)} target="_blank" rel="noreferrer">Blockscout ↗</a>
          <button className={styles.ghostBtn} data-busy={reading} disabled={reading || busy !== null} onClick={() => void refreshAll()} type="button">
            {reading ? "Reading…" : "Refresh"}
          </button>
          <Link className={styles.primaryBtn} href="/zap">New zap</Link>
        </div>
      </header>

      {chainMismatch ? (
        <div className={`${styles.banner} ${styles.warning}`} role="alert">
          <span>
            Wallet network is {walletChainId === null ? "unavailable" : `chain ${walletChainId}`}. Reads still show
            Robinhood Chain, but writes stay paused until chain 4663 is active.
          </span>
          <button className={styles.ghostBtn} data-busy={busy === "connect"} disabled={busy !== null} onClick={() => void switchWalletNetwork()} type="button">
            {busy === "connect" ? "Switching…" : "Switch network"}
          </button>
        </div>
      ) : null}
      {notice ? <div className={`${styles.banner} ${styles.notice}`} role="status">{notice}</div> : null}
      {error ? <div className={`${styles.banner} ${styles.error}`} role="alert">{error}</div> : null}
      {localActions.map((action) => (
        <div className={`${styles.banner} ${action.status === "failed" ? styles.error : styles.pending}`} key={action.id} role={action.status === "failed" ? "alert" : "status"}>
          <strong>{action.label}</strong> · {shortAddress(action.zap)} · {action.detail}
          {action.txHash ? <a href={explorerTransaction(action.txHash)} target="_blank" rel="noreferrer"> transaction ↗</a> : null}
        </div>
      ))}

      <section className={styles.sourceBar} aria-label="Data source">
        <span className={styles.sourceChip} data-status={profile?.sourceStatus ?? "unavailable"}>
          {profile ? `chain reads · ${profile.sourceStatus}` : "chain reads · unavailable"}
        </span>
        <p className={styles.sourceCopy}>
          {profile
            ? `Read straight from Robinhood Chain logs at block ${Number(profile.headBlock).toLocaleString("en-US")}.${
              profile.sourceStatus === "degraded"
                ? " Degraded means at least one Zap's tracked-asset read failed, so its recovery control stays disabled."
                : ""
            } ${profile.sourceCaveat}`
            : "The canonical RPC history could not be read, so no empty state is asserted."}
        </p>
      </section>

      <section className={styles.metrics} aria-label="Wallet zap metrics">
        <Metric value={profile ? String(profile.stats.zapsCreated) : "—"} label="Zaps created" />
        <Metric value={profile ? String(totalRuns) : "—"} label="Zaps executed" />
        <Metric value={String(activeAutomations)} label="Live authorizations" />
        <Metric value={profile ? String(profile.stats.authorizationsRevoked) : "—"} label="Revocations" />
      </section>

      <PortfolioPanel
        status={portfolioStatus}
        data={portfolio}
        error={portfolioError}
        onRetry={() => void refreshPortfolio()}
      />

      <section aria-labelledby="automation-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} id="automation-heading">Signed authorizations</h2>
          <span className={styles.sectionLede}>Every authorization this wallet signed — live, spent, expired, or revoked.</span>
          <span className={styles.relayBadge} data-status={relayStatus}>
            relay {relayStatus === "live" ? "connected" : relayStatus === "unavailable" ? "unavailable" : "idle"}
          </span>
        </div>
        <p className={styles.sectionNote}>
          Relay records make signed automations visible across browsers. Onchain nonce, series, and log reads decide
          each state. Editing is replacement: revoke the old immutable authorization, then sign new terms.
        </p>

        {automationViews.length === 0 ? (
          <div className={styles.emptyCard}>
            <BlockGlyph name="repeat" />
            <h3>No signed automation found.</h3>
            <p>Confirmed v3/v3.1 Zaps still appear in history. A standing intent appears here after it is signed locally or published to the relay.</p>
            <Link className={styles.primaryBtn} href="/zap?view=automate">Create an AutoZap</Link>
          </div>
        ) : (
          <div className={styles.automationGrid}>
            {automationViews.map((automation) => {
              const confirm = confirmAction?.key === automation.key ? confirmAction.kind : null;
              const zapSummary = profile?.zaps.find((row) => isAddressEqual(row.address, automation.zap));
              return (
                <article className={styles.automationCard} data-state={automation.state.lifecycle} key={automation.key}>
                  <header className={styles.autoHeader}>
                    <span className={styles.autoGlyph}>
                      <BlockGlyph name={automation.parsed?.mode === "trigger" ? "band" : "repeat"} />
                    </span>
                    <div>
                      <span className={styles.autoEyebrow}>{automationEyebrow(automation, zapSummary)}</span>
                      <h3 className={styles.autoTitle}>{automationTerms(automation)}</h3>
                    </div>
                    <span className={styles.stateBadge} data-state={automation.state.lifecycle}>{automation.state.label}</span>
                  </header>
                  <p className={styles.stateDetail}>{automation.state.detail}</p>
                  <AutomationProgress automation={automation} />
                  <dl className={styles.autoFacts}>
                    <div><dt>Zap</dt><dd><Link href={`/explore/${automation.zap}`}>{shortAddress(automation.zap)}</Link></dd></div>
                    <div><dt>Authorization</dt><dd>{automation.parsed ? shortId(automation.parsed.authorizationId) : "not signed"}</dd></div>
                    <div><dt>Progress</dt><dd>{automationProgress(automation)}</dd></div>
                    <div><dt>Source</dt><dd>{automation.relay ? "executor relay" : automation.local ? "this browser" : "—"}</dd></div>
                  </dl>

                  {confirm === "revoke" ? (
                    <div className={styles.confirmBox} data-kind="revoke" role="alert">
                      <strong>Revoke this authorization?</strong>
                      <p>This writes invalidateNonce onchain. It cannot be undone, and the existing signature can never Zap again. Zap balances stay in place.</p>
                      <div className={styles.confirmActions}>
                        <button className={styles.actionBtn} disabled={busy !== null} onClick={() => setConfirmAction(null)} type="button">Keep live</button>
                        <button className={`${styles.primaryBtn} ${styles.confirmGo}`} data-busy={busy === `revoke:${automation.key}`} disabled={chainMismatch || busy !== null} onClick={() => void submitRevoke(automation)} type="button">
                          {busy === `revoke:${automation.key}` ? "Revoking…" : "Confirm onchain revoke"}
                        </button>
                      </div>
                    </div>
                  ) : confirm === "recover" ? (
                    <div className={styles.confirmBox} data-kind="recover" role="alert">
                      <strong>Recover Zap balances?</strong>
                      <p>This returns all tracked assets and native balance to the owner. It does not revoke a still-live signature; revoke separately if you want execution authority removed.</p>
                      <div className={styles.confirmActions}>
                        <button className={styles.actionBtn} disabled={busy !== null} onClick={() => setConfirmAction(null)} type="button">Keep funded</button>
                        <button className={`${styles.primaryBtn} ${styles.confirmGo}`} data-busy={busy === `recover:${automation.key}`} disabled={chainMismatch || busy !== null || zapSummary?.managementReadsStatus !== "live"} onClick={() => void submitRecovery(automation)} type="button">
                          {busy === `recover:${automation.key}` ? "Recovering…" : "Confirm recovery"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.autoActions}>
                      {automation.state.cancelable && automation.parsed ? (
                        <button className={styles.actionBtn} disabled={chainMismatch || busy !== null} onClick={() => setConfirmAction({ kind: "revoke", key: automation.key })} type="button">Revoke</button>
                      ) : null}
                      {automation.intentJson ? (
                        <button className={styles.actionBtn} onClick={() => exportIntent(automation)} type="button">Export intent</button>
                      ) : null}
                      <Link className={styles.actionZap} href={replacementHref(automation)}>Sign new terms</Link>
                      <button className={styles.actionBtn} disabled={chainMismatch || busy !== null || zapSummary?.managementReadsStatus !== "live"} onClick={() => setConfirmAction({ kind: "recover", key: automation.key })} type="button">Recover funds</button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {profile && profile.zaps.length > 0 ? (
        <section aria-labelledby="capsules-heading">
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle} id="capsules-heading">Zaps you created</h2>
            <span className={styles.sectionLede}>Every Zap this wallet created. Open one to read its policy, balances, and confirmed history.</span>
          </div>
          <p className={styles.sectionNote}>Automation records can be browser- or relay-scoped. This list is not: it comes only from canonical factory ZapCreated logs.</p>
          <div className={styles.capsuleGrid}>
            {profile.zaps.map((zap) => <CapsuleCard zap={zap} key={zap.address} />)}
          </div>
        </section>
      ) : null}

      <div className={styles.tail}>
        <section className={styles.activityCard} aria-labelledby="activity-heading">
          <div className={styles.activityHead}>
            <h2 className={styles.activityTitle} id="activity-heading">Activity</h2>
            <span className={styles.activityHint}>every confirmed event on the Zaps this wallet created</span>
            <div className={styles.search}>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search activity by Zap, transaction, or asset"
                placeholder="Search Zap, tx, or asset…"
              />
            </div>
          </div>
          <div className={styles.filters} role="group" aria-label="Filter activity">
            {(["all", "executions", "automation", "control"] as const).map((value) => (
              <button
                className={filter === value ? styles.filterOn : styles.filter}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                type="button"
                key={value}
              >
                {value === "all" ? "All" : value === "executions" ? "Zaps" : value === "automation" ? "AutoZaps" : "Created & control"}
              </button>
            ))}
          </div>

          {!profile ? (
            <div className={styles.unavailable} role="alert">History is unavailable. No zero count or empty list is inferred.</div>
          ) : filteredActivity.length === 0 ? (
            <div className={styles.emptyActivity}>No confirmed event matches this filter or search.</div>
          ) : (
            <ol className={styles.timeline}>
              {filteredActivity.map((row) => (
                <li key={row.id} className={styles.timelineRow}>
                  <span className={styles.timelineGlyph} data-kind={row.kind}><BlockGlyph name={ACTIVITY_GLYPHS[row.kind]} /></span>
                  <div className={styles.timelineMain}>
                    <span className={styles.timelineType}>{ACTIVITY_LABELS[row.kind]} · {row.lineage}</span>
                    <strong>{activityTitle(row)}</strong>
                    <p>{row.detail}</p>
                  </div>
                  <div className={styles.timelineMeta}>
                    <Link href={`/explore/${row.zap}`}>{shortAddress(row.zap)}</Link>
                    <a href={explorerTransaction(row.txHash)} target="_blank" rel="noreferrer">{row.timestamp ? formatDate(row.timestamp) : `block ${Number(row.blockNumber).toLocaleString("en-US")}`} ↗</a>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <aside className={styles.recovery} aria-labelledby="recovery-heading">
          <h2 id="recovery-heading">Recovery</h2>
          <p>Withdraw and revoke need no one&rsquo;s cooperation — not ours, not an executor&rsquo;s.</p>
          <div className={styles.recoveryActions}>
            {/* The design drew a wallet-wide "recover everything" button. There
                is no such call: `emergencyExit` is per Zap and is gated on that
                Zap's tracked-asset read. So this points at the cards where the
                real, confirm-gated control lives instead of promising a
                transaction the contracts cannot make. */}
            <a className={styles.recoveryLink} href="#automation-heading">Recover from an authorization</a>
            <p className={styles.recoveryNote}>
              Emergency recovery is per Zap and lives on each authorization card: it returns that Zap&rsquo;s tracked
              assets and native balance to you. A Zap whose tracked-asset read failed keeps its control disabled rather
              than guessing the asset list.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function mergeAutomations(
  owner: Address | null,
  localRecords: readonly AutomationRecord[],
  relayRecords: readonly RelayRecord[],
): DashboardAutomation[] {
  if (!owner) return [];
  const merged = new Map<string, DashboardAutomation>();
  for (const relay of relayRecords) {
    if (!sameAddress(relay.owner, owner)) continue;
    const intentJson = JSON.stringify({ kind: relay.kind, intent: relay.intent, signature: relay.signature });
    const parsed = parseAutomationIntent(intentJson);
    if (!parsed || !sameAddress(relay.zap, parsed.zap)) continue;
    const key = automationIntentKey(parsed);
    merged.set(key, { key, zap: parsed.zap, parsed, local: null, relay, createdAt: relay.createdAt, intentJson });
  }
  for (const local of localRecords) {
    const parsed = local.intentFile ? parseAutomationIntent(local.intentFile) : null;
    const key = parsed ? automationIntentKey(parsed) : `draft:${local.address.toLowerCase()}`;
    const existing = merged.get(key);
    merged.set(key, {
      key,
      zap: local.address,
      parsed,
      local,
      relay: existing?.relay ?? null,
      createdAt: local.createdAt || existing?.createdAt || new Date(0).toISOString(),
      intentJson: local.intentFile ?? existing?.intentJson ?? null,
    });
  }
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function loadAutomationChainState(intent: ParsedAutomationIntent | null): Promise<AutomationChainState | null> {
  if (!intent) return null;
  try {
    if (intent.mode === "recurring") {
      const [nonceUsed, series] = await Promise.all([
        publicClient.readContract({ address: intent.zap, abi: openZapV3Abi, functionName: "nonceUsed", args: [intent.authorizationId] }),
        publicClient.readContract({ address: intent.zap, abi: openZapV3Abi, functionName: "series", args: [intent.authorizationId] }),
      ]);
      return { nonceUsed, runs: Number(series[0]), lastRun: BigInt(series[1]), priceX96: null };
    }
    const nonceUsed = await publicClient.readContract({
      address: intent.zap,
      abi: openZapV3Abi,
      functionName: "nonceUsed",
      args: [intent.authorizationId],
    });
    let priceX96: bigint | null = null;
    if (intent.priceSource) {
      priceX96 = await publicClient.readContract({
        address: intent.priceSource,
        abi: priceSourceAbi,
        functionName: "priceX96",
      }).catch(() => null);
    }
    return { nonceUsed, runs: null, lastRun: null, priceX96 };
  } catch {
    return null;
  }
}

function automationEvidence(
  profile: WalletProfilePayload | null,
  automation: DashboardAutomation,
): { revoked: boolean; completed: boolean } {
  if (!profile || !automation.parsed) return { revoked: false, completed: false };
  const matches = (row: WalletActivityEntry): boolean =>
    isAddressEqual(row.zap, automation.zap) && row.authorizationId === automation.parsed?.authorizationId.toString();
  return {
    revoked: profile.activity.some((row) => row.kind === "revoked" && matches(row)),
    completed: profile.activity.some((row) =>
      matches(row) && (
        row.kind === "series-finished" ||
        (automation.parsed?.mode === "trigger" && row.kind === "automated" && row.automationKind === "trigger")
      ),
    ),
  };
}

async function requireWallet(account: Address) {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("Wallet provider disconnected.");
  await ensureRobinhoodChain(provider);
  const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
  const [active] = await wallet.getAddresses();
  if (!active || !isAddressEqual(active, account)) throw new Error("The active wallet changed. Refresh the profile before submitting.");
  return wallet;
}

function automationEyebrow(automation: DashboardAutomation, zapSummary: WalletZapSummary | undefined): string {
  const mode = automation.parsed?.mode === "trigger" ? "Price trigger" : automation.parsed ? "Recurring" : "Draft";
  return zapSummary ? `${mode} · ${zapSummary.lineage}` : mode;
}

function automationTerms(automation: DashboardAutomation): string {
  if (automation.local?.terms) return automation.local.terms;
  const intent = automation.parsed;
  if (!intent) return "Unsigned Zap";
  if (intent.mode === "recurring") {
    return `${formatInterval(intent.interval)} · ${intent.maxRuns ?? "?"} Zaps · expires ${formatDeadline(intent.deadline)}`;
  }
  return `${intent.thresholdBps === null ? "?" : intent.thresholdBps / 100}% signed move · expires ${formatDeadline(intent.deadline)}`;
}

function automationProgress(automation: DashboardAutomationView): string {
  if (!automation.parsed) return "not signed";
  if (automation.parsed.mode === "trigger") return automation.chain?.nonceUsed ? "nonce spent" : "one Zap, unspent";
  const runs = automation.chain?.runs;
  return runs === null || runs === undefined ? "unavailable" : `${runs} / ${automation.parsed.maxRuns ?? "?"} Zaps`;
}

/**
 * How far spot has travelled toward a signed price threshold, as 0..1.
 *
 * Returns null the moment any input is missing. A bar drawn from a failed price
 * read would claim "nowhere near" when the truth is "we could not read it" —
 * the exact false zero the source bar promises this page never shows. The armed
 * verdict itself still comes from `deriveAutomationLifecycle`; this only draws
 * the position it implies.
 */
function triggerProgress(chain: AutomationChainState | null, intent: ParsedAutomationIntent): number | null {
  const price = chain?.priceX96;
  const baseline = intent.baselinePriceX96;
  if (price === null || price === undefined) return null;
  if (baseline === null || baseline === 0n) return null;
  if (intent.thresholdBps === null || intent.thresholdBps <= 0 || intent.above === null) return null;
  const moveBps = Number(((price - baseline) * 10_000n) / baseline);
  const towardThreshold = intent.above ? moveBps : -moveBps;
  return Math.min(1, Math.max(0, towardThreshold / intent.thresholdBps));
}

function AutomationProgress({ automation }: { automation: DashboardAutomationView }): React.JSX.Element | null {
  const intent = automation.parsed;
  if (!intent) return null;

  if (intent.mode === "recurring") {
    const runs = automation.chain?.runs;
    if (runs === null || runs === undefined) {
      return <p className={styles.factNote}>Run progress unavailable — the series read failed.</p>;
    }
    const maxRuns = intent.maxRuns;
    if (maxRuns === null || maxRuns <= 0) {
      return <p className={styles.factNote}>Run progress unavailable — the signed run count could not be read.</p>;
    }
    if (maxRuns <= MAX_RUN_SEGMENTS) {
      return (
        <div className={styles.progressTrack}>
          {Array.from({ length: maxRuns }, (_, index) => (
            <i className={styles.progressSeg} data-on={index < runs} key={index} />
          ))}
        </div>
      );
    }
    // Past the readable segment count the same fact is told as one proportional
    // bar rather than as 200 hairlines.
    const done = Math.min(1, Math.max(0, runs / maxRuns));
    return (
      <div className={styles.progressTrack}>
        {done > 0 ? <i className={styles.progressSeg} data-on style={{ flex: done }} /> : null}
        {done < 1 ? <i className={styles.progressSeg} style={{ flex: 1 - done }} /> : null}
      </div>
    );
  }

  const progress = triggerProgress(automation.chain, intent);
  if (progress === null) {
    return <p className={styles.factNote}>Price read unavailable — the trigger position cannot be shown.</p>;
  }
  return (
    <div className={styles.thresholdBar}>
      <i className={styles.thresholdFill} style={{ width: `${(progress * 100).toFixed(1)}%` }} />
      <i className={styles.thresholdMark} />
    </div>
  );
}

function replacementHref(automation: DashboardAutomation): string {
  const routeId = automation.local?.routeId ?? (
    automation.parsed && isAddressEqual(automation.parsed.outAsset, ROBINHOOD_ASSETS.weth)
      ? "robinhood-v4-zaps-weth"
      : "robinhood-v4-weth-zaps"
  );
  const route = resolveRouteById(routeId);
  let amount = "0.01";
  if (route && automation.local) {
    try {
      amount = trimDecimal(formatUnits(BigInt(automation.local.amountPerRun), route.tokenIn.decimals));
    } catch {
      amount = "0.01";
    }
  }
  const mode = automation.parsed?.mode ?? automation.local?.mode ?? "recurring";
  const params = new URLSearchParams({
    view: "automate",
    src: "build",
    mode,
    route: routeId,
    amount,
    bps: "100",
  });
  if (mode === "recurring") {
    params.set("interval", intervalPreset(automation.parsed?.interval ?? null));
    params.set("runs", String(automation.parsed?.maxRuns ?? automation.local?.plannedRuns ?? 10));
  } else {
    params.set("threshold", "up10");
    params.set("days", "30");
  }
  return `/zap?${params.toString()}`;
}

function activityTitle(row: WalletActivityEntry): string {
  if (row.amount && row.assetSymbol) return `${formatRawAmount(row.amount, row.assetSymbol)} ${row.assetSymbol}`;
  if (row.authorizationId) return `Authorization ${shortId(BigInt(row.authorizationId))}`;
  return row.kind === "created" ? `${row.lineage} Zap contract` : ACTIVITY_LABELS[row.kind];
}

function formatRawAmount(raw: string, symbol: string): string {
  const decimals = symbol === "USDG" ? 6 : symbol === "ozUSDG" ? 9 : 18;
  try {
    const value = formatUnits(BigInt(raw), decimals);
    const [whole, fraction = ""] = value.split(".");
    const trimmed = fraction.slice(0, 5).replace(/0+$/, "");
    return `${Number(whole).toLocaleString("en-US")}${trimmed ? `.${trimmed}` : ""}`;
  } catch {
    return "—";
  }
}

function formatInterval(interval: bigint | null): string {
  if (interval === 3_600n) return "hourly";
  if (interval === 21_600n) return "every 6 hours";
  if (interval === 86_400n) return "daily";
  if (interval === 604_800n) return "weekly";
  return interval === null ? "cadence unavailable" : `every ${interval.toString()}s`;
}

function intervalPreset(interval: bigint | null): string {
  if (interval === 3_600n) return "hourly";
  if (interval === 21_600n) return "six-hourly";
  if (interval === 604_800n) return "weekly";
  return "daily";
}

function formatDeadline(deadline: bigint): string {
  const millis = Number(deadline) * 1000;
  return Number.isSafeInteger(Number(deadline)) ? new Date(millis).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "an unreadable date";
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function trimDecimal(value: string): string {
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed && trimmed !== "0" ? trimmed : "0.01";
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function sameAddress(value: string, expected: Address): boolean {
  try {
    return isAddressEqual(getAddress(value), expected);
  } catch {
    return false;
  }
}

function shortId(id: bigint): string {
  const value = id.toString();
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-5)}`;
}

function readableError(cause: unknown): string {
  if (cause instanceof Error) return cause.message.split("\n")[0].replace("User rejected the request.", "Wallet request rejected.");
  return "Unknown wallet or RPC error.";
}

function Metric({ value, label }: { value: string; label: string }): React.JSX.Element {
  return <div className={styles.metric}><strong>{value}</strong><span>{label}</span></div>;
}

function PreviewRow({ glyph, label, value }: { glyph: string; label: string; value: string }): React.JSX.Element {
  return <div className={styles.previewRow}><BlockGlyph name={glyph} /><span>{label}</span><strong>{value}</strong></div>;
}

function CapsuleCard({ zap }: { zap: WalletZapSummary }): React.JSX.Element {
  return (
    <Link className={styles.capsuleCard} href={`/explore/${zap.address}`}>
      <span className={styles.capsuleLineage}>{zap.lineage}</span>
      <code>{shortAddress(zap.address)}</code>
      <strong>{zap.executionCount + zap.automatedRunCount} confirmed Zaps</strong>
      <small>{zap.revocationCount} revoked · {zap.recoveryCount} recoveries</small>
      <span className={styles.capsuleOpen}>Open →</span>
    </Link>
  );
}
