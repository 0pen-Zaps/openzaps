"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  marketingRunIdFromSearch,
  parseMarketingSourceUrls,
} from "@/lib/marketing/operator-input";
import { parseCanonicalXStatusUrl } from "@/lib/marketing/x-interaction";
import styles from "./marketing.module.css";

const TOKEN_STORAGE_KEY = "openzaps:marketing:operator-token";
const LEAD_TOKEN_STORAGE_KEY = "openzaps:marketing:lead-desk-token";
const RUN_STORAGE_KEY = "openzaps:marketing:run-id";
const POLL_INTERVAL_MS = 2_500;

const CHANNELS = ["x", "discord", "substack"] as const;
type Channel = (typeof CHANNELS)[number];
type DraftKind = "product_update" | "tutorial" | "community_reply";
type LeadStatus = "new" | "contacted" | "qualified" | "closed";
type JsonRecord = Record<string, unknown>;

type OperatorError = Error & { status?: number };

type ReadinessRow = {
  key: string;
  label: string;
  ready: boolean;
  state: string;
  detail: string;
};

export type OperatorLead = {
  id: string;
  persona: string;
  name: string;
  email: string;
  emailVerified: boolean;
  project: string | null;
  projectUrl: string | null;
  workflow: string;
  protocolsAssets: string | null;
  trigger: string;
  guardrails: string;
  timeline: string;
  attribution: JsonRecord;
  qualificationScore: number;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

const LEAD_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function readJson(response: Response): Promise<JsonRecord> {
  const body = await response.json().catch(() => null);
  return isRecord(body) ? body : {};
}

async function operatorRequest(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<JsonRecord> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers,
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error(
      text(body.error) ?? text(body.message) ?? `Request failed (${response.status}).`,
    ) as OperatorError;
    error.status = response.status;
    throw error;
  }
  return body;
}

function readinessValue(key: string, value: unknown): ReadinessRow {
  if (typeof value === "boolean") {
    return {
      key,
      label: titleCase(key),
      ready: value,
      state: value ? "ready" : "blocked",
      detail: value ? "Configured and available." : "Not configured.",
    };
  }
  if (typeof value === "string") {
    const state = value.toLowerCase();
    const ready = state === "ready" || state === "enabled" || state === "configured";
    return {
      key,
      label: titleCase(key),
      ready,
      state,
      detail: value,
    };
  }

  const entry = isRecord(value) ? value : {};
  const state = text(entry.status) ?? text(entry.state) ?? text(entry.mode);
  const ready = typeof entry.ready === "boolean"
    ? entry.ready
    : typeof entry.configured === "boolean"
      ? entry.configured
      : state === "ready" || state === "enabled" || state === "configured";

  return {
    key,
    label: text(entry.label) ?? text(entry.name) ?? titleCase(key),
    ready,
    state: state ?? (ready ? "ready" : "blocked"),
    detail:
      text(entry.detail)
      ?? text(entry.reason)
      ?? text(entry.message)
      ?? (ready ? "Configured and available." : "Not configured."),
  };
}

function readinessRows(status: JsonRecord | null): ReadinessRow[] {
  if (!status) return [];
  const root = isRecord(status.config) ? status.config : status;
  const readiness = isRecord(root.readiness) ? root.readiness : null;
  const source = root.channels ?? readiness?.channels ?? root.checks;
  const rows: ReadinessRow[] = [];

  if (readiness && typeof readiness.configurationValid === "boolean") {
    rows.push(readinessValue("configuration", {
      ready: readiness.configurationValid,
      detail: readiness.configurationValid
        ? "All configured values passed validation."
        : "One or more configuration values are invalid.",
    }));
  }
  if (readiness && typeof readiness.canDraft === "boolean") {
    const blockers = Array.isArray(readiness.blockers)
      ? readiness.blockers.filter((blocker): blocker is string => typeof blocker === "string")
      : [];
    rows.push(readinessValue("drafting", {
      ready: readiness.canDraft,
      detail: readiness.canDraft
        ? "Source-backed draft generation is enabled."
        : blockers.join(" ") || "Draft generation is disabled.",
    }));
  }

  if (Array.isArray(source)) {
    return [...rows, ...source.map((value, index) => {
      const entry = isRecord(value) ? value : {};
      const key =
        text(entry.channel)
        ?? text(entry.key)
        ?? text(entry.name)
        ?? `check-${index + 1}`;
      return readinessValue(key, value);
    })];
  }
  if (isRecord(source)) {
    return [...rows, ...Object.entries(source).map(([key, value]) => readinessValue(key, value))];
  }
  return rows;
}

