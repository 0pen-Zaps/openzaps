-- Replace six not-yet-delivered reviewed campaign artifacts with exact
-- channel-attributed copies. Existing queue rows remain immutable historical
-- evidence; the append-only supersession ledger makes them ineligible.

create table public.marketing_reviewed_campaign_supersessions (
  superseded_campaign_id text not null,
  superseded_channel text not null check (superseded_channel in ('x', 'discord')),
  replacement_campaign_id text not null,
  replacement_channel text not null check (replacement_channel in ('x', 'discord')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (superseded_campaign_id, superseded_channel),
  unique (replacement_campaign_id, replacement_channel),
  check (superseded_channel = replacement_channel),
  check (superseded_campaign_id <> replacement_campaign_id),
  foreign key (superseded_campaign_id, superseded_channel)
    references public.marketing_reviewed_campaigns (campaign_id, channel),
  foreign key (replacement_campaign_id, replacement_channel)
    references public.marketing_reviewed_campaigns (campaign_id, channel)
);

alter table public.marketing_reviewed_campaign_supersessions enable row level security;
revoke all on table public.marketing_reviewed_campaign_supersessions
  from public, anon, authenticated, service_role;

-- Exclude a race between the reconciliation guard and the replacement rows.
lock table public.marketing_reviewed_campaigns in share row exclusive mode;
lock table public.marketing_campaign_schedule_claims in share row exclusive mode;
lock table public.marketing_delivery_ledger in share row exclusive mode;

do $guard$
begin
  if exists (
    select 1
    from public.marketing_campaign_schedule_claims as schedule_claim
    where (schedule_claim.campaign_id, schedule_claim.channel) in (
      ('agent-kit-published-v1', 'discord'),
      ('agent-kit-published-v1', 'x'),
      ('learn-hub-launched-v1', 'x'),
      ('learn-hub-launched-v1', 'discord'),
      ('share-zap-design-v1', 'discord'),
      ('share-zap-design-v1', 'x')
    )
  ) or exists (
    select 1
    from public.marketing_delivery_ledger as delivery
    where delivery.idempotency_key in (
      'scheduled:agent-kit-published-v1:discord',
      'scheduled:agent-kit-published-v1:x',
      'scheduled:learn-hub-launched-v1:x',
      'scheduled:learn-hub-launched-v1:discord',
      'scheduled:share-zap-design-v1:discord',
      'scheduled:share-zap-design-v1:x'
    )
  ) then
    raise exception 'cannot supersede a claimed or delivered marketing campaign';
  end if;
end;
$guard$;

insert into public.marketing_reviewed_campaigns (
  campaign_id,
  channel,
  queue_order,
  not_before,
  body,
  links,
  topics,
  disclosures,
  claims,
  flags,
  required_facts,
  canonical_source_urls,
  content_hash
)
values
(
  'agent-kit-published-v2',
  'discord',
  120,
  '2026-08-03T14:00:00.000Z'::timestamptz,
  $campaign$**The OpenZaps Agent Kit is published.**

`@openzaps/sdk@0.1.0` compiles the exact policy tuple and prepares unsigned EIP-712 data. `@openzaps/mcp@0.1.0` gives agent clients read-only capsule discovery. Both releases carry npm provenance attestations.

Neither package holds a key, signs, or broadcasts. Your wallet or Safe creates authority; the signed intent and immutable Zap policy set the bounds.

Connect an agent: https://www.0xzaps.com/agent-kit?utm_source=discord&utm_medium=community&utm_campaign=agent-kit-published-v2&utm_content=feed_update

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/agent-kit?utm_source=discord&utm_medium=community&utm_campaign=agent-kit-published-v2&utm_content=feed_update"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "The npm registry publishes @openzaps/sdk@0.1.0 with a provenance attestation.",
      "factKeys": ["product.agent_kit_sdk_release"],
      "treatment": "asserted"
    },
    {
      "text": "The npm registry publishes @openzaps/mcp@0.1.0 with a provenance attestation.",
      "factKeys": ["product.agent_kit_mcp_release"],
      "treatment": "asserted"
    },
    {
      "text": "The SDK prepares unsigned policy data without signing or broadcasting; the read-only MCP surface discovers capsules without holding a wallet key; creation stays with the owner wallet or Safe, and execution authority lives in the immutable policy or typed intent.",
      "factKeys": ["product.agent_kit_boundaries"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.agent_kit_sdk_release",
      "sourceUrl": "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0"
    },
    {
      "key": "product.agent_kit_mcp_release",
      "sourceUrl": "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0"
    },
    {
      "key": "product.agent_kit_boundaries",
      "sourceUrl": "https://www.0xzaps.com/docs"
    }
  ]'::jsonb,
  '[
    "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0",
    "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0",
    "https://www.0xzaps.com/docs"
  ]'::jsonb,
  '9fcbfdbf84d79274c27dac26479aaf0560e7434cbb6614b0e90d976fb0af39dc'
),
(
  'agent-kit-published-v2',
  'x',
  121,
  '2026-08-05T14:00:00.000Z'::timestamptz,
  $campaign$OpenZaps Agent Kit is live.

SDK: bounded policies. MCP: read-only discovery. No keys, signing, or broadcasting.

https://www.0xzaps.com/agent-kit?utm_source=x&utm_medium=social&utm_campaign=agent-kit-published-v2&utm_content=feed_update

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/agent-kit?utm_source=x&utm_medium=social&utm_campaign=agent-kit-published-v2&utm_content=feed_update"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "The npm registry publishes @openzaps/sdk@0.1.0, and the live Agent Kit page states that the SDK compiles the exact policy tuple and prepares unsigned EIP-712 data.",
      "factKeys": ["product.agent_kit_sdk_release", "product.agent_kit_page"],
      "treatment": "asserted"
    },
    {
      "text": "The npm registry publishes @openzaps/mcp@0.1.0, and the live Agent Kit page states that the MCP surface gives agent clients read-only capsule discovery.",
      "factKeys": ["product.agent_kit_mcp_release", "product.agent_kit_page"],
      "treatment": "asserted"
    },
    {
      "text": "The live Agent Kit page states that neither package holds a wallet key, signs, or broadcasts.",
      "factKeys": ["product.agent_kit_page"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.agent_kit_sdk_release",
      "sourceUrl": "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0"
    },
    {
      "key": "product.agent_kit_mcp_release",
      "sourceUrl": "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0"
    },
    {
      "key": "product.agent_kit_page",
      "sourceUrl": "https://www.0xzaps.com/agent-kit"
    }
  ]'::jsonb,
  '[
    "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0",
    "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0",
    "https://www.0xzaps.com/agent-kit"
  ]'::jsonb,
  '7abff834112caf333811d11ff2291915179029d704c41b1b6f386a4ea64438e7'
),
(
  'learn-hub-launched-v2',
  'x',
  130,
  '2026-08-04T14:00:00.000Z'::timestamptz,
  $campaign$OpenZaps Learn is live.

Source-reviewed updates + RSS-confirmed DeFi Tutorials. Drafts stay out until confirmed.

https://www.0xzaps.com/learn?utm_source=x&utm_medium=social&utm_campaign=learn-hub-launched-v2&utm_content=feed_update

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/learn?utm_source=x&utm_medium=social&utm_campaign=learn-hub-launched-v2&utm_content=feed_update"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "OpenZaps Learn publishes source-reviewed product updates and only RSS-confirmed DeFi Tutorials, withholds drafts and editor handoffs from its catalog until RSS confirmation, and links to Request a Zap for a human-reviewed authority map.",
      "factKeys": ["product.learn_hub"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.learn_hub",
      "sourceUrl": "https://www.0xzaps.com/learn"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  'f25701fecbcd1be418a5e97c64a87e3db8ad5c69fc9e4e7677b4b84bb9f3837c'
),
(
  'learn-hub-launched-v2',
  'discord',
  131,
  '2026-08-04T14:00:00.000Z'::timestamptz,
  $campaign$**OpenZaps Learn is live.**

The new hub collects source-reviewed OpenZaps product updates and DeFi Tutorials whose title and canonical URL are RSS-confirmed. Drafts and editor handoffs are withheld from the Learn catalog until RSS confirmation.

Use it to follow what shipped, read why the bounds matter, or request a human-reviewed authority map for one workflow:
https://www.0xzaps.com/learn?utm_source=discord&utm_medium=community&utm_campaign=learn-hub-launched-v2&utm_content=feed_update

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/learn?utm_source=discord&utm_medium=community&utm_campaign=learn-hub-launched-v2&utm_content=feed_update"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "OpenZaps Learn publishes source-reviewed product updates and only RSS-confirmed DeFi Tutorials, withholds drafts and editor handoffs from its catalog until RSS confirmation, and links to Request a Zap for a human-reviewed authority map.",
      "factKeys": ["product.learn_hub"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.learn_hub",
      "sourceUrl": "https://www.0xzaps.com/learn"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  '3e919b5a929225399ff4dc444f89079a6a65a1abb6dc3a9fe89fc09bfa73d646'
),
(
  'share-zap-design-v2',
  'discord',
  140,
  '2026-08-07T14:00:00.000Z'::timestamptz,
  $campaign$**Share a Zap design—not wallet authority.**

OpenZaps can encode a designed chain into a `?d=` link. When someone opens it, the builder validates the design against the current typed-block catalog and recompiles the result. Design mode does not prompt for wallet access, approval, a signature, or a transaction.

A link may carry a live-route design or a design-only blueprint. The receiver still has to review which bounds the selected lineage enforces; any live action requires their own wallet review and signature.

Build and review:
https://www.0xzaps.com/zap?view=design&utm_source=discord&utm_medium=community&utm_campaign=share-zap-design-v2&utm_content=feed_update

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/zap?view=design&utm_source=discord&utm_medium=community&utm_campaign=share-zap-design-v2&utm_content=feed_update"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "An OpenZaps design link carries only a designed chain into the builder, which bounds and validates the untrusted payload before recompiling recognized blocks and parameters; the link grants no wallet authority, design mode never prompts for wallet access, approval, funding, a signature, or a transaction, and any supported live action remains separately wallet-reviewed and signed.",
      "factKeys": ["product.shareable_zap_design"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.shareable_zap_design",
      "sourceUrl": "https://www.0xzaps.com/docs"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/docs"]'::jsonb,
  'e4a832a26c0cd79787c77829bbf2a54529fb696588df1899570492df0ae461d5'
),
(
  'share-zap-design-v2',
  'x',
  141,
  '2026-08-10T14:00:00.000Z'::timestamptz,
  $campaign$Share a Zap design—not wallet authority.

Validated in builder. No wallet prompt, signature, or transaction.

https://www.0xzaps.com/zap?view=design&utm_source=x&utm_medium=social&utm_campaign=share-zap-design-v2&utm_content=feed_update

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/zap?view=design&utm_source=x&utm_medium=social&utm_campaign=share-zap-design-v2&utm_content=feed_update"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "An OpenZaps design link carries only a designed chain into the builder, which bounds and validates the untrusted payload before recompiling recognized blocks and parameters; the link grants no wallet authority, design mode never prompts for wallet access, approval, funding, a signature, or a transaction, and any supported live action remains separately wallet-reviewed and signed.",
      "factKeys": ["product.shareable_zap_design"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.shareable_zap_design",
      "sourceUrl": "https://www.0xzaps.com/docs"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/docs"]'::jsonb,
  '4be6f92cd4047cb149d5a03257773d472c035fe613a91746215a25224c2ad392'
);

insert into public.marketing_reviewed_campaign_supersessions (
  superseded_campaign_id,
  superseded_channel,
  replacement_campaign_id,
  replacement_channel
)
values
  ('agent-kit-published-v1', 'discord', 'agent-kit-published-v2', 'discord'),
  ('agent-kit-published-v1', 'x', 'agent-kit-published-v2', 'x'),
  ('learn-hub-launched-v1', 'x', 'learn-hub-launched-v2', 'x'),
  ('learn-hub-launched-v1', 'discord', 'learn-hub-launched-v2', 'discord'),
  ('share-zap-design-v1', 'discord', 'share-zap-design-v2', 'discord'),
  ('share-zap-design-v1', 'x', 'share-zap-design-v2', 'x');

create trigger marketing_reviewed_campaign_supersessions_immutable
before update or delete or truncate
on public.marketing_reviewed_campaign_supersessions
for each statement
execute function private.reject_marketing_campaign_mutation();

create or replace function private.claim_next_marketing_campaign_at(
  p_channels text[],
  p_now timestamptz
)
returns table (
  result_code text,
  schedule_key text,
  slot_day date,
  campaign_id text,
  channel text,
  queue_order integer,
  not_before timestamptz,
  body text,
  links jsonb,
  topics jsonb,
  disclosures jsonb,
  claims jsonb,
  flags jsonb,
  required_facts jsonb,
  canonical_source_urls jsonb,
  content_hash text,
  claimed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  utc_now timestamptz;
  utc_day date;
  selected_campaign public.marketing_reviewed_campaigns%rowtype;
  existing_claim public.marketing_campaign_schedule_claims%rowtype;
  campaign_claimed_at timestamptz;
begin
  if p_now is null
    or p_now in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_channels is null
    or pg_catalog.cardinality(p_channels) not between 1 and 2
    or exists (
      select 1
      from pg_catalog.unnest(p_channels) as requested(value)
      where requested.value not in ('x', 'discord')
    )
    or pg_catalog.cardinality(p_channels) <> (
      select count(distinct requested.value)::integer
      from pg_catalog.unnest(p_channels) as requested(value)
    )
  then
    raise exception 'invalid reviewed marketing campaign channels';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-marketing-campaign-queue', 0)
  );
  utc_now := p_now;
  utc_day := (utc_now at time zone 'UTC')::date;

  if extract(isodow from utc_day) not between 1 and 5 then
    return query
      select
        'outside_schedule'::text,
        'weekday_product_update'::text,
        utc_day,
        null::text,
        null::text,
        null::integer,
        null::timestamptz,
        null::text,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::text,
        null::timestamptz;
    return;
  end if;

  select claims_table.*
  into existing_claim
  from public.marketing_campaign_schedule_claims as claims_table
  where claims_table.schedule_key = 'weekday_product_update'
    and claims_table.claim_day = utc_day;

  if found then
    return query
      select
        'already_claimed'::text,
        'weekday_product_update'::text,
        utc_day,
        null::text,
        null::text,
        null::integer,
        null::timestamptz,
        null::text,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::text,
        existing_claim.claimed_at;
    return;
  end if;

  select campaigns.*
  into selected_campaign
  from public.marketing_reviewed_campaigns as campaigns
  where campaigns.channel = any(p_channels)
    and (campaigns.not_before is null or campaigns.not_before <= utc_now)
    and not exists (
      select 1
      from public.marketing_reviewed_campaign_supersessions as supersession
      where supersession.superseded_campaign_id = campaigns.campaign_id
        and supersession.superseded_channel = campaigns.channel
    )
    and not exists (
      select 1
      from public.marketing_delivery_ledger as delivery
      where delivery.idempotency_key =
        'scheduled:' || campaigns.campaign_id || ':' || campaigns.channel
    )
  order by campaigns.queue_order, campaigns.campaign_id, campaigns.channel
  limit 1;

  if not found then
    return query
      select
        'no_pending_campaign'::text,
        'weekday_product_update'::text,
        utc_day,
        null::text,
        null::text,
        null::integer,
        null::timestamptz,
        null::text,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::jsonb,
        null::text,
        null::timestamptz;
    return;
  end if;

  insert into public.marketing_campaign_schedule_claims (
    campaign_id,
    channel,
    schedule_key,
    claim_day
  )
  values (
    selected_campaign.campaign_id,
    selected_campaign.channel,
    'weekday_product_update',
    utc_day
  )
  returning marketing_campaign_schedule_claims.claimed_at
  into campaign_claimed_at;

  return query
    select
      'claimed'::text,
      'weekday_product_update'::text,
      utc_day,
      selected_campaign.campaign_id,
      selected_campaign.channel,
      selected_campaign.queue_order,
      selected_campaign.not_before,
      selected_campaign.body,
      selected_campaign.links,
      selected_campaign.topics,
      selected_campaign.disclosures,
      selected_campaign.claims,
      selected_campaign.flags,
      selected_campaign.required_facts,
      selected_campaign.canonical_source_urls,
      selected_campaign.content_hash,
      campaign_claimed_at;
end;
$function$;

revoke all on function private.claim_next_marketing_campaign_at(
  text[], timestamptz
) from public, anon, authenticated, service_role;
