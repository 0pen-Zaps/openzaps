-- Queue two exact source-reviewed design-sharing artifacts. Each row stays
-- ineligible until the live docs prove that a shared design is untrusted data,
-- grants no wallet authority, and still requires separate wallet review for a
-- supported live action.

insert into public.marketing_reviewed_campaigns (
  campaign_id,
  channel,
  queue_order,
  not_before,
  body,
  links,
  topics,
  disclosures,
  claims,
  flags,
  required_facts,
  canonical_source_urls,
  content_hash
)
values
(
  'share-zap-design-v1',
  'discord',
  40,
  '2026-08-07T14:00:00.000Z'::timestamptz,
  $campaign$**Share a Zap design—not wallet authority.**

OpenZaps can encode a designed chain into a `?d=` link. When someone opens it, the builder validates the design against the current typed-block catalog and recompiles the result. Design mode does not prompt for wallet access, approval, a signature, or a transaction.

A link may carry a live-route design or a design-only blueprint. The receiver still has to review which bounds the selected lineage enforces; any live action requires their own wallet review and signature.

Build and review:
https://www.0xzaps.com/zap?view=design

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/zap?view=design"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "An OpenZaps design link carries only a designed chain into the builder, which bounds and validates the untrusted payload before recompiling recognized blocks and parameters; the link grants no wallet authority, design mode never prompts for wallet access, approval, funding, a signature, or a transaction, and any supported live action remains separately wallet-reviewed and signed.",
      "factKeys": ["product.shareable_zap_design"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.shareable_zap_design",
      "sourceUrl": "https://www.0xzaps.com/docs"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/docs"]'::jsonb,
  'd36350d80f73d71b56c269cb29fe58088db8e74b258d3c75302dc9858e75ab88'
),
(
  'share-zap-design-v1',
  'x',
  41,
  '2026-08-10T14:00:00.000Z'::timestamptz,
  $campaign$Share a Zap design—not wallet authority.

A link carries a design into the builder. It is validated and recompiled without a wallet prompt, signature, or transaction.

Build and review:
https://www.0xzaps.com/zap?view=design

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/zap?view=design"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "An OpenZaps design link carries only a designed chain into the builder, which bounds and validates the untrusted payload before recompiling recognized blocks and parameters; the link grants no wallet authority, design mode never prompts for wallet access, approval, funding, a signature, or a transaction, and any supported live action remains separately wallet-reviewed and signed.",
      "factKeys": ["product.shareable_zap_design"],
      "treatment": "asserted"
    }
  ]'::jsonb,
  '{
    "containsCredential": false,
    "guaranteesReturns": false,
    "impersonatesPerson": false,
    "requestsPolicyBypass": false,
    "unsolicitedBulkMessaging": false,
    "usesUnavailableAsZero": false
  }'::jsonb,
  '[
    {
      "key": "product.shareable_zap_design",
      "sourceUrl": "https://www.0xzaps.com/docs"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/docs"]'::jsonb,
  '7f28715d95af94e6b99a72c1581172e1c1d030570b39c67a11909d1eeaeefc38'
);
