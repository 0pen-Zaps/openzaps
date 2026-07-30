-- A verified receipt must carry a complete, syntactically valid provenance
-- tuple for the exact immutable lineage assigned to its intent kind.
-- PostgreSQL CHECK constraints accept NULL, so the earlier conditional regex
-- constraint could admit provenance_verified = true with one or more nullable
-- fields missing. It also accepted any syntactically valid factory,
-- implementation, and clone hash combination.
--
-- Stop rather than silently relabel or discard any such row. Receipt evidence
-- is immutable; an operator must reconcile malformed historical data before
-- this forward-only hardening migration can be applied.
do $$
begin
  if exists (
    select 1
    from public.execution_receipts
    where provenance_verified
      and (
        factory is null
        or factory !~ '^0x[0-9a-f]{40}$'
        or implementation is null
        or implementation !~ '^0x[0-9a-f]{40}$'
        or implementation_code_hash is null
        or implementation_code_hash !~ '^0x[0-9a-f]{64}$'
        or capsule_runtime_hash is null
        or capsule_runtime_hash !~ '^0x[0-9a-f]{64}$'
        or creation_tx_hash is null
        or creation_tx_hash !~ '^0x[0-9a-f]{64}$'
        or creation_block is null
        or creation_block < 0
        or creation_block > block_number
        or not (
          (
            intent_kind in ('recurring', 'trigger')
            and factory = '0x70fcfd3615ea6651a670b6c4cd6b8ba1506717e9'
            and implementation = '0x0309e72ffd1c6855ff519d9e923aefc0c52bfdb5'
            and implementation_code_hash =
              '0x99c49515bd0a7038c216a0d710676c4c63bb7dd09108de5fddca885542057149'
            and capsule_runtime_hash =
              '0x4cf8ac2dfdd484e091d02d8075be96118aa25b46733e7301d50782f755c5097c'
          )
          or (
            intent_kind = 'recurring-relative'
            and factory = '0xda5f501052fe6f87f547bc21fcaa1f122ed2f2e1'
            and implementation = '0x0fe5bc78b2bac5f09e940c2accc0c3b785d91063'
            and implementation_code_hash =
              '0xe18008b64e593526441c989e3ade3b12c056a4dfe9b7e34e59a8f124f4be979c'
            and capsule_runtime_hash =
              '0x60151728f3988403bc5f59f1e6d0987313a26cf182eabf537c1a487cb0507800'
          )
          or (
            intent_kind = 'recurring-stack'
            and factory = '0xd9134f778e523e9cf2fd75ffcb98499e9046457b'
            and implementation = '0x5882e3dc1ca0a7162d8f80ab59bc98e2fb8da987'
            and implementation_code_hash =
              '0xe271b762131d9e198769ed44124fa52eef4051e00da517716136dae5bfcef321'
            and capsule_runtime_hash =
              '0x692bd6c37a5436be8aa94556cedfb8a2a6fea42f66f9c4883e0d5b3a58f672e8'
          )
        )
      )
  ) then
    raise exception
      'execution_receipts contains malformed verified provenance; reconcile before migration';
  end if;
end;
$$;

alter table public.execution_receipts
  drop constraint if exists execution_receipts_provenance_check;
alter table public.execution_receipts
  add constraint execution_receipts_provenance_check check (
    not provenance_verified
    or (
      factory is not null
      and factory ~ '^0x[0-9a-f]{40}$'
      and implementation is not null
      and implementation ~ '^0x[0-9a-f]{40}$'
      and implementation_code_hash is not null
      and implementation_code_hash ~ '^0x[0-9a-f]{64}$'
      and capsule_runtime_hash is not null
      and capsule_runtime_hash ~ '^0x[0-9a-f]{64}$'
      and creation_tx_hash is not null
      and creation_tx_hash ~ '^0x[0-9a-f]{64}$'
      and creation_block is not null
      and creation_block >= 0
      and creation_block <= block_number
      and (
        (
          intent_kind in ('recurring', 'trigger')
          and factory = '0x70fcfd3615ea6651a670b6c4cd6b8ba1506717e9'
          and implementation = '0x0309e72ffd1c6855ff519d9e923aefc0c52bfdb5'
          and implementation_code_hash =
            '0x99c49515bd0a7038c216a0d710676c4c63bb7dd09108de5fddca885542057149'
          and capsule_runtime_hash =
            '0x4cf8ac2dfdd484e091d02d8075be96118aa25b46733e7301d50782f755c5097c'
        )
        or (
          intent_kind = 'recurring-relative'
          and factory = '0xda5f501052fe6f87f547bc21fcaa1f122ed2f2e1'
          and implementation = '0x0fe5bc78b2bac5f09e940c2accc0c3b785d91063'
          and implementation_code_hash =
            '0xe18008b64e593526441c989e3ade3b12c056a4dfe9b7e34e59a8f124f4be979c'
          and capsule_runtime_hash =
            '0x60151728f3988403bc5f59f1e6d0987313a26cf182eabf537c1a487cb0507800'
        )
        or (
          intent_kind = 'recurring-stack'
          and factory = '0xd9134f778e523e9cf2fd75ffcb98499e9046457b'
          and implementation = '0x5882e3dc1ca0a7162d8f80ab59bc98e2fb8da987'
          and implementation_code_hash =
            '0xe271b762131d9e198769ed44124fa52eef4051e00da517716136dae5bfcef321'
          and capsule_runtime_hash =
            '0x692bd6c37a5436be8aa94556cedfb8a2a6fea42f66f9c4883e0d5b3a58f672e8'
        )
      )
    )
  );
