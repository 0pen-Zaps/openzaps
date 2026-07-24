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
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, loadExecutorKey } from "./config.mjs";
import { loadIntents, archiveIntent, readState, writeState } from "./store.mjs";
import { tick, log } from "./engine.mjs";
import { checkGas, convertPotFees } from "./keeper.mjs";

const MAX_SUBMISSION_RECORDS = 200;

const cfg = loadConfig();

const chain = defineChain({
  id: cfg.chainId,
  name: `chain-${cfg.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
});

const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

function buildWalletClient() {
  const key = loadExecutorKey();
  if (!key) return null;
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
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

  const { block } = await connectivity();
  log("info", `connected to chain ${cfg.chainId} via ${cfg.rpcUrl} (block ${block})`);
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
    if (walletClient) await checkGas({ publicClient, walletClient, cfg, announce: true });
    return;
  }

  if (command === "once") {
    await runPass(walletClient, state);
    await runMaintenance(walletClient, state);
    return;
  }

  if (command !== "start") {
    console.error(`unknown command: ${command} (use start | once | status)`);
    process.exitCode = 2;
    return;
  }

  let stopping = false;
  const stop = (signal) => {
    log("info", `${signal} received — finishing current pass then exiting`);
    stopping = true;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

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
}

main().catch((err) => {
  log("error", err.stack ?? String(err));
  process.exitCode = 1;
});
