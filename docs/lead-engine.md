# OpenZaps Lead Engine

The lead engine converts a concrete DeFi workflow into a human-reviewed,
bounded-authority design conversation. It has two inputs:

1. opted-in requests submitted through `/request-a-zap`; and
2. organization-level opportunities found by the review-only Lead Scout.

Neither path receives wallet, signing, transaction, publishing, messaging, or
CRM authority.

## Public request flow

`/request-a-zap` asks an agent builder, protocol team, or DeFi operator for the
workflow, trigger, protocols/assets, test timeline, and the authority an agent
must never receive. It explicitly rejects private keys, seed phrases,
passwords, API keys, signatures, recovery phrases, sensitive balances, and
wallet access.

The browser sends the form to `POST /api/leads/request`. The route:

- accepts same-origin JSON only;
- stops reading after 16 KiB;
- validates a strict schema and an inert honeypot;
- derives an HMAC abuse-control key from a platform forwarding header without
  storing the raw network address;
- keeps that pseudonymous key only in a separate short-lived quota ledger;
- reduces the referrer to its origin and drops sensitive campaign values;
- computes a deterministic qualification score; and
- calls one service-role-only database RPC.

The public response is deliberately minimal. It never returns contact data,
the qualification score, a database identifier, or quota fingerprint.

## Qualification

The score is one point for each of five signals:

1. an identifiable project or project URL;
2. a concrete workflow;
3. named protocols or assets;
4. explicit safety limits; and
5. intent to test immediately or within 30 days.

The private operator queue defaults to scores of 3 or higher. The score
prioritizes human review; it never automatically contacts, rejects, deploys,
or funds a request.

## Private storage and consent

Apply
`supabase/migrations/20260730020106_private_lead_intake.sql` and
`supabase/migrations/20260730144125_lead_submission_notification_outbox.sql`
before exposing the form in a deployment.

The migration stores contact and workflow data in `private.lead_requests` and
short-lived quota counters in `private.lead_request_quotas`. The two are not
joined. RLS is enabled, browser roles receive no policies or table grants, and
only narrow public-schema wrappers are executable by `service_role`. Raw
network addresses and quota fingerprints are never returned.

Consent version `lead-contact-v1` authorizes a reply only about the submitted
request. The public notice at `/legal#request-data` discloses the stored
fields, purpose, minimized attribution, and retention. `marketing_opt_in` is
fixed to `false`; a submission does not join a newsletter or outbound
campaign. Email ownership begins unverified; an operator may send only a
request-specific confirmation or reply until ownership is confirmed.

New requests expire after 180 days. Reviewed lifecycle transitions are
recorded, may extend an active request only within a hard one-year limit, and
make `closed` terminal with no more than 30 days remaining. A daily retention
job deletes expired requests and quota counters. An operator can also
permanently delete a request through the narrow lead endpoint.

## Submission notifications

Every accepted lead insert creates one row in
`private.lead_notification_outbox` in the same database transaction. The
public request does not wait for email delivery and still returns its minimal
`202` after durable storage if the email provider or workflow scheduler is
temporarily unavailable.

A no-argument Vercel Workflow claims one due row at a time with a finite lease,
loads only the notification-safe lead fields through a service-role RPC, sends
one plain-text message to `nodar.janashia@gmail.com`, and records the provider
receipt. The provider idempotency key is derived from the private lead ID.
Concurrent workers use `FOR UPDATE SKIP LOCKED`; retries cannot widen the
recipient or sender. The existing daily retention route also starts a bounded
recovery drain, so a missed immediate scheduler nudge remains recoverable.

Email content includes the submitted contact and workflow details, timeline,
qualification score, received time, and a link to the private lead desk. It
omits attribution, network metadata, fingerprints, quotas, secrets, and
provider error bodies. Project URL query strings and fragments are removed.
If a free-text field resembles a credential, the notification withholds that
entire field and the operator must inspect the protected lead desk instead.
Because a delivered email is a separate copy, database cascade deletion cannot
remove it from the operator mailbox or the provider's service records. Delete
the matching mailbox notification when the lead is deleted. The public privacy
notice distinguishes database expiry from email-provider and mailbox
retention.

## Operator access

`GET /api/leads?limit=50&minScore=3` and lifecycle mutations use the separate
`OPENZAPS_LEAD_ADMIN_TOKEN` bearer credential. Marketing drafting and
publication approval continue to use `OPENZAPS_MARKETING_ADMIN_TOKEN`; neither
credential grants the other scope. The `/marketing` operator surface requires
both tokens, displays the scored queue, and supports forward-only status
changes and two-step permanent deletion. Responses omit fingerprints and all
network metadata and use `Cache-Control: private, no-store`.

