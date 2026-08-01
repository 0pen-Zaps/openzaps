-- Durable queue for exact source-reviewed campaign/channel copy.
--
-- Campaign rows are append-only release artifacts. Service-role callers can
-- only claim the oldest eligible row through the bounded RPC; they cannot read
-- or mutate either table directly. Model output never enters this queue.

create table public.marketing_reviewed_campaigns (
  campaign_id text not null
    check (
      char_length(campaign_id) between 1 and 120
      and campaign_id ~ '^[a-z0-9][a-z0-9-]*$'
    ),
  channel text not null check (channel in ('x', 'discord')),
  queue_order integer not null unique
    check (queue_order between 1 and 1000000),
  not_before timestamptz,
  body text not null
    check (
      char_length(body) between 1 and 2000
      and (channel <> 'x' or char_length(body) <= 280)
    ),
  links jsonb not null check (jsonb_typeof(links) = 'array'),
  topics jsonb not null check (jsonb_typeof(topics) = 'array'),
  disclosures jsonb not null check (jsonb_typeof(disclosures) = 'array'),
  claims jsonb not null check (jsonb_typeof(claims) = 'array'),
  flags jsonb not null check (jsonb_typeof(flags) = 'object'),
  required_facts jsonb not null
    check (jsonb_typeof(required_facts) = 'array'),
  canonical_source_urls jsonb not null
    check (jsonb_typeof(canonical_source_urls) = 'array'),
  content_hash text not null
    check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (campaign_id, channel)
);

alter table public.marketing_reviewed_campaigns enable row level security;
revoke all on table public.marketing_reviewed_campaigns
  from public, anon, authenticated, service_role;

create table public.marketing_campaign_schedule_claims (
  campaign_id text not null,
  channel text not null,
  schedule_key text not null
    check (schedule_key = 'weekday_product_update'),
  claim_day date not null
    check (extract(isodow from claim_day) between 1 and 5),
  claimed_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (campaign_id, channel, claim_day),
  unique (schedule_key, claim_day),
  foreign key (campaign_id, channel)
    references public.marketing_reviewed_campaigns (campaign_id, channel)
);

alter table public.marketing_campaign_schedule_claims enable row level security;
revoke all on table public.marketing_campaign_schedule_claims
  from public, anon, authenticated, service_role;

-- The initial release intentionally starts empty. The virtual-trading and
-- Request-a-Zap announcement was already published to X and Discord before
-- this durable queue existed. Queueing either copy here would create a second
-- public post, while fabricating a historical delivery row would weaken
-- receipt provenance. Future reviewed campaigns are appended by new,
-- source-reviewed migrations.

create or replace function private.reject_marketing_campaign_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'reviewed marketing campaign artifacts are immutable';
end;
$function$;

revoke all on function private.reject_marketing_campaign_mutation()
  from public, anon, authenticated, service_role;

create trigger marketing_reviewed_campaigns_immutable
before update or delete or truncate
on public.marketing_reviewed_campaigns
for each statement
execute function private.reject_marketing_campaign_mutation();

create trigger marketing_campaign_schedule_claims_immutable
before update or delete or truncate
on public.marketing_campaign_schedule_claims
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

create or replace function private.claim_next_marketing_campaign(
  p_channels text[]
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
language sql
security definer
set search_path = ''
as $function$
  select *
  from private.claim_next_marketing_campaign_at(
    p_channels,
    pg_catalog.clock_timestamp()
  );
$function$;

revoke all on function private.claim_next_marketing_campaign(text[])
  from public, anon, authenticated, service_role;
grant execute on function private.claim_next_marketing_campaign(text[])
  to service_role;

create or replace function public.claim_next_marketing_campaign(
  p_channels text[]
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
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.claim_next_marketing_campaign(p_channels);
$function$;

revoke all on function public.claim_next_marketing_campaign(text[])
  from public, anon, authenticated, service_role;
grant execute on function public.claim_next_marketing_campaign(text[])
  to service_role;

create or replace function private.verify_marketing_campaign_schedule_claim_at(
  p_campaign_id text,
  p_channel text,
  p_slot_day date,
  p_content_hash text,
  p_now timestamptz
)
returns table (
  verified boolean,
  claimed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  durable_claimed_at timestamptz;
  utc_day date;
begin
  if p_now is null
    or p_now in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_campaign_id is null
    or char_length(p_campaign_id) not between 1 and 120
    or p_campaign_id !~ '^[a-z0-9][a-z0-9-]*$'
    or p_channel is null
    or p_channel not in ('x', 'discord')
    or p_slot_day is null
    or extract(isodow from p_slot_day) not between 1 and 5
    or p_content_hash is null
    or p_content_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid reviewed marketing campaign claim identity';
  end if;

  utc_day := (p_now at time zone 'UTC')::date;
  if p_slot_day <> utc_day then
    return query select false, null::timestamptz;
    return;
  end if;

  select schedule_claim.claimed_at
  into durable_claimed_at
  from public.marketing_campaign_schedule_claims as schedule_claim
  join public.marketing_reviewed_campaigns as campaign
    on campaign.campaign_id = schedule_claim.campaign_id
   and campaign.channel = schedule_claim.channel
  where schedule_claim.campaign_id = p_campaign_id
    and schedule_claim.channel = p_channel
    and schedule_claim.claim_day = p_slot_day
    and schedule_claim.schedule_key = 'weekday_product_update'
    and campaign.content_hash = p_content_hash;

  if not found then
    return query select false, null::timestamptz;
    return;
  end if;

  return query select true, durable_claimed_at;
end;
$function$;

revoke all on function private.verify_marketing_campaign_schedule_claim_at(
  text, text, date, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function private.verify_marketing_campaign_schedule_claim(
  p_campaign_id text,
  p_channel text,
  p_slot_day date,
  p_content_hash text
)
returns table (
  verified boolean,
  claimed_at timestamptz
)
language sql
security definer
set search_path = ''
as $function$
  select *
  from private.verify_marketing_campaign_schedule_claim_at(
    p_campaign_id,
    p_channel,
    p_slot_day,
    p_content_hash,
    pg_catalog.clock_timestamp()
  );
$function$;

revoke all on function private.verify_marketing_campaign_schedule_claim(
  text, text, date, text
) from public, anon, authenticated, service_role;
grant execute on function private.verify_marketing_campaign_schedule_claim(
  text, text, date, text
) to service_role;

create or replace function public.verify_marketing_campaign_schedule_claim(
  p_campaign_id text,
  p_channel text,
  p_slot_day date,
  p_content_hash text
)
returns table (
  verified boolean,
  claimed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.verify_marketing_campaign_schedule_claim(
    p_campaign_id,
    p_channel,
    p_slot_day,
    p_content_hash
  );
$function$;

revoke all on function public.verify_marketing_campaign_schedule_claim(
  text, text, date, text
) from public, anon, authenticated, service_role;
grant execute on function public.verify_marketing_campaign_schedule_claim(
  text, text, date, text
) to service_role;
