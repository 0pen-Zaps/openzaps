-- Durable, metadata-only X mention admission for the OpenZaps marketing agent.
--
-- Raw post text, usernames, display names, profile data, URLs, and media are
-- deliberately outside this store. Discovery can persist only X object IDs,
-- the source timestamp, a keyed content HMAC, and bounded classification codes.
-- All access is through service-role-only RPCs; the tables have no Data API
-- grants and every auto-reply claim is terminal even when delivery fails.
-- A narrow service-role-only compliance RPC can erase X-derived identifiers
-- while retaining only aggregate, non-subject compliance evidence.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create or replace function private.marketing_x_random_interaction_reference()
returns text
language sql
volatile
security invoker
set search_path = ''
as $function$
  select '8' || pg_catalog.substr(
    pg_catalog.translate(
      pg_catalog.md5(pg_catalog.gen_random_uuid()::text),
      'abcdef',
      '012345'
    ),
    1,
    29
  );
$function$;

revoke all on function private.marketing_x_random_interaction_reference()
  from public, anon, authenticated, service_role;

create table public.marketing_x_mention_accounts (
  account_id text primary key
    check (account_id ~ '^[1-9][0-9]{0,18}$'),
  initialized_at timestamptz,
  since_id text
    check (since_id is null or since_id ~ '^[1-9][0-9]{0,18}$'),
  continuation_until_id text
    check (
      continuation_until_id is null
      or continuation_until_id ~ '^[1-9][0-9]{0,18}$'
    ),
  continuation_base_since_id text
    check (
      continuation_base_since_id is null
      or continuation_base_since_id ~ '^[1-9][0-9]{0,18}$'
    ),
  continuation_newest_id text
    check (
      continuation_newest_id is null
      or continuation_newest_id ~ '^[1-9][0-9]{0,18}$'
    ),
  continuation_started_at timestamptz,
  poll_lease_token uuid,
  poll_lease_expires_at timestamptz,
  next_poll_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_poll_started_at timestamptz,
  last_poll_finished_at timestamptz,
  last_success_at timestamptz,
  last_defer_reason text
    check (
      last_defer_reason is null
      or last_defer_reason ~ '^[a-z][a-z0-9_:-]{0,63}$'
    ),
  compliance_hold_at timestamptz,
  compliance_hold_reason text
    check (
      compliance_hold_reason is null
      or compliance_hold_reason ~ '^[a-z][a-z0-9_:-]{0,63}$'
    ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (initialized_at is not null or since_id is null),
  check (
    (
      continuation_until_id is null
      and continuation_base_since_id is null
      and continuation_newest_id is null
      and continuation_started_at is null
    )
    or (
      continuation_until_id is not null
      and continuation_newest_id is not null
      and continuation_started_at is not null
      and continuation_base_since_id is not distinct from since_id
    )
  ),
  check (
    (compliance_hold_at is null and compliance_hold_reason is null)
    or (compliance_hold_at is not null and compliance_hold_reason is not null)
  ),
  check (
    (poll_lease_token is null and poll_lease_expires_at is null)
    or (
      poll_lease_token is not null
      and poll_lease_expires_at is not null
      and last_poll_started_at is not null
      and poll_lease_expires_at > last_poll_started_at
    )
  ),
  check (
    last_poll_finished_at is null
    or poll_lease_token is not null
    or (
      last_poll_started_at is not null
      and last_poll_finished_at >= last_poll_started_at
    )
  ),
  check (
    last_success_at is null
    or (
      initialized_at is not null
      and last_poll_finished_at is not null
      and last_success_at <= last_poll_finished_at
    )
  ),
  check (updated_at >= created_at)
);

alter table public.marketing_x_mention_accounts enable row level security;
revoke all on table public.marketing_x_mention_accounts
  from public, anon, authenticated, service_role;

create table public.marketing_x_mentions (
  account_id text not null
    references public.marketing_x_mention_accounts (account_id),
  post_id text not null unique
    check (post_id ~ '^[1-9][0-9]{0,18}$'),
  author_id text not null
    check (author_id ~ '^[1-9][0-9]{0,18}$'),
  conversation_id text not null
    check (conversation_id ~ '^[1-9][0-9]{0,18}$'),
  source_created_at timestamptz not null
    check (
      source_created_at not in (
        '-infinity'::timestamptz,
        'infinity'::timestamptz
      )
    ),
  content_hmac text not null
    check (content_hmac ~ '^[0-9a-f]{64}$'),
  delivery_reference uuid not null unique default pg_catalog.gen_random_uuid(),
  interaction_reference text not null unique
    default private.marketing_x_random_interaction_reference()
    check (interaction_reference ~ '^[1-9][0-9]{29}$'),
  classification text not null
    check (
      classification in ('auto_reply', 'review', 'ignore', 'opt_out')
    ),
  eligibility_reason text not null
    check (eligibility_reason ~ '^[a-z][a-z0-9_:-]{0,63}$'),
  state text not null
    check (
      state in (
        'baseline',
        'eligible',
        'review_required',
        'ignored',
        'opted_out',
        'claimed',
        'replied',
        'failed'
      )
    ),
  reply_claim_token uuid,
  reply_claim_day date,
  discovered_at timestamptz not null default pg_catalog.clock_timestamp(),
  state_changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  claimed_at timestamptz,
  replied_at timestamptz,
  failed_at timestamptz,
  failure_code text
    check (
      failure_code is null
      or failure_code ~ '^[a-z][a-z0-9_:-]{0,63}$'
    ),
  primary key (account_id, post_id),
  check (
    (classification = 'auto_reply' and state in (
      'baseline', 'eligible', 'opted_out', 'claimed', 'replied', 'failed'
    ))
    or (classification = 'review' and state in (
      'baseline', 'review_required', 'opted_out'
    ))
    or (classification = 'ignore' and state in ('baseline', 'ignored'))
    or (classification = 'opt_out' and state = 'opted_out')
  ),
  check (
    (
      state in (
        'baseline', 'eligible', 'review_required', 'ignored', 'opted_out'
      )
      and reply_claim_token is null
      and reply_claim_day is null
      and claimed_at is null
      and replied_at is null
      and failed_at is null
      and failure_code is null
    )
    or (
      state = 'claimed'
      and reply_claim_token is not null
      and reply_claim_day is not null
      and claimed_at is not null
      and replied_at is null
      and failed_at is null
      and failure_code is null
    )
    or (
      state = 'replied'
      and reply_claim_token is not null
      and reply_claim_day is not null
      and claimed_at is not null
      and replied_at is not null
      and replied_at >= claimed_at
      and failed_at is null
      and failure_code is null
    )
    or (
      state = 'failed'
      and reply_claim_token is not null
      and reply_claim_day is not null
      and claimed_at is not null
      and replied_at is null
      and failed_at is not null
      and failed_at >= claimed_at
      and failure_code is not null
    )
  ),
  check (state_changed_at >= discovered_at)
);

create unique index marketing_x_mentions_one_author_reply_per_day
  on public.marketing_x_mentions (account_id, author_id, reply_claim_day)
  where reply_claim_day is not null;

create unique index marketing_x_mentions_one_conversation_reply_per_day
  on public.marketing_x_mentions (
    account_id,
    conversation_id,
    reply_claim_day
  )
  where reply_claim_day is not null;

create index marketing_x_mentions_claim_order
  on public.marketing_x_mentions (
    account_id,
    state,
    source_created_at,
    post_id
  );

alter table public.marketing_x_mentions enable row level security;
revoke all on table public.marketing_x_mentions
  from public, anon, authenticated, service_role;

create table public.marketing_x_mention_opt_outs (
  account_id text not null
    references public.marketing_x_mention_accounts (account_id),
  author_id text not null
    check (author_id ~ '^[1-9][0-9]{0,18}$'),
  source_post_id text
    check (source_post_id is null or source_post_id ~ '^[1-9][0-9]{0,18}$'),
  opted_out_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (account_id, author_id),
  unique (account_id, source_post_id)
);

alter table public.marketing_x_mention_opt_outs enable row level security;
revoke all on table public.marketing_x_mention_opt_outs
  from public, anon, authenticated, service_role;

create table public.marketing_x_compliance_events (
  event_id bigint generated always as identity primary key,
  account_id text not null
    references public.marketing_x_mention_accounts (account_id),
  erase_scope text not null check (erase_scope in ('post', 'author')),
  reason_code text not null
    check (reason_code ~ '^[a-z][a-z0-9_:-]{0,63}$'),
  deleted_mention_count integer not null
    check (deleted_mention_count >= 0),
  deleted_opt_out_count integer not null
    check (deleted_opt_out_count >= 0),
  redacted_delivery_count integer not null
    check (redacted_delivery_count >= 0),
  processed_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.marketing_x_compliance_events enable row level security;
revoke all on table public.marketing_x_compliance_events
  from public, anon, authenticated, service_role;

create or replace function private.marketing_x_id_precedes(
  p_left text,
  p_right text
)
returns boolean
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  select
    char_length(p_left) < char_length(p_right)
    or (
      char_length(p_left) = char_length(p_right)
      and p_left < p_right collate "C"
    );
$function$;

revoke all on function private.marketing_x_id_precedes(text, text)
  from public, anon, authenticated, service_role;

create or replace function private.enforce_marketing_x_account_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if pg_catalog.current_setting(
    'openzaps.marketing_x_compliance_erase',
    true
  ) = 'true' then
    return new;
  end if;
  if new.account_id <> old.account_id
    or new.created_at <> old.created_at
    or (
      old.initialized_at is not null
      and new.initialized_at is distinct from old.initialized_at
    )
    or (
      old.initialized_at is null
      and new.initialized_at is not null
      and new.last_success_at is distinct from new.initialized_at
    )
    or (
      old.since_id is not null
      and (
        new.since_id is null
        or private.marketing_x_id_precedes(new.since_id, old.since_id)
      )
    )
    or (
      old.last_poll_started_at is not null
      and new.last_poll_started_at < old.last_poll_started_at
    )
    or (
      old.last_poll_finished_at is not null
      and new.last_poll_finished_at < old.last_poll_finished_at
    )
    or (
      old.last_success_at is not null
      and new.last_success_at < old.last_success_at
    )
    or new.updated_at < old.updated_at
  then
    raise exception 'invalid marketing X mention account transition';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_marketing_x_account_update()
  from public, anon, authenticated, service_role;

create trigger marketing_x_mention_accounts_guard
before update
on public.marketing_x_mention_accounts
for each row
execute function private.enforce_marketing_x_account_update();

create or replace function private.enforce_marketing_x_mention_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.account_id <> old.account_id
    or new.post_id <> old.post_id
    or new.author_id <> old.author_id
    or new.conversation_id <> old.conversation_id
    or new.source_created_at <> old.source_created_at
    or new.content_hmac <> old.content_hmac
    or new.delivery_reference <> old.delivery_reference
    or new.interaction_reference <> old.interaction_reference
    or new.classification <> old.classification
    or new.eligibility_reason <> old.eligibility_reason
    or new.discovered_at <> old.discovered_at
  then
    raise exception 'marketing X mention identity is immutable';
  end if;

  if new.state <> old.state
    and not (
      (old.state = 'eligible' and new.state in ('claimed', 'opted_out'))
      or (old.state = 'review_required' and new.state = 'opted_out')
      or (old.state = 'claimed' and new.state in ('replied', 'failed'))
    )
  then
    raise exception 'invalid marketing X mention state transition';
  end if;

  if new.state = old.state and new.state_changed_at <> old.state_changed_at then
    raise exception 'marketing X mention state timestamp changed without a transition';
  end if;

  if new.state <> old.state and new.state_changed_at <= old.state_changed_at then
    raise exception 'marketing X mention state timestamp must advance';
  end if;

  if old.reply_claim_token is not null
    and new.reply_claim_token is distinct from old.reply_claim_token
  then
    raise exception 'marketing X mention claim token is immutable';
  end if;

  if old.reply_claim_day is not null
    and new.reply_claim_day is distinct from old.reply_claim_day
  then
    raise exception 'marketing X mention claim day is immutable';
  end if;

  if old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at
    or old.replied_at is not null and new.replied_at is distinct from old.replied_at
    or old.failed_at is not null and new.failed_at is distinct from old.failed_at
    or old.failure_code is not null and new.failure_code is distinct from old.failure_code
  then
    raise exception 'marketing X mention terminal evidence is immutable';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_marketing_x_mention_update()
  from public, anon, authenticated, service_role;

create trigger marketing_x_mentions_guard
before update
on public.marketing_x_mentions
for each row
execute function private.enforce_marketing_x_mention_update();

create or replace function private.reject_marketing_x_mention_deletion()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE'
    and pg_catalog.current_setting(
      'openzaps.marketing_x_compliance_erase',
      true
    ) = 'true'
  then
    return null;
  end if;
  raise exception 'marketing X mention evidence is append-only';
end;
$function$;

revoke all on function private.reject_marketing_x_mention_deletion()
  from public, anon, authenticated, service_role;

create trigger marketing_x_mention_accounts_append_only
before delete or truncate
on public.marketing_x_mention_accounts
for each statement
execute function private.reject_marketing_x_mention_deletion();

create trigger marketing_x_mentions_append_only
before delete or truncate
on public.marketing_x_mentions
for each statement
execute function private.reject_marketing_x_mention_deletion();

create trigger marketing_x_mention_opt_outs_append_only
before delete or truncate
on public.marketing_x_mention_opt_outs
for each statement
execute function private.reject_marketing_x_mention_deletion();

create trigger marketing_x_compliance_events_append_only
before delete or truncate
on public.marketing_x_compliance_events
for each statement
execute function private.reject_marketing_x_mention_deletion();

create or replace function private.erase_marketing_x_compliance_data(
  p_account_id text,
  p_post_id text,
  p_author_id text,
  p_reason text
)
returns table (
  result_code text,
  account_id text,
  erase_scope text,
  deleted_mention_count integer,
  deleted_opt_out_count integer,
  redacted_delivery_count integer,
  processed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  erased_mentions integer := 0;
  erased_opt_outs integer := 0;
  redacted_deliveries integer := 0;
  erased_at timestamptz := pg_catalog.clock_timestamp();
  requested_scope text;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_reason is null
    or p_reason !~ '^[a-z][a-z0-9_:-]{0,63}$'
    or ((p_post_id is null)::integer + (p_author_id is null)::integer) <> 1
    or (p_post_id is not null and p_post_id !~ '^[1-9][0-9]{0,18}$')
    or (p_author_id is not null and p_author_id !~ '^[1-9][0-9]{0,18}$')
  then
    raise exception 'invalid marketing X compliance erasure request';
  end if;

  requested_scope := case when p_post_id is not null then 'post' else 'author' end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-poll:' || p_account_id,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-reply:' || p_account_id,
      0
    )
  );

  if not exists (
    select 1
    from public.marketing_x_mention_accounts as accounts
    where accounts.account_id = p_account_id
  ) then
    return query select
      'account_not_found'::text,
      p_account_id,
      requested_scope,
      0,
      0,
      0,
      null::timestamptz;
    return;
  end if;

  perform pg_catalog.set_config(
    'openzaps.marketing_x_compliance_erase',
    'true',
    true
  );

  update public.marketing_x_mention_accounts as accounts
  set
    compliance_hold_at = erased_at,
    compliance_hold_reason = p_reason,
    poll_lease_token = null,
    poll_lease_expires_at = null,
    next_poll_at = erased_at,
    last_defer_reason = 'compliance_hold',
    updated_at = greatest(erased_at, accounts.updated_at)
  where accounts.account_id = p_account_id;

  if requested_scope = 'author' then
    update public.marketing_delivery_ledger as ledger
    set interaction_id = mentions.interaction_reference
    from public.marketing_x_mentions as mentions
    where ledger.channel = 'x'
      and ledger.action = 'reply'
      and ledger.interaction_id = mentions.post_id
      and mentions.account_id = p_account_id
      and mentions.author_id = p_author_id;
    get diagnostics redacted_deliveries = row_count;

    update public.marketing_x_mention_accounts as accounts
    set
      initialized_at = null,
      since_id = null,
      continuation_until_id = null,
      continuation_base_since_id = null,
      continuation_newest_id = null,
      continuation_started_at = null,
      poll_lease_token = null,
      poll_lease_expires_at = null,
      next_poll_at = erased_at,
      last_success_at = null,
      last_defer_reason = 'compliance_rebaseline',
      updated_at = greatest(erased_at, accounts.updated_at)
    where accounts.account_id = p_account_id
      and exists (
        select 1
        from public.marketing_x_mentions as mentions
        where mentions.account_id = p_account_id
          and mentions.author_id = p_author_id
          and mentions.post_id in (
            accounts.since_id,
            accounts.continuation_until_id,
            accounts.continuation_base_since_id,
            accounts.continuation_newest_id
          )
      );

    delete from public.marketing_x_mention_opt_outs as opt_outs
    where opt_outs.account_id = p_account_id
      and opt_outs.author_id = p_author_id;
    get diagnostics erased_opt_outs = row_count;

    delete from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
      and mentions.author_id = p_author_id;
    get diagnostics erased_mentions = row_count;
  else
    update public.marketing_delivery_ledger as ledger
    set interaction_id = mentions.interaction_reference
    from public.marketing_x_mentions as mentions
    where ledger.channel = 'x'
      and ledger.action = 'reply'
      and ledger.interaction_id = p_post_id
      and mentions.account_id = p_account_id
      and mentions.post_id = p_post_id;
    get diagnostics redacted_deliveries = row_count;

    update public.marketing_x_mention_accounts as accounts
    set
      initialized_at = null,
      since_id = null,
      continuation_until_id = null,
      continuation_base_since_id = null,
      continuation_newest_id = null,
      continuation_started_at = null,
      poll_lease_token = null,
      poll_lease_expires_at = null,
      next_poll_at = erased_at,
      last_success_at = null,
      last_defer_reason = 'compliance_rebaseline',
      updated_at = greatest(erased_at, accounts.updated_at)
    where accounts.account_id = p_account_id
      and p_post_id in (
        accounts.since_id,
        accounts.continuation_until_id,
        accounts.continuation_base_since_id,
        accounts.continuation_newest_id
      );

    update public.marketing_x_mention_opt_outs as opt_outs
    set source_post_id = null
    where opt_outs.account_id = p_account_id
      and opt_outs.source_post_id = p_post_id;

    delete from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
      and mentions.post_id = p_post_id;
    get diagnostics erased_mentions = row_count;
  end if;

  erased_at := pg_catalog.clock_timestamp();
  insert into public.marketing_x_compliance_events (
    account_id,
    erase_scope,
    reason_code,
    deleted_mention_count,
    deleted_opt_out_count,
    redacted_delivery_count,
    processed_at
  ) values (
    p_account_id,
    requested_scope,
    p_reason,
    erased_mentions,
    erased_opt_outs,
    redacted_deliveries,
    erased_at
  );

  return query select
    'erased'::text,
    p_account_id,
    requested_scope,
    erased_mentions,
    erased_opt_outs,
    redacted_deliveries,
    erased_at;
end;
$function$;

revoke all on function private.erase_marketing_x_compliance_data(
  text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.erase_marketing_x_compliance_data(
  text, text, text, text
) to service_role;

create or replace function public.erase_marketing_x_compliance_data(
  p_account_id text,
  p_post_id text,
  p_author_id text,
  p_reason text
)
returns table (
  result_code text,
  account_id text,
  erase_scope text,
  deleted_mention_count integer,
  deleted_opt_out_count integer,
  redacted_delivery_count integer,
  processed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.erase_marketing_x_compliance_data(
    p_account_id,
    p_post_id,
    p_author_id,
    p_reason
  );
$function$;

revoke all on function public.erase_marketing_x_compliance_data(
  text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.erase_marketing_x_compliance_data(
  text, text, text, text
) to service_role;

create or replace function private.clear_marketing_x_compliance_hold(
  p_account_id text,
  p_verification_code text
)
returns table (
  result_code text,
  account_id text,
  cleared_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_account public.marketing_x_mention_accounts%rowtype;
  cleared_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_verification_code <> 'official_source_absence_verified'
  then
    raise exception 'invalid marketing X compliance hold clearance';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-poll:' || p_account_id,
      0
    )
  );

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  if not found then
    return query select 'account_not_found'::text, p_account_id, null::timestamptz;
    return;
  end if;
  if current_account.compliance_hold_at is null then
    return query select 'already_clear'::text, p_account_id, null::timestamptz;
    return;
  end if;

  cleared_at := greatest(cleared_at, current_account.updated_at);
  update public.marketing_x_mention_accounts as accounts
  set
    compliance_hold_at = null,
    compliance_hold_reason = null,
    next_poll_at = cleared_at,
    last_defer_reason = 'compliance_hold_cleared',
    updated_at = cleared_at
  where accounts.account_id = p_account_id;

  return query select 'cleared'::text, p_account_id, cleared_at;
end;
$function$;

revoke all on function private.clear_marketing_x_compliance_hold(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.clear_marketing_x_compliance_hold(text, text)
  to service_role;

create or replace function public.clear_marketing_x_compliance_hold(
  p_account_id text,
  p_verification_code text
)
returns table (
  result_code text,
  account_id text,
  cleared_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.clear_marketing_x_compliance_hold(
    p_account_id,
    p_verification_code
  );
$function$;

revoke all on function public.clear_marketing_x_compliance_hold(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.clear_marketing_x_compliance_hold(text, text)
  to service_role;

create or replace function private.get_marketing_x_interaction_reference(
  p_account_id text,
  p_post_id text
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  interaction_reference text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  stored_reference text;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_post_id is null
    or p_post_id !~ '^[1-9][0-9]{0,18}$'
  then
    raise exception 'invalid marketing X interaction reference request';
  end if;

  select mentions.interaction_reference
  into stored_reference
  from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and mentions.post_id = p_post_id;

  return query select
    case when found then 'found'::text else 'not_found'::text end,
    p_account_id,
    p_post_id,
    stored_reference;
end;
$function$;

revoke all on function private.get_marketing_x_interaction_reference(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.get_marketing_x_interaction_reference(text, text)
  to service_role;

create or replace function public.get_marketing_x_interaction_reference(
  p_account_id text,
  p_post_id text
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  interaction_reference text
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.get_marketing_x_interaction_reference(
    p_account_id,
    p_post_id
  );
$function$;

revoke all on function public.get_marketing_x_interaction_reference(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_x_interaction_reference(text, text)
  to service_role;

create or replace function private.claim_marketing_x_mention_poll(
  p_account_id text
)
returns table (
  result_code text,
  account_id text,
  lease_token uuid,
  since_id text,
  continuation_until_id text,
  continuation_base_since_id text,
  continuation_newest_id text,
  baseline_required boolean,
  lease_expires_at timestamptz,
  next_poll_at timestamptz,
  last_success_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_account public.marketing_x_mention_accounts%rowtype;
  claimed_at timestamptz := pg_catalog.clock_timestamp();
  new_token uuid;
begin
  if p_account_id is null or p_account_id !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid marketing X account id';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-poll:' || p_account_id,
      0
    )
  );

  insert into public.marketing_x_mention_accounts (
    account_id,
    next_poll_at,
    created_at,
    updated_at
  )
  values (p_account_id, claimed_at, claimed_at, claimed_at)
  on conflict on constraint marketing_x_mention_accounts_pkey do nothing;

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  claimed_at := pg_catalog.clock_timestamp();
  claimed_at := greatest(claimed_at, current_account.updated_at);

  if current_account.compliance_hold_at is not null then
    return query select
      'compliance_hold'::text,
      current_account.account_id,
      null::uuid,
      current_account.since_id,
      current_account.continuation_until_id,
      current_account.continuation_base_since_id,
      current_account.continuation_newest_id,
      current_account.initialized_at is null,
      null::timestamptz,
      current_account.next_poll_at,
      current_account.last_success_at;
    return;
  end if;

  if current_account.poll_lease_token is not null
    and current_account.poll_lease_expires_at > claimed_at
  then
    return query select
      'leased'::text,
      current_account.account_id,
      null::uuid,
      current_account.since_id,
      current_account.continuation_until_id,
      current_account.continuation_base_since_id,
      current_account.continuation_newest_id,
      current_account.initialized_at is null,
      current_account.poll_lease_expires_at,
      current_account.next_poll_at,
      current_account.last_success_at;
    return;
  end if;

  if current_account.next_poll_at > claimed_at then
    return query select
      'not_due'::text,
      current_account.account_id,
      null::uuid,
      current_account.since_id,
      current_account.continuation_until_id,
      current_account.continuation_base_since_id,
      current_account.continuation_newest_id,
      current_account.initialized_at is null,
      null::timestamptz,
      current_account.next_poll_at,
      current_account.last_success_at;
    return;
  end if;

  new_token := pg_catalog.gen_random_uuid();
  update public.marketing_x_mention_accounts as accounts
  set
    poll_lease_token = new_token,
    poll_lease_expires_at = claimed_at + interval '5 minutes',
    last_poll_started_at = claimed_at,
    updated_at = claimed_at
  where accounts.account_id = p_account_id
  returning accounts.* into current_account;

  return query select
    'claimed'::text,
    current_account.account_id,
    current_account.poll_lease_token,
    current_account.since_id,
    current_account.continuation_until_id,
    current_account.continuation_base_since_id,
    current_account.continuation_newest_id,
    current_account.initialized_at is null,
    current_account.poll_lease_expires_at,
    current_account.next_poll_at,
    current_account.last_success_at;
end;
$function$;

revoke all on function private.claim_marketing_x_mention_poll(text)
  from public, anon, authenticated, service_role;
grant execute on function private.claim_marketing_x_mention_poll(text)
  to service_role;

create or replace function public.claim_marketing_x_mention_poll(
  p_account_id text
)
returns table (
  result_code text,
  account_id text,
  lease_token uuid,
  since_id text,
  continuation_until_id text,
  continuation_base_since_id text,
  continuation_newest_id text,
  baseline_required boolean,
  lease_expires_at timestamptz,
  next_poll_at timestamptz,
  last_success_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.claim_marketing_x_mention_poll(p_account_id);
$function$;

revoke all on function public.claim_marketing_x_mention_poll(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_marketing_x_mention_poll(text)
  to service_role;

create or replace function private.commit_marketing_x_mention_discovery(
  p_account_id text,
  p_lease_token uuid,
  p_previous_since_id text,
  p_next_since_id text,
  p_previous_continuation_until_id text,
  p_next_continuation_until_id text,
  p_completed boolean,
  p_mentions jsonb
)
returns table (
  result_code text,
  account_id text,
  inserted_count integer,
  existing_count integer,
  opt_out_count integer,
  resulting_since_id text,
  continuation_until_id text,
  continuation_newest_id text,
  initialized_at timestamptz,
  next_poll_at timestamptz,
  last_success_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_account public.marketing_x_mention_accounts%rowtype;
  finished_at timestamptz := pg_catalog.clock_timestamp();
  item_count integer;
  inserted_rows integer := 0;
  existing_rows integer := 0;
  opted_out_rows integer := 0;
  was_baseline boolean;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_lease_token is null
    or p_completed is null
    or p_mentions is null
    or pg_catalog.jsonb_typeof(p_mentions) <> 'array'
    or (
      p_previous_since_id is not null
      and p_previous_since_id !~ '^[1-9][0-9]{0,18}$'
    )
    or (
      p_next_since_id is not null
      and p_next_since_id !~ '^[1-9][0-9]{0,18}$'
    )
    or (
      p_previous_continuation_until_id is not null
      and p_previous_continuation_until_id !~ '^[1-9][0-9]{0,18}$'
    )
    or (
      p_next_continuation_until_id is not null
      and p_next_continuation_until_id !~ '^[1-9][0-9]{0,18}$'
    )
  then
    raise exception 'invalid marketing X mention discovery';
  end if;

  item_count := pg_catalog.jsonb_array_length(p_mentions);
  if item_count not between 0 and 500 then
    raise exception 'invalid marketing X mention discovery size';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_mentions) as entries(item)
    where pg_catalog.jsonb_typeof(entries.item) <> 'object'
      or not (entries.item ?& array[
        'post_id',
        'author_id',
        'conversation_id',
        'created_at',
        'content_hmac',
        'classification',
        'eligibility_reason'
      ])
      or (
        select count(*)
        from pg_catalog.jsonb_object_keys(entries.item)
      ) <> 7
      or pg_catalog.jsonb_typeof(entries.item -> 'post_id') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'author_id') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'conversation_id') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'created_at') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'content_hmac') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'classification') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'eligibility_reason') <> 'string'
  ) then
    raise exception 'invalid marketing X mention shape';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_mentions) as mention(
      post_id text,
      author_id text,
      conversation_id text,
      created_at timestamptz,
      content_hmac text,
      classification text,
      eligibility_reason text
    )
    where mention.post_id !~ '^[1-9][0-9]{0,18}$'
      or mention.author_id !~ '^[1-9][0-9]{0,18}$'
      or mention.conversation_id !~ '^[1-9][0-9]{0,18}$'
      or mention.created_at is null
      or mention.created_at in (
        '-infinity'::timestamptz,
        'infinity'::timestamptz
      )
      or mention.created_at > finished_at + interval '5 minutes'
      or mention.content_hmac !~ '^[0-9a-f]{64}$'
      or mention.classification not in (
        'auto_reply', 'review', 'ignore', 'opt_out'
      )
      or mention.eligibility_reason !~ '^[a-z][a-z0-9_:-]{0,63}$'
  ) then
    raise exception 'invalid marketing X mention metadata';
  end if;

  if (
    select count(*)
    from pg_catalog.jsonb_to_recordset(p_mentions) as mention(post_id text)
  ) <> (
    select count(distinct mention.post_id)
    from pg_catalog.jsonb_to_recordset(p_mentions) as mention(post_id text)
  ) then
    raise exception 'duplicate marketing X mention post id';
  end if;

  if p_completed
    and item_count > 0
    and p_next_since_id is null
  then
    raise exception 'completed marketing X mention page requires a cursor';
  end if;

  if (p_completed and p_next_continuation_until_id is not null)
    or (
      not p_completed
      and (
        p_next_continuation_until_id is null
        or p_next_since_id is null
      )
    )
  then
    raise exception 'invalid marketing X mention continuation';
  end if;

  if p_previous_since_id is not null
    and p_next_since_id is not null
    and private.marketing_x_id_precedes(
      p_next_since_id,
      p_previous_since_id
    )
  then
    raise exception 'marketing X mention cursor cannot move backwards';
  end if;

  if p_next_continuation_until_id is not null
    and (
      p_next_since_id is null
      or private.marketing_x_id_precedes(
        p_next_since_id,
        p_next_continuation_until_id
      )
      or (
        p_previous_since_id is not null
        and not private.marketing_x_id_precedes(
          p_previous_since_id,
          p_next_continuation_until_id
        )
      )
    )
  then
    raise exception 'invalid marketing X mention continuation boundary';
  end if;

  if p_completed
    and p_next_since_id is not null
    and exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_mentions) as mention(post_id text)
      where private.marketing_x_id_precedes(
        p_next_since_id,
        mention.post_id
      )
    )
  then
    raise exception 'marketing X mention cursor does not cover the page';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-poll:' || p_account_id,
      0
    )
  );

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  finished_at := pg_catalog.clock_timestamp();
  if not found
    or current_account.poll_lease_token is distinct from p_lease_token
    or current_account.poll_lease_expires_at <= finished_at
  then
    return query select
      'lease_lost'::text,
      p_account_id,
      0,
      0,
      0,
      current_account.since_id,
      current_account.continuation_until_id,
      current_account.continuation_newest_id,
      current_account.initialized_at,
      current_account.next_poll_at,
      current_account.last_success_at;
    return;
  end if;

  if current_account.since_id is distinct from p_previous_since_id then
    return query select
      'cursor_conflict'::text,
      current_account.account_id,
      0,
      0,
      0,
      current_account.since_id,
      current_account.continuation_until_id,
      current_account.continuation_newest_id,
      current_account.initialized_at,
      current_account.next_poll_at,
      current_account.last_success_at;
    return;
  end if;

  if current_account.continuation_until_id is distinct from p_previous_continuation_until_id
    or (
      current_account.continuation_until_id is not null
      and (
        current_account.continuation_base_since_id is distinct from p_previous_since_id
        or current_account.continuation_newest_id is distinct from p_next_since_id
      )
    )
  then
    return query select
      'cursor_conflict'::text,
      current_account.account_id,
      0,
      0,
      0,
      current_account.since_id,
      current_account.continuation_until_id,
      current_account.continuation_newest_id,
      current_account.initialized_at,
      current_account.next_poll_at,
      current_account.last_success_at;
    return;
  end if;

  if not p_completed
    and current_account.continuation_until_id is not null
    and not private.marketing_x_id_precedes(
      p_next_continuation_until_id,
      current_account.continuation_until_id
    )
  then
    raise exception 'marketing X mention continuation did not advance';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_mentions) as incoming(
      post_id text,
      author_id text,
      conversation_id text,
      created_at timestamptz,
      content_hmac text,
      classification text,
      eligibility_reason text
    )
    join public.marketing_x_mentions as stored
      on stored.post_id = incoming.post_id
    where stored.account_id <> p_account_id
      or stored.author_id <> incoming.author_id
      or stored.conversation_id <> incoming.conversation_id
      or stored.source_created_at <> incoming.created_at
      or stored.content_hmac <> incoming.content_hmac
      or stored.classification <> incoming.classification
      or stored.eligibility_reason <> incoming.eligibility_reason
  ) then
    raise exception 'marketing X mention identity conflict';
  end if;

  was_baseline := current_account.initialized_at is null;

  select count(*)::integer
  into existing_rows
  from pg_catalog.jsonb_to_recordset(p_mentions) as incoming(post_id text)
  join public.marketing_x_mentions as stored
    on stored.post_id = incoming.post_id;

  insert into public.marketing_x_mentions (
    account_id,
    post_id,
    author_id,
    conversation_id,
    source_created_at,
    content_hmac,
    classification,
    eligibility_reason,
    state,
    discovered_at,
    state_changed_at
  )
  select
    p_account_id,
    incoming.post_id,
    incoming.author_id,
    incoming.conversation_id,
    incoming.created_at,
    incoming.content_hmac,
    incoming.classification,
    incoming.eligibility_reason,
    case
      when incoming.classification = 'opt_out' then 'opted_out'
      when was_baseline then 'baseline'
      when incoming.classification = 'auto_reply' then 'eligible'
      when incoming.classification = 'review' then 'review_required'
      else 'ignored'
    end,
    finished_at,
    finished_at
  from pg_catalog.jsonb_to_recordset(p_mentions) as incoming(
    post_id text,
    author_id text,
    conversation_id text,
    created_at timestamptz,
    content_hmac text,
    classification text,
    eligibility_reason text
  )
  on conflict (post_id) do nothing;

  get diagnostics inserted_rows = row_count;

  insert into public.marketing_x_mention_opt_outs (
    account_id,
    author_id,
    source_post_id,
    opted_out_at
  )
  select
    p_account_id,
    incoming.author_id,
    min(incoming.post_id),
    finished_at
  from pg_catalog.jsonb_to_recordset(p_mentions) as incoming(
    post_id text,
    author_id text,
    classification text
  )
  where incoming.classification = 'opt_out'
  group by incoming.author_id
  on conflict on constraint marketing_x_mention_opt_outs_pkey do nothing;

  get diagnostics opted_out_rows = row_count;

  update public.marketing_x_mentions as mentions
  set
    state = 'opted_out',
    state_changed_at = greatest(
      finished_at,
      mentions.state_changed_at + interval '1 microsecond'
    )
  where mentions.account_id = p_account_id
    and mentions.state in ('eligible', 'review_required')
    and exists (
      select 1
      from public.marketing_x_mention_opt_outs as opt_outs
      where opt_outs.account_id = mentions.account_id
        and opt_outs.author_id = mentions.author_id
    );

  finished_at := greatest(
    finished_at,
    current_account.updated_at + interval '1 microsecond'
  );

  if p_completed and was_baseline and p_next_since_id is null then
    update public.marketing_x_mention_accounts as accounts
    set
      initialized_at = finished_at,
      continuation_until_id = null,
      continuation_base_since_id = null,
      continuation_newest_id = null,
      continuation_started_at = null,
      poll_lease_token = null,
      poll_lease_expires_at = null,
      next_poll_at = finished_at + interval '1 minute',
      last_poll_finished_at = finished_at,
      last_success_at = finished_at,
      updated_at = finished_at
    where accounts.account_id = p_account_id
    returning accounts.* into current_account;
  elsif p_completed then
    update public.marketing_x_mention_accounts as accounts
    set
      initialized_at = coalesce(accounts.initialized_at, finished_at),
      since_id = coalesce(p_next_since_id, accounts.since_id),
      continuation_until_id = null,
      continuation_base_since_id = null,
      continuation_newest_id = null,
      continuation_started_at = null,
      poll_lease_token = null,
      poll_lease_expires_at = null,
      next_poll_at = finished_at + interval '1 minute',
      last_poll_finished_at = finished_at,
      last_success_at = finished_at,
      updated_at = finished_at
    where accounts.account_id = p_account_id
    returning accounts.* into current_account;
  else
    update public.marketing_x_mention_accounts as accounts
    set
      continuation_until_id = p_next_continuation_until_id,
      continuation_base_since_id = case
        when accounts.continuation_until_id is null then p_previous_since_id
        else accounts.continuation_base_since_id
      end,
      continuation_newest_id = coalesce(
        accounts.continuation_newest_id,
        p_next_since_id
      ),
      continuation_started_at = coalesce(
        accounts.continuation_started_at,
        finished_at
      ),
      poll_lease_token = null,
      poll_lease_expires_at = null,
      next_poll_at = finished_at + interval '15 seconds',
      last_poll_finished_at = finished_at,
      updated_at = finished_at
    where accounts.account_id = p_account_id
    returning accounts.* into current_account;
  end if;

  return query select
    case
      when p_completed and was_baseline and p_next_since_id is null
        then 'baseline_empty'::text
      when p_completed then 'committed'::text
      else 'partial_committed'::text
    end,
    current_account.account_id,
    inserted_rows,
    existing_rows,
    opted_out_rows,
    current_account.since_id,
    current_account.continuation_until_id,
    current_account.continuation_newest_id,
    current_account.initialized_at,
    current_account.next_poll_at,
    current_account.last_success_at;
