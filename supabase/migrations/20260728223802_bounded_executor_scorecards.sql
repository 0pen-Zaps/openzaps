-- Lifetime scorecard totals belong in Postgres, not in a serverless process that walks every
-- receipt into memory. The application still exposes a bounded keyset page of underlying evidence.
--
-- This function is reachable only by the service role. It is SECURITY INVOKER, so it retains the
-- caller's table privileges and does not introduce an RLS/privilege bypass.

create or replace function public.executor_scorecard_aggregate(p_executor text)
returns table (
  attempts bigint,
  finalized bigint,
  reverted bigint,
  reliability_bps integer,
  unique_zaps bigint,
  total_gas_used numeric,
  first_block numeric,
  last_block numeric,
  last_execution_at timestamptz,
  executor_fees_by_asset jsonb,
  executor_fee_asset_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with matched as (
    select
      receipt.outcome,
      receipt.zap,
      receipt.block_number,
      receipt.gas_used,
      receipt.block_time,
      case
        when receipt.event_payload ->> 'outAsset' ~ '^0x[0-9a-fA-F]{40}$'
          and receipt.event_payload ->> 'executorFee' ~ '^[0-9]{1,78}$'
        then pg_catalog.lower(receipt.event_payload ->> 'outAsset')
        else null
      end as fee_asset,
      case
        when receipt.event_payload ->> 'outAsset' ~ '^0x[0-9a-fA-F]{40}$'
          and receipt.event_payload ->> 'executorFee' ~ '^[0-9]{1,78}$'
        then (receipt.event_payload ->> 'executorFee')::numeric
        else null
      end as fee_amount
    from public.execution_receipts as receipt
    where receipt.provenance_verified
      and receipt.executor = pg_catalog.lower(p_executor)
  ),
  totals as (
    select
      pg_catalog.count(*) as attempts,
      pg_catalog.count(*) filter (where outcome = 'finalized') as finalized,
      pg_catalog.count(*) filter (where outcome = 'reverted') as reverted,
      pg_catalog.count(distinct zap) as unique_zaps,
      coalesce(pg_catalog.sum(gas_used), 0::numeric) as total_gas_used,
      pg_catalog.min(block_number) as first_block,
      pg_catalog.max(block_number) as last_block,
      pg_catalog.max(block_time) as last_execution_at
    from matched
  ),
  fee_sums as (
    select fee_asset, pg_catalog.sum(fee_amount) as amount
    from matched
    where fee_asset is not null and fee_amount is not null
    group by fee_asset
  ),
  fee_top as (
    select fee_asset, amount
    from fee_sums
    order by amount desc, fee_asset asc
    limit 32
  ),
  fees as (
    select coalesce(
      pg_catalog.jsonb_object_agg(fee_asset, amount::text),
      '{}'::jsonb
    ) as by_asset
    from fee_top
  )
  select
    totals.attempts,
    totals.finalized,
    totals.reverted,
    case
      when totals.attempts = 0 then null
      else ((totals.finalized * 10000) / totals.attempts)::integer
    end,
    totals.unique_zaps,
    totals.total_gas_used,
    totals.first_block,
    totals.last_block,
    totals.last_execution_at,
    fees.by_asset,
    (select pg_catalog.count(*) from fee_sums)
  from totals
  cross join fees;
$function$;

revoke all on function public.executor_scorecard_aggregate(text)
  from public, anon, authenticated, service_role;
grant execute on function public.executor_scorecard_aggregate(text)
  to service_role;
