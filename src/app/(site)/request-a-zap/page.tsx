import type { Metadata } from "next";
import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";

import {
  RequestZapForm,
  type LeadPersona,
} from "./RequestZapForm";
import styles from "./request-a-zap.module.css";

type SearchParams = Record<string, string | string[] | undefined>;

const PERSONAS = new Set<LeadPersona>([
  "agent_builder",
  "protocol_team",
  "defi_user",
]);

export const metadata: Metadata = pageMetadata({
  ...STATIC_PAGE_SEO.requestZap,
  keywords: [
    "request a DeFi integration",
    "bounded agent authority",
    "DeFi workflow review",
    "agent wallet safety",
    "protocol integration request",
  ],
});

function first(params: SearchParams, key: string, maxLength: number): string | undefined {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

function initialPersona(params: SearchParams): LeadPersona | undefined {
  const value = first(params, "persona", 32);
  return value && PERSONAS.has(value as LeadPersona)
    ? (value as LeadPersona)
    : undefined;
}

export default async function RequestAZapPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const intent = first(params, "intent", 500);
  const asset = first(params, "asset", 200);

  return (
    <main className={styles.page} id="main" data-screen-label="Request a Zap">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.requestZap),
            breadcrumbJsonLd("/request-a-zap", "Request a Zap"),
          ],
        }}
      />

      <section className={styles.hero} aria-labelledby="request-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span aria-hidden />
            Free bounded-action review
          </p>
          <h1 id="request-title">
            Send one workflow.
            <span> Get its authority map.</span>
          </h1>
          <p className={styles.heroLead}>
            Tell us what an agent or user should be able to trigger. We will map
            the fixed targets, assets, recipients, limits, and recovery path—and
            make explicit what the agent can never change.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryAction} href="#request-form">
              Start the request
              <span aria-hidden>↓</span>
            </a>
            <Link className={styles.secondaryAction} href="/docs">
              Review the security model
            </Link>
          </div>
          <p className={styles.heroFootnote}>
            No wallet connection, deposit, signature, or integration commitment.
          </p>
        </div>

        <aside className={styles.deliverable} aria-label="What the review covers">
          <span className={styles.deliverableLabel}>The one-page review</span>
          <strong>A boundary your team can inspect.</strong>
          <ol>
            <li>
              <span>01</span>
              Workflow and trigger
            </li>
            <li>
              <span>02</span>
              Allowed targets and assets
            </li>
            <li>
              <span>03</span>
              Spend, cadence, and slippage limits
            </li>
            <li>
              <span>04</span>
              Revoke and recovery path
            </li>
            <li>
              <span>05</span>
              Explicitly forbidden authority
            </li>
          </ol>
        </aside>
      </section>

      <section className={styles.trustStrip} aria-label="Request principles">
        <div>
          <strong>Human reviewed</strong>
          <span>No automatic deployment</span>
        </div>
        <div>
          <strong>Bounded by design</strong>
          <span>The trigger never expands authority</span>
        </div>
        <div>
          <strong>Pre-audit disclosure</strong>
          <span>Production use requires independent review</span>
        </div>
      </section>

      <section
        className={styles.formShell}
        id="request-form"
        aria-labelledby="request-form-title"
      >
        <header className={styles.formHeader}>
          <p>Request brief</p>
          <h2 id="request-form-title">Map the action before anyone grants authority.</h2>
          <span>
            Required fields are marked with an asterisk. Share the workflow, not
            credentials or wallet secrets.
          </span>
        </header>

        <RequestZapForm
          isPreviewDeployment={process.env.VERCEL_ENV === "preview"}
          initialValues={{
            persona: initialPersona(params),
            project: first(params, "project", 120),
            projectUrl: first(params, "projectUrl", 500),
            workflow: first(params, "workflow", 4000) ?? intent,
            protocolsAssets:
              first(params, "protocolsAssets", 2000) ?? asset,
          }}
          attribution={{
            utmSource: first(params, "utm_source", 200),
            utmMedium: first(params, "utm_medium", 200),
            utmCampaign: first(params, "utm_campaign", 200),
            utmContent: first(params, "utm_content", 200),
            utmTerm: first(params, "utm_term", 200),
            landingPath: "/request-a-zap",
          }}
        />
      </section>

      <section className={styles.bottomCta} aria-labelledby="request-alternative-title">
        <div>
          <p>Already know the route?</p>
          <h2 id="request-alternative-title">Compile it in the builder first.</h2>
        </div>
        <Link href="/zap?view=design" className="btn btnGhost">
          Compose a Zap
        </Link>
      </section>
    </main>
  );
}
