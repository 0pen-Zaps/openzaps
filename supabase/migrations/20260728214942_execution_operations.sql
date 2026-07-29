-- Durable, chain-verified receipts for the automation operations layer.
--
-- Trust model:
--   * callers may nominate a transaction hash, but the server derives every stored field from the
--     Robinhood chain before inserting it;
--   * these rows are evidence and reputation inputs only. They never authorize execution;
--   * browser roles cannot reach either table directly. Read access is exposed only through
--     bounded application routes, and writes use the server-side service role.
--
-- Supabase changed new-table Data API exposure in April 2026. Grants are therefore explicit rather
-- than relying on project default privileges. RLS remains enabled as a separate defense-in-depth
-- layer even though only the service role is granted table privileges.

create table if not exists public.execution_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_version smallint not null default 1 check (receipt_version = 1),
  chain_id integer not null check (chain_id > 0),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  relay_intent_id uuid references public.zap_intents(id) on delete set null,
  zap text not null check (zap ~ '^0x[0-9a-f]{40}$'),
  executor text not null check (executor ~ '^0x[0-9a-f]{40}$'),
  intent_kind text not null
    check (intent_kind in ('recurring', 'recurring-relative', 'recurring-stack', 'trigger')),
  intent_nonce text not null check (intent_nonce ~ '^[0-9]{1,78}$'),
  outcome text not null check (outcome in ('reverted', 'finalized')),
  block_number numeric(78, 0) not null check (block_number >= 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_time timestamptz not null,
  transaction_index integer not null check (transaction_index >= 0),
  log_index integer check (log_index is null or log_index >= 0),
  gas_used numeric(78, 0) not null check (gas_used >= 0),
  effective_gas_price numeric(78, 0) check (effective_gas_price is null or effective_gas_price >= 0),
  confirmations integer not null check (confirmations >= 1),
  event_name text,
  event_payload jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  -- Makes the non-authorizing nature of this evidence explicit and machine-checkable.
  authority_scope text not null default 'none' check (authority_scope = 'none'),
  unique (chain_id, tx_hash)
);

create index if not exists execution_receipts_executor
  on public.execution_receipts (executor, block_number desc, tx_hash desc);
create index if not exists execution_receipts_zap
  on public.execution_receipts (zap, block_number desc, tx_hash desc);
create index if not exists execution_receipts_intent
  on public.execution_receipts (relay_intent_id, block_number desc, tx_hash desc)
  where relay_intent_id is not null;

alter table public.execution_receipts enable row level security;

-- Explicit opt-in for the Data API after the April 2026 Supabase default change. Remove any
-- inherited/default privileges first, then grant only what the backend actually uses.
revoke all on table public.execution_receipts from anon, authenticated, service_role;
grant select, insert, update on table public.execution_receipts to service_role;

-- The relay predates the exposure change. Restate its intended access model so a fresh project and
-- an existing project behave identically: server-side select/insert/update, no direct browser role.
revoke all on table public.zap_intents from anon, authenticated, service_role;
grant select, insert, update on table public.zap_intents to service_role;

-- Expiry is signed and chain-time-derived, so the permissionless reaper may safely remove expired
-- authorizations from the open executor queue even though their nonce was never consumed.
alter table public.zap_intents drop constraint if exists zap_intents_status_check;
alter table public.zap_intents
  add constraint zap_intents_status_check check (status in ('open', 'consumed', 'expired'));
