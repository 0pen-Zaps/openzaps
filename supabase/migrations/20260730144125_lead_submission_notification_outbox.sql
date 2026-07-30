-- Durable, private email-notification outbox for accepted lead submissions.
--
-- The intake transaction only enqueues work. A server-side worker claims one
-- row at a time through the narrow public RPCs below, performs the provider
-- call outside PostgreSQL, and then records the terminal or retry state.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.lead_notification_outbox (
  lead_id uuid primary key
    references private.lead_requests(id) on delete cascade,
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'processing',
        'sent',
        'permanent_failure'
      )
    ),
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  claimed_by text
    check (
      claimed_by is null
      or (
        char_length(claimed_by) between 1 and 128
        and claimed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      )
    ),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null,
  provider_message_id text
    check (
      provider_message_id is null
      or (
        char_length(provider_message_id) between 1 and 255
        and provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      )
    ),
  last_error_code text
    check (
      last_error_code is null
      or (
        char_length(last_error_code) between 1 and 64
        and last_error_code ~ '^[a-z0-9][a-z0-9_:-]*$'
      )
    ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sent_at timestamptz,
  check (updated_at >= created_at),
  check (next_attempt_at >= created_at),
  check (sent_at is null or sent_at >= created_at),
  check (
    (
      status = 'pending'
      and claimed_by is null
      and lease_expires_at is null
      and provider_message_id is null
      and sent_at is null
    )
    or (
      status = 'processing'
      and claimed_by is not null
      and lease_expires_at is not null
      and provider_message_id is null
      and sent_at is null
    )
    or (
      status = 'sent'
      and claimed_by is null
      and lease_expires_at is null
      and provider_message_id is not null
      and last_error_code is null
      and sent_at is not null
    )
    or (
      status = 'permanent_failure'
      and claimed_by is null
      and lease_expires_at is null
      and provider_message_id is null
      and last_error_code is not null
      and sent_at is null
    )
  )
);

alter table private.lead_notification_outbox enable row level security;
revoke all on table private.lead_notification_outbox
  from public, anon, authenticated, service_role;

create index if not exists lead_notification_outbox_pending_due
  on private.lead_notification_outbox (
    next_attempt_at,
    created_at,
    lead_id
  )
  where status = 'pending';

create index if not exists lead_notification_outbox_expired_lease
  on private.lead_notification_outbox (
    lease_expires_at,
    created_at,
    lead_id
  )
  where status = 'processing';

create or replace function private.enqueue_lead_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into private.lead_notification_outbox (
    lead_id,
    status,
    attempt_count,
    next_attempt_at,
    created_at,
    updated_at
  )
  values (
    new.id,
    'pending',
    0,
    new.created_at,
    new.created_at,
    new.created_at
  )
  on conflict (lead_id) do nothing;

  return new;
end;
$function$;

revoke all on function private.enqueue_lead_notification()
  from public, anon, authenticated, service_role;

drop trigger if exists enqueue_lead_notification
  on private.lead_requests;
create trigger enqueue_lead_notification
after insert on private.lead_requests
for each row execute function private.enqueue_lead_notification();