Both operator tokens remain in the current tab's `sessionStorage`. Use a
dedicated browser profile and select **Forget** before handing the machine to
another person.

Review the queue every business morning. New qualified requests target a human
review within two business days. Mark a request `contacted`, `qualified`, or
`closed` only after the real-world step occurs; never use the status controls
to send a message. The Lead Scout also reports queue counts at the start of
each scheduled run without copying personal data into its report.

## Environment

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Canonical server-only Supabase project origin. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only credential for the reviewed lead RPCs. |
| `OPENZAPS_SUPABASE_PROJECT_REF` | Exact project ref required to bind the configured Supabase origin. |
| `OPENZAPS_LEAD_FINGERPRINT_SECRET` | At least 32 bytes; HMAC key for the non-reversible daily quota fingerprint. |
| `OPENZAPS_LEAD_ADMIN_TOKEN` | At least 32 bytes; private lead read/lifecycle credential. |
| `OPENZAPS_LEAD_NOTIFICATION_ENABLED` | Exact `true` production gate. Leave unset in preview and development. |
| `OPENZAPS_LEAD_NOTIFICATION_TO` | Must exactly equal `nodar.janashia@gmail.com`; any other value disables delivery. |
| `OPENZAPS_LEAD_NOTIFICATION_FROM` | Server-only Resend sender. Use a verified OpenZaps sender for production. |
| `OPENZAPS_LEAD_NOTIFICATION_OPERATOR_URL` | Optional clean HTTPS OpenZaps lead-desk URL; defaults to `https://www.0xzaps.com/marketing`. |
| `RESEND_API_KEY` | Server-only Resend credential scoped through the production Vercel integration. |
| `OPENZAPS_MARKETING_ADMIN_TOKEN` | Separate private drafting/publication credential. |
| `CRON_SECRET` | Existing Vercel cron credential used for retention. |

All secrets belong in Vercel environment settings. Never place them in a
tracked file, a lead request, a model prompt, or a client-exposed variable.
Keep the notification enable gate and provider key out of preview deployments
so test submissions cannot email the production recipient. The runtime also
requires Vercel's system `VERCEL_ENV` value to be exactly `production`; a
mis-scoped preview secret therefore remains fail-closed.

## Lead Scout

The active heartbeat automation is named **OpenZaps Lead Scout**. It runs in
the owner OpenZaps task every Monday, Wednesday, and Friday at 10:00 AM
Eastern. It reviews the inbound queue first, then may return at most five new
organizations and must:

- refresh current OpenZaps product truth;
- use dated, first-party, organization-level public evidence;
- score fit, evidence, and timing, accepting only totals of 11/15 or higher;
- deduplicate normalized organization domains and GitHub organizations;
- keep confirmed facts separate from inference; and
- label every suggested note `DRAFT ONLY — NOT SENT — OWNER APPROVAL REQUIRED`.

The scout may not collect personal contact data, scrape X or LinkedIn, enrich
emails, send messages, submit forms, follow accounts, join servers, modify a
CRM, change production, or use wallet authority.

Pause or resume it from Codex Automations; do not edit a raw schedule string.
Review failures in the owner task. A failed queue read should identify only
the high-level configuration or access blocker and must never print or request
a secret. Re-run only after the blocker is corrected.

## Measurement

`src/components/OpenZapsAnalytics.tsx` removes every query string and fragment
from Vercel pageviews and replaces EVM identifiers embedded in route paths.
`src/lib/analytics.ts` forwards no more than two allowlisted anonymous funnel
properties per custom event, matching the production Pro-plan limit. Wallet
addresses, transaction hashes, email addresses, contact details, URLs,
secret-like values, unknown keys, nested values, and oversized values are
dropped before transmission. Raw UTM values are reduced to controlled source,
medium, campaign, and content categories; a first-touch category is kept only
in the current tab's `sessionStorage`. One `campaign_arrival` event per tab and
coarse first touch supplies the campaign denominator without preserving the raw
UTM values.

`lead_request_accepted` is emitted server-side only after the private store
returns durable acceptance. It contains a coarse source and score band. The
honeypot's decoy `202`, validation failures, quota responses, and store failures
emit no accepted conversion event, and analytics failure cannot change an
accepted request's response.

Review these metrics weekly:

- qualified Zap requests;
- request-to-technical-review rate;
- technical-review-to-pilot rate; and
- campaign visitor-to-builder activation rate.

Followers and impressions are supporting signals, not the north-star metric.
