-- Immutable, content-addressed public policy templates.
--
-- The app is the only writer: it validates every block through the same
-- untrusted-link decoder and compiler the visual builder uses, computes the
-- keccak256 content address, and writes with the service role. Public callers
-- read and publish through /api/policy-templates; no browser receives the
-- service key and the Data API grants below expose nothing to anon/authenticated.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.policy_templates (
  content_hash text primary key check (content_hash ~ '^0x[0-9a-f]{64}$'),
  schema_version text not null check (schema_version = 'openzaps-policy-template/v1'),
  version integer not null check (version > 0),
  parent_hash text references public.policy_templates(content_hash) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  summary text not null default '' check (char_length(summary) <= 240),
  chain jsonb not null check (jsonb_typeof(chain) = 'array' and jsonb_array_length(chain) > 0),
  compiled_hash text not null,
  subscription_count integer not null default 0 check (subscription_count >= 0),
  created_at timestamptz not null default now(),
  check (
    (parent_hash is null and version = 1)
    or (parent_hash is not null and version > 1)
  )
);

create index if not exists policy_templates_parent
  on public.policy_templates (parent_hash, version);

create index if not exists policy_templates_created
  on public.policy_templates (created_at desc);

alter table public.policy_templates enable row level security;
revoke all on public.policy_templates from anon, authenticated;
grant select, insert on public.policy_templates to service_role;
grant update (subscription_count) on public.policy_templates to service_role;

create table if not exists public.policy_template_subscriptions (
  subscriber_key uuid not null,
  content_hash text not null references public.policy_templates(content_hash) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (subscriber_key, content_hash)
);

create index if not exists policy_template_subscriptions_hash
  on public.policy_template_subscriptions (content_hash);

alter table public.policy_template_subscriptions enable row level security;
revoke all on public.policy_template_subscriptions from anon, authenticated;
grant select, insert, delete on public.policy_template_subscriptions to service_role;

-- A child always advances exactly one version from the exact parent it names.
-- This is a lineage invariant, so enforce it below the API as well.
create or replace function private.validate_policy_template_lineage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  parent_version integer;
begin
  if new.parent_hash is null then
    if new.version <> 1 then
      raise exception 'root policy template must be version 1';
    end if;
    return new;
  end if;

  select version
  into parent_version
  from public.policy_templates
  where content_hash = new.parent_hash;

  if parent_version is null then
    raise exception 'parent policy template does not exist';
  end if;
  if new.version <> parent_version + 1 then
    raise exception 'policy template fork must advance exactly one version';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_policy_template_lineage() from public, anon, authenticated;

drop trigger if exists policy_template_lineage on public.policy_templates;
create trigger policy_template_lineage
before insert on public.policy_templates
for each row execute function private.validate_policy_template_lineage();

-- Content, lineage and timestamps never mutate. subscription_count is derived
-- convenience metadata and is the only field an UPDATE may change.
create or replace function private.enforce_policy_template_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'policy templates are immutable';
  end if;
  if row(
    new.content_hash,
    new.schema_version,
    new.version,
    new.parent_hash,
    new.name,
    new.summary,
    new.chain,
    new.compiled_hash,
    new.created_at
  ) is distinct from row(
    old.content_hash,
    old.schema_version,
    old.version,
    old.parent_hash,
    old.name,
    old.summary,
    old.chain,
    old.compiled_hash,
    old.created_at
  ) then
    raise exception 'policy template content is immutable';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_policy_template_immutable() from public, anon, authenticated;

drop trigger if exists policy_template_immutable on public.policy_templates;
create trigger policy_template_immutable
before update or delete on public.policy_templates
for each row execute function private.enforce_policy_template_immutable();

-- Count is maintained from exact-version rows; no floating "latest" relation
-- exists anywhere in the schema.
create or replace function private.refresh_policy_template_subscription_count()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_hash text;
begin
  if tg_op = 'DELETE' then
    target_hash := old.content_hash;
  else
    target_hash := new.content_hash;
  end if;
  update public.policy_templates
  set subscription_count = (
    select count(*)::integer
    from public.policy_template_subscriptions
    where content_hash = target_hash
  )
  where content_hash = target_hash;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.refresh_policy_template_subscription_count() from public, anon, authenticated;

drop trigger if exists policy_template_subscription_count
  on public.policy_template_subscriptions;
create trigger policy_template_subscription_count
after insert or delete on public.policy_template_subscriptions
for each row execute function private.refresh_policy_template_subscription_count();
