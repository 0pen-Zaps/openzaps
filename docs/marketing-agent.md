# OpenZaps Marketing Agent Runbook

This runbook covers deployment and operation of the OpenZaps marketing agent on
Vercel. Model-generated copy is **review-only**: the agent collects evidence
and drafts channel-specific copy, deterministic policy evaluates it, and an
authenticated operator approves or rejects every generated outbound bundle.
There is one narrower automatic lane for exact, versioned, server-rendered
tier-1 education templates on ready X and Discord broadcast providers.

The agent does not receive wallet authority. It cannot create, fund, sign, or
execute a Zap. Its only external write surfaces are reviewed X broadcasts and
operator-selected, verified X replies, plus reviewed Discord broadcasts.
Discord slash commands return deterministic responses. Substack publication
always stops at a human editor handoff.

The inbound request queue and separate review-only Lead Scout are documented
in [lead-engine.md](lead-engine.md).

## Operating invariants

| Invariant | Enforcement |
| --- | --- |
| Evidence before copy | Each run reads the production health, protocol activity, and pot APIs. Optional source URLs are restricted to OpenZaps, DeFi Tutorials, and the canonical GitHub repository. |
| External text is data | Fetched text is marked `instructionsTrusted: false` and cannot widen the operator brief or policy. |
| Claims cite facts | Every asserted or qualified generated claim must cite a source-packet fact key. Unavailable data is `null`, never zero. |
| Pre-audit disclosure | Public copy includes `Pre-audit software. Verify before use.` while the protocol remains pre-audit. |
| Canonical links only | Outbound links are restricted to `0xzaps.com`, `www.0xzaps.com`, `defitutorials.substack.com`, and `github.com/0pen-Zaps/openzaps`. |
| Human review | Every model-generated item and every reply remains review-only. Tutorials, incidents, security, token/trading, partnerships, roadmaps, and new deployments always require approval. |
| Bounded scheduled templates | Automatic delivery accepts only the exact public fields of the current versioned server template, only for tier-1 X/Discord broadcasts, and rechecks configuration, source freshness, provider identity/destination, caps, and the durable claim immediately before writing. A changed body, claim, or channel—or missing, stale, or internally inconsistent source evidence—cannot inherit that authority. |
| Prohibited means prohibited | A human cannot override credential exposure, guaranteed-return claims, impersonation, policy bypasses, unsolicited bulk messaging, unavailable-as-zero claims, or non-canonical links. |
| No unverified X replies | An operator supplies only a canonical `x.com/<user>/status/<id>` URL and a paraphrase. The agent verifies the author and explicit mention/owned quote through X's API, stores metadata but not post text, requires human approval, and enforces one lifetime reply per interaction. There is no polling or browser scraping. |
| No undocumented publishing | X uses `POST /2/tweets`; Discord uses official webhooks/REST; Substack uses its official editor and public RSS feed. There is no browser scraping, session-cookie automation, or private endpoint. |
| Safe failure | Missing or malformed configuration blocks work. Provider errors are sanitized, publishing is not automatically retried, and Discord mentions are disabled. |

The workflow is:

```text
operator
  -> authenticated workflow start
  -> production evidence snapshot
  -> model-generated structured drafts
  -> deterministic policy
  -> operator approval hook
  -> X / Discord delivery OR Substack editor handoff

cron
  -> durable weekday slot
  -> production evidence snapshot
  -> exact versioned server template (no model)
  -> deterministic tier-1 policy
  -> fresh automatic-authority and provider checks
  -> durable once-per-template/channel claim
  -> X / Discord delivery
```

Discord slash-command answers are a separate deterministic FAQ path. They do
not invoke the model or the approval workflow.

## Surfaces and access

| Surface | Purpose | Authentication |
| --- | --- | --- |
| `/marketing` | Private operator UI for readiness, drafting, review, approval, and rejection | The page shell is public and `noindex`; every data/action API requires the operator bearer token. |
| `GET /api/marketing/status` | Secret-free readiness and policy posture | `Authorization: Bearer <OPENZAPS_MARKETING_ADMIN_TOKEN>` |
| `POST /api/marketing/runs` | Start a durable draft workflow | Operator bearer token |
| `GET /api/marketing/runs/:runId` | Read the latest run event/result | Operator bearer token |
| `POST /api/marketing/approvals` | Resume the one-shot approval hook | Operator bearer token |
| `GET /api/marketing/cron` | Start the bounded scheduled-template workflow | `Authorization: Bearer <CRON_SECRET>` |
| `POST /api/marketing/discord/interactions` | Receive Discord application commands | Discord Ed25519 request signature and a five-minute freshness window |

