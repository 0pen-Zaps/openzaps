-- Forward-only security hardening for two production tables created earlier on
-- 2026-07-28. Existing anonymous template rows and pre-provenance receipts stay
-- readable at the database layer for incident recovery, but application reads
-- select only rows whose new verification flag is true.

-- ---------------------------------------------------------------------------
-- Wallet-attributed, bounded public policy template admission.
-- ---------------------------------------------------------------------------

alter table public.policy_templates
  add column if not exists publisher text,
  add column if not exists publisher_signature text,
  add column if not exists publisher_verified boolean not null default false,
  add column if not exists visible boolean not null default false,
  add column if not exists moderation_status text not null default 'pending',
  add column if not exists moderated_at timestamptz,
  add column if not exists moderation_note text;

alter table public.policy_templates
  drop constraint if exists policy_templates_verified_publisher_check;
alter table public.policy_templates
  add constraint policy_templates_verified_publisher_check check (
    not publisher_verified
    or (
      publisher ~ '^0x[0-9a-f]{40}$'
      and publisher_signature ~ '^0x[0-9a-f]{130}$'
    )
  );

alter table public.policy_templates
  drop constraint if exists policy_templates_moderation_check;
alter table public.policy_templates
  add constraint policy_templates_moderation_check check (
    moderation_status in ('pending', 'approved', 'hidden', 'rejected')
    and (moderation_note is null or char_length(moderation_note) <= 500)
    and (not visible or moderation_status = 'approved')
  );

create index if not exists policy_templates_verified_page
  on public.policy_templates (created_at asc, content_hash asc)
  where publisher_verified and visible and moderation_status = 'approved';

create index if not exists policy_templates_publisher
  on public.policy_templates (publisher, created_at asc, content_hash asc)
  where publisher_verified;

-- Older Supabase projects may have inherited table-wide service_role grants
-- when these tables were created. Column-level GRANTs do not narrow an
-- existing table-wide UPDATE/DELETE privilege, so reset both tables before
-- restating the exact backend surface.
revoke all on table public.policy_templates from service_role;
grant select, insert on table public.policy_templates to service_role;
grant update (
  subscription_count,
  visible,
  moderation_status,
  moderated_at,
  moderation_note
) on table public.policy_templates to service_role;

revoke all on table public.policy_template_subscriptions from service_role;
grant select, insert, delete on table public.policy_template_subscriptions to service_role;

-- Each admitted identity is bounded below the API. The advisory transaction
-- lock closes the concurrent-insert race around COUNT(*). A publisher may
-- still fork other identities' work, but cannot create an unbounded immutable
-- tail under one wallet.
create or replace function private.enforce_policy_template_admission()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  publisher_total integer;
  publisher_roots integer;
  global_total integer;
begin
  if not new.publisher_verified
    or new.publisher is null
    or new.publisher_signature is null
  then
    raise exception 'policy template publication requires a verified wallet signature';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.lower(new.publisher), 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-policy-template-global', 0)
  );

  select
    count(*)::integer,
    count(*) filter (where parent_hash is null)::integer
  into publisher_total, publisher_roots
  from public.policy_templates
  where publisher_verified
    and publisher = new.publisher;

  if publisher_total >= 64 then
    raise exception 'policy template publisher has reached the 64-version limit';
  end if;
  if new.parent_hash is null and publisher_roots >= 12 then
    raise exception 'policy template publisher has reached the 12-root limit';
  end if;

  select count(*)::integer
  into global_total
  from public.policy_templates
  where publisher_verified;
  if global_total >= 5000 then
    raise exception 'policy template registry has reached the 5000-version global limit';
  end if;

  if not new.visible or new.moderation_status <> 'approved' then
    raise exception 'new policy templates must enter through approved publication admission';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_policy_template_admission() from public, anon, authenticated;

drop trigger if exists policy_template_admission on public.policy_templates;
create trigger policy_template_admission
before insert on public.policy_templates
for each row execute function private.enforce_policy_template_admission();

