-- The original three-per-UTC-day network ceiling was too small for shared
-- office networks and routine operator verification. Preserve the same
-- non-reversible, short-lived fingerprint boundary while allowing a bounded
-- twelve accepted requests per UTC day.

alter table private.lead_request_quotas
  drop constraint if exists lead_request_quotas_accepted_count_check;

alter table private.lead_request_quotas
  add constraint lead_request_quotas_accepted_count_check
  check (accepted_count between 1 and 12);

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

  if current_count >= 12 then
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
