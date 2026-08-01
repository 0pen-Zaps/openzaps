# OpenZaps Marketing Agent Runbook

This runbook covers deployment and operation of the OpenZaps marketing agent on
Vercel. Model-generated copy is **review-only**: the agent collects evidence
and drafts channel-specific copy, deterministic policy evaluates it, and an
authenticated operator approves or rejects every generated outbound bundle.
There is one narrower automatic lane for exact, versioned, source-reviewed
tier-1 educational or wallet-free simulation campaigns on ready X and Discord
broadcast providers. Campaign/channel rows are append-only release artifacts;
the model and public drafting inputs cannot add to the queue.

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
| Evidence before copy | Each run reads the production health, protocol activity, pot, Virtual Trading markets, a fresh read-only quote, and lead-intake readiness, then verifies bounded markers on the two promoted feature pages. Optional source URLs are restricted to OpenZaps, DeFi Tutorials, and the canonical GitHub repository. |
| External text is data | Fetched text is marked `instructionsTrusted: false` and cannot widen the operator brief or policy. |
| Claims cite facts | Every asserted or qualified generated claim must cite a source-packet fact key. Unavailable data is `null`, never zero. |
| Pre-audit disclosure | Public copy includes `Pre-audit software. Verify before use.` while the protocol remains pre-audit. |
| Canonical links only | Outbound links are restricted to `0xzaps.com`, `www.0xzaps.com`, `defitutorials.substack.com`, and `github.com/0pen-Zaps/openzaps`. |
| Human review | Every model-generated item and every reply remains review-only. Tutorials, incidents, security, token/trading, partnerships, roadmaps, and new deployments always require approval. |
| Paper simulation | The `simulation` topic is reserved for wallet-free, no-real-funds practice surfaces. Live or token trading remains `trading` and always requires approval. |
| Bounded scheduled campaigns | Automatic delivery accepts only an immutable campaign/channel row that exactly matches the source-reviewed registry and its SHA-256 content binding, only for tier-1 X/Discord broadcasts. It rechecks typed source requirements, freshness, provider identity/destination, caps, and the durable delivery claim immediately before writing. A changed body, fact source, claim, or channel cannot inherit that authority. |
| Review-only feed discovery | A separate daily cron reads only the source-controlled OpenZaps feed and public DeFi Tutorials RSS metadata. Its first complete snapshots are baselined, later canonical items are deduplicated into a private inbox, and it cannot start a workflow or call a provider. |
| Exact syndication attribution | An operator-started inbox workflow binds a deterministic, non-personal X or Discord UTM URL to the canonical source and campaign slug. Generation fails unless the exact channel URL appears in both the reviewed body and its link metadata. |
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
  -> oldest eligible source-reviewed campaign/channel (no model)
  -> exact database/source content-hash match
  -> deterministic tier-1 policy
  -> fresh automatic-authority and provider checks
  -> durable once-per-campaign/channel claim
  -> X / Discord delivery

