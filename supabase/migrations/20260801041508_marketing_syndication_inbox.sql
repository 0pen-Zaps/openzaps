-- Durable, fail-closed inbox for syndicating canonical OpenZaps and DeFi
-- Tutorials feed entries into the reviewed marketing workflow.
--
-- The inbox stores only public feed metadata. It deliberately has no content
-- body, author/contact fields, cookies, request headers, or provider secrets.
-- Service-role callers can use the bounded public RPCs, but no Data API role
-- can read or mutate either table directly.

create table public.marketing_syndication_sources (
  source_key text primary key
    check (source_key in ('openzaps', 'defitutorials')),
  initialized_at timestamptz not null,
  etag text
    check (
      etag is null
      or (
        char_length(etag) between 1 and 512
        and etag !~ '[[:cntrl:]]'
      )
    ),
  last_modified text
    check (
      last_modified is null
      or (
        char_length(last_modified) between 1 and 128
        and last_modified !~ '[[:cntrl:]]'
      )
    ),
  last_checked_at timestamptz not null,
  check (last_checked_at >= initialized_at)
);

alter table public.marketing_syndication_sources enable row level security;
revoke all on table public.marketing_syndication_sources
  from public, anon, authenticated, service_role;

create table public.marketing_syndication_items (
  source_key text not null
    references public.marketing_syndication_sources (source_key),
  source_item_key text not null
    unique
    check (source_item_key ~ '^[0-9a-f]{64}$'),
  item_key text generated always as
    (source_key || ':' || source_item_key) stored,
  canonical_url text not null unique
    check (
      char_length(canonical_url) between 1 and 2048
      and canonical_url !~ '[[:space:][:cntrl:]]'
      and canonical_url !~ '[?#]'
      and (
        (
          source_key = 'openzaps'
          and canonical_url ~ '^https://www\.0xzaps\.com/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*$'
        )
        or (
          source_key = 'defitutorials'
          and canonical_url ~ '^https://defitutorials\.substack\.com/p/[a-z0-9][a-z0-9-]*$'
        )
      )
    ),
  title text not null
    check (
      char_length(title) between 1 and 200
      and btrim(title) = title
      and title !~ '[[:cntrl:]]'
    ),
  campaign_slug text not null
    check (campaign_slug ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
  source_published_at timestamptz,
  classification text not null
    check (classification in ('tutorial', 'product_update', 'unknown')),
  check (
    (source_key = 'openzaps' and classification in ('product_update', 'unknown'))
    or (
      source_key = 'defitutorials'
      and classification in ('tutorial', 'unknown')
    )
  ),
  state text not null
    check (
      state in (
        'baseline',
        'pending',
        'drafting',
        'awaiting_approval',
        'published',
        'skipped',
        'failed'
      )
    ),
  workflow_run_id text
    check (
      workflow_run_id is null
      or (
        char_length(workflow_run_id) between 1 and 200
        and workflow_run_id !~ '[[:space:]/\\]'
        and workflow_run_id !~ '[[:cntrl:]]'
      )
    ),
  discovered_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  state_changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  draft_claimed_at timestamptz,
  draft_completed_at timestamptz,
  syndicated_at timestamptz,
  skipped_at timestamptz,
  failed_at timestamptz,
  primary key (item_key),
  unique (source_key, source_item_key),
  check (
    (
      source_published_at is null
      and classification = 'unknown'
    )
    or (
      source_published_at is not null
      and source_published_at not in (
        '-infinity'::timestamptz,
        'infinity'::timestamptz
      )
    )
  ),
  check (updated_at >= discovered_at),
  check (state_changed_at >= discovered_at),
  check (
    (
      state in ('baseline', 'pending')
      and workflow_run_id is null
      and draft_claimed_at is null
      and draft_completed_at is null
      and syndicated_at is null
      and skipped_at is null
      and failed_at is null
    )
    or (
      state = 'drafting'
      and draft_claimed_at is not null
      and draft_completed_at is null
      and syndicated_at is null
      and skipped_at is null
      and failed_at is null
    )
    or (
      state = 'awaiting_approval'
      and workflow_run_id is not null
      and draft_claimed_at is not null
      and draft_completed_at is not null
      and draft_completed_at >= draft_claimed_at
      and syndicated_at is null
      and skipped_at is null
      and failed_at is null
    )
    or (
      state = 'published'
      and workflow_run_id is not null
      and draft_claimed_at is not null
      and draft_completed_at is not null
      and draft_completed_at >= draft_claimed_at
      and syndicated_at is not null
      and syndicated_at >= draft_completed_at
      and skipped_at is null
      and failed_at is null
    )
    or (
      state = 'skipped'
      and workflow_run_id is null
      and draft_claimed_at is null
      and draft_completed_at is null
      and syndicated_at is null
      and skipped_at is not null
      and failed_at is null
    )
    or (
      state = 'failed'
      and draft_claimed_at is not null
      and syndicated_at is null
      and skipped_at is null
      and failed_at is not null
      and failed_at >= draft_claimed_at
      and (
        (
          workflow_run_id is null
          and draft_completed_at is null
        )
        or (
          workflow_run_id is not null
          and draft_completed_at is not null
          and draft_completed_at >= draft_claimed_at
        )
      )
    )
  )
);

create index marketing_syndication_items_operator_order
  on public.marketing_syndication_items (
    state,
    source_published_at desc,
    item_key
  );

alter table public.marketing_syndication_items enable row level security;
revoke all on table public.marketing_syndication_items
  from public, anon, authenticated, service_role;

create or replace function private.enforce_marketing_syndication_source_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.source_key <> old.source_key
    or new.initialized_at <> old.initialized_at
    or new.last_checked_at < old.last_checked_at
  then
    raise exception 'marketing syndication source identity is immutable';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_marketing_syndication_source_update()
  from public, anon, authenticated, service_role;

create trigger marketing_syndication_sources_guard
before update
on public.marketing_syndication_sources
for each row
execute function private.enforce_marketing_syndication_source_update();

create or replace function private.enforce_marketing_syndication_item_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.item_key <> old.item_key
    or new.source_key <> old.source_key
    or new.source_item_key <> old.source_item_key
    or new.canonical_url <> old.canonical_url
    or (
      new.title <> old.title
      and not (
        old.classification = 'unknown'
        and new.classification in ('tutorial', 'product_update')
        and old.state in ('baseline', 'pending')
        and new.state = old.state
      )
    )
    or new.campaign_slug <> old.campaign_slug
    or (
      new.source_published_at is distinct from old.source_published_at
      and not (
        old.classification = 'unknown'
        and new.classification in ('tutorial', 'product_update')
        and old.source_published_at is null
        and new.source_published_at is not null
        and old.state in ('baseline', 'pending')
        and new.state = old.state
      )
    )
    or new.discovered_at <> old.discovered_at
  then
    raise exception 'marketing syndication item identity is immutable';
  end if;

  if new.classification <> old.classification
    and not (
      old.classification = 'unknown'
      and new.classification in ('tutorial', 'product_update')
      and old.state in ('baseline', 'pending')
      and new.state = old.state
    )
  then
    raise exception 'invalid marketing syndication classification transition';
  end if;

  if new.state <> old.state
    and not (
      (old.state = 'pending' and new.state in ('drafting', 'skipped'))
      or (
        old.state = 'drafting'
        and new.state in ('awaiting_approval', 'failed')
      )
      or (
        old.state = 'awaiting_approval'
        and new.state in ('published', 'failed')
      )
    )
  then
    raise exception 'invalid marketing syndication state transition';
  end if;

  if old.workflow_run_id is not null
    and new.workflow_run_id is distinct from old.workflow_run_id
  then
    raise exception 'marketing syndication workflow identity is immutable';
  end if;

  if old.draft_claimed_at is not null
    and new.draft_claimed_at is distinct from old.draft_claimed_at
  then
    raise exception 'marketing syndication claim timestamp is immutable';
  end if;

  if old.draft_completed_at is not null
    and new.draft_completed_at is distinct from old.draft_completed_at
  then
    raise exception 'marketing syndication completion timestamp is immutable';
  end if;

  if old.syndicated_at is not null
    and new.syndicated_at is distinct from old.syndicated_at
  then
    raise exception 'marketing syndication publication timestamp is immutable';
  end if;

  if old.skipped_at is not null
    and new.skipped_at is distinct from old.skipped_at
  then
    raise exception 'marketing syndication skip timestamp is immutable';
  end if;

  if old.failed_at is not null
    and new.failed_at is distinct from old.failed_at
  then
    raise exception 'marketing syndication failure timestamp is immutable';
  end if;

  if new.state = old.state and new.state_changed_at <> old.state_changed_at then
    raise exception 'marketing syndication state timestamp changed without a transition';
  end if;

  if new.state <> old.state and new.state_changed_at <= old.state_changed_at then
    raise exception 'marketing syndication state timestamp must advance';
  end if;

  if new.updated_at < old.updated_at then
    raise exception 'marketing syndication update timestamp cannot move backwards';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_marketing_syndication_item_update()
  from public, anon, authenticated, service_role;

create trigger marketing_syndication_items_guard
before update
on public.marketing_syndication_items
for each row
execute function private.enforce_marketing_syndication_item_update();

create or replace function private.reject_marketing_syndication_deletion()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'marketing syndication evidence is append-only';
end;
$function$;

revoke all on function private.reject_marketing_syndication_deletion()
  from public, anon, authenticated, service_role;

create trigger marketing_syndication_sources_append_only
before delete or truncate
on public.marketing_syndication_sources
for each statement
execute function private.reject_marketing_syndication_deletion();

create trigger marketing_syndication_items_append_only
before delete or truncate
on public.marketing_syndication_items
for each statement
execute function private.reject_marketing_syndication_deletion();

create or replace function private.get_marketing_syndication_source_cursor(
  p_source_key text
)
returns table (
  result_code text,
  source_key text,
  initialized_at timestamptz,
  etag text,
  last_modified text,
  last_checked_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_source public.marketing_syndication_sources%rowtype;
begin
  if p_source_key is null
    or p_source_key not in ('openzaps', 'defitutorials')
  then
    raise exception 'invalid marketing syndication source';
  end if;

  select sources.*
  into current_source
  from public.marketing_syndication_sources as sources
  where sources.source_key = p_source_key;

  if not found then
    return query
      select
        'not_initialized'::text,
        p_source_key,
        null::timestamptz,
        null::text,
        null::text,
        null::timestamptz;
    return;
  end if;

  return query
    select
      'found'::text,
      current_source.source_key,
      current_source.initialized_at,
      current_source.etag,
      current_source.last_modified,
      current_source.last_checked_at;
end;
$function$;

revoke all on function private.get_marketing_syndication_source_cursor(text)
  from public, anon, authenticated, service_role;
grant execute on function private.get_marketing_syndication_source_cursor(text)
  to service_role;

create or replace function public.get_marketing_syndication_source_cursor(
  p_source_key text
)
returns table (
  result_code text,
  source_key text,
  initialized_at timestamptz,
  etag text,
  last_modified text,
  last_checked_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.get_marketing_syndication_source_cursor(p_source_key);
$function$;

revoke all on function public.get_marketing_syndication_source_cursor(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_syndication_source_cursor(text)
  to service_role;

create or replace function private.discover_marketing_syndication_items(
  p_snapshot jsonb,
  p_initialize_as_baseline boolean
)
returns table (
  result_code text,
  source_key text,
  initialized_at timestamptz,
  discovered_count integer,
  baseline_count integer,
  pending_count integer,
  existing_count integer,
  reclassified_count integer,
  etag text,
  last_modified text,
  last_checked_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  requested_source text;
  requested_etag text;
  requested_last_modified text;
  requested_not_modified boolean;
  requested_items jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
  current_source public.marketing_syndication_sources%rowtype;
  initialized_now timestamptz;
  item_count integer;
  already_count integer := 0;
  promoted_count integer := 0;
  inserted_count integer := 0;
begin
  if p_snapshot is null
    or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
    or not (p_snapshot ?& array[
      'source_key',
      'etag',
      'last_modified',
      'not_modified',
      'items'
    ])
    or (
      select count(*)
      from pg_catalog.jsonb_object_keys(p_snapshot)
    ) <> 5
    or pg_catalog.jsonb_typeof(p_snapshot -> 'source_key') <> 'string'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'not_modified') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'items') <> 'array'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'etag') not in ('string', 'null')
    or pg_catalog.jsonb_typeof(p_snapshot -> 'last_modified') not in ('string', 'null')
    or p_initialize_as_baseline is null
  then
    raise exception 'invalid marketing syndication snapshot shape';
  end if;

  requested_source := p_snapshot ->> 'source_key';
  requested_etag := p_snapshot ->> 'etag';
  requested_last_modified := p_snapshot ->> 'last_modified';
  requested_not_modified := (p_snapshot ->> 'not_modified')::boolean;
  requested_items := p_snapshot -> 'items';
  item_count := pg_catalog.jsonb_array_length(requested_items);

  if requested_source not in ('openzaps', 'defitutorials')
    or item_count not between 0 and 100
    or (
      requested_etag is not null
      and (
        char_length(requested_etag) not between 1 and 512
        or requested_etag ~ '[[:cntrl:]]'
      )
    )
    or (
      requested_last_modified is not null
      and (
        char_length(requested_last_modified) not between 1 and 128
        or requested_last_modified ~ '[[:cntrl:]]'
      )
    )
    or (
      requested_not_modified
      and (item_count <> 0 or p_initialize_as_baseline)
    )
    or (
      not requested_not_modified
      and item_count = 0
    )
  then
    raise exception 'invalid marketing syndication snapshot';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(requested_items) as entries(item)
    where pg_catalog.jsonb_typeof(entries.item) <> 'object'
      or not (entries.item ?& array[
        'source_item_key',
        'canonical_url',
        'title',
        'campaign_slug',
        'published_at',
        'classification'
      ])
      or (
        select count(*)
        from pg_catalog.jsonb_object_keys(entries.item)
      ) <> 6
      or pg_catalog.jsonb_typeof(entries.item -> 'source_item_key') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'canonical_url') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'title') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'campaign_slug') <> 'string'
      or pg_catalog.jsonb_typeof(entries.item -> 'published_at') not in ('string', 'null')
      or pg_catalog.jsonb_typeof(entries.item -> 'classification') <> 'string'
  ) then
    raise exception 'invalid marketing syndication item shape';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(requested_items) as item(
      source_item_key text,
      canonical_url text,
      title text,
      campaign_slug text,
      published_at timestamptz,
      classification text
    )
    where item.source_item_key is null
      or item.source_item_key !~ '^[0-9a-f]{64}$'
      or item.canonical_url is null
      or char_length(item.canonical_url) not between 1 and 2048
      or item.canonical_url ~ '[[:space:][:cntrl:]]'
      or item.canonical_url ~ '[?#]'
      or (
        requested_source = 'openzaps'
        and item.canonical_url !~ '^https://www\.0xzaps\.com/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*$'
      )
      or (
        requested_source = 'defitutorials'
        and item.canonical_url !~ '^https://defitutorials\.substack\.com/p/[a-z0-9][a-z0-9-]*$'
      )
      or item.title is null
      or char_length(item.title) not between 1 and 200
      or pg_catalog.btrim(item.title) <> item.title
      or item.title ~ '[[:cntrl:]]'
      or item.campaign_slug is null
      or item.campaign_slug !~ '^[a-z0-9][a-z0-9-]{0,95}$'
      or item.classification is null
      or item.classification not in ('tutorial', 'product_update', 'unknown')
      or (
        requested_source = 'openzaps'
        and item.classification not in ('product_update', 'unknown')
      )
      or (
        requested_source = 'defitutorials'
        and item.classification not in ('tutorial', 'unknown')
      )
      or (item.published_at is null and item.classification <> 'unknown')
      or item.published_at in (
        '-infinity'::timestamptz,
        'infinity'::timestamptz
      )
      or item.published_at > checked_at + interval '1 day'
  ) then
    raise exception 'invalid marketing syndication item';
  end if;

  if (
    select count(*)
    from pg_catalog.jsonb_to_recordset(requested_items) as item(
      source_item_key text,
      canonical_url text
    )
  ) <> (
    select count(distinct item.source_item_key)
    from pg_catalog.jsonb_to_recordset(requested_items) as item(
      source_item_key text
    )
  )
  or (
    select count(*)
    from pg_catalog.jsonb_to_recordset(requested_items) as item(
      source_item_key text,
      canonical_url text
    )
  ) <> (
    select count(distinct item.canonical_url)
    from pg_catalog.jsonb_to_recordset(requested_items) as item(
      canonical_url text
    )
  ) then
    raise exception 'duplicate marketing syndication item identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openzaps-marketing-syndication-discovery', 0)
  );

  select sources.*
  into current_source
  from public.marketing_syndication_sources as sources
  where sources.source_key = requested_source
  for update;

  if found then
    checked_at := greatest(checked_at, current_source.last_checked_at);
  end if;

  if requested_not_modified then
    if not found then
      return query
        select
          'baseline_required'::text,
          requested_source,
          null::timestamptz,
          0,
          0,
          0,
          0,
          0,
          null::text,
          null::text,
          null::timestamptz;
      return;
    end if;

    update public.marketing_syndication_sources as sources
    set
      etag = coalesce(requested_etag, sources.etag),
      last_modified = coalesce(
        requested_last_modified,
        sources.last_modified
      ),
      last_checked_at = checked_at
    where sources.source_key = requested_source
    returning
      sources.initialized_at,
      sources.etag,
      sources.last_modified,
      sources.last_checked_at
    into
      initialized_now,
      requested_etag,
      requested_last_modified,
      checked_at;

    return query
      select
        'not_modified'::text,
        requested_source,
        initialized_now,
        0,
        0,
        0,
        0,
        0,
        requested_etag,
        requested_last_modified,
        checked_at;
    return;
  end if;

  if not found and not p_initialize_as_baseline then
    return query
      select
        'baseline_required'::text,
        requested_source,
        null::timestamptz,
        0,
        0,
        0,
        0,
        0,
        null::text,
        null::text,
        null::timestamptz;
    return;
  end if;

  if found and p_initialize_as_baseline then
    return query
      select
        'already_initialized'::text,
        requested_source,
        current_source.initialized_at,
        0,
        0,
        0,
        0,
        0,
        current_source.etag,
        current_source.last_modified,
        current_source.last_checked_at;
    return;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(requested_items) as incoming(
      source_item_key text,
      canonical_url text,
      title text,
      campaign_slug text,
      published_at timestamptz,
      classification text
    )
    join public.marketing_syndication_items as stored
      on stored.source_item_key = incoming.source_item_key
      or stored.canonical_url = incoming.canonical_url
    where stored.source_key <> requested_source
      or stored.source_item_key <> incoming.source_item_key
      or stored.canonical_url <> incoming.canonical_url
      or stored.campaign_slug <> incoming.campaign_slug
      or (
        stored.classification <> incoming.classification
        and stored.classification <> 'unknown'
        and incoming.classification <> 'unknown'
      )
  ) then
    raise exception 'marketing syndication item identity conflict';
  end if;

  -- Feed titles and publication timestamps can be edited after publication.
  -- They are not identity fields: preserve the first stored evidence instead
  -- of letting ordinary metadata drift block every newer item in the source.
  -- The bounded unknown-to-known promotion below may adopt the now-approved
  -- title and fill a previously absent publication timestamp only while the
  -- item remains baseline or pending.

  if not found then
    insert into public.marketing_syndication_sources (
      source_key,
      initialized_at,
      etag,
      last_modified,
      last_checked_at
    )
    values (
      requested_source,
      checked_at,
      requested_etag,
      requested_last_modified,
      checked_at
    )
    returning marketing_syndication_sources.initialized_at
    into initialized_now;
  else
    update public.marketing_syndication_sources as sources
    set
      etag = requested_etag,
      last_modified = requested_last_modified,
      last_checked_at = checked_at
    where sources.source_key = requested_source
    returning sources.initialized_at
    into initialized_now;
  end if;

  select count(*)::integer
  into already_count
  from pg_catalog.jsonb_to_recordset(requested_items) as incoming(
    source_item_key text
  )
  join public.marketing_syndication_items as stored
    on stored.source_item_key = incoming.source_item_key;

  select count(*)::integer
  into promoted_count
  from pg_catalog.jsonb_to_recordset(requested_items) as incoming(
    source_item_key text,
    classification text
  )
  join public.marketing_syndication_items as stored
    on stored.source_item_key = incoming.source_item_key
  where stored.classification = 'unknown'
    and incoming.classification in ('tutorial', 'product_update')
    and stored.state in ('baseline', 'pending');

  insert into public.marketing_syndication_items (
    source_key,
    source_item_key,
    canonical_url,
    title,
    campaign_slug,
    source_published_at,
    classification,
    state,
    discovered_at,
    updated_at,
    state_changed_at
  )
  select
    requested_source,
    incoming.source_item_key,
    incoming.canonical_url,
    incoming.title,
    incoming.campaign_slug,
    incoming.published_at,
    incoming.classification,
    case
      when p_initialize_as_baseline then 'baseline'
      else 'pending'
    end,
    checked_at,
    checked_at,
    checked_at
  from pg_catalog.jsonb_to_recordset(requested_items) as incoming(
    source_item_key text,
    canonical_url text,
    title text,
    campaign_slug text,
    published_at timestamptz,
    classification text
  )
  where not exists (
    select 1
    from public.marketing_syndication_items as stored
    where stored.source_item_key = incoming.source_item_key
  );

  get diagnostics inserted_count = row_count;

  update public.marketing_syndication_items as stored
  set
    title = incoming.title,
    classification = incoming.classification,
    source_published_at = coalesce(
      stored.source_published_at,
      incoming.published_at
    ),
    updated_at = checked_at
  from pg_catalog.jsonb_to_recordset(requested_items) as incoming(
    source_item_key text,
    title text,
    classification text,
    published_at timestamptz
  )
  where stored.source_item_key = incoming.source_item_key
    and stored.classification = 'unknown'
    and incoming.classification in ('tutorial', 'product_update')
    and stored.state in ('baseline', 'pending');

  select
    sources.etag,
    sources.last_modified,
    sources.last_checked_at
  into
    requested_etag,
    requested_last_modified,
    checked_at
  from public.marketing_syndication_sources as sources
  where sources.source_key = requested_source;

  return query
    select
      case
        when p_initialize_as_baseline then 'baselined'::text
        else 'discovered'::text
      end,
      requested_source,
      initialized_now,
      item_count,
      case when p_initialize_as_baseline then inserted_count else 0 end,
      case when p_initialize_as_baseline then 0 else inserted_count end,
      already_count,
      promoted_count,
      requested_etag,
      requested_last_modified,
      checked_at;