-- Include publisher evidence in the existing immutable tuple. The service role
-- may update only derived subscription metadata and moderation tombstones; this
-- trigger keeps the content invariant explicit if grants change later.
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
    new.publisher,
    new.publisher_signature,
    new.publisher_verified,
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
    old.publisher,
    old.publisher_signature,
    old.publisher_verified,
    old.created_at
  ) then
    raise exception 'policy template content is immutable';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_policy_template_immutable() from public, anon, authenticated;

-- Moderation is a tombstone, not a content rewrite. Operators can remove a
-- malicious entry from all public reads or restore one after review while its
-- content hash, lineage, publisher evidence and creation time stay unchanged.
create or replace function private.set_policy_template_moderation(
  target_hash text,
  next_status text,
  note text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if next_status not in ('approved', 'hidden', 'rejected') then
    raise exception 'invalid policy template moderation status';
  end if;
  if note is not null and char_length(note) > 500 then
    raise exception 'policy template moderation note is too long';
  end if;

  update public.policy_templates
  set
    moderation_status = next_status,
    visible = next_status = 'approved',
    moderated_at = pg_catalog.now(),
    moderation_note = note
  where content_hash = target_hash;

  if not found then
    raise exception 'policy template not found';
  end if;
end;
$$;

revoke all on function private.set_policy_template_moderation(text, text, text)
  from public, anon, authenticated;
grant execute on function private.set_policy_template_moderation(text, text, text)
  to service_role;

-- Anonymous UUID subscriptions are convenience pins, not identities. Keep their storage bounded
-- below the API even when operators explicitly enable the production write surface. One global
-- transaction lock makes the COUNT-based caps exact under concurrent inserts.
create or replace function private.enforce_policy_template_subscription_admission()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  global_total integer;
  template_total integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-policy-template-subscriptions-global', 0)
  );

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

  return new;
end;
$$;

revoke all on function private.enforce_policy_template_subscription_admission()
  from public, anon, authenticated;

drop trigger if exists policy_template_subscription_admission
  on public.policy_template_subscriptions;
create trigger policy_template_subscription_admission
before insert on public.policy_template_subscriptions
for each row execute function private.enforce_policy_template_subscription_admission();

-- Repair any count drift from the old COUNT(*) trigger, then switch to atomic deltas. PostgreSQL
-- serializes concurrent updates of the same template row, so no committed insert/delete is lost.
update public.policy_templates template
set subscription_count = (
  select count(*)::integer
  from public.policy_template_subscriptions subscription
  where subscription.content_hash = template.content_hash
);

create or replace function private.refresh_policy_template_subscription_count()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.policy_templates
    set subscription_count = greatest(0, subscription_count - 1)
    where content_hash = old.content_hash;
    return old;
  end if;

  update public.policy_templates
  set subscription_count = subscription_count + 1
  where content_hash = new.content_hash;
  return new;
end;
$$;

revoke all on function private.refresh_policy_template_subscription_count()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Factory-proven execution receipt attribution.
-- ---------------------------------------------------------------------------

alter table public.execution_receipts
  add column if not exists provenance_verified boolean not null default false,
  add column if not exists factory text,
  add column if not exists implementation text,
  add column if not exists implementation_code_hash text,
  add column if not exists capsule_runtime_hash text,
  add column if not exists creation_tx_hash text,
  add column if not exists creation_block numeric(78, 0);

alter table public.execution_receipts
  drop constraint if exists execution_receipts_provenance_check;
alter table public.execution_receipts
  add constraint execution_receipts_provenance_check check (
    not provenance_verified
    or (
      factory ~ '^0x[0-9a-f]{40}$'
      and implementation ~ '^0x[0-9a-f]{40}$'
      and implementation_code_hash ~ '^0x[0-9a-f]{64}$'
      and capsule_runtime_hash ~ '^0x[0-9a-f]{64}$'
      and creation_tx_hash ~ '^0x[0-9a-f]{64}$'
      and creation_block is not null
      and creation_block >= 0
      and creation_block <= block_number
    )
  );

