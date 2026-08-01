-- Provider-backed X compliance, short-lived manual reply subjects, and final
-- outbound admission fencing for the OpenZaps marketing agent.
--
-- This migration is append-only relative to the deployed mention store. It
-- deliberately leaves every public table behind RLS with no direct Data API
-- grants. Only service-role RPC wrappers can read or mutate X identifiers.
-- Provider observations are accepted only as one complete, recent official
-- lookup snapshot; individual observation identifiers are never persisted in
-- the aggregate checkpoint record.

alter table public.marketing_x_mention_accounts
  add column if not exists eligibility_cutoff_at timestamptz,
  add column if not exists cursor_set_at timestamptz,
  add column if not exists compliance_checkpoint_id uuid,
  add column if not exists compliance_checked_at timestamptz,
  add column if not exists compliance_valid_until timestamptz;

update public.marketing_x_mention_accounts as accounts
set
  eligibility_cutoff_at = coalesce(
    accounts.initialized_at,
    accounts.last_poll_started_at,
    accounts.created_at
  ),
  cursor_set_at = case
    when accounts.since_id is not null then coalesce(
      accounts.last_success_at,
      accounts.initialized_at,
      accounts.created_at
    )
    else null
  end
where accounts.eligibility_cutoff_at is null;

update public.marketing_x_mention_accounts as accounts
set cursor_set_at = coalesce(
  accounts.last_success_at,
  accounts.initialized_at,
  accounts.created_at
)
where accounts.since_id is not null
  and accounts.cursor_set_at is null;

alter table public.marketing_x_mention_accounts
  alter column eligibility_cutoff_at set not null;

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'marketing_x_mention_accounts_cutoff_finite'
      and conrelid = 'public.marketing_x_mention_accounts'::regclass
  ) then
    alter table public.marketing_x_mention_accounts
    add constraint marketing_x_mention_accounts_cutoff_finite check (
    eligibility_cutoff_at not in (
      '-infinity'::timestamptz,
      'infinity'::timestamptz
    )
    );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'marketing_x_mention_accounts_cursor_age'
      and conrelid = 'public.marketing_x_mention_accounts'::regclass
  ) then
    alter table public.marketing_x_mention_accounts
    add constraint marketing_x_mention_accounts_cursor_age check (
    (since_id is null and cursor_set_at is null)
    or (since_id is not null and cursor_set_at is not null)
    );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'marketing_x_mention_accounts_compliance_window'
      and conrelid = 'public.marketing_x_mention_accounts'::regclass
  ) then
    alter table public.marketing_x_mention_accounts
    add constraint marketing_x_mention_accounts_compliance_window check (
    (
      compliance_checkpoint_id is null
      and compliance_checked_at is null
      and compliance_valid_until is null
    )
    or (
      compliance_checkpoint_id is not null
      and compliance_checked_at is not null
      and compliance_valid_until is not null
      and compliance_valid_until > compliance_checked_at
    )
    );
  end if;
end;
$constraints$;

create table if not exists public.marketing_x_compliance_checkpoints (
  checkpoint_id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id text not null
    references public.marketing_x_mention_accounts (account_id),
  provider_run_id uuid not null unique,
  source_kind text not null default 'official_lookup'
    check (source_kind = 'official_lookup'),
  status text not null
    check (status in ('healthy', 'action_required')),
  lookup_started_at timestamptz not null,
  lookup_completed_at timestamptz not null,
  valid_until timestamptz not null,
  subject_count integer not null check (subject_count between 1 and 5000),
  non_present_count integer not null
    check (non_present_count between 0 and subject_count),
  recorded_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (lookup_completed_at >= lookup_started_at),
  check (valid_until = lookup_completed_at + interval '30 minutes'),
  check (
    (status = 'healthy' and non_present_count = 0)
    or (status = 'action_required' and non_present_count > 0)
  )
);

alter table public.marketing_x_compliance_checkpoints enable row level security;
revoke all on table public.marketing_x_compliance_checkpoints
  from public, anon, authenticated, service_role;

create table if not exists public.marketing_x_compliance_subject_observations (
  checkpoint_id uuid not null
    references public.marketing_x_compliance_checkpoints (checkpoint_id),
  account_id text not null
    references public.marketing_x_mention_accounts (account_id),
  subject_kind text not null
    check (subject_kind in ('account', 'post', 'author')),
  subject_id text not null
    check (subject_id ~ '^[1-9][0-9]{0,18}$'),
  outcome text not null check (outcome = 'present'),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (checkpoint_id, subject_kind, subject_id),
  check (expires_at = observed_at + interval '30 minutes')
);

create index if not exists marketing_x_compliance_subject_lookup
  on public.marketing_x_compliance_subject_observations (
    account_id,
    checkpoint_id,
    subject_kind,
    subject_id
  );

alter table public.marketing_x_compliance_subject_observations
  enable row level security;
revoke all on table public.marketing_x_compliance_subject_observations
  from public, anon, authenticated, service_role;

do $checkpoint_fk$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'marketing_x_mention_accounts_compliance_checkpoint_fkey'
      and conrelid = 'public.marketing_x_mention_accounts'::regclass
  ) then
    alter table public.marketing_x_mention_accounts
      add constraint marketing_x_mention_accounts_compliance_checkpoint_fkey
      foreign key (compliance_checkpoint_id)
      references public.marketing_x_compliance_checkpoints (checkpoint_id);
  end if;
end;
$checkpoint_fk$;

create table if not exists public.marketing_x_reply_subjects (
  interaction_reference text primary key
    check (interaction_reference ~ '^[1-9][0-9]{29}$'),
  account_id text not null
    references public.marketing_x_mention_accounts (account_id),
  post_id text not null
    check (post_id ~ '^[1-9][0-9]{0,18}$'),
  author_id text not null
    check (author_id ~ '^[1-9][0-9]{0,18}$'),
  target_url text not null
    check (
      target_url ~ '^https://x[.]com/(i/web|[A-Za-z0-9_]{1,15})/status/[1-9][0-9]{0,18}$'
    ),
  trigger_code text not null
    check (trigger_code ~ '^[a-z][a-z0-9_:-]{0,63}$'),
  observed_at timestamptz not null,
  state text not null default 'pending'
    check (state in ('pending', 'resolving', 'admitted')),
  idempotency_key text,
  claim_token uuid,
  claim_started_at timestamptz,
  claim_expires_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  state_changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (account_id, post_id),
  check (expires_at = created_at + interval '24 hours'),
  check (observed_at <= created_at + interval '5 minutes'),
  check (
    (
      state = 'pending'
      and idempotency_key is null
      and claim_token is null
      and claim_started_at is null
      and claim_expires_at is null
    )
    or (
      state in ('resolving', 'admitted')
      and idempotency_key is not null
      and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      and claim_token is not null
      and claim_started_at is not null
      and claim_expires_at = claim_started_at + interval '2 minutes'
    )
  ),
  check (state_changed_at >= created_at)
);

create index if not exists marketing_x_reply_subjects_expiry
  on public.marketing_x_reply_subjects (expires_at);

alter table public.marketing_x_reply_subjects enable row level security;
revoke all on table public.marketing_x_reply_subjects
  from public, anon, authenticated, service_role;

create table if not exists public.marketing_x_outbound_admissions (
  admission_token uuid primary key default pg_catalog.gen_random_uuid(),
  account_id text not null
    references public.marketing_x_mention_accounts (account_id),
  interaction_reference text not null
    check (interaction_reference ~ '^[1-9][0-9]{29}$'),
  lane text not null check (lane in ('mention', 'manual')),
  source_claim_token uuid not null,
  checkpoint_id uuid not null
    references public.marketing_x_compliance_checkpoints (checkpoint_id),
  provider_checked_at timestamptz not null,
  state text not null default 'active'
    check (state in ('active', 'completed', 'failed', 'revoked')),
  failure_code text
    check (
      failure_code is null
      or failure_code ~ '^[a-z][a-z0-9_:-]{0,63}$'
    ),
  admitted_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  state_changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  finalized_at timestamptz,
  check (expires_at = admitted_at + interval '10 seconds'),
  check (provider_checked_at <= admitted_at + interval '1 minute'),
  check (
    (state = 'active' and failure_code is null and finalized_at is null)
    or (
      state = 'completed'
      and failure_code is null
      and finalized_at is not null
    )
    or (
      state in ('failed', 'revoked')
      and failure_code is not null
      and finalized_at is not null
    )
  ),
  check (state_changed_at >= admitted_at)
);

create unique index if not exists marketing_x_outbound_one_admission_per_claim
  on public.marketing_x_outbound_admissions (
    account_id,
    interaction_reference,
    source_claim_token
  );

create index if not exists marketing_x_outbound_admissions_expiry
  on public.marketing_x_outbound_admissions (expires_at, state);

alter table public.marketing_x_outbound_admissions enable row level security;
revoke all on table public.marketing_x_outbound_admissions
  from public, anon, authenticated, service_role;