The operator token is held in browser `sessionStorage`, scoped to the current
tab. Use a dedicated browser profile, never paste the token into a brief or
provider message, and use **Forget token** before handing the machine to anyone
else. For stronger isolation, add Vercel Deployment Protection or an
organization access layer in front of `/marketing`; the API bearer check
remains mandatory.

## Environment configuration

All boolean values are strict lowercase strings: exactly `true` or `false`.
Invalid spellings fail closed. Add secrets through the Vercel project settings
or interactive `vercel env add`; never commit `.env` files.

### Core and model

| Variable | Default | Production use |
| --- | --- | --- |
| `OPENZAPS_MARKETING_ENABLED` | `false` | Master gate. Set `true` only after a disabled deployment passes readiness checks. |
| `OPENZAPS_MARKETING_DRY_RUN` | `true` | When `true`, runs stop at `dry_run_complete` and never wait for approval or publish. |
| `OPENZAPS_MARKETING_AUTO_PUBLISH` | `false` | Enables only the exact versioned scheduled-template lane when live mode, the durable ledger, and at least one requested X/Discord provider are ready. It never authorizes model output, replies, tutorials, direct messages, or operator-supplied copy. |
| `OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED` | `false` | Set `true` only after the reviewed migration is applied and its RPC/privilege checks pass in the target Supabase project. Non-dry-run drafting fails closed without it. |
| `OPENZAPS_MARKETING_ADMIN_TOKEN` | unset | Strong random operator bearer token. Missing configuration denies every operator API. |
| `OPENZAPS_MARKETING_APPROVER_ID` | `authenticated-operator` | Non-secret audit label recorded with approvals. Do not put an email address or other unnecessary personal data here. |
| `OPENZAPS_MARKETING_MODEL` | `openai/gpt-5-mini` | AI Gateway model id. The default is currently listed for free-tier access; re-check the live catalog and rerun structured-output tests before changing it. |
| `OPENZAPS_MARKETING_SITE_URL` | `https://www.0xzaps.com` | Evidence origin. Only canonical HTTPS OpenZaps origins are accepted; any other value falls back to production. |
| `AI_GATEWAY_API_KEY` | unset | Local/non-Vercel model authentication only. Vercel production uses automatically managed OIDC; do not add an OpenAI key for this agent. |
| `OPENZAPS_MARKETING_SUPABASE_PROJECT_REF` | unset | Exact lowercase project ref for the OpenZaps Supabase project. Cloud ledger access remains blocked unless this value matches the host in `SUPABASE_URL`. |
| `SUPABASE_URL` | unset | Existing server-only OpenZaps Supabase project URL. It must exactly equal `https://<OPENZAPS_MARKETING_SUPABASE_PROJECT_REF>.supabase.co` (or use loopback HTTP in local development). |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Existing server-only service-role key used only for the reviewed marketing ledger RPCs. Never expose it to the browser or a model. |

Vercel Workflow and AI Gateway use deployment OIDC automatically. For local
development, `vercel env pull` can supply a short-lived OIDC token, or a scoped
AI Gateway key can be stored in the untracked local environment. OIDC tokens
pulled locally expire, so refresh them rather than copying them into source.

If any model/provider key is exposed in chat, logs, screenshots, shell history,
or a tracked file, revoke it at the provider immediately. Removing the text
later is not sufficient.

### Policy caps and disabled features

| Variable | Default |
| --- | ---: |
| `OPENZAPS_MARKETING_DAILY_X_POST_CAP` | `2` |
| `OPENZAPS_MARKETING_DAILY_X_REPLY_CAP` | `10` |
| `OPENZAPS_MARKETING_DAILY_DISCORD_POST_CAP` | `3` |
| `OPENZAPS_MARKETING_DAILY_SUBSTACK_TUTORIAL_CAP` | `1` |
| `OPENZAPS_MARKETING_DAILY_DM_CAP` | `1` |
| `OPENZAPS_MARKETING_DM_ENABLED` | `false` |
| `OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED` | `false` (required for every X provider write) |
| `OPENZAPS_X_AI_REPLY_APPROVED` | `false` (additional gate for AI-authored replies) |

Caps accept integers from 0 through 100. A cap of `0` is an emergency
per-channel kill switch. In non-dry-run mode, every provider call must first
acquire an atomic claim in `marketing_delivery_ledger`. That transaction
enforces the UTC-day cap, lifetime one-reply-per-X-interaction rule, and stable
idempotency identity across workflow replays. Claims continue to consume the
cap after a provider ambiguity so a timeout cannot cause an automatic duplicate.

