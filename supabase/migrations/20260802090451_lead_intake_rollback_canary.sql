-- Authenticated transaction-rollback probe for the private lead intake.
--
-- The probe calls the production public submit wrapper, verifies its
-- service_role grant plus the quota, lead, lifecycle, and notification-outbox
-- effects while they are visible in the current transaction, and then raises
-- a dedicated success exception. That exception is intentionally uncaught:
-- PostgreSQL rolls back the Data API request, so no canary row can become
-- visible to a worker or pollute the operator queue. As with every rolled-back
-- INSERT backed by a PostgreSQL sequence, the lifecycle-event identity sequence
-- still advances because sequence values are non-transactional. The public
-- canary wrapper accepts no caller data and remains executable only with the
-- service_role credential.

create or replace function private.probe_lead_intake_write_path()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  submit_rpc regprocedure := pg_catalog.to_regprocedure(
    'public.submit_lead_request(text,text,text,text,text,text,text,text,text,text,text,boolean,jsonb,integer)'
  );
  private_submit_rpc regprocedure := pg_catalog.to_regprocedure(
    'private.submit_lead_request(text,text,text,text,text,text,text,text,text,text,text,boolean,jsonb,integer)'
  );
  canary_uuid uuid := pg_catalog.gen_random_uuid();
  canary_token text := pg_catalog.replace(canary_uuid::text, '-', '');
  canary_fingerprint text := canary_token || canary_token;
  canary_email text :=
    'lead-intake-canary+' || canary_uuid::text || '@openzaps.invalid';
  canary_lead_id uuid;
  result_code text;
  matched_rows bigint;
begin
  if submit_rpc is null
    or private_submit_rpc is null
    or not pg_catalog.has_schema_privilege(
      'service_role',
      'public',
      'usage'
    )
    or not pg_catalog.has_schema_privilege(
      'service_role',
      'private',
      'usage'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      submit_rpc,
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      private_submit_rpc,
      'execute'
    )
  then
    raise exception using
      errcode = 'PZC02',
      message = 'OPENZAPS_LEAD_INTAKE_CANARY_ASSERTION_FAILED';
  end if;

  select submitted.result_code
  into strict result_code
  from public.submit_lead_request(
    p_fingerprint => canary_fingerprint,
    p_persona => 'agent_builder',
    p_name => 'OpenZaps Canary',
    p_email => canary_email,
    p_project => 'OpenZaps Intake Canary',
    p_project_url => null::text,
    p_workflow =>
      'Verify the bounded lead-intake write path and every transactional trigger without retaining a submission.',
    p_protocols_assets => null::text,
    p_trigger => 'An authenticated operator starts the rollback canary.',
    p_guardrails =>
      'Roll back every inserted row and never schedule external delivery.',
    p_timeline => 'exploring',
    p_consent_to_contact => true,
    p_attribution => '{"probe":"rollback_only"}'::jsonb,
    p_qualification_score => 0
  ) as submitted;

  if result_code is distinct from 'accepted' then
    raise exception using
      errcode = 'PZC02',
      message = 'OPENZAPS_LEAD_INTAKE_CANARY_ASSERTION_FAILED';
  end if;

  select pg_catalog.count(*)
  into matched_rows
  from private.lead_request_quotas as quotas
  where quotas.client_fingerprint = canary_fingerprint
    and quotas.accepted_count = 1;
  if matched_rows <> 1 then
    raise exception using
      errcode = 'PZC02',
      message = 'OPENZAPS_LEAD_INTAKE_CANARY_ASSERTION_FAILED';
  end if;

  select pg_catalog.count(*)
  into matched_rows
  from private.lead_requests as leads
  where leads.email = canary_email
    and leads.persona = 'agent_builder'
    and leads.project = 'OpenZaps Intake Canary'
    and leads.qualification_score = 0
    and leads.status = 'new'
    and leads.consent_to_contact is true
    and leads.marketing_opt_in is false
    and leads.attribution = '{"probe":"rollback_only"}'::jsonb;
  if matched_rows <> 1 then
    raise exception using
      errcode = 'PZC02',
      message = 'OPENZAPS_LEAD_INTAKE_CANARY_ASSERTION_FAILED';
  end if;

  select leads.id
  into strict canary_lead_id
  from private.lead_requests as leads
  where leads.email = canary_email;

  select pg_catalog.count(*)
  into matched_rows
  from private.lead_request_lifecycle_events as events
  where events.lead_id = canary_lead_id
    and events.from_status is null
    and events.to_status = 'new'
    and events.changed_by = 'intake';
  if matched_rows <> 1 then
    raise exception using
      errcode = 'PZC02',
      message = 'OPENZAPS_LEAD_INTAKE_CANARY_ASSERTION_FAILED';
  end if;

  select pg_catalog.count(*)
  into matched_rows
  from private.lead_notification_outbox as outbox
  where outbox.lead_id = canary_lead_id
    and outbox.status = 'pending'
    and outbox.attempt_count = 0
    and outbox.claimed_by is null
    and outbox.lease_expires_at is null
    and outbox.provider_message_id is null
    and outbox.sent_at is null;
  if matched_rows <> 1 then
    raise exception using
      errcode = 'PZC02',
      message = 'OPENZAPS_LEAD_INTAKE_CANARY_ASSERTION_FAILED';
  end if;

  raise exception using
    errcode = 'PZC01',
    message = 'OPENZAPS_LEAD_INTAKE_CANARY_ROLLED_BACK';
end;
$function$;

revoke all on function private.probe_lead_intake_write_path()
  from public, anon, authenticated, service_role;
grant execute on function private.probe_lead_intake_write_path()
  to service_role;

create or replace function public.probe_lead_intake_write_path()
returns void
language sql
volatile
security invoker
set search_path = ''
as $function$
  select private.probe_lead_intake_write_path();
$function$;

revoke all on function public.probe_lead_intake_write_path()
  from public, anon, authenticated, service_role;
grant execute on function public.probe_lead_intake_write_path()
  to service_role;