export function operatorLeads(body: JsonRecord): OperatorLead[] {
  if (!Array.isArray(body.leads) || body.leads.length > 100) return [];

  return body.leads.flatMap((value): OperatorLead[] => {
    if (!isRecord(value)) return [];
    const id = text(value.id);
    const persona = text(value.persona);
    const name = text(value.name);
    const email = text(value.email);
    const emailVerified = value.emailVerified;
    const workflow = text(value.workflow);
    const trigger = text(value.trigger);
    const guardrails = text(value.guardrails);
    const timeline = text(value.timeline);
    const status = text(value.status);
    const createdAt = text(value.createdAt);
    const updatedAt = text(value.updatedAt);
    const expiresAt = text(value.expiresAt);
    const score = value.qualificationScore;
    if (
      !id
      || !persona
      || !name
      || !email
      || typeof emailVerified !== "boolean"
      || !workflow
      || !trigger
      || !guardrails
      || !timeline
      || !status
      || !["new", "contacted", "qualified", "closed"].includes(status)
      || !createdAt
      || !updatedAt
      || !expiresAt
      || typeof score !== "number"
      || !Number.isInteger(score)
      || score < 0
      || score > 5
    ) {
      return [];
    }

    return [{
      id,
      persona,
      name,
      email,
      emailVerified,
      project: text(value.project),
      projectUrl: text(value.projectUrl),
      workflow,
      protocolsAssets: text(value.protocolsAssets),
      trigger,
      guardrails,
      timeline,
      attribution: isRecord(value.attribution) ? value.attribution : {},
      qualificationScore: score,
      status: status as LeadStatus,
      createdAt,
      updatedAt,
      expiresAt,
    }];
  });
}

function leadDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Unknown time"
    : LEAD_DATE_FORMATTER.format(parsed);
}

function nestedRun(body: JsonRecord): JsonRecord {
  return isRecord(body.run) ? body.run : body;
}

function runIdFrom(body: JsonRecord): string | null {
  const run = nestedRun(body);
  return text(body.runId) ?? text(body.id) ?? text(run.runId) ?? text(run.id);
}

function runStatus(run: JsonRecord | null): string {
  if (!run) return "starting";
  const nested = nestedRun(run);
  return text(nested.status) ?? text(run.status) ?? "running";
}

function draftFrom(run: JsonRecord | null): unknown {
  if (!run) return null;
  const nested = nestedRun(run);
  return nested.draft ?? run.draft ?? null;
}

function resultFrom(run: JsonRecord | null): unknown {
  if (!run) return null;
  const nested = nestedRun(run);
  return nested.result ?? run.result ?? null;
}

function terminalStatus(status: string): boolean {
  return [
    "completed",
    "published",
    "partially_published",
    "requires_human_publish",
    "completed_with_errors",
    "dry_run_complete",
    "blocked",
    "failed",
    "rejected",
    "cancelled",
    "canceled",
  ].includes(
    status.toLowerCase(),
  );
}

function sessionRead(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function sessionWrite(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // The in-memory token still works when storage is unavailable.
  }
}

function sessionRemove(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing else should retain or expose the credential.
  }
}

