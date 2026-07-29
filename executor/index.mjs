#!/usr/bin/env node
// OpenZaps Zap Executor — watches time and chain, submits owed recurring/trigger executions, and
// earns 80% of the 1% protocol fee (the other 20% funds the 0xZAPS lottery pot).
//
//   node executor/index.mjs start    run the loop (what launchd runs)
//   node executor/index.mjs once     one evaluation pass + one keeper attempt, then exit
//   node executor/index.mjs status   connectivity + store summary + gas health, then exit
//
// Fail-closed: with no OPENZAPS_EXECUTOR_PRIVATE_KEY / OPENZAPS_EXECUTOR_KEYFILE configured this
// process is read-only against the chain (watch-only mode).
//
// Two INDEPENDENT loops share one in-memory state object (persisted atomically after each change):
//   * the intent loop — evaluates every stored intent each pollMs and submits owed runs;
//   * the maintenance loop — gas self-check + the pot-conversion keeper.
// Evaluation and monitoring stay independent, while every wallet write deliberately shares one
// durable, one-outstanding signer lane until its canonical receipt settles.
import { createPublicClient, createWalletClient, createNonceManager, defineChain, fallback, http } from "viem";
import { jsonRpc } from "viem/nonce";
import { privateKeyToAccount } from "viem/accounts";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadExecutorKey } from "./config.mjs";
import { loadIntents, archiveIntent, readState, writeState } from "./store.mjs";
import { checkNonceLane, createAsyncMutex, tick, log } from "./engine.mjs";
import { checkGas, convertPotFees } from "./keeper.mjs";
import { loadIntakeToken, startIntake } from "./intake.mjs";
import { fetchRelayIntents, markRelayConsumed } from "./relay-source.mjs";
import {
  accountSettledReceipts,
  createReceiptOutboxController,
  intentHasPendingReceipt,
  pendingReceiptIdentitySet,
  settleReceiptOutbox,
} from "./receipt-source.mjs";
import { deliverOperationalNotification, operationalStatus } from "./notifications.mjs";

let relayWarned = false; // dedupe the relay-poll failure warning to once per outage
let receiptOutboxController = null;
const withSignerLane = createAsyncMutex();

function getReceiptOutboxController(state) {
  receiptOutboxController ??= createReceiptOutboxController(state, (nextState) =>
    writeState(cfg.stateFile, nextState),
  );
  return receiptOutboxController;
}

async function walletBroadcastAdmission(walletClient, state) {
  const outboxAdmission = getReceiptOutboxController(state).admission();
  if (!outboxAdmission.allowed) return outboxAdmission;
  return checkNonceLane(publicClient, walletClient);
}

/** Dedup key includes the capsule: different zaps routinely reuse the same series/nonce values. */
function intentKey(item) {
  return `${String(item.intent.zap).toLowerCase()}:${item.kind}:${item.kind === "trigger" ? item.intent.nonce : item.intent.seriesId}`;
}

const MAX_SUBMISSION_RECORDS = 200;

const cfg = loadConfig();

/**
 * Single-instance guard. Two daemons on one intents dir both broadcast every due run (the loser's
 * tx reverts and burns gas) and race state.json. The intake port is only an accidental mutex — it
 * vanishes when configs diverge (different intakePort, or 0). A pid lockfile makes it explicit.
 * Returns a release() to call on clean shutdown.
 */
