"use client";

import Link from "next/link";
import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import { trackEvent } from "@/lib/analytics";
import {
  leadRequestPayload,
  type LeadClientAttribution,
} from "@/lib/leads/client";
import {
  consumeBuilderLeadRequestDraftInBrowser,
  type BuilderLeadRequestDraft,
} from "@/lib/leads/builder-handoff";

import styles from "./request-a-zap.module.css";

export type LeadPersona = "agent_builder" | "protocol_team" | "defi_user";

type InitialValues = {
  persona?: LeadPersona;
  project?: string;
  projectUrl?: string;
  workflow?: string;
  protocolsAssets?: string;
};

type RequestZapFormProps = {
  attribution: LeadClientAttribution;
  initialValues: InitialValues;
  isPreviewDeployment?: boolean;
};

type SubmissionState = "idle" | "pending" | "success" | "error";

const INVALID_REQUEST_MESSAGES: Readonly<Record<string, string>> = {
  persona: "Choose which path describes you before sending the request.",
  name: "Enter your name before sending the request.",
  email: "Enter a valid work email before sending the request.",
  projectUrl: "Use a secure project URL beginning with https://, or leave it blank.",
  workflow: "Describe what the Zap should accomplish in at least 20 characters.",
  trigger: "Describe the trigger or cadence before sending the request.",
  guardrails: "Describe what the agent must never be allowed to change.",
  timeline: "Choose when you would test the Zap.",
  consent: "Agree to the request data-use notice before sending.",
};

export function requestValidationMessage(fieldName: string | null): string {
  if (fieldName && INVALID_REQUEST_MESSAGES[fieldName]) {
    return INVALID_REQUEST_MESSAGES[fieldName];
  }
  return "Complete every required field marked with an asterisk before sending.";
}

export function requestSubmissionErrorMessage(status: number): string {
  if (status === 429) {
    return "This network reached today's request limit. Try again after the daily UTC reset, or contact us in Discord if the request is urgent.";
  }
  if (status === 503) {
    return "The request desk is temporarily unavailable. Please try again shortly.";
  }
  return "We could not send your request. Check the form and try again.";
}

const PERSONAS: readonly {
  value: LeadPersona;
  index: string;
  title: string;
  detail: string;
}[] = [
  {
    value: "agent_builder",
    index: "01",
    title: "Agent builder",
    detail: "Give an agent a useful onchain action without handing it broad wallet authority.",
  },
  {
    value: "protocol_team",
    index: "02",
    title: "Protocol team",
    detail: "Turn your contracts into a bounded, shareable workflow and integration brief.",
  },
  {
    value: "defi_user",
    index: "03",
    title: "DeFi user or operator",
    detail: "Map a repeatable multi-step workflow into one inspectable Zap design.",
  },
] as const;

function noBuilderDraft(): null {
  return null;
}

function builderDraftStore(enabled: boolean): {
  getSnapshot: () => BuilderLeadRequestDraft | null;
  subscribe: (notify: () => void) => () => void;
} {
  let current: BuilderLeadRequestDraft | null = null;
  let initialized = false;
  return {
    getSnapshot: () => current,
    subscribe: (notify) => {
      if (!initialized) {
        initialized = true;
        current = enabled
          ? consumeBuilderLeadRequestDraftInBrowser()
          : null;
      }
      let active = true;
      if (current) queueMicrotask(() => {
        if (active) notify();
      });
      return () => {
        active = false;
      };
    },
  };
}