Readiness reports `durableLedgerConfigured: true` only when the explicit flag,
exact project-ref/host binding, canonical Supabase origin, and service-role
secret are all present. Loopback HTTP is accepted only outside production. Dry
runs may use a marked empty snapshot and never call the provider. Live drafting
and delivery fail closed without the durable ledger. Effective `autoPublish`
can become `true` only for the scheduled-template prerequisites above; the
ledger never replaces human approval for generated copy or replies.
Direct-message delivery is hard-disabled because there is no deployed DM
adapter; setting the legacy DM flag does not enable it.

### Schedule

| Variable | Default | Meaning |
| --- | --- | --- |
| `CRON_SECRET` | unset | Vercel Cron bearer secret. A missing value makes the cron route return `401`. |
| `OPENZAPS_MARKETING_SCHEDULE_ENABLED` | unset/disabled | Must be exactly `true` before cron starts a workflow. |
| `OPENZAPS_MARKETING_SCHEDULE_CHANNELS` | `x,discord` | Comma-separated subset of `x` and `discord`; invalid values are ignored, duplicates are removed, and a requested channel is omitted until its provider gates are ready. |

`vercel.json` invokes the route at `0 14 * * 1-5`: 14:00 UTC every weekday.
That is 10:00 Eastern during daylight-saving time and 09:00 Eastern during
standard time. Vercel schedules use UTC. The route never invokes a model. It
renders the exact `bounded-authority-v1` education template and can publish it
only when `OPENZAPS_MARKETING_AUTO_PUBLISH=true` and every fresh gate passes.
Substack, replies, and arbitrary copy are outside this lane.

Keep the schedule disabled during previews and initial production rollout.
Before starting a workflow, cron atomically claims one
`weekday_product_update` slot for the current UTC weekday in Supabase.
Overlapping or retried invocations return `already_claimed` without creating a
second run. A claimed slot is deliberately retained when workflow start is
ambiguous, so the day's scheduled draft may be skipped rather than duplicated.
Each template revision and channel also has one stable durable delivery key.
Replaying `bounded-authority-v1` reconciles its original receipt instead of
posting identical copy again, even on a later weekday. Shipping new scheduled
copy therefore requires a reviewed source change with a new template id; never
date-salt identical text to manufacture a new delivery.

### X

