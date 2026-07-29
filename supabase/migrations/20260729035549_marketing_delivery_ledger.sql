-- Durable, service-role-only admission ledger for reviewed marketing delivery.
--
-- Every provider call must first acquire one immutable idempotency claim. The
-- claim transaction enforces the configured UTC-day counter and the lifetime
-- one-reply-per-X-interaction rule. Failed/ambiguous provider calls retain
-- their claim and continue to consume the cap: safety wins over retrying a
-- post that may already be public.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists public.marketing_delivery_ledger (
  idempotency_key text primary key
    check (
      char_length(idempotency_key) between 1 and 200
      and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  run_id text not null
    check (char_length(run_id) between 1 and 200),
  candidate_id text not null
    check (char_length(candidate_id) between 1 and 300),
  content_hash text not null
    check (content_hash ~ '^[0-9a-f]{64}$'),
  channel text not null
    check (channel in ('x', 'discord', 'substack')),
  action text not null
    check (
      action in (
        'broadcast',
        'reply',
        'prepare_tutorial'
      )
    ),
  counter_key text not null
    check (
      counter_key in (
        'xPosts',
        'xReplies',
        'discordPosts',
        'substackTutorials',
        'directMessages'
      )
    ),
  interaction_id text,
  approved_by text not null
    check (char_length(approved_by) between 1 and 120),
  claim_day date not null,
  status text not null default 'claimed'
    check (
      status in (
        'claimed',
        'published',
        'failed',
        'requires_human_publish'
      )
    ),
  provider_message_id text
    check (
      provider_message_id is null
      or char_length(provider_message_id) between 1 and 200
    ),
  provider_url text
    check (
      provider_url is null
      or (
        char_length(provider_url) between 1 and 2048
        and provider_url ~ '^https://'
      )
    ),
  failure_code text
    check (
      failure_code is null
      or failure_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    ),
  claimed_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  check (
    (
      channel = 'x'
      and action = 'reply'
      and interaction_id is not null
      and interaction_id ~ '^[0-9]{1,30}$'
    )
    or (
      not (channel = 'x' and action = 'reply')
      and interaction_id is null
    )
  ),
  check (
    (channel = 'x' and action in ('broadcast', 'reply'))
    or (channel = 'discord' and action = 'broadcast')
    or (channel = 'substack' and action = 'prepare_tutorial')
  ),
  check (
    (channel = 'x' and action = 'broadcast' and counter_key = 'xPosts')
    or (channel = 'x' and action = 'reply' and counter_key = 'xReplies')
    or (channel = 'discord' and action = 'broadcast' and counter_key = 'discordPosts')
    or (
      channel = 'substack'
      and action = 'prepare_tutorial'
      and counter_key = 'substackTutorials'
    )
  ),
  check (
    (status = 'claimed' and finalized_at is null)
    or (status <> 'claimed' and finalized_at is not null)
  ),
  check (
    (status = 'failed' and failure_code is not null)
    or (status <> 'failed' and failure_code is null)
  ),
  check (
    (
      status = 'claimed'
      and provider_message_id is null
      and provider_url is null
    )
    or (
      status = 'failed'
      and provider_message_id is null
      and provider_url is null
    )
    or (
      channel = 'x'
      and action in ('broadcast', 'reply')
      and status = 'published'
      and provider_message_id is not null
      and provider_message_id ~ '^[0-9]{1,19}$'
      and provider_url is not null
      and provider_url =
        'https://x.com/i/web/status/' || provider_message_id
    )
    or (
      channel = 'discord'
      and action = 'broadcast'
      and status = 'published'
      and provider_message_id is not null
      and provider_message_id ~ '^[0-9]{1,30}$'
      and provider_url is null
    )
    or (
      channel = 'substack'
      and action = 'prepare_tutorial'
      and status = 'requires_human_publish'
      and provider_message_id is null
      and provider_url is not null
      and provider_url =
        'https://defitutorials.substack.com/publish/post'
    )
  )
);

alter table public.marketing_delivery_ledger enable row level security;
revoke all on table public.marketing_delivery_ledger
  from public, anon, authenticated, service_role;

create unique index if not exists marketing_delivery_one_x_reply
  on public.marketing_delivery_ledger (interaction_id)
  where channel = 'x' and action = 'reply';

create index if not exists marketing_delivery_daily_counter
  on public.marketing_delivery_ledger (claim_day, counter_key);

-- The privileged implementation stays outside the exposed public schema. Its
-- public wrapper is SECURITY INVOKER and executable only by service_role.
create or replace function private.claim_marketing_delivery(
  p_idempotency_key text,
  p_run_id text,
  p_candidate_id text,
  p_content_hash text,
  p_channel text,
  p_action text,
  p_interaction_id text,
  p_approved_by text,
  p_daily_cap integer
)
returns table (
  result_code text,
  resulting_status text,
  current_count integer,
  resulting_day date,
  provider_message_id text,
  provider_url text,
  failure_code text,
  claimed_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_row public.marketing_delivery_ledger%rowtype;
  utc_day date;
  resolved_counter text;
  used_count integer;
begin
  if p_idempotency_key is null
    or char_length(p_idempotency_key) not between 1 and 200
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_run_id is null
    or char_length(p_run_id) not between 1 and 200
    or p_candidate_id is null
    or char_length(p_candidate_id) not between 1 and 300
    or p_content_hash is null
    or p_content_hash !~ '^[0-9a-f]{64}$'
    or p_approved_by is null
    or char_length(pg_catalog.btrim(p_approved_by)) not between 1 and 120
    or p_daily_cap is null
    or p_daily_cap not between 0 and 100
  then
    return query
      select
        'invalid_input'::text,
        null::text,
        null::integer,
        null::date,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  resolved_counter := case
    when p_channel = 'x' and p_action = 'broadcast'
      then 'xPosts'
    when p_channel = 'x' and p_action = 'reply'
      and p_interaction_id ~ '^[0-9]{1,30}$'
      then 'xReplies'
    when p_channel = 'discord' and p_action = 'broadcast'
      then 'discordPosts'
    when p_channel = 'substack'
      and p_action = 'prepare_tutorial'
      then 'substackTutorials'
    else null
  end;

  if resolved_counter is null
    or (
      not (p_channel = 'x' and p_action = 'reply')
      and p_interaction_id is not null
    )
  then
    return query
      select
        'invalid_input'::text,
        null::text,
        null::integer,
        null::date,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  -- Low-volume global admission makes idempotency, interaction uniqueness, and
  -- all five counters one serializable decision without lock-order ambiguity.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-marketing-delivery-global', 0)
  );
  -- Resolve the UTC counter window only after admission is serialized. A
  -- waiter crossing midnight must claim against the day it actually enters.
  utc_day := (
    pg_catalog.clock_timestamp() at time zone 'UTC'
  )::date;

  select ledger.*
  into current_row
  from public.marketing_delivery_ledger as ledger
  where ledger.idempotency_key = p_idempotency_key;

  if found then
    if current_row.run_id = p_run_id
      and current_row.candidate_id = p_candidate_id
      and current_row.content_hash = p_content_hash
      and current_row.channel = p_channel
      and current_row.action = p_action
      and current_row.interaction_id is not distinct from p_interaction_id
      and current_row.approved_by = pg_catalog.btrim(p_approved_by)
    then
      return query
        select
          'already_claimed'::text,
          current_row.status,
          (
            select count(*)::integer
            from public.marketing_delivery_ledger as daily
            where daily.claim_day = current_row.claim_day
              and daily.counter_key = current_row.counter_key
          ),
          current_row.claim_day,
          current_row.provider_message_id,
          current_row.provider_url,
          current_row.failure_code,
          current_row.claimed_at,
          current_row.finalized_at;
    else
      return query
        select
          'idempotency_conflict'::text,
          current_row.status,
          null::integer,
          current_row.claim_day,
          null::text,
          null::text,
          null::text,
          null::timestamptz,
          null::timestamptz;
    end if;
    return;
  end if;

  if p_channel = 'x'
    and p_action = 'reply'
    and exists (
      select 1
      from public.marketing_delivery_ledger as prior_reply
      where prior_reply.channel = 'x'
        and prior_reply.action = 'reply'
        and prior_reply.interaction_id = p_interaction_id
    )
  then
    return query
      select
        'interaction_already_claimed'::text,
        null::text,
        null::integer,
        utc_day,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  select count(*)::integer
  into used_count
  from public.marketing_delivery_ledger as daily
  where daily.claim_day = utc_day
    and daily.counter_key = resolved_counter;

  if used_count >= p_daily_cap then
    return query
      select
        'daily_cap_reached'::text,
        null::text,
        used_count,
        utc_day,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  insert into public.marketing_delivery_ledger (
    idempotency_key,
    run_id,
    candidate_id,
    content_hash,
    channel,
    action,
    counter_key,
    interaction_id,
    approved_by,
    claim_day,
    status
  )
  values (
    p_idempotency_key,
    p_run_id,
    p_candidate_id,
    p_content_hash,
    p_channel,
    p_action,
    resolved_counter,
    p_interaction_id,
    pg_catalog.btrim(p_approved_by),
    utc_day,
    'claimed'
  )
  returning * into current_row;

  return query
    select
      'claimed'::text,
      current_row.status,
      used_count + 1,
      current_row.claim_day,
      current_row.provider_message_id,
      current_row.provider_url,
      current_row.failure_code,
      current_row.claimed_at,
      current_row.finalized_at;
end;
$function$;

revoke all on function private.claim_marketing_delivery(
  text, text, text, text, text, text, text, text, integer
) from public, anon, authenticated, service_role;
grant execute on function private.claim_marketing_delivery(
  text, text, text, text, text, text, text, text, integer
) to service_role;

create or replace function public.claim_marketing_delivery(
  p_idempotency_key text,
  p_run_id text,
  p_candidate_id text,
  p_content_hash text,
  p_channel text,
  p_action text,
  p_interaction_id text,
  p_approved_by text,
  p_daily_cap integer
)
returns table (
  result_code text,
  resulting_status text,
  current_count integer,
  resulting_day date,
  provider_message_id text,
  provider_url text,
  failure_code text,
  claimed_at timestamptz,
  completed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.claim_marketing_delivery(
    p_idempotency_key,
    p_run_id,
    p_candidate_id,
    p_content_hash,
    p_channel,
    p_action,
    p_interaction_id,
    p_approved_by,
    p_daily_cap
  );
$function$;

revoke all on function public.claim_marketing_delivery(
  text, text, text, text, text, text, text, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.claim_marketing_delivery(
  text, text, text, text, text, text, text, text, integer
) to service_role;

create or replace function private.get_marketing_delivery_snapshot(
  p_interaction_ids text[]
)
returns table (
  snapshot_day date,
  x_posts integer,
  x_replies integer,
  discord_posts integer,
  substack_tutorials integer,
  direct_messages integer,
  replied_interaction_ids text[]
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  utc_day date;
begin
  utc_day := (
    pg_catalog.clock_timestamp() at time zone 'UTC'
  )::date;

  if p_interaction_ids is null
    or pg_catalog.cardinality(p_interaction_ids) > 100
    or exists (
      select 1
      from pg_catalog.unnest(p_interaction_ids) as requested(interaction_id)
      where requested.interaction_id !~ '^[0-9]{1,30}$'
    )
  then
    raise exception 'invalid marketing interaction snapshot input';
  end if;

  return query
    select
      utc_day,
      count(*) filter (
        where ledger.claim_day = utc_day
          and ledger.counter_key = 'xPosts'
      )::integer,
      count(*) filter (
        where ledger.claim_day = utc_day
          and ledger.counter_key = 'xReplies'
      )::integer,
      count(*) filter (
        where ledger.claim_day = utc_day
          and ledger.counter_key = 'discordPosts'
      )::integer,
      count(*) filter (
        where ledger.claim_day = utc_day
          and ledger.counter_key = 'substackTutorials'
      )::integer,
      count(*) filter (
        where ledger.claim_day = utc_day
          and ledger.counter_key = 'directMessages'
      )::integer,
      coalesce(
        array_agg(ledger.interaction_id order by ledger.interaction_id)
          filter (
            where ledger.channel = 'x'
              and ledger.action = 'reply'
              and ledger.interaction_id = any(p_interaction_ids)
          ),
        array[]::text[]
      )
    from public.marketing_delivery_ledger as ledger;
end;
$function$;

revoke all on function private.get_marketing_delivery_snapshot(text[])
  from public, anon, authenticated, service_role;
grant execute on function private.get_marketing_delivery_snapshot(text[])
  to service_role;

create or replace function public.get_marketing_delivery_snapshot(
  p_interaction_ids text[] default array[]::text[]
)
returns table (
  snapshot_day date,
  x_posts integer,
  x_replies integer,
  discord_posts integer,
  substack_tutorials integer,
  direct_messages integer,
  replied_interaction_ids text[]
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.get_marketing_delivery_snapshot(p_interaction_ids);
$function$;

revoke all on function public.get_marketing_delivery_snapshot(text[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_delivery_snapshot(text[])
  to service_role;

create or replace function private.complete_marketing_delivery_claim(
  p_idempotency_key text,
  p_channel text,
  p_action text,
  p_status text,
  p_provider_message_id text,
  p_provider_url text,
  p_failure_code text
)
returns table (
  result_code text,
  resulting_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_row public.marketing_delivery_ledger%rowtype;
begin
  if p_idempotency_key is null
    or char_length(p_idempotency_key) not between 1 and 200
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or not coalesce((
      (
        p_status = 'failed'
        and (
          (p_channel = 'x' and p_action in ('broadcast', 'reply'))
          or (p_channel = 'discord' and p_action = 'broadcast')
          or (
            p_channel = 'substack'
            and p_action = 'prepare_tutorial'
          )
        )
        and p_provider_message_id is null
        and p_provider_url is null
        and p_failure_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
      )
      or (
        p_channel = 'x'
        and p_action in ('broadcast', 'reply')
        and p_status = 'published'
        and p_provider_message_id ~ '^[0-9]{1,19}$'
        and p_provider_url =
          'https://x.com/i/web/status/' || p_provider_message_id
        and p_failure_code is null
      )
      or (
        p_channel = 'discord'
        and p_action = 'broadcast'
        and p_status = 'published'
        and p_provider_message_id ~ '^[0-9]{1,30}$'
        and p_provider_url is null
        and p_failure_code is null
      )
      or (
        p_channel = 'substack'
        and p_action = 'prepare_tutorial'
        and p_status = 'requires_human_publish'
        and p_provider_message_id is null
        and p_provider_url =
          'https://defitutorials.substack.com/publish/post'
        and p_failure_code is null
      )
    ), false)
  then
    return query select 'invalid_input'::text, null::text;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-marketing-delivery-global', 0)
  );

  select ledger.*
  into current_row
  from public.marketing_delivery_ledger as ledger
  where ledger.idempotency_key = p_idempotency_key
  for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if current_row.channel <> p_channel
    or current_row.action <> p_action
  then
    return query select 'status_conflict'::text, null::text;
    return;
  end if;

  if current_row.status <> 'claimed' then
    return query
      select
        case
          when current_row.status = p_status
            and current_row.provider_message_id is not distinct from p_provider_message_id
            and current_row.provider_url is not distinct from p_provider_url
            and current_row.failure_code is not distinct from p_failure_code
          then 'already_finalized'::text
          else 'status_conflict'::text
        end,
        current_row.status;
    return;
  end if;

  update public.marketing_delivery_ledger
  set
    status = p_status,
    provider_message_id = p_provider_message_id,
    provider_url = p_provider_url,
    failure_code = p_failure_code,
    finalized_at = pg_catalog.clock_timestamp()
  where idempotency_key = p_idempotency_key;

  return query select 'finalized'::text, p_status;
end;
$function$;

revoke all on function private.complete_marketing_delivery_claim(
  text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.complete_marketing_delivery_claim(
  text, text, text, text, text, text, text
) to service_role;

create or replace function public.complete_marketing_delivery_claim(
  p_idempotency_key text,
  p_channel text,
  p_action text,
  p_status text,
  p_provider_message_id text default null,
  p_provider_url text default null,
  p_failure_code text default null
)
returns table (
  result_code text,
  resulting_status text
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.complete_marketing_delivery_claim(
    p_idempotency_key,
    p_channel,
    p_action,
    p_status,
    p_provider_message_id,
    p_provider_url,
    p_failure_code
  );
$function$;

revoke all on function public.complete_marketing_delivery_claim(
  text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_marketing_delivery_claim(
  text, text, text, text, text, text, text
) to service_role;

-- Vercel Cron delivery is at-least-once. Claim one database-derived weekday
-- slot before starting a workflow so retries and overlapping invocations cannot
-- create two product-update runs for the same UTC date.
create table if not exists public.marketing_schedule_slots (
  schedule_key text not null
    check (schedule_key = 'weekday_product_update'),
  slot_day date not null
    check (extract(isodow from slot_day) between 1 and 5),
  claimed_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (schedule_key, slot_day)
);

alter table public.marketing_schedule_slots enable row level security;
revoke all on table public.marketing_schedule_slots
  from public, anon, authenticated, service_role;

create or replace function private.claim_marketing_schedule_slot_for_day(
  p_slot_day date
)
returns table (
  result_code text,
  schedule_key text,
  slot_day date,
  claimed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  slot_claimed_at timestamptz;
begin
  if p_slot_day is null then
    raise exception 'marketing schedule slot day is required';
  end if;

  if extract(isodow from p_slot_day) not between 1 and 5 then
    return query
      select
        'outside_schedule'::text,
        'weekday_product_update'::text,
        p_slot_day,
        null::timestamptz;
    return;
  end if;

  insert into public.marketing_schedule_slots (
    schedule_key,
    slot_day
  )
  values (
    'weekday_product_update',
    p_slot_day
  )
  on conflict on constraint marketing_schedule_slots_pkey do nothing
  returning marketing_schedule_slots.claimed_at into slot_claimed_at;

  if found then
    return query
      select
        'claimed'::text,
        'weekday_product_update'::text,
        p_slot_day,
        slot_claimed_at;
    return;
  end if;

  select slots.claimed_at
  into slot_claimed_at
  from public.marketing_schedule_slots as slots
  where slots.schedule_key = 'weekday_product_update'
    and slots.slot_day = p_slot_day;

  return query
    select
      'already_claimed'::text,
      'weekday_product_update'::text,
      p_slot_day,
      slot_claimed_at;
end;
$function$;

revoke all on function private.claim_marketing_schedule_slot_for_day(date)
  from public, anon, authenticated, service_role;

create or replace function private.claim_marketing_schedule_slot()
returns table (
  result_code text,
  schedule_key text,
  slot_day date,
  claimed_at timestamptz
)
language sql
security definer
set search_path = ''
as $function$
  select *
  from private.claim_marketing_schedule_slot_for_day(
    (
      pg_catalog.clock_timestamp() at time zone 'UTC'
    )::date
  );
$function$;

revoke all on function private.claim_marketing_schedule_slot()
  from public, anon, authenticated, service_role;
grant execute on function private.claim_marketing_schedule_slot()
  to service_role;

create or replace function public.claim_marketing_schedule_slot()
returns table (
  result_code text,
  schedule_key text,
  slot_day date,
  claimed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.claim_marketing_schedule_slot();
$function$;

revoke all on function public.claim_marketing_schedule_slot()
  from public, anon, authenticated, service_role;
grant execute on function public.claim_marketing_schedule_slot()
  to service_role;
