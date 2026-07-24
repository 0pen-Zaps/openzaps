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
// They are separate on purpose: a buyZaps stuck in waitForTransactionReceipt (up to 120s) must
// never delay an owed execution, which is time-critical fee income.
import { createPublicClient, createWalletClient, createNonceManager, defineChain, fallback, http } from "viem";
import { jsonRpc } from "viem/nonce";
import { privateKeyToAccount } from "viem/accounts";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadExecutorKey } from "./config.mjs";
import { loadIntents, archiveIntent, readState, writeState } from "./store.mjs";
import { tick, log } from "./engine.mjs";
import { checkGas, convertPotFees } from "./keeper.mjs";
import { loadIntakeToken, startIntake } from "./intake.mjs";

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
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, "utf8").trim());
    let alive = false;
    try {
      process.kill(pid, 0); // signal 0 only probes existence
      alive = pid !== process.pid;
    } catch {
      alive = false; // ESRCH → stale lock from a crashed run
    }
    if (alive) {
      throw new Error(`another executor is already running (pid ${pid}, lock ${lockFile}). Stop it first.`);
    }
  }
  writeFileSync(lockFile, String(process.pid));
  return () => {
    try {
      if (existsSync(lockFile) && readFileSync(lockFile, "utf8").trim() === String(process.pid)) unlinkSync(lockFile);
    } catch {
      // Best effort.
    }
  };
}

const chain = defineChain({
  id: cfg.chainId,
  name: `chain-${cfg.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
});

// One flaky endpoint must not idle the bundler: with OPENZAPS_RPC_URLS set, every request tries
// the URLs in order (viem ranks/falls back per call). Single-URL mode otherwise.
const transport = cfg.rpcUrls.length > 1 ? fallback(cfg.rpcUrls.map((u) => http(u))) : http(cfg.rpcUrls[0] ?? cfg.rpcUrl);

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

/** One intent pass: evaluate every stored intent, submit owed runs, persist what happened. */
async function runPass(walletClient, state) {
  const { ok, bad } = loadIntents(cfg.intentsDir);
  for (const b of bad) log("warn", `unparseable intent ${b.file}: ${b.error}`);

  const results = await tick({
    publicClient,
    walletClient,
    cfg,
    intents: ok,
    archive: (item, reason) => archiveIntent(item, cfg.doneDir, reason),
  });

  for (const r of results) {
    const level = r.status === "error" || r.outcome === "broadcast-failed" || r.outcome === "tx-reverted" ? "error" : "info";
    log(level, `${r.label}: ${r.status}${r.outcome ? `/${r.outcome}` : ""} — ${r.detail}`);
    if (r.txHash) {
      recordSubmission(state, `${r.label}@${Date.now()}`, { txHash: r.txHash, detail: r.detail });
      if (r.outcome === "executed") state.earnings.runs += 1;
    }
  }
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
  const conv = await convertPotFees({ publicClient, walletClient, cfg });
  if (conv.outcome !== "idle" && conv.outcome !== "disabled") {
    // A reverted conversion is usually benign (another keeper drained the pot first — buyZaps is
    // permissionless and the loser's tx reverts), so it warns rather than alarms.
    const level =
      conv.outcome === "broadcast-failed" ? "error" : conv.outcome === "tx-reverted" ? "warn" : "info";
    const suffix = conv.outcome === "tx-reverted" ? " (possibly another keeper converted first)" : "";
    log(level, `pot-convert: ${conv.outcome} — ${conv.detail}${suffix}`);
  }
  if (conv.txHash) {
    recordSubmission(state, `convert@${Date.now()}`, { txHash: conv.txHash, detail: conv.detail });
    if (conv.outcome === "converted") state.earnings.conversions += 1;
  }
  writeState(cfg.stateFile, state);

  const failed = ["read-failed", "simulation-reverted", "broadcast-failed", "tx-reverted"].includes(conv.outcome);
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
  log(
    "info",
    cfg.lotteryPot
      ? `pot-conversion keeper: pot ${cfg.lotteryPot}, fee asset ${cfg.feeAsset}, every ${cfg.convertEveryMs}ms`
      : "pot-conversion keeper: disabled (no pot configured)",
  );

  const state = readState(cfg.stateFile);
  state.submissions ??= {};
  state.earnings ??= { runs: 0, conversions: 0 };

  if (command === "status") {
    const { ok, bad } = loadIntents(cfg.intentsDir);
    log("info", `intents: ${ok.length} valid (${ok.filter((i) => i.kind === "recurring").length} recurring, ${ok.filter((i) => i.kind === "trigger").length} trigger), ${bad.length} malformed`);
    log("info", `lifetime: ${state.earnings.runs} runs executed, ${state.earnings.conversions} pot conversions`);
    if (cfg.intakePort > 0) {
      // The token is a LOCAL capability (this machine only); status is where the operator
      // retrieves it to paste into the Automate tab's "Send to executor" field.
      log("info", `intake: http://127.0.0.1:${cfg.intakePort} — token: ${loadIntakeToken(cfg.intakeTokenFile)}`);
    }
    if (walletClient) await checkGas({ publicClient, walletClient, cfg, announce: true });
    return;
  }

  if (command !== "once" && command !== "start") {
    console.error(`unknown command: ${command} (use start | once | status)`);
    process.exitCode = 2;
    return;
  }

  // Both broadcasting commands hold the single-instance lock, so a manual `once` cannot
  // double-broadcast alongside a running daemon (and two daemons cannot run at all).
  const release = acquireLock();
  process.on("exit", release);

  if (command === "once") {
    try {
      await runPass(walletClient, state);
      await runMaintenance(walletClient, state);
    } finally {
      release();
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
  release();
}

main().catch((err) => {
  log("error", err.stack ?? String(err));
  process.exitCode = 1;
});