| Variable | Required | Meaning |
| --- | --- | --- |
| `X_USER_ACCESS_TOKEN` | One X auth option | User-context OAuth 2.0 bearer token for the OpenZaps account. |
| `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | Preferred X auth option | Complete OAuth 1.0a user-context credential set. Partial sets fail closed. |
| `X_EXPECTED_ACCOUNT_ID` | Every X read/write operation | Exact numeric X account id returned for the intended OpenZaps account by `GET /2/users/me`. |
| `X_EXPECTED_USERNAME` | Every X read/write operation | Canonical lowercase username without `@`; use `0xzaps`. |
| `OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED` | Every X provider write | Set only after the account's required automated-account label/operator disclosure is visibly configured. |
| `OPENZAPS_X_AI_REPLY_APPROVED` | AI-authored replies only | Independent operator attestation that X has approved the reply automation. |

The adapter prefers a complete OAuth 1.0a user-context credential set and
retains OAuth 2.0 bearer support. OAuth 1.0a requests are signed with
HMAC-SHA1. For OAuth 2.0, use only the user scopes required here:
`tweet.read`, `tweet.write`, and `users.read`. Never use an app-only bearer
token for posting and never automate the X website.

All X writes remain blocked while
`OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=false`; this includes broadcasts. A
reply additionally requires `OPENZAPS_X_AI_REPLY_APPROVED=true`. Every reply
starts from a human-selected canonical status URL in `/marketing`, not a
poller. The adapter uses `GET /2/users/me` and `GET /2/tweets/:id` to prove
that another account explicitly mentioned the authenticated OpenZaps username
or quoted a post owned by that account. It derives the trigger itself, stores
only target URL/id, author/account ids, trigger, and observation time, and
discards the target text. The operator brief must paraphrase the question.
Every generated reply still waits for human approval and the durable ledger
allows at most one reply for that interaction.

The adapter calls `GET /2/users/me` before every `POST /2/tweets` and requires
both the returned id and username to match `X_EXPECTED_ACCOUNT_ID` and
`X_EXPECTED_USERNAME`. The workflow repeats that identity check before it
acquires the durable delivery claim, so credentials for the wrong account
cannot consume a cap or send. Reply delivery also requires the reverified
account id to match the immutable id captured during target verification.
Expected identity values are configuration, not tokens, and readiness never
returns any X credential value.

### Discord

| Variable | Required | Meaning |
| --- | --- | --- |
| `DISCORD_MARKETING_WEBHOOK_URL` | One reviewed broadcast option | Incoming webhook for the public announcements/update channel. It takes precedence when configured. |
| `DISCORD_MARKETING_REVIEW_WEBHOOK_URL` | Optional | Separate webhook for a private staff review channel. An invalid URL or the same webhook identity as the public webhook makes configuration invalid. Pair it with the review channel id below. |
| `DISCORD_MARKETING_REVIEW_CHANNEL_ID` | With review webhook | Numeric private staff review channel id used to verify webhook metadata before sending a draft. |
| `DISCORD_APPLICATION_PUBLIC_KEY` | For slash commands | Hex public key from the Discord application General Information page. |
| `OPENZAPS_DISCORD_APPLICATION_ID` | For slash commands | Numeric application id. Every signed interaction, including PING, must match it. |
| `OPENZAPS_DISCORD_GUILD_ID` | For all Discord features | Numeric OpenZaps server id. Outbound metadata and every application command must match it. A signed endpoint-validation PING may omit `guild_id`, but a present value must match. |
| `DISCORD_BOT_TOKEN` | Alternate reviewed broadcast option and command registration | Pair with the numeric channel id for REST delivery when no webhook is configured. Keep it in an operator shell for command registration. |
| `DISCORD_MARKETING_CHANNEL_ID` | For public broadcasts | Numeric public destination channel id required for either webhook or bot REST delivery. |

Discord outbound messages hard-limit content and embed sizes and always send
`allowed_mentions: { "parse": [] }`, so model output cannot notify a user,
role, or `@everyone`. The interaction endpoint supports `/ask`, `/openzaps`,
and `/status`. Answers are deterministic FAQ text with safety disclosures; the
endpoint does not listen to general channel messages and does not maintain a
Gateway connection.

Choose either the webhook or the bot-token/channel-id pair for public
broadcasts. The webhook is operationally narrower and preferred. If
`DISCORD_MARKETING_WEBHOOK_URL` is present but malformed, readiness fails
closed instead of silently falling back to the bot credentials.
The private review URL is validated independently. The config check compares
Discord webhook ids after normalizing the supported `discord.com` and
`discordapp.com` hosts and versioned or unversioned API paths, so aliases
cannot route unpublished review content to the public webhook. Readiness and
errors never return either URL or webhook token.

Before every public Discord ledger claim, the agent performs a read-only
destination preflight. For webhook delivery it calls Discord's official
get-webhook-with-token endpoint and requires the expected webhook, guild, and
public channel ids. For bot delivery it calls the official get-channel endpoint
and requires the exact public channel and guild ids. The adapter repeats this
bounded, no-redirect metadata check immediately before the POST. Review alerts
use the same webhook verification against
`DISCORD_MARKETING_REVIEW_CHANNEL_ID`. A missing or mismatched destination
fails before any provider write; metadata and credentials are never returned
or logged.

Discord interactions are ready only when the public key, application id, and
guild id are all valid. The endpoint verifies the signature first, then returns
an empty `403` without answering when the signed payload does not match the
configured application and OpenZaps guild. Discord's endpoint-validation PING
is accepted without `guild_id` only because Discord documents that field as
optional; its application id must still match, and a supplied guild id must
match.

#### Register the Discord commands

1. Create or select the OpenZaps application in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Set its Interactions Endpoint URL to
   `https://www.0xzaps.com/api/marketing/discord/interactions`. Discord's PING
   verification must succeed.
3. Install the application into the OpenZaps server with the
   `applications.commands` scope. A bot scope is unnecessary for
   interaction-only commands; add it only if an independently reviewed bot
   feature needs it.
4. Register commands to the OpenZaps guild first. Guild commands update
   quickly and are safer for testing than global commands.

Keep the bot token in the current shell, not a file or command-line argument:

```bash
export OPENZAPS_DISCORD_APPLICATION_ID="your-application-id"
export OPENZAPS_DISCORD_GUILD_ID="your-openzaps-guild-id"
read -r -s DISCORD_BOT_TOKEN
export DISCORD_BOT_TOKEN

node --input-type=module <<'NODE'
const applicationId = process.env.OPENZAPS_DISCORD_APPLICATION_ID;
const guildId = process.env.OPENZAPS_DISCORD_GUILD_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!applicationId || !guildId || !token) throw new Error("Missing Discord registration environment.");

const commands = [
  {
    name: "ask",
    description: "Ask a question about OpenZaps",
    type: 1,
    options: [{
      name: "question",
      description: "Your OpenZaps question",
      type: 3,
      required: true
    }]
  },
  {
    name: "openzaps",
    description: "Learn what OpenZaps is and how bounded authority works",
    type: 1,
    options: [{
      name: "question",
      description: "Optional topic: Zaps, agents, security, audit status, or token",
      type: 3,
      required: false
    }]
  },
  {
    name: "status",
    description: "Read the current OpenZaps audit and production posture",
    type: 1
  }
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(commands)
  }
);
if (!response.ok) throw new Error(`Discord command registration failed (${response.status}).`);
console.log(`Registered ${commands.length} guild commands.`);
NODE

unset DISCORD_BOT_TOKEN
```

