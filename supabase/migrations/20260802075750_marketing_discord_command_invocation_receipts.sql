-- Privacy-safe evidence that a verified Discord command reached the configured
-- OpenZaps interaction handler. The target is represented only by a keyed,
-- domain-separated HMAC computed server-side. Repeated invocations converge on
-- the same append-once row and therefore cannot be used as an activity counter.

create schema if not exists private;
revoke all on schema private
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;

create table if not exists private.marketing_discord_command_invocation_receipts (
  target_binding_hmac text not null
    check (target_binding_hmac ~ '^[0-9a-f]{64}$'),
  command_name text not null
    check (command_name in ('ask', 'openzaps', 'status')),
  manifest_sha256 text not null
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  first_verified_at timestamptz not null
    default pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp())
    check (
      first_verified_at not in (
        '-infinity'::timestamptz,
        'infinity'::timestamptz
      )
      and first_verified_at = pg_catalog.date_trunc(
        'minute',
        first_verified_at
      )
    ),
  constraint marketing_discord_command_invocation_receipts_pkey
    primary key (target_binding_hmac, command_name, manifest_sha256)
);

alter table private.marketing_discord_command_invocation_receipts
  enable row level security;
revoke all on table private.marketing_discord_command_invocation_receipts
  from public, anon, authenticated, service_role;

create or replace function private.reject_marketing_discord_command_invocation_receipt_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'marketing Discord command invocation receipts are immutable';
end;
$function$;

revoke all on function private.reject_marketing_discord_command_invocation_receipt_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists marketing_discord_command_invocation_receipts_immutable
  on private.marketing_discord_command_invocation_receipts;
create trigger marketing_discord_command_invocation_receipts_immutable
before update or delete or truncate
on private.marketing_discord_command_invocation_receipts
for each statement
execute function private.reject_marketing_discord_command_invocation_receipt_mutation();

-- The only writer accepts the opaque target binding, one allowlisted command,
-- and the source-controlled manifest hash. The database chooses the timestamp.
create or replace function private.record_marketing_discord_command_invocation_receipt(
  p_target_binding_hmac text,
  p_command_name text,
  p_manifest_sha256 text
)
returns table (
  result_code text,
  target_binding_hmac text,
  command_name text,
  manifest_sha256 text,
  first_verified_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_receipt private.marketing_discord_command_invocation_receipts%rowtype;
  outcome text;
begin
  if p_target_binding_hmac is null
    or p_target_binding_hmac !~ '^[0-9a-f]{64}$'
    or p_command_name is null
    or p_command_name not in ('ask', 'openzaps', 'status')
    or p_manifest_sha256 is null
    or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid marketing Discord command invocation receipt';
  end if;

  insert into private.marketing_discord_command_invocation_receipts (
    target_binding_hmac,
    command_name,
    manifest_sha256
  ) values (
    p_target_binding_hmac,
    p_command_name,
    p_manifest_sha256
  )
  on conflict on constraint marketing_discord_command_invocation_receipts_pkey
    do nothing
  returning * into current_receipt;

  if found then
    outcome := 'recorded';
  else
    select receipts.*
    into strict current_receipt
    from private.marketing_discord_command_invocation_receipts as receipts
    where receipts.target_binding_hmac = p_target_binding_hmac
      and receipts.command_name = p_command_name
      and receipts.manifest_sha256 = p_manifest_sha256;
    outcome := 'already_recorded';
  end if;

  return query select
    outcome,
    current_receipt.target_binding_hmac,
    current_receipt.command_name,
    current_receipt.manifest_sha256,
    current_receipt.first_verified_at;
end;
$function$;

revoke all on function private.record_marketing_discord_command_invocation_receipt(
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.record_marketing_discord_command_invocation_receipt(
  text, text, text
) to service_role;

-- Return one deterministic row for every current allowlisted command. No
-- historical manifest or differently configured target can satisfy this read.
create or replace function private.get_marketing_discord_command_invocation_readback(
  p_target_binding_hmac text,
  p_manifest_sha256 text
)
returns table (
  target_binding_hmac text,
  manifest_sha256 text,
  command_name text,
  observed boolean,
  first_verified_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_target_binding_hmac is null
    or p_target_binding_hmac !~ '^[0-9a-f]{64}$'
    or p_manifest_sha256 is null
    or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid marketing Discord command invocation readback';
  end if;

  return query
  select
    p_target_binding_hmac,
    p_manifest_sha256,
    desired.command_name,
    receipts.target_binding_hmac is not null,
    receipts.first_verified_at
  from (
    values
      ('ask'::text, 1),
      ('openzaps'::text, 2),
      ('status'::text, 3)
  ) as desired(command_name, command_order)
  left join private.marketing_discord_command_invocation_receipts as receipts
    on receipts.target_binding_hmac = p_target_binding_hmac
    and receipts.command_name = desired.command_name
    and receipts.manifest_sha256 = p_manifest_sha256
  order by desired.command_order;
end;
$function$;

revoke all on function private.get_marketing_discord_command_invocation_readback(
  text, text
) from public, anon, authenticated, service_role;
grant execute on function private.get_marketing_discord_command_invocation_readback(
  text, text
) to service_role;

create or replace function public.record_marketing_discord_command_invocation_receipt(
  p_target_binding_hmac text,
  p_command_name text,
  p_manifest_sha256 text
)
returns table (
  result_code text,
  target_binding_hmac text,
  command_name text,
  manifest_sha256 text,
  first_verified_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.record_marketing_discord_command_invocation_receipt(
    p_target_binding_hmac,
    p_command_name,
    p_manifest_sha256
  );
$function$;

revoke all on function public.record_marketing_discord_command_invocation_receipt(
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_marketing_discord_command_invocation_receipt(
  text, text, text
) to service_role;

create or replace function public.get_marketing_discord_command_invocation_readback(
  p_target_binding_hmac text,
  p_manifest_sha256 text
)
returns table (
  target_binding_hmac text,
  manifest_sha256 text,
  command_name text,
  observed boolean,
  first_verified_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.get_marketing_discord_command_invocation_readback(
    p_target_binding_hmac,
    p_manifest_sha256
  );
$function$;

revoke all on function public.get_marketing_discord_command_invocation_readback(
  text, text
) from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_discord_command_invocation_readback(
  text, text
) to service_role;
