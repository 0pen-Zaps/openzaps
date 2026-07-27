-- Round 6 (recurring-stack, v3.2) adds a FOURTH intent kind the Automate tab publishes: a recurring
-- series that converts a signed slice of every run's output into 0xZAPS and stakes it to the lottery
-- pot as the owner's tickets.
--
-- The kind must be widened HERE as well as in the TypeScript union. This is the exact step that was
-- missed when 'recurring-relative' shipped: the app validated the new kind happily, then PostgREST
-- rejected the insert against the CHECK constraint and every publish surfaced as an opaque
-- "Relay storage failed (400)". A new intent kind is not done until this constraint knows about it.
--
-- Additive and non-destructive: existing rows are all
-- ('recurring' | 'recurring-relative' | 'trigger'), which the new constraint still allows.

alter table public.zap_intents drop constraint if exists zap_intents_kind_check;

alter table public.zap_intents
  add constraint zap_intents_kind_check
  check (kind in ('recurring', 'recurring-relative', 'recurring-stack', 'trigger'));
