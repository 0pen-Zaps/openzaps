"use client";

import { useEffect, useMemo, useState } from "react";
import { OpenZapMark } from "@/components/OpenZapMark";
import { trackEvent } from "@/lib/analytics";
import { CHAIN, CONTRACTS, contractsLive, explorer } from "@/lib/config";
import {
  POLICY_TEMPLATES,
  TOKENS,
  buildPolicyDraft,
  getTemplate,
  shortHash,
  simulatePolicy,
  type AuthorityModel,
  type PolicyDraft,
  type PolicyStatus,
  type PolicyTemplateId,
  type SimulationResult,
} from "@/lib/policy";
import styles from "./app.module.css";

type PolicyRecord = {
  id: string;
  policy: PolicyDraft;
  simulation: SimulationResult;
  status: PolicyStatus;
  createdAt: string;
  nextRun: string;
  version: number;
  history: AuditEvent[];
};

type AuditEvent = {
  id: string;
  time: string;
  actor: string;
  action: string;
  detail: string;
  status: "pass" | "warn" | "block";
};

const DEMO_ADDRESS = "0x7b7D2F44F4eC84e2b9D30c879d3B8710C0a77E3a";
const EMPTY_OWNER = "0x0000000000000000000000000000000000000000";
const STORAGE_KEY = "openzaps:demo-policies:v2";

const MODELS: Array<{ id: AuthorityModel; label: string; hint: string }> = [
  { id: "deposit", label: "Deposit", hint: "Pre-fund an immutable capsule" },
  { id: "intent", label: "Typed intent", hint: "One-shot EIP-712 authority" },
  { id: "safe", label: "Safe / ERC-1271", hint: "Contract wallet validation" },
  { id: "session", label: "Session key", hint: "Planned smart-account mode" },
];

