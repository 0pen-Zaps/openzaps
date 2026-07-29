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
import { createPublicClient, createWalletClient, createNonceManager, custom, defineChain, fallback, http } from "viem";
import { jsonRpc } from "viem/nonce";
import { privateKeyToAccount } from "viem/accounts";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadExecutorKey } from "./config.mjs";
import { loadIntents, archiveIntent, readState, writeState } from "./store.mjs";
import {
  checkNonceLane,
  createAsyncMutex,
  executionSimulationParameters,
  tick,
  log,
} from "./engine.mjs";
import { checkGas, convertPotFees } from "./keeper.mjs";
import { loadIntakeToken, startIntake } from "./intake.mjs";
import { checkLateBlockQuorum } from "./late-block.mjs";
import { fetchRelayIntents, markRelayConsumed } from "./relay-source.mjs";
import {
  accountSettledReceipts,
  createReceiptOutboxController,
  intentHasPendingReceipt,
  pendingReceiptIdentitySet,
  recordExecutionSubmissionEvent,
  recordOperationSubmissionEvent,
  settleReceiptOutbox,
} from "./receipt-source.mjs";
import { deliverOperationalNotification, operationalStatus } from "./notifications.mjs";
import { createPrivateSubmissionProvider } from "./private-submission.mjs";

let relayWarned = false; // dedupe the relay-poll failure warning to once per outage
let receiptOutboxController = null;
const withSignerLane = createAsyncMutex();

function getReceiptOutboxController(state) {
  receiptOutboxController ??= createReceiptOutboxController(state, (nextState) =>
    writeState(cfg.stateFile, nextState),
  );
  return receiptOutboxController;
}

