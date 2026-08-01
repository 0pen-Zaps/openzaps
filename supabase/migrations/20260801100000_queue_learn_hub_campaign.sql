-- Queue the exact source-reviewed OpenZaps Learn launch artifacts. The weekday
-- scheduler may claim these immutable rows only after the live page proves the
-- public catalog boundary and the deployed source registry matches every field.

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
  'learn-hub-launched-v1',
  'x',
  30,
  '2026-08-04T14:00:00.000Z'::timestamptz,
  $campaign$OpenZaps Learn is live.

Source-reviewed product updates and RSS-confirmed DeFi Tutorials in one hub. Drafts stay private until evidence exists.

Read—or request a bounded authority map:
https://www.0xzaps.com/learn

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "OpenZaps Learn publishes source-reviewed product updates and only RSS-confirmed DeFi Tutorials, keeps drafts and editor handoffs private, and links to Request a Zap for a human-reviewed authority map.",
      "factKeys": ["product.learn_hub"],
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
      "key": "product.learn_hub",
      "sourceUrl": "https://www.0xzaps.com/learn"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  '0f3f9bd4b0b4950f55749a194d98a4fbeb87e16d33274b6f7640c35c499efd82'
),
(
  'learn-hub-launched-v1',
  'discord',
  31,
  '2026-08-04T14:00:00.000Z'::timestamptz,
  $campaign$**OpenZaps Learn is live.**

The new hub collects source-reviewed OpenZaps product updates and DeFi Tutorials whose title and canonical URL are RSS-confirmed. Drafts and editor handoffs stay private until that publication evidence exists.

Use it to follow what shipped, read why the bounds matter, or request a human-reviewed authority map for one workflow:
https://www.0xzaps.com/learn

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "OpenZaps Learn publishes source-reviewed product updates and only RSS-confirmed DeFi Tutorials, keeps drafts and editor handoffs private, and links to Request a Zap for a human-reviewed authority map.",
      "factKeys": ["product.learn_hub"],
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
      "key": "product.learn_hub",
      "sourceUrl": "https://www.0xzaps.com/learn"
    }
  ]'::jsonb,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  'e4e5576c60c5d08e1e874875b15ac82aa9a9f1db016132ee682bc95d124529d8'
);
