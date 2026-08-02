-- Immutable, service-role-only evidence that an owner-approved DeFi Tutorials
-- handoff was observed at its exact canonical URL in the public Substack RSS.
-- The receipt stores only source-controlled workflow identifiers and public
-- publication metadata; it contains no author, subscriber, or request data.

create schema if not exists private;
revoke all on schema private
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;

create table public.marketing_tutorial_publication_receipts (
  tutorial_id text primary key
    check (
      char_length(tutorial_id) between 1 and 200
      and tutorial_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    ),
  run_id text not null
    check (
      char_length(run_id) between 1 and 200
      and run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  candidate_id text not null
    check (
      char_length(candidate_id) between 1 and 300
      and candidate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  source_path text not null
    check (source_path = 'docs/tutorials/' || tutorial_id || '.md'),
  source_sha256 text not null
    check (source_sha256 ~ '^[0-9a-f]{64}$'),
  body_sha256 text not null
    check (body_sha256 ~ '^[0-9a-f]{64}$'),
  approved_title text not null
    check (
      char_length(approved_title) between 1 and 200
      and approved_title = pg_catalog.btrim(approved_title)
      and approved_title !~ '[[:cntrl:]]'
    ),
  canonical_url text not null
    check (
      char_length(canonical_url) between 38 and 237
      and canonical_url ~ '^https://defitutorials[.]substack[.]com/p/[a-z0-9]+(-[a-z0-9]+)*$'
    ),
  feed_url text not null
    check (feed_url = 'https://defitutorials.substack.com/feed'),
  published_at timestamptz not null
    check (
      published_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      and published_at >= '2017-01-01 00:00:00+00'::timestamptz
    ),
  rss_checked_at timestamptz not null
    check (
      rss_checked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      and rss_checked_at >= published_at
    ),
  recorded_at timestamptz not null default pg_catalog.clock_timestamp()
    check (
      recorded_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    ),
  constraint marketing_tutorial_publication_receipts_canonical_url_key
    unique (canonical_url),
  constraint marketing_tutorial_publication_receipts_workflow_candidate_key
    unique (run_id, candidate_id)
);

alter table public.marketing_tutorial_publication_receipts
  enable row level security;
revoke all on table public.marketing_tutorial_publication_receipts
  from public, anon, authenticated, service_role;

create or replace function private.reject_marketing_tutorial_publication_receipt_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'marketing tutorial publication receipts are immutable';
end;
$function$;

revoke all on function private.reject_marketing_tutorial_publication_receipt_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists marketing_tutorial_publication_receipts_immutable
  on public.marketing_tutorial_publication_receipts;
create trigger marketing_tutorial_publication_receipts_immutable
before update or delete or truncate
on public.marketing_tutorial_publication_receipts
for each statement
execute function private.reject_marketing_tutorial_publication_receipt_mutation();

-- This is the only write path. A per-tutorial transaction lock makes the first
-- exact tuple authoritative. Replaying that tuple is idempotent; a different
-- tuple for the same tutorial returns the stored evidence without mutation.
create or replace function private.record_marketing_tutorial_publication_receipt(
  p_tutorial_id text,
  p_run_id text,
  p_candidate_id text,
  p_source_path text,
  p_source_sha256 text,
  p_body_sha256 text,
  p_approved_title text,
  p_canonical_url text,
  p_feed_url text,
  p_published_at timestamptz,
  p_rss_checked_at timestamptz
)
returns table (
  result_code text,
  tutorial_id text,
  run_id text,
  candidate_id text,
  source_path text,
  source_sha256 text,
  body_sha256 text,
  approved_title text,
  canonical_url text,
  feed_url text,
  published_at timestamptz,
  rss_checked_at timestamptz,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_receipt public.marketing_tutorial_publication_receipts%rowtype;
  outcome text;
begin
  if p_tutorial_id is null
    or char_length(p_tutorial_id) not between 1 and 200
    or p_tutorial_id !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or p_run_id is null
    or char_length(p_run_id) not between 1 and 200
    or p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_candidate_id is null
    or char_length(p_candidate_id) not between 1 and 300
    or p_candidate_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_source_path is null
    or p_source_path <> 'docs/tutorials/' || p_tutorial_id || '.md'
    or p_source_sha256 is null
    or p_source_sha256 !~ '^[0-9a-f]{64}$'
    or p_body_sha256 is null
    or p_body_sha256 !~ '^[0-9a-f]{64}$'
    or p_approved_title is null
    or char_length(p_approved_title) not between 1 and 200
    or p_approved_title <> pg_catalog.btrim(p_approved_title)
    or p_approved_title ~ '[[:cntrl:]]'
    or p_canonical_url is null
    or char_length(p_canonical_url) not between 38 and 237
    or p_canonical_url !~ '^https://defitutorials[.]substack[.]com/p/[a-z0-9]+(-[a-z0-9]+)*$'
    or p_feed_url is null
    or p_feed_url <> 'https://defitutorials.substack.com/feed'
    or p_published_at is null
    or p_published_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_published_at < '2017-01-01 00:00:00+00'::timestamptz
    or p_rss_checked_at is null
    or p_rss_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_rss_checked_at < p_published_at
    or p_rss_checked_at > pg_catalog.clock_timestamp() + interval '5 minutes'
  then
    raise exception 'invalid marketing tutorial publication receipt';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'openzaps-marketing-tutorial-publication:' || p_tutorial_id,
      0
    )
  );

  select receipts.*
  into current_receipt
  from public.marketing_tutorial_publication_receipts as receipts
  where receipts.tutorial_id = p_tutorial_id;

  if found then
    if current_receipt.run_id = p_run_id
      and current_receipt.candidate_id = p_candidate_id
      and current_receipt.source_path = p_source_path
      and current_receipt.source_sha256 = p_source_sha256
      and current_receipt.body_sha256 = p_body_sha256
      and current_receipt.approved_title = p_approved_title
      and current_receipt.canonical_url = p_canonical_url
      and current_receipt.feed_url = p_feed_url
      and current_receipt.published_at = p_published_at
      and current_receipt.rss_checked_at = p_rss_checked_at
    then
      outcome := 'already_recorded';
    else
      outcome := 'conflict';
    end if;
  else
    insert into public.marketing_tutorial_publication_receipts (
      tutorial_id,
      run_id,
      candidate_id,
      source_path,
      source_sha256,
      body_sha256,
      approved_title,
      canonical_url,
      feed_url,
      published_at,
      rss_checked_at
    ) values (
      p_tutorial_id,
      p_run_id,
      p_candidate_id,
      p_source_path,
      p_source_sha256,
      p_body_sha256,
      p_approved_title,
      p_canonical_url,
      p_feed_url,
      p_published_at,
      p_rss_checked_at
    )
    returning * into current_receipt;

    outcome := 'recorded';
  end if;

  return query select
    outcome,
    current_receipt.tutorial_id,
    current_receipt.run_id,
    current_receipt.candidate_id,
    current_receipt.source_path,
    current_receipt.source_sha256,
    current_receipt.body_sha256,
    current_receipt.approved_title,
    current_receipt.canonical_url,
    current_receipt.feed_url,
    current_receipt.published_at,
    current_receipt.rss_checked_at,
    current_receipt.recorded_at;
end;
$function$;

revoke all on function private.record_marketing_tutorial_publication_receipt(
  text, text, text, text, text, text, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function private.record_marketing_tutorial_publication_receipt(
  text, text, text, text, text, text, text, text, text, timestamptz, timestamptz
) to service_role;

create or replace function public.record_marketing_tutorial_publication_receipt(
  p_tutorial_id text,
  p_run_id text,
  p_candidate_id text,
  p_source_path text,
  p_source_sha256 text,
  p_body_sha256 text,
  p_approved_title text,
  p_canonical_url text,
  p_feed_url text,
  p_published_at timestamptz,
  p_rss_checked_at timestamptz
)
returns table (
  result_code text,
  tutorial_id text,
  run_id text,
  candidate_id text,
  source_path text,
  source_sha256 text,
  body_sha256 text,
  approved_title text,
  canonical_url text,
  feed_url text,
  published_at timestamptz,
  rss_checked_at timestamptz,
  recorded_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.record_marketing_tutorial_publication_receipt(
    p_tutorial_id,
    p_run_id,
    p_candidate_id,
    p_source_path,
    p_source_sha256,
    p_body_sha256,
    p_approved_title,
    p_canonical_url,
    p_feed_url,
    p_published_at,
    p_rss_checked_at
  );
$function$;

revoke all on function public.record_marketing_tutorial_publication_receipt(
  text, text, text, text, text, text, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_marketing_tutorial_publication_receipt(
  text, text, text, text, text, text, text, text, text, timestamptz, timestamptz
) to service_role;