create or replace function private.claim_next_lead_notification(
  p_worker_id text
)
returns table (
  lead_id uuid,
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
  qualification_score smallint,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claimed_at timestamptz;
begin
  if p_worker_id is null
    or char_length(p_worker_id) not between 1 and 128
    or p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  then
    raise exception 'invalid lead-notification worker identifier';
  end if;

  claimed_at := pg_catalog.clock_timestamp();

  return query
    with candidate as (
      select outbox.lead_id
      from private.lead_notification_outbox as outbox
      where (
        outbox.status = 'pending'
        and outbox.next_attempt_at <= claimed_at
      )
      or (
        outbox.status = 'processing'
        and (
          outbox.claimed_by = p_worker_id
          or outbox.lease_expires_at <= claimed_at
        )
      )
      order by
        case
          when outbox.status = 'processing'
            and outbox.claimed_by = p_worker_id
          then 0
          else 1
        end,
        outbox.next_attempt_at,
        outbox.created_at,
        outbox.lead_id
      for update of outbox skip locked
      limit 1
    ),
    claimed as (
      update private.lead_notification_outbox as outbox
      set
        status = 'processing',
        attempt_count = case
          when outbox.status = 'processing'
            and outbox.claimed_by = p_worker_id
          then outbox.attempt_count
          else outbox.attempt_count + 1
        end,
        claimed_by = p_worker_id,
        lease_expires_at = claimed_at + interval '10 minutes',
        updated_at = claimed_at
      from candidate
      where outbox.lead_id = candidate.lead_id
      returning outbox.lead_id
    )
    select
      leads.id as lead_id,
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
      leads.qualification_score,
      leads.created_at
    from claimed
    join private.lead_requests as leads
      on leads.id = claimed.lead_id;
end;
$function$;

revoke all on function private.claim_next_lead_notification(text)
  from public, anon, authenticated, service_role;
grant execute on function private.claim_next_lead_notification(text)
  to service_role;

create or replace function public.claim_next_lead_notification(
  p_worker_id text
)
returns table (
  lead_id uuid,
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
  qualification_score smallint,
  created_at timestamptz
)
language sql
volatile
security invoker
set search_path = ''
as $function$
  select *
  from private.claim_next_lead_notification(p_worker_id);
$function$;

revoke all on function public.claim_next_lead_notification(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_next_lead_notification(text)
  to service_role;

create or replace function private.complete_lead_notification(
  p_lead_id uuid,
  p_worker_id text,
  p_provider_message_id text
)
returns table (
  result_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  outbox_row private.lead_notification_outbox%rowtype;
  completed_at timestamptz;
begin
  if p_lead_id is null
    or p_worker_id is null
    or char_length(p_worker_id) not between 1 and 128
    or p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_provider_message_id is null
    or char_length(p_provider_message_id) not between 1 and 255
    or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  then
    return query select 'invalid_input'::text;
    return;
  end if;

  select outbox.*
  into outbox_row
  from private.lead_notification_outbox as outbox
  where outbox.lead_id = p_lead_id
  for update;

  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  if outbox_row.status = 'sent' then
    return query
      select case
        when outbox_row.provider_message_id = p_provider_message_id
        then 'already_sent'
        else 'ownership_lost'
      end::text;
    return;
  end if;

  if outbox_row.status <> 'processing' then
    return query select 'ownership_lost'::text;
    return;
  end if;

  if outbox_row.claimed_by <> p_worker_id then
    return query select 'ownership_lost'::text;
    return;
  end if;

  completed_at := pg_catalog.clock_timestamp();

  update private.lead_notification_outbox as outbox
  set
    status = 'sent',
    claimed_by = null,
    lease_expires_at = null,
    provider_message_id = p_provider_message_id,
    last_error_code = null,
    updated_at = completed_at,
    sent_at = completed_at
  where outbox.lead_id = p_lead_id;

  return query select 'sent'::text;
end;
$function$;

revoke all on function private.complete_lead_notification(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.complete_lead_notification(uuid, text, text)
  to service_role;

create or replace function public.complete_lead_notification(
  p_lead_id uuid,
  p_worker_id text,
  p_provider_message_id text
)
returns table (
  result_code text
)
language sql
volatile
security invoker
set search_path = ''
as $function$
  select *
  from private.complete_lead_notification(
    p_lead_id,
    p_worker_id,
    p_provider_message_id
  );
$function$;

revoke all on function public.complete_lead_notification(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_lead_notification(uuid, text, text)
  to service_role;

create or replace function private.fail_lead_notification(
  p_lead_id uuid,
  p_worker_id text,
  p_failure_code text,
  p_permanent boolean
)
returns table (
  result_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  outbox_row private.lead_notification_outbox%rowtype;
  failed_at timestamptz;
  retry_delay interval;
begin
  if p_lead_id is null
    or p_worker_id is null
    or char_length(p_worker_id) not between 1 and 128
    or p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_failure_code is null
    or char_length(p_failure_code) not between 1 and 64
    or p_failure_code !~ '^[a-z0-9][a-z0-9_:-]*$'
    or p_permanent is null
  then
    return query select 'invalid_input'::text;
    return;
  end if;

  select outbox.*
  into outbox_row
  from private.lead_notification_outbox as outbox
  where outbox.lead_id = p_lead_id
  for update;

  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  if outbox_row.status = 'permanent_failure'
    and p_permanent
    and outbox_row.last_error_code = p_failure_code
  then
    return query select 'permanent_failure'::text;
    return;
  end if;

  if outbox_row.status <> 'processing' then
    return query select 'ownership_lost'::text;
    return;
  end if;

  if outbox_row.claimed_by <> p_worker_id then
    return query select 'ownership_lost'::text;
    return;
  end if;

  failed_at := pg_catalog.clock_timestamp();
  retry_delay := case
    when outbox_row.attempt_count <= 1 then interval '1 minute'
    when outbox_row.attempt_count = 2 then interval '2 minutes'
    when outbox_row.attempt_count = 3 then interval '4 minutes'
    when outbox_row.attempt_count = 4 then interval '8 minutes'
    when outbox_row.attempt_count = 5 then interval '16 minutes'
    else interval '30 minutes'
  end;

  update private.lead_notification_outbox as outbox
  set
    status = case
      when p_permanent then 'permanent_failure'
      else 'pending'
    end,
    claimed_by = null,
    lease_expires_at = null,
    next_attempt_at = case
      when p_permanent then failed_at
      else failed_at + retry_delay
    end,
    last_error_code = p_failure_code,
    updated_at = failed_at
  where outbox.lead_id = p_lead_id;

  return query select case
    when p_permanent then 'permanent_failure'
    else 'released'
  end::text;
end;
$function$;

revoke all on function private.fail_lead_notification(
  uuid, text, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function private.fail_lead_notification(
  uuid, text, text, boolean
) to service_role;

create or replace function public.fail_lead_notification(
  p_lead_id uuid,
  p_worker_id text,
  p_failure_code text,
  p_permanent boolean
)
returns table (
  result_code text
)
language sql
volatile
security invoker
set search_path = ''
as $function$
  select *
  from private.fail_lead_notification(
    p_lead_id,
    p_worker_id,
    p_failure_code,
    p_permanent
  );
$function$;

revoke all on function public.fail_lead_notification(
  uuid, text, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.fail_lead_notification(
  uuid, text, text, boolean
) to service_role;
