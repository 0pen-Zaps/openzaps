#!/usr/bin/env node

/**
 * Disposable PostgreSQL 16 integration test for relay, subscriptions, durable
 * marketing delivery, syndication admission, and lead notifications.
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

function sqlJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function refreshXComplianceCheckpoint(accountId) {
  const listed = psqlScalar(`
    select subjects::text
    from public.list_marketing_x_compliance_subjects('${accountId}', 5000);
  `);
  const subjects = JSON.parse(listed);
  if (subjects.length === 0) {
    subjects.push({ subject_kind: "account", subject_id: accountId });
  }
  const observations = subjects.map((subject) => ({
    ...subject,
    outcome: "present",
  }));
  const result = psqlScalar(`
    select result_code || '|' || checkpoint_id::text
    from public.record_marketing_x_compliance_checkpoint(
      '${accountId}',
      pg_catalog.gen_random_uuid(),
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(),
      ${sqlJson(observations)}
    );
  `).split("|");
  assert(
    result[0] === "recorded" && /^[0-9a-f-]{36}$/.test(result[1]),
    `X compliance checkpoint did not become healthy: ${result.join("|")}`,
  );
  return result[1];
}

function syndicationSnapshot({
  sourceKey,
  items = [],
  etag = null,
  lastModified = null,
  notModified = false,
}) {
  return {
    source_key: sourceKey,
    etag,
    last_modified: lastModified,
    not_modified: notModified,
    items,
  };
}

function syndicationItem({
  itemId,
  canonicalUrl,
  title,
  campaignSlug,
  publishedAt,
  classification,
}) {
  return {
    source_item_key: itemId,
    canonical_url: canonicalUrl,
    title,
    campaign_slug: campaignSlug,
    published_at: publishedAt,
    classification,
  };
}

function discoverSyndication(snapshot, initializeAsBaseline) {
  return psqlScalar(`
    select
      result_code,
      source_key,
      discovered_count,
      baseline_count,
      pending_count,
      existing_count,
      reclassified_count
    from public.discover_marketing_syndication_items(
      ${sqlJson(snapshot)},
      ${initializeAsBaseline ? "true" : "false"}
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
const agentKitCampaignMigration =
  "20260801062000_queue_agent_kit_discord_campaign.sql";
const learnHubCampaignMigration =
  "20260801100000_queue_learn_hub_campaign.sql";
const syndicationInboxMigration =
  "20260801041508_marketing_syndication_inbox.sql";
const xMentionInboxMigration =
  "20260801143000_marketing_x_mentions.sql";
const subscriptionGrantHardeningMigration =
  "20260801214552_harden_subscription_authorization_grants.sql";
const reviewedCampaignFixture = "pg16-reviewed-campaign";
const reviewedCampaignContentHash = "de".repeat(32);
const agentKitCampaignId = "agent-kit-published-v1";
const agentKitCampaignContentHash =
  "516443309a2b558c1335bb4f672a649a1f728ddc643bb0a762564835c6ff59ca";
const learnHubCampaignId = "learn-hub-launched-v1";
const learnHubXContentHash =
  "d1582813d0f9c4a53385e75082bd6d3fba90a5ea0edd2ce86bed873ca7289717";
const learnHubCommunityContentHash =
  "4f091100fe08207167569a2233d0c6ebe4910c64efd4161347277986478042c9";
const reviewedCampaignMonday = "2026-07-27T15:00:00Z";
const reviewedCampaignTuesday = "2026-07-28T15:00:00Z";
const reviewedCampaignWednesday = "2026-07-29T15:00:00Z";
const syndicationBaselineKnown = "10".repeat(32);
const syndicationBaselineUnknown = "20".repeat(32);
const syndicationPendingKnown = "30".repeat(32);
const syndicationPendingUnknown = "40".repeat(32);
const syndicationPendingFailure = "50".repeat(32);
const syndicationOpenZapsBaseline = "60".repeat(32);
const syndicationOversizedXLink = "70".repeat(32);
const syndicationMetadataDriftNew = "80".repeat(32);
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
      if (
        pass === 1
        && [agentKitCampaignMigration, learnHubCampaignMigration].includes(
          filename,
        )
      ) {
        const replayProbe = psqlFileProbe(join(migrations, filename), "select 1;");
        assert(
          replayProbe.status !== 0
            && /duplicate key value violates unique constraint "marketing_reviewed_campaigns_pkey"/.test(
              `${replayProbe.stdout}${replayProbe.stderr}`,
            ),
          `${filename} did not fail closed on an unexpected replay`,
        );
        continue;
      }
      if (
        pass === 1 &&
        [
          reviewedCampaignQueueMigration,
          syndicationInboxMigration,
          xMentionInboxMigration,
        ].includes(
          filename,
        )
      ) {
        const replayProbe = psqlFileProbe(join(migrations, filename), "select 1;");
        const expectedRelation = filename === reviewedCampaignQueueMigration
          ? "marketing_reviewed_campaigns"
          : filename === syndicationInboxMigration
            ? "marketing_syndication_sources"
            : "marketing_x_mention_accounts";
        assert(
          replayProbe.status !== 0 &&
            new RegExp(`relation "${expectedRelation}" already exists`).test(
              `${replayProbe.stdout}${replayProbe.stderr}`,
            ),
          `${filename} did not fail closed on an unexpected replay`,
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
      if (pass === 0 && filename === subscriptionGrantHardeningMigration) {
        // Supabase projects can carry service_role default privileges that
        // predate this repository. Reproduce that shared-project posture so
        // the corrective migration proves it removes inherited table grants.
        psql(`
          grant all privileges
            on table public.policy_template_subscription_authorizations
            to service_role;
        `);
        assert(
          psqlScalar(`
            select has_table_privilege(
              'service_role',
              'public.policy_template_subscription_authorizations',
              'delete'
            );
          `) === "t",
          "subscription authorization privilege-drift fixture was not installed",
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

  const xMentionRpcs = [
    "public.claim_marketing_x_mention_poll(text)",
    "public.commit_marketing_x_mention_discovery(text,uuid,text,text,text,text,boolean,jsonb)",
    "public.defer_marketing_x_mention_poll(text,uuid,timestamp with time zone,text)",
    "public.list_marketing_x_mention_inbox(text,integer)",
    "public.claim_next_marketing_x_mention(text,integer)",
    "public.complete_marketing_x_mention_reply(text,text,uuid)",
    "public.fail_marketing_x_mention_reply(text,text,uuid,text)",
    "public.record_marketing_x_mention_opt_out(text,text,text)",
    "public.erase_marketing_x_compliance_data(text,text,text,text)",
    "public.clear_marketing_x_compliance_hold(text,text)",
    "public.get_marketing_x_interaction_reference(text,text)",
    "public.list_marketing_x_compliance_subjects(text,integer)",
    "public.record_marketing_x_compliance_checkpoint(text,uuid,timestamp with time zone,timestamp with time zone,jsonb)",
    "public.get_marketing_x_compliance_health(text)",
    "public.create_marketing_x_reply_subject(text,text,text,text,text,timestamp with time zone)",
    "public.get_marketing_x_reply_subject(text)",
    "public.claim_marketing_x_reply_subject_admission(text,text)",
    "public.admit_marketing_x_outbound_delivery(text,text,text,text,uuid,timestamp with time zone)",
    "public.check_marketing_x_outbound_admission(uuid)",
    "public.finalize_marketing_x_outbound_admission(uuid,text,text)",
    "public.purge_marketing_x_retention(timestamp with time zone)",
  ];
  const xMentionRpcArray = xMentionRpcs
    .map((signature) => `'${signature}'`)
    .join(",");
  const xMentionPrivileges = psqlScalar(`
    select
      (
        select bool_and(relrowsecurity)
        from pg_catalog.pg_class
        where oid in (
          'public.marketing_x_mention_accounts'::regclass,
          'public.marketing_x_mentions'::regclass,
          'public.marketing_x_mention_opt_outs'::regclass,
          'public.marketing_x_compliance_events'::regclass,
          'public.marketing_x_compliance_checkpoints'::regclass,
          'public.marketing_x_compliance_subject_observations'::regclass,
          'public.marketing_x_reply_subjects'::regclass,
          'public.marketing_x_outbound_admissions'::regclass,
          'public.marketing_x_retention_events'::regclass
        )
      ),
      has_table_privilege(
        'service_role',
        'public.marketing_x_mentions',
        'select'
      ),
      (
        select bool_and(
          has_function_privilege('service_role', rpc.signature, 'execute')
        )
        from pg_catalog.unnest(
          array[${xMentionRpcArray}]::text[]
        ) as rpc(signature)
      ),
      (
        select bool_or(
          has_function_privilege('anon', rpc.signature, 'execute')
        )
        from pg_catalog.unnest(
          array[${xMentionRpcArray}]::text[]
        ) as rpc(signature)
      );
  `);
  assert(
    xMentionPrivileges === "t|f|t|f",
    `unexpected X mention inbox privileges: ${xMentionPrivileges}`,
  );

  const emptyXAccountId = "1910000000000000999";
  refreshXComplianceCheckpoint(emptyXAccountId);
  const emptyXLease = psqlScalar(`
    select lease_token::text
    from public.claim_marketing_x_mention_poll('${emptyXAccountId}');
  `);
  const emptyXBaseline = psqlScalar(`
    select
      result_code,
      resulting_since_id is null,
      initialized_at is not null,
      last_success_at is not null
    from public.commit_marketing_x_mention_discovery(
      '${emptyXAccountId}',
      '${emptyXLease}'::uuid,
      null,
      null,
      null,
      null,
      true,
      '[]'::jsonb
    );
  `);
  assert(
    emptyXBaseline === "baseline_empty|t|t|t",
    `empty X first-run baseline did not initialize safely: ${emptyXBaseline}`,
  );

  psql(`
    update public.marketing_x_mention_accounts
    set next_poll_at = pg_catalog.clock_timestamp() - interval '1 second'
    where account_id = '${emptyXAccountId}';
  `);
  const delayedBaselineLease = psqlScalar(`
    select lease_token::text
    from public.claim_marketing_x_mention_poll('${emptyXAccountId}');
  `);
  const delayedPreCutoffCommit = psqlScalar(`
    select result_code
    from public.commit_marketing_x_mention_discovery(
      '${emptyXAccountId}',
      '${delayedBaselineLease}'::uuid,
      null,
      '1910000000000000998',
      null,
      null,
      true,
      ${sqlJson([{
        post_id: "1910000000000000998",
        author_id: "1910000000000000997",
        conversation_id: "1910000000000000996",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        content_hmac: "11".repeat(32),
        classification: "auto_reply",
        eligibility_reason: "bounded_faq",
      }])}
    );
  `);
  const delayedPreCutoffState = psqlScalar(`
    select state
    from public.marketing_x_mentions
    where account_id = '${emptyXAccountId}'
      and post_id = '1910000000000000998';
  `);
  assert(
    delayedPreCutoffCommit === "committed" && delayedPreCutoffState === "baseline",
    `delayed pre-cutoff X mention escaped the immutable baseline: ${delayedPreCutoffCommit}|${delayedPreCutoffState}`,
  );

  const xAccountId = "1910000000000000001";
  const xObservedAt = new Date(Date.now() - 60_000).toISOString();
  const xEligibleObservedAt = new Date(Date.now() + 30_000).toISOString();
  refreshXComplianceCheckpoint(xAccountId);
  const firstXLease = psqlScalar(`
    select result_code || '|' || lease_token::text || '|' || baseline_required
    from public.claim_marketing_x_mention_poll('${xAccountId}');
  `).split("|");
  assert(
    firstXLease.length === 3
      && firstXLease[0] === "claimed"
      && /^[0-9a-f-]{36}$/.test(firstXLease[1])
      && firstXLease[2] === "true",
    `first X mention poll was not a leased baseline: ${firstXLease.join("|")}`,
  );

  const duplicateXLease = psqlScalar(`
    select result_code
    from public.claim_marketing_x_mention_poll('${xAccountId}');
  `);
  assert(
    duplicateXLease === "leased",
    `concurrent X mention poll escaped the account lease: ${duplicateXLease}`,
  );

  const baselineXCommit = psqlScalar(`
    select
      result_code,
      inserted_count,
      resulting_since_id,
      initialized_at is not null,
      last_success_at is not null
    from public.commit_marketing_x_mention_discovery(
      '${xAccountId}',
      '${firstXLease[1]}'::uuid,
      null,
      '1910000000000000201',
      null,
      null,
      true,
      ${sqlJson([
        {
          post_id: "1910000000000000200",
          author_id: "1910000000000000300",
          conversation_id: "1910000000000000400",
          created_at: xObservedAt,
          content_hmac: "12".repeat(32),
          classification: "auto_reply",
          eligibility_reason: "bounded_faq",
        },
        {
          post_id: "1910000000000000201",
          author_id: "1910000000000000301",
          conversation_id: "1910000000000000401",
          created_at: xObservedAt,
          content_hmac: "13".repeat(32),
          classification: "opt_out",
          eligibility_reason: "explicit_opt_out",
        },
      ])}
    );
  `);
  assert(
    baselineXCommit === "committed|2|1910000000000000201|t|t",
    `X mention baseline did not commit atomically: ${baselineXCommit}`,
  );

  const baselineReplyClaim = psqlScalar(`
    select result_code
    from public.claim_next_marketing_x_mention('${xAccountId}', 5);
  `);
  assert(
    baselineReplyClaim === "no_eligible",
    `first-run X mention baseline became replyable: ${baselineReplyClaim}`,
  );

  psql(`
    update public.marketing_x_mention_accounts
    set next_poll_at = pg_catalog.clock_timestamp() - interval '1 second'
    where account_id = '${xAccountId}';
  `);
  const partialXLease = psqlScalar(`
    select lease_token::text
    from public.claim_marketing_x_mention_poll('${xAccountId}');
  `);
  const pendingXItems = [
    {
      post_id: "1910000000000000202",
      author_id: "1910000000000000302",
      conversation_id: "1910000000000000402",
      created_at: xEligibleObservedAt,
      content_hmac: "14".repeat(32),
      classification: "auto_reply",
      eligibility_reason: "bounded_faq",
    },
    {
      post_id: "1910000000000000203",
      author_id: "1910000000000000303",
      conversation_id: "1910000000000000402",
      created_at: xEligibleObservedAt,
      content_hmac: "15".repeat(32),
      classification: "auto_reply",
      eligibility_reason: "bounded_faq",
    },
    {
      post_id: "1910000000000000204",
      author_id: "1910000000000000304",
      conversation_id: "1910000000000000404",
      created_at: xEligibleObservedAt,
      content_hmac: "16".repeat(32),
      classification: "review",
      eligibility_reason: "needs_review",
    },
    {
      post_id: "1910000000000000205",
      author_id: "1910000000000000302",
      conversation_id: "1910000000000000405",
      created_at: xEligibleObservedAt,
      content_hmac: "17".repeat(32),
      classification: "auto_reply",
      eligibility_reason: "bounded_faq",
    },
    {
      post_id: "1910000000000000206",
      author_id: "1910000000000000306",
      conversation_id: "1910000000000000406",
      created_at: xEligibleObservedAt,
      content_hmac: "18".repeat(32),
      classification: "auto_reply",
      eligibility_reason: "bounded_faq",
    },
  ];
  const partialXCommit = psqlScalar(`
    select result_code || '|' || resulting_since_id
    from public.commit_marketing_x_mention_discovery(
      '${xAccountId}',
      '${partialXLease}'::uuid,
      '1910000000000000201',
      '1910000000000000206',
      null,
      '1910000000000000202',
      false,
      ${sqlJson(pendingXItems)}
    );
  `);
  assert(
    partialXCommit === "partial_committed|1910000000000000201",
    `partial X mention page advanced its cursor: ${partialXCommit}`,
  );

  const incompleteXReplyClaim = psqlScalar(`
    select result_code
    from public.claim_next_marketing_x_mention('${xAccountId}', 5);
  `);
  assert(
    incompleteXReplyClaim === "poll_incomplete",
    `partial X discovery became replyable: ${incompleteXReplyClaim}`,
  );

  psql(`
    update public.marketing_x_mention_accounts
    set next_poll_at = pg_catalog.clock_timestamp() - interval '1 second'
    where account_id = '${xAccountId}';
  `);
  const completeXLease = psqlScalar(`
    select
      lease_token::text,
      since_id,
      continuation_until_id,
      continuation_base_since_id,
      continuation_newest_id
    from public.claim_marketing_x_mention_poll('${xAccountId}');
  `).split("|");
  assert(
    completeXLease.length === 5
      && /^[0-9a-f-]{36}$/.test(completeXLease[0])
      && completeXLease.slice(1).join("|") ===
        "1910000000000000201|1910000000000000202|1910000000000000201|1910000000000000206",
    `X continuation lease did not preserve stable bounds: ${completeXLease.join("|")}`,
  );
  const completeXCommit = psqlScalar(`
    select
      result_code,
      inserted_count,
      existing_count,
      resulting_since_id
    from public.commit_marketing_x_mention_discovery(
      '${xAccountId}',
      '${completeXLease[0]}'::uuid,
      '1910000000000000201',
      '1910000000000000206',
      '1910000000000000202',
      null,
      true,
      ${sqlJson(pendingXItems)}
    );
  `);
  assert(
    completeXCommit === "committed|0|5|1910000000000000206",
    `complete X mention page did not dedupe/advance: ${completeXCommit}`,
  );

  const uncoveredXReplyClaim = psqlScalar(`
    select result_code
    from public.claim_next_marketing_x_mention('${xAccountId}', 1);
  `);
  assert(
    uncoveredXReplyClaim === "subject_compliance_stale",
    `new X mention escaped subject-specific compliance coverage: ${uncoveredXReplyClaim}`,
  );
  refreshXComplianceCheckpoint(xAccountId);

  const firstXReplyClaim = psqlScalar(`
    select
      result_code,
      post_id,
      claim_token::text,
      delivery_reference::text,
      interaction_reference
    from public.claim_next_marketing_x_mention('${xAccountId}', 1);
  `).split("|");
  assert(
    firstXReplyClaim[0] === "claimed"
      && firstXReplyClaim[1] === "1910000000000000202"
      && /^[0-9a-f-]{36}$/.test(firstXReplyClaim[2])
      && /^[0-9a-f-]{36}$/.test(firstXReplyClaim[3])
      && /^[1-9][0-9]{29}$/.test(firstXReplyClaim[4])
      && firstXReplyClaim[4] !== firstXReplyClaim[1],
    `oldest eligible X mention was not claimed: ${firstXReplyClaim.join("|")}`,
  );

  const autoXAdmission = psqlScalar(`
    select result_code || '|' || admission_token::text
    from public.admit_marketing_x_outbound_delivery(
      '${xAccountId}',
      '${firstXReplyClaim[4]}',
      '${firstXReplyClaim[1]}',
      '1910000000000000302',
      '${firstXReplyClaim[2]}'::uuid,
      pg_catalog.clock_timestamp()
    );
  `).split("|");
  assert(
    autoXAdmission[0] === "admitted"
      && /^[0-9a-f-]{36}$/.test(autoXAdmission[1]),
    `covered X mention did not receive a final admission fence: ${autoXAdmission.join("|")}`,
  );
  const autoXAdmissionCheck = psqlScalar(`
    select result_code || '|' || allowed
    from public.check_marketing_x_outbound_admission(
      '${autoXAdmission[1]}'::uuid
    );
  `);
  assert(
    autoXAdmissionCheck === "allowed|true",
    `fresh X mention admission failed its final fence: ${autoXAdmissionCheck}`,
  );
  const autoXAdmissionFinalized = psqlScalar(`
    select result_code || '|' || state
    from public.finalize_marketing_x_outbound_admission(
      '${autoXAdmission[1]}'::uuid,
      'failed',
      'integration_no_provider'
    );
  `);
  assert(
    autoXAdmissionFinalized === "finalized|failed",
    `X mention admission did not finalize terminally: ${autoXAdmissionFinalized}`,
  );

  const firstXInteractionLookup = psqlScalar(`
    select result_code || '|' || interaction_reference
    from public.get_marketing_x_interaction_reference(
      '${xAccountId}',
      '${firstXReplyClaim[1]}'
    );
  `);
  assert(
    firstXInteractionLookup === `found|${firstXReplyClaim[4]}`,
    `manual reply lane did not resolve the durable X interaction reference: ${firstXInteractionLookup}`,
  );

  psql(`
    begin;
    do $cross_lane$
    declare
      auto_result text;
      manual_result text;
    begin
      select result_code into auto_result
      from public.claim_marketing_delivery(
        'x-mention:${firstXReplyClaim[3]}',
        'x-mention-auto-run',
        'x-mention-auto-candidate',
        '${"19".repeat(32)}',
        'x',
        'reply',
        '${firstXReplyClaim[4]}',
        'x-template-v1',
        5
      );
      select result_code into manual_result
      from public.claim_marketing_delivery(
        'x-manual:${firstXReplyClaim[1]}',
        'x-mention-manual-run',
        'x-mention-manual-candidate',
        '${"20".repeat(32)}',
        'x',
        'reply',
        '${firstXReplyClaim[4]}',
        'integration-test',
        5
      );
      if auto_result <> 'claimed'
        or manual_result <> 'interaction_already_claimed'
      then
        raise exception 'auto-to-manual X cross-lane dedupe failed: %|%',
          auto_result,
          manual_result;
      end if;
    end;
    $cross_lane$;
    rollback;
  `);

  psql(`
    begin;
    do $compliance$
    declare
      delivery_result text;
      erase_result record;
      poll_result text;
      clear_result text;
      redacted_interaction text;
      stored_mention_count integer;
      compliance_event_count integer;
      current_subjects jsonb;
      healthy_observations jsonb;
      clearance_checkpoint uuid;
    begin
      select result_code into delivery_result
      from public.claim_marketing_delivery(
        'x-compliance:${firstXReplyClaim[1]}',
        'x-compliance-run',
        'x-compliance-candidate',
        '${"23".repeat(32)}',
        'x',
        'reply',
        '${firstXReplyClaim[1]}',
        'integration-test',
        100
      );
      select * into erase_result
      from public.erase_marketing_x_compliance_data(
        '${xAccountId}',
        '${firstXReplyClaim[1]}',
        null,
        'source_deleted'
      );
      select interaction_id into redacted_interaction
      from public.marketing_delivery_ledger
      where idempotency_key = 'x-compliance:${firstXReplyClaim[1]}';
      select count(*)::integer into stored_mention_count
      from public.marketing_x_mentions
      where account_id = '${xAccountId}'
        and post_id = '${firstXReplyClaim[1]}';
      select count(*)::integer into compliance_event_count
      from public.marketing_x_compliance_events
      where account_id = '${xAccountId}'
        and erase_scope = 'post'
        and reason_code = 'source_deleted';
      select result_code into poll_result
      from public.claim_marketing_x_mention_poll('${xAccountId}');
      select subjects into current_subjects
      from public.list_marketing_x_compliance_subjects('${xAccountId}', 5000);
      select coalesce(
        pg_catalog.jsonb_agg(
          entries.item || pg_catalog.jsonb_build_object('outcome', 'present')
        ),
        '[]'::jsonb
      ) into healthy_observations
      from pg_catalog.jsonb_array_elements(current_subjects) as entries(item);
      select checkpoint_id into clearance_checkpoint
      from public.record_marketing_x_compliance_checkpoint(
        '${xAccountId}',
        pg_catalog.gen_random_uuid(),
        pg_catalog.clock_timestamp(),
        pg_catalog.clock_timestamp(),
        healthy_observations
      );
      select result_code into clear_result
      from public.clear_marketing_x_compliance_hold(
        '${xAccountId}',
        clearance_checkpoint::text
      );

      if delivery_result <> 'claimed'
        or erase_result.result_code <> 'erased'
        or erase_result.deleted_mention_count <> 1
        or erase_result.redacted_delivery_count <> 1
        or redacted_interaction <> '${firstXReplyClaim[4]}'
        or stored_mention_count <> 0
        or compliance_event_count <> 1
        or poll_result <> 'compliance_hold'
        or clear_result <> 'cleared'
      then
        raise exception
          'X compliance hold/clear failed: %|%|%|%|%|%|%|%|%',
          delivery_result,
          erase_result.result_code,
          erase_result.deleted_mention_count,
          erase_result.redacted_delivery_count,
          redacted_interaction,
          stored_mention_count,
          compliance_event_count,
          poll_result,
          clear_result;
      end if;
    end;
    $compliance$;
    rollback;
  `);

  const cappedXReplyClaim = psqlScalar(`
    select result_code
    from public.claim_next_marketing_x_mention('${xAccountId}', 1);
  `);
  assert(
    cappedXReplyClaim === "daily_cap_reached",
    `X mention daily cap did not run before the next claim: ${cappedXReplyClaim}`,
  );

  const failedXReply = psqlScalar(`
    select result_code || '|' || state
    from public.fail_marketing_x_mention_reply(
      '${xAccountId}',
      '${firstXReplyClaim[1]}',
      '${firstXReplyClaim[2]}'::uuid,
      'provider_ambiguous'
    );
  `);
  assert(
    failedXReply === "failed|failed",
    `X mention failure did not remain terminal: ${failedXReply}`,
  );

  const secondXReplyClaim = psqlScalar(`
    select
      result_code,
      post_id,
      claim_token::text,
      delivery_reference::text,
      interaction_reference
    from public.claim_next_marketing_x_mention('${xAccountId}', 5);
  `).split("|");
  assert(
    secondXReplyClaim[0] === "claimed"
      && secondXReplyClaim[1] === "1910000000000000206"
      && /^[0-9a-f-]{36}$/.test(secondXReplyClaim[3])
      && /^[1-9][0-9]{29}$/.test(secondXReplyClaim[4]),
    `author/conversation daily guards admitted the wrong mention: ${secondXReplyClaim.join("|")}`,
  );

  psql(`
    begin;
    do $cross_lane$
    declare
      manual_result text;
      auto_result text;
    begin
      select result_code into manual_result
      from public.claim_marketing_delivery(
        'x-manual:${secondXReplyClaim[1]}',
        'x-mention-manual-run',
        'x-mention-manual-candidate',
        '${"21".repeat(32)}',
        'x',
        'reply',
        '${secondXReplyClaim[4]}',
        'integration-test',
        5
      );
      select result_code into auto_result
      from public.claim_marketing_delivery(
        'x-mention:${secondXReplyClaim[3]}',
        'x-mention-auto-run',
        'x-mention-auto-candidate',
        '${"22".repeat(32)}',
        'x',
        'reply',
        '${secondXReplyClaim[4]}',
        'x-template-v1',
        5
      );
      if manual_result <> 'claimed'
        or auto_result <> 'interaction_already_claimed'
      then
        raise exception 'manual-to-auto X cross-lane dedupe failed: %|%',
          manual_result,
          auto_result;
      end if;
    end;
    $cross_lane$;
    rollback;
  `);

  const completedXReply = psqlScalar(`
    select result_code || '|' || state
    from public.complete_marketing_x_mention_reply(
      '${xAccountId}',
      '${secondXReplyClaim[1]}',
      '${secondXReplyClaim[2]}'::uuid
    );
  `);
  assert(
    completedXReply === "completed|replied",
    `X mention completion did not become terminal: ${completedXReply}`,
  );

  const reviewInboxBeforeOptOut = psqlScalar(`
    select review_required_count
    from public.list_marketing_x_mention_inbox('${xAccountId}', 100);
  `);
  assert(
    reviewInboxBeforeOptOut === "1",
    `X mention review inbox lost its bounded review item: ${reviewInboxBeforeOptOut}`,
  );

  const recordedXOptOut = psqlScalar(`
    select result_code || '|' || blocked_count
    from public.record_marketing_x_mention_opt_out(
      '${xAccountId}',
      '1910000000000000304',
      '1910000000000000204'
    );
  `);
  assert(
    recordedXOptOut === "recorded|1",
    `X mention opt-out did not block the review item: ${recordedXOptOut}`,
  );

  const reviewInboxAfterOptOut = psqlScalar(`
    select review_required_count
    from public.list_marketing_x_mention_inbox('${xAccountId}', 100);
  `);
  assert(
    reviewInboxAfterOptOut === "0",
    `X mention opt-out remained reviewable: ${reviewInboxAfterOptOut}`,
  );

  const manualXAccountId = "1910000000000000500";
  refreshXComplianceCheckpoint(manualXAccountId);
  const firstManualSubject = psqlScalar(`
    select result_code || '|' || interaction_reference
    from public.create_marketing_x_reply_subject(
      '${manualXAccountId}',
      '1910000000000000501',
      '1910000000000000502',
      'https://x.com/community/status/1910000000000000501',
      'operator_selected_status',
      pg_catalog.clock_timestamp()
    );
  `).split("|");
  assert(
    firstManualSubject[0] === "created"
      && /^[1-9][0-9]{29}$/.test(firstManualSubject[1]),
    `manual X subject was not vaulted opaquely: ${firstManualSubject.join("|")}`,
  );
  const safeManualSubject = psqlScalar(`
    select result_code || '|' || interaction_reference || '|' || trigger
    from public.get_marketing_x_reply_subject('${firstManualSubject[1]}');
  `);
  assert(
    safeManualSubject === `found|${firstManualSubject[1]}|operator_selected_status`,
    `manual X subject safe read was not metadata-only: ${safeManualSubject}`,
  );
  const firstManualClaim = psqlScalar(`
    select
      result_code || '|' || claim_token::text || '|' || account_id || '|'
      || post_id || '|' || author_id || '|' || target_url
    from public.claim_marketing_x_reply_subject_admission(
      '${firstManualSubject[1]}',
      'manual-subject-integration-1'
    );
  `).split("|");
  assert(
    firstManualClaim[0] === "claimed"
      && /^[0-9a-f-]{36}$/.test(firstManualClaim[1])
      && firstManualClaim.slice(2).join("|") ===
        `${manualXAccountId}|1910000000000000501|1910000000000000502|https://x.com/community/status/1910000000000000501`,
    `manual X subject claim did not reveal raw data only at the provider boundary: ${firstManualClaim.join("|")}`,
  );
  const replayedManualClaim = psqlScalar(`
    select
      result_code || '|' || (account_id is null) || '|' || (post_id is null)
      || '|' || (author_id is null) || '|' || (target_url is null)
    from public.claim_marketing_x_reply_subject_admission(
      '${firstManualSubject[1]}',
      'manual-subject-integration-1'
    );
  `);
  assert(
    replayedManualClaim === "already_claimed|true|true|true|true",
    `manual X subject replay re-exposed raw provider data: ${replayedManualClaim}`,
  );
  const firstManualAdmission = psqlScalar(`
    select result_code || '|' || admission_token::text
    from public.admit_marketing_x_outbound_delivery(
      '${manualXAccountId}',
      '${firstManualSubject[1]}',
      '1910000000000000501',
      '1910000000000000502',
      '${firstManualClaim[1]}'::uuid,
      pg_catalog.clock_timestamp()
    );
  `).split("|");
  assert(
    firstManualAdmission[0] === "admitted"
      && /^[0-9a-f-]{36}$/.test(firstManualAdmission[1]),
    `manual X subject did not receive a final admission lease: ${firstManualAdmission.join("|")}`,
  );

  const manualComplianceSubjects = JSON.parse(psqlScalar(`
    select subjects::text
    from public.list_marketing_x_compliance_subjects('${manualXAccountId}', 5000);
  `));
  const manualActionObservations = manualComplianceSubjects.map((subject) => ({
    ...subject,
    outcome:
      subject.subject_kind === "post"
      && subject.subject_id === "1910000000000000501"
        ? "deleted"
        : "present",
  }));
  const manualActionCheckpoint = psqlScalar(`
    select result_code || '|' || non_present_count
    from public.record_marketing_x_compliance_checkpoint(
      '${manualXAccountId}',
      pg_catalog.gen_random_uuid(),
      pg_catalog.clock_timestamp() - interval '1 second',
      pg_catalog.clock_timestamp(),
      ${sqlJson(manualActionObservations)}
    );
  `);
  assert(
    manualActionCheckpoint === "action_required|1",
    `non-present X provider observation did not atomically enter a hold: ${manualActionCheckpoint}`,
  );
  const fencedManualAdmission = psqlScalar(`
    select result_code || '|' || allowed
    from public.check_marketing_x_outbound_admission(
      '${firstManualAdmission[1]}'::uuid
    );
  `);
  const erasedManualSubject = psqlScalar(`
    select result_code
    from public.get_marketing_x_reply_subject('${firstManualSubject[1]}');
  `);
  const heldManualHealth = psqlScalar(`
    select result_code || '|' || hold
    from public.get_marketing_x_compliance_health('${manualXAccountId}');
  `);
  assert(
    fencedManualAdmission === "revoked|false"
      && erasedManualSubject === "not_found"
      && heldManualHealth === "hold|true",
    `X compliance action did not fence, erase, and hold atomically: ${fencedManualAdmission}|${erasedManualSubject}|${heldManualHealth}`,
  );

  const manualClearanceCheckpoint = refreshXComplianceCheckpoint(manualXAccountId);
  const manualHoldClear = psqlScalar(`
    select result_code
    from public.clear_marketing_x_compliance_hold(
      '${manualXAccountId}',
      '${manualClearanceCheckpoint}'
    );
  `);
  assert(
    manualHoldClear === "cleared",
    `provider-backed X compliance hold did not clear: ${manualHoldClear}`,
  );

  const secondManualSubject = psqlScalar(`
    select interaction_reference
    from public.create_marketing_x_reply_subject(
      '${manualXAccountId}',
      '1910000000000000503',
      '1910000000000000504',
      'https://x.com/i/web/status/1910000000000000503',
      'operator_selected_status',
      pg_catalog.clock_timestamp()
    );
  `);
  const secondManualClaim = psqlScalar(`
    select claim_token::text
    from public.claim_marketing_x_reply_subject_admission(
      '${secondManualSubject}',
      'manual-subject-integration-2'
    );
  `);
  const secondManualAdmission = psqlScalar(`
    select admission_token::text
    from public.admit_marketing_x_outbound_delivery(
      '${manualXAccountId}',
      '${secondManualSubject}',
      '1910000000000000503',
      '1910000000000000504',
      '${secondManualClaim}'::uuid,
      pg_catalog.clock_timestamp()
    );
  `);
  const completedManualAdmission = psqlScalar(`
    select result_code || '|' || state
    from public.finalize_marketing_x_outbound_admission(
      '${secondManualAdmission}'::uuid,
      'completed',
      null
    );
  `);
  const completedManualSubjectGone = psqlScalar(`
    select result_code
    from public.get_marketing_x_reply_subject('${secondManualSubject}');
  `);
  assert(
    completedManualAdmission === "finalized|completed"
      && completedManualSubjectGone === "not_found",
    `terminal manual X delivery retained raw subject data: ${completedManualAdmission}|${completedManualSubjectGone}`,
  );

  const syndicationRpcs = [
    "public.get_marketing_syndication_source_cursor(text)",
    "public.discover_marketing_syndication_items(jsonb,boolean)",
    "public.list_marketing_syndication_items(integer)",
    "public.claim_marketing_syndication_draft(text)",
    "public.attach_marketing_syndication_workflow(text,text)",
    "public.fail_marketing_syndication_draft(text)",
    "public.skip_marketing_syndication_item(text)",
    "public.sync_marketing_syndication_item(text,text,text)",
  ];
  const syndicationRpcArray = syndicationRpcs
    .map((signature) => `'${signature}'`)
    .join(",");
  const syndicationPrivileges = psqlScalar(`
    select
      (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'public.marketing_syndication_sources'::regclass
      ),
      (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'public.marketing_syndication_items'::regclass
      ),
      has_table_privilege(
        'service_role',
        'public.marketing_syndication_sources',
        'select'
      ),
      has_table_privilege(
        'service_role',
        'public.marketing_syndication_items',
        'select'
      ),
      (
        select bool_and(
          has_function_privilege('service_role', rpc.signature, 'execute')
        )
        from pg_catalog.unnest(
          array[${syndicationRpcArray}]::text[]
        ) as rpc(signature)
      ),
      (
        select bool_or(
          has_function_privilege('anon', rpc.signature, 'execute')
        )
        from pg_catalog.unnest(
          array[${syndicationRpcArray}]::text[]
        ) as rpc(signature)
      ),
      (
        select bool_or(
          has_function_privilege('authenticated', rpc.signature, 'execute')
        )
        from pg_catalog.unnest(
          array[${syndicationRpcArray}]::text[]
        ) as rpc(signature)
      );
  `);
  assert(
    syndicationPrivileges === "t|t|f|f|t|f|f",
    `unexpected syndication inbox privileges: ${syndicationPrivileges}`,
  );

  const serviceCursorRead = await psqlScalarSession(`
    set role service_role;
    select result_code
    from public.get_marketing_syndication_source_cursor('defitutorials');
  `);
  assert(
    serviceCursorRead.status === 0 &&
      /(?:^|\n)not_initialized(?:\n|$)/.test(serviceCursorRead.stdout),
    `service role could not read the bounded syndication cursor: ${serviceCursorRead.stdout}${serviceCursorRead.stderr}`,
  );

  const directSyndicationRead = await psqlScalarSession(`
    set role service_role;
    select * from public.marketing_syndication_items;
  `);
  assert(
    directSyndicationRead.status !== 0 &&
      /permission denied/.test(
        `${directSyndicationRead.stdout}${directSyndicationRead.stderr}`,
      ),
    "service role unexpectedly read the syndication inbox directly",
  );

  const unauthorizedSyndicationRpc = await psqlScalarSession(`
    set role authenticated;
    select * from public.list_marketing_syndication_items(20);
  `);
  assert(
    unauthorizedSyndicationRpc.status !== 0 &&
      /permission denied/.test(
        `${unauthorizedSyndicationRpc.stdout}${unauthorizedSyndicationRpc.stderr}`,
      ),
    "authenticated role unexpectedly executed a syndication RPC",
  );

  const baselineItems = [
    syndicationItem({
      itemId: syndicationBaselineKnown,
      canonicalUrl: "https://defitutorials.substack.com/p/baseline-known",
      title: "Baseline known tutorial",
      campaignSlug: "baseline-known",
      publishedAt: "2026-07-01T12:00:00Z",
      classification: "tutorial",
    }),
    syndicationItem({
      itemId: syndicationBaselineUnknown,
      canonicalUrl: "https://defitutorials.substack.com/p/baseline-unknown",
      title: "Baseline unclassified post",
      campaignSlug: "defitutorials-baseline-unknown",
      publishedAt: "2026-07-02T12:00:00Z",
      classification: "unknown",
    }),
  ];
  const baselineSnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    etag: 'W/"defi-v1"',
    lastModified: "Fri, 31 Jul 2026 12:00:00 GMT",
    items: baselineItems,
  });

  const emptyBaselineDiscovery = await psqlScalarSession(`
    select result_code
    from public.discover_marketing_syndication_items(
      ${sqlJson(syndicationSnapshot({ sourceKey: "defitutorials" }))},
      true
    );
  `);
  assert(
    emptyBaselineDiscovery.status !== 0 &&
      /invalid marketing syndication snapshot/.test(
        `${emptyBaselineDiscovery.stdout}${emptyBaselineDiscovery.stderr}`,
      ),
    "syndication discovery accepted an empty first baseline",
  );

  const malformedBodySnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    items: [{ ...baselineItems[0], body: "must never be stored" }],
  });
  const malformedBodyDiscovery = await psqlScalarSession(`
    select result_code
    from public.discover_marketing_syndication_items(
      ${sqlJson(malformedBodySnapshot)},
      true
    );
  `);
  assert(
    malformedBodyDiscovery.status !== 0 &&
      /invalid marketing syndication item shape/.test(
        `${malformedBodyDiscovery.stdout}${malformedBodyDiscovery.stderr}`,
      ),
    "syndication discovery accepted a content body",
  );

  const missingBaseline = discoverSyndication(baselineSnapshot, false);
  const missingBaselineState = psqlScalar(`
    select
      (select count(*) from public.marketing_syndication_sources),
      (select count(*) from public.marketing_syndication_items);
  `);
  assert(
    missingBaseline === "baseline_required|defitutorials|0|0|0|0|0" &&
      missingBaselineState === "0|0",
    `first discovery did not fail closed without a baseline: ${missingBaseline}|${missingBaselineState}`,
  );

  const baselineResult = discoverSyndication(baselineSnapshot, true);
  const baselineState = psqlScalar(`
    select
      count(*) filter (where state = 'baseline'),
      count(*) filter (where state = 'pending'),
      count(*) filter (
        where classification = 'unknown'
          and source_published_at is not null
      )
    from public.marketing_syndication_items
    where source_key = 'defitutorials';
  `);
  assert(
    baselineResult === "baselined|defitutorials|2|2|0|0|0" &&
      baselineState === "2|0|1",
    `first successful snapshot was not baselined: ${baselineResult}|${baselineState}`,
  );

  const emptyInitializedSnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    etag: 'W/"empty-poison"',
    lastModified: "Fri, 31 Jul 2026 12:30:00 GMT",
  });
  const emptyInitializedDiscovery = await psqlScalarSession(`
    select result_code
    from public.discover_marketing_syndication_items(
      ${sqlJson(emptyInitializedSnapshot)},
      false
    );
  `);
  const emptyInitializedState = psqlScalar(`
    select
      etag,
      last_modified,
      (
        select count(*)
        from public.marketing_syndication_items
        where source_key = 'defitutorials'
      )
    from public.marketing_syndication_sources
    where source_key = 'defitutorials';
  `);
  assert(
    emptyInitializedDiscovery.status !== 0 &&
      /invalid marketing syndication snapshot/.test(
        `${emptyInitializedDiscovery.stdout}${emptyInitializedDiscovery.stderr}`,
      ) &&
      emptyInitializedState ===
        'W/"defi-v1"|Fri, 31 Jul 2026 12:00:00 GMT|2',
    `an empty successful snapshot advanced durable validators: ${emptyInitializedDiscovery.stdout}${emptyInitializedDiscovery.stderr}|${emptyInitializedState}`,
  );

  const defitutorialsCursor = psqlScalar(`
    select
      result_code,
      source_key,
      initialized_at is not null,
      etag,
      last_modified,
      last_checked_at >= initialized_at
    from public.get_marketing_syndication_source_cursor('defitutorials');
  `);
  assert(
    defitutorialsCursor ===
      'found|defitutorials|t|W/"defi-v1"|Fri, 31 Jul 2026 12:00:00 GMT|t',
    `syndication cursor did not persist validators: ${defitutorialsCursor}`,
  );

  const notModifiedSnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    etag: 'W/"defi-v1"',
    lastModified: "Fri, 31 Jul 2026 12:00:00 GMT",
    notModified: true,
  });
  const notModifiedResult = discoverSyndication(notModifiedSnapshot, false);
  const notModifiedState = psqlScalar(`
    select
      (select count(*) from public.marketing_syndication_sources),
      (select count(*) from public.marketing_syndication_items);
  `);
  assert(
    notModifiedResult === "not_modified|defitutorials|0|0|0|0|0" &&
      notModifiedState === "1|2",
    `304 discovery mutated inbox items: ${notModifiedResult}|${notModifiedState}`,
  );

  const openZapsSnapshot = syndicationSnapshot({
    sourceKey: "openzaps",
    etag: '"openzaps-v1"',
    items: [
      syndicationItem({
        itemId: syndicationOpenZapsBaseline,
        canonicalUrl: "https://www.0xzaps.com/updates/baseline-release",
        title: "Baseline OpenZaps release",
        campaignSlug: "baseline-release",
        publishedAt: "2026-07-30T12:00:00Z",
        classification: "product_update",
      }),
    ],
  });
  const concurrentBaselines = await Promise.all([
    psqlScalarSession(`
      select result_code
      from public.discover_marketing_syndication_items(
        ${sqlJson(openZapsSnapshot)},
        true
      );
    `),
    psqlScalarSession(`
      select result_code
      from public.discover_marketing_syndication_items(
        ${sqlJson(openZapsSnapshot)},
        true
      );
    `),
  ]);
  assert(
    concurrentBaselines.every((result) => result.status === 0),
    `concurrent baseline calls failed: ${concurrentBaselines
      .map((result) => `${result.stdout}${result.stderr}`)
      .join("\n")}`,
  );
  const concurrentBaselineCodes = concurrentBaselines
    .map((result) => result.stdout.trim())
    .sort();
  assert(
    concurrentBaselineCodes.join("|") === "already_initialized|baselined",
    `first-run baseline was not serialized exactly once: ${concurrentBaselineCodes.join("|")}`,
  );

  const pendingItems = [
    baselineItems[0],
    {
      ...baselineItems[1],
      title: "Approved baseline tutorial title",
      published_at: "2026-07-02T12:00:00Z",
      classification: "tutorial",
    },
    syndicationItem({
      itemId: syndicationPendingKnown,
      canonicalUrl: "https://defitutorials.substack.com/p/new-bounded-zap",
      title: "A new bounded Zap tutorial",
      campaignSlug: "new-bounded-zap",
      publishedAt: "2026-08-01T03:00:00Z",
      classification: "tutorial",
    }),
    syndicationItem({
      itemId: syndicationPendingUnknown,
      canonicalUrl: "https://defitutorials.substack.com/p/new-unclassified-post",
      title: "A new unclassified post",
      campaignSlug: "new-unclassified-post",
      publishedAt: null,
      classification: "unknown",
    }),
    syndicationItem({
      itemId: syndicationPendingFailure,
      canonicalUrl: "https://defitutorials.substack.com/p/new-failure-probe",
      title: "A new failure-path tutorial",
      campaignSlug: "new-failure-probe",
      publishedAt: "2026-08-01T04:00:00Z",
      classification: "tutorial",
    }),
  ];
  const pendingSnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    etag: 'W/"defi-v2"',
    lastModified: "Sat, 01 Aug 2026 04:00:00 GMT",
    items: pendingItems,
  });
  const pendingDiscovery = discoverSyndication(pendingSnapshot, false);
  const pendingDiscoveryState = psqlScalar(`
    select
      count(*) filter (where state = 'baseline'),
      count(*) filter (where state = 'pending'),
      count(*) filter (
        where source_item_key = '${syndicationBaselineUnknown}'
          and classification = 'tutorial'
          and title = 'Approved baseline tutorial title'
          and source_published_at is not null
      )
    from public.marketing_syndication_items
    where source_key = 'defitutorials';
  `);
  assert(
    pendingDiscovery === "discovered|defitutorials|5|0|3|2|1" &&
      pendingDiscoveryState === "2|3|1",
    `later discovery did not preserve baseline and queue only new items: ${pendingDiscovery}|${pendingDiscoveryState}`,
  );

  const pendingReplay = discoverSyndication(pendingSnapshot, false);
  assert(
    pendingReplay === "discovered|defitutorials|5|0|0|5|0",
    `exact discovery replay was not idempotent: ${pendingReplay}`,
  );

  const oversizedXLinkSnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    items: [syndicationItem({
      itemId: syndicationOversizedXLink,
      canonicalUrl:
        `https://defitutorials.substack.com/p/${"a".repeat(120)}`,
      title: "A tutorial whose exact X attribution URL cannot fit",
      campaignSlug: `defitutorials-${"b".repeat(80)}`,
      publishedAt: "2026-08-01T04:01:00Z",
      classification: "tutorial",
    })],
  });
  const oversizedXLinkDiscovery = discoverSyndication(
    oversizedXLinkSnapshot,
    false,
  );
  const oversizedXLinkClaim = psqlScalar(`
    select result_code, state
    from public.claim_marketing_syndication_draft(
      '${syndicationOversizedXLink}'
    );
  `);
  assert(
    oversizedXLinkDiscovery === "discovered|defitutorials|1|0|1|0|0" &&
      oversizedXLinkClaim === "not_claimable|pending",
    `an impossible X attribution link became claimable: ${oversizedXLinkDiscovery}|${oversizedXLinkClaim}`,
  );

  const baselineClaim = psqlScalar(`
    select result_code, state, classification
    from public.claim_marketing_syndication_draft(
      '${syndicationBaselineUnknown}'
    );
  `);
  assert(
    baselineClaim === "not_claimable|baseline|tutorial",
    `baseline item became claimable after classification: ${baselineClaim}`,
  );

  const unknownClaim = psqlScalar(`
    select result_code, state, classification
    from public.claim_marketing_syndication_draft(
      '${syndicationPendingUnknown}'
    );
  `);
  assert(
    unknownClaim === "unknown_classification|pending|unknown",
    `unknown syndication item was claimable: ${unknownClaim}`,
  );

  const skipUnknown = psqlScalar(`
    select result_code, state
    from public.skip_marketing_syndication_item(
      '${syndicationPendingUnknown}'
    );
  `);
  const skipUnknownReplay = psqlScalar(`
    select result_code, state
    from public.skip_marketing_syndication_item(
      '${syndicationPendingUnknown}'
    );
  `);
  assert(
    skipUnknown === "skipped|skipped" &&
      skipUnknownReplay === "already_skipped|skipped",
    `syndication skip was not retry-safe: ${skipUnknown}|${skipUnknownReplay}`,
  );

  const skippedPromotionSnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    etag: 'W/"defi-v3"',
    lastModified: "Sat, 01 Aug 2026 05:00:00 GMT",
    items: pendingItems.map((item) =>
      item.source_item_key === syndicationPendingUnknown
        ? {
            ...item,
            published_at: "2026-08-01T05:00:00Z",
            classification: "tutorial",
          }
        : item,
    ),
  });
  const skippedPromotionDiscovery = discoverSyndication(
    skippedPromotionSnapshot,
    false,
  );
  const skippedPromotionState = psqlScalar(`
    select
      state,
      classification,
      source_published_at is null,
      workflow_run_id is null
    from public.marketing_syndication_items
    where source_item_key = '${syndicationPendingUnknown}';
  `);
  assert(
    skippedPromotionDiscovery === "discovered|defitutorials|5|0|0|5|0" &&
      skippedPromotionState === "skipped|unknown|t|t",
    `a terminal skipped item was mutated or blocked later discovery: ${skippedPromotionDiscovery}|${skippedPromotionState}`,
  );

  const metadataDriftNewItem = syndicationItem({
    itemId: syndicationMetadataDriftNew,
    canonicalUrl:
      "https://defitutorials.substack.com/p/new-after-metadata-drift",
    title: "A new tutorial after ordinary feed metadata drift",
    campaignSlug: "new-after-metadata-drift",
    publishedAt: "2026-08-01T06:00:00Z",
    classification: "tutorial",
  });
  const metadataDriftSnapshot = syndicationSnapshot({
    sourceKey: "defitutorials",
    etag: 'W/"defi-v4"',
    lastModified: "Sat, 01 Aug 2026 06:00:00 GMT",
    items: [
      ...pendingItems.map((item) =>
        item.source_item_key === syndicationBaselineKnown
          ? {
              ...item,
              title: "Edited title that must not replace stored evidence",
              published_at: "2026-07-01T13:00:00Z",
            }
          : item,
      ),
      metadataDriftNewItem,
    ],
  });
  const metadataDriftDiscovery = discoverSyndication(
    metadataDriftSnapshot,
    false,
  );
  const metadataDriftState = psqlScalar(`
    select
      (
        select title
        from public.marketing_syndication_items
        where source_item_key = '${syndicationBaselineKnown}'
      ),
      (
        select source_published_at = '2026-07-01T12:00:00Z'::timestamptz
        from public.marketing_syndication_items
        where source_item_key = '${syndicationBaselineKnown}'
      ),
      (
        select state
        from public.marketing_syndication_items
        where source_item_key = '${syndicationMetadataDriftNew}'
      ),
      (
        select etag
        from public.marketing_syndication_sources
        where source_key = 'defitutorials'
      );
  `);
  assert(
    metadataDriftDiscovery === "discovered|defitutorials|6|0|1|5|0" &&
      metadataDriftState ===
        'Baseline known tutorial|t|pending|W/"defi-v4"',
    `ordinary metadata drift blocked discovery or replaced stored evidence: ${metadataDriftDiscovery}|${metadataDriftState}`,
  );

  const concurrentDraftClaims = await Promise.all([
    psqlScalarSession(`
      select result_code, state
      from public.claim_marketing_syndication_draft(
        '${syndicationPendingKnown}'
      );
    `),
    psqlScalarSession(`
      select result_code, state
      from public.claim_marketing_syndication_draft(
        '${syndicationPendingKnown}'
      );
    `),
  ]);
  assert(
    concurrentDraftClaims.every((result) => result.status === 0),
    `concurrent syndication claims failed: ${concurrentDraftClaims
      .map((result) => `${result.stdout}${result.stderr}`)
      .join("\n")}`,
  );
  const concurrentDraftCodes = concurrentDraftClaims
    .map((result) => result.stdout.trim())
    .sort();
  assert(
    concurrentDraftCodes.join("|") ===
      "already_claimed|drafting|claimed|drafting",
    `syndication draft was not claimed exactly once: ${concurrentDraftCodes.join("|")}`,
  );

  const claimedSnapshot = psqlScalar(`
    select
      result_code,
      item_id,
      campaign_slug,
      state,
      workflow_run_id is null
    from public.claim_marketing_syndication_draft(
      '${syndicationPendingKnown}'
    );
  `);
  assert(
    claimedSnapshot ===
      `already_claimed|${syndicationPendingKnown}|new-bounded-zap|drafting|t`,
    `claim did not return the exact durable item snapshot: ${claimedSnapshot}`,
  );

  const syncBeforeAttachment = psqlScalar(`
    select result_code, state, workflow_run_id is null
    from public.sync_marketing_syndication_item(
      '${syndicationPendingKnown}',
      'run:syndication-1',
      'awaiting_approval'
    );
  `);
  assert(
    syncBeforeAttachment === "invalid_transition|drafting|t",
    `workflow evidence attached a missing run identity: ${syncBeforeAttachment}`,
  );

  const attachedDraft = psqlScalar(`
    select result_code, state, workflow_run_id
    from public.attach_marketing_syndication_workflow(
      '${syndicationPendingKnown}',
      'run:syndication-1'
    );
  `);
  const attachedDraftReplay = psqlScalar(`
    select result_code, state, workflow_run_id
    from public.attach_marketing_syndication_workflow(
      '${syndicationPendingKnown}',
      'run:syndication-1'
    );
  `);
  assert(
    attachedDraft === "attached|drafting|run:syndication-1" &&
      attachedDraftReplay ===
        "already_attached|drafting|run:syndication-1",
    `workflow attachment was not retry-safe: ${attachedDraft}|${attachedDraftReplay}`,
  );

  const awaitingApprovalSync = psqlScalar(`
    select result_code, state, workflow_run_id
    from public.sync_marketing_syndication_item(
      '${syndicationPendingKnown}',
      'run:syndication-1',
      'awaiting_approval'
    );
  `);
  assert(
    awaitingApprovalSync ===
      "synced|awaiting_approval|run:syndication-1",
    `draft evidence did not advance awaiting approval: ${awaitingApprovalSync}`,
  );

  const conflictingSync = psqlScalar(`
    select result_code, state, workflow_run_id
    from public.sync_marketing_syndication_item(
      '${syndicationPendingKnown}',
      'run:different',
      'published'
    );
  `);
  const publishedSync = psqlScalar(`
    select result_code, state, workflow_run_id
    from public.sync_marketing_syndication_item(
      '${syndicationPendingKnown}',
      'run:syndication-1',
      'published'
    );
  `);
  const publishedSyncReplay = psqlScalar(`
    select result_code, state, workflow_run_id
    from public.sync_marketing_syndication_item(
      '${syndicationPendingKnown}',
      'run:syndication-1',
      'published'
    );
  `);
  assert(
    conflictingSync ===
      "workflow_conflict|awaiting_approval|run:syndication-1" &&
      publishedSync === "synced|published|run:syndication-1" &&
      publishedSyncReplay === "already_synced|published|run:syndication-1",
    `workflow reconciliation was not exact and retry-safe: ${conflictingSync}|${publishedSync}|${publishedSyncReplay}`,
  );

  const completedClaimReplay = psqlScalar(`
    select result_code, state, workflow_run_id
    from public.claim_marketing_syndication_draft(
      '${syndicationPendingKnown}'
    );
  `);
  assert(
    completedClaimReplay ===
      "already_completed|published|run:syndication-1",
    `completed syndication was reclaimed: ${completedClaimReplay}`,
  );

  const failureClaim = psqlScalar(`
    select result_code, state
    from public.claim_marketing_syndication_draft(
      '${syndicationPendingFailure}'
    );
  `);
  const failedStart = psqlScalar(`
    select result_code, state, workflow_run_id is null
    from public.fail_marketing_syndication_draft(
      '${syndicationPendingFailure}'
    );
  `);
  const failedStartReplay = psqlScalar(`
    select result_code, state
    from public.fail_marketing_syndication_draft(
      '${syndicationPendingFailure}'
    );
  `);
  const failedClaimReplay = psqlScalar(`
    select result_code, state
    from public.claim_marketing_syndication_draft(
      '${syndicationPendingFailure}'
    );
  `);
  assert(
    failureClaim === "claimed|drafting" &&
      failedStart === "failed|failed|t" &&
      failedStartReplay === "already_failed|failed" &&
      failedClaimReplay === "failed|failed",
    `ambiguous workflow start was retryable: ${failureClaim}|${failedStart}|${failedStartReplay}|${failedClaimReplay}`,
  );

  const boundedList = psqlScalar(`
    select item_id, campaign_slug, source_published_at is not null
    from public.list_marketing_syndication_items(100)
    where item_id = '${syndicationPendingKnown}';
  `);
  assert(
    boundedList === `${syndicationPendingKnown}|new-bounded-zap|t`,
    `bounded syndication list lost durable source metadata: ${boundedList}`,
  );
  const oversizedList = await psqlScalarSession(`
    select * from public.list_marketing_syndication_items(101);
  `);
  assert(
    oversizedList.status !== 0 &&
      /invalid marketing syndication list limit/.test(
        `${oversizedList.stdout}${oversizedList.stderr}`,
      ),
    "syndication list accepted an unbounded limit",
  );

  for (const [mutation, expectedError] of [
    [
      `update public.marketing_syndication_items
       set canonical_url = canonical_url || '-changed'
       where source_item_key = '${syndicationBaselineKnown}'`,
      "marketing syndication item identity is immutable",
    ],
    [
      `update public.marketing_syndication_items
       set state = 'published'
       where source_item_key = '${syndicationBaselineKnown}'`,
      "invalid marketing syndication state transition",
    ],
    [
      `delete from public.marketing_syndication_items
       where source_item_key = '${syndicationBaselineKnown}'`,
      "marketing syndication evidence is append-only",
    ],
    [
      "truncate public.marketing_syndication_items",
      "marketing syndication evidence is append-only",
    ],
  ]) {
    const mutationAttempt = await psqlScalarSession(mutation);
    assert(
      mutationAttempt.status !== 0 &&
        `${mutationAttempt.stdout}${mutationAttempt.stderr}`.includes(
          expectedError,
        ),
      `syndication artifact mutation was not rejected: ${mutation}\n${mutationAttempt.stdout}${mutationAttempt.stderr}`,
    );
  }

  const immutableSyndicationState = psqlScalar(`
    select
      (select count(*) from public.marketing_syndication_sources),
      (select count(*) from public.marketing_syndication_items),
      count(*) filter (where state = 'published'),
      count(*) filter (where state = 'skipped'),
      count(*) filter (where state = 'failed')
    from public.marketing_syndication_items;
  `);
  assert(
    immutableSyndicationState === "2|8|1|1|1",
    `rejected syndication mutations changed durable state: ${immutableSyndicationState}`,
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
    initialReviewedCampaignState === "3|0|1",
    `reviewed campaign queue did not contain the three exact release artifacts: ${initialReviewedCampaignState}`,
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
      '2026-07-27'::date,
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
          '2026-07-27'::date,
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
      '2026-07-27'::date,
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
    reviewedCampaignChannelState === "3|1",
    `reviewed queue fixture changed the expected channel distribution: ${reviewedCampaignChannelState}`,
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
    firstReviewedCampaignClaimState === "1|1|discord|2026-07-27",
    `first reviewed campaign claim did not persist exactly once: ${firstReviewedCampaignClaimState}`,
  );

  const reviewedCampaignVerification = psqlScalar(`
    select
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'discord',
          '2026-07-27'::date,
          '${reviewedCampaignContentHash}',
          '${reviewedCampaignMonday}'::timestamptz
        )
      ),
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'x',
          '2026-07-27'::date,
          '${reviewedCampaignContentHash}',
          '${reviewedCampaignMonday}'::timestamptz
        )
      ),
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'discord',
          '2026-07-27'::date,
          '${"ef".repeat(32)}',
          '${reviewedCampaignMonday}'::timestamptz
        )
      ),
      (
        select verified
        from private.verify_marketing_campaign_schedule_claim_at(
          '${reviewedCampaignFixture}',
          'discord',
          '2026-07-27'::date,
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

  const agentKitCampaignClaim = psqlScalar(`
    select
      result_code || '|' ||
      campaign_id || '|' ||
      channel || '|' ||
      queue_order::text || '|' ||
      content_hash || '|' ||
      (not_before = '2026-08-03T14:00:00Z'::timestamptz)::text || '|' ||
      (body = $campaign$**The OpenZaps Agent Kit is published.**

\`@openzaps/sdk@0.1.0\` compiles the exact policy tuple and prepares unsigned EIP-712 data. \`@openzaps/mcp@0.1.0\` gives agent clients read-only capsule discovery. Both releases carry npm provenance attestations.

Neither package holds a key, signs, or broadcasts. Your wallet or Safe creates authority; the signed intent and immutable Zap policy set the bounds.

Connect an agent: https://www.0xzaps.com/docs#agents

Pre-audit software. Verify before use.$campaign$)::text
    from private.claim_next_marketing_campaign_at(
      array['discord']::text[],
      '2026-08-03T15:00:00Z'::timestamptz
    );
  `);
  assert(
    agentKitCampaignClaim ===
      `claimed|${agentKitCampaignId}|discord|20|${agentKitCampaignContentHash}|true|true`,
    `actual Agent Kit campaign claim drifted: ${agentKitCampaignClaim}`,
  );

  const agentKitSameDayReplay = psqlScalar(`
    select result_code
    from private.claim_next_marketing_campaign_at(
      array['discord']::text[],
      '2026-08-03T15:05:00Z'::timestamptz
    );
  `);
  assert(
    agentKitSameDayReplay === "already_claimed",
    `Agent Kit schedule claim replay was not suppressed: ${agentKitSameDayReplay}`,
  );

  const agentKitCampaignVerification = psqlScalar(`
    select verified
    from private.verify_marketing_campaign_schedule_claim_at(
      '${agentKitCampaignId}',
      'discord',
      '2026-08-03'::date,
      '${agentKitCampaignContentHash}',
      '2026-08-03T15:05:00Z'::timestamptz
    );
  `);
  assert(
    agentKitCampaignVerification === "t",
    `Agent Kit campaign claim did not verify: ${agentKitCampaignVerification}`,
  );

  psql(`
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
      'scheduled:${agentKitCampaignId}:discord',
      'marketing-agent-kit-campaign-harness',
      'marketing-agent-kit-campaign-harness-discord',
      '${agentKitCampaignContentHash}',
      'discord',
      'broadcast',
      'discordPosts',
      null,
      'integration-test',
      '2000-01-04'::date,
      'claimed'
    );
  `);

  const learnHubXClaim = psqlScalar(`
    select
      result_code || '|' ||
      campaign_id || '|' ||
      channel || '|' ||
      queue_order::text || '|' ||
      content_hash || '|' ||
      (not_before = '2026-08-04T14:00:00Z'::timestamptz)::text || '|' ||
      (body = $campaign$OpenZaps Learn is live.

Source-reviewed product updates and RSS-confirmed DeFi Tutorials in one hub. Drafts stay off this catalog until RSS confirmation.

Read—or request a bounded authority map:
https://www.0xzaps.com/learn

Pre-audit software. Verify before use.$campaign$)::text
    from private.claim_next_marketing_campaign_at(
      array['x', 'discord']::text[],
      '2026-08-04T15:00:00Z'::timestamptz
    );
  `);
  assert(
    learnHubXClaim ===
      `claimed|${learnHubCampaignId}|x|30|${learnHubXContentHash}|true|true`,
    `OpenZaps Learn X campaign claim drifted: ${learnHubXClaim}`,
  );

  const learnHubXVerification = psqlScalar(`
    select verified
    from private.verify_marketing_campaign_schedule_claim_at(
      '${learnHubCampaignId}',
      'x',
      '2026-08-04'::date,
      '${learnHubXContentHash}',
      '2026-08-04T15:05:00Z'::timestamptz
    );
  `);
  assert(
    learnHubXVerification === "t",
    `OpenZaps Learn X campaign claim did not verify: ${learnHubXVerification}`,
  );

  psql(`
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
      'scheduled:${learnHubCampaignId}:x',
      'marketing-learn-hub-x-harness',
      'marketing-learn-hub-x-harness-candidate',
      '${learnHubXContentHash}',
      'x',
      'broadcast',
      'xPosts',
      null,
      'integration-test',
      '2000-01-05'::date,
      'claimed'
    );
  `);

  const learnHubDiscordClaim = psqlScalar(`
    select
      result_code || '|' ||
      campaign_id || '|' ||
      channel || '|' ||
      queue_order::text || '|' ||
      content_hash || '|' ||
      (not_before = '2026-08-04T14:00:00Z'::timestamptz)::text || '|' ||
      (body = $campaign$**OpenZaps Learn is live.**

The new hub collects source-reviewed OpenZaps product updates and DeFi Tutorials whose title and canonical URL are RSS-confirmed. Drafts and editor handoffs are withheld from the Learn catalog until RSS confirmation.

Use it to follow what shipped, read why the bounds matter, or request a human-reviewed authority map for one workflow:
https://www.0xzaps.com/learn

Pre-audit software. Verify before use.$campaign$)::text
    from private.claim_next_marketing_campaign_at(
      array['x', 'discord']::text[],
      '2026-08-05T15:00:00Z'::timestamptz
    );
  `);
  assert(
    learnHubDiscordClaim ===
      `claimed|${learnHubCampaignId}|discord|31|${learnHubCommunityContentHash}|true|true`,
    `OpenZaps Learn Discord campaign claim drifted: ${learnHubDiscordClaim}`,
  );

  const learnHubDiscordVerification = psqlScalar(`
    select verified
    from private.verify_marketing_campaign_schedule_claim_at(
      '${learnHubCampaignId}',
      'discord',
      '2026-08-05'::date,
      '${learnHubCommunityContentHash}',
      '2026-08-05T15:05:00Z'::timestamptz
    );
  `);
  assert(
    learnHubDiscordVerification === "t",
    `OpenZaps Learn Discord campaign claim did not verify: ${learnHubDiscordVerification}`,
  );

  psql(`
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
      'scheduled:${learnHubCampaignId}:discord',
      'marketing-learn-hub-discord-harness',
      'marketing-learn-hub-discord-harness-candidate',
      '${learnHubCommunityContentHash}',
      'discord',
      'broadcast',
      'discordPosts',
      null,
      'integration-test',
      '2000-01-06'::date,
      'claimed'
    );
  `);

  const completedReviewedCampaignQueue = psqlScalar(`
    select result_code
    from private.claim_next_marketing_campaign_at(
      array['x', 'discord']::text[],
      '2026-08-06T15:00:00Z'::timestamptz
    );
  `);
  const completedReviewedCampaignState = psqlScalar(`
    select
      (select count(*) from public.marketing_campaign_schedule_claims),
      (
        select count(*)
        from public.marketing_delivery_ledger
        where idempotency_key in (
          'scheduled:${agentKitCampaignId}:discord',
          'scheduled:${learnHubCampaignId}:x',
          'scheduled:${learnHubCampaignId}:discord'
        )
      );
  `);
  assert(
    completedReviewedCampaignQueue === "no_pending_campaign"
      && completedReviewedCampaignState === "5|3",
    `completed reviewed campaign queue was reclaimed: ${completedReviewedCampaignQueue}|${completedReviewedCampaignState}`,
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
    immutableReviewedCampaignState === "4|5",
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

  const subscriptionAuthorizationPrivileges = psqlScalar(`
    select
      has_table_privilege(
        'service_role',
        'public.policy_template_subscription_authorizations',
        'select'
      ),
      has_table_privilege(
        'service_role',
        'public.policy_template_subscription_authorizations',
        'insert'
      ),
      has_table_privilege(
        'service_role',
        'public.policy_template_subscription_authorizations',
        'update'
      ),
      has_table_privilege(
        'service_role',
        'public.policy_template_subscription_authorizations',
        'delete'
      ),
      has_table_privilege(
        'service_role',
        'public.policy_template_subscription_authorizations',
        'truncate'
      ),
      has_table_privilege(
        'service_role',
        'public.policy_template_subscription_authorizations',
        'references'
      ),
      has_table_privilege(
        'service_role',
        'public.policy_template_subscription_authorizations',
        'trigger'
      );
  `).split("|");
  assert(
    subscriptionAuthorizationPrivileges.join("|") ===
      "t|t|t|f|f|f|f",
    `unexpected subscription authorization privileges: ${subscriptionAuthorizationPrivileges.join(", ")}`,
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

  const sharedNetworkFingerprint = "e".repeat(64);
  const sharedNetworkResults = [];
  for (let index = 1; index <= 13; index += 1) {
    sharedNetworkResults.push(
      submitLeadFixture({
        fingerprint: sharedNetworkFingerprint,
        email: `lead-quota-${index}@example.com`,
        name: `Harness Lead Quota ${index}`,
      }),
    );
  }
  const independentNetworkResult = submitLeadFixture({
    fingerprint: "f".repeat(64),
    email: "lead-quota-independent@example.com",
    name: "Harness Lead Quota Independent",
  });
  const sharedNetworkState = psqlScalar(`
    select
      quotas.accepted_count,
      count(leads.id)
    from private.lead_request_quotas as quotas
    left join private.lead_requests as leads
      on leads.email like 'lead-quota-%@example.com'
      and leads.email <> 'lead-quota-independent@example.com'
    where quotas.client_fingerprint = '${sharedNetworkFingerprint}'
    group by quotas.accepted_count;
  `);
  assert(
    sharedNetworkResults.slice(0, 12).every((result) => result === "accepted")
      && sharedNetworkResults[12] === "quota_reached"
      && independentNetworkResult === "accepted"
      && sharedNetworkState === "12|12",
    `lead shared-network quota was not bounded independently: ${sharedNetworkResults.join(",")}|${independentNetworkResult}|${sharedNetworkState}`,
  );
  psql(`
    delete from private.lead_requests
    where email like 'lead-quota-%@example.com';

    delete from private.lead_request_quotas
    where client_fingerprint in (
      '${sharedNetworkFingerprint}',
      '${"f".repeat(64)}'
    );
  `);

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
    "PostgreSQL 16 relay, marketing, syndication, and lead-notification integration: passed",
  );
} finally {
  spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "stop"], {
    cwd: root,
    stdio: "ignore",
  });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
