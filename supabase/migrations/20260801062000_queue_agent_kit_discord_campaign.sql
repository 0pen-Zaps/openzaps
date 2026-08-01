-- Queue one exact, source-reviewed Discord announcement for the published
-- OpenZaps Agent Kit. The weekday scheduler may claim this immutable row only
-- after its source registry and production-doc facts are freshly reverified.

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
  'discord',
  20,
  '2026-08-03T14:00:00.000Z'::timestamptz,
  $campaign$**The OpenZaps Agent Kit is published.**

`@openzaps/sdk@0.1.0` compiles the exact policy tuple and prepares unsigned EIP-712 data. `@openzaps/mcp@0.1.0` gives agent clients read-only capsule discovery. Both releases carry npm provenance attestations.

Neither package holds a key, signs, or broadcasts. Your wallet or Safe creates authority; the signed intent and immutable Zap policy set the bounds.

Connect an agent: https://www.0xzaps.com/docs#agents

Pre-audit software. Verify before use.$campaign$,
  '["https://www.0xzaps.com/docs#agents"]'::jsonb,
  '["protocol"]'::jsonb,
  '["pre_audit"]'::jsonb,
  '[
    {
      "text": "The npm registry publishes @openzaps/sdk@0.1.0 with a provenance attestation.",
      "factKeys": ["product.agent_kit_sdk_release"],
      "treatment": "asserted"
    },
    {
      "text": "The npm registry publishes @openzaps/mcp@0.1.0 with a provenance attestation.",
      "factKeys": ["product.agent_kit_mcp_release"],
      "treatment": "asserted"
    },
    {
      "text": "The SDK prepares unsigned policy data without signing or broadcasting; the read-only MCP surface discovers capsules without holding a wallet key; creation stays with the owner wallet or Safe, and execution authority lives in the immutable policy or typed intent.",
      "factKeys": ["product.agent_kit_boundaries"],
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
      "key": "product.agent_kit_boundaries",
      "sourceUrl": "https://www.0xzaps.com/docs"
    }
  ]'::jsonb,
  '[
    "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0",
    "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0",
    "https://www.0xzaps.com/docs"
  ]'::jsonb,
  '516443309a2b558c1335bb4f672a649a1f728ddc643bb0a762564835c6ff59ca'
);
