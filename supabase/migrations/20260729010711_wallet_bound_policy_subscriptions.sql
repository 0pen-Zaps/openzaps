-- Wallet-bound subscription admission with replay-safe authorization versions.
--
-- A wallet signs one exact content hash, action, expected server version, and
-- short expiry. The service-role-only RPC below compares and increments a
-- persisted per-wallet version in the same transaction that inserts/deletes the
-- active subscription row. The version survives unsubscribe, so an old
-- subscribe or unsubscribe signature can never become valid again.

alter table public.policy_template_subscriptions
  add column if not exists authorization_version bigint;

create table if not exists private.policy_template_subscription_legacy_quarantine (
  subscriber_key uuid not null,
  content_hash text not null,
  created_at timestamptz not null,
  quarantined_at timestamptz not null default now(),
  reason text not null
    check (reason = 'pre-wallet-bound-subscription'),
  primary key (subscriber_key, content_hash)
);

revoke all on table private.policy_template_subscription_legacy_quarantine
  from public, anon, authenticated, service_role;

-- Existing UUIDs were caller-generated and cannot be attributed to a wallet.
-- Preserve them as inaccessible migration evidence, then remove them from the
-- active set. The checks deliberately fail the migration if any legacy row was
-- neither quarantined nor removed.
insert into private.policy_template_subscription_legacy_quarantine (
  subscriber_key,
  content_hash,
  created_at,
  reason
)
select
  subscriber_key,
  content_hash,
  created_at,
  'pre-wallet-bound-subscription'
from public.policy_template_subscriptions
where authorization_version is null
on conflict (subscriber_key, content_hash) do nothing;

do $$
begin
  if exists (
    select 1
    from public.policy_template_subscriptions active
    left join private.policy_template_subscription_legacy_quarantine quarantine
      on quarantine.subscriber_key = active.subscriber_key
     and quarantine.content_hash = active.content_hash
    where active.authorization_version is null
      and quarantine.subscriber_key is null
  ) then
    raise exception 'legacy policy subscriptions were not fully quarantined';
  end if;
end;
$$;

delete from public.policy_template_subscriptions
where authorization_version is null;

do $$
begin
  if exists (
    select 1
    from public.policy_template_subscriptions
    where authorization_version is null
  ) then
    raise exception 'legacy policy subscriptions remain active';
  end if;
end;
$$;

alter table public.policy_template_subscriptions
  alter column authorization_version set not null;

alter table public.policy_template_subscriptions
  drop constraint if exists policy_template_subscription_authorization_version_check;
alter table public.policy_template_subscriptions
  add constraint policy_template_subscription_authorization_version_check
  check (authorization_version between 1 and 9007199254740991);

create table if not exists public.policy_template_subscription_authorizations (
  subscriber_key uuid primary key,
  version bigint not null default 0
    check (version between 0 and 9007199254740991),
  updated_at timestamptz not null default now()
);

alter table public.policy_template_subscription_authorizations
  enable row level security;
revoke all on table public.policy_template_subscription_authorizations
  from public, anon, authenticated;
grant select, insert, update on table public.policy_template_subscription_authorizations
  to service_role;

revoke all on table public.policy_template_subscriptions
  from service_role;
grant select, insert, update, delete on table public.policy_template_subscriptions
  to service_role;

-- Recover conservatively if a partial/manual rollout created versioned active
-- rows before this migration created the authorization table.
insert into public.policy_template_subscription_authorizations (
  subscriber_key,
  version
)
select
  subscriber_key,
  max(authorization_version)
from public.policy_template_subscriptions
group by subscriber_key
on conflict (subscriber_key) do update
set
  version = greatest(
    public.policy_template_subscription_authorizations.version,
    excluded.version
  ),
  updated_at = now();

create or replace function private.enforce_policy_template_subscription_admission()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_version bigint;
  global_total integer;
  template_total integer;
  subscriber_total integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-policy-template-subscriptions-global', 0)
  );

  select auth_state.version
  into current_version
  from public.policy_template_subscription_authorizations auth_state
  where auth_state.subscriber_key = new.subscriber_key;

  if current_version is null or current_version <> new.authorization_version then
    raise exception 'policy subscription authorization version mismatch';
  end if;

  if tg_op = 'UPDATE' then
    if old.subscriber_key <> new.subscriber_key
      or old.content_hash <> new.content_hash
    then
      raise exception 'policy subscription identity is immutable';
    end if;
    return new;
  end if;

  if exists (
    select 1
    from public.policy_template_subscriptions
    where subscriber_key = new.subscriber_key
      and content_hash = new.content_hash
  ) then
    return new;
  end if;

  select count(*)::integer
  into global_total
  from public.policy_template_subscriptions;
  if global_total >= 50000 then
    raise exception 'policy template subscriptions have reached the 50000-row global limit';
  end if;

  select count(*)::integer
  into template_total
  from public.policy_template_subscriptions
  where content_hash = new.content_hash;
  if template_total >= 5000 then
    raise exception 'policy template has reached the 5000-subscription limit';
  end if;

  select count(*)::integer
  into subscriber_total
  from public.policy_template_subscriptions
  where subscriber_key = new.subscriber_key;
  if subscriber_total >= 256 then
    raise exception 'subscriber has reached the 256-template subscription limit';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_policy_template_subscription_admission()
  from public, anon, authenticated;