Test all three commands in the server. Promote them to global commands only if
the application is intentionally meant for other servers; use the same payload
with `/applications/{application.id}/commands` and omit the guild segment.

Create two separate incoming webhooks when review notifications are desired:

- public update channel → `DISCORD_MARKETING_WEBHOOK_URL`;
- private staff review channel → `DISCORD_MARKETING_REVIEW_WEBHOOK_URL`.

Record the numeric public and private channel ids separately in
`DISCORD_MARKETING_CHANNEL_ID` and `DISCORD_MARKETING_REVIEW_CHANNEL_ID`.
Deleting, rotating, or moving either webhook makes its metadata check fail and
is an immediate channel-specific stop.

### Substack

Substack has no supported public write API for this workflow. Do not place a
Substack session cookie, password, or private endpoint in Vercel.

After approval, a Substack delivery returns:

- `status: "requires_human_publish"`;
- the official editor URL;
- a title, optional subtitle, body Markdown, tags, and an idempotency key in
  the reviewed draft bundle.

The operator must:

1. Open the returned `https://defitutorials.substack.com/publish/post` URL.
2. Copy the approved title, subtitle, Markdown, and tags.
3. Recheck every fact, link, image right, disclosure, and call to action in the
   Substack preview.
4. Publish or schedule from the official editor.
5. Record the canonical public post URL with the run id.
6. Confirm the item appears at
   `https://defitutorials.substack.com/feed`.
7. Start a new, reviewed X/Discord syndication run using the canonical
   Substack URL as a source.

The repository includes a bounded public-RSS parser with ETag and
`Last-Modified` support, but no deployed cron currently turns feed items into
social posts. Treat RSS syndication as a manual follow-up until that trigger
has its own durable deduplication ledger and tests.

## Deploy safely

### 1. Preflight

From the exact commit intended for production:

```bash
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run test:relay-pg16
npm run validate:workflow
npm run build
npm run audit:production
```

Confirm `next.config.ts` remains wrapped with `withWorkflow`, and confirm the
production deployment is connected to the canonical
`0pen-Zaps/openzaps` repository. Vercel automatically provisions the managed
Workflow backend, queues, storage, and OIDC for a Vercel deployment.

### 2. Add preview-safe configuration

Use a preview deployment with:

```text
OPENZAPS_MARKETING_ENABLED=true
OPENZAPS_MARKETING_DRY_RUN=true
OPENZAPS_MARKETING_AUTO_PUBLISH=false
OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED=false
OPENZAPS_MARKETING_SCHEDULE_ENABLED=false
OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=false
OPENZAPS_X_AI_REPLY_APPROVED=false
OPENZAPS_MARKETING_DM_ENABLED=false
```

Add a preview-only operator token. Do not add production X or public Discord
credentials to previews. The model may use Vercel OIDC; source collection still
reads the canonical production origin.

Deploy the preview, open `/marketing`, enter the preview operator token, and
verify:

- configuration is valid and drafting is ready;
- the expected public channel readiness is false;
- a dry-run draft reaches `dry_run_complete`;
- source packets show timestamps, URLs, and unavailable values as `null`;
- every public candidate includes the pre-audit disclosure;
- an attempted non-canonical source URL is rejected;
- no X post, Discord message, or Substack draft is created externally.

Inspect the run in Vercel Workflow:

```bash
npx workflow inspect runs --backend vercel
npx workflow inspect run RUN_ID --backend vercel --url
```

### 3. Deploy production disabled

Configure production secrets and channel credentials, but deploy with:

```text
OPENZAPS_MARKETING_ENABLED=false
OPENZAPS_MARKETING_DRY_RUN=true
OPENZAPS_MARKETING_AUTO_PUBLISH=false
OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED=false
OPENZAPS_MARKETING_SCHEDULE_ENABLED=false
OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=false
OPENZAPS_X_AI_REPLY_APPROVED=false
OPENZAPS_MARKETING_DM_ENABLED=false
```

