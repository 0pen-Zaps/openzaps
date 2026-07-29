-- Bound the signed-intent relay below the unauthenticated HTTP surface.
--
-- The caps here apply to concurrently executable work, not to the useful
-- lifetime of an owner or capsule:
--   * 128 open intents per capsule
--   * 500 open intents per owner
--   * 50,000 open intents globally
--   * 1,000,000 signed artifacts in the online table
--
-- A single transaction-scoped advisory lock serializes every insert and every
-- open -> terminal transition. The private singleton avoids a full-table
-- COUNT(*) on every publication, while the indexed owner/capsule counts remain
-- exact under that lock. The final ceiling is intentionally high and fails
-- closed; it is an operational signal to forward-migrate immutable evidence to
-- partitioned/cold storage, not permission to delete signed artifacts in place.

create schema if not exists private;

-- The service role needs schema resolution for the one private moderation RPC
-- explicitly granted by the preceding security migration. USAGE does not grant
-- table access or function execution; both remain separately denied below.
revoke all on schema private
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;

-- Receipt publication is insert-only. The API uses ON CONFLICT DO NOTHING and
-- then reads the already-stored row for an idempotent replay, so the service
-- role never needs UPDATE to merge a second observation into chain evidence.
-- Restate the grants here because the original operations migration granted a
-- table-wide UPDATE that could rewrite executor reputation inputs.
revoke all on table public.execution_receipts
  from anon, authenticated, service_role;
grant select, insert on table public.execution_receipts to service_role;

-- The service grant is the primary application boundary, but receipts are
-- described and consumed as durable evidence. Reject owner/admin UPDATE,
-- DELETE, and TRUNCATE statements too, including statements that match no rows,
-- so maintenance cannot silently rewrite or erase reputation history.
create or replace function private.reject_execution_receipt_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'execution receipt artifacts are immutable';
end;
$function$;

revoke all on function private.reject_execution_receipt_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists execution_receipt_reject_mutation
  on public.execution_receipts;
create trigger execution_receipt_reject_mutation
before update or delete or truncate on public.execution_receipts
for each statement execute function private.reject_execution_receipt_mutation();

-- Policy templates are content-addressed immutable artifacts. Their row trigger
-- rejects UPDATE/DELETE, but PostgreSQL TRUNCATE bypasses row triggers entirely
-- (including TRUNCATE ... CASCADE by the table owner), so close that statement
-- path explicitly in the final hardening migration.
create or replace function private.reject_policy_template_truncate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'policy template artifacts are immutable';
end;
$function$;

revoke all on function private.reject_policy_template_truncate()
  from public, anon, authenticated, service_role;

drop trigger if exists policy_template_reject_truncate
  on public.policy_templates;
create trigger policy_template_reject_truncate
before truncate on public.policy_templates
for each statement execute function private.reject_policy_template_truncate();

create table if not exists private.zap_intent_admission_state (
  singleton boolean primary key default true check (singleton),
  total_rows bigint not null check (total_rows >= 0),
  open_rows bigint not null check (open_rows >= 0 and open_rows <= total_rows),
  updated_at timestamptz not null default now()
);

revoke all on table private.zap_intent_admission_state
  from public, anon, authenticated, service_role;
alter table private.zap_intent_admission_state enable row level security;

comment on table private.zap_intent_admission_state is
  'Exact relay admission counters. If total_rows approaches 1000000, preserve the immutable signed artifacts in independently verified partitioned or cold evidence storage and ship a forward migration before admitting more rows.';

create index if not exists zap_intents_open_owner
  on public.zap_intents ((lower(owner)))
  where status = 'open';

create index if not exists zap_intents_open_zap
  on public.zap_intents (zap)
  where status = 'open';

-- CREATE INDEX and CREATE TRIGGER take locks of their own, but keep the
-- backfill lock explicit: no relay insert can land between the snapshot and
-- installation of the counter-maintaining triggers in this migration.
lock table public.zap_intents in share row exclusive mode;

insert into private.zap_intent_admission_state (
  singleton,
  total_rows,
  open_rows,
  updated_at
)
select
  true,
  count(*)::bigint,
  count(*) filter (where status = 'open')::bigint,
  pg_catalog.now()
from public.zap_intents
on conflict (singleton) do update
set
  total_rows = excluded.total_rows,
  open_rows = excluded.open_rows,
  updated_at = excluded.updated_at;

create or replace function private.enforce_zap_intent_admission_caps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_total bigint;
  current_open bigint;
  owner_open bigint;
  zap_open bigint;
