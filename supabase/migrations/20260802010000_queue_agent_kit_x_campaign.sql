-- Queue one exact, source-reviewed X announcement for the published OpenZaps
-- Agent Kit. The scheduler may claim this immutable row only after the npm
-- releases and the dedicated production page are freshly reverified.

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
values (
  'agent-kit-published-v1',
  'x',
  21,
  '2026-08-05T14:00:00.000Z'::timestamptz,
  $campaign$OpenZaps Agent Kit is published.

→ SDK: compiles the exact policy tuple and prepares unsigned EIP-712 data.
→ MCP: read-only capsule discovery.

Neither package holds a key, signs, or broadcasts.
https://www.0xzaps.com/agent-kit

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/agent-kit"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "The npm registry publishes @openzaps/sdk@0.1.0, and the live Agent Kit page states that the SDK compiles the exact policy tuple and prepares unsigned EIP-712 data.",
      "factKeys": ["product.agent_kit_sdk_release", "product.agent_kit_page"],
      "treatment": "asserted"
    },
    {
      "text": "The npm registry publishes @openzaps/mcp@0.1.0, and the live Agent Kit page states that the MCP surface gives agent clients read-only capsule discovery.",
      "factKeys": ["product.agent_kit_mcp_release", "product.agent_kit_page"],
      "treatment": "asserted"
    },
    {
      "text": "The live Agent Kit page states that neither package holds a wallet key, signs, or broadcasts.",
      "factKeys": ["product.agent_kit_page"],
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
      "key": "product.agent_kit_sdk_release",
      "sourceUrl": "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0"
    },
    {
      "key": "product.agent_kit_mcp_release",
      "sourceUrl": "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0"
    },
    {
      "key": "product.agent_kit_page",
      "sourceUrl": "https://www.0xzaps.com/agent-kit"
    }
  ]'::jsonb,
  '[
    "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0",
    "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0",
    "https://www.0xzaps.com/agent-kit"
  ]'::jsonb,
  'c0dc5ff730cdd8efaf58cf1af1940941e5c6dd60c75f542ad036226862448a0e'
);
