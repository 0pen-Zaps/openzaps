"use client";

import { useCallback, useRef, useState } from "react";

import type {
  TranscriptBody,
  TranscriptChip,
  TranscriptComposer,
  TranscriptMessage,
  TranscriptPlan,
  TranscriptStatus,
} from "@/lib/transcript";
import styles from "./Transcript.module.css";

/**
 * The conversational surface every agent screen shares.
 *
 * Three things about it are deliberate:
 *
 * 1. A message can BE a compiled plan, not merely describe one. The plan card
 *    is rendered from `CompiledZap` fields, so nothing in it is prose someone
 *    could have written differently — which is what lets an `agent` message sit
 *    next to a `capsule` message without the two being confusable.
 * 2. The live region announces ADDITIONS only, and the status ("thinking") lives
 *    in a separate `role="status"` node. Putting a changing status inside the
 *    log makes a screen reader re-announce the whole transcript every tick.
 * 3. Roles are `data-role`, never conditional class strings, matching the rest
 *    of the app — and matching how the CSS is written.
 */
export function Transcript({
  label,
  messages,
  status = "idle",
  statusNote,
  composer = { mode: "none" },
  onSubmit,
  onChip,
  className = "",
}: {
  label: string;
  messages: readonly TranscriptMessage[];
  status?: TranscriptStatus;
  /** Human-readable explanation of the current status, e.g. the 503 reason. */
  statusNote?: string;
  composer?: TranscriptComposer;
  onSubmit?: (text: string) => void;
  onChip?: (chip: TranscriptChip) => void;
  className?: string;
}): React.JSX.Element {
  const busy = status === "thinking" || status === "compiling";

  return (
    <section className={`${styles.root} ${className}`.trim()} aria-label={label}>
      <ol
        className={styles.log}
        // `additions` only: a message body never mutates in place, so there is
        // nothing to re-announce, and the status node below carries progress.
        aria-live="polite"
        aria-relevant="additions"
        data-busy={busy || undefined}
      >
        {messages.map((message) => (
          <li key={message.id} className={styles.row} data-role={message.role} data-tone={message.tone ?? "normal"}>
            <span className={`${styles.who} mono`} aria-hidden="true">
              {WHO[message.role]}
            </span>
            <div className={styles.body}>
              <Body body={message.body} />
              {message.evidence ? (
                <a className={`${styles.evidence} mono`} href={message.evidence.href} rel="noreferrer" target="_blank">
                  {message.evidence.label}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <p className={styles.status} role="status" data-status={status}>
        {statusLabel(status, statusNote)}
      </p>

      {/* Keyed by mode so a half-typed question cannot reappear under a prompt
          that no longer asks it — React drops the draft on remount, which is
          the same intent an effect would express with worse timing. */}
      <Composer composer={composer} key={composer.mode} onSubmit={onSubmit} onChip={onChip} />
    </section>
  );
}

/** How each voice introduces itself. The asymmetry is the point. */
const WHO: Record<TranscriptMessage["role"], string> = {
  you: "you",
  agent: "agent",
  capsule: "capsule",
  chain: "chain",
};

function statusLabel(status: TranscriptStatus, note?: string): string {
  if (note) return note;
  if (status === "thinking") return "Thinking…";
  if (status === "compiling") return "Compiling the design…";
  if (status === "error") return "That did not work.";
  if (status === "offline") return "No agent is configured on this deployment.";
  return "";
}

function Body({ body }: { body: TranscriptBody }): React.JSX.Element {
  switch (body.kind) {
    case "text":
      return <p className={styles.text}>{body.text}</p>;

    case "facts":
      return (
        <dl className={styles.facts}>
          {body.rows.map((row) => (
            <div className={styles.factRow} key={row.key}>
              <dt className={`${styles.factKey} mono`}>{row.label}</dt>
              <dd className={styles.factValue}>{row.value}</dd>
            </div>
          ))}
        </dl>
      );

    case "checks":
      return <Checks checks={body.checks} />;

    case "refusal":
      return (
        <div className={styles.refusal}>
          <p className={styles.text}>{body.reason}</p>
          {body.refuses.length > 0 ? (
            <ul className={styles.refuses}>
              {body.refuses.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      );

    case "plan":
      return <Plan plan={body.plan} />;
  }
}

function Checks({ checks }: { checks: TranscriptPlan["checks"] }): React.JSX.Element {
  return (
    <ul className={styles.checks}>
      {checks.map((check, i) => (
        <li data-status={check.status} key={`${check.label}-${i}`}>
          <span aria-hidden="true" className={styles.checkMark} />
          <span className={styles.checkLabel}>{check.label}</span>
          <span className={styles.checkDetail}>{check.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A compiled design, rendered in the vocabulary the landing page already
 * teaches: what it does, what the simulator says, and — last, because it is the
 * part people skip — what it refuses to do.
 */
function Plan({ plan }: { plan: TranscriptPlan }): React.JSX.Element {
  return (
    <div className={styles.plan} data-status={plan.status}>
      <div className={styles.planRow}>
        <span className={`${styles.factKey} mono`}>steps</span>
        <ol className={styles.steps}>
          {plan.steps.map((step, i) => (
            <li key={`${step}-${i}`}>{step}</li>
          ))}
        </ol>
      </div>

      <div className={styles.planRow}>
        <span className={`${styles.factKey} mono`}>bounds</span>
        <dl className={styles.bounds}>
          <div>
            <dt className="mono">hash</dt>
            <dd className="mono">
              {plan.hash.slice(0, 10)}…{plan.hash.slice(-6)}
            </dd>
          </div>
          <div>
            <dt className="mono">gas</dt>
            <dd className="mono">{plan.gas.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt className="mono">guards</dt>
            <dd className="mono">{plan.guardScore}/100</dd>
          </div>
        </dl>
      </div>

      {plan.checks.length > 0 ? (
        <div className={styles.planRow}>
          <span className={`${styles.factKey} mono`}>simulation</span>
          <Checks checks={plan.checks} />
        </div>
      ) : null}

      {/* Verbatim from deployable.ts. Never reworded, never truncated — this is
          the half of the plan that says what will NOT happen. */}
      {plan.refuses.length > 0 ? (
        <div className={styles.planRefuses}>
          <span className={`${styles.factKey} mono`}>refuses</span>
          <ul className={styles.refuses}>
            {plan.refuses.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {plan.handoff ? (
        <a className={`btn ${styles.handoff}`} href={plan.handoff.href}>
          {plan.handoff.label}
        </a>
      ) : null}
    </div>
  );
}

function Composer({
  composer,
  onSubmit,
  onChip,
}: {
  composer: TranscriptComposer;
  onSubmit?: (text: string) => void;
  onChip?: (chip: TranscriptChip) => void;
}): React.JSX.Element | null {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    (event: React.FormEvent): void => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || !onSubmit) return;
      setDraft("");
      onSubmit(text);
      input.current?.focus();
    },
    [draft, onSubmit],
  );

  if (composer.mode === "none") return null;

  const chips = composer.mode === "chips" ? composer.chips : (composer.chips ?? []);
  const busy = composer.busy === true;

  return (
    <div className={styles.composer}>
      {chips.length > 0 ? (
        <div className={styles.chips} role="group" aria-label="Suggested replies">
          {chips.map((chip) => (
            <button
              className={styles.chip}
              data-busy={busy || undefined}
              disabled={busy}
              key={chip.id}
              onClick={() => onChip?.(chip)}
              title={chip.hint}
              type="button"
            >
              <span aria-hidden="true" className={`${styles.chipCaret} mono`}>
                ›
              </span>
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}

      {composer.mode === "text" ? (
        <form className={styles.form} onSubmit={submit}>
          <label className="srOnly" htmlFor="transcript-input">
            {composer.placeholder}
          </label>
          <input
            autoComplete="off"
            className={styles.input}
            disabled={busy}
            id="transcript-input"
            maxLength={composer.maxLength}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={composer.placeholder}
            ref={input}
            type="text"
            value={draft}
          />
          <button className="btn btnPrimary" data-busy={busy || undefined} disabled={busy || !draft.trim()} type="submit">
            Ask
          </button>
        </form>
      ) : null}
    </div>
  );
}