function acquireLock() {
  const lockFile = join(cfg.stateFile, "..", "executor.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockFile, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      fd = undefined;
      return () => {
        try {
          if (
            existsSync(lockFile)
            && readFileSync(lockFile, "utf8").trim() === String(process.pid)
          ) {
            unlinkSync(lockFile);
          }
        } catch {
          // Best effort.
        }
      };
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the lock acquisition error.
        }
      }
      if (error?.code !== "EEXIST") throw error;
    }

    let pid;
    try {
      pid = Number(readFileSync(lockFile, "utf8").trim());
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    let alive = Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid;
    if (alive) {
      try {
        process.kill(pid, 0); // signal 0 only probes existence
      } catch (error) {
        alive = error?.code !== "ESRCH";
      }
    }
    if (alive) {
      throw new Error(`another executor is already running (pid ${pid}, lock ${lockFile}). Stop it first.`);
    }
    try {
      unlinkSync(lockFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`could not acquire executor lock ${lockFile}; retry after checking for another daemon`);
}

const chain = defineChain({
  id: cfg.chainId,
  name: `chain-${cfg.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
});

// One flaky endpoint must not idle the bundler: with OPENZAPS_RPC_URLS set, every request tries
// the URLs in order (viem ranks/falls back per call). Single-URL mode otherwise.
const transport =
  cfg.rpcUrls.length > 1
    ? fallback(cfg.rpcUrls.map((u) => http(u, { retryCount: 1, timeout: 8_000 })), { rank: true })
    : http(cfg.rpcUrls[0] ?? cfg.rpcUrl, { retryCount: 2, timeout: 8_000 });

const publicClient = createPublicClient({ chain, transport });

function buildWalletClient() {
  const key = loadExecutorKey();
  if (!key) return null;
  // A shared nonce manager serializes nonce assignment across the two loops (intent + maintenance),
  // so a submission and a buyZaps that fire close together can never grab the same nonce.
  const account = privateKeyToAccount(key, { nonceManager: createNonceManager({ source: jsonRpc() }) });
  return createWalletClient({ account, chain, transport });
}

async function connectivity() {
  const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  if (chainId !== cfg.chainId) {
    throw new Error(`RPC ${cfg.rpcUrl} reports chain ${chainId}, config expects ${cfg.chainId}`);
  }
  return { chainId, block };
}

/** Append a submission record and prune the map so state.json cannot grow without bound. */
function recordSubmission(state, key, record) {
  state.submissions[key] = record;
  const keys = Object.keys(state.submissions);
  if (keys.length > MAX_SUBMISSION_RECORDS) {
    // Insertion order is chronological; drop the oldest overflow.
    for (const stale of keys.slice(0, keys.length - MAX_SUBMISSION_RECORDS)) {
      delete state.submissions[stale];
    }
  }
}

async function notifyTransitions(state, events) {
  state.notificationStates ??= {};
  for (const event of events) {
    const status = event.status ?? operationalStatus(event);
    const key = `${String(event.zap).toLowerCase()}:${event.kind}:${event.nonce}`;
    if (!status) {
      delete state.notificationStates[key];
      continue;
    }
    if (state.notificationStates[key] === status) continue;
    state.notificationStates[key] = status;
    const result = await deliverOperationalNotification(
      {
        status,
        zap: event.zap,
        kind: event.kind,
        nonce: event.nonce,
        txHash: event.txHash ?? null,
        detail: event.detail ?? `${status} execution receipt`,
        observedAt: new Date().toISOString(),
        authorityScope: "none",
      },
      cfg,
    );
    for (const delivery of result.deliveries) {
      if (!delivery.delivered) log("warn", `notification ${delivery.channel} failed: ${delivery.error}`);
    }
  }
}

async function settleReceipts(state) {
  try {
    const result = await settleReceiptOutbox({ publicClient, state, cfg });
    accountSettledReceipts(state, result.settled);
    await notifyTransitions(
      state,
      result.settled.map((receipt) => ({
        ...receipt,
        status: receipt.outcome,
        detail: `${receipt.outcome} onchain at block ${receipt.blockNumber}`,
      })),
    );
    return result;
  } catch (err) {
    log("warn", `receipt outbox retry failed: ${err.shortMessage ?? err.message}`);
    return { settled: [], pending: Object.values(state.receiptOutbox ?? {}) };
  }
}

/** One intent pass: evaluate every intent (local files + the shared relay pool), submit owed runs. */
async function runPass(walletClient, state) {
  const outboxController = getReceiptOutboxController(state);
  await settleReceipts(state);
  const { ok, bad } = loadIntents(cfg.intentsDir);
  for (const b of bad) log("warn", `unparseable intent ${b.file}: ${b.error}`);

  // Discover intents published to the shared relay by any owner — the "connected" pool.
  let intents = ok;
  let nextRelayCursor;
  if (cfg.relayUrl) {
    // Bounded: a hung relay must never stall the intent loop (owed runs are time-critical).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const relayed = await fetchRelayIntents(cfg.relayUrl, abort.signal, fetch, {
        cursor: typeof state.relayCursor === "string" ? state.relayCursor : null,
        pageSize: cfg.relayPageSize,
        maxPages: cfg.relayMaxPagesPerPass,
        maxRows: cfg.relayMaxRowsPerPass,
        maxBytes: cfg.relayMaxBytesPerPass,
      });
      for (const b of relayed.bad) log("warn", `relay intent ${b.file}: ${b.error}`);
      // De-dupe: a local file and a relay row for the same (kind, seriesId/nonce) are one intent.
      const localKeys = new Set(ok.map(intentKey));
      intents = [...ok, ...relayed.ok.filter((i) => !localKeys.has(intentKey(i)))];
      // Advance only after tick succeeds. A crash during evaluation therefore retries this slice
      // rather than silently skipping authority that was never checked.
      if (!relayed.disabled) nextRelayCursor = relayed.nextCursor;
      relayWarned = false; // recovered
    } catch (err) {
      if (!relayWarned) {
        log("warn", `relay poll failed (file store still active): ${err.shortMessage ?? err.message}`);
        relayWarned = true;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // A persisted tx hash means this exact authorization has already been broadcast. Suppress it
  // across restarts until its chain receipt reaches finality; replaying a still-open relay row can
  // otherwise burn gas or submit a second valid run before the first transaction is observed.
  const pendingIdentities = pendingReceiptIdentitySet(state);
  const pendingReceipts = intents.filter((item) => intentHasPendingReceipt(state, item, pendingIdentities));
  if (pendingReceipts.length > 0) {
    log("info", `receipt outbox suppressing ${pendingReceipts.length} already-broadcast authorization(s)`);
    intents = intents.filter((item) => !intentHasPendingReceipt(state, item, pendingIdentities));
  }

  const results = await tick({
    publicClient,
    walletClient,
    cfg,
    intents,
    // File intents archive by renaming; a relay intent is instead marked consumed on the relay
    // (best-effort) so it drops out of the shared open list once its nonce is spent on-chain.
    archive: (item, reason) => {
      if (item.path) return archiveIntent(item, cfg.doneDir, reason);
      if (item.source === "relay" && item.relayId && cfg.relayUrl) void markRelayConsumed(cfg.relayUrl, item.relayId);
      return `relay:${item.relayId ?? item.file}`;
    },
    onBroadcast: async ({ hash, item }) => {
      try {
        await outboxController.record(item, hash);
      } catch (error) {
        log(
          "error",
          `CRITICAL: ${error.message}; no further execution broadcasts will be admitted until storage is repaired and the daemon restarts`,
        );
        throw error;
      }
    },
    canBroadcast: () => walletBroadcastAdmission(walletClient, state),
    withBroadcastLane: withSignerLane,
  });

  if (nextRelayCursor !== undefined) {
    state.relayCursor = nextRelayCursor;
    state.relayCursorUpdatedAt = new Date().toISOString();
  }
  for (const r of results) {
    const level =
      r.status === "error"
      || [
        "broadcast-admission-unknown",
        "broadcast-failed",
        "fee-market-unknown",
        "nonce-lane-unknown",
        "receipt-persistence-halted",
        "reverted",
      ].includes(r.outcome)
        ? "error"
        : ["confirmation-pending", "gas-above-cap", "nonce-lane-pending", "receipt-backlog"].includes(r.outcome)
          ? "warn"
          : "info";
    log(level, `${r.label}: ${r.status}${r.outcome ? `/${r.outcome}` : ""} — ${r.detail}`);
    if (r.txHash) {
      recordSubmission(state, `${r.label}@${Date.now()}`, { txHash: r.txHash, detail: r.detail });
    }
  }
  await notifyTransitions(
    state,
    results.map((result) => ({ ...result, status: operationalStatus(result) })),
  );
  await settleReceipts(state);
  writeState(cfg.stateFile, state);
  return results;
}

/**
 * One maintenance attempt: gas health + the pot-conversion keeper. Returns the delay (ms) until
 * the next attempt — shorter after a transient failure so a hiccup does not idle the keeper for
 * the full cadence, full cadence after success/idle.
 */
async function runMaintenance(walletClient, state) {
  await checkGas({ publicClient, walletClient, cfg });

  if (!cfg.lotteryPot) return cfg.convertEveryMs;
  const conv = await convertPotFees({
    publicClient,
    walletClient,
    cfg,
    onBroadcast: async ({ hash }) => {
      try {
        await getReceiptOutboxController(state).recordOperation(
          {
            relayIntentId: null,
            zap: cfg.lotteryPot,
            kind: "pot-conversion",
            nonce: hash.toLowerCase(),
          },
          hash,
        );
      } catch (error) {
        log(
          "error",
          `CRITICAL: ${error.message}; no further wallet broadcasts will be admitted until storage is repaired and the daemon restarts`,
        );
        throw error;
      }
    },
    canBroadcast: () => walletBroadcastAdmission(walletClient, state),
    withBroadcastLane: withSignerLane,
  });
  if (conv.outcome !== "idle" && conv.outcome !== "disabled") {
    // A reverted conversion is usually benign (another keeper drained the pot first — buyZaps is
    // permissionless and the loser's tx reverts), so it warns rather than alarms.
    const level = [
      "broadcast-failed",
      "broadcast-admission-unknown",
      "fee-market-unknown",
      "nonce-lane-unknown",
      "receipt-persistence-halted",
    ].includes(conv.outcome)
      ? "error"
      : [
          "tx-reverted",
          "confirmation-pending",
          "gas-above-cap",
          "nonce-lane-pending",
          "receipt-backlog",
        ].includes(conv.outcome)
        ? "warn"
        : "info";
    const suffix = conv.outcome === "tx-reverted" ? " (possibly another keeper converted first)" : "";
    log(level, `pot-convert: ${conv.outcome} — ${conv.detail}${suffix}`);
  }
  if (conv.txHash) {
    recordSubmission(state, `convert@${Date.now()}`, { txHash: conv.txHash, detail: conv.detail });
  }
  writeState(cfg.stateFile, state);

  const failed = [
    "read-failed",
    "simulation-reverted",
    "broadcast-failed",
    "broadcast-admission-unknown",
    "confirmation-pending",
    "fee-market-unknown",
    "gas-above-cap",
    "nonce-lane-pending",
    "nonce-lane-unknown",
    "receipt-backlog",
    "receipt-persistence-halted",
    "tx-reverted",
  ].includes(conv.outcome);
  return failed ? Math.max(Math.floor(cfg.convertEveryMs / 4), 30_000) : cfg.convertEveryMs;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const command = process.argv[2] ?? "start";
  const walletClient = buildWalletClient();

  const endpointLabel = cfg.rpcUrls.length > 1 ? `${cfg.rpcUrls.length} RPCs (fallback)` : cfg.rpcUrls[0] ?? cfg.rpcUrl;
  const { block } = await connectivity();
  log("info", `connected to chain ${cfg.chainId} via ${endpointLabel} (block ${block})`);
  log(
    "info",
    walletClient
      ? `executor wallet ${walletClient.account.address} — WILL broadcast owed executions`
      : "no executor key configured — WATCH-ONLY mode (simulates, never broadcasts)",
  );
  log("info", `intent store: ${cfg.intentsDir}`);
  log("info", cfg.relayUrl ? `relay: polling ${cfg.relayUrl}/api/intents for shared intents` : "relay: disabled (local file store only)");
  log(
    "info",
    cfg.lotteryPot
      ? `pot-conversion keeper: pot ${cfg.lotteryPot}, fee asset ${cfg.feeAsset}, every ${cfg.convertEveryMs}ms`
      : "pot-conversion keeper: disabled (no pot configured)",
  );

  if (command !== "status" && command !== "once" && command !== "start") {
    console.error(`unknown command: ${command} (use start | once | status)`);
    process.exitCode = 2;
    return;
  }

  // Broadcasting modes lock before reading state. Otherwise a replacement process could read the
  // old target while the current daemon is fsyncing a newer temp, then inherit the lock after that
  // daemon crashes and miss the pending receipt the temp was preserving.
  const release = command === "status" ? null : acquireLock();
  if (release) process.on("exit", release);

  const state = readState(cfg.stateFile);
  state.submissions ??= {};
  state.earnings ??= { runs: 0, conversions: 0 };

  if (command === "status") {
    const { ok, bad } = loadIntents(cfg.intentsDir);
    const byKind = (k) => ok.filter((i) => i.kind === k).length;
    log(
      "info",
      `intents: ${ok.length} valid (${byKind("recurring")} recurring, ${byKind("recurring-relative")} recurring-relative, ${byKind("trigger")} trigger), ${bad.length} malformed`,
    );
    log("info", `lifetime: ${state.earnings.runs} runs executed, ${state.earnings.conversions} pot conversions`);
    if (cfg.intakePort > 0) {
      // The token is a LOCAL capability (this machine only); status is where the operator
      // retrieves it to paste into the Automate tab's "Send to executor" field.
      log("info", `intake: http://127.0.0.1:${cfg.intakePort} — token: ${loadIntakeToken(cfg.intakeTokenFile)}`);
    }
    if (walletClient) await checkGas({ publicClient, walletClient, cfg, announce: true });
    return;
  }

  if (command === "once") {
    try {
      await runPass(walletClient, state);
      await runMaintenance(walletClient, state);
    } finally {
      release?.();
    }
    return;
  }

  let stopping = false;
  const stop = (signal) => {
    log("info", `${signal} received — finishing current pass then exiting`);
    stopping = true;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  let intakeServer = null;
  if (cfg.intakePort > 0) {
    intakeServer = startIntake({
      cfg,
      token: loadIntakeToken(cfg.intakeTokenFile),
      isExecuting: () => walletClient !== null,
      countIntents: () => loadIntents(cfg.intentsDir).ok.length,
    });
  }

  log("info", `loop started — intents every ${cfg.pollMs}ms, maintenance every ${cfg.convertEveryMs}ms`);

  const intentLoop = (async () => {
    while (!stopping) {
      try {
        await runPass(walletClient, state);
      } catch (err) {
        log("error", `pass failed: ${err.shortMessage ?? err.message}`);
      }
      await sleep(cfg.pollMs);
    }
  })();

  const maintenanceLoop = (async () => {
    while (!stopping) {
      let delayMs = cfg.convertEveryMs;
      try {
        delayMs = await runMaintenance(walletClient, state);
      } catch (err) {
        log("error", `maintenance failed: ${err.shortMessage ?? err.message}`);
      }
      // Sleep in short slices so SIGTERM exits promptly instead of waiting out the cadence.
      const until = Date.now() + delayMs;
      while (!stopping && Date.now() < until) await sleep(Math.min(5_000, until - Date.now()));
    }
  })();

  await Promise.all([intentLoop, maintenanceLoop]);
  intakeServer?.close();
  release?.();
}

main().catch((err) => {
  log("error", err.stack ?? String(err));
  process.exitCode = 1;
});