drop trigger if exists policy_template_subscription_admission
  on public.policy_template_subscriptions;
create trigger policy_template_subscription_admission
before insert or update on public.policy_template_subscriptions
for each row execute function private.enforce_policy_template_subscription_admission();

-- Expected cap/version outcomes are returned as typed rows. Unexpected database
-- failures still raise and therefore remain 5xx at the API boundary.
create or replace function public.set_policy_template_subscription(
  p_subscriber_key uuid,
  p_content_hash text,
  p_subscribed boolean,
  p_expected_version bigint,
  p_expires_at bigint
)
returns table (
  result_code text,
  resulting_version bigint,
  resulting_subscribed boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_version bigint;
  next_version bigint;
  global_total integer;
  template_total integer;
  subscriber_total integer;
  now_seconds bigint;
begin
  now_seconds := pg_catalog.floor(
    extract(epoch from pg_catalog.clock_timestamp())
  )::bigint;

  if p_expires_at is null or p_expires_at <= now_seconds then
    return query select 'expired'::text, null::bigint, null::boolean;
    return;
  end if;
  if p_expires_at > now_seconds + 300 then
    return query select 'invalid_expiry'::text, null::bigint, null::boolean;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-policy-template-subscriptions-global', 0)
  );

  insert into public.policy_template_subscription_authorizations (
    subscriber_key,
    version
  )
  values (p_subscriber_key, 0)
  on conflict (subscriber_key) do nothing;

  select auth_state.version
  into current_version
  from public.policy_template_subscription_authorizations auth_state
  where auth_state.subscriber_key = p_subscriber_key
  for update;

  if p_expected_version is null
    or p_expected_version < 0
    or current_version <> p_expected_version
  then
    return query
      select
        'version_conflict'::text,
        current_version,
        exists (
          select 1
          from public.policy_template_subscriptions
          where subscriber_key = p_subscriber_key
            and content_hash = p_content_hash
        );
    return;
  end if;

  if current_version >= 9007199254740991 then
    return query
      select
        'version_exhausted'::text,
        current_version,
        exists (
          select 1
          from public.policy_template_subscriptions
          where subscriber_key = p_subscriber_key
            and content_hash = p_content_hash
        );
    return;
  end if;

  if p_subscribed and not exists (
    select 1
    from public.policy_template_subscriptions
    where subscriber_key = p_subscriber_key
      and content_hash = p_content_hash
  ) then
    select count(*)::integer
    into global_total
    from public.policy_template_subscriptions;
    if global_total >= 50000 then
      return query select 'global_limit'::text, current_version, false;
      return;
    end if;

    select count(*)::integer
    into template_total
    from public.policy_template_subscriptions
    where content_hash = p_content_hash;
    if template_total >= 5000 then
      return query select 'template_limit'::text, current_version, false;
      return;
    end if;

    select count(*)::integer
    into subscriber_total
    from public.policy_template_subscriptions
    where subscriber_key = p_subscriber_key;
    if subscriber_total >= 256 then
      return query select 'subscriber_limit'::text, current_version, false;
      return;
    end if;
  end if;

  next_version := current_version + 1;
  update public.policy_template_subscription_authorizations
  set
    version = next_version,
    updated_at = pg_catalog.clock_timestamp()
  where subscriber_key = p_subscriber_key;

  if p_subscribed then
    insert into public.policy_template_subscriptions (
      subscriber_key,
      content_hash,
      authorization_version
    )
    values (
      p_subscriber_key,
      p_content_hash,
      next_version
    )
    on conflict (subscriber_key, content_hash) do update
    set authorization_version = excluded.authorization_version;
  else
    delete from public.policy_template_subscriptions
    where subscriber_key = p_subscriber_key
      and content_hash = p_content_hash;
  end if;

  return query select 'applied'::text, next_version, p_subscribed;
end;
$$;

revoke all on function public.set_policy_template_subscription(
  uuid,
  text,
  boolean,
  bigint,
  bigint
) from public, anon, authenticated;
grant execute on function public.set_policy_template_subscription(
  uuid,
  text,
  boolean,
  bigint,
  bigint
) to service_role;

-- Return the authorization version and active hashes from one PostgreSQL
-- statement snapshot. Two independent PostgREST reads could otherwise straddle
-- a committed mutation and describe a state that never existed.
create or replace function public.get_policy_template_subscription_snapshot(
  p_subscriber_key uuid
)
returns table (
  resulting_version bigint,
  content_hashes text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(auth_state.version, 0::bigint) as resulting_version,
    coalesce(
      pg_catalog.array_agg(
        subscription.content_hash
        order by subscription.content_hash
      ) filter (where subscription.content_hash is not null),
      array[]::text[]
    ) as content_hashes
  from (select 1) singleton
  left join public.policy_template_subscription_authorizations auth_state
    on auth_state.subscriber_key = p_subscriber_key
  left join public.policy_template_subscriptions subscription
    on subscription.subscriber_key = p_subscriber_key
  group by auth_state.version;
$$;

revoke all on function public.get_policy_template_subscription_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.get_policy_template_subscription_snapshot(uuid)
  to service_role;

-- Active rows alone drive the convenience count. Quarantined legacy rows and
-- persisted wallet authorization versions never contribute.
update public.policy_templates template
set subscription_count = (
  select count(*)::integer
  from public.policy_template_subscriptions subscription
  where subscription.content_hash = template.content_hash
);
