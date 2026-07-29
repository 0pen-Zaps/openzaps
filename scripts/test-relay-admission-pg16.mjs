#!/usr/bin/env node

/**
 * Disposable PostgreSQL 16 integration test for the relay admission migration.
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

async function waitForUpdatePause() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const count = psqlScalar(`
      select count(*)
      from pg_catalog.pg_stat_activity
      where application_name = 'relay-update-lock-holder'
        and wait_event = 'PgSleep';
    `);
    if (count === "1") return;
    await delay(20);
  }
  throw new Error("update session never reached the row-locked pause");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const firstZap = "0x1111111111111111111111111111111111111111";
const cappedZap = "0x2222222222222222222222222222222222222222";
const receiptHash = `0x${"33".repeat(32)}`;
const policyHash = `0x${"44".repeat(32)}`;
const intent =
  `'{"executor":"0x0000000000000000000000000000000000000000"}'::jsonb`;

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
  // A clean schema must survive a complete replay too. This catches migrations
  // whose IF EXISTS/OR REPLACE story only works in a partially upgraded DB.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const filename of migrationFiles) {
      psqlFile(join(migrations, filename));
    }
  }

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
      has_table_privilege('service_role', 'public.execution_receipts', 'truncate');
  `).split("|");
  assert(
    hardenedPrivileges.join("|") === "t|f|f|t|t|t|f|f|f",
    `unexpected hardened service privileges: ${hardenedPrivileges.join(", ")}`,
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
      '${firstZap}',
      '${cappedZap}',
      '0x${"66".repeat(32)}',
      '0x${"77".repeat(32)}',
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
      '${firstZap}',
      '${cappedZap}',
      '0x${"66".repeat(32)}',
      '0x${"77".repeat(32)}',
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
  await waitForUpdatePause();
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

  console.log("PostgreSQL 16 relay admission integration: passed");
} finally {
  spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "stop"], {
    cwd: root,
    stdio: "ignore",
  });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