Verify that the authenticated status endpoint reports disabled/dry-run and
does not return any secret values. Verify unauthorized requests return `401`
with `Cache-Control: private, no-store`.

### 4. Apply and verify the durable ledger

The production Supabase database is shared. Do not run a blind `supabase db
push`, repair unrelated migration history, or replay SQL copied from an
unreviewed branch. Follow [`supabase/README.md`](../supabase/README.md) and
apply only:

```text
supabase/migrations/20260729035549_marketing_delivery_ledger.sql
```

Apply it transactionally while the marketing agent is disabled. Then verify:

- the exact migration timestamp/name is recorded once;
- `public.marketing_delivery_ledger` has RLS enabled and no direct table grants
  for `anon`, `authenticated`, or `service_role`;
- only `service_role` can execute the four public marketing RPCs, including
  schedule-slot admission;
- the snapshot returns the current UTC day and zero or expected counters;
- an idempotency replay returns the stored claim/receipt and never inserts a
  second row;
- concurrent claims at a cap of one admit exactly one caller.

Keep a record of the verification output with the release. The migration is an
append-only audit/idempotency boundary; do not add a destructive rollback.
Application rollback remains compatible with the table.

After verification, set:

```text
OPENZAPS_MARKETING_SUPABASE_PROJECT_REF=<exact-project-ref>
OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED=true
```

The project ref binds the service-role credential to the reviewed OpenZaps
database host. The flag is an assertion that the reviewed database boundary
exists. Setting either value before the migration is applied does not create
the schema and makes live work fail closed.

### 5. Enable production dry-run

Set only `OPENZAPS_MARKETING_ENABLED=true`, redeploy, and run one X/Discord
product update plus one Substack tutorial. Both must end as dry runs with no
provider side effect. Review the exact source packet, model usage, and readiness
report. Dry-run does not consume durable delivery counters.

### 6. Enable review-only delivery

Set `OPENZAPS_MARKETING_DRY_RUN=false` and keep
`OPENZAPS_MARKETING_AUTO_PUBLISH=false`. Redeploy.

Roll out one channel at a time:

1. Discord review webhook in a private channel.
2. Discord public webhook and slash commands.
3. One operator-approved X broadcast.
4. One approved Substack editor handoff followed by manual publication.
5. Only after X has approved AI reply automation, the automated label is
   visible, and the expected account binding passes, test one
   operator-selected, API-verified X reply.

After each step, inspect the workflow receipt and the provider's canonical
surface. A `published` workflow receipt is not a substitute for checking the
actual X post or Discord channel.

### 7. Enable bounded scheduled publishing

After at least several successful manual runs, set:

```text
OPENZAPS_MARKETING_SCHEDULE_ENABLED=true
OPENZAPS_MARKETING_SCHEDULE_CHANNELS=discord
OPENZAPS_MARKETING_AUTO_PUBLISH=true
```

Redeploy, then verify the next Vercel Cron invocation returns `202` with a run
id, records `auto_authorized`, and publishes only the requested providers that
are ready. Keep production Discord-only while the X automated label and API
write credits are pending. Written X approval remains an additional requirement
for AI replies, which are never part of this automatic lane. Verify the
canonical Discord receipt, then replay the same template and prove it returns
the stored receipt without a second provider call. Leave all model-generated
runs and all replies on the approval hook.

To roll back automatic delivery, first set
`OPENZAPS_MARKETING_SCHEDULE_ENABLED=false`, then set
`OPENZAPS_MARKETING_AUTO_PUBLISH=false`, and redeploy. This returns production
to review-only delivery without removing provider credentials or altering the
append-only ledger. Never delete or rewrite a claimed row to force a retry;
ambiguous provider outcomes require human reconciliation.

## Manual operation

The UI at `/marketing` is the normal operator path. These API examples are for
diagnosis and controlled automation.

Load the operator token without placing it in shell history:

```bash
export MARKETING_BASE_URL="https://www.0xzaps.com"
read -r -s MARKETING_OPERATOR_TOKEN
export MARKETING_OPERATOR_TOKEN
```

Check readiness:

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${MARKETING_OPERATOR_TOKEN}" \
  "${MARKETING_BASE_URL}/api/marketing/status"
```

Start a source-backed run:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${MARKETING_OPERATOR_TOKEN}" \
  --header "Content-Type: application/json" \
  --data '{
    "kind": "product_update",
    "brief": "Explain the most useful verified OpenZaps improvement without inventing metrics or implying audit completion.",
    "channels": ["x", "discord"],
    "sourceUrls": []
  }' \
  "${MARKETING_BASE_URL}/api/marketing/runs"
```

Save the returned `runId`, then inspect it:

