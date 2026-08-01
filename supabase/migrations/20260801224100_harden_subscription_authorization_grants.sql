-- Close service_role privileges inherited from shared-project defaults. The
-- wallet-bound subscription RPCs only read and advance authorization versions;
-- they never delete, truncate, reference, or install triggers on this table.
revoke all on table public.policy_template_subscription_authorizations
  from service_role;
grant select, insert, update on table public.policy_template_subscription_authorizations
  to service_role;
