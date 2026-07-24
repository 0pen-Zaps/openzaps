-- The intent relay's storage: the shared pool of signed standing intents that connects owners
-- (who publish from the Automate tab) to executors (who poll to discover work). Apply with the
-- Supabase CLI (`supabase db push`) or paste into the SQL editor.
--
-- Security: RLS is ON with NO policies, so anon/public keys cannot read or write this table at all.
-- Every access goes through the `/api/intents` route using the SERVICE ROLE key (which bypasses
-- RLS) — and that route only stores an intent whose signature recovers to the zap's on-chain owner
-- and whose policy hash matches the on-chain capsule. So the pool cannot be spammed with junk, and
-- the relay is never a security dependency (the capsule re-verifies everything on-chain anyway).

create table if not exists public.zap_intents (
  id uuid primary key default gen_random_uuid(),
  zap text not null,
  owner text not null,
  chain_id integer not null,
  kind text not null check (kind in ('recurring', 'trigger')),
  nonce text not null,           -- seriesId (recurring) or nonce (trigger), as a decimal string
  intent jsonb not null,         -- the exact signed intent, all uint fields as decimal strings
  signature text not null,
  status text not null default 'open' check (status in ('open', 'consumed')),
  created_at timestamptz not null default now()
);

-- One row per (zap, kind, nonce): a re-publish of the same series/trigger merges instead of
-- duplicating (the route POSTs with resolution=merge-duplicates).
create unique index if not exists zap_intents_unique on public.zap_intents (zap, kind, nonce);

-- Executors list open intents newest-first.
create index if not exists zap_intents_status on public.zap_intents (status, created_at desc);

alter table public.zap_intents enable row level security;