discovery cron
  -> source-controlled OpenZaps feed + public DeFi Tutorials RSS metadata
  -> require a complete first baseline, including every RSS-confirmed tutorial
  -> durable deduplication inbox only
  -> zero workflows and zero provider writes
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
| `GET /api/marketing/cron` | Claim and start the next bounded reviewed-campaign workflow | `Authorization: Bearer <CRON_SECRET>` |
| `GET /api/marketing/syndication` | List the private feed inbox and reconcile attached workflow evidence | Operator bearer token |
| `POST /api/marketing/syndication` | Draft, skip, or repair the durable run link for one exact inbox item | Operator bearer token |
| `GET /api/marketing/syndication/cron` | Discover and deduplicate public feed metadata; never starts a workflow or provider write | `Authorization: Bearer <CRON_SECRET>` |
| `POST /api/marketing/substack/verify` | Read-only canonical-URL check against public DeFi Tutorials RSS, bound to one completed, approved editor handoff whose recorded title is used server-side | Operator bearer token |
| `POST /api/marketing/discord/interactions` | Receive Discord application commands | Discord Ed25519 request signature and a five-minute freshness window |
| `GET /api/leads/request` | Return non-secret, non-mutating lead-intake RPC readiness for fail-closed campaign evidence | Public; private/no-store response, with `503` while unavailable |

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
| `OPENZAPS_MARKETING_AUTO_PUBLISH` | `false` | Enables only exact source-reviewed queued campaigns when live mode, the durable ledger/queue, and at least one requested X/Discord provider are ready. It never authorizes model output, replies, tutorials, direct messages, or operator-supplied copy. |
| `OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED` | `false` | Set `true` only after the reviewed migration is applied and its RPC/privilege checks pass in the target Supabase project. Non-dry-run drafting fails closed without it. |
| `OPENZAPS_MARKETING_ADMIN_TOKEN` | unset | Strong random operator bearer token. Missing configuration denies every operator API. |
| `OPENZAPS_MARKETING_APPROVER_ID` | `authenticated-operator` | Non-secret audit label recorded with approvals. Do not put an email address or other unnecessary personal data here. |
| `OPENZAPS_MARKETING_MODEL` | `openai/gpt-5-mini` | AI Gateway model id. The default is currently listed for free-tier access; re-check the live catalog and rerun structured-output tests before changing it. |
| `OPENZAPS_MARKETING_SITE_URL` | `https://www.0xzaps.com` | Evidence origin. Only canonical HTTPS OpenZaps origins are accepted; any other value falls back to production. |
| `AI_GATEWAY_API_KEY` | unset | Local/non-Vercel model authentication only. Vercel production uses automatically managed OIDC; do not add an OpenAI key for this agent. |
| `OPENZAPS_MARKETING_SUPABASE_PROJECT_REF` | unset | Exact lowercase project ref for the OpenZaps Supabase project. Cloud ledger access remains blocked unless this value matches the host in `SUPABASE_URL`. |
| `SUPABASE_URL` | unset | Existing server-only OpenZaps Supabase project URL. It must exactly equal `https://<OPENZAPS_MARKETING_SUPABASE_PROJECT_REF>.supabase.co` (or use loopback HTTP in local development). |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Existing server-only service-role key used for the reviewed marketing RPCs and domain-separated syndication attachment-repair proofs. Never expose it to the browser, operator, or a model. |

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
can become `true` only for the reviewed-campaign prerequisites above; the
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
claims at most one eligible campaign/channel, returns `no_pending_campaign`
without starting a workflow when the queue is empty, and can publish only when
`OPENZAPS_MARKETING_AUTO_PUBLISH=true` and every fresh gate passes. Substack,
replies, and arbitrary copy are outside this lane.

Keep the schedule disabled during previews and initial production rollout.
Before starting a workflow, cron atomically claims one
`weekday_product_update` slot and the oldest eligible campaign/channel for the
current UTC weekday in Supabase.
Overlapping or retried invocations return `already_claimed` without creating a
second run. A claimed slot is deliberately retained when workflow start is
ambiguous, so the day's scheduled draft may be skipped rather than duplicated.
Each campaign and channel also has one stable durable delivery key. A
retry inside the same workflow run can reconcile its original receipt. Once
a delivery key exists, later weekdays advance to the next eligible row. A
schedule claim without a delivery key suppresses duplicate starts for that UTC
day, then becomes eligible for a later weekday retry. Shipping new automatic
copy requires a new reviewed source entry plus its exact append-only queue row
and content hash; never date-salt identical text to manufacture a new delivery.
The initial queue is empty because the Virtual Trading and Request-a-Zap update
was already published to both X and Discord. No duplicate pending row or
fabricated historical delivery receipt is created.

The separate feed-discovery route runs at `30 13 * * *`: 13:30 UTC every
day. It becomes operational only after the syndication migration is applied
and the exact durable Supabase binding is enabled. It reads approved public
metadata, updates the private inbox and validators, and returns
`providerWritesAttempted: false` and `workflowsStarted: false`. It never uses
`OPENZAPS_MARKETING_AUTO_PUBLISH`, never starts the marketing workflow, and
never calls X, Discord, or a Substack write surface.

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
- an idempotency key bound to the exact candidate.

The reviewed draft bundle persists the approved title, optional subtitle,
body Markdown, and tags. After the exact handoff is approved, the operator UI
derives sanitized HTML and plain text locally for copying; those derived forms
are not separate persisted review artifacts.

The operator must:

1. Open the returned `https://defitutorials.substack.com/publish/post` URL.
2. Use **Copy rich text** for the body and copy the approved title, subtitle,
   and tags separately. Keep the Markdown view as the immutable audit source;
   Substack's editor does not accept Markdown syntax as an import format. If
   rich clipboard MIME is unavailable, use the copied or selectable plain-text
   fallback.
3. Recheck every fact, link, image right, disclosure, and call to action in the
   Substack preview.
