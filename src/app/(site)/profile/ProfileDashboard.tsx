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
  executed: "bolt",
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
      setError("Tracked-asset reads are unavailable for this capsule. Recovery is disabled rather than guessing the asset list.");
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
      setNotice("Recovery confirmed. The capsule returned its tracked assets and native balance to the owner.");
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
      <main className={styles.page} id="main">
        <section className={`container ${styles.connectHero}`}>
          <div>
            <span className="eyebrow">Profile</span>
            <h1>Your zaps.<br />One control room.</h1>
            <p>
              Connect a wallet to read curated balances plus every confirmed capsule event attributed to it across
              v1.1, v3, and v3.1, then inspect, revoke, replace, or recover supported automations.
            </p>
            <div className={styles.heroActions}>
              <button className="btn btnPrimary btnLg" data-busy={busy === "connect"} disabled={busy !== null} onClick={() => void connectWallet()} type="button">
                {busy === "connect" ? "Connecting…" : "Connect wallet"}
              </button>
              <Link className="btn btnGhost btnLg" href="/zap">Create a zap</Link>
            </div>
            {error ? <p className={styles.connectError} role="alert">{error}</p> : null}
          </div>
          <div className={styles.connectPreview} aria-label="Profile capabilities">
            <PreviewRow glyph="coins" label="Holdings" value="balances · priced subtotal · sources" />
            <PreviewRow glyph="clock" label="History" value="creations · Zaps · recoveries" />
            <PreviewRow glyph="repeat" label="AutoZaps" value="recurring · price triggers" />
            <PreviewRow glyph="shield" label="Control" value="revoke · replace · recover" />
            <p>No account is uploaded to an OpenZaps profile database. The connected address selects public balances, chain logs, onchain quotes, and its relayed executor records.</p>
          </div>
        </section>
      </main>
    );
  }

  const totalRuns = (profile?.stats.oneShotExecutions ?? 0) + (profile?.stats.automatedRuns ?? 0);
  const activeAutomations = automationViews.filter((automation) => automation.state.cancelable).length;
  const chainMismatch = walletChainId !== ROBINHOOD_CHAIN_ID;

  return (
    <main className={styles.page} id="main">
      <section className={`container ${styles.profileHead}`}>
        <div className={styles.identity}>
          <span className={styles.identicon} aria-hidden>{account.slice(2, 4)}</span>
          <div>
            <span className="eyebrow">Wallet profile</span>
            <h1>{shortAddress(account)}</h1>
            <code>{account}</code>
          </div>
        </div>
        <div className={styles.headActions}>
          <a className="btn btnGhost" href={explorerAddress(account)} target="_blank" rel="noreferrer">Blockscout ↗</a>
          <button className="btn btnGhost" disabled={loading || portfolioStatus === "loading" || busy !== null} onClick={() => void refreshAll()} type="button">
            {loading || portfolioStatus === "loading" ? "Reading…" : "Refresh"}
          </button>
          <Link className="btn btnPrimary" href="/zap">New zap</Link>
        </div>
      </section>

      {chainMismatch ? (
        <div className={`container ${styles.warning}`} role="alert">
          Wallet network is {walletChainId === null ? "unavailable" : `chain ${walletChainId}`}. Reads still show Robinhood Chain, but writes stay paused until chain 4663 is active.
          {" "}
          <button className="btn btnGhost" data-busy={busy === "connect"} disabled={busy !== null} onClick={() => void switchWalletNetwork()} type="button">
            {busy === "connect" ? "Switching…" : "Switch network"}
          </button>
        </div>
      ) : null}
      {notice ? <div className={`container ${styles.notice}`} role="status">{notice}</div> : null}
      {error ? <div className={`container ${styles.error}`} role="alert">{error}</div> : null}
      {localActions.map((action) => (
        <div className={`container ${action.status === "failed" ? styles.error : styles.pending}`} key={action.id} role={action.status === "failed" ? "alert" : "status"}>
          <strong>{action.label}</strong> · {shortAddress(action.zap)} · {action.detail}
          {action.txHash ? <a href={explorerTransaction(action.txHash)} target="_blank" rel="noreferrer"> transaction ↗</a> : null}
        </div>
      ))}

      <PortfolioPanel
        status={portfolioStatus}
        data={portfolio}
        error={portfolioError}
        onRetry={() => void refreshPortfolio()}
      />

      <section className={`container ${styles.sourceBar}`} aria-label="Data source">
        <span data-status={profile?.sourceStatus ?? "unavailable"}>
          {profile ? `${profile.sourceStatus} · block ${Number(profile.headBlock).toLocaleString("en-US")}` : "source unavailable"}
        </span>
        <p>{profile?.sourceCaveat ?? "The canonical RPC history could not be read, so no empty state is asserted."}</p>
      </section>

      <section className={`container ${styles.metrics}`} aria-label="Wallet zap metrics">
        <Metric value={profile ? String(profile.stats.zapsCreated) : "—"} label="Capsules created" />
        <Metric value={profile ? String(totalRuns) : "—"} label="Confirmed Zaps" />
        <Metric value={String(activeAutomations)} label="Live authorizations" />
        <Metric value={profile ? String(profile.stats.authorizationsRevoked) : "—"} label="Revocations" />
      </section>

      <section className={`container ${styles.automationSection}`} aria-labelledby="automation-heading">
        <header className={styles.sectionHead}>
          <div>
            <span className="eyebrow">Auto zaps</span>
            <h2 id="automation-heading">Signed terms, live state, enforceable controls.</h2>
            <p>
              Relay records make signed automations visible across browsers. Capsule nonce and series reads decide the state.
              Editing is replacement: revoke the old immutable authorization, then sign new terms.
            </p>
          </div>
          <span className={styles.relayBadge} data-status={relayStatus}>
            relay {relayStatus === "live" ? "connected" : relayStatus === "unavailable" ? "unavailable" : "idle"}
          </span>
        </header>

        {automationViews.length === 0 ? (
          <div className={styles.emptyCard}>
            <BlockGlyph name="repeat" />
            <h3>No signed automation found.</h3>
            <p>Confirmed v3/v3.1 capsules still appear in history. A standing intent appears here after it is signed locally or published to the relay.</p>
            <Link className="btn btnPrimary" href="/zap?view=automate">Create auto zap</Link>
          </div>
        ) : (
          <div className={styles.automationGrid}>
            {automationViews.map((automation) => {
              const confirm = confirmAction?.key === automation.key ? confirmAction.kind : null;
              const zapSummary = profile?.zaps.find((row) => isAddressEqual(row.address, automation.zap));
              return (
                <article className={styles.automationCard} data-state={automation.state.lifecycle} key={automation.key}>
                  <header>
                    <span className={styles.autoGlyph}>
                      <BlockGlyph name={automation.parsed?.mode === "trigger" ? "band" : "repeat"} />
                    </span>
                    <div>
                      <span>{automation.parsed?.mode === "trigger" ? "Price trigger" : automation.parsed ? "Recurring" : "Automation draft"}</span>
                      <h3>{automationTerms(automation)}</h3>
                    </div>
                    <span className={styles.stateBadge} data-state={automation.state.lifecycle}>{automation.state.label}</span>
                  </header>
                  <p className={styles.stateDetail}>{automation.state.detail}</p>
                  <dl className={styles.autoFacts}>
                    <div><dt>Capsule</dt><dd><Link href={`/explore/${automation.zap}`}>{shortAddress(automation.zap)}</Link></dd></div>
                    <div><dt>Authorization</dt><dd>{automation.parsed ? shortId(automation.parsed.authorizationId) : "not signed"}</dd></div>
                    <div><dt>Progress</dt><dd>{automationProgress(automation)}</dd></div>
                    <div><dt>Source</dt><dd>{automation.relay ? "executor relay" : automation.local ? "this browser" : "—"}</dd></div>
                  </dl>

                  {confirm === "revoke" ? (
                    <div className={styles.confirmBox} role="alert">
                      <strong>Revoke this authorization?</strong>
                      <p>This writes `invalidateNonce` onchain. It cannot be undone, and the existing signature can never Zap again. Capsule funds stay in place.</p>
                      <div>
                        <button className="btn btnGhost" disabled={busy !== null} onClick={() => setConfirmAction(null)} type="button">Keep live</button>
                        <button className="btn btnPrimary" data-busy={busy === `revoke:${automation.key}`} disabled={chainMismatch || busy !== null} onClick={() => void submitRevoke(automation)} type="button">
                          {busy === `revoke:${automation.key}` ? "Revoking…" : "Confirm onchain revoke"}
                        </button>
                      </div>
                    </div>
                  ) : confirm === "recover" ? (
                    <div className={styles.confirmBox} role="alert">
                      <strong>Recover capsule balances?</strong>
                      <p>This returns all tracked assets and native balance to the owner. It does not revoke a still-live signature; revoke separately if you want execution authority removed.</p>
                      <div>
                        <button className="btn btnGhost" disabled={busy !== null} onClick={() => setConfirmAction(null)} type="button">Keep funded</button>
                        <button className="btn btnPrimary" data-busy={busy === `recover:${automation.key}`} disabled={chainMismatch || busy !== null || zapSummary?.managementReadsStatus !== "live"} onClick={() => void submitRecovery(automation)} type="button">
                          {busy === `recover:${automation.key}` ? "Recovering…" : "Confirm recovery"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.autoActions}>
                      {automation.state.cancelable && automation.parsed ? (
                        <button className="btn btnGhost" disabled={chainMismatch || busy !== null} onClick={() => setConfirmAction({ kind: "revoke", key: automation.key })} type="button">Revoke</button>
                      ) : null}
                      <Link className="btn btnGhost" href={replacementHref(automation)}>Create replacement</Link>
                      <button className="btn btnGhost" disabled={chainMismatch || busy !== null || zapSummary?.managementReadsStatus !== "live"} onClick={() => setConfirmAction({ kind: "recover", key: automation.key })} type="button">Recover funds</button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className={`container ${styles.activitySection}`} aria-labelledby="activity-heading">
        <header className={styles.activityHead}>
          <div>
            <span className="eyebrow">Activity</span>
            <h2 id="activity-heading">Confirmed wallet history.</h2>
          </div>
          <label className={styles.search}>
            <span className="srOnly">Filter by zap or transaction</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search zap or transaction" />
          </label>
        </header>
        <div className={styles.filters} role="group" aria-label="Filter activity">
          {(["all", "executions", "automation", "control"] as const).map((value) => (
            <button className={filter === value ? styles.filterOn : styles.filter} onClick={() => setFilter(value)} type="button" key={value}>
              {value === "all" ? "All activity" : value === "executions" ? "Zaps" : value === "automation" ? "AutoZaps" : "Create / control"}
            </button>
          ))}
        </div>

        {!profile ? (
          <div className={styles.unavailable} role="alert">History is unavailable. No zero counts or empty list are inferred.</div>
        ) : filteredActivity.length === 0 ? (
          <div className={styles.emptyActivity}>No confirmed event matches this filter.</div>
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

      {profile && profile.zaps.length > 0 ? (
        <section className={`container ${styles.capsuleSection}`} aria-labelledby="capsules-heading">
          <header className={styles.sectionHead}>
            <div>
              <span className="eyebrow">Capsules</span>
              <h2 id="capsules-heading">Every factory creation for this wallet.</h2>
              <p>Automation records can be browser- or relay-scoped. This list is not: it comes only from canonical factory `ZapCreated` logs.</p>
            </div>
          </header>
          <div className={styles.capsuleGrid}>
            {profile.zaps.map((zap) => <CapsuleCard zap={zap} key={zap.address} />)}
          </div>
        </section>
      ) : null}
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
    const parsed = parseAutomationIntent(JSON.stringify({ kind: relay.kind, intent: relay.intent, signature: relay.signature }));
    if (!parsed || !sameAddress(relay.zap, parsed.zap)) continue;
    const key = automationIntentKey(parsed);
    merged.set(key, { key, zap: parsed.zap, parsed, local: null, relay, createdAt: relay.createdAt });
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

function automationTerms(automation: DashboardAutomation): string {
  if (automation.local?.terms) return automation.local.terms;
  const intent = automation.parsed;
  if (!intent) return "Unsigned capsule";
  if (intent.mode === "recurring") {
    return `${formatInterval(intent.interval)} · ${intent.maxRuns ?? "?"} Zaps · expires ${formatDeadline(intent.deadline)}`;
  }
  return `${intent.thresholdBps === null ? "?" : intent.thresholdBps / 100}% signed move · expires ${formatDeadline(intent.deadline)}`;
}

function automationProgress(automation: DashboardAutomationView): string {
  if (!automation.parsed) return "not signed";
  if (automation.parsed.mode === "trigger") return automation.chain?.nonceUsed ? "nonce spent" : "one Zap";
  const runs = automation.chain?.runs;
  return runs === null || runs === undefined ? "unavailable" : `${runs} / ${automation.parsed.maxRuns ?? "?"} Zaps`;
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
  return row.kind === "created" ? `${row.lineage} policy capsule` : ACTIVITY_LABELS[row.kind];
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
  return Number.isSafeInteger(Number(deadline)) ? new Date(millis).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "signed deadline";
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
      <span>Open capsule →</span>
    </Link>
  );
}
