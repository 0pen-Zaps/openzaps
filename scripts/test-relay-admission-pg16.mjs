#!/usr/bin/env node

/**
 * Disposable PostgreSQL 16 integration test for relay and subscription admission.
 *
 * This intentionally lives outside the default Vitest suite because it needs
 * local `initdb`, `postgres`, `pg_ctl`, and `psql` binaries. It applies every
 * migration to a fresh cluster, then uses independent sessions to exercise the
 * lock order and the exact per-capsule cap.
 */

import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const migrations = join(root, "supabase", "migrations");
const temporaryRoot = mkdtempSync(join(tmpdir(), "openzaps-relay-pg16-"));
const dataDirectory = join(temporaryRoot, "data");
const socketDirectory = join(temporaryRoot, "socket");
const port = "5432";
mkdirSync(socketDirectory);

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${binary} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

function postgresVersion() {
  const output = command("postgres", ["--version"]).trim();
  const match = output.match(/PostgreSQL\) (\d+)\./);
  if (!match || match[1] !== "16") {
    throw new Error(`PostgreSQL 16 is required; found: ${output}`);
  }
}

const psqlArgs = [
  "-X",
  "-v",
  "ON_ERROR_STOP=1",
  "-h",
  socketDirectory,
  "-p",
  port,
  "-d",
  "postgres",
];

function psql(sql) {
  return command("psql", [...psqlArgs, "-c", sql]);
}

function psqlScalar(sql) {
  return command("psql", [...psqlArgs, "-A", "-t", "-F", "|", "-c", sql]).trim();
}

function psqlFile(file) {
  // Supabase CLI ExecBatch wraps each migration in a transaction. Exercise the
  // migration file itself without psql's --single-transaction convenience so a
  // top-level BEGIN/COMMIT regression cannot be hidden by the harness.
  command("psql", [...psqlArgs, "-c", "begin", "-f", file, "-c", "commit"]);
}

