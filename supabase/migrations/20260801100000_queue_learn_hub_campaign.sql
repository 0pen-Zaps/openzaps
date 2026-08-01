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

Source-reviewed product updates and RSS-confirmed DeFi Tutorials in one hub. Drafts stay off this catalog until RSS confirmation.

Read—or request a bounded authority map:
https://www.0xzaps.com/learn

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "OpenZaps Learn publishes source-reviewed product updates and only RSS-confirmed DeFi Tutorials, withholds drafts and editor handoffs from its catalog until RSS confirmation, and links to Request a Zap for a human-reviewed authority map.",
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
  'd1582813d0f9c4a53385e75082bd6d3fba90a5ea0edd2ce86bed873ca7289717'
),
(
  'learn-hub-launched-v1',
  'discord',
  31,
  '2026-08-04T14:00:00.000Z'::timestamptz,
  $campaign$**OpenZaps Learn is live.**

The new hub collects source-reviewed OpenZaps product updates and DeFi Tutorials whose title and canonical URL are RSS-confirmed. Drafts and editor handoffs are withheld from the Learn catalog until RSS confirmation.

Use it to follow what shipped, read why the bounds matter, or request a human-reviewed authority map for one workflow:
https://www.0xzaps.com/learn

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/learn"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "OpenZaps Learn publishes source-reviewed product updates and only RSS-confirmed DeFi Tutorials, withholds drafts and editor handoffs from its catalog until RSS confirmation, and links to Request a Zap for a human-reviewed authority map.",
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
  '4f091100fe08207167569a2233d0c6ebe4910c64efd4161347277986478042c9'
);