```bash
export MARKETING_RUN_ID="returned-workflow-run-id"
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${MARKETING_OPERATOR_TOKEN}" \
  "${MARKETING_BASE_URL}/api/marketing/runs/${MARKETING_RUN_ID}"
```

Before approval, read all of the following:

- operator brief and requested channels;
- source URLs, observation time, and chain head/read time;
- every candidate's body, links, topics, claims, and disclosures;
- policy disposition, risk tier, issues, and approval reasons;
- whether any data is unavailable or stale;
- whether the same update was already published.

Approve:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${MARKETING_OPERATOR_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "{
    \"runId\": \"${MARKETING_RUN_ID}\",
    \"decision\": \"approve\",
    \"comment\": \"Facts and disclosures checked against the source packet.\"
  }" \
  "${MARKETING_BASE_URL}/api/marketing/approvals"
```

Reject by changing `decision` to `reject`. Approval hooks are one-shot; a
second decision returns `409`.

When finished:

```bash
unset MARKETING_OPERATOR_TOKEN
unset MARKETING_RUN_ID
```

## Idempotency and recovery

Each bundle derives a stable per-channel idempotency key and returns it in the
delivery result. Before a provider call, the workflow atomically records that
key, the content hash, channel, action, approving operator, UTC claim day, and
counter slot. X and Discord do not provide one universal reviewed idempotency
header, so the durable claim—not a made-up provider header—is the replay
boundary.

Terminal receipts remain bound to that exact channel and action. X accepts
only its numeric post id and matching canonical `x.com/i/web/status/...` URL;
Discord accepts only its numeric message id; Substack accepts only the official
editor handoff URL. Conflict responses do not return another claim's receipt
metadata.

Model generation has zero retries at both the AI SDK request and Workflow step
layers, and provider publishing also has zero automatic retries. Generation
failures need configuration review and a fresh operator-requested run; this
avoids repeating the same billable request after a model, billing, schema, or
policy error. The idempotent ledger completion write may retry a bounded number
of times. If a provider accepted a request but its response was lost, the claim
remains `claimed`; replay skips the provider and reports that human
reconciliation is required.

### Ambiguous or failed delivery

1. Do not immediately rerun the bundle.
2. Check the X account and Discord channel directly for the candidate text.
3. Inspect the workflow run, its per-channel idempotency key, and the matching
   ledger row.
4. For a `429`, honor the provider's retry window.
5. If the item is public, reconcile the same claim to `published` with the
   provider message id and canonical URL. If the provider definitively confirms
   that nothing was accepted, reconcile it to `failed` with a short
   operator-verified failure code.
6. Only after that reconciliation may a new reviewed run be considered. If only
   some channels succeeded, request only the definitively absent channels. A
   multi-channel workflow does not roll back successful posts.

The reconciliation RPC is service-role-only:

```sql
-- Public X receipt found after a lost response:
select *
from public.complete_marketing_delivery_claim(
  'EXACT_IDEMPOTENCY_KEY',
  'x',
  'broadcast',
  'published',
  'X_POST_ID',
  'https://x.com/i/web/status/X_POST_ID',
  null
);