4. Publish or schedule from the official editor.
5. Paste the exact canonical `https://defitutorials.substack.com/p/...` URL
   into the operator's read-only RSS verifier. The request carries only the run
   id, candidate id, and canonical URL. The server loads the completed workflow,
   requires its approved official-editor handoff, derives the recorded title,
   and requires that URL and title to appear together in the public feed.
6. Update that tutorial's source-controlled entry in
   `docs/tutorials/manifest.json`: keep its reviewed source path and stable id,
   set the exact approved title, `status: "rss_confirmed"`, canonical public
   URL, and RSS publication timestamp. Review, commit, and deploy that manifest
   change before expecting discovery to authorize a social draft. The verifier
   does not mutate the manifest.
7. Record the canonical public post URL with the run id. The verifier currently
   reports `persisted: false`; it does not append a publication receipt to the
   durable ledger.
8. Confirm the next discovery run promotes or finds the RSS-confirmed item in the private
   feed inbox. Select **Draft X + Discord** to start the existing review
   workflow, then review and explicitly approve it as a separate outbound run.

The daily discovery cron uses bounded public-RSS parsing plus validated ETag and
`Last-Modified` cursors. The first complete snapshot is historical baseline,
not an outbound queue. Later items become private inbox entries only. Discovery
cannot turn a feed item into a social post; the operator action creates an
X/Discord draft with exact attributed links, and every generated post still
waits for owner approval.

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

### 4. Apply and verify the durable ledger, reviewed queue, and feed inbox

The production Supabase database is shared. Do not run a blind `supabase db
push`, repair unrelated migration history, or replay SQL copied from an
unreviewed branch. Follow [`supabase/README.md`](../supabase/README.md) and
apply only:

```text
supabase/migrations/20260729035549_marketing_delivery_ledger.sql
supabase/migrations/20260801024005_durable_reviewed_marketing_campaign_queue.sql
supabase/migrations/20260801041508_marketing_syndication_inbox.sql
```

If any file is already recorded remotely, apply only the missing exact files
in timestamp order. Do not use `db push` to cross unrelated or intentionally
unapplied rows in the shared migration history.

Apply them transactionally while the marketing agent is disabled. Then verify:

- the exact migration timestamp/name is recorded once;
- `public.marketing_delivery_ledger` has RLS enabled and no direct table grants
  for `anon`, `authenticated`, or `service_role`;
- `public.marketing_reviewed_campaigns` and
  `public.marketing_campaign_schedule_claims` have RLS enabled and no direct
  table grants for `anon`, `authenticated`, or `service_role`;
- `public.marketing_syndication_sources` and
  `public.marketing_syndication_items` have RLS enabled and no direct table
  grants for `anon`, `authenticated`, or `service_role`;
- only `service_role` can execute the public marketing RPCs, including the new
  reviewed-campaign claim and the bounded syndication cursor, discovery, list,
  claim, attach, fail, skip, and sync RPCs;
- the initial reviewed-campaign queue is empty because the
  `virtual-trading-request-zap-v2` update was already public on both X and
  Discord before the queue existed;
- an empty eligible queue returns `no_pending_campaign` without inserting a
  schedule claim or starting a workflow;
- the snapshot returns the current UTC day and zero or expected counters;
- an idempotency replay returns the stored claim/receipt and never inserts a
  second row;
- concurrent claims at a cap of one admit exactly one caller;
- an empty first syndication snapshot is rejected and writes no cursor;
- the first complete OpenZaps and DeFi Tutorials snapshots create only
  `baseline` rows, including every current `rss_confirmed` manifest URL;
- an exact discovery replay creates no pending item, workflow, or provider
  write; a later new canonical item creates one `pending` inbox row;
- attaching a workflow run id retains `drafting`; only verified workflow draft
  evidence may advance it to `awaiting_approval`;
- a partial X/Discord delivery is recorded as failed/incomplete, never as a
  fully published syndication item.

Keep a record of the verification output with the release. The migrations are
append-only audit/idempotency boundaries; do not add a destructive rollback.
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

After the redeploy, invoke `/api/marketing/syndication/cron` with the cron
bearer credential before the scheduled window. Initialization is transactional
per source, not across both feeds: if the later Substack fetch fails, the
OpenZaps baseline may already be durable. Across the first successful attempts,
require each source to report `initialized` exactly once, every first-seen row
to be `baseline`, and both `providerWritesAttempted` and `workflowsStarted` to
remain `false`. Then invoke it again and prove no item becomes pending. If
either baseline is empty, incomplete, or unavailable, stop; do not repair the
cursor by hand or expect both sources to initialize in the same response.