async function walletBroadcastAdmission(walletClient, state, item = null) {
  const outboxAdmission = getReceiptOutboxController(state).admission();
  if (!outboxAdmission.allowed) return outboxAdmission;
  const privateSubmission = walletClient?.openZapsPrivateSubmission;
  if (!privateSubmission?.readiness?.ready) {
    return {
      allowed: false,
      outcome: "private-submission-unavailable",
      detail:
        "price-sensitive execution is fail-closed: "
        + (privateSubmission?.readiness?.detail ?? "private relay transport is unavailable"),
    };
  }
  const nonceAdmission = await checkNonceLane(publicClient, walletClient);
  if (!nonceAdmission.allowed) return nonceAdmission;

  const lateBlockAdmission = await checkLateBlockQuorum({
    clients: lateBlockClients,
    chainId: cfg.chainId,
    minimumAgreement: cfg.lateBlock.minimumAgreement,
    maxHeadSkewBlocks: cfg.lateBlock.maxHeadSkewBlocks,
    maxBlockAgeSeconds: cfg.lateBlock.maxBlockAgeSeconds,
    maxFutureSkewSeconds: cfg.lateBlock.maxFutureSkewSeconds,
    simulate: item
      ? async (client, blockNumber) => {
          const { result } = await client.simulateContract(
            executionSimulationParameters(item, walletClient.account, blockNumber),
          );
          return result;
        }
      : null,
  });
  if (!lateBlockAdmission.allowed) return lateBlockAdmission;
  return {
    ...lateBlockAdmission,
    latestNonce: nonceAdmission.latestNonce,
    pendingNonce: nonceAdmission.pendingNonce,
  };
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
const lateBlockClients = cfg.lateBlock.rpcUrls.map(({ url, origin }) => ({
  origin,
  client: createPublicClient({
    chain,
    transport: http(url, { retryCount: 0, timeout: 8_000 }),
  }),
}));
const privateSubmissionProvider = createPrivateSubmissionProvider({
  endpoints: cfg.privateSubmission.endpoints,
  minimumDistinctOrigins: cfg.privateSubmission.minimumDistinctOrigins,
  timeoutMs: cfg.privateSubmission.timeoutMs,
  publicRequest: (request) => publicClient.request(request),
});

function buildWalletClient() {
  const key = loadExecutorKey();
  if (!key) return null;
  // A shared nonce manager serializes nonce assignment across the two loops (intent + maintenance),
  // so a submission and a buyZaps that fire close together can never grab the same nonce.
  const account = privateKeyToAccount(key, { nonceManager: createNonceManager({ source: jsonRpc() }) });
  // viem prepares and signs locally, then emits eth_sendRawTransaction into this custom provider.
  // Read/preparation calls still use the public client; the signed bytes can only fan out to the
  // explicitly classified private relay set, never to the public read transport.
  return createWalletClient({
    account,
    chain,
    transport: custom(privateSubmissionProvider),
  }).extend(() => ({
    openZapsPrivateSubmission: privateSubmissionProvider,
  }));
}

async function connectivity() {
  const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  if (chainId !== cfg.chainId) {
    throw new Error(`configured RPC reports chain ${chainId}, config expects ${cfg.chainId}`);
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
    const result = await settleReceiptOutbox({
      publicClient,
      finalityClients: lateBlockClients,
      state,
      cfg,
    });
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

const PRIVATE_REDISPATCH_INTERVAL_MS = 30_000;

/**
 * Raw bytes are journaled before the first relay request. Re-dispatch that exact transaction after
 * a crash in the prepare-to-send window; never construct a replacement or use the public RPC.
 */
async function redispatchPreparedPrivateTransaction(walletClient, state) {
  const prepared = Object.values(state.receiptOutbox ?? {}).filter(
    (entry) =>
      entry?.submissionState === "prepared"
      && typeof entry.serializedTransaction === "string",
  );
  if (prepared.length === 0) return;
  if (prepared.length > 1) {
    log(
      "error",
      `CRITICAL: ${prepared.length} prepared raw transactions share one signer lane; refusing automatic redispatch`,
    );
    return;
  }
  const entry = prepared[0];
  const privateSubmission = walletClient?.openZapsPrivateSubmission;
  if (!privateSubmission?.readiness?.ready) {
    log(
      "error",
      `prepared private transaction ${entry.txHash} is waiting: `
        + (privateSubmission?.readiness?.detail ?? "private relay transport unavailable"),
    );
    return;
  }
  const lastAttempt = Date.parse(entry.lastPrivateDispatchAt ?? "");
  if (
    Number.isFinite(lastAttempt)
    && Date.now() - lastAttempt < PRIVATE_REDISPATCH_INTERVAL_MS
  ) {
    return;
  }

  await withSignerLane(async () => {
    try {
      await publicClient.getTransaction({ hash: entry.txHash });
      await getReceiptOutboxController(state).markSubmitted(entry.txHash, null);
      return;
    } catch {
      // The read quorum does not know the hash yet. Exact nonce admission below decides whether
      // replay is safe; uncertainty does not trigger a private or public request.
    }
    const nonceAdmission = await checkNonceLane(publicClient, walletClient);
    if (!nonceAdmission.allowed) {
      if (nonceAdmission.outcome !== "nonce-lane-pending") {
        log("error", `prepared private transaction ${entry.txHash}: ${nonceAdmission.detail}`);
      }
      return;
    }
    try {
      const hash = await privateSubmission.request({
        method: "eth_sendRawTransaction",
        params: [entry.serializedTransaction],
      });
      if (hash.toLowerCase() !== entry.txHash.toLowerCase()) {
        throw new Error("private relay provider returned a different transaction hash");
      }
      await getReceiptOutboxController(state).markSubmitted(
        entry.txHash,
        privateSubmission.getOutcome(entry.txHash),
      );
      log("info", `redispatched prepared private transaction ${entry.txHash}`);
    } catch (error) {
      await getReceiptOutboxController(state).recordDispatchFailure(entry.txHash, error);
      log(
        "error",
        `prepared private transaction ${entry.txHash} remains fail-closed: `
          + `${error?.shortMessage ?? error?.message ?? String(error)}`,
      );
    }
  });
}

/** One intent pass: evaluate every intent (local files + the shared relay pool), submit owed runs. */
async function runPass(walletClient, state) {
  const outboxController = getReceiptOutboxController(state);
  await settleReceipts(state);
  await redispatchPreparedPrivateTransaction(walletClient, state);
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
    onBroadcast: async ({
      hash,
      item,
      phase,
      serializedTransaction,
      privateSubmission,
    }) => {
      try {
        await recordExecutionSubmissionEvent(outboxController, state, {
          hash,
          item,
          phase,
          serializedTransaction,
          privateSubmission,
        });
      } catch (error) {
        log(
          "error",
          `CRITICAL: ${error.message}; no further execution broadcasts will be admitted until storage is repaired and the daemon restarts`,
        );
        throw error;
      }
    },
    canBroadcast: (item) => walletBroadcastAdmission(walletClient, state, item),
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
        "late-block-head-skew",
        "late-block-quorum-disagrees",
        "late-block-quorum-unavailable",
        "late-block-simulation-failed",
        "nonce-lane-unknown",
        "private-submission-unavailable",
        "receipt-persistence-halted",
        "reverted",
        "sequencer-stale",
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

function conversionPots() {
  if (Array.isArray(cfg.conversionPots)) {
    return cfg.conversionPots.filter((pot) => pot && typeof pot === "object" && pot.lotteryPot);
  }
  // Config files from before multi-pot support keep the original single v3.1 target.
  return cfg.lotteryPot
    ? [
        {
          id: "v3.1",
          lotteryPot: cfg.lotteryPot,
          poolPriceSource: cfg.poolPriceSource,
          feeAsset: cfg.feeAsset,
          convertMinWei: cfg.convertMinWei,
          convertSlippageBps: cfg.convertSlippageBps,
        },
      ]
    : [];
}

function logPotAccounting(state) {
  const pots = conversionPots();
  const trackedPots =
    state.earnings?.pots && typeof state.earnings.pots === "object"
      ? state.earnings.pots
      : {};
  const configuredAddresses = new Set();
  for (const pot of pots) {
    const key = String(pot.lotteryPot).toLowerCase();
    configuredAddresses.add(key);
    const tracked = trackedPots[key];
    const asset = tracked?.assets?.[String(pot.feeAsset).toLowerCase()];
    log(
      asset?.accountingError ? "warn" : "info",
      `pot ${pot.id}: ${Number(tracked?.conversions ?? 0)} settled conversion(s), `
        + `${String(asset?.amountInWei ?? "0")} fee-asset wei converted; `
        + `pot ${pot.lotteryPot}, asset ${pot.feeAsset}`
        + `${asset?.accountingError ? `; ACCOUNTING WARNING: ${asset.accountingError}` : ""}`,
    );
  }
  for (const [address, tracked] of Object.entries(trackedPots)) {
    if (configuredAddresses.has(address)) continue;
    const assets = Object.values(tracked?.assets ?? {});
    const summary = assets
      .map((asset) => `${asset.amountInWei ?? "unknown"} wei of ${asset.address ?? "unknown asset"}`)
      .join(", ");
    log(
      "info",
      `pot ${tracked?.id ?? "historical"} (historical/unconfigured): `
        + `${Number(tracked?.conversions ?? 0)} settled conversion(s)`
        + `${summary ? `; ${summary}` : ""}; pot ${tracked?.address ?? address}`,
    );
  }
}

const FAILED_CONVERSION_OUTCOMES = new Set([
  "blocked",
  "read-failed",
  "simulation-reverted",
  "broadcast-failed",
  "broadcast-admission-unknown",
  "confirmation-pending",
  "fee-market-unknown",
  "gas-above-cap",
  "late-block-head-skew",
  "late-block-quorum-disagrees",
  "late-block-quorum-unavailable",
  "late-block-simulation-failed",
  "nonce-lane-pending",
  "nonce-lane-unknown",
  "private-submission-unavailable",
  "receipt-backlog",
  "receipt-persistence-halted",
  "sequencer-stale",
  "tx-reverted",
]);

const GLOBAL_CONVERSION_BLOCKS = new Set([
  "broadcast-admission-unknown",
  "fee-market-unknown",
  "gas-above-cap",
  "late-block-head-skew",
  "late-block-quorum-disagrees",
  "late-block-quorum-unavailable",
  "late-block-simulation-failed",
  "nonce-lane-pending",
  "nonce-lane-unknown",
  "private-submission-unavailable",
  "receipt-backlog",
  "receipt-persistence-halted",
  "sequencer-stale",
]);

/**
 * One maintenance attempt: gas health + every configured pot-conversion target. The start target
 * rotates after each pass so an always-accruing v3.1 pot cannot starve v3.2. All writes still pass
 * through the same process mutex, durable receipt admission, nonce check, and signer.
 *
 * Returns the delay (ms) until the next attempt — shorter after a transient failure so a hiccup
 * does not idle the keeper for the full cadence, full cadence after success/idle.
 */
async function runMaintenance(walletClient, state) {
  await checkGas({ publicClient, walletClient, cfg });

  const pots = conversionPots();
  if (pots.length === 0) return cfg.convertEveryMs;
  const storedCursor = Number(state.potConversionCursor ?? 0);
  const start = Number.isSafeInteger(storedCursor) && storedCursor >= 0
    ? storedCursor % pots.length
    : 0;
  const ordered = Array.from({ length: pots.length }, (_, offset) => ({
    index: (start + offset) % pots.length,
    pot: pots[(start + offset) % pots.length],
  }));
  const conversions = [];
  let nextCursor = (start + 1) % pots.length;

  for (const { index, pot } of ordered) {
    const conv = await convertPotFees({
      publicClient,
      walletClient,
      cfg,
      pot,
      onBroadcast: async ({
        hash,
        potId,
        potAddress,
        feeAsset,
        priceSource,
        amountIn,
        minZapsOut,
        phase,
        serializedTransaction,
        privateSubmission,
      }) => {
        try {
          const entry = {
            relayIntentId: null,
            zap: potAddress,
            kind: "pot-conversion",
            nonce: hash.toLowerCase(),
            potId,
            feeAsset,
            priceSource,
            amountInWei: amountIn.toString(),
            minZapsOutWei: minZapsOut.toString(),
          };
          const controller = getReceiptOutboxController(state);
          await recordOperationSubmissionEvent(controller, state, entry, {
            hash,
            phase,
            serializedTransaction,
            privateSubmission,
          });
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
    conversions.push(conv);
    if (conv.outcome !== "idle" && conv.outcome !== "disabled") {
      // A reverted conversion is usually benign (another keeper drained that pot first — buyZaps
      // is permissionless and the loser's tx reverts), so it warns rather than alarms.
      const level = [
        "blocked",
        "broadcast-failed",
        "broadcast-admission-unknown",
        "fee-market-unknown",
        "late-block-head-skew",
        "late-block-quorum-disagrees",
        "late-block-quorum-unavailable",
        "late-block-simulation-failed",
        "nonce-lane-unknown",
        "private-submission-unavailable",
        "receipt-persistence-halted",
        "sequencer-stale",
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
      const suffix = conv.outcome === "tx-reverted"
        ? " (possibly another keeper converted first)"
        : "";
      log(level, `pot-convert/${conv.potId}: ${conv.outcome} — ${conv.detail}${suffix}`);
    }
    if (conv.txHash) {
      recordSubmission(state, `convert:${conv.potId}@${Date.now()}`, {
        txHash: conv.txHash,
        detail: conv.detail,
        potId: conv.potId,
        potAddress: conv.potAddress,
        feeAsset: conv.feeAsset,
        amountInWei: conv.amountIn?.toString() ?? null,
        minZapsOutWei: conv.minZapsOut?.toString() ?? null,
      });
      nextCursor = (index + 1) % pots.length;
      break;
    }
    // Admission failures apply to the shared signer lane; re-running the same check for another pot
    // would add RPC load but cannot admit a second write.
    if (GLOBAL_CONVERSION_BLOCKS.has(conv.outcome)) break;
  }
  state.potConversionCursor = nextCursor;
  writeState(cfg.stateFile, state);

  const failed = conversions.some((conv) => FAILED_CONVERSION_OUTCOMES.has(conv.outcome));
  return failed ? Math.max(Math.floor(cfg.convertEveryMs / 4), 30_000) : cfg.convertEveryMs;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const command = process.argv[2] ?? "start";
  const walletClient = buildWalletClient();

  // Provider URLs can contain API credentials. Log only counts, never endpoint text.
  const endpointLabel = cfg.rpcUrls.length > 0
    ? `${cfg.rpcUrls.length} configured RPC${cfg.rpcUrls.length === 1 ? "" : "s"} (fallback)`
    : "the default RPC";
  const { block } = await connectivity();
  log("info", `connected to chain ${cfg.chainId} via ${endpointLabel} (block ${block})`);
  log(
    "info",
    walletClient
      ? walletClient.openZapsPrivateSubmission.readiness.ready
        ? `executor wallet ${walletClient.account.address} — private submission ready via `
          + `${walletClient.openZapsPrivateSubmission.readiness.distinctOrigins} distinct relay origins`
        : `executor wallet ${walletClient.account.address} — EXECUTION BLOCKED: `
          + walletClient.openZapsPrivateSubmission.readiness.detail
      : "no executor key configured — WATCH-ONLY mode (simulates, never broadcasts)",
  );
  log(
    "info",
    `late-block admission: ${lateBlockClients.length} independent RPC origin(s) configured; `
      + `${cfg.lateBlock.minimumAgreement} required before any wallet write`,
  );
  log("info", `intent store: ${cfg.intentsDir}`);
  log("info", cfg.relayUrl ? `relay: polling ${cfg.relayUrl}/api/intents for shared intents` : "relay: disabled (local file store only)");
  const configuredPots = conversionPots();
  log(
    "info",
    configuredPots.length > 0
      ? `pot-conversion keeper: ${configuredPots.length} pot(s), every ${cfg.convertEveryMs}ms`
      : "pot-conversion keeper: disabled (no pot configured)",
  );
  for (const pot of configuredPots) {
    log(
      "info",
      `pot-conversion/${pot.id}: pot ${pot.lotteryPot}, fee asset ${pot.feeAsset}, price source ${pot.poolPriceSource}`,
    );
  }

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
  state.earnings.runs ??= 0;
  state.earnings.conversions ??= 0;

  if (command === "status") {
    const { ok, bad } = loadIntents(cfg.intentsDir);
    const byKind = (k) => ok.filter((i) => i.kind === k).length;
    log(
      "info",
      `intents: ${ok.length} valid (${byKind("recurring")} recurring, ${byKind("recurring-relative")} recurring-relative, ${byKind("recurring-stack")} recurring-stack, ${byKind("trigger")} trigger), ${bad.length} malformed`,
    );
    log("info", `lifetime: ${state.earnings.runs} runs executed, ${state.earnings.conversions} pot conversions`);
    logPotAccounting(state);
    if (cfg.intakePort > 0) {
      // The browser never receives this local capability. The MCP process reads it from disk.
      loadIntakeToken(cfg.intakeTokenFile);
      log(
        "info",
        `intake: http://127.0.0.1:${cfg.intakePort} — token stored at ${cfg.intakeTokenFile} (not printed)`,
      );
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
      isExecuting: () =>
        walletClient !== null && walletClient.openZapsPrivateSubmission.readiness.ready,
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