export default function AppPage(): React.JSX.Element {
  const live = contractsLive();
  const [connected, setConnected] = useState(false);
  const [templateId, setTemplateId] = useState<PolicyTemplateId>("recurring-dca");
  const [authorityModel, setAuthorityModel] = useState<AuthorityModel>("deposit");
  const [tokenIn, setTokenIn] = useState("USDC");
  const [tokenOut, setTokenOut] = useState("WETH");
  const [amount, setAmount] = useState("250");
  const [maxSpend, setMaxSpend] = useState("1000");
  const [frequency, setFrequency] = useState("weekly");
  const [slippageBps, setSlippageBps] = useState(50);
  const [humanApproval, setHumanApproval] = useState(false);
  const [privateSubmission, setPrivateSubmission] = useState(true);
  const [alerts, setAlerts] = useState(["Farcaster", "Webhook"]);
  const [records, setRecords] = useState<PolicyRecord[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [reviewedPolicy, setReviewedPolicy] = useState<PolicyDraft | null>(null);
  const [toast, setToast] = useState("");
  const [copiedId, setCopiedId] = useState("");

  const template = getTemplate(templateId);
  const owner = connected ? DEMO_ADDRESS : EMPTY_OWNER;

  const policy = useMemo(
    () =>
      buildPolicyDraft({
        templateId,
        authorityModel,
        owner,
        recipient: owner,
        tokenIn,
        tokenOut,
        amount,
        maxSpend,
        frequency,
        slippageBps,
        humanApproval,
        privateSubmission,
        alerts,
      }),
    [
      templateId,
      authorityModel,
      owner,
      tokenIn,
      tokenOut,
      amount,
      maxSpend,
      frequency,
      slippageBps,
      humanApproval,
      privateSubmission,
      alerts,
    ],
  );

  const simulation = useMemo(() => simulatePolicy(policy, reviewedPolicy ?? undefined), [policy, reviewedPolicy]);
  const reviewedHash = reviewedPolicy ? simulatePolicy(reviewedPolicy).policyHash : "";
  const hasCurrentReview = reviewedHash === simulation.policyHash;
  const changedSinceReview = reviewedHash.length > 0 && reviewedHash !== simulation.policyHash;
  const canCreate = connected && simulation.status !== "block" && hasCurrentReview;
  const activeCount = records.filter((record) => record.status === "active").length;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          setRecords(JSON.parse(raw) as PolicyRecord[]);
        } catch {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }, [hydrated, records]);

  function applyTemplate(nextTemplateId: PolicyTemplateId): void {
    const next = getTemplate(nextTemplateId);
    setTemplateId(next.id);
    setAuthorityModel(next.recommendedModel);
    setTokenIn(next.defaults.tokenIn);
    setTokenOut(next.defaults.tokenOut);
    setAmount(next.defaults.amount);
    setMaxSpend(next.defaults.maxSpend);
    setFrequency(next.defaults.frequency);
    setSlippageBps(next.defaults.slippageBps);
    setReviewedPolicy(null);
    setToast(`${next.name} template loaded.`);
    trackEvent("policy_template_selected", { template: next.id });
  }

  function connectDemo(): void {
    setConnected(true);
    setToast("Demo account connected. No wallet request was made.");
    trackEvent("demo_wallet_connected");
  }

  function disconnectDemo(): void {
    setConnected(false);
    setToast("Demo account disconnected.");
    trackEvent("demo_wallet_disconnected");
  }

  function runSimulation(): void {
    setReviewedPolicy(policy);
    setToast(simulation.status === "block" ? "Simulation blocked this policy." : "Simulation complete.");
    trackEvent("policy_simulated", { status: simulation.status, template: policy.templateId });
  }

  function createPolicy(): void {
    if (!canCreate) {
      setToast(
        !connected
          ? "Connect the demo account before creating a policy preview."
          : changedSinceReview
            ? "Run simulation again after policy changes."
            : !hasCurrentReview
              ? "Run simulation before saving this policy."
            : "Blocked policies cannot be created.",
      );
      return;
    }

    const id = simulation.policyHash;
    const createdAt = new Date().toISOString();
    const nextRecord: PolicyRecord = {
      id,
      policy,
      simulation,
      status: simulation.status === "warn" ? "paused" : "active",
      createdAt,
      nextRun: nextRunLabel(policy.frequency),
      version: policy.version,
      history: [
        makeEvent(
          "Policy capsule created",
          simulation.status === "warn"
            ? "Created paused because one or more checks require governance or human review."
            : "Ready for wallet review. Nothing was broadcast.",
          simulation.status,
        ),
        makeEvent("Simulation reviewed", `${simulation.checks.length} checks completed.`, simulation.status),
      ],
    };

    setRecords((current) => [nextRecord, ...current.filter((record) => record.id !== id)]);
    setToast(simulation.status === "warn" ? "Policy saved as paused for review." : "Policy preview created.");
    trackEvent("policy_created", { status: nextRecord.status, template: policy.templateId });
  }

  function dryRun(id: string): void {
    updateRecord(id, (record) => ({
      ...record,
      history: [
        makeEvent(
          "Hermes dry-run receipt",
          `Latest-block simulation returned ${record.simulation.estimatedOut}; broadcast=false.`,
          record.simulation.status,
        ),
        ...record.history,
      ],
    }));
    setToast("Dry-run receipt added to audit log.");
    trackEvent("policy_dry_run", { id });
  }

  function setRecordStatus(id: string, status: PolicyStatus): void {
    updateRecord(id, (record) => ({
      ...record,
      status,
      history: [
        makeEvent(
          status === "revoked" ? "Emergency revoke" : status === "paused" ? "Policy paused" : "Policy resumed",
          status === "revoked"
            ? "Owner revoke path marked this policy as unavailable for future submissions."
            : status === "paused"
              ? "Hermes submission disabled until resumed by owner."
              : "Policy returned to active preview state.",
          status === "revoked" ? "block" : "pass",
        ),
        ...record.history,
      ],
    }));
    setToast(status === "revoked" ? "Policy revoked locally." : `Policy ${status}.`);
    trackEvent("policy_status_changed", { id, status });
  }

  async function copyPolicy(record: PolicyRecord): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(record.policy, null, 2));
    setCopiedId(record.id);
    setToast("Policy JSON copied.");
    trackEvent("policy_copied", { id: record.id });
  }

  function toggleAlert(alert: string): void {
    setAlerts((current) => (current.includes(alert) ? current.filter((item) => item !== alert) : [...current, alert]));
    setReviewedPolicy(null);
  }

  function updateRecord(id: string, updater: (record: PolicyRecord) => PolicyRecord): void {
    setRecords((current) => current.map((record) => (record.id === id ? updater(record) : record)));
  }

  return (
    <main className={styles.page} id="main">
      <section className={`container ${styles.statusBar}`} aria-label="Product status">
        <span className={live ? styles.statusLive : styles.statusPreview}>{live ? `Contracts on ${CHAIN.name}` : "Preview"}</span>
        <p>
          {live ? (
            <>
              Factory{" "}
              <a href={explorer(CONTRACTS.factory)} target="_blank" rel="noreferrer">
                {shortAddress(CONTRACTS.factory)}
              </a>{" "}
              is deployed. Mainnet fund creation remains gated until external audit, adapter governance, and wallet
              review paths are complete.
            </>
          ) : (
            <>Simulation workspace only. No transaction can be broadcast from this interface.</>
          )}
        </p>
      </section>

      <section className={`container ${styles.appHead}`}>
        <div className={styles.titleRow}>
          <OpenZapMark className={styles.headMark} />
          <div>
            <span className="eyebrow">Policy console</span>
            <h1>Build bounded execution policies.</h1>
            <p>Design a capsule, simulate the diff, save the review artifact, then revoke or pause from one place.</p>
          </div>
        </div>
        <div className={styles.wallet}>
          {connected ? (
            <>
              <span className={styles.addr}>{shortAddress(DEMO_ADDRESS)}</span>
              <button className="btn btnGhost" onClick={disconnectDemo} type="button">
                Disconnect
              </button>
            </>
          ) : (
            <button className="btn btnPrimary" onClick={connectDemo} type="button">
              Connect demo account
            </button>
          )}
        </div>
      </section>

      {toast && (
        <div className={`container ${styles.toast}`} role="status" aria-live="polite">
          {toast}
        </div>
      )}

      <section className={`container ${styles.metrics}`} aria-label="Workspace summary">
        <Metric label="Active policies" value={String(activeCount)} />
        <Metric label="Saved reviews" value={String(records.length)} />
        <Metric label="Current status" value={simulation.status} tone={simulation.status} />
        <Metric label="Policy version" value={`v${policy.version}`} />
      </section>

      <section className={`container ${styles.workspace}`}>
        <aside className={styles.sidebar} aria-label="Policy templates">
          <div className={styles.cardHead}>Templates</div>
          <div className={styles.templateList}>
            {POLICY_TEMPLATES.map((item) => (
              <button
                key={item.id}
                className={item.id === templateId ? styles.templateActive : styles.template}
                onClick={() => applyTemplate(item.id)}
                type="button"
              >
                <span>
                  <strong>{item.name}</strong>
                  <em>{item.short}</em>
                </span>
                <small>{item.production.replace("-", " ")}</small>
              </button>
            ))}
          </div>

          <div className={styles.agentPanel}>
            <div className={styles.cardHead}>Agent gate</div>
            <div className={styles.agentRow}>
              <span>Hermes relay</span>
              <strong>Verified</strong>
            </div>
            <div className={styles.agentRow}>
              <span>Adapter evals</span>
              <strong>47 checks</strong>
            </div>
            <div className={styles.agentRow}>
              <span>Reputation tier</span>
              <strong>Allowlist only</strong>
            </div>
          </div>
        </aside>

        <section className={styles.builder} aria-label="Policy capsule builder">
          <div className={styles.builderTop}>
            <div>
              <div className={styles.cardHead}>Policy capsule builder</div>
              <h2>{template.name}</h2>
              <p>{template.description}</p>
            </div>
            <span className={styles.templateBadge}>{template.category}</span>
          </div>

          <div className={styles.fieldGroup} role="group" aria-label="Authority model">
            <span>Authority model</span>
            <div className={styles.segment}>
              {MODELS.map((model) => (
                <button
                  key={model.id}
                  className={authorityModel === model.id ? styles.segOn : styles.seg}
                  onClick={() => {
                    setAuthorityModel(model.id);
                    setReviewedPolicy(null);
                  }}
                  aria-pressed={authorityModel === model.id}
                  type="button"
                >
                  {model.label}
                  <em>{model.hint}</em>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.formGrid}>
            <Field label="From asset">
              <select
                value={tokenIn}
                onChange={(event) => {
                  setTokenIn(event.target.value);
                  setReviewedPolicy(null);
                }}
                className={styles.select}
              >
                {TOKENS.map((token) => (
                  <option key={token} value={token}>
                    {token}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To asset">
              <select
                value={tokenOut}
                onChange={(event) => {
                  setTokenOut(event.target.value);
                  setReviewedPolicy(null);
                }}
                className={styles.select}
              >
                {TOKENS.map((token) => (
                  <option key={token} value={token}>
                    {token}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Amount per run (${tokenIn})`}>
              <input
                className={styles.input}
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(sanitizeDecimal(event.target.value));
                  setReviewedPolicy(null);
                }}
              />
            </Field>
            <Field label={`Max policy spend (${tokenIn})`}>
              <input
                className={styles.input}
                inputMode="decimal"
                value={maxSpend}
                onChange={(event) => {
                  setMaxSpend(sanitizeDecimal(event.target.value));
                  setReviewedPolicy(null);
                }}
              />
            </Field>
            <Field label="Frequency">
              <select
                value={frequency}
                onChange={(event) => {
                  setFrequency(event.target.value);
                  setReviewedPolicy(null);
                }}
                className={styles.select}
              >
                <option value="once">Once</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="condition-based">Condition-based</option>
              </select>
            </Field>
            <Field label={`Max slippage (${(slippageBps / 100).toFixed(2)}%)`}>
              <input
                className={styles.range}
                min="0"
                max="300"
                step="5"
                type="range"
                value={slippageBps}
                onChange={(event) => {
                  setSlippageBps(Number(event.target.value));
                  setReviewedPolicy(null);
                }}
              />
            </Field>
          </div>

          <div className={styles.toggleGrid}>
            <Toggle
              checked={privateSubmission}
              label="Private submission"
              detail="Route through private orderflow after latest-block simulation."
              onChange={() => {
                setPrivateSubmission((value) => !value);
                setReviewedPolicy(null);
              }}
            />
            <Toggle
              checked={humanApproval}
              label="Human approval gate"
              detail="Require wallet review before Hermes can submit."
              onChange={() => {
                setHumanApproval((value) => !value);
                setReviewedPolicy(null);
              }}
            />
          </div>

          <div className={styles.alerts} aria-label="Alert channels">
            <span>Alerts</span>
            {["Farcaster", "Webhook", "Email"].map((alert) => (
              <button
                key={alert}
                className={alerts.includes(alert) ? styles.alertOn : styles.alert}
                onClick={() => toggleAlert(alert)}
                type="button"
                aria-pressed={alerts.includes(alert)}
              >
                {alert}
              </button>
            ))}
          </div>

          <div className={styles.actionRow}>
            <button className="btn btnGhost btnLg" onClick={runSimulation} type="button">
              Run simulation
            </button>
            <button className="btn btnPrimary btnLg" onClick={createPolicy} disabled={!canCreate} type="button">
              Save reviewed policy
            </button>
          </div>
          <p className={styles.fineprint}>
            This workspace creates review artifacts only. Wallet signing, token approval, and onchain deployment remain
            disabled until the production gates are cleared.
          </p>
        </section>

        <aside className={styles.review} aria-label="Simulation and review">
          <div className={styles.cardHead}>Simulation review</div>
          <div className={styles.hashRow}>
            <span>Policy hash</span>
            <strong>{shortHash(simulation.policyHash)}</strong>
          </div>
          <div className={styles.reviewStats}>
            <div>
              <span>Estimated out</span>
              <strong>{simulation.estimatedOut}</strong>
            </div>
            <div>
              <span>Relayer fee cap</span>
              <strong>{simulation.relayerFee}</strong>
            </div>
            <div>
              <span>Gas envelope</span>
              <strong>{simulation.gasEstimate}</strong>
            </div>
          </div>

          {changedSinceReview && (
            <p className={styles.warn}>Policy changed since the last simulation. Run simulation again before saving.</p>
          )}

          <div className={styles.checks}>
            {simulation.checks.map((check) => (
              <div className={styles.check} data-status={check.status} key={check.label}>
                <span>{check.status}</span>
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <details className={styles.policyJson}>
            <summary>Typed policy payload</summary>
            <pre>{JSON.stringify(policy, null, 2)}</pre>
          </details>

          {simulation.diff.length > 0 && (
            <div className={styles.diffBox}>
              <strong>Diff from last reviewed policy</strong>
              {simulation.diff.map((item) => (
                <div className={styles.diffRow} key={item.field}>
                  <span>{item.field}</span>
                  <code>{item.before}</code>
                  <code>{item.after}</code>
                </div>
              ))}
            </div>
          )}
        </aside>
      </section>

      <section className={`container ${styles.dash}`} aria-label="Policy dashboard">
        <div className={styles.dashHead}>
          <div>
            <span className="eyebrow">Dashboard</span>
            <h2>Policies, execution history, and revoke controls.</h2>
          </div>
          <span className={styles.dashCount}>{activeCount} active</span>
        </div>

        {records.length === 0 ? (
          <div className={styles.empty}>
            <OpenZapMark className={styles.emptyMark} />
            <strong>No policy capsules saved</strong>
            <p>Connect the demo account, run a simulation, then save the reviewed policy artifact.</p>
          </div>
        ) : (
          <div className={styles.policyGrid}>
            {records.map((record) => (
              <article className={styles.policyCard} key={record.id}>
                <div className={styles.policyTop}>
                  <div>
                    <span className={styles.policyHash}>{shortHash(record.id)}</span>
                    <h3>{record.policy.templateName}</h3>
                    <p>
                      {record.policy.amount} {record.policy.tokenIn} to {record.policy.tokenOut} ·{" "}
                      {record.policy.frequency}
                    </p>
                  </div>
                  <span className={styles.statusPill} data-status={record.status}>
                    {record.status}
                  </span>
                </div>

                <div className={styles.policyMeta}>
                  <div>
                    <span>Next run</span>
                    <strong>{record.nextRun}</strong>
                  </div>
                  <div>
                    <span>Model</span>
                    <strong>{record.policy.authorityModel}</strong>
                  </div>
                  <div>
                    <span>Version</span>
                    <strong>v{record.version}</strong>
                  </div>
                </div>

                <div className={styles.cardActions}>
                  <button className="btn btnGhost" onClick={() => dryRun(record.id)} type="button">
                    Dry-run
                  </button>
                  {record.status === "paused" ? (
                    <button className="btn btnGhost" onClick={() => setRecordStatus(record.id, "active")} type="button">
                      Resume
                    </button>
                  ) : (
                    <button
                      className="btn btnGhost"
                      onClick={() => setRecordStatus(record.id, "paused")}
                      disabled={record.status === "revoked"}
                      type="button"
                    >
                      Pause
                    </button>
                  )}
                  <button
                    className="btn btnGhost"
                    onClick={() => setRecordStatus(record.id, "revoked")}
                    disabled={record.status === "revoked"}
                    type="button"
                  >
                    Revoke
                  </button>
                  <button className="btn btnGhost" onClick={() => copyPolicy(record)} type="button">
                    {copiedId === record.id ? "Copied" : "Copy JSON"}
                  </button>
                </div>

                <div className={styles.auditLog}>
                  <strong>Audit log</strong>
                  {record.history.slice(0, 4).map((event) => (
                    <div className={styles.auditRow} data-status={event.status} key={event.id}>
                      <span>{formatTime(event.time)}</span>
                      <div>
                        <b>{event.action}</b>
                        <p>{event.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pass" | "warn" | "block";
}): React.JSX.Element {
  return (
    <div className={styles.metric} data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  checked,
  label,
  detail,
  onChange,
}: {
  checked: boolean;
  label: string;
  detail: string;
  onChange: () => void;
}): React.JSX.Element {
  return (
    <button className={checked ? styles.toggleOn : styles.toggle} onClick={onChange} type="button" aria-pressed={checked}>
      <span aria-hidden>{checked ? "on" : "off"}</span>
      <strong>{label}</strong>
      <em>{detail}</em>
    </button>
  );
}

function makeEvent(action: string, detail: string, status: "pass" | "warn" | "block"): AuditEvent {
  const time = new Date().toISOString();
  return {
    id: `${time}-${action}`,
    time,
    actor: "OpenZaps local console",
    action,
    detail,
    status,
  };
}

function nextRunLabel(frequency: string): string {
  if (frequency === "once") return "Manual review";
  if (frequency === "condition-based") return "When conditions pass";
  const date = new Date();
  const days = frequency === "daily" ? 1 : frequency === "weekly" ? 7 : 30;
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sanitizeDecimal(value: string): string {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}

function shortAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