create table if not exists public.marketing_x_retention_events (
  event_id bigint generated always as identity primary key,
  expired_subject_count integer not null check (expired_subject_count >= 0),
  deleted_mention_count integer not null check (deleted_mention_count >= 0),
  deleted_opt_out_count integer not null check (deleted_opt_out_count >= 0),
  deleted_admission_count integer not null check (deleted_admission_count >= 0),
  deleted_checkpoint_count integer not null check (deleted_checkpoint_count >= 0),
  deleted_compliance_event_count integer not null
    check (deleted_compliance_event_count >= 0),
  reset_cursor_count integer not null check (reset_cursor_count >= 0),
  processed_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.marketing_x_retention_events enable row level security;
revoke all on table public.marketing_x_retention_events
  from public, anon, authenticated, service_role;

create or replace function private.enforce_marketing_x_reply_subject_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.interaction_reference <> old.interaction_reference
    or new.account_id <> old.account_id
    or new.post_id <> old.post_id
    or new.author_id <> old.author_id
    or new.target_url <> old.target_url
    or new.trigger_code <> old.trigger_code
    or new.observed_at <> old.observed_at
    or new.created_at <> old.created_at
    or new.expires_at <> old.expires_at
  then
    raise exception 'marketing X reply subject identity is immutable';
  end if;

  if new.state <> old.state
    and not (
      (old.state = 'pending' and new.state = 'resolving')
      or (old.state = 'resolving' and new.state = 'admitted')
    )
  then
    raise exception 'invalid marketing X reply subject transition';
  end if;

  if old.claim_token is not null
    and (
      new.claim_token is distinct from old.claim_token
      or new.idempotency_key is distinct from old.idempotency_key
      or new.claim_started_at is distinct from old.claim_started_at
      or new.claim_expires_at is distinct from old.claim_expires_at
    )
  then
    raise exception 'marketing X reply subject claim is immutable';
  end if;

  if new.state = old.state and new.state_changed_at <> old.state_changed_at
    or new.state <> old.state and new.state_changed_at <= old.state_changed_at
  then
    raise exception 'invalid marketing X reply subject state timestamp';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_marketing_x_reply_subject_update()
  from public, anon, authenticated, service_role;

drop trigger if exists marketing_x_reply_subjects_guard
on public.marketing_x_reply_subjects;
create trigger marketing_x_reply_subjects_guard
before update on public.marketing_x_reply_subjects
for each row execute function private.enforce_marketing_x_reply_subject_update();

drop trigger if exists marketing_x_reply_subjects_append_only
on public.marketing_x_reply_subjects;
create trigger marketing_x_reply_subjects_append_only
before delete or truncate on public.marketing_x_reply_subjects
for each statement execute function private.reject_marketing_x_mention_deletion();

create or replace function private.enforce_marketing_x_outbound_admission_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.admission_token <> old.admission_token
    or new.account_id <> old.account_id
    or new.interaction_reference <> old.interaction_reference
    or new.lane <> old.lane
    or new.source_claim_token <> old.source_claim_token
    or new.checkpoint_id <> old.checkpoint_id
    or new.provider_checked_at <> old.provider_checked_at
    or new.admitted_at <> old.admitted_at
    or new.expires_at <> old.expires_at
  then
    raise exception 'marketing X outbound admission identity is immutable';
  end if;

  if new.state <> old.state
    and not (old.state = 'active' and new.state in ('completed', 'failed', 'revoked'))
  then
    raise exception 'invalid marketing X outbound admission transition';
  end if;

  if new.state = old.state and (
    new.failure_code is distinct from old.failure_code
    or new.finalized_at is distinct from old.finalized_at
    or new.state_changed_at <> old.state_changed_at
  ) then
    raise exception 'marketing X outbound terminal evidence changed without a transition';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_marketing_x_outbound_admission_update()
  from public, anon, authenticated, service_role;

drop trigger if exists marketing_x_outbound_admissions_guard
on public.marketing_x_outbound_admissions;
create trigger marketing_x_outbound_admissions_guard
before update on public.marketing_x_outbound_admissions
for each row execute function private.enforce_marketing_x_outbound_admission_update();

drop trigger if exists marketing_x_outbound_admissions_append_only
on public.marketing_x_outbound_admissions;
create trigger marketing_x_outbound_admissions_append_only
before delete or truncate on public.marketing_x_outbound_admissions
for each statement execute function private.reject_marketing_x_mention_deletion();

drop trigger if exists marketing_x_compliance_checkpoints_append_only
on public.marketing_x_compliance_checkpoints;
create trigger marketing_x_compliance_checkpoints_append_only
before delete or truncate on public.marketing_x_compliance_checkpoints
for each statement execute function private.reject_marketing_x_mention_deletion();

drop trigger if exists marketing_x_compliance_subject_observations_append_only
on public.marketing_x_compliance_subject_observations;
create trigger marketing_x_compliance_subject_observations_append_only
before delete or truncate on public.marketing_x_compliance_subject_observations
for each statement execute function private.reject_marketing_x_mention_deletion();

drop trigger if exists marketing_x_retention_events_append_only
on public.marketing_x_retention_events;
create trigger marketing_x_retention_events_append_only
before delete or truncate on public.marketing_x_retention_events
for each statement execute function private.reject_marketing_x_mention_deletion();

create or replace function private.marketing_x_compliance_is_fresh(
  p_account_id text,
  p_now timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.marketing_x_mention_accounts as accounts
    join public.marketing_x_compliance_checkpoints as checkpoints
      on checkpoints.checkpoint_id = accounts.compliance_checkpoint_id
    where accounts.account_id = p_account_id
      and accounts.compliance_hold_at is null
      and accounts.compliance_checked_at = checkpoints.lookup_completed_at
      and accounts.compliance_valid_until = checkpoints.valid_until
      and checkpoints.status = 'healthy'
      and checkpoints.lookup_completed_at <= p_now + interval '1 minute'
      and checkpoints.valid_until > p_now
  );
$function$;

revoke all on function private.marketing_x_compliance_is_fresh(text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.marketing_x_subject_is_covered(
  p_account_id text,
  p_subject_kind text,
  p_subject_id text,
  p_now timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.marketing_x_mention_accounts as accounts
    join public.marketing_x_compliance_subject_observations as observations
      on observations.checkpoint_id = accounts.compliance_checkpoint_id
      and observations.account_id = accounts.account_id
    where accounts.account_id = p_account_id
      and observations.subject_kind = p_subject_kind
      and observations.subject_id = p_subject_id
      and observations.outcome = 'present'
      and observations.observed_at = accounts.compliance_checked_at
      and observations.expires_at = accounts.compliance_valid_until
      and observations.expires_at > p_now
  );
$function$;

revoke all on function private.marketing_x_subject_is_covered(
  text, text, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function private.enforce_marketing_x_eligibility_cutoff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  cutoff timestamptz;
begin
  select accounts.eligibility_cutoff_at
  into cutoff
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = new.account_id;

  if cutoff is null then
    raise exception 'marketing X eligibility cutoff is unavailable';
  end if;

  if new.classification <> 'opt_out'
    and new.source_created_at <= cutoff
  then
    new.state := 'baseline';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_marketing_x_eligibility_cutoff()
  from public, anon, authenticated, service_role;

drop trigger if exists marketing_x_mentions_eligibility_cutoff
on public.marketing_x_mentions;
create trigger marketing_x_mentions_eligibility_cutoff
before insert on public.marketing_x_mentions
for each row execute function private.enforce_marketing_x_eligibility_cutoff();

create or replace function private.list_marketing_x_compliance_subjects(
  p_account_id text,
  p_limit integer
)
returns table (
  result_code text,
  account_id text,
  subject_count integer,
  subjects jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  total_count integer;
  listed jsonb;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_limit is null
    or p_limit not between 1 and 5000
  then
    raise exception 'invalid marketing X compliance subject request';
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

  with current_subjects as (
    select 'account'::text as subject_kind, p_account_id as subject_id
    union
    select 'post'::text, mentions.post_id
    from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
    union
    select 'author'::text, mentions.author_id
    from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
    union
    select 'post'::text, subjects.post_id
    from public.marketing_x_reply_subjects as subjects
    where subjects.account_id = p_account_id
      and subjects.expires_at > pg_catalog.clock_timestamp()
    union
    select 'author'::text, subjects.author_id
    from public.marketing_x_reply_subjects as subjects
    where subjects.account_id = p_account_id
      and subjects.expires_at > pg_catalog.clock_timestamp()
  )
  select count(*)::integer
  into total_count
  from current_subjects;

  if total_count > p_limit then
    return query select
      'limit_exceeded'::text,
      p_account_id,
      total_count,
      '[]'::jsonb;
    return;
  end if;

  with current_subjects as (
    select 'account'::text as subject_kind, p_account_id as subject_id
    union
    select 'post'::text, mentions.post_id
    from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
    union
    select 'author'::text, mentions.author_id
    from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
    union
    select 'post'::text, reply_subjects.post_id
    from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.account_id = p_account_id
      and reply_subjects.expires_at > pg_catalog.clock_timestamp()
    union
    select 'author'::text, reply_subjects.author_id
    from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.account_id = p_account_id
      and reply_subjects.expires_at > pg_catalog.clock_timestamp()
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'subject_kind', ordered.subject_kind,
        'subject_id', ordered.subject_id
      )
      order by ordered.subject_kind, ordered.subject_id
    ),
    '[]'::jsonb
  )
  into listed
  from current_subjects as ordered;

  return query select
    'listed'::text,
    p_account_id,
    total_count,
    listed;
end;
$function$;

revoke all on function private.list_marketing_x_compliance_subjects(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.list_marketing_x_compliance_subjects(text, integer)
  to service_role;

create or replace function public.list_marketing_x_compliance_subjects(
  p_account_id text,
  p_limit integer
)
returns table (
  result_code text,
  account_id text,
  subject_count integer,
  subjects jsonb
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.list_marketing_x_compliance_subjects(
    p_account_id,
    p_limit
  );
$function$;

revoke all on function public.list_marketing_x_compliance_subjects(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_marketing_x_compliance_subjects(text, integer)
  to service_role;

create or replace function private.record_marketing_x_compliance_checkpoint(
  p_account_id text,
  p_provider_run_id uuid,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_observations jsonb
)
returns table (
  result_code text,
  checkpoint_id uuid,
  checked_at timestamptz,
  valid_until timestamptz,
  subject_count integer,
  non_present_count integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  recorded_now timestamptz := pg_catalog.clock_timestamp();
  observation_count integer;
  non_present integer;
  current_checkpoint public.marketing_x_compliance_checkpoints%rowtype;
  erased_mentions integer := 0;
  erased_opt_outs integer := 0;
  redacted_deliveries integer := 0;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_provider_run_id is null
    or p_started_at is null
    or p_completed_at is null
    or p_started_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_completed_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_completed_at < p_started_at
    or p_started_at < recorded_now - interval '10 minutes'
    or p_completed_at > recorded_now + interval '1 minute'
    or p_completed_at - p_started_at > interval '10 minutes'
    or p_observations is null
    or pg_catalog.jsonb_typeof(p_observations) <> 'array'
  then
    raise exception 'invalid marketing X compliance checkpoint';
  end if;

  observation_count := pg_catalog.jsonb_array_length(p_observations);
  if observation_count not between 1 and 5000 then
    raise exception 'invalid marketing X compliance checkpoint size';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_observations) as entries(item)
    where pg_catalog.jsonb_typeof(entries.item) <> 'object'
      or not (entries.item ?& array['subject_kind', 'subject_id', 'outcome'])
      or (select count(*) from pg_catalog.jsonb_object_keys(entries.item)) <> 3
      or pg_catalog.jsonb_typeof(entries.item -> 'subject_kind') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'subject_id') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'outcome') <> 'string'
  ) then
    raise exception 'invalid marketing X compliance observation shape';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_observations) as observation(
      subject_kind text,
      subject_id text,
      outcome text
    )
    where observation.subject_kind not in ('account', 'post', 'author')
      or observation.subject_id !~ '^[1-9][0-9]{0,18}$'
      or observation.outcome not in (
        'present', 'absent', 'deleted', 'protected', 'suspended', 'withheld'
      )
      or (
        observation.subject_kind = 'account'
        and observation.subject_id <> p_account_id
      )
  ) then
    raise exception 'invalid marketing X compliance observation';
  end if;

  if observation_count <> (
    select count(*)
    from (
      select distinct
        observation.subject_kind,
        observation.subject_id
      from pg_catalog.jsonb_to_recordset(p_observations) as observation(
        subject_kind text,
        subject_id text
      )
    ) as unique_observations
  ) then
    raise exception 'duplicate marketing X compliance observation';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );
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

  insert into public.marketing_x_mention_accounts (
    account_id,
    eligibility_cutoff_at,
    next_poll_at,
    created_at,
    updated_at
  ) values (
    p_account_id,
    p_completed_at,
    recorded_now,
    recorded_now,
    recorded_now
  ) on conflict on constraint marketing_x_mention_accounts_pkey do nothing;

  select checkpoints.*
  into current_checkpoint
  from public.marketing_x_compliance_checkpoints as checkpoints
  where checkpoints.provider_run_id = p_provider_run_id;

  if found then
    if current_checkpoint.account_id <> p_account_id
      or current_checkpoint.lookup_started_at <> p_started_at
      or current_checkpoint.lookup_completed_at <> p_completed_at
      or current_checkpoint.subject_count <> observation_count
    then
      raise exception 'marketing X compliance provider run conflict';
    end if;

    return query select
      case
        when current_checkpoint.status = 'healthy' then 'already_recorded'::text
        else 'already_actioned'::text
      end,
      current_checkpoint.checkpoint_id,
      current_checkpoint.lookup_completed_at,
      current_checkpoint.valid_until,
      current_checkpoint.subject_count,
      current_checkpoint.non_present_count;
    return;
  end if;

  if exists (
    with expected as (
      select 'account'::text as subject_kind, p_account_id as subject_id
      union
      select 'post'::text, mentions.post_id
      from public.marketing_x_mentions as mentions
      where mentions.account_id = p_account_id
      union
      select 'author'::text, mentions.author_id
      from public.marketing_x_mentions as mentions
      where mentions.account_id = p_account_id
      union
      select 'post'::text, reply_subjects.post_id
      from public.marketing_x_reply_subjects as reply_subjects
      where reply_subjects.account_id = p_account_id
        and reply_subjects.expires_at > recorded_now
      union
      select 'author'::text, reply_subjects.author_id
      from public.marketing_x_reply_subjects as reply_subjects
      where reply_subjects.account_id = p_account_id
        and reply_subjects.expires_at > recorded_now
    ), provided as (
      select observation.subject_kind, observation.subject_id
      from pg_catalog.jsonb_to_recordset(p_observations) as observation(
        subject_kind text,
        subject_id text
      )
    )
    (select expected.subject_kind, expected.subject_id from expected
     except
     select provided.subject_kind, provided.subject_id from provided)
    union all
    (select provided.subject_kind, provided.subject_id from provided
     except
     select expected.subject_kind, expected.subject_id from expected)
  ) then
    return query select
      'coverage_conflict'::text,
      null::uuid,
      null::timestamptz,
      null::timestamptz,
      observation_count,
      0;
    return;
  end if;

  select count(*)::integer
  into non_present
  from pg_catalog.jsonb_to_recordset(p_observations) as observation(outcome text)
  where observation.outcome <> 'present';

  insert into public.marketing_x_compliance_checkpoints (
    account_id,
    provider_run_id,
    status,
    lookup_started_at,
    lookup_completed_at,
    valid_until,
    subject_count,
    non_present_count,
    recorded_at
  ) values (
    p_account_id,
    p_provider_run_id,
    case when non_present = 0 then 'healthy' else 'action_required' end,
    p_started_at,
    p_completed_at,
    p_completed_at + interval '30 minutes',
    observation_count,
    non_present,
    recorded_now
  ) returning * into current_checkpoint;

  if non_present = 0 then
    insert into public.marketing_x_compliance_subject_observations (
      checkpoint_id,
      account_id,
      subject_kind,
      subject_id,
      outcome,
      observed_at,
      expires_at,
      recorded_at
    )
    select
      current_checkpoint.checkpoint_id,
      p_account_id,
      observation.subject_kind,
      observation.subject_id,
      'present',
      p_completed_at,
      p_completed_at + interval '30 minutes',
      recorded_now
    from pg_catalog.jsonb_to_recordset(p_observations) as observation(
      subject_kind text,
      subject_id text
    );

    update public.marketing_x_mention_accounts as accounts
    set
      compliance_checkpoint_id = current_checkpoint.checkpoint_id,
      compliance_checked_at = current_checkpoint.lookup_completed_at,
      compliance_valid_until = current_checkpoint.valid_until,
      updated_at = greatest(
        recorded_now,
        accounts.updated_at + interval '1 microsecond'
      )
    where accounts.account_id = p_account_id;

    return query select
      'recorded'::text,
      current_checkpoint.checkpoint_id,
      current_checkpoint.lookup_completed_at,
      current_checkpoint.valid_until,
      current_checkpoint.subject_count,
      0;
    return;
  end if;

  -- A provider non-presence/protection/withholding observation closes every
  -- admission gate before raw identifiers are suppressed. The same advisory
  -- locks are used by final admission, so the hold and fence are serialized.
  update public.marketing_x_mention_accounts as accounts
  set
    compliance_hold_at = coalesce(accounts.compliance_hold_at, recorded_now),
    compliance_hold_reason = coalesce(
      accounts.compliance_hold_reason,
      'provider_lookup_action_required'
    ),
    poll_lease_token = null,
    poll_lease_expires_at = null,
    next_poll_at = recorded_now,
    last_defer_reason = 'compliance_hold',
    updated_at = greatest(
      recorded_now,
      accounts.updated_at + interval '1 microsecond'
    )
  where accounts.account_id = p_account_id;

  update public.marketing_x_outbound_admissions as admissions
  set
    state = 'revoked',
    failure_code = 'compliance_hold',
    finalized_at = recorded_now,
    state_changed_at = greatest(
      recorded_now,
      admissions.state_changed_at + interval '1 microsecond'
    )
  where admissions.account_id = p_account_id
    and admissions.state = 'active';

  perform pg_catalog.set_config(
    'openzaps.marketing_x_compliance_erase',
    'true',
    true
  );

  with affected as (
    select distinct on (source.post_id)
      source.post_id,
      source.interaction_reference
    from (
      select mentions.post_id, mentions.interaction_reference, 0 as priority
      from public.marketing_x_mentions as mentions
      where mentions.account_id = p_account_id
      union all
      select reply_subjects.post_id, reply_subjects.interaction_reference, 1
      from public.marketing_x_reply_subjects as reply_subjects
      where reply_subjects.account_id = p_account_id
    ) as source
    join pg_catalog.jsonb_to_recordset(p_observations) as observation(
      subject_kind text,
      subject_id text,
      outcome text
    ) on observation.outcome <> 'present'
      and (
        observation.subject_kind = 'account'
        or observation.subject_kind = 'post'
          and observation.subject_id = source.post_id
        or observation.subject_kind = 'author'
          and exists (
            select 1
            from public.marketing_x_mentions as author_mentions
            where author_mentions.account_id = p_account_id
              and author_mentions.post_id = source.post_id
              and author_mentions.author_id = observation.subject_id
            union all
            select 1
            from public.marketing_x_reply_subjects as author_subjects
            where author_subjects.account_id = p_account_id
              and author_subjects.post_id = source.post_id
              and author_subjects.author_id = observation.subject_id
          )
      )
    order by source.post_id, source.priority
  )
  update public.marketing_delivery_ledger as ledger
  set interaction_id = affected.interaction_reference
  from affected
  where ledger.channel = 'x'
    and ledger.action = 'reply'
    and ledger.interaction_id = affected.post_id;
  get diagnostics redacted_deliveries = row_count;

  delete from public.marketing_x_compliance_subject_observations as stored
  where stored.account_id = p_account_id
    and exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_observations) as observation(
        subject_kind text,
        subject_id text,
        outcome text
      )
      where observation.outcome <> 'present'
        and (
          observation.subject_kind = 'account'
          or observation.subject_kind = stored.subject_kind
            and observation.subject_id = stored.subject_id
          or observation.subject_kind = 'author'
            and stored.subject_kind = 'post'
            and (
              exists (
                select 1
                from public.marketing_x_mentions as mentions
                where mentions.account_id = p_account_id
                  and mentions.author_id = observation.subject_id
                  and mentions.post_id = stored.subject_id
              )
              or exists (
                select 1
                from public.marketing_x_reply_subjects as reply_subjects
                where reply_subjects.account_id = p_account_id
                  and reply_subjects.author_id = observation.subject_id
                  and reply_subjects.post_id = stored.subject_id
              )
            )
        )
    );

  update public.marketing_x_mention_opt_outs as opt_outs
  set source_post_id = null
  where opt_outs.account_id = p_account_id
    and opt_outs.source_post_id is not null
    and exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_observations) as observation(
        subject_kind text,
        subject_id text,
        outcome text
      )
      where observation.outcome <> 'present'
        and (
          observation.subject_kind = 'account'
          or observation.subject_kind = 'post'
            and observation.subject_id = opt_outs.source_post_id
        )
    );

  delete from public.marketing_x_mention_opt_outs as opt_outs
  where opt_outs.account_id = p_account_id
    and exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_observations) as observation(
        subject_kind text,
        subject_id text,
        outcome text
      )
      where observation.outcome <> 'present'
        and (
          observation.subject_kind = 'account'
          or observation.subject_kind = 'author'
            and observation.subject_id = opt_outs.author_id
        )
    );
  get diagnostics erased_opt_outs = row_count;

  delete from public.marketing_x_reply_subjects as reply_subjects
  where reply_subjects.account_id = p_account_id
    and exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_observations) as observation(
        subject_kind text,
        subject_id text,
        outcome text
      )
      where observation.outcome <> 'present'
        and (
          observation.subject_kind = 'account'
          or observation.subject_kind = 'post'
            and observation.subject_id = reply_subjects.post_id
          or observation.subject_kind = 'author'
            and observation.subject_id = reply_subjects.author_id
        )
    );

  delete from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and exists (
      select 1
      from pg_catalog.jsonb_to_recordset(p_observations) as observation(
        subject_kind text,
        subject_id text,
        outcome text
      )
      where observation.outcome <> 'present'
        and (
          observation.subject_kind = 'account'
          or observation.subject_kind = 'post'
            and observation.subject_id = mentions.post_id
          or observation.subject_kind = 'author'
            and observation.subject_id = mentions.author_id
        )
    );
  get diagnostics erased_mentions = row_count;

  update public.marketing_x_mention_accounts as accounts
  set
    initialized_at = null,
    since_id = null,
    cursor_set_at = null,
    continuation_until_id = null,
    continuation_base_since_id = null,
    continuation_newest_id = null,
    continuation_started_at = null,
    last_success_at = null,
    last_defer_reason = 'compliance_rebaseline',
    updated_at = greatest(
      pg_catalog.clock_timestamp(),
      accounts.updated_at + interval '1 microsecond'
    )
  where accounts.account_id = p_account_id;

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
    'author',
    'provider_lookup_action_required',
    erased_mentions,
    erased_opt_outs,
    redacted_deliveries,
    pg_catalog.clock_timestamp()
  );

  return query select
    'action_required'::text,
    current_checkpoint.checkpoint_id,
    current_checkpoint.lookup_completed_at,
    current_checkpoint.valid_until,
    current_checkpoint.subject_count,
    current_checkpoint.non_present_count;