export function RequestZapForm({
  attribution,
  initialValues,
  isPreviewDeployment = false,
}: RequestZapFormProps): React.JSX.Element {
  const [persona, setPersona] = useState<LeadPersona | "">(initialValues.persona ?? "");
  const [workflowEdit, setWorkflowEdit] = useState<string | null>(null);
  const [protocolsAssetsEdit, setProtocolsAssetsEdit] = useState<string | null>(
    null,
  );
  const [submission, setSubmission] = useState<SubmissionState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const statusRef = useRef<HTMLDivElement>(null);
  const analyticsAttribution = {
    source: attribution.utmSource,
    medium: attribution.utmMedium,
    campaign: attribution.utmCampaign,
    content: attribution.utmContent,
  };
  const draftStore = useMemo(
    () => builderDraftStore(
      attribution.entryPoint === "builder_review" && !isPreviewDeployment,
    ),
    [attribution.entryPoint, isPreviewDeployment],
  );
  const builderDraft = useSyncExternalStore(
    draftStore.subscribe,
    draftStore.getSnapshot,
    noBuilderDraft,
  );
  const workflow =
    workflowEdit ?? initialValues.workflow ?? builderDraft?.workflow ?? "";
  const protocolsAssets =
    protocolsAssetsEdit
    ?? initialValues.protocolsAssets
    ?? builderDraft?.protocolsAssets
    ?? "";

  if (isPreviewDeployment) {
    return (
      <section className={styles.previewNotice} aria-labelledby="preview-request-title">
        <span className={styles.previewNoticeMark} aria-hidden>
          ↗
        </span>
        <p className={styles.previewNoticeKicker}>Preview deployment</p>
        <h2 id="preview-request-title">Submit Zap requests on the production site.</h2>
        <p>
          Preview deployments intentionally cannot access the private lead store.
          Your design stays in this preview tab and cannot cross to the production
          origin automatically. Open the blank production form, then paste the
          workflow details you want reviewed.
        </p>
        <a
          href="https://www.0xzaps.com/request-a-zap#request-form"
          className="btn btnPrimary"
        >
          Open production request form
        </a>
      </section>
    );
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submission === "pending") return;

    const form = event.currentTarget;
    if (!form.checkValidity()) {
      const firstInvalid = form.querySelector<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("[name]:invalid");
      setErrorMessage(requestValidationMessage(firstInvalid?.name ?? null));
      setSubmission("error");
      requestAnimationFrame(() => statusRef.current?.focus());
      return;
    }

    const data = new FormData(form);
    const payload = leadRequestPayload(data, attribution, document.referrer);
    const selectedPersona = payload.persona as LeadPersona;

    setSubmission("pending");
    setErrorMessage("");
    trackEvent("lead_request_submit", {
      ...analyticsAttribution,
      persona: selectedPersona,
    });

    try {
      const response = await fetch("/api/leads/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => null)) as
        | { accepted?: boolean; error?: string }
        | null;

      if (!response.ok || result?.accepted !== true) {
        setErrorMessage(requestSubmissionErrorMessage(response.status));
        setSubmission("error");
        trackEvent("lead_request_error", {
          ...analyticsAttribution,
          persona: selectedPersona,
          status: response.status,
        });
        requestAnimationFrame(() => statusRef.current?.focus());
        return;
      }

      setSubmission("success");
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch {
      setErrorMessage("We could not reach the request desk. Check your connection and try again.");
      setSubmission("error");
      trackEvent("lead_request_error", {
        ...analyticsAttribution,
        persona: selectedPersona,
        status: 0,
      });
      requestAnimationFrame(() => statusRef.current?.focus());
    }
  }

  if (submission === "success") {
    return (
      <section
        className={styles.success}
        ref={statusRef}
        tabIndex={-1}
        aria-labelledby="request-success-title"
      >
        <span className={styles.successMark} aria-hidden>
          ✓
        </span>
        <p className={styles.successKicker}>Request received</p>
        <h2 id="request-success-title">Your workflow is in the review queue.</h2>
        <p>
          We will review the authority boundary and reply by email. We will never ask for
          a private key, seed phrase, signature, deposit, or wallet access.
        </p>
        <div className={styles.successActions}>
          <Link
            href="/zap?view=design"
            className="btn btnPrimary"
            data-analytics-event="builder_cta_clicked"
            data-analytics-cta="try_builder"
            data-analytics-content="request_success"
          >
            Try the builder
          </Link>
          <a
            href="https://discord.com/invite/openzaps"
            target="_blank"
            rel="noreferrer noopener"
            className="btn btnGhost"
            data-analytics-event="growth_link_clicked"
            data-analytics-cta="discord"
            data-analytics-content="request_success"
          >
            Join Discord
          </a>
        </div>
      </section>
    );
  }

  return (
    <form className={styles.form} onSubmit={submitRequest} noValidate>
      <div className={styles.progress} aria-label="Request steps">
        <span>1 · Pick your path</span>
        <span>2 · Map the workflow</span>
        <span>3 · Send the brief</span>
      </div>

      <fieldset className={styles.personaFieldset}>
        <legend>
          Which path describes you? <span aria-hidden>*</span>
        </legend>
        <div className={styles.personaGrid}>
          {PERSONAS.map((option) => {
            const inputId = `lead-persona-${option.value}`;

            return (
              <label
                className={styles.personaCard}
                htmlFor={inputId}
                key={option.value}
              >
                <input
                  id={inputId}
                  type="radio"
                  name="persona"
                  value={option.value}
                  checked={persona === option.value}
                  required
                  onChange={() => {
                    setPersona(option.value);
                    trackEvent("lead_persona_selected", {
                      ...analyticsAttribution,
                      persona: option.value,
                    });
                  }}
                />
                <span className={styles.personaIndex}>{option.index}</span>
                <strong>{option.title}</strong>
                <span>{option.detail}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className={styles.formSection}>
        <div className={styles.formSectionHead}>
          <span>About you</span>
          <p>Enough to return the review—nothing more.</p>
        </div>
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span>
              Your name <b aria-hidden>*</b>
            </span>
            <input
              type="text"
              name="name"
              autoComplete="name"
              minLength={2}
              maxLength={100}
              required
            />
          </label>
          <label className={styles.field}>
            <span>
              Work email <b aria-hidden>*</b>
            </span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              required
            />
          </label>
          <label className={styles.field}>
            <span>Project or team</span>
            <input
              type="text"
              name="project"
              autoComplete="organization"
              maxLength={120}
              defaultValue={initialValues.project}
            />
          </label>
          <label className={styles.field}>
            <span>Project URL</span>
            <input
              type="url"
              name="projectUrl"
              inputMode="url"
              placeholder="https://"
              pattern="https://.*"
              title="Use a secure URL beginning with https://"
              maxLength={500}
              defaultValue={initialValues.projectUrl}
            />
          </label>
        </div>
      </div>

      <div className={styles.formSection}>
        <div className={styles.formSectionHead}>
          <span>The workflow</span>
          <p>Describe the outcome first. We will help shape the route.</p>
        </div>
        <div className={styles.fieldStack}>
          <label className={styles.field}>
            <span>
              What should the Zap accomplish? <b aria-hidden>*</b>
            </span>
            <textarea
              name="workflow"
              rows={5}
              minLength={20}
              maxLength={4000}
              placeholder="Example: Move a capped amount of USDG into a verified liquidity position when…"
              value={workflow}
              onChange={(event) => setWorkflowEdit(event.target.value)}
              required
            />
            <small>Plain language is perfect. Do not paste calldata or credentials.</small>
          </label>

          <div className={styles.fieldGrid}>
            <label className={styles.field}>
              <span>Protocols and assets</span>
              <textarea
                name="protocolsAssets"
                rows={3}
                maxLength={2000}
                placeholder="Uniswap v4, USDG, aeWETH…"
                value={protocolsAssets}
                onChange={(event) => setProtocolsAssetsEdit(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>
                Trigger or cadence <b aria-hidden>*</b>
              </span>
              <textarea
                name="trigger"
                rows={3}
                minLength={3}
                maxLength={2000}
                placeholder="Manual, weekly, or only when a verified price crosses…"
                required
              />
            </label>
          </div>

          <label className={styles.field}>
            <span>
              What must the agent never be allowed to change? <b aria-hidden>*</b>
            </span>
            <textarea
              name="guardrails"
              rows={4}
              minLength={10}
              maxLength={2000}
              placeholder="Recipient, approved targets, spend ceiling, slippage, deadline, revoke path…"
              required
            />
            <small>This is the heart of the bounded-authority review.</small>
          </label>

          <label className={`${styles.field} ${styles.timelineField}`}>
            <span>
              When would you test it? <b aria-hidden>*</b>
            </span>
            <select name="timeline" defaultValue="within_30_days" required>
              <option value="immediately">As soon as possible</option>
              <option value="within_30_days">Within 30 days</option>
              <option value="within_90_days">Within 90 days</option>
              <option value="exploring">Exploring for later</option>
            </select>
          </label>
        </div>
      </div>

      <aside className={styles.noSecrets} aria-labelledby="no-secrets-title">
        <span aria-hidden>!</span>
        <div>
          <strong id="no-secrets-title">No secrets. No signing authority.</strong>
          <p>
            Never submit a private key, seed phrase, password, API key, wallet signature,
            recovery phrase, or sensitive balance information. This form cannot authorize
            a transaction.
          </p>
        </div>
      </aside>

      <div className={styles.honeypot} aria-hidden="true" inert>
        <label>
          Leave this field empty
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            maxLength={200}
          />
        </label>
      </div>

      <label className={styles.consent}>
        <input type="checkbox" name="consent" required />
        <span>
          I agree that OpenZaps may store the request data described in the{" "}
          <Link href="/legal#request-data">data-use notice</Link> to review and
          reply to this request. This does not add me to a marketing list.{" "}
          <b aria-hidden>*</b>
        </span>
      </label>

      {submission === "error" ? (
        <div
          className={styles.error}
          ref={statusRef}
          role="alert"
          tabIndex={-1}
        >
          <strong>Request not sent.</strong>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className={styles.submitRow}>
        <button
          type="submit"
          className="btn btnPrimary btnLg"
          disabled={submission === "pending"}
          data-busy={submission === "pending" || undefined}
          aria-busy={submission === "pending"}
        >
          {submission === "pending" ? "Sending request" : "Request my Zap review"}
        </button>
        <p>
          Target response: two business days for qualified requests. OpenZaps is
          pre-audit; a review is not a production-deployment promise.
        </p>
      </div>
    </form>
  );
}
