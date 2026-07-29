-- Round 5 (recurring-relative, v3.1) added a third intent kind the Automate tab publishes, but the
-- original zap_intents constraint only allowed ('recurring', 'trigger'). A recurring-relative publish
-- therefore violated the CHECK and PostgREST returned 400 ("Relay storage failed (400)") for every
-- recurring zap. This widens the constraint to accept it. Additive and non-destructive: existing
-- rows are all ('recurring' | 'trigger'), which the new constraint still allows.
--
-- Already applied to the live pool-fans-v2 project (jhzpyfzkdsyavgnnuzyu); this file keeps a
-- from-scratch `supabase db push` in sync.

alter table public.zap_intents drop constraint if exists zap_intents_kind_check;

alter table public.zap_intents
  add constraint zap_intents_kind_check
  check (kind in ('recurring', 'recurring-relative', 'trigger'));
