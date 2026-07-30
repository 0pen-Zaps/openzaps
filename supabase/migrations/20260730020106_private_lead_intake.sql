-- Private lead intake and durable abuse quota.
--
-- Raw contact and workflow data never receives a direct Data API grant. The
-- website backend calls narrow public-schema RPC wrappers with the
-- service_role credential; their privileged implementations live in the
-- unexposed private schema. Browser roles have neither table access nor an RLS
-- policy.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- The abuse-control identifier is deliberately isolated from the contact
-- record and retained only long enough to enforce the current UTC-day quota.
create table if not exists private.lead_request_quotas (
  client_fingerprint text not null
    check (client_fingerprint ~ '^[0-9a-f]{64}$'),
  received_day date not null,
  accepted_count smallint not null
    check (accepted_count between 1 and 3),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (client_fingerprint, received_day),
  check (updated_at >= created_at),
  check (expires_at > updated_at),
  check (expires_at <= created_at + interval '2 days')
);

alter table private.lead_request_quotas enable row level security;
revoke all on table private.lead_request_quotas
  from public, anon, authenticated, service_role;

create table if not exists private.lead_requests (
  id uuid primary key default gen_random_uuid(),
  persona text not null
    check (persona in ('agent_builder', 'protocol_team', 'defi_user')),
  name text not null
    check (char_length(name) between 2 and 100),
  email text not null
    check (
      char_length(email) between 3 and 254
      and email = lower(email)
      and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  project text
    check (
      project is null
      or char_length(project) between 1 and 120
    ),
  project_url text
    check (
      project_url is null
      or (
        char_length(project_url) between 1 and 500
        and project_url ~ '^https://[^[:space:]]+$'
      )
    ),
  workflow text not null
    check (char_length(workflow) between 20 and 4000),
  protocols_assets text
    check (
      protocols_assets is null
      or char_length(protocols_assets) between 1 and 2000
    ),
  trigger_description text not null
    check (char_length(trigger_description) between 3 and 2000),
  guardrails text not null
    check (char_length(guardrails) between 10 and 2000),
  timeline text not null
    check (
      timeline in (
        'immediately',
        'within_30_days',
        'within_90_days',
        'exploring'
      )
    ),
  consent_to_contact boolean not null
    check (consent_to_contact is true),
  consent_version text not null
    check (consent_version = 'lead-contact-v1'),
  consented_at timestamptz not null,
  marketing_opt_in boolean not null default false
    check (marketing_opt_in is false),
  email_verified boolean not null default false,
  attribution jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(attribution) = 'object'
      and octet_length(attribution::text) <= 4096
    ),
  qualification_score smallint not null
    check (qualification_score between 0 and 5),
  status text not null default 'new'
    check (status in ('new', 'contacted', 'qualified', 'closed')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  check (consented_at = created_at),
  check (updated_at >= created_at),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '365 days'),
  check (
    status <> 'closed'
    or expires_at <= updated_at + interval '30 days'
  )
);

alter table private.lead_requests enable row level security;
revoke all on table private.lead_requests
  from public, anon, authenticated, service_role;

create table if not exists private.lead_request_lifecycle_events (
  id bigint generated always as identity primary key,
  lead_id uuid not null
    references private.lead_requests(id) on delete cascade,
  from_status text
    check (
      from_status is null
      or from_status in ('new', 'contacted', 'qualified', 'closed')
    ),
  to_status text not null
    check (to_status in ('new', 'contacted', 'qualified', 'closed')),
  changed_at timestamptz not null,
  changed_by text not null
    check (changed_by in ('intake', 'operator')),
  check (
    (from_status is null and to_status = 'new')
    or from_status is distinct from to_status
  )
);

alter table private.lead_request_lifecycle_events enable row level security;
revoke all on table private.lead_request_lifecycle_events
  from public, anon, authenticated, service_role;

create index if not exists lead_requests_operator_queue
  on private.lead_requests (
    qualification_score desc,
    created_at desc,
    id desc
  );

create index if not exists lead_request_lifecycle_events_lead
  on private.lead_request_lifecycle_events (lead_id, changed_at, id);