### 5. Enable production dry-run

Set only `OPENZAPS_MARKETING_ENABLED=true`, redeploy, and run one X/Discord
product update plus one Substack tutorial. Both must end as dry runs with no
provider side effect. Review the exact source packet, model usage, and readiness
report. Dry-run does not consume durable delivery counters. Open the private
feed inbox and verify baseline rows have no draft action, while a controlled
later source fixture becomes one pending review item without starting a
workflow until the operator selects it.

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

Redeploy, then verify the next Vercel Cron invocation returns
`no_pending_campaign` and creates no workflow or provider write. That is the
expected initial state. To exercise automatic delivery, add a genuinely new,
owner-reviewed campaign in source plus its exact append-only queue migration,
deploy both together, and verify the next eligible invocation returns `202`
with a run id and records `auto_authorized`. Confirm the canonical provider
receipt, then replay the same campaign and prove the stable delivery key
returns the stored receipt without a second provider call. Written X approval
remains an additional requirement for AI replies, which are never part of this
automatic lane. Leave every model-generated run and every reply on the
approval hook.

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

List the review-only feed inbox:

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${MARKETING_OPERATOR_TOKEN}" \
  "${MARKETING_BASE_URL}/api/marketing/syndication"
```

Starting a draft from `/marketing` is preferred. The bounded API action accepts
only one exact pending item id:

```bash
export SYNDICATION_ITEM_ID="64-character-item-id"
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${MARKETING_OPERATOR_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "{\"action\":\"draft\",\"itemId\":\"${SYNDICATION_ITEM_ID}\"}" \
  "${MARKETING_BASE_URL}/api/marketing/syndication"
```

The returned run remains `drafting` until its real workflow event proves that
the review bundle is waiting for approval. Starting the workflow never implies
approval or publication.

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

### Feed-inbox workflow attachment recovery

The inbox first claims a pending item, starts one workflow, and then attaches
the returned run id without changing the item from `drafting`. A verified
`draft.awaiting_approval` workflow event is the only evidence that advances it
to `awaiting_approval`.

If workflow start returns a run id but the attachment write fails, the
authenticated response includes that known run id plus a narrow HMAC repair
proof bound to the exact item/run pair. `/marketing` keeps that pair only in
tab-scoped session storage, opens the run, and retries only the idempotent
attachment; it never starts a replacement workflow. The proof grants no draft,
approval, or provider-write authority and is signed with a server-only durable
store credential the operator never receives. If that credential rotates, the
proof becomes invalid. If manual repair is required, use the exact values from
that authenticated response without logging them:

```bash
export MARKETING_RUN_ID="original-returned-run-id"
export MARKETING_REPAIR_PROOF="original-returned-repair-proof"
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${MARKETING_OPERATOR_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "{\"action\":\"attach\",\"itemId\":\"${SYNDICATION_ITEM_ID}\",\"runId\":\"${MARKETING_RUN_ID}\",\"repairProof\":\"${MARKETING_REPAIR_PROOF}\"}" \
  "${MARKETING_BASE_URL}/api/marketing/syndication"
```

Do not call `draft` again, create a new workflow, or mutate the inbox row. If
the exact proof is absent, invalid, substituted, or invalidated by credential
rotation, do not reconstruct it from either identifier. Leave the item
unresolved and inspect the deployment-pinned Workflow history before taking
further action.

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
| Inbox item is `drafting` without a run link | Do not start another draft. Recover the exact original run id and repair proof from the authenticated response and use the bounded `attach` action; never substitute either value. If the proof is unavailable or the run does not exist, leave it unresolved. |
| Syndication cron returns `503` on first run | Confirm the feed is non-empty, contains every current `rss_confirmed` manifest URL, returns valid ETag/Last-Modified values, and the exact inbox migration is applied. Never baseline an incomplete response manually. |
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

The durable ledger records delivery admission and receipts, while syndication
drafts carry deterministic per-channel UTM links. Neither surface proves visits,
conversions, or semantic duplicate detection. Do not claim measured attribution
until the analytics destination records it, and do not use engagement
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
- [Substack Markdown support](https://support.substack.com/hc/en-us/articles/360037463132-Do-you-support-Markdown)
- [Substack publication RSS](https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication)
- [Substack API terms](https://substack.com/api-tos)
