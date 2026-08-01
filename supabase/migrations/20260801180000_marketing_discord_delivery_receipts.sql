-- A Discord publish is terminal only after the exact accepted message can be
-- read back from the configured destination. Preserve historical rows whose
-- older receipts had no URL, but require every new completion RPC call to bind
-- the provider id to Discord's canonical credential-free message URL.

do $migration$
declare
  terminal_constraints name[];
begin
  select pg_catalog.array_agg(constraint_row.conname order by constraint_row.conname)
  into terminal_constraints
  from pg_catalog.pg_constraint as constraint_row
  where constraint_row.conrelid = 'public.marketing_delivery_ledger'::pg_catalog.regclass
    and constraint_row.contype = 'c'
    and pg_catalog.lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
      like '%channel = ''discord''%'
    and pg_catalog.lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
      like '%provider_url is null%'
    and pg_catalog.lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
      like '%defitutorials.substack.com%';

  if coalesce(pg_catalog.cardinality(terminal_constraints), 0) <> 1 then
    raise exception 'Expected one marketing delivery terminal receipt constraint.';
  end if;

  execute pg_catalog.format(
    'alter table public.marketing_delivery_ledger drop constraint %I',
    terminal_constraints[1]
  );
end;
$migration$;

alter table public.marketing_delivery_ledger
  add column if not exists provider_receipt_version smallint not null default 2;

-- Mark only already-finalized legacy Discord rows. New claims and all future
-- direct inserts receive version 2 from the column default and therefore
-- cannot finalize without the canonical readback URL.
update public.marketing_delivery_ledger
set provider_receipt_version = 1
where channel = 'discord'
  and action = 'broadcast'
  and status = 'published'
  and provider_message_id is not null
  and provider_url is null;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid =
      'public.marketing_delivery_ledger'::pg_catalog.regclass
      and constraint_row.conname =
        'marketing_delivery_provider_receipt_version_check'
  ) then
    alter table public.marketing_delivery_ledger
      add constraint marketing_delivery_provider_receipt_version_check
      check (
        provider_receipt_version = 2
        or (
          provider_receipt_version = 1
          and channel = 'discord'
          and action = 'broadcast'
          and status = 'published'
          and provider_message_id is not null
          and provider_url is null
        )
      );
  end if;
end;
$migration$;

alter table public.marketing_delivery_ledger
  add constraint marketing_delivery_terminal_receipt_check
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
      and (
        (
          provider_receipt_version = 1
          and provider_url is null
        )
        or (
          provider_receipt_version = 2
          and provider_url ~
            '^https://discord[.]com/channels/[0-9]{1,30}/[0-9]{1,30}/[0-9]{1,30}$'
          and pg_catalog.split_part(provider_url, '/', 7) = provider_message_id
        )
      )
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
  );

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
        and (
          p_provider_url is null
          or (
            p_provider_url ~
              '^https://discord[.]com/channels/[0-9]{1,30}/[0-9]{1,30}/[0-9]{1,30}$'
            and pg_catalog.split_part(p_provider_url, '/', 7) =
              p_provider_message_id
          )
        )
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

  -- Preserve the established claim-mismatch precedence above, then tighten
  -- only a matching, still-claimed Discord row. A legacy v1 finalized row may
  -- still replay its historical URL-less receipt idempotently.
  if current_row.status = 'claimed'
    and p_channel = 'discord'
    and p_action = 'broadcast'
    and p_status = 'published'
    and not coalesce((
      p_provider_url ~
        '^https://discord[.]com/channels/[0-9]{1,30}/[0-9]{1,30}/[0-9]{1,30}$'
      and pg_catalog.split_part(p_provider_url, '/', 7) =
        p_provider_message_id
    ), false)
  then
    return query select 'invalid_input'::text, null::text;
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