-- Provider definitively confirms no delivery:
select *
from public.complete_marketing_delivery_claim(
  'EXACT_IDEMPOTENCY_KEY',
  'x',
  'broadcast',
  'failed',
  null,
  null,
  'operator_verified_absent'
);
```

Run reconciliation only through the Supabase SQL editor or another reviewed
server-side service-role path, and verify that it returns `finalized` or a
matching `already_finalized`. Never expose the service-role key to the browser.
Starting a fresh run creates a new bundle and idempotency key, so an
unreconciled ambiguity can still become a duplicate if an operator bypasses
this procedure.

### Emergency stop

Use the narrowest effective control:

1. Disable new cron starts with
   `OPENZAPS_MARKETING_SCHEDULE_ENABLED=false` and redeploy.
2. Disable all new drafting with `OPENZAPS_MARKETING_ENABLED=false` and
   redeploy.
3. Set the affected channel cap to `0` and redeploy as an additional policy
   stop.
4. Reject every workflow waiting for approval. List runs with
   `npx workflow inspect runs --backend vercel`.
5. For an immediate external stop, revoke the X token or delete/rotate the
   Discord webhook. Rotate the Discord bot token if it was exposed.
6. Rotate `OPENZAPS_MARKETING_ADMIN_TOKEN` after any operator-token exposure
   and clear all operator tabs.

Vercel Workflow runs are pinned to the deployment that started them. A code
rollback or a new disabled deployment does not rewrite an already waiting run.
Policy therefore expires every source packet after six hours and blocks
materially future-dated evidence. Reject and regenerate any expired run.
Provider credential revocation remains the final stop when an in-flight
deployment must be made unable to publish.

### Common failures

| Symptom | Check |
| --- | --- |
| Status/runs return `401` | Operator token exists in the target Vercel environment, the deployment was rebuilt after the change, and the request uses one Bearer token. |
| Drafting returns `503` | `OPENZAPS_MARKETING_ENABLED`, exact boolean spellings, model authentication, durable-ledger readiness outside dry-run, and status blockers. |
| Model step fails | AI Gateway OIDC/key, model availability, account spend limits, and structured-output compatibility. |
| Run waits with no review alert | `DISCORD_MARKETING_REVIEW_WEBHOOK_URL`; the run remains visible in `/marketing` and Workflow even without an alert. |
| Discord interaction returns `401` | Exact application public key, raw-body proxy behavior, endpoint URL, and server clock. |
| Discord command is missing | Application installation scope and whether the command was registered to the correct guild/application. |
| X returns `401` or `403` | User-context token, `tweet.write` scope, token expiry/revocation, account access, and app permissions. |
| X identity verification is blocked | Confirm `X_EXPECTED_ACCOUNT_ID` is the intended account's numeric id and `X_EXPECTED_USERNAME=0xzaps`; then verify the active user-context credentials resolve to both values via `GET /2/users/me`. |
| X returns `429` | Stop, inspect the response window/provider dashboard, and wait. Never bypass rate limits. |
| X publishing is policy-blocked | Confirm user-context credentials and keep `OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=false` until the automated label/operator disclosure is visibly configured. Replies also require the separate X approval attestation and API-verified engagement. |
| Substack says `requires_human_publish` | Expected behavior; open the official editor and complete the human checklist. |
| Approval returns `409` | The run is not waiting, already decided, or the run id is wrong. Inspect the run before doing anything else. |
| Old run differs from current code | Expected Workflow version pinning. Review it under the deployment that created it or reject it and start fresh. |

## Monitoring and operating cadence

Review these surfaces at least weekly:

- Vercel Workflow runs, failed steps, model usage, and waiting hooks;
- Vercel Cron invocations and duplicate starts;
- X API spend/rate limits and actual broadcast posts;
- Discord webhook health and slash-command responses;
- DeFi Tutorials editor queue and public RSS;
- stale or repetitive copy, opt-outs, complaints, and policy changes.

A useful low-volume loop is:

1. Publish verified product/educational updates to X and Discord.
2. Prepare one substantive tutorial for human Substack publication.
3. Confirm the canonical Substack URL in public RSS.
4. Run a fresh reviewed syndication bundle linking to that tutorial.
5. Record reach, meaningful replies, Discord command usage, tutorial reads,
   and resulting product actions separately from vanity impressions.

The durable ledger records delivery admission and receipts, not audience
analytics, campaign attribution, or semantic duplicate detection. Do not claim
attribution the implementation does not measure, and do not use engagement
automation, bulk DMs, follow churn, trend hijacking, or substantially duplicate
posts to manufacture reach.

## Time-bounded dependency exception

As of 2026-07-29, `npm audit --omit=dev` traces one high-severity advisory,
[GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg),
through command-line/build dependencies bundled by `workflow@4.7.0`. The
affected Workflow CLI/Nest, oclif, SWC CLI, EJS, Jake, Filelist, Minimatch, and
Brace Expansion paths do not appear in the production Next.js runtime traces.

`npm run audit:production` is the narrow exception boundary. It fails on any
other high/critical advisory, fails if the reviewed dependency graph changes,
and fails if any affected build/CLI package enters a `.next` runtime trace. Do
not replace it with a blanket audit suppression or npm's unrelated suggested
`workflow@2.0.6` downgrade.

Recheck the stable Workflow dependency tree on every release and no later than
2026-08-12. Remove this exception immediately when Workflow ships a compatible
patched tree, or stop the release if the affected packages enter runtime output.

## Official references

- [Vercel Workflow](https://vercel.com/docs/workflows)
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [X automation rules](https://help.x.com/en/rules-and-policies/x-automation)
- [X create-post endpoint](https://docs.x.com/x-api/posts/create-post)
- [X OAuth 2.0 authorization-code flow](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
- [Discord receiving and responding to interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Discord webhooks](https://docs.discord.com/developers/resources/webhook)
- [Substack publishing](https://support.substack.com/hc/en-us/articles/360037831771-How-do-I-publish-a-new-post-on-Substack)
- [Substack publication RSS](https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication)
- [Substack API terms](https://substack.com/api-tos)