function psqlFileProbe(file, setupSql) {
  const result = spawnSync(
    "psql",
    [
      ...psqlArgs,
      "-c",
      "begin",
      "-c",
      setupSql,
      "-f",
      file,
      "-c",
      "rollback",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  return result;
}

function psqlSession(sql) {
  return new Promise((resolveSession, rejectSession) => {
    const child = spawn("psql", [...psqlArgs, "-c", sql], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectSession);
    child.on("close", (status) => {
      resolveSession({ status, stdout, stderr });
    });
  });
}

function psqlScalarSession(sql) {
  return new Promise((resolveSession, rejectSession) => {
    const child = spawn(
      "psql",
      [...psqlArgs, "-A", "-t", "-F", "|", "-c", sql],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectSession);
    child.on("close", (status) => {
      resolveSession({ status, stdout, stderr });
    });
  });
}

async function waitForSessionPause(applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const count = psqlScalar(`
      select count(*)
      from pg_catalog.pg_stat_activity
      where application_name = '${applicationName}'
        and wait_event = 'PgSleep';
    `);
    if (count === "1") return;
    await delay(20);
  }
  throw new Error(`${applicationName} never reached its test pause`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function policySubscriptionMutation(
  subscriberKey,
  contentHash,
  subscribed,
  expectedVersion,
  expiryExpression = "pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint + 120",
) {
  return psqlScalar(`
    select
      result_code,
      resulting_version,
      resulting_subscribed
    from public.set_policy_template_subscription(
      '${subscriberKey}',
      '${contentHash}',
      ${subscribed ? "true" : "false"},
      ${expectedVersion},
      ${expiryExpression}
    );
  `);
}

function marketingDeliveryClaim({
  idempotencyKey,
  runId = "marketing-run-1",
  candidateId = "marketing-candidate-1",
  contentHash = "aa".repeat(32),
  channel = "x",
  action = "broadcast",
  interactionId = null,
  approvedBy = "integration-test",
  dailyCap = 10,
}) {
  const interactionSql = interactionId === null ? "null" : `'${interactionId}'`;
  return psqlScalar(`
    select
      result_code,
      resulting_status,
      current_count,
      resulting_day
    from public.claim_marketing_delivery(
      '${idempotencyKey}',
      '${runId}',
      '${candidateId}',
      '${contentHash}',
      '${channel}',
      '${action}',
      ${interactionSql},
      '${approvedBy}',
      ${dailyCap}
    );
  `);
}

function submitLeadFixture({
  fingerprint,
  email,
  name,
  qualificationScore = 4,
}) {
  return psqlScalar(`
    select result_code
    from public.submit_lead_request(
      '${fingerprint}',
      'agent_builder',
      '${name}',
      '${email}',
      'OpenZaps PostgreSQL harness',
      'https://example.com/openzaps-harness',
      'Automate a bounded multi-protocol workflow with one approved transaction.',
      'ETH, USDC, and a harness-only protocol fixture',
      'When the pre-committed market condition is met',
      'Enforce explicit value, slippage, protocol, and expiry limits.',
      'within_30_days',
      true,
      '{"utm_source":"integration-harness","secret_marker":"must-not-leak"}'::jsonb,
      ${qualificationScore}
    );
  `);
}

const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const firstZap = "0x1111111111111111111111111111111111111111";
const cappedZap = "0x2222222222222222222222222222222222222222";
const receiptHash = `0x${"33".repeat(32)}`;
const lineageMismatchReceiptHash = `0x${"bc".repeat(32)}`;
const implementationHashMismatchReceiptHash = `0x${"bd".repeat(32)}`;
const policyHash = `0x${"44".repeat(32)}`;
const legacyPolicyHash = `0x${"99".repeat(32)}`;
const legacySubscriberKey = "11111111-1111-4111-8111-111111111111";
const replaySubscriberKey = "22222222-2222-4222-8222-222222222222";
const concurrentSubscriberKey = "33333333-3333-4333-8333-333333333333";
const cappedSubscriberKey = "44444444-4444-4444-8444-444444444444";
const subscriptionMigration = "20260729010711_wallet_bound_policy_subscriptions.sql";
const receiptProvenanceMigration =
  "20260729095505_harden_verified_receipt_provenance.sql";
const reviewedCampaignQueueMigration =
  "20260801024005_durable_reviewed_marketing_campaign_queue.sql";
const reviewedCampaignFixture = "pg16-reviewed-campaign";
const reviewedCampaignContentHash = "de".repeat(32);
const reviewedCampaignMonday = "2026-08-03T15:00:00Z";
const reviewedCampaignTuesday = "2026-08-04T15:00:00Z";
const reviewedCampaignWednesday = "2026-08-05T15:00:00Z";
const malformedReceiptHash = `0x${"aa".repeat(32)}`;
const rejectedMalformedReceiptHash = `0x${"bb".repeat(32)}`;
const v3Factory = "0x70fcfd3615ea6651a670b6c4cd6b8ba1506717e9";
const v3Implementation = "0x0309e72ffd1c6855ff519d9e923aefc0c52bfdb5";
const v3ImplementationCodeHash =
  "0x99c49515bd0a7038c216a0d710676c4c63bb7dd09108de5fddca885542057149";
const v3CloneRuntimeHash =
  "0x4cf8ac2dfdd484e091d02d8075be96118aa25b46733e7301d50782f755c5097c";
const v31Factory = "0xda5f501052fe6f87f547bc21fcaa1f122ed2f2e1";
const v31Implementation = "0x0fe5bc78b2bac5f09e940c2accc0c3b785d91063";
const v31ImplementationCodeHash =
  "0xe18008b64e593526441c989e3ade3b12c056a4dfe9b7e34e59a8f124f4be979c";
const v31CloneRuntimeHash =
  "0x60151728f3988403bc5f59f1e6d0987313a26cf182eabf537c1a487cb0507800";
const intent =
  `'{"executor":"0x0000000000000000000000000000000000000000"}'::jsonb`;

function malformedVerifiedReceiptSql(txHash) {
  return `
    insert into public.execution_receipts (
      chain_id,
      tx_hash,
      zap,
      executor,
      intent_kind,
      intent_nonce,
      outcome,
      block_number,
      block_hash,
      block_time,
      transaction_index,
      gas_used,
      confirmations,
      provenance_verified,
      creation_block
    )
    values (
      4663,
      '${txHash}',
      '${firstZap}',
      '${owner}',
      'trigger',
      '999',
      'finalized',
      100,
      '0x${"cc".repeat(32)}',
      '2026-07-29T09:00:00Z',
      0,
      123,
      12,
      true,
      90
    );
  `;
}

function mismatchedLineageReceiptSql(
  txHash,
  {
    factory = v31Factory,
    implementation = v31Implementation,
    implementationCodeHash = v31ImplementationCodeHash,
    capsuleRuntimeHash = v31CloneRuntimeHash,
  } = {},
) {
  return `
    insert into public.execution_receipts (
      chain_id,
      tx_hash,
      zap,
      executor,
      intent_kind,
      intent_nonce,
      outcome,
      block_number,
      block_hash,
      block_time,
      transaction_index,
      gas_used,
      confirmations,
      provenance_verified,
      factory,
      implementation,
      implementation_code_hash,
      capsule_runtime_hash,
      creation_tx_hash,
      creation_block
    )
    values (
      4663,
      '${txHash}',
      '${firstZap}',
      '${owner}',
      'trigger',
      '998',
      'finalized',
      100,
      '0x${"cd".repeat(32)}',
      '2026-07-29T09:00:00Z',
      0,
      123,
      12,
      true,
      '${factory}',
      '${implementation}',
      '${implementationCodeHash}',
      '${capsuleRuntimeHash}',
      '0x${"88".repeat(32)}',
      90
    );
  `;
}

try {
  postgresVersion();
  command("initdb", ["-D", dataDirectory, "--auth=trust", "--no-locale"]);
  command("pg_ctl", [
    "-D",
    dataDirectory,
    "-o",
    `-F -k ${socketDirectory} -c listen_addresses='' -p ${port}`,
    "-w",
    "start",
  ], { stdio: "ignore" });

  psql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);

  const migrationFiles = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
  // A clean schema must survive a complete replay except for exact new-table
  // migrations that deliberately reject an unexpected history replay.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const filename of migrationFiles) {
      if (pass === 1 && filename === reviewedCampaignQueueMigration) {
        const replayProbe = psqlFileProbe(join(migrations, filename), "select 1;");
        assert(
          replayProbe.status !== 0 &&
            /relation "marketing_reviewed_campaigns" already exists/.test(
              `${replayProbe.stdout}${replayProbe.stderr}`,
            ),
          "reviewed campaign queue migration did not fail closed on an unexpected replay",
        );
        continue;
      }
      if (pass === 0 && filename === subscriptionMigration) {
        psql(`
          insert into public.policy_templates (
            content_hash,
            schema_version,
            version,
            name,
            chain,
            compiled_hash,
            publisher,
            publisher_signature,
            publisher_verified,
            visible,
            moderation_status
          )
          values (
            '${legacyPolicyHash}',
            'openzaps-policy-template/v1',
            1,
            'Legacy subscription quarantine fixture',
            '[{"kind":"harness"}]'::jsonb,
            '${legacyPolicyHash}',
            '${owner}',
            '0x' || pg_catalog.repeat('9', 130),
            true,
            true,
            'approved'
          );

          insert into public.policy_template_subscriptions (
            subscriber_key,
            content_hash
          )
          values (
            '${legacySubscriberKey}',
            '${legacyPolicyHash}'
          );
        `);
        const legacyBefore = psqlScalar(`
          select
            (select count(*) from public.policy_template_subscriptions
             where subscriber_key = '${legacySubscriberKey}'),
            (select subscription_count from public.policy_templates
             where content_hash = '${legacyPolicyHash}');
        `);
        assert(
          legacyBefore === "1|1",
          `legacy subscription fixture was not active before migration: ${legacyBefore}`,
        );
      }
      if (pass === 0 && filename === receiptProvenanceMigration) {
        const malformedProbe = psqlFileProbe(
          join(migrations, filename),
          `
            set role service_role;
            ${malformedVerifiedReceiptSql(malformedReceiptHash)}
            reset role;
          `,
        );
        assert(
          malformedProbe.status !== 0,
          "verified receipt provenance migration accepted malformed historical evidence",
        );
        assert(
          /execution_receipts contains malformed verified provenance; reconcile before migration/.test(
            `${malformedProbe.stdout}${malformedProbe.stderr}`,
          ),
          "verified receipt provenance migration did not fail on its reconciliation guard",
        );

        const lineageProbe = psqlFileProbe(
          join(migrations, filename),
          `
            set role service_role;
            ${mismatchedLineageReceiptSql(lineageMismatchReceiptHash)}
            reset role;
          `,
        );
        assert(
          lineageProbe.status !== 0,
          "verified receipt provenance migration accepted inconsistent historical lineage",
        );
        assert(
          /execution_receipts contains malformed verified provenance; reconcile before migration/.test(
            `${lineageProbe.stdout}${lineageProbe.stderr}`,
          ),
          "verified receipt provenance migration did not reject inconsistent historical lineage",
        );

        const implementationHashProbe = psqlFileProbe(
          join(migrations, filename),
          `
            set role service_role;
            ${mismatchedLineageReceiptSql(implementationHashMismatchReceiptHash, {
              factory: v3Factory,
              implementation: v3Implementation,
              implementationCodeHash: `0x${"66".repeat(32)}`,
              capsuleRuntimeHash: v3CloneRuntimeHash,
            })}
            reset role;
          `,
        );
        assert(
          implementationHashProbe.status !== 0,
          "verified receipt provenance migration accepted an inconsistent implementation code hash",
        );
        assert(
          /execution_receipts contains malformed verified provenance; reconcile before migration/.test(
            `${implementationHashProbe.stdout}${implementationHashProbe.stderr}`,
          ),
          "verified receipt provenance migration did not reject an inconsistent implementation code hash",
        );
      }
      psqlFile(join(migrations, filename));
    }
  }

  const legacyAfter = psqlScalar(`
    select
      (select count(*) from public.policy_template_subscriptions
       where subscriber_key = '${legacySubscriberKey}'),
      (select count(*) from private.policy_template_subscription_legacy_quarantine
       where subscriber_key = '${legacySubscriberKey}'
         and content_hash = '${legacyPolicyHash}'),
      (select subscription_count from public.policy_templates
       where content_hash = '${legacyPolicyHash}');
  `);
  assert(
    legacyAfter === "0|1|0",
    `legacy subscription was not quarantined and reconciled: ${legacyAfter}`,
  );

  const replayState = psqlScalar(`
    select
      state.total_rows,
      state.open_rows,
      (select count(*) from public.zap_intents),
      (
        select count(*)
        from pg_catalog.pg_trigger
        where tgrelid = 'public.zap_intents'::regclass
          and not tgisinternal
      )
    from private.zap_intent_admission_state as state
    where state.singleton;
  `).split("|");
  assert(
    replayState.join("|") === "0|0|0|5",
    `full-chain replay left unexpected relay state: ${replayState.join(", ")}`,
  );

  const initialReviewedCampaignState = psqlScalar(`
    select
      (select count(*) from public.marketing_reviewed_campaigns),
      (select count(*) from public.marketing_campaign_schedule_claims),
      (
        select count(*)
        from public.marketing_reviewed_campaigns
        where channel = 'x'
      );
  `);
  assert(
    initialReviewedCampaignState === "0|0|0",
    `reviewed campaign migration seeded a production post: ${initialReviewedCampaignState}`,
  );

  const emptyReviewedCampaignClaim = psqlScalar(`
    select result_code
    from private.claim_next_marketing_campaign_at(
      array['discord']::text[],
      '${reviewedCampaignMonday}'::timestamptz
    );
  `);
  const emptyReviewedCampaignClaimState = psqlScalar(`
    select count(*)
    from public.marketing_campaign_schedule_claims;
  `);
  assert(
    emptyReviewedCampaignClaim === "no_pending_campaign" &&
      emptyReviewedCampaignClaimState === "0",
    `empty reviewed queue wrote a schedule claim: ${emptyReviewedCampaignClaim}|${emptyReviewedCampaignClaimState}`,
  );

  const reviewedCampaignPrivileges = psqlScalar(`
    select
      (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'public.marketing_reviewed_campaigns'::regclass
      ),
      (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'public.marketing_campaign_schedule_claims'::regclass
      ),
      has_table_privilege(
        'service_role',
        'public.marketing_reviewed_campaigns',
        'select'
      ),
      has_table_privilege(
        'service_role',
        'public.marketing_campaign_schedule_claims',
        'select'
      ),
      has_function_privilege(
        'service_role',
        'public.claim_next_marketing_campaign(text[])',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.verify_marketing_campaign_schedule_claim(text,text,date,text)',
        'execute'
      ),
      has_function_privilege(
        'anon',
        'public.claim_next_marketing_campaign(text[])',
        'execute'
      ),
      has_function_privilege(
        'authenticated',
        'public.claim_next_marketing_campaign(text[])',
        'execute'
      ),
      has_function_privilege(
        'anon',
        'public.verify_marketing_campaign_schedule_claim(text,text,date,text)',
        'execute'
      ),
      has_function_privilege(
        'authenticated',
        'public.verify_marketing_campaign_schedule_claim(text,text,date,text)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'private.claim_next_marketing_campaign_at(text[],timestamptz)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'private.verify_marketing_campaign_schedule_claim_at(text,text,date,text,timestamptz)',
        'execute'
      );
  `);
  assert(
    reviewedCampaignPrivileges === "t|t|f|f|t|t|f|f|f|f|f|f",
    `unexpected reviewed campaign queue privileges: ${reviewedCampaignPrivileges}`,
  );

  const serviceReviewedCampaignClaim = await psqlScalarSession(`
    set role service_role;
    select count(*)
    from public.claim_next_marketing_campaign(array['discord']::text[]);
  `);
  assert(
    serviceReviewedCampaignClaim.status === 0 &&
      /(?:^|\n)1(?:\n|$)/.test(serviceReviewedCampaignClaim.stdout),
    `service role could not call reviewed campaign RPC: ${serviceReviewedCampaignClaim.stdout}${serviceReviewedCampaignClaim.stderr}`,
  );

  const serviceReviewedCampaignVerify = await psqlScalarSession(`
    set role service_role;
    select count(*)
    from public.verify_marketing_campaign_schedule_claim(
      '${reviewedCampaignFixture}',
      'discord',
      '2026-08-03'::date,
      '${reviewedCampaignContentHash}'
    );
  `);
  assert(
    serviceReviewedCampaignVerify.status === 0 &&
      /(?:^|\n)1(?:\n|$)/.test(serviceReviewedCampaignVerify.stdout),
    `service role could not call reviewed campaign verification RPC: ${serviceReviewedCampaignVerify.stdout}${serviceReviewedCampaignVerify.stderr}`,
  );

  for (const role of ["anon", "authenticated"]) {
    for (const [rpcName, rpcSql] of [
      [
        "claim",
        "select result_code from public.claim_next_marketing_campaign(array['discord']::text[])",
      ],
      [
        "verify",
        `select verified from public.verify_marketing_campaign_schedule_claim(
          '${reviewedCampaignFixture}',
          'discord',
          '2026-08-03'::date,
          '${reviewedCampaignContentHash}'
        )`,
      ],
    ]) {
      const unauthorizedReviewedCampaignRpc = await psqlScalarSession(`
        set role ${role};
        ${rpcSql};
      `);
      assert(
        unauthorizedReviewedCampaignRpc.status !== 0 &&
          /permission denied/.test(
            `${unauthorizedReviewedCampaignRpc.stdout}${unauthorizedReviewedCampaignRpc.stderr}`,
          ),
        `${role} unexpectedly executed the reviewed campaign ${rpcName} RPC`,
      );
    }
  }

  const directReviewedCampaignRead = await psqlScalarSession(`
    set role service_role;
    select * from public.marketing_reviewed_campaigns;
  `);
  assert(
    directReviewedCampaignRead.status !== 0 &&
      /permission denied/.test(
        `${directReviewedCampaignRead.stdout}${directReviewedCampaignRead.stderr}`,
      ),
    "service role unexpectedly read the reviewed campaign queue directly",
  );

  const fixedTimeHelperCall = await psqlScalarSession(`
    set role service_role;
    select result_code
    from private.claim_next_marketing_campaign_at(
      array['discord']::text[],
      '${reviewedCampaignMonday}'::timestamptz
    );
  `);
  assert(
    fixedTimeHelperCall.status !== 0 &&
      /permission denied/.test(
        `${fixedTimeHelperCall.stdout}${fixedTimeHelperCall.stderr}`,
      ),
    "service role unexpectedly executed the fixed-time queue test helper",
  );

  const fixedTimeVerifyHelperCall = await psqlScalarSession(`
    set role service_role;
    select verified
    from private.verify_marketing_campaign_schedule_claim_at(
      '${reviewedCampaignFixture}',
      'discord',
      '2026-08-03'::date,
      '${reviewedCampaignContentHash}',
      '${reviewedCampaignMonday}'::timestamptz
    );
  `);
  assert(
    fixedTimeVerifyHelperCall.status !== 0 &&
      /permission denied/.test(
        `${fixedTimeVerifyHelperCall.stdout}${fixedTimeVerifyHelperCall.stderr}`,
      ),
    "service role unexpectedly executed the fixed-time verification test helper",
  );

  psql(`
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
      '${reviewedCampaignFixture}',
      'discord',
      1,
      null,
      'Harness-only reviewed Discord campaign.',
      '["https://www.0xzaps.com/docs"]'::jsonb,
      '["protocol"]'::jsonb,
      '["pre_audit"]'::jsonb,
      '[{
        "text":"Harness-only reviewed product fact.",
        "factKeys":["product.docs"],
        "treatment":"asserted"
      }]'::jsonb,
      '{
        "containsCredential":false,
        "guaranteesReturns":false,
        "impersonatesPerson":false,
        "requestsPolicyBypass":false,
        "unsolicitedBulkMessaging":false,
        "usesUnavailableAsZero":false
      }'::jsonb,
      '[{
        "key":"product.docs",
        "sourceUrl":"https://www.0xzaps.com/docs"
      }]'::jsonb,
      '["https://www.0xzaps.com/docs"]'::jsonb,
      '${reviewedCampaignContentHash}'
    );
  `);

  const reviewedCampaignChannelState = psqlScalar(`
    select
      count(*) filter (where channel = 'discord'),
      count(*) filter (where channel = 'x')
    from public.marketing_reviewed_campaigns;
  `);
  assert(
    reviewedCampaignChannelState === "1|0",
    `reviewed queue fixture unexpectedly created an X row: ${reviewedCampaignChannelState}`,
  );

  const xOnlyReviewedCampaignClaim = psqlScalar(`
    select result_code
    from private.claim_next_marketing_campaign_at(
      array['x']::text[],
      '${reviewedCampaignMonday}'::timestamptz
    );
  `);
  assert(
    xOnlyReviewedCampaignClaim === "no_pending_campaign",
    `X-only claim selected a Discord campaign: ${xOnlyReviewedCampaignClaim}`,
  );

  const concurrentReviewedCampaignClaims = await Promise.all([
    psqlScalarSession(`
      select result_code
      from private.claim_next_marketing_campaign_at(
        array['discord']::text[],
        '${reviewedCampaignMonday}'::timestamptz
      );
    `),
    psqlScalarSession(`
      select result_code
      from private.claim_next_marketing_campaign_at(
        array['discord']::text[],
        '${reviewedCampaignMonday}'::timestamptz
      );
    `),
  ]);
  assert(
    concurrentReviewedCampaignClaims.every((result) => result.status === 0),
    `concurrent reviewed campaign claims failed: ${concurrentReviewedCampaignClaims
      .map((result) => `${result.stdout}${result.stderr}`)
      .join("\n")}`,
  );
  const concurrentReviewedCampaignCodes = concurrentReviewedCampaignClaims
    .map((result) => result.stdout.trim())
    .sort();
  assert(
    concurrentReviewedCampaignCodes.join("|") === "already_claimed|claimed",
    `reviewed campaign claim was not serialized exactly once: ${concurrentReviewedCampaignCodes.join("|")}`,
  );

  const firstReviewedCampaignClaimState = psqlScalar(`
    select
      count(*),
      count(distinct campaign_id || ':' || channel),
      min(channel),
      min(claim_day)::text
    from public.marketing_campaign_schedule_claims;
  `);
  assert(
    firstReviewedCampaignClaimState === "1|1|discord|2026-08-03",
    `first reviewed campaign claim did not persist exactly once: ${firstReviewedCampaignClaimState}`,
  );

  const reviewedCampaignVerification = psqlScalar(`
    select
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'discord',
          '2026-08-03'::date,
          '${reviewedCampaignContentHash}',
          '${reviewedCampaignMonday}'::timestamptz
        )
      ),
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'x',
          '2026-08-03'::date,
          '${reviewedCampaignContentHash}',
          '${reviewedCampaignMonday}'::timestamptz
        )
      ),
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'discord',
          '2026-08-03'::date,
          '${"ef".repeat(32)}',
          '${reviewedCampaignMonday}'::timestamptz
        )
      ),
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'discord',
          '2026-08-03'::date,
          '${reviewedCampaignContentHash}',
          '${reviewedCampaignTuesday}'::timestamptz
        )
      );
  `);
  assert(
    reviewedCampaignVerification === "t|f|f|f",
    `reviewed claim verification accepted a stale or mismatched identity: ${reviewedCampaignVerification}`,
  );

  const nextWeekdayReviewedCampaignClaim = psqlScalar(`
    select result_code
    from private.claim_next_marketing_campaign_at(
      array['discord']::text[],
      '${reviewedCampaignTuesday}'::timestamptz
    );
  `);
  assert(
    nextWeekdayReviewedCampaignClaim === "claimed",
    `undelivered reviewed campaign was not retryable next weekday: ${nextWeekdayReviewedCampaignClaim}`,
  );

  const scheduledDeliveryClaim = psqlScalar(`
    insert into public.marketing_delivery_ledger (
      idempotency_key,
      run_id,
      candidate_id,
      content_hash,
      channel,
      action,
      counter_key,
      interaction_id,
      approved_by,
      claim_day,
      status
    )
    values (
      'scheduled:${reviewedCampaignFixture}:discord',
      'marketing-reviewed-campaign-harness',
      'marketing-reviewed-campaign-harness-discord',
      '${reviewedCampaignContentHash}',
      'discord',
      'broadcast',
      'discordPosts',
      null,
      'integration-test',
      '2000-01-03'::date,
      'claimed'
    )
    returning status, claim_day;
  `);
  assert(
    scheduledDeliveryClaim.startsWith("claimed|2000-01-03"),
    `reviewed campaign delivery key could not be persisted: ${scheduledDeliveryClaim}`,
  );

  const deliveredReviewedCampaignClaim = psqlScalar(`
    select result_code
    from private.claim_next_marketing_campaign_at(
      array['discord']::text[],
      '${reviewedCampaignWednesday}'::timestamptz
    );
  `);
  const deliveredReviewedCampaignState = psqlScalar(`
    select
      (select count(*) from public.marketing_campaign_schedule_claims),
      (
        select count(*)
        from public.marketing_delivery_ledger
        where idempotency_key =
          'scheduled:${reviewedCampaignFixture}:discord'
      );
  `);
  assert(
    deliveredReviewedCampaignClaim === "no_pending_campaign" &&
      deliveredReviewedCampaignState === "2|1",
    `delivered reviewed campaign was reclaimed: ${deliveredReviewedCampaignClaim}|${deliveredReviewedCampaignState}`,
  );

  for (const mutation of [
    "update public.marketing_reviewed_campaigns set body = body",
    "delete from public.marketing_reviewed_campaigns",
    "truncate public.marketing_reviewed_campaigns cascade",
    "update public.marketing_campaign_schedule_claims set claim_day = claim_day",
    "delete from public.marketing_campaign_schedule_claims",
    "truncate public.marketing_campaign_schedule_claims",
  ]) {
    const mutationAttempt = await psqlScalarSession(mutation);
    assert(
      mutationAttempt.status !== 0 &&
        /reviewed marketing campaign artifacts are immutable/.test(
          `${mutationAttempt.stdout}${mutationAttempt.stderr}`,
        ),
      `reviewed campaign artifact mutation was not rejected: ${mutation}\n${mutationAttempt.stdout}${mutationAttempt.stderr}`,
    );
  }

  const immutableReviewedCampaignState = psqlScalar(`
    select
      (select count(*) from public.marketing_reviewed_campaigns),
      (select count(*) from public.marketing_campaign_schedule_claims);
  `);
  assert(
    immutableReviewedCampaignState === "1|2",
    `reviewed campaign artifacts changed after rejected mutations: ${immutableReviewedCampaignState}`,
  );

  const hardenedPrivileges = psqlScalar(`
    select
      has_schema_privilege('service_role', 'private', 'usage'),
      has_table_privilege('service_role', 'private.zap_intent_admission_state', 'select'),
      has_function_privilege(
        'service_role',
        'private.enforce_zap_intent_admission_caps()',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'private.set_policy_template_moderation(text,text,text)',
        'execute'
      ),
      has_table_privilege('service_role', 'public.execution_receipts', 'select'),
      has_table_privilege('service_role', 'public.execution_receipts', 'insert'),
      has_table_privilege('service_role', 'public.execution_receipts', 'update'),
      has_table_privilege('service_role', 'public.execution_receipts', 'delete'),
      has_table_privilege('service_role', 'public.execution_receipts', 'truncate'),
      has_table_privilege(
        'service_role',
        'private.policy_template_subscription_legacy_quarantine',
        'select'
      ),
      has_table_privilege(
        'anon',
        'public.policy_template_subscription_authorizations',
        'select'
      ),
      has_function_privilege(
        'anon',
        'public.set_policy_template_subscription(uuid,text,boolean,bigint,bigint)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.set_policy_template_subscription(uuid,text,boolean,bigint,bigint)',
        'execute'
      ),
      has_function_privilege(
        'anon',
        'public.get_policy_template_subscription_snapshot(uuid)',
        'execute'
      ),
      has_function_privilege(
        'authenticated',
        'public.get_policy_template_subscription_snapshot(uuid)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.get_policy_template_subscription_snapshot(uuid)',
        'execute'
      );
  `).split("|");
  assert(
    hardenedPrivileges.join("|") === "t|f|f|t|t|t|f|f|f|f|f|f|t|f|f|t",
    `unexpected hardened service privileges: ${hardenedPrivileges.join(", ")}`,
  );

  const notificationOutputColumns = psqlScalar(`
    select pg_catalog.array_to_string(
      array(
        select arguments.name
        from pg_catalog.pg_proc as functions
        cross join lateral (
          select
            functions.proargnames[positions.position] as name,
            functions.proargmodes[positions.position] as mode,
            positions.position
          from pg_catalog.generate_subscripts(
            functions.proargnames,
            1
          ) as positions(position)
        ) as arguments
        where functions.oid =
          'public.claim_next_lead_notification(text)'::regprocedure
          and arguments.mode in ('o', 't')
        order by arguments.position
      ),
      ','
    );
  `);
  assert(
    notificationOutputColumns ===
      "lead_id,persona,name,email,project,project_url,workflow,protocols_assets,trigger_description,guardrails,timeline,qualification_score,created_at",
    `lead notification claim exposed an unexpected record shape: ${notificationOutputColumns}`,
  );

  const notificationPrivileges = psqlScalar(`
    select
      (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'private.lead_notification_outbox'::regclass
      ),
      has_table_privilege(
        'service_role',
        'private.lead_notification_outbox',
        'select'
      ),
      has_table_privilege(
        'anon',
        'private.lead_notification_outbox',
        'select'
      ),
      has_function_privilege(
        'service_role',
        'public.claim_next_lead_notification(text)',
        'execute'
      ),
      has_function_privilege(
        'anon',
        'public.claim_next_lead_notification(text)',
        'execute'
      ),
      has_function_privilege(
        'authenticated',
        'public.claim_next_lead_notification(text)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'private.claim_next_lead_notification(text)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.complete_lead_notification(uuid,text,text)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.fail_lead_notification(uuid,text,text,boolean)',
        'execute'
      );
  `).split("|");
  assert(
    notificationPrivileges.join("|") === "t|f|f|t|f|f|t|t|t",
    `unexpected lead-notification privileges: ${notificationPrivileges.join(", ")}`,
  );

  const emptyServiceNotificationClaim = await psqlSession(`
    set role service_role;
    select count(*)
    from public.claim_next_lead_notification('harness-empty-worker');
  `);
  assert(
    emptyServiceNotificationClaim.status === 0
      && /(?:^|\n)\s*0\s*(?:\n|$)/.test(
        `${emptyServiceNotificationClaim.stdout}${emptyServiceNotificationClaim.stderr}`,
      ),
    `service role could not call the notification RPC: ${emptyServiceNotificationClaim.stdout}${emptyServiceNotificationClaim.stderr}`,
  );
  const directNotificationRead = await psqlSession(`
    set role service_role;
    select * from private.lead_notification_outbox;
  `);
  assert(
    directNotificationRead.status !== 0
      && /permission denied/.test(
        `${directNotificationRead.stdout}${directNotificationRead.stderr}`,
      ),
    "service role unexpectedly bypassed the private lead-notification RPC boundary",
  );

  const firstLeadEmail = "lead-concurrent-a@example.com";
  const secondLeadEmail = "lead-concurrent-b@example.com";
  const firstLeadSubmission = submitLeadFixture({
    fingerprint: "a".repeat(64),
    email: firstLeadEmail,
    name: "Harness Lead Alpha",
    qualificationScore: 5,
  });
  const secondLeadSubmission = submitLeadFixture({
    fingerprint: "b".repeat(64),
    email: secondLeadEmail,
    name: "Harness Lead Beta",
    qualificationScore: 4,
  });
  assert(
    firstLeadSubmission === "accepted" && secondLeadSubmission === "accepted",
    `lead notification fixtures were not accepted: ${firstLeadSubmission}|${secondLeadSubmission}`,
  );

  const atomicEnqueueState = psqlScalar(`
    select
      count(*),
      count(*) filter (
        where outbox.status = 'pending'
          and outbox.attempt_count = 0
          and outbox.claimed_by is null
          and outbox.lease_expires_at is null
      ),
      count(distinct outbox.lead_id)
    from private.lead_notification_outbox as outbox
    join private.lead_requests as leads
      on leads.id = outbox.lead_id
    where leads.email in ('${firstLeadEmail}', '${secondLeadEmail}');
  `);
  assert(
    atomicEnqueueState === "2|2|2",
    `accepted leads were not atomically enqueued exactly once: ${atomicEnqueueState}`,
  );

  const concurrentNotificationClaimA = psqlSession(`
    select lead_id, email
    from public.claim_next_lead_notification('harness-worker-a');
  `);
  const concurrentNotificationClaimB = psqlSession(`
    select lead_id, email
    from public.claim_next_lead_notification('harness-worker-b');
  `);
  const concurrentNotificationClaims = await Promise.all([
    concurrentNotificationClaimA,
    concurrentNotificationClaimB,
  ]);
  assert(
    concurrentNotificationClaims.every((result) => result.status === 0),
    `concurrent lead-notification claims failed: ${concurrentNotificationClaims
      .map((result) => `${result.stdout}${result.stderr}`)
      .join("\n")}`,
  );

  const concurrentNotificationState = psqlScalar(`
    select
      count(*) filter (where outbox.status = 'processing'),
      count(distinct outbox.claimed_by),
      sum(outbox.attempt_count)
    from private.lead_notification_outbox as outbox
    join private.lead_requests as leads
      on leads.id = outbox.lead_id
    where leads.email in ('${firstLeadEmail}', '${secondLeadEmail}');
  `);
  assert(
    concurrentNotificationState === "2|2|2",
    `SKIP LOCKED did not give concurrent workers distinct claims: ${concurrentNotificationState}`,
  );

  const workerAClaim = psqlScalar(`
    select outbox.lead_id, leads.email
    from private.lead_notification_outbox as outbox
    join private.lead_requests as leads
      on leads.id = outbox.lead_id
    where outbox.claimed_by = 'harness-worker-a';
  `);
  const [workerALeadId] = workerAClaim.split("|");
  const reenteredWorkerAClaim = psqlScalar(`
    select lead_id, email
    from public.claim_next_lead_notification('harness-worker-a');
  `);
  assert(
    reenteredWorkerAClaim === workerAClaim,
    `same worker did not re-enter its active claim: ${workerAClaim} -> ${reenteredWorkerAClaim}`,
  );
  const reenteredAttemptCount = psqlScalar(`
    select attempt_count
    from private.lead_notification_outbox
    where lead_id = '${workerALeadId}';
  `);
  assert(
    reenteredAttemptCount === "1",
    `same-worker re-entry incremented the attempt count: ${reenteredAttemptCount}`,
  );
  const unavailableClaim = psqlScalar(`
    select count(*)
    from public.claim_next_lead_notification('harness-worker-unavailable');
  `);
  assert(
    unavailableClaim === "0",
    `a third worker stole a live notification lease: ${unavailableClaim}`,
  );

  const invalidCompletion = psqlScalar(`
    select result_code
    from public.complete_lead_notification(
      '${workerALeadId}',
      'harness-worker-a',
      'invalid provider id'
    );
  `);
  assert(
    invalidCompletion === "invalid_input",
    `unsafe provider identifier was accepted: ${invalidCompletion}`,
  );
  const completedNotification = psqlScalar(`
    select result_code
    from public.complete_lead_notification(
      '${workerALeadId}',
      'harness-worker-a',
      'resend-msg-a'
    );
  `);
  const replayedCompletion = psqlScalar(`
    select result_code
    from public.complete_lead_notification(
      '${workerALeadId}',
      'harness-worker-a',
      'resend-msg-a'
    );
  `);
  const conflictingCompletion = psqlScalar(`
    select result_code
    from public.complete_lead_notification(
      '${workerALeadId}',
      'harness-worker-a',
      'resend-msg-conflict'
    );
  `);
  assert(
    completedNotification === "sent"
      && replayedCompletion === "already_sent"
      && conflictingCompletion === "ownership_lost",
    `lead-notification completion was not replay-safe: ${completedNotification}|${replayedCompletion}|${conflictingCompletion}`,
  );
  const completedNotificationState = psqlScalar(`
    select
      status,
      attempt_count,
      provider_message_id,
      claimed_by is null,
      lease_expires_at is null,
      sent_at is not null
    from private.lead_notification_outbox
    where lead_id = '${workerALeadId}';
  `);
  assert(
    completedNotificationState === "sent|1|resend-msg-a|t|t|t",
    `completed notification retained an invalid state: ${completedNotificationState}`,
  );

  const workerBClaim = psqlScalar(`
    select outbox.lead_id, leads.email
    from private.lead_notification_outbox as outbox
    join private.lead_requests as leads
      on leads.id = outbox.lead_id
    where outbox.claimed_by = 'harness-worker-b';
  `);
  const [workerBLeadId] = workerBClaim.split("|");
  const lostFailureClaim = psqlScalar(`
    select result_code
    from public.fail_lead_notification(
      '${workerBLeadId}',
      'harness-wrong-worker',
      'provider_503',
      false
    );
  `);
  const releasedNotification = psqlScalar(`
    select result_code
    from public.fail_lead_notification(
      '${workerBLeadId}',
      'harness-worker-b',
      'provider_503',
      false
    );
  `);
  assert(
    lostFailureClaim === "ownership_lost"
      && releasedNotification === "released",
    `transient notification failure did not honor claim ownership: ${lostFailureClaim}|${releasedNotification}`,
  );
  const releasedNotificationState = psqlScalar(`
    select
      status,
      attempt_count,
      last_error_code,
      claimed_by is null,
      lease_expires_at is null,
      next_attempt_at > pg_catalog.clock_timestamp()
    from private.lead_notification_outbox
    where lead_id = '${workerBLeadId}';
  `);
  assert(
    releasedNotificationState === "pending|1|provider_503|t|t|t",
    `transient notification failure did not schedule backoff: ${releasedNotificationState}`,
  );
  const earlyRecoveryClaim = psqlScalar(`
    select count(*)
    from public.claim_next_lead_notification('harness-recovery-worker');
  `);
  assert(
    earlyRecoveryClaim === "0",
    `notification retry ignored its durable backoff: ${earlyRecoveryClaim}`,
  );

  psql(`
    update private.lead_notification_outbox
    set next_attempt_at = pg_catalog.clock_timestamp()
    where lead_id = '${workerBLeadId}';
  `);
  const recoveredNotification = psqlScalar(`
    select lead_id
    from public.claim_next_lead_notification('harness-recovery-worker');
  `);
  assert(
    recoveredNotification === workerBLeadId,
    `due notification was not recovered: ${workerBLeadId} -> ${recoveredNotification}`,
  );
  const recoveredAttemptCount = psqlScalar(`
    select status, attempt_count, claimed_by
    from private.lead_notification_outbox
    where lead_id = '${workerBLeadId}';
  `);
  assert(
    recoveredAttemptCount === "processing|2|harness-recovery-worker",
    `notification retry did not acquire a fresh attempt: ${recoveredAttemptCount}`,
  );
  const recoveredCompletion = psqlScalar(`
    select result_code
    from public.complete_lead_notification(
      '${workerBLeadId}',
      'harness-recovery-worker',
      'resend-msg-b'
    );
  `);
  assert(
    recoveredCompletion === "sent",
    `recovered notification could not complete: ${recoveredCompletion}`,
  );

  const permanentLeadEmail = "lead-permanent@example.com";
  const permanentLeadSubmission = submitLeadFixture({
    fingerprint: "c".repeat(64),
    email: permanentLeadEmail,
    name: "Harness Lead Permanent",
    qualificationScore: 3,
  });
  assert(
    permanentLeadSubmission === "accepted",
    `permanent-failure lead fixture was not accepted: ${permanentLeadSubmission}`,
  );
  const permanentLeadId = psqlScalar(`
    select lead_id
    from public.claim_next_lead_notification('harness-permanent-worker');
  `);
  psql(`
    update private.lead_notification_outbox
    set lease_expires_at =
      pg_catalog.clock_timestamp() - interval '1 second'
    where lead_id = '${permanentLeadId}';
  `);
  const expiredLeaseRecovery = psqlScalar(`
    select lead_id
    from public.claim_next_lead_notification('harness-takeover-worker');
  `);
  const expiredLeaseState = psqlScalar(`
    select status, attempt_count, claimed_by
    from private.lead_notification_outbox
    where lead_id = '${permanentLeadId}';
  `);
  assert(
    expiredLeaseRecovery === permanentLeadId
      && expiredLeaseState ===
        "processing|2|harness-takeover-worker",
    `expired notification lease was not recoverable: ${expiredLeaseRecovery}|${expiredLeaseState}`,
  );
  const expiredOwnerFailure = psqlScalar(`
    select result_code
    from public.fail_lead_notification(
      '${permanentLeadId}',
      'harness-permanent-worker',
      'invalid_recipient',
      true
    );
  `);
  const invalidFailureCode = psqlScalar(`
    select result_code
    from public.fail_lead_notification(
      '${permanentLeadId}',
      'harness-takeover-worker',
      'INVALID CODE',
      true
    );
  `);
  const permanentFailure = psqlScalar(`
    select result_code
    from public.fail_lead_notification(
      '${permanentLeadId}',
      'harness-takeover-worker',
      'invalid_recipient',
      true
    );
  `);
  const replayedPermanentFailure = psqlScalar(`
    select result_code
    from public.fail_lead_notification(
      '${permanentLeadId}',
      'harness-takeover-worker',
      'invalid_recipient',
      true
    );
  `);
  assert(
    expiredOwnerFailure === "ownership_lost"
      && invalidFailureCode === "invalid_input"
      && permanentFailure === "permanent_failure"
      && replayedPermanentFailure === "permanent_failure",
    `permanent notification failure was not safe or idempotent: ${expiredOwnerFailure}|${invalidFailureCode}|${permanentFailure}|${replayedPermanentFailure}`,
  );
  const permanentFailureState = psqlScalar(`
    select
      status,
      last_error_code,
      claimed_by is null,
      lease_expires_at is null,
      provider_message_id is null,
      sent_at is null
    from private.lead_notification_outbox
    where lead_id = '${permanentLeadId}';
  `);
  assert(
    permanentFailureState ===
      "permanent_failure|invalid_recipient|t|t|t|t",
    `permanent notification failure retained an invalid state: ${permanentFailureState}`,
  );

  const cascadeLeadEmail = "lead-cascade@example.com";
  const cascadeLeadSubmission = submitLeadFixture({
    fingerprint: "d".repeat(64),
    email: cascadeLeadEmail,
    name: "Harness Lead Cascade",
    qualificationScore: 2,
  });
  assert(
    cascadeLeadSubmission === "accepted",
    `cascade lead fixture was not accepted: ${cascadeLeadSubmission}`,
  );
  const cascadeLeadId = psqlScalar(`
    select id
    from private.lead_requests
    where email = '${cascadeLeadEmail}';
  `);
  const cascadeBefore = psqlScalar(`
    select
      (select count(*) from private.lead_requests
       where id = '${cascadeLeadId}'),
      (select count(*) from private.lead_notification_outbox
       where lead_id = '${cascadeLeadId}');
  `);
  psql(`
    delete from private.lead_requests
    where id = '${cascadeLeadId}';
  `);
  const cascadeAfter = psqlScalar(`
    select
      (select count(*) from private.lead_requests
       where id = '${cascadeLeadId}'),
      (select count(*) from private.lead_notification_outbox
       where lead_id = '${cascadeLeadId}');
  `);
  assert(
    cascadeBefore === "1|1" && cascadeAfter === "0|0",
    `lead deletion did not cascade to its notification outbox: ${cascadeBefore} -> ${cascadeAfter}`,
  );

  psql(`
    set role service_role;

    insert into public.policy_templates (
      content_hash,
      schema_version,
      version,
      name,
      chain,
      compiled_hash,
      publisher,
      publisher_signature,
      publisher_verified,
      visible,
      moderation_status
    )
    values (
      '${policyHash}',
      'openzaps-policy-template/v1',
      1,
      'PostgreSQL harness policy',
      '[{"kind":"harness"}]'::jsonb,
      '${policyHash}',
      '${owner}',
      '0x' || pg_catalog.repeat('1', 130),
      true,
      true,
      'approved'
    );

    select private.set_policy_template_moderation(
      '${policyHash}',
      'hidden',
      'integration test'
    );

    insert into public.execution_receipts (
      chain_id,
      tx_hash,
      zap,
      executor,
      intent_kind,
      intent_nonce,
      outcome,
      block_number,
      block_hash,
      block_time,
      transaction_index,
      gas_used,
      confirmations,
      provenance_verified,
      factory,
      implementation,
      implementation_code_hash,
      capsule_runtime_hash,
      creation_tx_hash,
      creation_block
    )
    values (
      4663,
      '${receiptHash}',
      '${firstZap}',
      '${owner}',
      'trigger',
      '1',
      'finalized',
      100,
      '0x${"55".repeat(32)}',
      '2026-07-28T12:00:00Z',
      0,
      123,
      12,
      true,
      '${v3Factory}',
      '${v3Implementation}',
      '${v3ImplementationCodeHash}',
      '${v3CloneRuntimeHash}',
      '0x${"88".repeat(32)}',
      90
    );

    insert into public.execution_receipts (
      chain_id,
      tx_hash,
      zap,
      executor,
      intent_kind,
      intent_nonce,
      outcome,
      block_number,
      block_hash,
      block_time,
      transaction_index,
      gas_used,
      confirmations,
      provenance_verified,
      factory,
      implementation,
      implementation_code_hash,
      capsule_runtime_hash,
      creation_tx_hash,
      creation_block
    )
    values (
      4663,
      '${receiptHash}',
      '${firstZap}',
      '${owner}',
      'trigger',
      '1',
      'finalized',
      100,
      '0x${"55".repeat(32)}',
      '2026-07-28T12:00:00Z',
      0,
      123,
      40,
      true,
      '${v3Factory}',
      '${v3Implementation}',
      '${v3ImplementationCodeHash}',
      '${v3CloneRuntimeHash}',
      '0x${"88".repeat(32)}',
      90
    )
    on conflict (chain_id, tx_hash) do nothing;

    reset role;
  `);

  const protectedRows = psqlScalar(`
    select
      (select moderation_status || '|' || visible::text
       from public.policy_templates where content_hash = '${policyHash}'),
      (select count(*) from public.execution_receipts where tx_hash = '${receiptHash}'),
      (select confirmations from public.execution_receipts where tx_hash = '${receiptHash}');
  `).split("|");
  assert(
    protectedRows.join("|") === "hidden|false|1|12",
    `private RPC or insert-only receipt replay regressed: ${protectedRows.join(", ")}`,
  );

  const malformedReceiptAdmission = await psqlSession(`
    set role service_role;
    ${malformedVerifiedReceiptSql(rejectedMalformedReceiptHash)}
  `);
  assert(
    malformedReceiptAdmission.status !== 0,
    "malformed verified receipt provenance unexpectedly passed database admission",
  );
  assert(
    /execution_receipts_provenance_check/.test(
      `${malformedReceiptAdmission.stdout}${malformedReceiptAdmission.stderr}`,
    ),
    "malformed verified receipt did not fail the provenance constraint",
  );

  const lineageMismatchAdmission = await psqlSession(`
    set role service_role;
    ${mismatchedLineageReceiptSql(lineageMismatchReceiptHash)}
  `);
  assert(
    lineageMismatchAdmission.status !== 0,
    "intent-kind lineage mismatch unexpectedly passed database admission",
  );
  assert(
    /execution_receipts_provenance_check/.test(
      `${lineageMismatchAdmission.stdout}${lineageMismatchAdmission.stderr}`,
    ),
    "intent-kind lineage mismatch did not fail the provenance constraint",
  );

  const implementationHashMismatchAdmission = await psqlSession(`
    set role service_role;
    ${mismatchedLineageReceiptSql(implementationHashMismatchReceiptHash, {
      factory: v3Factory,
      implementation: v3Implementation,
      implementationCodeHash: `0x${"66".repeat(32)}`,
      capsuleRuntimeHash: v3CloneRuntimeHash,
    })}
  `);
  assert(
    implementationHashMismatchAdmission.status !== 0,
    "implementation code hash mismatch unexpectedly passed database admission",
  );
  assert(
    /execution_receipts_provenance_check/.test(
      `${implementationHashMismatchAdmission.stdout}${implementationHashMismatchAdmission.stderr}`,
    ),
    "implementation code hash mismatch did not fail the provenance constraint",
  );

  const initialSubscribe = policySubscriptionMutation(
    replaySubscriberKey,
    policyHash,
    true,
    0,
  );
  assert(
    initialSubscribe === "applied|1|t",
    `initial subscription authorization failed: ${initialSubscribe}`,
  );
  const firstUnsubscribe = policySubscriptionMutation(
    replaySubscriberKey,
    policyHash,
    false,
    1,
  );
  assert(
    firstUnsubscribe === "applied|2|f",
    `subscription unsubscribe failed: ${firstUnsubscribe}`,
  );
  const subscribeReplay = policySubscriptionMutation(
    replaySubscriberKey,
    policyHash,
    true,
    0,
  );
  const unsubscribeReplay = policySubscriptionMutation(
    replaySubscriberKey,
    policyHash,
    false,
    1,
  );
  assert(
    subscribeReplay === "version_conflict|2|f",
    `old subscribe authorization replayed after unsubscribe: ${subscribeReplay}`,
  );
  assert(
    unsubscribeReplay === "version_conflict|2|f",
    `old unsubscribe authorization replayed after unsubscribe: ${unsubscribeReplay}`,
  );
  const resubscribe = policySubscriptionMutation(
    replaySubscriberKey,
    policyHash,
    true,
    2,
  );
  assert(
    resubscribe === "applied|3|t",
    `fresh subscription authorization failed: ${resubscribe}`,
  );
  const persistedReplayState = psqlScalar(`
    select
      auth_state.version,
      (select count(*)
       from public.policy_template_subscriptions
       where subscriber_key = '${replaySubscriberKey}'
         and content_hash = '${policyHash}'),
      (select subscription_count
       from public.policy_templates
       where content_hash = '${policyHash}')
    from public.policy_template_subscription_authorizations auth_state
    where auth_state.subscriber_key = '${replaySubscriberKey}';
  `);
  assert(
    persistedReplayState === "3|1|1",
    `subscription version/count state drifted: ${persistedReplayState}`,
  );

  const expiredMutation = policySubscriptionMutation(
    replaySubscriberKey,
    policyHash,
    false,
    3,
    "pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint - 1",
  );
  assert(
    expiredMutation === "expired||",
    `expired subscription authorization was not rejected: ${expiredMutation}`,
  );

  psql(`
    insert into public.policy_templates (
      content_hash,
      schema_version,
      version,
      name,
      chain,
      compiled_hash,
      publisher,
      publisher_signature,
      publisher_verified,
      visible,
      moderation_status
    )
    select
      '0x' || pg_catalog.lpad(pg_catalog.to_hex(series), 64, '0'),
      'openzaps-policy-template/v1',
      1,
      'Subscription cap fixture ' || series::text,
      '[{"kind":"harness"}]'::jsonb,
      '0x' || pg_catalog.lpad(pg_catalog.to_hex(series), 64, '0'),
      '0x' || pg_catalog.lpad(pg_catalog.to_hex(series), 40, '0'),
      '0x' || pg_catalog.repeat('8', 130),
      true,
      true,
      'approved'
    from pg_catalog.generate_series(1000, 1258) as series;
  `);

  const concurrentHashA = `0x${(1000).toString(16).padStart(64, "0")}`;
  const concurrentHashB = `0x${(1001).toString(16).padStart(64, "0")}`;
  const concurrentBase = policySubscriptionMutation(
    concurrentSubscriberKey,
    policyHash,
    true,
    0,
  );
  assert(
    concurrentBase === "applied|1|t",
    `concurrent subscription base state failed: ${concurrentBase}`,
  );
  const concurrentA = psqlSession(`
    select *
    from public.set_policy_template_subscription(
      '${concurrentSubscriberKey}',
      '${concurrentHashA}',
      true,
      1,
      pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint + 120
    );
  `);
  const concurrentB = psqlSession(`
    select *
    from public.set_policy_template_subscription(
      '${concurrentSubscriberKey}',
      '${concurrentHashB}',
      true,
      1,
      pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint + 120
    );
  `);
  const concurrentResults = await Promise.all([concurrentA, concurrentB]);
  assert(
    concurrentResults.every((result) => result.status === 0),
    `concurrent subscription RPC failed unexpectedly: ${concurrentResults.map((result) => result.stderr).join("\n")}`,
  );
  const concurrentOutput = concurrentResults
    .map((result) => `${result.stdout}${result.stderr}`);
  assert(
    concurrentOutput.filter((output) => /applied\s+\|\s+2\s+\|\s+t/.test(output)).length === 1,
    `expected one concurrent subscription to apply:\n${concurrentOutput.join("\n")}`,
  );
  assert(
    concurrentOutput.filter((output) => /version_conflict\s+\|\s+2\s+\|\s+/.test(output)).length === 1,
    `expected one concurrent subscription replay conflict:\n${concurrentOutput.join("\n")}`,
  );
  const concurrentState = psqlScalar(`
    select
      auth_state.version,
      (select count(*)
       from public.policy_template_subscriptions
       where subscriber_key = '${concurrentSubscriberKey}')
    from public.policy_template_subscription_authorizations auth_state
    where auth_state.subscriber_key = '${concurrentSubscriberKey}';
  `);
  assert(
    concurrentState === "2|2",
    `concurrent subscription state was not serialized: ${concurrentState}`,
  );

  const snapshotHash = `0x${(1002).toString(16).padStart(64, "0")}`;
  const snapshotWriter = psqlSession(`
    set application_name = 'subscription-snapshot-writer';
    begin;
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('openzaps-policy-template-subscriptions-global', 0)
    );
    update public.policy_template_subscription_authorizations
    set version = 3, updated_at = pg_catalog.clock_timestamp()
    where subscriber_key = '${concurrentSubscriberKey}';
    select pg_catalog.pg_sleep(1.5);
    insert into public.policy_template_subscriptions (
      subscriber_key,
      content_hash,
      authorization_version
    )
    values ('${concurrentSubscriberKey}', '${snapshotHash}', 3);
    commit;
  `);
  await waitForSessionPause("subscription-snapshot-writer");
  const snapshotDuringWrite = psqlScalar(`
    select resulting_version, pg_catalog.cardinality(content_hashes)
    from public.get_policy_template_subscription_snapshot('${concurrentSubscriberKey}');
  `);
  assert(
    snapshotDuringWrite === "2|2",
    `subscription read observed a torn in-flight snapshot: ${snapshotDuringWrite}`,
  );
  const snapshotWriterResult = await snapshotWriter;
  assert(
    snapshotWriterResult.status === 0,
    `subscription snapshot writer failed: ${snapshotWriterResult.stdout}${snapshotWriterResult.stderr}`,
  );
  const snapshotAfterWrite = psqlScalar(`
    select resulting_version, pg_catalog.cardinality(content_hashes)
    from public.get_policy_template_subscription_snapshot('${concurrentSubscriberKey}');
  `);
  assert(
    snapshotAfterWrite === "3|3",
    `subscription read did not return the committed atomic snapshot: ${snapshotAfterWrite}`,
  );

  psql(`
    do $block$
    declare
      series integer;
      mutation record;
      fixture_hash text;
      expiry bigint;
    begin
      expiry := pg_catalog.floor(
        extract(epoch from pg_catalog.clock_timestamp())
      )::bigint + 120;
      for series in 1002..1257 loop
        fixture_hash := '0x' || pg_catalog.lpad(pg_catalog.to_hex(series), 64, '0');
        select *
        into mutation
        from public.set_policy_template_subscription(
          '${cappedSubscriberKey}',
          fixture_hash,
          true,
          series - 1002,
          expiry
        );
        if mutation.result_code <> 'applied'
          or mutation.resulting_version <> series - 1001
        then
          raise exception 'subscription cap fixture failed at %: %/%',
            series,
            mutation.result_code,
            mutation.resulting_version;
        end if;
      end loop;
    end;
    $block$;
  `);
  const overSubscriberCapHash = `0x${(1258).toString(16).padStart(64, "0")}`;
  const overSubscriberCap = policySubscriptionMutation(
    cappedSubscriberKey,
    overSubscriberCapHash,
    true,
    256,
  );
  assert(
    overSubscriberCap === "subscriber_limit|256|f",
    `257th active wallet subscription bypassed the cap: ${overSubscriberCap}`,
  );
  const subscriberCapState = psqlScalar(`
    select
      auth_state.version,
      (select count(*)
       from public.policy_template_subscriptions
       where subscriber_key = '${cappedSubscriberKey}')
    from public.policy_template_subscription_authorizations auth_state
    where auth_state.subscriber_key = '${cappedSubscriberKey}';
  `);
  assert(
    subscriberCapState === "256|256",
    `subscription cap changed version or row count: ${subscriberCapState}`,
  );

  const concurrentScheduleA = psqlSession(`
    select *
    from private.claim_marketing_schedule_slot_for_day(date '2099-01-05');
  `);
  const concurrentScheduleB = psqlSession(`
    select *
    from private.claim_marketing_schedule_slot_for_day(date '2099-01-05');
  `);
  const concurrentScheduleResults = await Promise.all([
    concurrentScheduleA,
    concurrentScheduleB,
  ]);
  assert(
    concurrentScheduleResults.every((result) => result.status === 0),
    `concurrent schedule claims failed unexpectedly: ${concurrentScheduleResults
      .map((result) => result.stderr)
      .join("\n")}`,
  );
  const concurrentScheduleOutput = concurrentScheduleResults.map(
    (result) => `${result.stdout}${result.stderr}`,
  );
  assert(
    concurrentScheduleOutput.filter((output) =>
      /(?:^|\n)\s*claimed\s+\|\s+weekday_product_update\s+\|\s+2099-01-05\s+\|\s+\S+/.test(output),
    ).length === 1,
    `expected one acquired schedule slot:\n${concurrentScheduleOutput.join("\n")}`,
  );
  assert(
    concurrentScheduleOutput.filter((output) =>
      /(?:^|\n)\s*already_claimed\s+\|\s+weekday_product_update\s+\|\s+2099-01-05\s+\|\s+\S+/.test(output),
    ).length === 1,
    `expected one duplicate schedule slot:\n${concurrentScheduleOutput.join("\n")}`,
  );
  const scheduleSlotState = psqlScalar(`
    select count(*), min(claimed_at) is not null
    from public.marketing_schedule_slots
    where schedule_key = 'weekday_product_update'
      and slot_day = date '2099-01-05';
  `);
  assert(
    scheduleSlotState === "1|t",
    `schedule slot was not unique and durable: ${scheduleSlotState}`,
  );
  const weekendScheduleClaim = psqlScalar(`
    select result_code, schedule_key, slot_day, claimed_at is null
    from private.claim_marketing_schedule_slot_for_day(date '2099-01-10');
  `);
  assert(
    weekendScheduleClaim ===
      "outside_schedule|weekday_product_update|2099-01-10|t",
    `weekend schedule invocation acquired a slot: ${weekendScheduleClaim}`,
  );

  const missingReceiptWrites = await Promise.all(
    [
      {
        key: "x",
        channel: "x",
        action: "broadcast",
        counter: "xPosts",
        status: "published",
      },
      {
        key: "discord",
        channel: "discord",
        action: "broadcast",
        counter: "discordPosts",
        status: "published",
      },
      {
        key: "substack",
        channel: "substack",
        action: "prepare_tutorial",
        counter: "substackTutorials",
        status: "requires_human_publish",
      },
    ].map((fixture) =>
      psqlSession(`
        insert into public.marketing_delivery_ledger (
          idempotency_key,
          run_id,
          candidate_id,
          content_hash,
          channel,
          action,
          counter_key,
          interaction_id,
          approved_by,
          claim_day,
          status,
          finalized_at
        )
        values (
          'marketing:missing-receipt:${fixture.key}',
          'marketing-invalid-run',
          'marketing-invalid-${fixture.key}',
          '${"ab".repeat(32)}',
          '${fixture.channel}',
          '${fixture.action}',
          '${fixture.counter}',
          null,
          'integration-test',
          date '2099-01-05',
          '${fixture.status}',
          pg_catalog.clock_timestamp()
        );
      `),
    ),
  );
  assert(
    missingReceiptWrites.every((result) => result.status !== 0),
    `terminal rows accepted missing receipts: ${missingReceiptWrites
      .map((result) => `${result.status}:${result.stdout}${result.stderr}`)
      .join("\n")}`,
  );

  const firstMarketingClaim = marketingDeliveryClaim({
    idempotencyKey: "marketing:first:x",
    dailyCap: 1,
  }).split("|");
  assert(
    firstMarketingClaim.slice(0, 3).join("|") === "claimed|claimed|1",
    `initial marketing claim failed: ${firstMarketingClaim.join("|")}`,
  );
  const replayedMarketingClaim = marketingDeliveryClaim({
    idempotencyKey: "marketing:first:x",
    dailyCap: 1,
  }).split("|");
  assert(
    replayedMarketingClaim.slice(0, 3).join("|") === "already_claimed|claimed|1",
    `marketing idempotency replay was not retained: ${replayedMarketingClaim.join("|")}`,
  );
  const conflictingMarketingClaim = marketingDeliveryClaim({
    idempotencyKey: "marketing:first:x",
    contentHash: "bb".repeat(32),
    dailyCap: 1,
  }).split("|");
  assert(
    conflictingMarketingClaim[0] === "idempotency_conflict",
    `marketing idempotency identity was mutable: ${conflictingMarketingClaim.join("|")}`,
  );
  const redactedConflict = psqlScalar(`
    select
      result_code,
      provider_message_id is null
        and provider_url is null
        and failure_code is null
        and claimed_at is null
        and completed_at is null
    from public.claim_marketing_delivery(
      'marketing:first:x',
      'marketing-run-1',
      'marketing-candidate-1',
      '${"bb".repeat(32)}',
      'x',
      'broadcast',
      null,
      'integration-test',
      1
    );
  `);
  assert(
    redactedConflict === "idempotency_conflict|t",
    `marketing conflict exposed existing receipt metadata: ${redactedConflict}`,
  );
  for (const [channel, action] of [
    ["x", "direct_message"],
    ["discord", "reply"],
    ["substack", "publish_tutorial"],
  ]) {
    const unsupportedClaim = marketingDeliveryClaim({
      idempotencyKey: `marketing:unsupported:${channel}:${action}`,
      candidateId: `marketing-unsupported-${channel}-${action}`,
      contentHash: "de".repeat(32),
      channel,
      action,
    }).split("|");
    assert(
      unsupportedClaim[0] === "invalid_input",
      `undeployed ${channel}/${action} action entered the ledger: ${unsupportedClaim.join("|")}`,
    );
  }
  const cappedMarketingClaim = marketingDeliveryClaim({
    idempotencyKey: "marketing:second:x",
    candidateId: "marketing-candidate-2",
    contentHash: "cc".repeat(32),
    dailyCap: 1,
  }).split("|");
  assert(
    cappedMarketingClaim.slice(0, 3).join("|") === "daily_cap_reached||1",
    `marketing daily cap admitted an extra post: ${cappedMarketingClaim.join("|")}`,
  );

  const firstReplyClaim = marketingDeliveryClaim({
    idempotencyKey: "marketing:reply:100",
    candidateId: "marketing-reply-100",
    contentHash: "dd".repeat(32),
    action: "reply",
    interactionId: "100",
  }).split("|");
  assert(
    firstReplyClaim.slice(0, 3).join("|") === "claimed|claimed|1",
    `initial X reply claim failed: ${firstReplyClaim.join("|")}`,
  );
  const duplicateReplyClaim = marketingDeliveryClaim({
    idempotencyKey: "marketing:reply:100:duplicate",
    candidateId: "marketing-reply-100-duplicate",
    contentHash: "ee".repeat(32),
    action: "reply",
    interactionId: "100",
  }).split("|");
  assert(
    duplicateReplyClaim[0] === "interaction_already_claimed",
    `second X reply claim bypassed interaction uniqueness: ${duplicateReplyClaim.join("|")}`,
  );

  const concurrentDiscordA = psqlSession(`
    select *
    from public.claim_marketing_delivery(
      'marketing:discord:a',
      'marketing-concurrent-run',
      'marketing-discord-a',
      '${"12".repeat(32)}',
      'discord',
      'broadcast',
      null,
      'integration-test',
      1
    );
  `);
  const concurrentDiscordB = psqlSession(`
    select *
    from public.claim_marketing_delivery(
      'marketing:discord:b',
      'marketing-concurrent-run',
      'marketing-discord-b',
      '${"13".repeat(32)}',
      'discord',
      'broadcast',
      null,
      'integration-test',
      1
    );
  `);
  const concurrentDiscordResults = await Promise.all([
    concurrentDiscordA,
    concurrentDiscordB,
  ]);
  assert(
    concurrentDiscordResults.every((result) => result.status === 0),
    `concurrent marketing claims failed unexpectedly: ${concurrentDiscordResults
      .map((result) => result.stderr)
      .join("\n")}`,
  );
  const concurrentDiscordOutput = concurrentDiscordResults.map(
    (result) => `${result.stdout}${result.stderr}`,
  );
  assert(
    concurrentDiscordOutput.filter((output) => /claimed\s+\|\s+claimed\s+\|\s+1/.test(output)).length === 1,
    `expected one concurrent Discord claim:\n${concurrentDiscordOutput.join("\n")}`,
  );
  assert(
    concurrentDiscordOutput.filter((output) => /daily_cap_reached\s+\|\s+\|\s+1/.test(output)).length === 1,
    `expected one concurrent Discord cap rejection:\n${concurrentDiscordOutput.join("\n")}`,
  );

  const marketingSnapshot = psqlScalar(`
    select
      x_posts,
      x_replies,
      discord_posts,
      substack_tutorials,
      direct_messages,
      pg_catalog.array_to_string(replied_interaction_ids, ',')
    from public.get_marketing_delivery_snapshot(array['100', '999']);
  `);
  assert(
    marketingSnapshot === "1|1|1|0|0|100",
    `marketing ledger snapshot drifted from admitted claims: ${marketingSnapshot}`,
  );

  const finalizedMarketingClaim = psqlScalar(`
    select result_code, resulting_status
    from public.complete_marketing_delivery_claim(
      'marketing:first:x',
      'x',
      'broadcast',
      'published',
      '123456789',
      'https://x.com/i/web/status/123456789',
      null
    );
  `);
  assert(
    finalizedMarketingClaim === "finalized|published",
    `marketing claim finalization failed: ${finalizedMarketingClaim}`,
  );
  const replayedFinalization = psqlScalar(`
    select result_code, resulting_status
    from public.complete_marketing_delivery_claim(
      'marketing:first:x',
      'x',
      'broadcast',
      'published',
      '123456789',
      'https://x.com/i/web/status/123456789',
      null
    );
  `);
  assert(
    replayedFinalization === "already_finalized|published",
    `marketing finalization replay was not idempotent: ${replayedFinalization}`,
  );
  const credentialLikeReceipt = psqlScalar(`
    select result_code, resulting_status
    from public.complete_marketing_delivery_claim(
      'marketing:first:x',
      'x',
      'broadcast',
      'published',
      '123456789',
      'https://x.com/i/web/status/123456789?token=secret',
      null
    );
  `);
  assert(
    credentialLikeReceipt === "invalid_input|",
    `credential-like provider metadata was accepted: ${credentialLikeReceipt}`,
  );
  const mismatchedCompletionIdentity = psqlScalar(`
    select result_code, resulting_status
    from public.complete_marketing_delivery_claim(
      'marketing:first:x',
      'discord',
      'broadcast',
      'published',
      '123456789',
      null,
      null
    );
  `);
  assert(
    mismatchedCompletionIdentity === "status_conflict|",
    `completion was not bound to the claimed channel/action: ${mismatchedCompletionIdentity}`,
  );
  const invalidSubstackTerminal = psqlScalar(`
    select result_code, resulting_status
    from public.complete_marketing_delivery_claim(
      'marketing:first:x',
      'substack',
      'prepare_tutorial',
      'published',
      '123456789',
      null,
      null
    );
  `);
  assert(
    invalidSubstackTerminal === "invalid_input|",
    `Substack handoff accepted a false published receipt: ${invalidSubstackTerminal}`,
  );
  const reconciledMarketingReceipt = psqlScalar(`
    select
      result_code,
      resulting_status,
      provider_message_id,
      provider_url,
      coalesce(failure_code, ''),
      claimed_at is not null,
      completed_at is not null
    from public.claim_marketing_delivery(
      'marketing:first:x',
      'marketing-run-1',
      'marketing-candidate-1',
      '${"aa".repeat(32)}',
      'x',
      'broadcast',
      null,
      'integration-test',
      1
    );
  `);
  assert(
    reconciledMarketingReceipt ===
      "already_claimed|published|123456789|https://x.com/i/web/status/123456789||t|t",
    `marketing replay did not return its durable receipt: ${reconciledMarketingReceipt}`,
  );
  const conflictingFinalization = psqlScalar(`
    select result_code, resulting_status
    from public.complete_marketing_delivery_claim(
      'marketing:first:x',
      'x',
      'broadcast',
      'failed',
      null,
      null,
      'provider-error'
    );
  `);
  assert(
    conflictingFinalization === "status_conflict|published",
    `marketing terminal status was rewritten: ${conflictingFinalization}`,
  );

  const marketingPrivileges = psqlScalar(`
    select
      has_table_privilege(
        'service_role',
        'public.marketing_delivery_ledger',
        'select'
      ),
      has_table_privilege(
        'service_role',
        'public.marketing_delivery_ledger',
        'insert'
      ),
      has_function_privilege(
        'anon',
        'public.claim_marketing_delivery(text,text,text,text,text,text,text,text,integer)',
        'execute'
      ),
      has_function_privilege(
        'authenticated',
        'public.get_marketing_delivery_snapshot(text[])',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.claim_marketing_delivery(text,text,text,text,text,text,text,text,integer)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.get_marketing_delivery_snapshot(text[])',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.complete_marketing_delivery_claim(text,text,text,text,text,text,text)',
        'execute'
      );
  `).split("|");
  assert(
    marketingPrivileges.join("|") === "f|f|f|f|t|t|t",
    `unexpected marketing ledger privileges: ${marketingPrivileges.join(", ")}`,
  );

  const schedulePrivileges = psqlScalar(`
    select
      has_table_privilege(
        'service_role',
        'public.marketing_schedule_slots',
        'select'
      ),
      has_table_privilege(
        'service_role',
        'public.marketing_schedule_slots',
        'insert'
      ),
      has_function_privilege(
        'anon',
        'public.claim_marketing_schedule_slot()',
        'execute'
      ),
      has_function_privilege(
        'authenticated',
        'public.claim_marketing_schedule_slot()',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'public.claim_marketing_schedule_slot()',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'private.claim_marketing_schedule_slot_for_day(date)',
        'execute'
      ),
      has_function_privilege(
        'service_role',
        'private.claim_marketing_schedule_slot()',
        'execute'
      );
  `).split("|");
  assert(
    schedulePrivileges.join("|") === "f|f|f|f|t|f|t",
    `unexpected schedule-slot privileges: ${schedulePrivileges.join(", ")}`,
  );

  const serviceLedgerRpc = await psqlSession(`
    set role service_role;
    select snapshot_day, x_posts, x_replies
    from public.get_marketing_delivery_snapshot(array['100']);
  `);
  assert(
    serviceLedgerRpc.status === 0 &&
      /\|\s+1\s+\|\s+1/.test(`${serviceLedgerRpc.stdout}${serviceLedgerRpc.stderr}`),
    `service role could not use the marketing snapshot RPC: ${serviceLedgerRpc.stdout}${serviceLedgerRpc.stderr}`,
  );
  const serviceScheduleRpc = await psqlSession(`
    set role service_role;
    select result_code, schedule_key, slot_day
    from public.claim_marketing_schedule_slot();
  `);
  assert(
    serviceScheduleRpc.status === 0 &&
      /(claimed|already_claimed|outside_schedule)\s+\|\s+weekday_product_update/.test(
        `${serviceScheduleRpc.stdout}${serviceScheduleRpc.stderr}`,
      ),
    `service role could not use the schedule-slot RPC: ${serviceScheduleRpc.stdout}${serviceScheduleRpc.stderr}`,
  );
  const serviceLedgerRead = await psqlSession(`
    set role service_role;
    select * from public.marketing_delivery_ledger;
  `);
  assert(
    serviceLedgerRead.status !== 0 &&
      /permission denied/.test(`${serviceLedgerRead.stdout}${serviceLedgerRead.stderr}`),
    "service role unexpectedly bypassed the marketing ledger RPC boundary",
  );
  const serviceScheduleRead = await psqlSession(`
    set role service_role;
    select * from public.marketing_schedule_slots;
  `);
  assert(
    serviceScheduleRead.status !== 0 &&
      /permission denied/.test(
        `${serviceScheduleRead.stdout}${serviceScheduleRead.stderr}`,
      ),
    "service role unexpectedly bypassed the schedule-slot RPC boundary",
  );

  const privateStateRead = await psqlSession(`
    set role service_role;
    select * from private.zap_intent_admission_state;
  `);
  assert(privateStateRead.status !== 0, "service role unexpectedly read private admission state");
  assert(
    /permission denied/.test(`${privateStateRead.stdout}${privateStateRead.stderr}`),
    "private admission state failed for a reason other than privilege denial",
  );

  const serviceReceiptUpdate = await psqlSession(`
    set role service_role;
    update public.execution_receipts
    set executor = '${cappedZap}'
    where tx_hash = '${receiptHash}';
  `);
  assert(serviceReceiptUpdate.status !== 0, "service role unexpectedly updated receipt evidence");
  assert(
    /permission denied/.test(`${serviceReceiptUpdate.stdout}${serviceReceiptUpdate.stderr}`),
    "service receipt update failed for a reason other than privilege denial",
  );

  for (const [operation, sql] of [
    ["update", `update public.execution_receipts set executor = '${cappedZap}' where tx_hash = '${receiptHash}';`],
    ["delete", `delete from public.execution_receipts where tx_hash = '${receiptHash}';`],
    ["truncate", "truncate public.execution_receipts;"],
  ]) {
    const mutation = await psqlSession(sql);
    assert(mutation.status !== 0, `owner ${operation} unexpectedly mutated receipt evidence`);
    assert(
      /execution receipt artifacts are immutable/.test(`${mutation.stdout}${mutation.stderr}`),
      `owner ${operation} was not rejected by the receipt immutability trigger`,
    );
  }

  const policyTruncation = await psqlSession("truncate public.policy_templates cascade;");
  assert(policyTruncation.status !== 0, "owner truncate unexpectedly erased policy templates");
  assert(
    /policy template artifacts are immutable/.test(
      `${policyTruncation.stdout}${policyTruncation.stderr}`,
    ),
    "owner truncate was not rejected by the policy-template immutability trigger",
  );

  psql(`
    insert into public.zap_intents
      (zap, owner, chain_id, kind, nonce, intent, signature, status)
    values
      ('${firstZap}', '${owner}', 4663, 'recurring', '900000', ${intent}, '0x01', 'open');

    create or replace function private.test_pause_zap_intent_update()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      perform pg_catalog.pg_sleep(1.5);
      return new;
    end;
    $function$;

    create trigger aa_test_pause_zap_intent_update
    before update on public.zap_intents
    for each row execute function private.test_pause_zap_intent_update();
  `);

  const updater = psqlSession(`
    set application_name = 'relay-update-lock-holder';
    set deadlock_timeout = '100ms';
    begin;
    update public.zap_intents
    set status = 'consumed'
    where zap = '${firstZap}' and kind = 'recurring' and nonce = '900000';
    commit;
  `);
  await waitForSessionPause("relay-update-lock-holder");
  const replay = psqlSession(`
    set deadlock_timeout = '100ms';
    set lock_timeout = '4s';
    insert into public.zap_intents
      (zap, owner, chain_id, kind, nonce, intent, signature, status)
    values
      ('${firstZap}', '${owner}', 4663, 'recurring', '900000', ${intent}, '0x01', 'open');
  `);
  const [updateResult, replayResult] = await Promise.all([updater, replay]);
  const replayOutput = `${replayResult.stdout}${replayResult.stderr}`;
  assert(updateResult.status === 0, `terminal update failed:\n${updateResult.stderr}`);
  assert(replayResult.status !== 0, "same-key replay unexpectedly inserted");
  assert(/duplicate key value/.test(replayOutput), `replay did not reach the unique check:\n${replayOutput}`);
  assert(!/deadlock detected|lock timeout/i.test(replayOutput), `lock-order regression:\n${replayOutput}`);

  psql(`
    drop trigger aa_test_pause_zap_intent_update on public.zap_intents;
    drop function private.test_pause_zap_intent_update();

    insert into public.zap_intents
      (zap, owner, chain_id, kind, nonce, intent, signature, status)
    select
      '${cappedZap}',
      '${owner}',
      4663,
      'recurring',
      series::text,
      ${intent},
      '0x02',
      'open'
    from pg_catalog.generate_series(1, 127) as series;
  `);

  const contenderA = psqlSession(`
    insert into public.zap_intents
      (zap, owner, chain_id, kind, nonce, intent, signature, status)
    values
      ('${cappedZap}', '${owner}', 4663, 'recurring', '128', ${intent}, '0x03', 'open');
  `);
  const contenderB = psqlSession(`
    insert into public.zap_intents
      (zap, owner, chain_id, kind, nonce, intent, signature, status)
    values
      ('${cappedZap}', '${owner}', 4663, 'recurring', '129', ${intent}, '0x04', 'open');
  `);
  const contenders = await Promise.all([contenderA, contenderB]);
  const successes = contenders.filter((result) => result.status === 0);
  const failures = contenders.filter((result) => result.status !== 0);
  assert(successes.length === 1, `expected one cap contender to succeed, got ${successes.length}`);
  assert(failures.length === 1, `expected one cap contender to fail, got ${failures.length}`);
  assert(
    /128-open limit/.test(`${failures[0].stdout}${failures[0].stderr}`),
    "losing cap contender did not fail on the exact capsule limit",
  );

  const counts = psqlScalar(`
    select
      (select count(*) from public.zap_intents where zap = '${cappedZap}' and status = 'open'),
      total_rows,
      open_rows
    from private.zap_intent_admission_state;
  `).split("|");
  assert(counts.length === 3, "could not parse final relay counters");
  assert(
    counts[0] === "128" && counts[1] === "129" && counts[2] === "128",
    `unexpected final counters: ${counts.join(", ")}`,
  );

  const deletion = await psqlSession(`
    delete from public.zap_intents
    where zap = '${firstZap}' and nonce = '900000';
  `);
  assert(deletion.status !== 0, "signed artifact deletion unexpectedly succeeded");
  assert(
    /cannot be deleted/.test(`${deletion.stdout}${deletion.stderr}`),
    "deletion was not rejected by the immutable-artifact trigger",
  );

  const truncation = await psqlSession("truncate public.zap_intents cascade;");
  assert(truncation.status !== 0, "signed artifact truncation unexpectedly succeeded");
  assert(
    /cannot be truncated|execution receipt artifacts are immutable/.test(
      `${truncation.stdout}${truncation.stderr}`,
    ),
    "truncation was not rejected by an immutable-evidence trigger",
  );

  const postMutationCounts = psqlScalar(`
    select
      (select count(*) from public.zap_intents),
      state.total_rows,
      state.open_rows,
      (select count(*) from public.execution_receipts)
    from private.zap_intent_admission_state as state
    where state.singleton;
  `).split("|");
  assert(
    postMutationCounts.join("|") === "129|129|128|1",
    `failed evidence mutation drifted stored rows or counters: ${postMutationCounts.join(", ")}`,
  );

  const privileges = psqlScalar(`
    select
      has_table_privilege('service_role', 'public.zap_intents', 'delete'),
      has_table_privilege('service_role', 'public.zap_intents', 'truncate'),
      has_column_privilege('service_role', 'public.zap_intents', 'status', 'update'),
      has_column_privilege('service_role', 'public.zap_intents', 'owner', 'update');
  `).split("|");
  assert(privileges.length === 4, "could not parse service-role privileges");
  assert(
    privileges.join("|") === "f|f|t|f",
    `unexpected service-role privileges: ${privileges.join(", ")}`,
  );

  console.log(
    "PostgreSQL 16 relay, marketing, and lead-notification integration: passed",
  );
} finally {
  spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "stop"], {
    cwd: root,
    stdio: "ignore",
  });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
