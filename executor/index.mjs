#!/usr/bin/env node
// OpenZaps Zap Executor — watches time and chain, submits owed recurring/trigger executions, and
// earns 80% of the 1% protocol fee (the other 20% funds the 0xZAPS lottery pot).
//
//   node executor/index.mjs start    run the loop (what launchd runs)
//   node executor/index.mjs once     one evaluation pass, then exit
//   node executor/index.mjs status   connectivity + store summary, then exit
//
// Fail-closed: with no OPENZAPS_EXECUTOR_PRIVATE_KEY / OPENZAPS_EXECUTOR_KEYFILE configured this
// process is read-only against the chain (watch-only mode).
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, loadExecutorKey } from "./config.mjs";
import { loadIntents, archiveIntent, readState, writeState } from "./store.mjs";
import { tick, log } from "./engine.mjs";

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

async function runPass(walletClient) {
  const { ok, bad } = loadIntents(cfg.intentsDir);
  for (const b of bad) log("warn", `unparseable intent ${b.file}: ${b.error}`);

  const results = await tick({
    publicClient,
    walletClient,
    cfg,
    intents: ok,
    archive: (item, reason) => archiveIntent(item, cfg.doneDir, reason),
  });

  const state = readState(cfg.stateFile);
  for (const r of results) {
    const level = r.status === "error" || r.outcome === "broadcast-failed" || r.outcome === "tx-reverted" ? "error" : "info";
    log(level, `${r.label}: ${r.status}${r.outcome ? `/${r.outcome}` : ""} — ${r.detail}`);
    if (r.txHash) {
      state.submissions[`${r.label}@${Date.now()}`] = { txHash: r.txHash, detail: r.detail };
    }
  }
  writeState(cfg.stateFile, state);
  return results;
}

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

  if (command === "status") {
    const { ok, bad } = loadIntents(cfg.intentsDir);
    log("info", `intents: ${ok.length} valid (${ok.filter((i) => i.kind === "recurring").length} recurring, ${ok.filter((i) => i.kind === "trigger").length} trigger), ${bad.length} malformed`);
    return;
  }

  if (command === "once") {
    await runPass(walletClient);
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

  log("info", `loop started — evaluating every ${cfg.pollMs}ms`);
  while (!stopping) {
    try {
      await runPass(walletClient);
    } catch (err) {
      log("error", `pass failed: ${err.shortMessage ?? err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollMs));
  }
}

main().catch((err) => {
  log("error", err.stack ?? String(err));
  process.exitCode = 1;
});