end;
$function$;

revoke all on function private.commit_marketing_x_mention_discovery(
  text, uuid, text, text, text, text, boolean, jsonb
) from public, anon, authenticated, service_role;
grant execute on function private.commit_marketing_x_mention_discovery(
  text, uuid, text, text, text, text, boolean, jsonb
) to service_role;

create or replace function public.commit_marketing_x_mention_discovery(
  p_account_id text,
  p_lease_token uuid,
  p_previous_since_id text,
  p_next_since_id text,
  p_previous_continuation_until_id text,
  p_next_continuation_until_id text,
  p_completed boolean,
  p_mentions jsonb
)
returns table (
  result_code text,
  account_id text,
  inserted_count integer,
  existing_count integer,
  opt_out_count integer,
  resulting_since_id text,
  continuation_until_id text,
  continuation_newest_id text,
  initialized_at timestamptz,
  next_poll_at timestamptz,
  last_success_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.commit_marketing_x_mention_discovery(
    p_account_id,
    p_lease_token,
    p_previous_since_id,
    p_next_since_id,
    p_previous_continuation_until_id,
    p_next_continuation_until_id,
    p_completed,
    p_mentions
  );
$function$;

revoke all on function public.commit_marketing_x_mention_discovery(
  text, uuid, text, text, text, text, boolean, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_marketing_x_mention_discovery(
  text, uuid, text, text, text, text, boolean, jsonb
) to service_role;

create or replace function private.defer_marketing_x_mention_poll(
  p_account_id text,
  p_lease_token uuid,
  p_next_poll_at timestamptz,
  p_reason text
)
returns table (
  result_code text,
  account_id text,
  next_poll_at timestamptz,
  last_success_at timestamptz,
  defer_reason text,
  deferred_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_account public.marketing_x_mention_accounts%rowtype;
  defer_time timestamptz := pg_catalog.clock_timestamp();
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_lease_token is null
    or p_next_poll_at is null
    or p_next_poll_at in (
      '-infinity'::timestamptz,
      'infinity'::timestamptz
    )
    or p_reason is null
    or p_reason !~ '^[a-z][a-z0-9_:-]{0,63}$'
    or p_next_poll_at < defer_time + interval '15 seconds'
    or p_next_poll_at > defer_time + interval '1 day'
  then
    raise exception 'invalid marketing X mention poll deferral';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-poll:' || p_account_id,
      0
    )
  );

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  defer_time := pg_catalog.clock_timestamp();
  if not found
    or current_account.poll_lease_token is distinct from p_lease_token
    or current_account.poll_lease_expires_at <= defer_time
  then
    return query select
      'lease_lost'::text,
      p_account_id,
      current_account.next_poll_at,
      current_account.last_success_at,
      current_account.last_defer_reason,
      null::timestamptz;
    return;
  end if;

  defer_time := greatest(
    defer_time,
    current_account.updated_at + interval '1 microsecond'
  );

  update public.marketing_x_mention_accounts as accounts
  set
    poll_lease_token = null,
    poll_lease_expires_at = null,
    next_poll_at = greatest(p_next_poll_at, defer_time + interval '15 seconds'),
    last_poll_finished_at = defer_time,
    last_defer_reason = p_reason,
    updated_at = defer_time
  where accounts.account_id = p_account_id
  returning accounts.* into current_account;

  return query select
    'deferred'::text,
    current_account.account_id,
    current_account.next_poll_at,
    current_account.last_success_at,
    current_account.last_defer_reason,
    defer_time;
end;
$function$;

revoke all on function private.defer_marketing_x_mention_poll(
  text, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function private.defer_marketing_x_mention_poll(
  text, uuid, timestamptz, text
) to service_role;

create or replace function public.defer_marketing_x_mention_poll(
  p_account_id text,
  p_lease_token uuid,
  p_next_poll_at timestamptz,
  p_reason text
)
returns table (
  result_code text,
  account_id text,
  next_poll_at timestamptz,
  last_success_at timestamptz,
  defer_reason text,
  deferred_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.defer_marketing_x_mention_poll(
    p_account_id,
    p_lease_token,
    p_next_poll_at,
    p_reason
  );
$function$;

revoke all on function public.defer_marketing_x_mention_poll(
  text, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.defer_marketing_x_mention_poll(
  text, uuid, timestamptz, text
) to service_role;

create or replace function private.list_marketing_x_mention_inbox(
  p_account_id text,
  p_limit integer
)
returns table (
  result_code text,
  account_id text,
  review_required_count integer,
  items jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  review_count integer := 0;
  bounded_items jsonb := '[]'::jsonb;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_limit is null
    or p_limit not between 1 and 100
  then
    raise exception 'invalid marketing X mention inbox request';
  end if;

  if not exists (
    select 1
    from public.marketing_x_mention_accounts as accounts
    where accounts.account_id = p_account_id
  ) then
    return query select
      'account_not_found'::text,
      p_account_id,
      0,
      '[]'::jsonb;
    return;
  end if;

  select count(*)::integer
  into review_count
  from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and mentions.state = 'review_required';

  select coalesce(pg_catalog.jsonb_agg(ordered.item), '[]'::jsonb)
  into bounded_items
  from (
    select pg_catalog.jsonb_build_object(
      'post_id', mentions.post_id,
      'author_id', mentions.author_id,
      'conversation_id', mentions.conversation_id,
      'created_at', mentions.source_created_at,
      'content_hmac', mentions.content_hmac,
      'classification', mentions.classification,
      'eligibility_reason', mentions.eligibility_reason,
      'state', mentions.state,
      'discovered_at', mentions.discovered_at,
      'state_changed_at', mentions.state_changed_at,
      'claim_day', mentions.reply_claim_day,
      'claimed_at', mentions.claimed_at,
      'replied_at', mentions.replied_at,
      'failed_at', mentions.failed_at,
      'failure_code', mentions.failure_code
    ) as item
    from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
      and mentions.state <> 'baseline'
    order by
      case mentions.state
        when 'review_required' then 0
        when 'eligible' then 1
        when 'claimed' then 2
        when 'failed' then 3
        when 'replied' then 4
        when 'opted_out' then 5
        else 6
      end,
      mentions.source_created_at desc,
      mentions.post_id desc
    limit p_limit
  ) as ordered;

  return query select
    'listed'::text,
    p_account_id,
    review_count,
    bounded_items;
end;
$function$;

revoke all on function private.list_marketing_x_mention_inbox(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.list_marketing_x_mention_inbox(text, integer)
  to service_role;

create or replace function public.list_marketing_x_mention_inbox(
  p_account_id text,
  p_limit integer
)
returns table (
  result_code text,
  account_id text,
  review_required_count integer,
  items jsonb
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.list_marketing_x_mention_inbox(
    p_account_id,
    p_limit
  );
$function$;

revoke all on function public.list_marketing_x_mention_inbox(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_marketing_x_mention_inbox(text, integer)
  to service_role;

create or replace function private.claim_next_marketing_x_mention(
  p_account_id text,
  p_daily_cap integer
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  author_id text,
  conversation_id text,
  source_created_at timestamptz,
  content_hmac text,
  delivery_reference uuid,
  interaction_reference text,
  classification text,
  eligibility_reason text,
  state text,
  claim_token uuid,
  claim_day date,
  claimed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_account public.marketing_x_mention_accounts%rowtype;
  current_mention public.marketing_x_mentions%rowtype;
  claim_time timestamptz := pg_catalog.clock_timestamp();
  utc_day date := (pg_catalog.clock_timestamp() at time zone 'UTC')::date;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_daily_cap is null
    or p_daily_cap not between 0 and 5
  then
    raise exception 'invalid marketing X account id';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-reply:' || p_account_id,
      0
    )
  );

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id;

  if not found or current_account.initialized_at is null then
    return query select
      'not_initialized'::text,
      p_account_id,
      null::text,
      null::text,
      null::text,
      null::timestamptz,
      null::text,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::text,
      null::uuid,
      null::date,
      null::timestamptz;
    return;
  end if;

  if current_account.continuation_until_id is not null then
    return query select
      'poll_incomplete'::text,
      p_account_id,
      null::text,
      null::text,
      null::text,
      null::timestamptz,
      null::text,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::text,
      null::uuid,
      null::date,
      null::timestamptz;
    return;
  end if;

  claim_time := pg_catalog.clock_timestamp();
  utc_day := (claim_time at time zone 'UTC')::date;

  if (
    select count(*)
    from public.marketing_x_mentions as claimed
    where claimed.account_id = p_account_id
      and claimed.reply_claim_day = utc_day
  ) >= p_daily_cap then
    return query select
      'daily_cap_reached'::text,
      p_account_id,
      null::text,
      null::text,
      null::text,
      null::timestamptz,
      null::text,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::text,
      null::uuid,
      utc_day,
      null::timestamptz;
    return;
  end if;

  update public.marketing_x_mentions as mentions
  set
    state = 'opted_out',
    state_changed_at = greatest(
      claim_time,
      mentions.state_changed_at + interval '1 microsecond'
    )
  where mentions.account_id = p_account_id
    and mentions.state in ('eligible', 'review_required')
    and exists (
      select 1
      from public.marketing_x_mention_opt_outs as opt_outs
      where opt_outs.account_id = mentions.account_id
        and opt_outs.author_id = mentions.author_id
    );

  select mentions.*
  into current_mention
  from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and mentions.state = 'eligible'
    and mentions.classification = 'auto_reply'
    and mentions.source_created_at >= claim_time - interval '24 hours'
    and mentions.source_created_at <= claim_time + interval '5 minutes'
    and not exists (
      select 1
      from public.marketing_x_mention_opt_outs as opt_outs
      where opt_outs.account_id = mentions.account_id
        and opt_outs.author_id = mentions.author_id
    )
    and not exists (
      select 1
      from public.marketing_x_mentions as prior
      where prior.account_id = mentions.account_id
        and prior.author_id = mentions.author_id
        and prior.reply_claim_day = utc_day
    )
    and not exists (
      select 1
      from public.marketing_x_mentions as prior
      where prior.account_id = mentions.account_id
        and prior.conversation_id = mentions.conversation_id
        and prior.reply_claim_day = utc_day
    )
  order by mentions.source_created_at, mentions.post_id
  for update skip locked
  limit 1;

  if not found then
    return query select
      'no_eligible'::text,
      p_account_id,
      null::text,
      null::text,
      null::text,
      null::timestamptz,
      null::text,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::text,
      null::uuid,
      utc_day,
      null::timestamptz;
    return;
  end if;

  claim_time := greatest(
    claim_time,
    current_mention.state_changed_at + interval '1 microsecond'
  );

  update public.marketing_x_mentions as mentions
  set
    state = 'claimed',
    reply_claim_token = pg_catalog.gen_random_uuid(),
    reply_claim_day = utc_day,
    claimed_at = claim_time,
    state_changed_at = claim_time
  where mentions.account_id = p_account_id
    and mentions.post_id = current_mention.post_id
  returning mentions.* into current_mention;

  return query select
    'claimed'::text,
    current_mention.account_id,
    current_mention.post_id,
    current_mention.author_id,
    current_mention.conversation_id,
    current_mention.source_created_at,
    current_mention.content_hmac,
    current_mention.delivery_reference,
    current_mention.interaction_reference,
    current_mention.classification,
    current_mention.eligibility_reason,
    current_mention.state,
    current_mention.reply_claim_token,
    current_mention.reply_claim_day,
    current_mention.claimed_at;
end;
$function$;

revoke all on function private.claim_next_marketing_x_mention(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.claim_next_marketing_x_mention(text, integer)
  to service_role;

create or replace function public.claim_next_marketing_x_mention(
  p_account_id text,
  p_daily_cap integer
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  author_id text,
  conversation_id text,
  source_created_at timestamptz,
  content_hmac text,
  delivery_reference uuid,
  interaction_reference text,
  classification text,
  eligibility_reason text,
  state text,
  claim_token uuid,
  claim_day date,
  claimed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.claim_next_marketing_x_mention(
    p_account_id,
    p_daily_cap
  );
$function$;

revoke all on function public.claim_next_marketing_x_mention(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_next_marketing_x_mention(text, integer)
  to service_role;

create or replace function private.complete_marketing_x_mention_reply(
  p_account_id text,
  p_post_id text,
  p_claim_token uuid
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  state text,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_mention public.marketing_x_mentions%rowtype;
  completion_time timestamptz := pg_catalog.clock_timestamp();
  outcome text;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_post_id is null
    or p_post_id !~ '^[1-9][0-9]{0,18}$'
    or p_claim_token is null
  then
    raise exception 'invalid marketing X mention completion';
  end if;

  select mentions.*
  into current_mention
  from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and mentions.post_id = p_post_id
  for update;

  completion_time := pg_catalog.clock_timestamp();
  if not found then
    return query select
      'not_found'::text,
      p_account_id,
      p_post_id,
      null::text,
      null::timestamptz;
    return;
  end if;

  if current_mention.reply_claim_token is distinct from p_claim_token then
    outcome := 'claim_conflict';
  elsif current_mention.state = 'replied' then
    outcome := 'already_completed';
  elsif current_mention.state = 'failed' then
    outcome := 'already_failed';
  elsif current_mention.state <> 'claimed' then
    outcome := 'not_claimed';
  else
    completion_time := greatest(
      completion_time,
      current_mention.state_changed_at + interval '1 microsecond'
    );
    update public.marketing_x_mentions as mentions
    set
      state = 'replied',
      replied_at = completion_time,
      state_changed_at = completion_time
    where mentions.account_id = p_account_id
      and mentions.post_id = p_post_id
    returning mentions.* into current_mention;
    outcome := 'completed';
  end if;

  return query select
    outcome,
    current_mention.account_id,
    current_mention.post_id,
    current_mention.state,
    current_mention.replied_at;
end;
$function$;

revoke all on function private.complete_marketing_x_mention_reply(
  text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function private.complete_marketing_x_mention_reply(
  text, text, uuid
) to service_role;

create or replace function public.complete_marketing_x_mention_reply(
  p_account_id text,
  p_post_id text,
  p_claim_token uuid
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  state text,
  completed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.complete_marketing_x_mention_reply(
    p_account_id,
    p_post_id,
    p_claim_token
  );
$function$;

revoke all on function public.complete_marketing_x_mention_reply(
  text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.complete_marketing_x_mention_reply(
  text, text, uuid
) to service_role;

create or replace function private.fail_marketing_x_mention_reply(
  p_account_id text,
  p_post_id text,
  p_claim_token uuid,
  p_failure_code text
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  state text,
  failed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_mention public.marketing_x_mentions%rowtype;
  failure_time timestamptz := pg_catalog.clock_timestamp();
  outcome text;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_post_id is null
    or p_post_id !~ '^[1-9][0-9]{0,18}$'
    or p_claim_token is null
    or p_failure_code is null
    or p_failure_code !~ '^[a-z][a-z0-9_:-]{0,63}$'
  then
    raise exception 'invalid marketing X mention failure';
  end if;

  select mentions.*
  into current_mention
  from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and mentions.post_id = p_post_id
  for update;

  failure_time := pg_catalog.clock_timestamp();
  if not found then
    return query select
      'not_found'::text,
      p_account_id,
      p_post_id,
      null::text,
      null::timestamptz;
    return;
  end if;

  if current_mention.reply_claim_token is distinct from p_claim_token then
    outcome := 'claim_conflict';
  elsif current_mention.state = 'failed' then
    outcome := 'already_failed';
  elsif current_mention.state = 'replied' then
    outcome := 'already_completed';
  elsif current_mention.state <> 'claimed' then
    outcome := 'not_claimed';
  else
    failure_time := greatest(
      failure_time,
      current_mention.state_changed_at + interval '1 microsecond'
    );
    update public.marketing_x_mentions as mentions
    set
      state = 'failed',
      failed_at = failure_time,
      failure_code = p_failure_code,
      state_changed_at = failure_time
    where mentions.account_id = p_account_id
      and mentions.post_id = p_post_id
    returning mentions.* into current_mention;
    outcome := 'failed';
  end if;

  return query select
    outcome,
    current_mention.account_id,
    current_mention.post_id,
    current_mention.state,
    current_mention.failed_at;
end;
$function$;

revoke all on function private.fail_marketing_x_mention_reply(
  text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function private.fail_marketing_x_mention_reply(
  text, text, uuid, text
) to service_role;

create or replace function public.fail_marketing_x_mention_reply(
  p_account_id text,
  p_post_id text,
  p_claim_token uuid,
  p_failure_code text
)
returns table (
  result_code text,
  account_id text,
  post_id text,
  state text,
  failed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.fail_marketing_x_mention_reply(
    p_account_id,
    p_post_id,
    p_claim_token,
    p_failure_code
  );
$function$;

revoke all on function public.fail_marketing_x_mention_reply(
  text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.fail_marketing_x_mention_reply(
  text, text, uuid, text
) to service_role;

create or replace function private.record_marketing_x_mention_opt_out(
  p_account_id text,
  p_author_id text,
  p_source_post_id text
)
returns table (
  result_code text,
  account_id text,
  author_id text,
  source_post_id text,
  opted_out_at timestamptz,
  blocked_count integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_opt_out public.marketing_x_mention_opt_outs%rowtype;
  opt_out_time timestamptz := pg_catalog.clock_timestamp();
  affected integer := 0;
  inserted boolean := false;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_author_id is null
    or p_author_id !~ '^[1-9][0-9]{0,18}$'
    or (
      p_source_post_id is not null
      and p_source_post_id !~ '^[1-9][0-9]{0,18}$'
    )
  then
    raise exception 'invalid marketing X mention opt-out';
  end if;

  if not exists (
    select 1
    from public.marketing_x_mention_accounts as accounts
    where accounts.account_id = p_account_id
  ) then
    return query select
      'account_not_found'::text,
      p_account_id,
      p_author_id,
      p_source_post_id,
      null::timestamptz,
      0;
    return;
  end if;

  if p_source_post_id is not null
    and not exists (
      select 1
      from public.marketing_x_mentions as mentions
      where mentions.account_id = p_account_id
        and mentions.post_id = p_source_post_id
        and mentions.author_id = p_author_id
    )
  then
    raise exception 'marketing X mention opt-out source mismatch';
  end if;

  insert into public.marketing_x_mention_opt_outs (
    account_id,
    author_id,
    source_post_id,
    opted_out_at
  ) values (
    p_account_id,
    p_author_id,
    p_source_post_id,
    opt_out_time
  )
  on conflict on constraint marketing_x_mention_opt_outs_pkey do nothing
  returning * into current_opt_out;

  inserted := found;
  if not inserted then
    select opt_outs.*
    into current_opt_out
    from public.marketing_x_mention_opt_outs as opt_outs
    where opt_outs.account_id = p_account_id
      and opt_outs.author_id = p_author_id;
  end if;

  update public.marketing_x_mentions as mentions
  set
    state = 'opted_out',
    state_changed_at = greatest(
      opt_out_time,
      mentions.state_changed_at + interval '1 microsecond'
    )
  where mentions.account_id = p_account_id
    and mentions.author_id = p_author_id
    and mentions.state in ('eligible', 'review_required');

  get diagnostics affected = row_count;

  return query select
    case when inserted then 'recorded'::text else 'already_recorded'::text end,
    current_opt_out.account_id,
    current_opt_out.author_id,
    current_opt_out.source_post_id,
    current_opt_out.opted_out_at,
    affected;
end;
$function$;

revoke all on function private.record_marketing_x_mention_opt_out(
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.record_marketing_x_mention_opt_out(
  text, text, text
) to service_role;

create or replace function public.record_marketing_x_mention_opt_out(
  p_account_id text,
  p_author_id text,
  p_source_post_id text
)
returns table (
  result_code text,
  account_id text,
  author_id text,
  source_post_id text,
  opted_out_at timestamptz,
  blocked_count integer
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.record_marketing_x_mention_opt_out(
    p_account_id,
    p_author_id,
    p_source_post_id
  );
$function$;

revoke all on function public.record_marketing_x_mention_opt_out(
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_marketing_x_mention_opt_out(
  text, text, text
) to service_role;