-- Serialize each pseudonymous client independently before deriving the UTC
-- window and counting. This makes the three-per-day ceiling durable across
-- serverless instances without storing a raw IP address.
create or replace function private.submit_lead_request(
  p_fingerprint text,
  p_persona text,
  p_name text,
  p_email text,
  p_project text,
  p_project_url text,
  p_workflow text,
  p_protocols_assets text,
  p_trigger text,
  p_guardrails text,
  p_timeline text,
  p_consent_to_contact boolean,
  p_attribution jsonb,
  p_qualification_score integer
)
returns table (
  result_code text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  utc_day date;
  current_count integer;
  accepted_at timestamptz;
  quota_expires_at timestamptz;
  accepted_lead_id uuid;
begin
  if p_fingerprint is null
    or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_persona not in ('agent_builder', 'protocol_team', 'defi_user')
    or p_name is null
    or char_length(p_name) not between 2 and 100
    or p_email is null
    or char_length(p_email) not between 3 and 254
    or p_email <> pg_catalog.lower(p_email)
    or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or (
      p_project is not null
      and char_length(p_project) not between 1 and 120
    )
    or (
      p_project_url is not null
      and (
        char_length(p_project_url) not between 1 and 500
        or p_project_url !~ '^https://[^[:space:]]+$'
      )
    )
    or p_workflow is null
    or char_length(p_workflow) not between 20 and 4000
    or (
      p_protocols_assets is not null
      and char_length(p_protocols_assets) not between 1 and 2000
    )
    or p_trigger is null
    or char_length(p_trigger) not between 3 and 2000
    or p_guardrails is null
    or char_length(p_guardrails) not between 10 and 2000
    or p_timeline not in (
      'immediately',
      'within_30_days',
      'within_90_days',
      'exploring'
    )
    or p_consent_to_contact is not true
    or p_attribution is null
    or pg_catalog.jsonb_typeof(p_attribution) <> 'object'
    or pg_catalog.octet_length(p_attribution::text) > 4096
    or p_qualification_score is null
    or p_qualification_score not between 0 and 5
  then
    return query select 'invalid_input'::text;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-lead-intake:' || p_fingerprint,
      0
    )
  );

  utc_day := (
    pg_catalog.clock_timestamp() at time zone 'UTC'
  )::date;
  accepted_at := pg_catalog.clock_timestamp();
  quota_expires_at := (
    utc_day::timestamp at time zone 'UTC'
  ) + interval '2 days';

  select quotas.accepted_count::integer
  into current_count
  from private.lead_request_quotas as quotas
  where quotas.client_fingerprint = p_fingerprint
    and quotas.received_day = utc_day;

  current_count := coalesce(current_count, 0);

  if current_count >= 3 then
    return query select 'quota_reached'::text;
    return;
  end if;

  insert into private.lead_request_quotas as existing_quota (
    client_fingerprint,
    received_day,
    accepted_count,
    created_at,
    updated_at,
    expires_at
  )
  values (
    p_fingerprint,
    utc_day,
    1,
    accepted_at,
    accepted_at,
    quota_expires_at
  )
  on conflict (client_fingerprint, received_day)
  do update set
    accepted_count =
      existing_quota.accepted_count + 1,
    updated_at = excluded.updated_at,
    expires_at = excluded.expires_at;

  insert into private.lead_requests (
    persona,
    name,
    email,
    project,
    project_url,
    workflow,
    protocols_assets,
    trigger_description,
    guardrails,
    timeline,
    consent_to_contact,
    consent_version,
    consented_at,
    marketing_opt_in,
    attribution,
    qualification_score,
    created_at,
    updated_at,
    expires_at
  )
  values (
    p_persona,
    p_name,
    p_email,
    p_project,
    p_project_url,
    p_workflow,
    p_protocols_assets,
    p_trigger,
    p_guardrails,
    p_timeline,
    p_consent_to_contact,
    'lead-contact-v1',
    accepted_at,
    false,
    p_attribution,
    p_qualification_score,
    accepted_at,
    accepted_at,
    accepted_at + interval '180 days'
  )
  returning id into accepted_lead_id;

  insert into private.lead_request_lifecycle_events (
    lead_id,
    from_status,
    to_status,
    changed_at,
    changed_by
  )
  values (
    accepted_lead_id,
    null,
    'new',
    accepted_at,
    'intake'
  );

  return query select 'accepted'::text;
