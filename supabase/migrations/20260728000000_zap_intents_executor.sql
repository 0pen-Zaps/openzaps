-- "Which agent may submit this run?" is not a fact we store. It is the `executor` field inside the
-- owner's signed intent, which the capsule enforces itself:
--
--     if (intent.executor != address(0) && msg.sender != intent.executor) revert ExecutorMismatch();
--
-- (OpenZapV3.sol:307,349 — OpenZapV3_1.sol:348,397,482)
--
-- To let an agent ask "what am I connected to?" the relay needs to filter on that field. It lives in
-- the `intent` jsonb and its case comes from whatever the signer wrote, so a naive
-- `intent->>'executor' = $1` silently misses every differently-cased pin — the classic address
-- comparison bug, in SQL.
--
-- A GENERATED column fixes both problems at once: it normalizes case, and because Postgres derives it
-- from the jsonb on every write, it cannot drift from the signed value. There is no code path that can
-- set it to something the signature does not say.
--
-- Additive and non-destructive: existing rows are backfilled by the generation expression, and nothing
-- reads this column except the new executor filter.

alter table public.zap_intents
  add column if not exists executor text
  generated always as (lower(intent->>'executor')) stored;

-- Paired with status because every real query is "open intents pinning this executor" — an executor
-- discovering its own work, or the profile answering "what is this agent connected to?".
create index if not exists zap_intents_executor on public.zap_intents (executor, status);

-- The zap filter serves the same discovery path from the other direction: "which agents may run THIS
-- capsule?". zap is already a plain column, so it only needs the index.
create index if not exists zap_intents_zap on public.zap_intents (zap, status);
