-- Break the fresh-install X compliance bootstrap cycle without touching the
-- mention timeline. The application must first bind its configured account to
-- the official authenticated-user endpoint, then this service-role-only RPC
-- may create the durable account boundary. No cursor, discovery baseline,
-- lease, mention, reply subject, or outbound admission is created here.

create or replace function private.initialize_marketing_x_compliance_account(
  p_account_id text,
  p_verified_at timestamptz
)
returns table (
  result_code text,
  account_id text,
  eligibility_cutoff_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  boundary_at timestamptz := pg_catalog.clock_timestamp();
  inserted_count integer;
  current_cutoff timestamptz;
begin
  if p_account_id is null
    or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_verified_at is null
    or p_verified_at in (
      '-infinity'::timestamptz,
      'infinity'::timestamptz
    )
  then
    raise exception 'invalid marketing X authenticated identity boundary';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-x-compliance:' || p_account_id,
      0
    )
  );

  boundary_at := pg_catalog.clock_timestamp();
  if p_verified_at < boundary_at - interval '10 minutes'
    or p_verified_at > boundary_at + interval '1 minute'
  then
    raise exception 'stale marketing X authenticated identity boundary';
  end if;

  insert into public.marketing_x_mention_accounts (
    account_id,
    eligibility_cutoff_at,
    next_poll_at,
    created_at,
    updated_at
  ) values (
    p_account_id,
    boundary_at,
    boundary_at,
    boundary_at,
    boundary_at
  ) on conflict on constraint marketing_x_mention_accounts_pkey do nothing;
  get diagnostics inserted_count = row_count;

  select accounts.eligibility_cutoff_at
  into strict current_cutoff
  from public.marketing_x_mention_accounts as accounts
  where accounts.account_id = p_account_id;

  return query select
    case when inserted_count = 1 then 'created'::text else 'already_exists'::text end,
    p_account_id,
    current_cutoff;
end;
$function$;

revoke all on function private.initialize_marketing_x_compliance_account(
  text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function private.initialize_marketing_x_compliance_account(
  text, timestamptz
) to service_role;

create or replace function public.initialize_marketing_x_compliance_account(
  p_account_id text,
  p_verified_at timestamptz
)
returns table (
  result_code text,
  account_id text,
  eligibility_cutoff_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.initialize_marketing_x_compliance_account(
    p_account_id,
    p_verified_at
  );
$function$;

revoke all on function public.initialize_marketing_x_compliance_account(
  text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.initialize_marketing_x_compliance_account(
  text, timestamptz
) to service_role;

-- A healthy official account-only checkpoint is enough to admit the first
-- mention poll. That poll still returns baseline_required=true, so it cannot
-- make any pre-boundary mention replyable. Never fake initialized_at here: it
-- remains proof that the mention timeline itself was successfully baselined.
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
      when private.marketing_x_compliance_is_fresh(p_account_id, checked_now)
        then 'healthy'::text
      when current_account.initialized_at is null then 'not_initialized'::text
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