create index if not exists execution_receipts_verified_executor
  on public.execution_receipts (executor, block_number asc, tx_hash asc)
  where provenance_verified;

create or replace function private.enforce_execution_receipt_provenance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.provenance_verified and row(
    new.provenance_verified,
    new.factory,
    new.implementation,
    new.implementation_code_hash,
    new.capsule_runtime_hash,
    new.creation_tx_hash,
    new.creation_block
  ) is distinct from row(
    old.provenance_verified,
    old.factory,
    old.implementation,
    old.implementation_code_hash,
    old.capsule_runtime_hash,
    old.creation_tx_hash,
    old.creation_block
  ) then
    raise exception 'verified execution receipt provenance is immutable';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_execution_receipt_provenance() from public, anon, authenticated;

drop trigger if exists execution_receipt_provenance_immutable
  on public.execution_receipts;
create trigger execution_receipt_provenance_immutable
before update on public.execution_receipts
for each row execute function private.enforce_execution_receipt_provenance();

-- ---------------------------------------------------------------------------
-- Signed relay artifacts are immutable and terminal status cannot reopen.
-- ---------------------------------------------------------------------------

-- Restate the relay's exact server surface. The earlier operations migration
-- granted table-wide UPDATE so it could advance status; narrow that to the
-- only mutable column and remove any inherited legacy grants.
revoke all on table public.zap_intents from anon, authenticated, service_role;
grant select, insert on table public.zap_intents to service_role;
grant update (status) on table public.zap_intents to service_role;

-- Decimal text is only a transport representation of an EIP-712 uint. Collapse legacy
-- leading-zero spellings and address casing before the immutable trigger is
-- installed, then keep the unique (zap, kind, nonce) key aligned with EVM
-- identity. If two historical rows already represent the same canonical key,
-- stop for operator reconciliation rather than choosing one signed artifact
-- to discard.
do $$
begin
  if exists (
    select 1
    from public.zap_intents
    where nonce ~ '^[0-9]{1,78}$'
    group by lower(zap), kind, (nonce::numeric)::text
    having count(*) > 1
  ) then
    raise exception 'zap_intents contains duplicate canonical zap nonces; reconcile before migration';
  end if;
end;
$$;

update public.zap_intents
set
  zap = lower(zap),
  nonce = (nonce::numeric)::text
where nonce ~ '^[0-9]{1,78}$'
  and (
    zap <> lower(zap)
    or nonce <> (nonce::numeric)::text
  );

alter table public.zap_intents
  drop constraint if exists zap_intents_nonce_canonical;
alter table public.zap_intents
  add constraint zap_intents_nonce_canonical
  check (nonce ~ '^(0|[1-9][0-9]{0,77})$');
alter table public.zap_intents
  drop constraint if exists zap_intents_zap_canonical;
alter table public.zap_intents
  add constraint zap_intents_zap_canonical
  check (zap = lower(zap));

create or replace function private.enforce_zap_intent_immutable_artifact()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if row(
    new.id,
    new.zap,
    new.owner,
    new.chain_id,
    new.kind,
    new.nonce,
    new.intent,
    new.signature,
    new.created_at
  ) is distinct from row(
    old.id,
    old.zap,
    old.owner,
    old.chain_id,
    old.kind,
    old.nonce,
    old.intent,
    old.signature,
    old.created_at
  ) then
    raise exception 'signed zap intent artifact is immutable';
  end if;

  if new.status is distinct from old.status then
    if old.status <> 'open' or new.status not in ('consumed', 'expired') then
      raise exception 'zap intent status transition is not monotonic';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_zap_intent_immutable_artifact() from public, anon, authenticated;

drop trigger if exists zap_intent_immutable_artifact on public.zap_intents;
create trigger zap_intent_immutable_artifact
before update on public.zap_intents
for each row execute function private.enforce_zap_intent_immutable_artifact();