begin
  if new.status <> 'open' then
    raise exception 'new zap intents must enter with open status';
  end if;

  -- Fast-path an existing key before taking the advisory lock. A concurrent
  -- status update already holds this row lock; proceeding directly to the
  -- unique check lets the insert wait without holding the admission lock and
  -- avoids an UPDATE(row -> advisory) / INSERT(advisory -> row) deadlock.
  if exists (
    select 1
    from public.zap_intents
    where zap = pg_catalog.lower(new.zap)
      and kind = new.kind
      and nonce = new.nonce
  ) then
    return new;
  end if;

  -- One lock covers the global counter and both scoped counts. Every code path
  -- that changes open-row cardinality takes this lock, so concurrent requests
  -- cannot each observe the same remaining slot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-zap-intents-admission-global', 0)
  );

  -- Recheck after acquiring the lock: two new publications can both miss the
  -- fast path, but only the first may consume the counter slot. The unique
  -- index then rejects the replay and the API compares immutable artifacts.
  if exists (
    select 1
    from public.zap_intents
    where zap = pg_catalog.lower(new.zap)
      and kind = new.kind
      and nonce = new.nonce
  ) then
    return new;
  end if;

  select state.total_rows, state.open_rows
  into current_total, current_open
  from private.zap_intent_admission_state as state
  where state.singleton
  for update;

  if not found then
    raise exception 'zap intent admission state is unavailable';
  end if;

  if current_total >= 1000000 then
    raise exception 'zap intent relay has reached the 1000000-artifact operational ceiling';
  end if;
  if current_open >= 50000 then
    raise exception 'zap intent relay has reached the 50000-open global limit';
  end if;

  select count(*)::bigint
  into owner_open
  from public.zap_intents
  where status = 'open'
    and pg_catalog.lower(owner) = pg_catalog.lower(new.owner);
  if owner_open >= 500 then
    raise exception 'zap intent owner has reached the 500-open limit';
  end if;

  select count(*)::bigint
  into zap_open
  from public.zap_intents
  where status = 'open'
    and zap = pg_catalog.lower(new.zap);
  if zap_open >= 128 then
    raise exception 'zap capsule has reached the 128-open limit';
  end if;

  update private.zap_intent_admission_state
  set
    total_rows = total_rows + 1,
    open_rows = open_rows + 1,
    updated_at = pg_catalog.clock_timestamp()
  where singleton;

  if not found then
    raise exception 'zap intent admission state could not be advanced';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_zap_intent_admission_caps()
  from public, anon, authenticated, service_role;

drop trigger if exists zap_intent_admission_caps on public.zap_intents;
create trigger zap_intent_admission_caps
before insert on public.zap_intents
for each row execute function private.enforce_zap_intent_admission_caps();

create or replace function private.maintain_zap_intent_admission_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.status = 'open' and new.status in ('consumed', 'expired') then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('openzaps-zap-intents-admission-global', 0)
    );

    update private.zap_intent_admission_state
    set
      open_rows = open_rows - 1,
      updated_at = pg_catalog.clock_timestamp()
    where singleton
      and open_rows > 0;

    if not found then
      raise exception 'zap intent admission state would underflow';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function private.maintain_zap_intent_admission_state()
  from public, anon, authenticated, service_role;

drop trigger if exists zap_intent_admission_state_maintenance
  on public.zap_intents;
create trigger zap_intent_admission_state_maintenance
after update of status on public.zap_intents
for each row execute function private.maintain_zap_intent_admission_state();

-- Signed authorizations are evidence. Terminal status is a tombstone; neither
-- the service nor an administrative session may silently erase the artifact.
create or replace function private.reject_zap_intent_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'signed zap intent artifacts cannot be deleted';
end;
$function$;

revoke all on function private.reject_zap_intent_delete()
  from public, anon, authenticated, service_role;

drop trigger if exists zap_intent_reject_delete on public.zap_intents;
create trigger zap_intent_reject_delete
before delete on public.zap_intents
for each row execute function private.reject_zap_intent_delete();

-- Row DELETE triggers do not run for TRUNCATE. Block the statement separately
-- so a table-owner maintenance command cannot erase signed evidence or leave
-- the exact admission counters detached from the online table.
create or replace function private.reject_zap_intent_truncate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'signed zap intent artifacts cannot be truncated';
end;
$function$;

revoke all on function private.reject_zap_intent_truncate()
  from public, anon, authenticated, service_role;

drop trigger if exists zap_intent_reject_truncate on public.zap_intents;
create trigger zap_intent_reject_truncate
before truncate on public.zap_intents
for each statement execute function private.reject_zap_intent_truncate();

-- Re-state the exact backend surface after installing the triggers. In
-- particular, no table-wide UPDATE and no DELETE privilege may survive an
-- older project default.
revoke all on table public.zap_intents
  from anon, authenticated, service_role;
grant select, insert on table public.zap_intents to service_role;
grant update (status) on table public.zap_intents to service_role;