end;
$function$;

revoke all on function private.record_marketing_x_compliance_checkpoint(
  text, uuid, timestamptz, timestamptz, jsonb
) from public, anon, authenticated, service_role;
grant execute on function private.record_marketing_x_compliance_checkpoint(
  text, uuid, timestamptz, timestamptz, jsonb
) to service_role;

create or replace function public.record_marketing_x_compliance_checkpoint(
  p_account_id text,
  p_provider_run_id uuid,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_observations jsonb
)
returns table (
  result_code text,
  checkpoint_id uuid,
  checked_at timestamptz,
  valid_until timestamptz,
  subject_count integer,
  non_present_count integer
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.record_marketing_x_compliance_checkpoint(
    p_account_id,
    p_provider_run_id,
    p_started_at,
    p_completed_at,
    p_observations
  );
$function$;

revoke all on function public.record_marketing_x_compliance_checkpoint(
  text, uuid, timestamptz, timestamptz, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_marketing_x_compliance_checkpoint(
  text, uuid, timestamptz, timestamptz, jsonb
) to service_role;

create or replace function private.create_marketing_x_reply_subject(
  p_account_id text,
  p_post_id text,
  p_author_id text,
  p_target_url text,
  p_trigger text,
  p_observed_at timestamptz
)
returns table (
  result_code text,
  interaction_reference text,
  trigger text,
  observed_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  created_now timestamptz := pg_catalog.clock_timestamp();
  current_account public.marketing_x_mention_accounts%rowtype;
  current_subject public.marketing_x_reply_subjects%rowtype;
  reference text;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_post_id is null
    or p_post_id !~ '^[1-9][0-9]{0,18}$'
    or p_author_id is null
    or p_author_id !~ '^[1-9][0-9]{0,18}$'
    or p_target_url is null
    or p_target_url !~ '^https://x[.]com/(i/web|[A-Za-z0-9_]{1,15})/status/[1-9][0-9]{0,18}$'
    or pg_catalog.regexp_replace(p_target_url, '^.*/', '') <> p_post_id
    or p_trigger is null
    or p_trigger !~ '^[a-z][a-z0-9_:-]{0,63}$'
    or p_observed_at is null
    or p_observed_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_observed_at < created_now - interval '10 minutes'
    or p_observed_at > created_now + interval '1 minute'
  then
    raise exception 'invalid marketing X reply subject';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-reply:' || p_account_id,
      0
    )
  );

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  if not found then
    return query select
      'not_found'::text,
      null::text,
      null::text,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;
  if current_account.compliance_hold_at is not null then
    return query select
      'compliance_hold'::text,
      null::text,
      null::text,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;
  if not private.marketing_x_compliance_is_fresh(p_account_id, created_now) then
    return query select
      'compliance_stale'::text,
      null::text,
      null::text,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  select reply_subjects.*
  into current_subject
  from public.marketing_x_reply_subjects as reply_subjects
  where reply_subjects.account_id = p_account_id
    and reply_subjects.post_id = p_post_id
  for update;

  if found and current_subject.expires_at <= created_now then
    perform pg_catalog.set_config(
      'openzaps.marketing_x_compliance_erase',
      'true',
      true
    );
    delete from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.interaction_reference = current_subject.interaction_reference;
  elsif found then
    if current_subject.author_id <> p_author_id
      or current_subject.target_url <> p_target_url
      or current_subject.trigger_code <> p_trigger
    then
      raise exception 'marketing X reply subject identity conflict';
    end if;

    return query select
      'created'::text,
      current_subject.interaction_reference,
      current_subject.trigger_code,
      current_subject.observed_at,
      current_subject.expires_at;
    return;
  end if;

  select mentions.interaction_reference
  into reference
  from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and mentions.post_id = p_post_id
    and mentions.author_id = p_author_id;

  if reference is null then
    loop
      reference := private.marketing_x_random_interaction_reference();
      exit when not exists (
        select 1
        from public.marketing_x_mentions as mentions
        where mentions.interaction_reference = reference
        union all
        select 1
        from public.marketing_x_reply_subjects as reply_subjects
        where reply_subjects.interaction_reference = reference
      );
    end loop;
  end if;

  insert into public.marketing_x_reply_subjects (
    interaction_reference,
    account_id,
    post_id,
    author_id,
    target_url,
    trigger_code,
    observed_at,
    state,
    created_at,
    expires_at,
    state_changed_at
  ) values (
    reference,
    p_account_id,
    p_post_id,
    p_author_id,
    p_target_url,
    p_trigger,
    p_observed_at,
    'pending',
    created_now,
    created_now + interval '24 hours',
    created_now
  ) returning * into current_subject;

  return query select
    'created'::text,
    current_subject.interaction_reference,
    current_subject.trigger_code,
    current_subject.observed_at,
    current_subject.expires_at;
end;
$function$;

revoke all on function private.create_marketing_x_reply_subject(
  text, text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function private.create_marketing_x_reply_subject(
  text, text, text, text, text, timestamptz
) to service_role;

create or replace function public.create_marketing_x_reply_subject(
  p_account_id text,
  p_post_id text,
  p_author_id text,
  p_target_url text,
  p_trigger text,
  p_observed_at timestamptz
)
returns table (
  result_code text,
  interaction_reference text,
  trigger text,
  observed_at timestamptz,
  expires_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.create_marketing_x_reply_subject(
    p_account_id,
    p_post_id,
    p_author_id,
    p_target_url,
    p_trigger,
    p_observed_at
  );
$function$;

revoke all on function public.create_marketing_x_reply_subject(
  text, text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.create_marketing_x_reply_subject(
  text, text, text, text, text, timestamptz
) to service_role;

create or replace function private.get_marketing_x_reply_subject(
  p_interaction_reference text
)
returns table (
  result_code text,
  interaction_reference text,
  trigger text,
  observed_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  checked_at timestamptz := pg_catalog.clock_timestamp();
  current_subject public.marketing_x_reply_subjects%rowtype;
  current_account public.marketing_x_mention_accounts%rowtype;
begin
  if p_interaction_reference is null
    or p_interaction_reference !~ '^[1-9][0-9]{29}$'
  then
    raise exception 'invalid marketing X reply subject reference';
  end if;

  select reply_subjects.*
  into current_subject
  from public.marketing_x_reply_subjects as reply_subjects
  where reply_subjects.interaction_reference = p_interaction_reference;

  if not found then
    return query select
      'not_found'::text,
      p_interaction_reference,
      null::text,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;
  if current_subject.expires_at <= checked_at then
    return query select
      'expired'::text,
      current_subject.interaction_reference,
      null::text,
      null::timestamptz,
      current_subject.expires_at;
    return;
  end if;

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = current_subject.account_id;

  if current_account.compliance_hold_at is not null then
    return query select
      'compliance_hold'::text,
      current_subject.interaction_reference,
      null::text,
      null::timestamptz,
      current_subject.expires_at;
    return;
  end if;
  if not private.marketing_x_compliance_is_fresh(
    current_subject.account_id,
    checked_at
  ) then
    return query select
      'compliance_stale'::text,
      current_subject.interaction_reference,
      null::text,
      null::timestamptz,
      current_subject.expires_at;
    return;
  end if;

  return query select
    'found'::text,
    current_subject.interaction_reference,
    current_subject.trigger_code,
    current_subject.observed_at,
    current_subject.expires_at;
end;
$function$;

revoke all on function private.get_marketing_x_reply_subject(text)
  from public, anon, authenticated, service_role;
grant execute on function private.get_marketing_x_reply_subject(text)
  to service_role;

create or replace function public.get_marketing_x_reply_subject(
  p_interaction_reference text
)
returns table (
  result_code text,
  interaction_reference text,
  trigger text,
  observed_at timestamptz,
  expires_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.get_marketing_x_reply_subject(p_interaction_reference);
$function$;

revoke all on function public.get_marketing_x_reply_subject(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_x_reply_subject(text)
  to service_role;

create or replace function private.claim_marketing_x_reply_subject_admission(
  p_interaction_reference text,
  p_idempotency_key text
)
returns table (
  result_code text,
  interaction_reference text,
  claim_token uuid,
  claim_expires_at timestamptz,
  account_id text,
  post_id text,
  author_id text,
  target_url text,
  trigger text,
  observed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_time timestamptz := pg_catalog.clock_timestamp();
  current_subject public.marketing_x_reply_subjects%rowtype;
  current_account public.marketing_x_mention_accounts%rowtype;
begin
  if p_interaction_reference is null
    or p_interaction_reference !~ '^[1-9][0-9]{29}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  then
    raise exception 'invalid marketing X reply subject admission claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-reply-subject:' || p_interaction_reference,
      0
    )
  );

  select reply_subjects.*
  into current_subject
  from public.marketing_x_reply_subjects as reply_subjects
  where reply_subjects.interaction_reference = p_interaction_reference;

  if not found then
    return query select
      'not_found'::text,
      p_interaction_reference,
      null::uuid,
      null::timestamptz,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-compliance:' || current_subject.account_id,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-reply:' || current_subject.account_id,
      0
    )
  );

  select reply_subjects.*
  into current_subject
  from public.marketing_x_reply_subjects as reply_subjects
  where reply_subjects.interaction_reference = p_interaction_reference
  for update;

  if not found then
    return query select
      'not_found'::text,
      p_interaction_reference,
      null::uuid,
      null::timestamptz,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz;
    return;
  end if;

  claim_time := pg_catalog.clock_timestamp();
  if current_subject.expires_at <= claim_time
    or current_subject.claim_expires_at is not null
      and current_subject.claim_expires_at <= claim_time
  then
    return query select
      'expired'::text,
      current_subject.interaction_reference,
      null::uuid,
      null::timestamptz,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz;
    return;
  end if;

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = current_subject.account_id
  for update;

  if current_account.compliance_hold_at is not null then
    return query select
      'compliance_hold'::text,
      current_subject.interaction_reference,
      null::uuid,
      null::timestamptz,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz;
    return;
  end if;
  if not private.marketing_x_compliance_is_fresh(
    current_subject.account_id,
    claim_time
  ) then
    return query select
      'compliance_stale'::text,
      current_subject.interaction_reference,
      null::uuid,
      null::timestamptz,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz;
    return;
  end if;

  if current_subject.state <> 'pending' then
    return query select
      'already_claimed'::text,
      current_subject.interaction_reference,
      null::uuid,
      null::timestamptz,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz;
    return;
  end if;

  claim_time := greatest(
    claim_time,
    current_subject.state_changed_at + interval '1 microsecond'
  );
  update public.marketing_x_reply_subjects as reply_subjects
  set
    state = 'resolving',
    idempotency_key = p_idempotency_key,
    claim_token = pg_catalog.gen_random_uuid(),
    claim_started_at = claim_time,
    claim_expires_at = claim_time + interval '2 minutes',
    state_changed_at = claim_time
  where reply_subjects.interaction_reference = p_interaction_reference
  returning * into current_subject;

  return query select
    'claimed'::text,
    current_subject.interaction_reference,
    current_subject.claim_token,
    current_subject.claim_expires_at,
    current_subject.account_id,
    current_subject.post_id,
    current_subject.author_id,
    current_subject.target_url,
    current_subject.trigger_code,
    current_subject.observed_at;
end;
$function$;

revoke all on function private.claim_marketing_x_reply_subject_admission(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.claim_marketing_x_reply_subject_admission(text, text)
  to service_role;

create or replace function public.claim_marketing_x_reply_subject_admission(
  p_interaction_reference text,
  p_idempotency_key text
)
returns table (
  result_code text,
  interaction_reference text,
  claim_token uuid,
  claim_expires_at timestamptz,
  account_id text,
  post_id text,
  author_id text,
  target_url text,
  trigger text,
  observed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.claim_marketing_x_reply_subject_admission(
    p_interaction_reference,
    p_idempotency_key
  );
$function$;

revoke all on function public.claim_marketing_x_reply_subject_admission(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_marketing_x_reply_subject_admission(text, text)
  to service_role;

create or replace function private.get_marketing_x_compliance_health(
  p_account_id text
)
returns table (
  result_code text,
  checkpoint_id uuid,
  checked_at timestamptz,
  valid_until timestamptz,
  subject_count integer,
  non_present_count integer,
  hold boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  checked_now timestamptz := pg_catalog.clock_timestamp();
  current_account public.marketing_x_mention_accounts%rowtype;
  current_checkpoint public.marketing_x_compliance_checkpoints%rowtype;
begin
  if p_account_id is null or p_account_id !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid marketing X compliance health request';
  end if;

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id;

  if not found then
    return query select
      'account_not_found'::text,
      null::uuid,
      null::timestamptz,
      null::timestamptz,
      0,
      0,
      false;
    return;
  end if;

  if current_account.compliance_checkpoint_id is not null then
    select checkpoints.*
    into current_checkpoint
    from public.marketing_x_compliance_checkpoints as checkpoints
    where checkpoints.checkpoint_id = current_account.compliance_checkpoint_id;
  end if;

  return query select
    case
      when current_account.compliance_hold_at is not null then 'hold'::text
      when current_account.initialized_at is null then 'not_initialized'::text
      when private.marketing_x_compliance_is_fresh(p_account_id, checked_now)
        then 'healthy'::text
      else 'stale'::text
    end,
    current_account.compliance_checkpoint_id,
    current_account.compliance_checked_at,
    current_account.compliance_valid_until,
    coalesce(current_checkpoint.subject_count, 0),
    coalesce(current_checkpoint.non_present_count, 0),
    current_account.compliance_hold_at is not null;
end;
$function$;

revoke all on function private.get_marketing_x_compliance_health(text)
  from public, anon, authenticated, service_role;
grant execute on function private.get_marketing_x_compliance_health(text)
  to service_role;

create or replace function public.get_marketing_x_compliance_health(
  p_account_id text
)
returns table (
  result_code text,
  checkpoint_id uuid,
  checked_at timestamptz,
  valid_until timestamptz,
  subject_count integer,
  non_present_count integer,
  hold boolean
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.get_marketing_x_compliance_health(p_account_id);
$function$;

revoke all on function public.get_marketing_x_compliance_health(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_x_compliance_health(text)
  to service_role;

create or replace function private.admit_marketing_x_outbound_delivery(
  p_account_id text,
  p_interaction_reference text,
  p_post_id text,
  p_author_id text,
  p_source_claim_token uuid,
  p_provider_checked_at timestamptz
)
returns table (
  result_code text,
  admission_token uuid,
  admission_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  admission_time timestamptz := pg_catalog.clock_timestamp();
  current_account public.marketing_x_mention_accounts%rowtype;
  current_mention public.marketing_x_mentions%rowtype;
  current_subject public.marketing_x_reply_subjects%rowtype;
  current_admission public.marketing_x_outbound_admissions%rowtype;
  lane_code text;
  source_claimed_at timestamptz;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_interaction_reference is null
    or p_interaction_reference !~ '^[1-9][0-9]{29}$'
    or p_post_id is null
    or p_post_id !~ '^[1-9][0-9]{0,18}$'
    or p_author_id is null
    or p_author_id !~ '^[1-9][0-9]{0,18}$'
    or p_source_claim_token is null
    or p_provider_checked_at is null
    or p_provider_checked_at in (
      '-infinity'::timestamptz,
      'infinity'::timestamptz
    )
    or p_provider_checked_at < admission_time - interval '2 minutes'
    or p_provider_checked_at > admission_time + interval '1 minute'
  then
    raise exception 'invalid marketing X outbound admission';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-reply:' || p_account_id,
      0
    )
  );

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  admission_time := pg_catalog.clock_timestamp();
  if not found then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if current_account.compliance_hold_at is not null then
    return query select 'compliance_hold'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if not private.marketing_x_compliance_is_fresh(p_account_id, admission_time) then
    return query select 'compliance_stale'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select mentions.*
  into current_mention
  from public.marketing_x_mentions as mentions
  where mentions.account_id = p_account_id
    and mentions.interaction_reference = p_interaction_reference
  for update;

  if found then
    lane_code := 'mention';
    source_claimed_at := current_mention.claimed_at;
    if current_mention.post_id <> p_post_id
      or current_mention.author_id <> p_author_id
      or current_mention.state <> 'claimed'
      or current_mention.reply_claim_token is distinct from p_source_claim_token
    then
      return query select 'claim_conflict'::text, null::uuid, null::timestamptz;
      return;
    end if;
    if not private.marketing_x_subject_is_covered(
      p_account_id,
      'post',
      p_post_id,
      admission_time
    ) or not private.marketing_x_subject_is_covered(
      p_account_id,
      'author',
      p_author_id,
      admission_time
    ) then
      return query select
        'subject_compliance_stale'::text,
        null::uuid,
        null::timestamptz;
      return;
    end if;
  else
    select reply_subjects.*
    into current_subject
    from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.account_id = p_account_id
      and reply_subjects.interaction_reference = p_interaction_reference
    for update;

    if not found then
      return query select 'not_found'::text, null::uuid, null::timestamptz;
      return;
    end if;
    lane_code := 'manual';
    source_claimed_at := current_subject.claim_started_at;
    if current_subject.post_id <> p_post_id
      or current_subject.author_id <> p_author_id
      or current_subject.state <> 'resolving'
      or current_subject.claim_token is distinct from p_source_claim_token
      or current_subject.expires_at <= admission_time
      or current_subject.claim_expires_at <= admission_time
    then
      return query select 'claim_conflict'::text, null::uuid, null::timestamptz;
      return;
    end if;
  end if;

  if source_claimed_at is null
    or p_provider_checked_at < source_claimed_at
  then
    return query select
      'provider_check_stale'::text,
      null::uuid,
      null::timestamptz;
    return;
  end if;

  select admissions.*
  into current_admission
  from public.marketing_x_outbound_admissions as admissions
  where admissions.account_id = p_account_id
    and admissions.interaction_reference = p_interaction_reference
    and admissions.source_claim_token = p_source_claim_token
  for update;

  if found then
    return query select
      case
        when current_admission.state = 'active'
          and current_admission.expires_at > admission_time
          then 'already_admitted'::text
        else 'already_consumed'::text
      end,
      current_admission.admission_token,
      current_admission.expires_at;
    return;
  end if;

  insert into public.marketing_x_outbound_admissions (
    account_id,
    interaction_reference,
    lane,
    source_claim_token,
    checkpoint_id,
    provider_checked_at,
    state,
    admitted_at,
    expires_at,
    state_changed_at
  ) values (
    p_account_id,
    p_interaction_reference,
    lane_code,
    p_source_claim_token,
    current_account.compliance_checkpoint_id,
    p_provider_checked_at,
    'active',
    admission_time,
    admission_time + interval '10 seconds',
    admission_time
  ) returning * into current_admission;

  if lane_code = 'manual' then
    update public.marketing_x_reply_subjects as reply_subjects
    set
      state = 'admitted',
      state_changed_at = greatest(
        admission_time,
        reply_subjects.state_changed_at + interval '1 microsecond'
      )
    where reply_subjects.interaction_reference = p_interaction_reference;
  end if;

  return query select
    'admitted'::text,
    current_admission.admission_token,
    current_admission.expires_at;
end;
$function$;

revoke all on function private.admit_marketing_x_outbound_delivery(
  text, text, text, text, uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function private.admit_marketing_x_outbound_delivery(
  text, text, text, text, uuid, timestamptz
) to service_role;

create or replace function public.admit_marketing_x_outbound_delivery(
  p_account_id text,
  p_interaction_reference text,
  p_post_id text,
  p_author_id text,
  p_source_claim_token uuid,
  p_provider_checked_at timestamptz
)
returns table (
  result_code text,
  admission_token uuid,
  admission_expires_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.admit_marketing_x_outbound_delivery(
    p_account_id,
    p_interaction_reference,
    p_post_id,
    p_author_id,
    p_source_claim_token,
    p_provider_checked_at
  );
$function$;

revoke all on function public.admit_marketing_x_outbound_delivery(
  text, text, text, text, uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.admit_marketing_x_outbound_delivery(
  text, text, text, text, uuid, timestamptz
) to service_role;

create or replace function private.check_marketing_x_outbound_admission(
  p_admission_token uuid
)
returns table (
  result_code text,
  allowed boolean,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  checked_now timestamptz := pg_catalog.clock_timestamp();
  current_admission public.marketing_x_outbound_admissions%rowtype;
  admission_account_id text;
  denial_code text;
begin
  if p_admission_token is null then
    raise exception 'invalid marketing X outbound admission token';
  end if;

  select admissions.account_id
  into admission_account_id
  from public.marketing_x_outbound_admissions as admissions
  where admissions.admission_token = p_admission_token;

  if not found then
    return query select 'not_found'::text, false, null::timestamptz;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-compliance:' || admission_account_id,
      0
    )
  );

  select admissions.*
  into current_admission
  from public.marketing_x_outbound_admissions as admissions
  where admissions.admission_token = p_admission_token
  for update;

  if not found then
    return query select 'not_found'::text, false, null::timestamptz;
    return;
  end if;
  if current_admission.state <> 'active' then
    return query select
      current_admission.state,
      false,
      current_admission.expires_at;
    return;
  end if;
  checked_now := pg_catalog.clock_timestamp();

  if current_admission.expires_at <= checked_now then
    denial_code := 'lease_expired';
  elsif exists (
    select 1
    from public.marketing_x_mention_accounts as accounts
    where accounts.account_id = current_admission.account_id
      and accounts.compliance_hold_at is not null
  ) then
    denial_code := 'compliance_hold';
  elsif not private.marketing_x_compliance_is_fresh(
    current_admission.account_id,
    checked_now
  ) then
    denial_code := 'compliance_stale';
  end if;

  if denial_code is not null then
    update public.marketing_x_outbound_admissions as admissions
    set
      state = 'revoked',
      failure_code = denial_code,
      finalized_at = checked_now,
      state_changed_at = greatest(
        checked_now,
        admissions.state_changed_at + interval '1 microsecond'
      )
    where admissions.admission_token = p_admission_token
    returning * into current_admission;

    return query select
      denial_code,
      false,
      current_admission.expires_at;
    return;
  end if;

  return query select
    'allowed'::text,
    true,
    current_admission.expires_at;
end;
$function$;

revoke all on function private.check_marketing_x_outbound_admission(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.check_marketing_x_outbound_admission(uuid)
  to service_role;

create or replace function public.check_marketing_x_outbound_admission(
  p_admission_token uuid
)
returns table (
  result_code text,
  allowed boolean,
  expires_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.check_marketing_x_outbound_admission(p_admission_token);
$function$;

revoke all on function public.check_marketing_x_outbound_admission(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.check_marketing_x_outbound_admission(uuid)
  to service_role;

create or replace function private.finalize_marketing_x_outbound_admission(
  p_admission_token uuid,
  p_outcome text,
  p_failure_code text
)
returns table (
  result_code text,
  state text,
  finalized_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  finalize_time timestamptz := pg_catalog.clock_timestamp();
  current_admission public.marketing_x_outbound_admissions%rowtype;
begin
  if p_admission_token is null
    or p_outcome not in ('completed', 'failed')
    or (
      p_outcome = 'completed'
      and p_failure_code is not null
    )
    or (
      p_outcome = 'failed'
      and (
        p_failure_code is null
        or p_failure_code !~ '^[a-z][a-z0-9_:-]{0,63}$'
      )
    )
  then
    raise exception 'invalid marketing X outbound admission finalization';
  end if;

  select admissions.*
  into current_admission
  from public.marketing_x_outbound_admissions as admissions
  where admissions.admission_token = p_admission_token
  for update;

  if not found then
    return query select
      'not_found'::text,
      null::text,
      null::timestamptz;
    return;
  end if;
  if current_admission.state <> 'active' then
    return query select
      'already_finalized'::text,
      current_admission.state,
      current_admission.finalized_at;
    return;
  end if;

  finalize_time := greatest(
    finalize_time,
    current_admission.state_changed_at + interval '1 microsecond'
  );
  update public.marketing_x_outbound_admissions as admissions
  set
    state = p_outcome,
    failure_code = p_failure_code,
    finalized_at = finalize_time,
    state_changed_at = finalize_time
  where admissions.admission_token = p_admission_token
  returning * into current_admission;

  if current_admission.lane = 'manual' then
    perform pg_catalog.set_config(
      'openzaps.marketing_x_compliance_erase',
      'true',
      true
    );
    delete from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.interaction_reference =
      current_admission.interaction_reference
      and reply_subjects.claim_token = current_admission.source_claim_token;
  end if;

  return query select
    'finalized'::text,
    current_admission.state,
    current_admission.finalized_at;
end;
$function$;

revoke all on function private.finalize_marketing_x_outbound_admission(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.finalize_marketing_x_outbound_admission(
  uuid, text, text
) to service_role;

create or replace function public.finalize_marketing_x_outbound_admission(
  p_admission_token uuid,
  p_outcome text,
  p_failure_code text
)
returns table (
  result_code text,
  state text,
  finalized_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.finalize_marketing_x_outbound_admission(
    p_admission_token,
    p_outcome,
    p_failure_code
  );
$function$;

revoke all on function public.finalize_marketing_x_outbound_admission(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_marketing_x_outbound_admission(
  uuid, text, text
) to service_role;

create or replace function private.enforce_marketing_x_account_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  erasing boolean := pg_catalog.current_setting(
    'openzaps.marketing_x_compliance_erase',
    true
  ) = 'true';
begin
  if new.eligibility_cutoff_at is distinct from old.eligibility_cutoff_at then
    raise exception 'marketing X eligibility cutoff is immutable';
  end if;

  if new.since_id is distinct from old.since_id then
    if new.since_id is null then
      if not erasing then
        raise exception 'marketing X mention cursor may clear only for compliance';
      end if;
      new.cursor_set_at := null;
    else
      new.cursor_set_at := greatest(
        pg_catalog.clock_timestamp(),
        coalesce(old.cursor_set_at, old.created_at) + interval '1 microsecond'
      );
    end if;
  elsif new.cursor_set_at is distinct from old.cursor_set_at then
    raise exception 'marketing X mention cursor timestamp is immutable';
  end if;

  if erasing then
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
    or (
      old.compliance_checked_at is not null
      and new.compliance_checked_at < old.compliance_checked_at
    )
    or (
      new.compliance_checkpoint_id is distinct from old.compliance_checkpoint_id
      and (
        new.compliance_checkpoint_id is null
        or new.compliance_checked_at is null
        or new.compliance_valid_until is null
      )
    )
    or new.updated_at < old.updated_at
  then
    raise exception 'invalid marketing X mention account transition';
  end if;

  return new;
end;
$function$;

create or replace function private.fence_marketing_x_admissions_on_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  fenced_at timestamptz := pg_catalog.clock_timestamp();
begin
  if old.compliance_hold_at is null and new.compliance_hold_at is not null then
    update public.marketing_x_outbound_admissions as admissions
    set
      state = 'revoked',
      failure_code = 'compliance_hold',
      finalized_at = fenced_at,
      state_changed_at = greatest(
        fenced_at,
        admissions.state_changed_at + interval '1 microsecond'
      )
    where admissions.account_id = new.account_id
      and admissions.state = 'active';
  end if;
  return null;
end;
$function$;

revoke all on function private.fence_marketing_x_admissions_on_hold()
  from public, anon, authenticated, service_role;

drop trigger if exists marketing_x_compliance_hold_admission_fence
on public.marketing_x_mention_accounts;
create trigger marketing_x_compliance_hold_admission_fence
after update of compliance_hold_at on public.marketing_x_mention_accounts
for each row execute function private.fence_marketing_x_admissions_on_hold();

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
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-poll:' || p_account_id,
      0
    )
  );

  insert into public.marketing_x_mention_accounts (
    account_id,
    eligibility_cutoff_at,
    next_poll_at,
    created_at,
    updated_at
  ) values (
    p_account_id,
    claimed_at,
    claimed_at,
    claimed_at,
    claimed_at
  ) on conflict on constraint marketing_x_mention_accounts_pkey do nothing;

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  claimed_at := greatest(
    pg_catalog.clock_timestamp(),
    current_account.updated_at
  );

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

  if not private.marketing_x_compliance_is_fresh(p_account_id, claimed_at) then
    return query select
      'compliance_stale'::text,
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
  uncovered_exists boolean := false;
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
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-mention-reply:' || p_account_id,
      0
    )
  );

  select accounts.*
  into current_account
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id
  for update;

  if not found or current_account.initialized_at is null then
    return query select
      'not_initialized'::text, p_account_id,
      null::text, null::text, null::text, null::timestamptz,
      null::text, null::uuid, null::text, null::text, null::text,
      null::text, null::uuid, null::date, null::timestamptz;
    return;
  end if;

  claim_time := pg_catalog.clock_timestamp();
  utc_day := (claim_time at time zone 'UTC')::date;

  if current_account.compliance_hold_at is not null then
    return query select
      'compliance_hold'::text, p_account_id,
      null::text, null::text, null::text, null::timestamptz,
      null::text, null::uuid, null::text, null::text, null::text,
      null::text, null::uuid, utc_day, null::timestamptz;
    return;
  end if;

  if not private.marketing_x_compliance_is_fresh(p_account_id, claim_time) then
    return query select
      'compliance_stale'::text, p_account_id,
      null::text, null::text, null::text, null::timestamptz,
      null::text, null::uuid, null::text, null::text, null::text,
      null::text, null::uuid, utc_day, null::timestamptz;
    return;
  end if;

  if current_account.continuation_until_id is not null then
    return query select
      'poll_incomplete'::text, p_account_id,
      null::text, null::text, null::text, null::timestamptz,
      null::text, null::uuid, null::text, null::text, null::text,
      null::text, null::uuid, utc_day, null::timestamptz;
    return;
  end if;

  if (
    select count(*)
    from public.marketing_x_mentions as claimed
    where claimed.account_id = p_account_id
      and claimed.reply_claim_day = utc_day
  ) >= p_daily_cap then
    return query select
      'daily_cap_reached'::text, p_account_id,
      null::text, null::text, null::text, null::timestamptz,
      null::text, null::uuid, null::text, null::text, null::text,
      null::text, null::uuid, utc_day, null::timestamptz;
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
    and mentions.source_created_at > current_account.eligibility_cutoff_at
    and mentions.source_created_at >= claim_time - interval '24 hours'
    and mentions.source_created_at <= claim_time + interval '5 minutes'
    and private.marketing_x_subject_is_covered(
      p_account_id,
      'post',
      mentions.post_id,
      claim_time
    )
    and private.marketing_x_subject_is_covered(
      p_account_id,
      'author',
      mentions.author_id,
      claim_time
    )
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
    select exists (
      select 1
      from public.marketing_x_mentions as mentions
      where mentions.account_id = p_account_id
        and mentions.state = 'eligible'
        and mentions.classification = 'auto_reply'
        and mentions.source_created_at > current_account.eligibility_cutoff_at
        and (
          not private.marketing_x_subject_is_covered(
            p_account_id,
            'post',
            mentions.post_id,
            claim_time
          )
          or not private.marketing_x_subject_is_covered(
            p_account_id,
            'author',
            mentions.author_id,
            claim_time
          )
        )
    ) into uncovered_exists;

    return query select
      case
        when uncovered_exists then 'subject_compliance_stale'::text
        else 'no_eligible'::text
      end,
      p_account_id,
      null::text, null::text, null::text, null::timestamptz,
      null::text, null::uuid, null::text, null::text, null::text,
      null::text, null::uuid, utc_day, null::timestamptz;
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
  current_checkpoint public.marketing_x_compliance_checkpoints%rowtype;
  cleared_at timestamptz := pg_catalog.clock_timestamp();
  verification_checkpoint_id uuid;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_verification_code is null
    or p_verification_code !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception 'invalid marketing X compliance hold clearance';
  end if;
  verification_checkpoint_id := p_verification_code::uuid;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );
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

  select checkpoints.*
  into current_checkpoint
  from public.marketing_x_compliance_checkpoints as checkpoints
  where checkpoints.checkpoint_id = verification_checkpoint_id
    and checkpoints.account_id = p_account_id
    and checkpoints.status = 'healthy';

  cleared_at := pg_catalog.clock_timestamp();
  if not found
    or current_account.compliance_checkpoint_id is distinct from
      verification_checkpoint_id
    or current_checkpoint.lookup_started_at < current_account.compliance_hold_at
    or current_checkpoint.lookup_completed_at < current_account.compliance_hold_at
    or current_checkpoint.valid_until <= cleared_at
    or exists (
      select 1
      from public.marketing_x_outbound_admissions as admissions
      where admissions.account_id = p_account_id
        and admissions.state = 'active'
        and admissions.expires_at > cleared_at
    )
  then
    return query select
      'verification_required'::text,
      p_account_id,
      null::timestamptz;
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
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );
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

  -- Fence first. The account hold trigger revokes every active final-admission
  -- lease in this same transaction before any subject identifier is deleted.
  update public.marketing_x_mention_accounts as accounts
  set
    compliance_hold_at = coalesce(accounts.compliance_hold_at, erased_at),
    compliance_hold_reason = coalesce(accounts.compliance_hold_reason, p_reason),
    poll_lease_token = null,
    poll_lease_expires_at = null,
    next_poll_at = erased_at,
    last_defer_reason = 'compliance_hold',
    updated_at = greatest(
      erased_at,
      accounts.updated_at + interval '1 microsecond'
    )
  where accounts.account_id = p_account_id;

  perform pg_catalog.set_config(
    'openzaps.marketing_x_compliance_erase',
    'true',
    true
  );

  with affected as (
    select distinct on (source.post_id)
      source.post_id,
      source.interaction_reference
    from (
      select mentions.post_id, mentions.interaction_reference, 0 as priority
      from public.marketing_x_mentions as mentions
      where mentions.account_id = p_account_id
        and (
          requested_scope = 'post' and mentions.post_id = p_post_id
          or requested_scope = 'author' and mentions.author_id = p_author_id
        )
      union all
      select reply_subjects.post_id, reply_subjects.interaction_reference, 1
      from public.marketing_x_reply_subjects as reply_subjects
      where reply_subjects.account_id = p_account_id
        and (
          requested_scope = 'post' and reply_subjects.post_id = p_post_id
          or requested_scope = 'author' and reply_subjects.author_id = p_author_id
        )
    ) as source
    order by source.post_id, source.priority
  )
  update public.marketing_delivery_ledger as ledger
  set interaction_id = affected.interaction_reference
  from affected
  where ledger.channel = 'x'
    and ledger.action = 'reply'
    and ledger.interaction_id = affected.post_id;
  get diagnostics redacted_deliveries = row_count;

  delete from public.marketing_x_compliance_subject_observations as observations
  where observations.account_id = p_account_id
    and (
      requested_scope = 'post'
        and observations.subject_kind = 'post'
        and observations.subject_id = p_post_id
      or requested_scope = 'author'
        and (
          observations.subject_kind = 'author'
            and observations.subject_id = p_author_id
          or observations.subject_kind = 'post'
            and (
              exists (
                select 1
                from public.marketing_x_mentions as mentions
                where mentions.account_id = p_account_id
                  and mentions.author_id = p_author_id
                  and mentions.post_id = observations.subject_id
              )
              or exists (
                select 1
                from public.marketing_x_reply_subjects as reply_subjects
                where reply_subjects.account_id = p_account_id
                  and reply_subjects.author_id = p_author_id
                  and reply_subjects.post_id = observations.subject_id
              )
            )
        )
    );

  if requested_scope = 'author' then
    delete from public.marketing_x_mention_opt_outs as opt_outs
    where opt_outs.account_id = p_account_id
      and opt_outs.author_id = p_author_id;
    get diagnostics erased_opt_outs = row_count;

    delete from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.account_id = p_account_id
      and reply_subjects.author_id = p_author_id;

    delete from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
      and mentions.author_id = p_author_id;
    get diagnostics erased_mentions = row_count;
  else
    update public.marketing_x_mention_opt_outs as opt_outs
    set source_post_id = null
    where opt_outs.account_id = p_account_id
      and opt_outs.source_post_id = p_post_id;

    delete from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.account_id = p_account_id
      and reply_subjects.post_id = p_post_id;

    delete from public.marketing_x_mentions as mentions
    where mentions.account_id = p_account_id
      and mentions.post_id = p_post_id;
    get diagnostics erased_mentions = row_count;
  end if;

  erased_at := pg_catalog.clock_timestamp();
  update public.marketing_x_mention_accounts as accounts
  set
    initialized_at = null,
    since_id = null,
    cursor_set_at = null,
    continuation_until_id = null,
    continuation_base_since_id = null,
    continuation_newest_id = null,
    continuation_started_at = null,
    poll_lease_token = null,
    poll_lease_expires_at = null,
    next_poll_at = erased_at,
    last_success_at = null,
    last_defer_reason = 'compliance_rebaseline',
    updated_at = greatest(
      erased_at,
      accounts.updated_at + interval '1 microsecond'
    )
  where accounts.account_id = p_account_id;

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

create or replace function private.purge_marketing_x_retention(
  p_now timestamptz
)
returns table (
  result_code text,
  expired_subject_count integer,
  deleted_mention_count integer,
  deleted_opt_out_count integer,
  deleted_admission_count integer,
  deleted_checkpoint_count integer,
  deleted_compliance_event_count integer,
  reset_cursor_count integer,
  processed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  database_now timestamptz := pg_catalog.clock_timestamp();
  processed timestamptz;
  subject_count integer := 0;
  mention_count integer := 0;
  opt_out_count integer := 0;
  admission_count integer := 0;
  checkpoint_count integer := 0;
  compliance_event_count integer := 0;
  cursor_count integer := 0;
begin
  if p_now is null
    or p_now in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_now < database_now - interval '5 minutes'
    or p_now > database_now + interval '5 minutes'
  then
    raise exception 'invalid marketing X retention boundary';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-marketing-x-retention', 0)
  );
  perform pg_catalog.set_config(
    'openzaps.marketing_x_compliance_erase',
    'true',
    true
  );

  update public.marketing_x_outbound_admissions as admissions
  set
    state = 'revoked',
    failure_code = 'lease_expired',
    finalized_at = p_now,
    state_changed_at = greatest(
      p_now,
      admissions.state_changed_at + interval '1 microsecond'
    )
  where admissions.state = 'active'
    and admissions.expires_at <= p_now;

  with expired as (
    select distinct on (reply_subjects.post_id)
      reply_subjects.post_id,
      reply_subjects.interaction_reference
    from public.marketing_x_reply_subjects as reply_subjects
    where reply_subjects.expires_at <= p_now
      or reply_subjects.claim_expires_at <= p_now
    order by reply_subjects.post_id, reply_subjects.created_at
  )
  update public.marketing_delivery_ledger as ledger
  set interaction_id = expired.interaction_reference
  from expired
  where ledger.channel = 'x'
    and ledger.action = 'reply'
    and ledger.interaction_id = expired.post_id;

  delete from public.marketing_x_reply_subjects as reply_subjects
  where reply_subjects.expires_at <= p_now
    or reply_subjects.claim_expires_at <= p_now;
  get diagnostics subject_count = row_count;

  delete from public.marketing_x_compliance_subject_observations as observations
  where observations.expires_at <= p_now;

  update public.marketing_x_mention_accounts as accounts
  set
    initialized_at = null,
    since_id = null,
    cursor_set_at = null,
    continuation_until_id = null,
    continuation_base_since_id = null,
    continuation_newest_id = null,
    continuation_started_at = null,
    poll_lease_token = null,
    poll_lease_expires_at = null,
    next_poll_at = p_now,
    last_success_at = null,
    last_defer_reason = 'retention_rebaseline',
    updated_at = greatest(
      p_now,
      accounts.updated_at + interval '1 microsecond'
    )
  where accounts.cursor_set_at <= p_now - interval '30 days';
  get diagnostics cursor_count = row_count;

  with expired as (
    select mentions.post_id, mentions.interaction_reference
    from public.marketing_x_mentions as mentions
    where mentions.discovered_at <= p_now - interval '30 days'
      and not exists (
        select 1
        from public.marketing_x_outbound_admissions as admissions
        where admissions.account_id = mentions.account_id
          and admissions.interaction_reference = mentions.interaction_reference
          and admissions.state = 'active'
      )
  )
  update public.marketing_delivery_ledger as ledger
  set interaction_id = expired.interaction_reference
  from expired
  where ledger.channel = 'x'
    and ledger.action = 'reply'
    and ledger.interaction_id = expired.post_id;

  update public.marketing_x_mention_opt_outs as opt_outs
  set source_post_id = null
  where opt_outs.source_post_id in (
    select mentions.post_id
    from public.marketing_x_mentions as mentions
    where mentions.discovered_at <= p_now - interval '30 days'
      and not exists (
        select 1
        from public.marketing_x_outbound_admissions as admissions
        where admissions.account_id = mentions.account_id
          and admissions.interaction_reference = mentions.interaction_reference
          and admissions.state = 'active'
      )
  );

  delete from public.marketing_x_compliance_subject_observations as observations
  where observations.subject_kind = 'post'
    and exists (
      select 1
      from public.marketing_x_mentions as mentions
      where mentions.account_id = observations.account_id
        and mentions.post_id = observations.subject_id
        and mentions.discovered_at <= p_now - interval '30 days'
    );

  delete from public.marketing_x_mentions as mentions
  where mentions.discovered_at <= p_now - interval '30 days'
    and not exists (
      select 1
      from public.marketing_x_outbound_admissions as admissions
      where admissions.account_id = mentions.account_id
        and admissions.interaction_reference = mentions.interaction_reference
        and admissions.state = 'active'
    );
  get diagnostics mention_count = row_count;

  delete from public.marketing_x_mention_opt_outs as opt_outs
  where opt_outs.opted_out_at <= p_now - interval '90 days';
  get diagnostics opt_out_count = row_count;

  delete from public.marketing_x_outbound_admissions as admissions
  where admissions.state <> 'active'
    and admissions.admitted_at <= p_now - interval '7 days';
  get diagnostics admission_count = row_count;

  update public.marketing_x_mention_accounts as accounts
  set
    compliance_checkpoint_id = null,
    compliance_checked_at = null,
    compliance_valid_until = null,
    updated_at = greatest(
      p_now,
      accounts.updated_at + interval '1 microsecond'
    )
  where accounts.compliance_checkpoint_id in (
    select checkpoints.checkpoint_id
    from public.marketing_x_compliance_checkpoints as checkpoints
    where checkpoints.lookup_completed_at <= p_now - interval '30 days'
  );

  delete from public.marketing_x_compliance_subject_observations as observations
  where observations.checkpoint_id in (
    select checkpoints.checkpoint_id
    from public.marketing_x_compliance_checkpoints as checkpoints
    where checkpoints.lookup_completed_at <= p_now - interval '30 days'
  );

  delete from public.marketing_x_compliance_checkpoints as checkpoints
  where checkpoints.lookup_completed_at <= p_now - interval '30 days';
  get diagnostics checkpoint_count = row_count;

  delete from public.marketing_x_compliance_events as events
  where events.processed_at <= p_now - interval '365 days';
  get diagnostics compliance_event_count = row_count;

  delete from public.marketing_x_retention_events as events
  where events.processed_at <= p_now - interval '365 days';

  processed := pg_catalog.clock_timestamp();
  insert into public.marketing_x_retention_events (
    expired_subject_count,
    deleted_mention_count,
    deleted_opt_out_count,
    deleted_admission_count,
    deleted_checkpoint_count,
    deleted_compliance_event_count,
    reset_cursor_count,
    processed_at
  ) values (
    subject_count,
    mention_count,
    opt_out_count,
    admission_count,
    checkpoint_count,
    compliance_event_count,
    cursor_count,
    processed
  );

  return query select
    'purged'::text,
    subject_count,
    mention_count,
    opt_out_count,
    admission_count,
    checkpoint_count,
    compliance_event_count,
    cursor_count,
    processed;
end;
$function$;

revoke all on function private.purge_marketing_x_retention(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.purge_marketing_x_retention(timestamptz)
  to service_role;

create or replace function public.purge_marketing_x_retention(
  p_now timestamptz
)
returns table (
  result_code text,
  expired_subject_count integer,
  deleted_mention_count integer,
  deleted_opt_out_count integer,
  deleted_admission_count integer,
  deleted_checkpoint_count integer,
  deleted_compliance_event_count integer,
  reset_cursor_count integer,
  processed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.purge_marketing_x_retention(p_now);
$function$;

revoke all on function public.purge_marketing_x_retention(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.purge_marketing_x_retention(timestamptz)
  to service_role;