end;
$function$;

revoke all on function private.discover_marketing_syndication_items(
  jsonb, boolean
) from public, anon, authenticated, service_role;
grant execute on function private.discover_marketing_syndication_items(
  jsonb, boolean
) to service_role;

create or replace function public.discover_marketing_syndication_items(
  p_snapshot jsonb,
  p_initialize_as_baseline boolean
)
returns table (
  result_code text,
  source_key text,
  initialized_at timestamptz,
  discovered_count integer,
  baseline_count integer,
  pending_count integer,
  existing_count integer,
  reclassified_count integer,
  etag text,
  last_modified text,
  last_checked_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.discover_marketing_syndication_items(
    p_snapshot,
    p_initialize_as_baseline
  );
$function$;

revoke all on function public.discover_marketing_syndication_items(
  jsonb, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.discover_marketing_syndication_items(
  jsonb, boolean
) to service_role;

create or replace function private.list_marketing_syndication_items(
  p_limit integer
)
returns table (
  item_id text,
  source_key text,
  canonical_url text,
  title text,
  campaign_slug text,
  source_published_at timestamptz,
  classification text,
  state text,
  workflow_run_id text,
  discovered_at timestamptz,
  state_changed_at timestamptz,
  draft_claimed_at timestamptz,
  draft_completed_at timestamptz,
  syndicated_at timestamptz,
  skipped_at timestamptz,
  failed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid marketing syndication list limit';
  end if;

  return query
    select
      items.source_item_key,
      items.source_key,
      items.canonical_url,
      items.title,
      items.campaign_slug,
      items.source_published_at,
      items.classification,
      items.state,
      items.workflow_run_id,
      items.discovered_at,
      items.state_changed_at,
      items.draft_claimed_at,
      items.draft_completed_at,
      items.syndicated_at,
      items.skipped_at,
      items.failed_at
    from public.marketing_syndication_items as items
    order by
      case items.state
        -- Attached workflows must stay inside the bounded operator page so
        -- their durable state can be reconciled even when pending items grow.
        when 'drafting' then 0
        when 'awaiting_approval' then 1
        when 'pending' then 2
        when 'failed' then 3
        when 'published' then 4
        when 'skipped' then 5
        else 6
      end,
      items.source_published_at desc nulls last,
      items.item_key
    limit p_limit;
end;
$function$;

revoke all on function private.list_marketing_syndication_items(integer)
  from public, anon, authenticated, service_role;
grant execute on function private.list_marketing_syndication_items(integer)
  to service_role;

create or replace function public.list_marketing_syndication_items(
  p_limit integer
)
returns table (
  item_id text,
  source_key text,
  canonical_url text,
  title text,
  campaign_slug text,
  source_published_at timestamptz,
  classification text,
  state text,
  workflow_run_id text,
  discovered_at timestamptz,
  state_changed_at timestamptz,
  draft_claimed_at timestamptz,
  draft_completed_at timestamptz,
  syndicated_at timestamptz,
  skipped_at timestamptz,
  failed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.list_marketing_syndication_items(p_limit);
$function$;

revoke all on function public.list_marketing_syndication_items(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_marketing_syndication_items(integer)
  to service_role;

create or replace function private.claim_marketing_syndication_draft(
  p_item_id text
)
returns table (
  result_code text,
  item_id text,
  source_key text,
  canonical_url text,
  title text,
  campaign_slug text,
  source_published_at timestamptz,
  classification text,
  state text,
  workflow_run_id text,
  draft_claimed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_item public.marketing_syndication_items%rowtype;
  transition_at timestamptz;
  outcome text;
begin
  if p_item_id is null
    or p_item_id !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid marketing syndication item key';
  end if;

  select items.*
  into current_item
  from public.marketing_syndication_items as items
  where items.source_item_key = p_item_id
  for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_item_id,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::text,
        null::text,
        null::text,
        null::timestamptz;
    return;
  end if;

  if current_item.state = 'pending'
    and current_item.classification in ('tutorial', 'product_update')
    -- Reserve 80 X code points for the mandatory pre-audit disclosure,
    -- separators, and meaningful copy. The canonical/UTM data is ASCII.
    and char_length(current_item.canonical_url)
      + 69
      + char_length(current_item.campaign_slug) <= 200
  then
    transition_at := greatest(
      pg_catalog.clock_timestamp(),
      current_item.state_changed_at + interval '1 microsecond'
    );

    update public.marketing_syndication_items as items
    set
      state = 'drafting',
      updated_at = transition_at,
      state_changed_at = transition_at,
      draft_claimed_at = transition_at
    where items.source_item_key = p_item_id
    returning items.*
    into current_item;

    outcome := 'claimed';
  elsif current_item.classification = 'unknown' then
    outcome := 'unknown_classification';
  elsif current_item.state = 'drafting' then
    outcome := 'already_claimed';
  elsif current_item.state in ('awaiting_approval', 'published') then
    outcome := 'already_completed';
  elsif current_item.state = 'failed' then
    outcome := 'failed';
  else
    outcome := 'not_claimable';
  end if;

  return query
    select
      outcome,
      current_item.source_item_key,
      current_item.source_key,
      current_item.canonical_url,
      current_item.title,
      current_item.campaign_slug,
      current_item.source_published_at,
      current_item.classification,
      current_item.state,
      current_item.workflow_run_id,
      current_item.draft_claimed_at;
end;
$function$;

revoke all on function private.claim_marketing_syndication_draft(text)
  from public, anon, authenticated, service_role;
grant execute on function private.claim_marketing_syndication_draft(text)
  to service_role;

create or replace function public.claim_marketing_syndication_draft(
  p_item_id text
)
returns table (
  result_code text,
  item_id text,
  source_key text,
  canonical_url text,
  title text,
  campaign_slug text,
  source_published_at timestamptz,
  classification text,
  state text,
  workflow_run_id text,
  draft_claimed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.claim_marketing_syndication_draft(p_item_id);
$function$;

revoke all on function public.claim_marketing_syndication_draft(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_marketing_syndication_draft(text)
  to service_role;

create or replace function private.attach_marketing_syndication_workflow(
  p_item_id text,
  p_workflow_run_id text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_item public.marketing_syndication_items%rowtype;
  attached_at timestamptz;
  outcome text;
begin
  if p_item_id is null
    or p_item_id !~ '^[0-9a-f]{64}$'
    or p_workflow_run_id is null
    or char_length(p_workflow_run_id) not between 1 and 200
    or p_workflow_run_id ~ '[[:space:]/\\]'
    or p_workflow_run_id ~ '[[:cntrl:]]'
  then
    raise exception 'invalid marketing syndication workflow attachment';
  end if;

  select items.*
  into current_item
  from public.marketing_syndication_items as items
  where items.source_item_key = p_item_id
  for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_item_id,
        null::text,
        null::text,
        null::timestamptz;
    return;
  end if;

  if current_item.state = 'drafting'
    and current_item.workflow_run_id is null
  then
    attached_at := greatest(
      pg_catalog.clock_timestamp(),
      current_item.updated_at + interval '1 microsecond'
    );

    update public.marketing_syndication_items as items
    set
      workflow_run_id = p_workflow_run_id,
      updated_at = attached_at
    where items.source_item_key = p_item_id
    returning items.*
    into current_item;

    outcome := 'attached';
  elsif current_item.state in (
    'drafting',
    'awaiting_approval',
    'published',
    'failed'
  )
    and current_item.workflow_run_id is not null
  then
    if current_item.workflow_run_id = p_workflow_run_id then
      outcome := 'already_attached';
    else
      outcome := 'workflow_conflict';
    end if;
  elsif current_item.state = 'pending' then
    outcome := 'not_claimed';
  else
    outcome := 'not_claimable';
  end if;

  return query
    select
      outcome,
      current_item.source_item_key,
      current_item.state,
      current_item.workflow_run_id,
      current_item.state_changed_at;
end;
$function$;

revoke all on function private.attach_marketing_syndication_workflow(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.attach_marketing_syndication_workflow(text, text)
  to service_role;

create or replace function public.attach_marketing_syndication_workflow(
  p_item_id text,
  p_workflow_run_id text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.attach_marketing_syndication_workflow(
    p_item_id,
    p_workflow_run_id
  );
$function$;

revoke all on function public.attach_marketing_syndication_workflow(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attach_marketing_syndication_workflow(text, text)
  to service_role;

create or replace function private.fail_marketing_syndication_draft(
  p_item_id text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_item public.marketing_syndication_items%rowtype;
  transition_at timestamptz;
  outcome text;
begin
  if p_item_id is null
    or p_item_id !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid marketing syndication item key';
  end if;

  select items.*
  into current_item
  from public.marketing_syndication_items as items
  where items.source_item_key = p_item_id
  for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_item_id,
        null::text,
        null::text,
        null::timestamptz;
    return;
  end if;

  if current_item.state = 'drafting'
    and current_item.workflow_run_id is null
  then
    transition_at := greatest(
      pg_catalog.clock_timestamp(),
      current_item.state_changed_at + interval '1 microsecond'
    );

    update public.marketing_syndication_items as items
    set
      state = 'failed',
      updated_at = transition_at,
      state_changed_at = transition_at,
      failed_at = transition_at
    where items.source_item_key = p_item_id
    returning items.*
    into current_item;

    outcome := 'failed';
  elsif current_item.state = 'failed' then
    outcome := 'already_failed';
  elsif current_item.state in ('awaiting_approval', 'published') then
    outcome := 'already_completed';
  elsif current_item.state = 'drafting' then
    outcome := 'not_claimable';
  elsif current_item.state = 'pending' then
    outcome := 'not_claimed';
  else
    outcome := 'not_claimable';
  end if;

  return query
    select
      outcome,
      current_item.source_item_key,
      current_item.state,
      current_item.workflow_run_id,
      current_item.state_changed_at;
end;
$function$;

revoke all on function private.fail_marketing_syndication_draft(text)
  from public, anon, authenticated, service_role;
grant execute on function private.fail_marketing_syndication_draft(text)
  to service_role;

create or replace function public.fail_marketing_syndication_draft(
  p_item_id text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.fail_marketing_syndication_draft(p_item_id);
$function$;

revoke all on function public.fail_marketing_syndication_draft(text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_marketing_syndication_draft(text)
  to service_role;

create or replace function private.skip_marketing_syndication_item(
  p_item_id text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_item public.marketing_syndication_items%rowtype;
  transition_at timestamptz;
  outcome text;
begin
  if p_item_id is null
    or p_item_id !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid marketing syndication item key';
  end if;

  select items.*
  into current_item
  from public.marketing_syndication_items as items
  where items.source_item_key = p_item_id
  for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_item_id,
        null::text,
        null::text,
        null::timestamptz;
    return;
  end if;

  if current_item.state = 'pending' then
    transition_at := greatest(
      pg_catalog.clock_timestamp(),
      current_item.state_changed_at + interval '1 microsecond'
    );

    update public.marketing_syndication_items as items
    set
      state = 'skipped',
      updated_at = transition_at,
      state_changed_at = transition_at,
      skipped_at = transition_at
    where items.source_item_key = p_item_id
    returning items.*
    into current_item;

    outcome := 'skipped';
  elsif current_item.state = 'skipped' then
    outcome := 'already_skipped';
  elsif current_item.state = 'drafting' then
    outcome := 'in_progress';
  else
    outcome := 'not_claimable';
  end if;

  return query
    select
      outcome,
      current_item.source_item_key,
      current_item.state,
      current_item.workflow_run_id,
      current_item.state_changed_at;
end;
$function$;

revoke all on function private.skip_marketing_syndication_item(text)
  from public, anon, authenticated, service_role;
grant execute on function private.skip_marketing_syndication_item(text)
  to service_role;

create or replace function public.skip_marketing_syndication_item(
  p_item_id text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.skip_marketing_syndication_item(p_item_id);
$function$;

revoke all on function public.skip_marketing_syndication_item(text)
  from public, anon, authenticated, service_role;
grant execute on function public.skip_marketing_syndication_item(text)
  to service_role;

create or replace function private.sync_marketing_syndication_item(
  p_item_id text,
  p_workflow_run_id text,
  p_state text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_item public.marketing_syndication_items%rowtype;
  transition_at timestamptz;
  outcome text;
begin
  if p_item_id is null
    or p_item_id !~ '^[0-9a-f]{64}$'
    or p_workflow_run_id is null
    or char_length(p_workflow_run_id) not between 1 and 200
    or p_workflow_run_id ~ '[[:space:]/\\]'
    or p_workflow_run_id ~ '[[:cntrl:]]'
    or p_state is null
    or p_state not in ('awaiting_approval', 'published', 'failed')
  then
    raise exception 'invalid marketing syndication workflow sync';
  end if;

  select items.*
  into current_item
  from public.marketing_syndication_items as items
  where items.source_item_key = p_item_id
  for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_item_id,
        null::text,
        null::text,
        null::timestamptz;
    return;
  end if;

  if current_item.workflow_run_id is null then
    outcome := 'invalid_transition';
  elsif current_item.workflow_run_id <> p_workflow_run_id then
    outcome := 'workflow_conflict';
  elsif current_item.state = p_state
    and current_item.workflow_run_id = p_workflow_run_id
  then
    outcome := 'already_synced';
  elsif (
    current_item.state = 'drafting'
    and p_state in ('awaiting_approval', 'failed')
  ) or (
    current_item.state = 'awaiting_approval'
    and p_state in ('published', 'failed')
  ) then
    transition_at := greatest(
      pg_catalog.clock_timestamp(),
      current_item.state_changed_at + interval '1 microsecond'
    );

    update public.marketing_syndication_items as items
    set
      state = p_state,
      workflow_run_id = items.workflow_run_id,
      updated_at = transition_at,
      state_changed_at = transition_at,
      draft_completed_at = case
        when items.draft_completed_at is null then transition_at
        else items.draft_completed_at
      end,
      syndicated_at = case
        when p_state = 'published' then transition_at
        else items.syndicated_at
      end,
      failed_at = case
        when p_state = 'failed' then transition_at
        else items.failed_at
      end
    where items.source_item_key = p_item_id
    returning items.*
    into current_item;

    outcome := 'synced';
  else
    outcome := 'invalid_transition';
  end if;

  return query
    select
      outcome,
      current_item.source_item_key,
      current_item.state,
      current_item.workflow_run_id,
      current_item.state_changed_at;
end;
$function$;

revoke all on function private.sync_marketing_syndication_item(
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.sync_marketing_syndication_item(
  text, text, text
) to service_role;

create or replace function public.sync_marketing_syndication_item(
  p_item_id text,
  p_workflow_run_id text,
  p_state text
)
returns table (
  result_code text,
  item_id text,
  state text,
  workflow_run_id text,
  state_changed_at timestamptz
)
language sql
security invoker
set search_path = ''
as $function$
  select *
  from private.sync_marketing_syndication_item(
    p_item_id,
    p_workflow_run_id,
    p_state
  );
$function$;

revoke all on function public.sync_marketing_syndication_item(
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.sync_marketing_syndication_item(
  text, text, text
) to service_role;