export function MarketingOperator(): React.JSX.Element {
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState("");
  const [leadTokenInput, setLeadTokenInput] = useState("");
  const [leadToken, setLeadToken] = useState("");
  const [status, setStatus] = useState<JsonRecord | null>(null);
  const [kind, setKind] = useState<DraftKind>("product_update");
  const [brief, setBrief] = useState("");
  const [interactionUrl, setInteractionUrl] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [channels, setChannels] = useState<Channel[]>(["x", "discord", "substack"]);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<JsonRecord | null>(null);
  const [comment, setComment] = useState("");
  const [acknowledgedDraftKey, setAcknowledgedDraftKey] = useState("");
  const [leads, setLeads] = useState<OperatorLead[]>([]);
  const [leadScoreFloor, setLeadScoreFloor] = useState(3);
  const [leadQueueState, setLeadQueueState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [leadQueueError, setLeadQueueError] = useState("");
  const [leadActionId, setLeadActionId] = useState("");
  const [leadDeleteConfirmId, setLeadDeleteConfirmId] = useState("");
  const [leadActionNotice, setLeadActionNotice] = useState("");
  const [busy, setBusy] = useState<
    "connect" | "create" | "approve" | "reject" | ""
  >("");
  const [notice, setNotice] = useState(
    "Enter both operator tokens to load readiness and the private lead queue.",
  );
  const [pollRevision, setPollRevision] = useState(0);
  const leadRequestGeneration = useRef(0);

  const readiness = useMemo(() => readinessRows(status), [status]);
  const currentStatus = runStatus(run);
  const draft = draftFrom(run);
  const result = resultFrom(run);
  const draftId = isRecord(draft) ? text(draft.id) : null;
  const displayedDraftKey = runId && draftId ? `${runId}:${draftId}` : "";
  const reviewAcknowledged =
    Boolean(displayedDraftKey) && acknowledgedDraftKey === displayedDraftKey;
  const canDecide =
    Boolean(draft) && currentStatus === "awaiting_approval" && !busy;
  const canApprove = canDecide && reviewAcknowledged;

  const forgetToken = (message = "Operator token forgotten for this tab."): void => {
    sessionRemove(TOKEN_STORAGE_KEY);
    sessionRemove(LEAD_TOKEN_STORAGE_KEY);
    sessionRemove(RUN_STORAGE_KEY);
    leadRequestGeneration.current += 1;
    setToken("");
    setTokenInput("");
    setLeadToken("");
    setLeadTokenInput("");
    setStatus(null);
    setRunId("");
    setRun(null);
    setLeads([]);
    setLeadQueueState("idle");
    setLeadQueueError("");
    setLeadActionId("");
    setLeadDeleteConfirmId("");
    setLeadActionNotice("");
    setAcknowledgedDraftKey("");
    setNotice(message);
  };

  const handleError = (error: unknown, fallback: string): void => {
    const requestError = error as OperatorError;
    if (requestError?.status === 401) {
      forgetToken("The operator token was rejected and removed from this tab.");
      return;
    }
    setNotice(error instanceof Error ? error.message : fallback);
  };

  const loadLeadQueue = async (
    candidateToken: string,
    minimumScore: number,
  ): Promise<void> => {
    const requestGeneration = leadRequestGeneration.current + 1;
    leadRequestGeneration.current = requestGeneration;
    setLeadQueueState("loading");
    setLeadQueueError("");
    try {
      const body = await operatorRequest(
        `/api/leads?limit=50&minScore=${minimumScore}`,
        candidateToken,
      );
      if (leadRequestGeneration.current !== requestGeneration) return;
      setLeads(operatorLeads(body));
      setLeadQueueState("ready");
    } catch (error) {
      if (leadRequestGeneration.current !== requestGeneration) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "The lead queue could not be loaded.");
        return;
      }
      setLeads([]);
      setLeadQueueState("error");
      setLeadQueueError(
        error instanceof Error
          ? error.message
          : "The lead queue could not be loaded.",
      );
    }
  };

  const updateLeadLifecycle = async (
    id: string,
    status: Exclude<LeadStatus, "new">,
  ): Promise<void> => {
    if (!leadToken || leadActionId) return;
    setLeadActionId(id);
    setLeadActionNotice("");
    try {
      await operatorRequest(`/api/leads/${encodeURIComponent(id)}`, leadToken, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setLeadDeleteConfirmId("");
      setLeadActionNotice(`Request marked ${titleCase(status)}.`);
      await loadLeadQueue(leadToken, leadScoreFloor);
    } catch (error) {
      handleError(error, "The request status could not be updated.");
    } finally {
      setLeadActionId("");
    }
  };

  const permanentlyDeleteLead = async (id: string): Promise<void> => {
    if (!leadToken || leadActionId) return;
    setLeadActionId(id);
    setLeadActionNotice("");
    try {
      await operatorRequest(`/api/leads/${encodeURIComponent(id)}`, leadToken, {
        method: "DELETE",
      });
      setLeadDeleteConfirmId("");
      setLeadActionNotice("Request permanently deleted.");
      await loadLeadQueue(leadToken, leadScoreFloor);
    } catch (error) {
      handleError(error, "The request could not be deleted.");
    } finally {
      setLeadActionId("");
    }
  };

  useEffect(() => {
    const storedToken = sessionRead(TOKEN_STORAGE_KEY);
    const storedLeadToken = sessionRead(LEAD_TOKEN_STORAGE_KEY);
    if (!storedToken || !storedLeadToken) return;

    let cancelled = false;
    void operatorRequest("/api/marketing/status", storedToken)
      .then((body) => {
        if (cancelled) return;
        setTokenInput(storedToken);
        setToken(storedToken);
        setLeadTokenInput(storedLeadToken);
        setLeadToken(storedLeadToken);
        setStatus(body);
        const recoveredRunId =
          marketingRunIdFromSearch(window.location.search)
          || sessionRead(RUN_STORAGE_KEY);
        if (recoveredRunId) {
          sessionWrite(RUN_STORAGE_KEY, recoveredRunId);
          setRunId(recoveredRunId);
        }
        void loadLeadQueue(storedLeadToken, 3);
        setNotice("Operator session restored. Readiness is current.");
      })
      .catch((error: unknown) => {
        if (!cancelled) handleError(error, "Could not restore the operator session.");
      });

    return () => {
      cancelled = true;
    };
    // This runs once to restore only the credential scoped to this browser tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!token || !runId) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const body = await operatorRequest(`/api/marketing/runs/${encodeURIComponent(runId)}`, token);
        if (cancelled) return;
        const nextRun = nestedRun(body);
        setRun(nextRun);
        const nextStatus = runStatus(nextRun);
        setNotice(
          draftFrom(nextRun)
            ? `Draft ready · ${titleCase(nextStatus)}.`
            : `Generating draft · ${titleCase(nextStatus)}.`,
        );
        if (!terminalStatus(nextStatus)) {
          timeout = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (!cancelled) handleError(error, "The run could not be refreshed.");
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
    // pollRevision restarts polling after an approval response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollRevision, runId, token]);

  const connect = async (): Promise<void> => {
    const candidate = tokenInput.trim();
    const candidateLeadToken = leadTokenInput.trim();
    if (!candidate || !candidateLeadToken || busy) {
      setNotice("Enter both separately scoped operator tokens.");
      return;
    }

    setBusy("connect");
    try {
      const body = await operatorRequest("/api/marketing/status", candidate);
      sessionWrite(TOKEN_STORAGE_KEY, candidate);
      sessionWrite(LEAD_TOKEN_STORAGE_KEY, candidateLeadToken);
      setToken(candidate);
      setLeadToken(candidateLeadToken);
      setStatus(body);
      const recoveredRunId =
        marketingRunIdFromSearch(window.location.search)
        || sessionRead(RUN_STORAGE_KEY);
      if (recoveredRunId) {
        sessionWrite(RUN_STORAGE_KEY, recoveredRunId);
        setRunId(recoveredRunId);
      }
      setNotice("Connected. Readiness is current.");
      await loadLeadQueue(candidateLeadToken, leadScoreFloor);
    } catch (error) {
      handleError(error, "Could not load marketing readiness.");
    } finally {
      setBusy("");
    }
  };

  const toggleChannel = (channel: Channel): void => {
    if (kind === "community_reply" && channel !== "x") return;
    setChannels((current) =>
      current.includes(channel)
        ? current.filter((candidate) => candidate !== channel)
        : [...current, channel],
    );
  };

  const createDraft = async (): Promise<void> => {
    if (!token || busy) return;
    if (!brief.trim()) {
      setNotice("Add the facts and objective for this draft.");
      return;
    }
    if (channels.length === 0) {
      setNotice("Select at least one channel.");
      return;
    }
    let verifiedInteractionUrl: string | undefined;
    if (kind === "community_reply") {
      try {
        verifiedInteractionUrl = parseCanonicalXStatusUrl(interactionUrl).url;
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "Add a canonical X post URL for the reply target.",
        );
        return;
      }
    }

    let parsedSources: string[];
    try {
      parsedSources = parseMarketingSourceUrls(sourceUrls);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Check the source URLs.");
      return;
    }

    setBusy("create");
    setRun(null);
    setComment("");
    setAcknowledgedDraftKey("");
    try {
      const body = await operatorRequest("/api/marketing/runs", token, {
        method: "POST",
        body: JSON.stringify({
          kind,
          brief: brief.trim(),
          channels,
          ...(verifiedInteractionUrl ? { interactionUrl: verifiedInteractionUrl } : {}),
          ...(parsedSources.length ? { sourceUrls: parsedSources } : {}),
        }),
      });
      const nextRunId = runIdFrom(body);
      if (!nextRunId) throw new Error("The agent started without returning a run ID.");

      setRunId(nextRunId);
      setRun(nestedRun(body));
      sessionWrite(RUN_STORAGE_KEY, nextRunId);
      setNotice("Run started. Waiting for a reviewable draft.");
      setPollRevision((value) => value + 1);
    } catch (error) {
      handleError(error, "The draft could not be started.");
    } finally {
      setBusy("");
    }
  };

  const decide = async (decision: "approve" | "reject"): Promise<void> => {
    if (
      !token
      || !runId
      || !canDecide
      || (decision === "approve" && !canApprove)
    ) return;

    setBusy(decision);
    try {
      const body = await operatorRequest("/api/marketing/approvals", token, {
        method: "POST",
        body: JSON.stringify({
          runId,
          decision,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });
      if (draftFrom(body) || resultFrom(body) || text(body.status)) {
        setRun((current) => ({ ...(current ?? {}), ...nestedRun(body) }));
      }
      setNotice(
        decision === "approve"
          ? "Approval recorded. Publishing adapters will report their outcome here."
          : "Draft rejected. No channel publication was authorized.",
      );
      setAcknowledgedDraftKey("");
      setPollRevision((value) => value + 1);
    } catch (error) {
      handleError(error, `The ${decision} decision could not be recorded.`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className={styles.operator}>
      <section className={styles.panel} aria-labelledby="operator-access">
        <div className={styles.sectionHead}>
          <div>
            <span className={styles.step}>01</span>
            <h2 id="operator-access">Operator access</h2>
          </div>
          <StatusChip
            ready={Boolean(token && leadToken)}
            label={token && leadToken ? "connected" : "locked"}
          />
        </div>

        <label className={styles.field}>
          <span>Marketing approval token</span>
          <span className={styles.inlineControl}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
              disabled={Boolean(token && leadToken)}
              placeholder="Publishing-scope bearer token"
            />
          </span>
        </label>
        <label className={styles.field}>
          <span>Lead desk token</span>
          <span className={styles.inlineControl}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={leadTokenInput}
              onChange={(event) => setLeadTokenInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
              disabled={Boolean(token && leadToken)}
              placeholder="Lead-data-scope bearer token"
            />
            {token && leadToken ? (
              <button className={styles.secondaryButton} type="button" onClick={() => forgetToken()}>
                Forget
              </button>
            ) : (
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void connect()}
                disabled={busy === "connect"}
              >
                {busy === "connect" ? "Checking…" : "Connect"}
              </button>
            )}
          </span>
        </label>
        <p className={styles.hint}>
          Separate tokens keep publication authority apart from private lead
          access. Both stay in <code>sessionStorage</code> for this tab only;
          neither is placed in a URL, cookie, or persistent local storage.
        </p>
      </section>

      {token && leadToken ? (
        <>
          <section className={styles.panel} aria-labelledby="channel-readiness">
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.step}>02</span>
                <h2 id="channel-readiness">Readiness</h2>
              </div>
              <button
                className={styles.textButton}
                type="button"
                onClick={() => void connect()}
                disabled={Boolean(busy)}
              >
                Refresh
              </button>
            </div>
            {readiness.length ? (
              <div className={styles.readinessGrid}>
                {readiness.map((item) => (
                  <article className={styles.readinessCard} key={item.key}>
                    <div>
                      <h3>{item.label}</h3>
                      <StatusChip ready={item.ready} label={item.state} />
                    </div>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className={styles.empty}>The status endpoint returned no readiness checks.</p>
            )}
          </section>

          <section className={styles.panel} aria-labelledby="lead-request-queue">
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.step}>03</span>
                <h2 id="lead-request-queue">Qualified Zap requests</h2>
              </div>
              <div className={styles.queueControls}>
                <label>
                  Minimum score
                  <select
                    value={leadScoreFloor}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setLeadScoreFloor(next);
                      void loadLeadQueue(leadToken, next);
                    }}
                    disabled={leadQueueState === "loading"}
                  >
                    <option value={0}>All</option>
                    <option value={3}>3+</option>
                    <option value={4}>4+</option>
                    <option value={5}>5 only</option>
                  </select>
                </label>
                <button
                  className={styles.textButton}
                  type="button"
                  onClick={() => void loadLeadQueue(leadToken, leadScoreFloor)}
                  disabled={leadQueueState === "loading"}
                >
                  {leadQueueState === "loading" ? "Loading…" : "Refresh"}
                </button>
              </div>
            </div>

            {leadQueueState === "loading" ? (
              <div className={styles.generating} role="status" aria-live="polite">
                <span aria-hidden />
                <p>Loading the private request queue.</p>
              </div>
            ) : leadQueueState === "error" ? (
              <div className={styles.queueError} role="status">
                <strong>Lead queue unavailable.</strong>
                <span>{leadQueueError}</span>
              </div>
            ) : leads.length ? (
              <div className={styles.leadQueue}>
                {leads.map((lead) => (
                  <article className={styles.leadCard} key={lead.id}>
                    <header>
                      <div>
                        <span className={styles.leadPersona}>{titleCase(lead.persona)}</span>
                        <h3>{lead.project ?? lead.name}</h3>
                        {lead.project ? <p>{lead.name}</p> : null}
                      </div>
                      <span
                        className={styles.leadScore}
                        data-qualified={lead.qualificationScore >= 3 || undefined}
                        aria-label={`Qualification score ${lead.qualificationScore} out of 5`}
                      >
                        {lead.qualificationScore}/5
                      </span>
                    </header>

                    <div className={styles.leadContact}>
                      <span>{lead.email}</span>
                      <span
                        data-email-state={
                          lead.emailVerified ? "verified" : "unverified"
                        }
                      >
                        {lead.emailVerified
                          ? "Email verified"
                          : "Email unverified · request-specific reply only"}
                      </span>
                      {lead.projectUrl ? (
                        <a
                          href={lead.projectUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Project ↗
                        </a>
                      ) : null}
                    </div>

                    <dl className={styles.leadBrief}>
                      <div>
                        <dt>Workflow</dt>
                        <dd>{lead.workflow}</dd>
                      </div>
                      <div>
                        <dt>Trigger</dt>
                        <dd>{lead.trigger}</dd>
                      </div>
                      <div>
                        <dt>Must never change</dt>
                        <dd>{lead.guardrails}</dd>
                      </div>
                      {lead.protocolsAssets ? (
                        <div>
                          <dt>Protocols / assets</dt>
                          <dd>{lead.protocolsAssets}</dd>
                        </div>
                      ) : null}
                    </dl>

                    <footer>
                      <span>{titleCase(lead.timeline)}</span>
                      <span>{titleCase(lead.status)}</span>
                      <span>{leadDate(lead.createdAt)} ET</span>
                      {text(lead.attribution.utmSource) ? (
                        <span>Source: {text(lead.attribution.utmSource)}</span>
                      ) : null}
                    </footer>
                    <div className={styles.leadActions}>
                      {lead.status === "new" ? (
                        <button
                          type="button"
                          onClick={() => void updateLeadLifecycle(lead.id, "contacted")}
                          disabled={Boolean(leadActionId)}
                        >
                          Mark contacted
                        </button>
                      ) : null}
                      {lead.status === "new" || lead.status === "contacted" ? (
                        <button
                          type="button"
                          onClick={() => void updateLeadLifecycle(lead.id, "qualified")}
                          disabled={Boolean(leadActionId)}
                        >
                          Qualify
                        </button>
                      ) : null}
                      {lead.status !== "closed" ? (
                        <button
                          type="button"
                          onClick={() => void updateLeadLifecycle(lead.id, "closed")}
                          disabled={Boolean(leadActionId)}
                        >
                          Close
                        </button>
                      ) : null}
                      {leadDeleteConfirmId === lead.id ? (
                        <>
                          <button
                            type="button"
                            data-danger
                            onClick={() => void permanentlyDeleteLead(lead.id)}
                            disabled={Boolean(leadActionId)}
                          >
                            Confirm permanent delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setLeadDeleteConfirmId("")}
                            disabled={Boolean(leadActionId)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setLeadDeleteConfirmId(lead.id)}
                          disabled={Boolean(leadActionId)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : leadQueueState === "ready" ? (
              <p className={styles.empty}>
                No active requests meet this score threshold.
              </p>
            ) : null}
            {leadQueueState === "ready" ? (
              <p className="srOnly" role="status" aria-live="polite">
                {leads.length === 1
                  ? "1 request loaded."
                  : `${leads.length} requests loaded.`}
              </p>
            ) : null}
            {leadActionNotice ? (
              <p className={styles.queueNotice} role="status" aria-live="polite">
                {leadActionNotice}
              </p>
            ) : null}
            <p className={styles.hint}>
              Private contact and workflow data is shown only after operator
              authentication. Requests are never enrolled in a marketing list.
            </p>
          </section>

          <section className={styles.panel} aria-labelledby="create-marketing-draft">
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.step}>04</span>
                <h2 id="create-marketing-draft">Create a review draft</h2>
              </div>
            </div>

            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Content type</span>
                <select
                  value={kind}
                  onChange={(event) => {
                    const nextKind = event.target.value as DraftKind;
                    setKind(nextKind);
                    if (nextKind === "community_reply") setChannels(["x"]);
                  }}
                >
                  <option value="product_update">Product update</option>
                  <option value="tutorial">Tutorial</option>
                  <option value="community_reply">Verified X reply</option>
                </select>
              </label>

              <fieldset className={styles.channelPicker}>
                <legend>Channels</legend>
                <div>
                  {CHANNELS.map((channel) => (
                    <label key={channel}>
                      <input
                        type="checkbox"
                        checked={channels.includes(channel)}
                        onChange={() => toggleChannel(channel)}
                        disabled={kind === "community_reply" && channel !== "x"}
                      />
                      <span>{channel === "x" ? "X" : titleCase(channel)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <label className={styles.field}>
              <span>
                {kind === "community_reply"
                  ? "Your paraphrase of the question"
                  : "Brief and verified facts"}
              </span>
              <textarea
                rows={6}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder={
                  kind === "community_reply"
                    ? "Paraphrase what the person is asking. Do not paste the post text…"
                    : "What shipped, why it matters, and which claims the source material supports…"
                }
              />
            </label>

            {kind === "community_reply" ? (
              <label className={styles.field}>
                <span>X reply target</span>
                <input
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  value={interactionUrl}
                  onChange={(event) => setInteractionUrl(event.target.value)}
                  placeholder="https://x.com/username/status/1234567890123456789"
                />
                <small>
                  The agent verifies this post through X&apos;s API. It stores only
                  author/trigger metadata and never sends or persists the post text.
                </small>
              </label>
            ) : null}

            <label className={styles.field}>
              <span>Source URLs <small>optional · one per line</small></span>
              <textarea
                rows={3}
                inputMode="url"
                value={sourceUrls}
                onChange={(event) => setSourceUrls(event.target.value)}
                placeholder={"https://www.0xzaps.com/...\nhttps://github.com/0pen-Zaps/openzaps/..."}
              />
            </label>

            <div className={styles.actionRow}>
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void createDraft()}
                disabled={Boolean(busy)}
              >
                {busy === "create" ? "Starting…" : "Create review draft"}
              </button>
              <span>Generation cannot publish. A separate approval is required.</span>
            </div>
          </section>

          {runId ? (
            <section className={styles.panel} aria-labelledby="review-marketing-draft">
              <div className={styles.sectionHead}>
                <div>
                  <span className={styles.step}>05</span>
                  <h2 id="review-marketing-draft">Review and decide</h2>
                </div>
                <StatusChip
                  ready={
                    Boolean(draft)
                    && ![
                      "blocked",
                      "failed",
                      "rejected",
                      "partially_published",
                      "requires_human_publish",
                      "completed_with_errors",
                      "cancelled",
                      "canceled",
                    ].includes(currentStatus)
                  }
                  label={currentStatus}
                />
              </div>

              <p className={styles.runMeta}>
                Run <code>{runId}</code>
              </p>

              {draft ? (
                <DraftReview draft={draft} />
              ) : (
                <div className={styles.generating} role="status">
                  <span aria-hidden />
                  <p>The agent is assembling channel copy, evidence, and policy gates.</p>
                </div>
              )}

              {result ? (
                <div className={styles.result}>
                  <h3>Publication result</h3>
                  <pre>{JSON.stringify(result, null, 2)}</pre>
                </div>
              ) : null}

              {draft && currentStatus === "awaiting_approval" ? (
                <div className={styles.decision}>
                  <label className={styles.field}>
                    <span>Operator comment <small>optional</small></span>
                    <textarea
                      rows={3}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Revision note, rejection reason, or approval context…"
                    />
                  </label>
                  <label className={styles.acknowledgement}>
                    <input
                      type="checkbox"
                      checked={reviewAcknowledged}
                      onChange={(event) => {
                        setAcknowledgedDraftKey(event.target.checked ? displayedDraftKey : "");
                      }}
                      disabled={!displayedDraftKey || Boolean(busy)}
                    />
                    <span>
                      I reviewed this run&apos;s channel copy, evidence, disclosures,
                      and policy gates. I understand approval may publish immediately.
                    </span>
                  </label>
                  <div className={styles.decisionButtons}>
                    <button
                      className={styles.dangerButton}
                      type="button"
                      onClick={() => void decide("reject")}
                      disabled={!canDecide}
                    >
                      {busy === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                    <button
                      className={styles.primaryButton}
                      type="button"
                      onClick={() => void decide("approve")}
                      disabled={!canApprove}
                    >
                      {busy === "approve" ? "Approving…" : "Approve publication"}
                    </button>
                  </div>
                  <p className={styles.hint}>
                    Approval releases only the adapters and policy modes reported as ready.
                    Substack publishing may still require its editor handoff.
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      <p className={styles.notice} aria-live="polite">{notice}</p>
    </div>
  );
}

function StatusChip({ ready, label }: { ready: boolean; label: string }): React.JSX.Element {
  return (
    <span className={styles.statusChip} data-ready={ready || undefined}>
      <span aria-hidden />
      {titleCase(label)}
    </span>
  );
}

function DraftReview({ draft }: { draft: unknown }): React.JSX.Element {
  const record = isRecord(draft) ? draft : {};
  const channelEntries = extractChannelEntries(record);
  const sourcePacket = isRecord(record.sourcePacket) ? record.sourcePacket : null;
  const evidence = [
    ...(sourcePacket?.interaction
      ? [{ label: "Verified X reply target", ...sourcePacket.interaction }]
      : []),
    ...itemEntries(record.evidence ?? record.sources ?? sourcePacket?.facts),
  ];
  const gates = itemEntries(
    record.policyGates
    ?? record.policyDecisions
    ?? record.decisions
    ?? record.policy
    ?? record.gates
    ?? record.guardrails,
  );
  const headline = text(record.title) ?? text(record.topic);

  return (
    <div className={styles.review}>
      {headline ? <h3 className={styles.draftTitle}>{headline}</h3> : null}

      <div className={styles.copyGrid}>
        {channelEntries.length ? channelEntries.map(([channel, value]) => (
          <article className={styles.copyCard} key={channel}>
            <div>
              <h3>{channel === "x" ? "X" : titleCase(channel)}</h3>
              {channel === "substack" ? <span>editor handoff</span> : null}
            </div>
            <DraftCopy value={value} />
          </article>
        )) : (
          <article className={styles.copyCard}>
            <div><h3>Draft payload</h3></div>
            <pre>{typeof draft === "string" ? draft : JSON.stringify(draft, null, 2)}</pre>
          </article>
        )}
      </div>

      <div className={styles.reviewMeta}>
        <ReviewItems title="Evidence" items={evidence} empty="No evidence was attached." />
        <ReviewItems title="Policy gates" items={gates} empty="No policy gates were reported." gates />
      </div>
    </div>
  );
}

function extractChannelEntries(record: JsonRecord): Array<[Channel, unknown]> {
  if (Array.isArray(record.candidates)) {
    const presentations = Array.isArray(record.presentations) ? record.presentations : [];
    const entries = record.candidates.flatMap((value): Array<[Channel, unknown]> => {
      if (!isRecord(value)) return [];
      const channel = text(value.channel);
      if (!CHANNELS.includes(channel as Channel)) return [];
      const candidateId = text(value.id);
      const presentation = presentations.find((item) =>
        isRecord(item) && text(item.candidateId) === candidateId
      );
      return [[
        channel as Channel,
        presentation && isRecord(presentation)
          ? { ...value, ...presentation }
          : value,
      ]];
    });
    if (entries.length) return entries;
  }

  const candidates = [
    record.channels,
    record.copy,
    record.outputs,
    record.content,
    record,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      const entries = CHANNELS
        .filter((channel) => candidate[channel] !== undefined)
        .map((channel) => [channel, candidate[channel]] as [Channel, unknown]);
      if (entries.length) return entries;
    }
    if (Array.isArray(candidate)) {
      const entries = candidate.flatMap((value): Array<[Channel, unknown]> => {
        if (!isRecord(value)) return [];
        const channel = text(value.channel);
        return CHANNELS.includes(channel as Channel)
          ? [[channel as Channel, value]]
          : [];
      });
      if (entries.length) return entries;
    }
  }
  return [];
}

function DraftCopy({ value }: { value: unknown }): React.JSX.Element {
  if (typeof value === "string") return <pre>{value}</pre>;
  if (!isRecord(value)) return <pre>{JSON.stringify(value, null, 2)}</pre>;

  const fields = ["title", "subtitle", "text", "copy", "content", "body", "bodyMarkdown"] as const;
  const parts = fields.flatMap((field) => {
    const valueText = text(value[field]);
    return valueText ? [{ field, value: valueText }] : [];
  });
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
    : [];

  if (!parts.length && !tags.length) return <pre>{JSON.stringify(value, null, 2)}</pre>;
  return (
    <>
      {parts.map((part) => (
        <div className={styles.copyPart} key={part.field}>
          {part.field !== "text" && part.field !== "copy" && part.field !== "content"
            ? <span>{titleCase(part.field)}</span>
            : null}
          <pre>{part.value}</pre>
        </div>
      ))}
      {tags.length ? (
        <div className={styles.copyPart}>
          <span>Tags</span>
          <pre>{tags.join(", ")}</pre>
        </div>
      ) : null}
    </>
  );
}

function itemEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) =>
      isRecord(entry) ? { key, ...entry } : { key, value: entry },
    );
  }
  return value === undefined || value === null ? [] : [value];
}

function ReviewItems({
  title,
  items,
  empty,
  gates = false,
}: {
  title: string;
  items: unknown[];
  empty: string;
  gates?: boolean;
}): React.JSX.Element {
  return (
    <section className={styles.reviewList}>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => {
            if (typeof item === "string") return <li key={`${item}-${index}`}>{item}</li>;
            if (!isRecord(item)) return <li key={index}>{JSON.stringify(item)}</li>;

            const label =
              text(item.label)
              ?? text(item.title)
              ?? text(item.claim)
              ?? text(item.fact)
              ?? text(item.candidateId)
              ?? text(item.key)
              ?? `Item ${index + 1}`;
            const detail =
              (gates ? policyGateDetail(item) : null)
              ?? text(item.detail)
              ?? text(item.reason)
              ?? text(item.message)
              ?? scalarEvidenceDetail(item)
              ?? text(item.status);
            const href = text(item.url) ?? text(item.sourceUrl) ?? text(item.href);
            const gateDisposition = text(item.disposition)?.toLowerCase() ?? "";
            const gateReady =
              item.passed === true
              || item.ready === true
              || ["allow", "dry_run"].includes(gateDisposition)
              || ["pass", "passed", "ready", "allowed"].includes(text(item.status)?.toLowerCase() ?? "");
            const gatePending = gateDisposition === "require_approval";

            return (
              <li key={`${label}-${index}`}>
                {gates ? (
                  <span
                    className={styles.gateDot}
                    data-ready={gateReady || undefined}
                    data-pending={gatePending || undefined}
                    aria-hidden
                  />
                ) : null}
                <div>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">{label}</a>
                  ) : (
                    <strong>{label}</strong>
                  )}
                  {detail && detail !== label ? <p>{detail}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.empty}>{empty}</p>
      )}
    </section>
  );
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "Unavailable";
  return null;
}

function scalarEvidenceDetail(item: JsonRecord): string | null {
  const value = scalarText(item.value);
  const status = text(item.status);
  if (value && status) return `${value} · ${titleCase(status)}`;
  return value ?? status;
}

function policyGateDetail(item: JsonRecord): string | null {
  const parts: string[] = [];
  const disposition = text(item.disposition) ?? text(item.status);
  if (disposition) parts.push(titleCase(disposition));

  const approvalReasons = stringArray(item.approvalReasons);
  if (approvalReasons.length) parts.push(`Approval: ${approvalReasons.map(titleCase).join(", ")}`);

  const disclosures = stringArray(item.requiredDisclosures);
  if (disclosures.length) parts.push(`Disclosures: ${disclosures.map(titleCase).join(", ")}`);

  if (Array.isArray(item.issues)) {
    const issues = item.issues.flatMap((issue) => {
      if (typeof issue === "string") return issue.trim() ? [issue.trim()] : [];
      if (!isRecord(issue)) return [];
      const message = text(issue.message) ?? text(issue.code);
      return message ? [message] : [];
    });
    if (issues.length) parts.push(`Issues: ${issues.join(" ")}`);
  }

  return parts.length ? parts.join(" · ") : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}
