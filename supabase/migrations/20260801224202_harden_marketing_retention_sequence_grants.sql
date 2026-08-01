-- Close sequence privileges inherited from shared-project defaults. Retention
-- writes run inside the reviewed SECURITY DEFINER RPC; callers never need
-- direct access to the identity sequence.
revoke all on sequence public.marketing_x_retention_events_event_id_seq
  from public, anon, authenticated, service_role;