end;
$function$;

revoke all on function private.submit_lead_request(
  text, text, text, text, text, text, text, text, text, text, text,
  boolean, jsonb, integer
) from public, anon, authenticated, service_role;
grant execute on function private.submit_lead_request(
  text, text, text, text, text, text, text, text, text, text, text,
  boolean, jsonb, integer
) to service_role;

create or replace function public.submit_lead_request(
  p_fingerprint text,
  p_persona text,
  p_name text,
  p_email text,
  p_project text,
  p_project_url text,
  p_workflow text,
  p_protocols_assets text,
  p_trigger text,
  p_guardrails text,
  p_timeline text,
  p_consent_to_contact boolean,
  p_attribution jsonb,
  p_qualification_score integer
)
returns table (
  result_code text
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.submit_lead_request(
    p_fingerprint,
    p_persona,
    p_name,
    p_email,
    p_project,
    p_project_url,
    p_workflow,
    p_protocols_assets,
    p_trigger,
    p_guardrails,
    p_timeline,
    p_consent_to_contact,
    p_attribution,
    p_qualification_score
  );
$function$;

revoke all on function public.submit_lead_request(
  text, text, text, text, text, text, text, text, text, text, text,
  boolean, jsonb, integer
) from public, anon, authenticated, service_role;
grant execute on function public.submit_lead_request(
  text, text, text, text, text, text, text, text, text, text, text,
  boolean, jsonb, integer
) to service_role;

create or replace function private.list_lead_requests(
  p_limit integer,
  p_min_score integer
)
returns table (
  id uuid,
  persona text,
  name text,
  email text,
  project text,
  project_url text,
  workflow text,
  protocols_assets text,
  trigger_description text,
  guardrails text,
  timeline text,
  consent_to_contact boolean,
  consent_version text,
  consented_at timestamptz,
  email_verified boolean,
  attribution jsonb,
  qualification_score smallint,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit is null
    or p_limit not between 1 and 100
    or p_min_score is null
    or p_min_score not between 0 and 5
  then
    raise exception 'invalid lead queue query';
  end if;

  return query
    select
      leads.id,
      leads.persona,
      leads.name,
      leads.email,
      leads.project,
      leads.project_url,
      leads.workflow,
      leads.protocols_assets,
      leads.trigger_description,
      leads.guardrails,
      leads.timeline,
      leads.consent_to_contact,
      leads.consent_version,
      leads.consented_at,
      leads.email_verified,
      leads.attribution,
      leads.qualification_score,
      leads.status,
      leads.created_at,
      leads.updated_at,
      leads.expires_at
    from private.lead_requests as leads
    where leads.qualification_score >= p_min_score
      and leads.expires_at > pg_catalog.clock_timestamp()
    order by
      leads.qualification_score desc,
      leads.created_at desc,
      leads.id desc
    limit p_limit;
end;
$function$;

revoke all on function private.list_lead_requests(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.list_lead_requests(integer, integer)
  to service_role;

create or replace function public.list_lead_requests(
  p_limit integer,
  p_min_score integer
)
returns table (
  id uuid,
  persona text,
  name text,
  email text,
  project text,
  project_url text,
  workflow text,
  protocols_assets text,
  trigger_description text,
  guardrails text,
  timeline text,
  consent_to_contact boolean,
  consent_version text,
  consented_at timestamptz,
  email_verified boolean,
  attribution jsonb,
  qualification_score smallint,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select *
  from private.list_lead_requests(p_limit, p_min_score);
$function$;

revoke all on function public.list_lead_requests(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_lead_requests(integer, integer)
  to service_role;

-- Move a lead through the finite operator lifecycle. Closed is terminal, every
-- transition is recorded, and no transition can extend storage beyond one
-- year from the original consent event.
create or replace function private.update_lead_request_lifecycle(
  p_id uuid,
  p_status text
)
returns table (
  result_code text,
  id uuid,
  status text,
  updated_at timestamptz,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  previous_status text;
  original_created_at timestamptz;
  previous_expires_at timestamptz;
  changed_at timestamptz;
  next_expires_at timestamptz;
begin
  if p_id is null
    or p_status is null
    or p_status not in ('new', 'contacted', 'qualified', 'closed')
  then
    return query
      select
        'invalid_input'::text,
        null::uuid,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  changed_at := pg_catalog.clock_timestamp();

  select
    leads.status,
    leads.created_at,
    leads.expires_at
  into
    previous_status,
    original_created_at,
    previous_expires_at
  from private.lead_requests as leads
  where leads.id = p_id
  for update;

  if not found then
    return query
      select
        'not_found'::text,
        null::uuid,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  if previous_expires_at <= changed_at then
    return query
      select
        'expired'::text,
        null::uuid,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  if not (
    (previous_status = 'new'
      and p_status in ('contacted', 'qualified', 'closed'))
    or (previous_status = 'contacted'
      and p_status in ('qualified', 'closed'))
    or (previous_status = 'qualified' and p_status = 'closed')
  ) then
    return query
      select
        'invalid_transition'::text,
        null::uuid,
        null::text,
        null::timestamptz,
        null::timestamptz;
    return;
  end if;

  next_expires_at := least(
    original_created_at + interval '365 days',
    changed_at + case
      when p_status = 'closed' then interval '30 days'
      else interval '180 days'
    end
  );

  update private.lead_requests as leads
  set
    status = p_status,
    updated_at = changed_at,
    expires_at = next_expires_at
  where leads.id = p_id;

  insert into private.lead_request_lifecycle_events (
    lead_id,
    from_status,
    to_status,
    changed_at,
    changed_by
  )
  values (
    p_id,
    previous_status,
    p_status,
    changed_at,
    'operator'
  );

  return query
    select
      'updated'::text,
      p_id,
      p_status,
      changed_at,
      next_expires_at;
end;
$function$;

revoke all on function private.update_lead_request_lifecycle(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function private.update_lead_request_lifecycle(uuid, text)
  to service_role;

create or replace function public.update_lead_request_lifecycle(
  p_id uuid,
  p_status text
)
returns table (
  result_code text,
  id uuid,
  status text,
  updated_at timestamptz,
  expires_at timestamptz
)
language sql
volatile
security invoker
set search_path = ''
as $function$
  select *
  from private.update_lead_request_lifecycle(p_id, p_status);
$function$;

revoke all on function public.update_lead_request_lifecycle(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.update_lead_request_lifecycle(uuid, text)
  to service_role;

-- Operator deletion is explicit and narrow; the lifecycle audit rows are
-- removed with the lead by the foreign-key cascade.
create or replace function private.delete_lead_request(p_id uuid)
returns table (
  deleted_count bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_id is null then
    return query select 0::bigint;
    return;
  end if;

  return query
    with deleted as (
      delete from private.lead_requests as leads
      where leads.id = p_id
      returning 1
    )
    select pg_catalog.count(*)::bigint
    from deleted;
end;
$function$;

revoke all on function private.delete_lead_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.delete_lead_request(uuid)
  to service_role;

create or replace function public.delete_lead_request(p_id uuid)
returns table (
  deleted_count bigint
)
language sql
volatile
security invoker
set search_path = ''
as $function$
  select *
  from private.delete_lead_request(p_id);
$function$;

revoke all on function public.delete_lead_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_lead_request(uuid)
  to service_role;

-- Enforce retention independently of operator reads. The same daily job drops
-- the short-lived pseudonymous quota ledger; no identifier is returned.
create or replace function private.purge_expired_lead_requests()
returns table (
  deleted_count bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  purged_leads bigint;
begin
  delete from private.lead_requests as leads
  where leads.expires_at <= pg_catalog.clock_timestamp();
  get diagnostics purged_leads = row_count;

  delete from private.lead_request_quotas as quotas
  where quotas.expires_at <= pg_catalog.clock_timestamp();

  return query select purged_leads;
end;
$function$;

revoke all on function private.purge_expired_lead_requests()
  from public, anon, authenticated, service_role;
grant execute on function private.purge_expired_lead_requests()
  to service_role;

create or replace function public.purge_expired_lead_requests()
returns table (
  deleted_count bigint
)
language sql
volatile
security invoker
set search_path = ''
as $function$
  select *
  from private.purge_expired_lead_requests();
$function$;

revoke all on function public.purge_expired_lead_requests()
  from public, anon, authenticated, service_role;
grant execute on function public.purge_expired_lead_requests()
  to service_role;
