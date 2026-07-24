// OpenZaps executor configuration. Everything here is PUBLIC except the executor key, which is
// only ever read from the environment (or a chmod-600 keyfile referenced by path) and never logged.
// With no key configured the daemon runs WATCH-ONLY: it evaluates schedules and triggers, logs the
// runs it would submit, and broadcasts nothing — fail-closed by default.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

const HOME_DIR = join(homedir(), ".openzaps", "executor");

function readJsonIfPresent(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Malformed config at ${path}: ${err.message}`);
  }
}

export function loadConfig() {
  const fileCfg = readJsonIfPresent(join(HOME_DIR, "config.json"));

  const cfg = {
    rpcUrl: process.env.OPENZAPS_RPC_URL ?? fileCfg.rpcUrl ?? DEFAULT_RPC_URL,
    chainId: Number(process.env.OPENZAPS_CHAIN_ID ?? fileCfg.chainId ?? ROBINHOOD_CHAIN_ID),
    // How often the loop re-evaluates every stored intent, in milliseconds.
    pollMs: Number(process.env.OPENZAPS_POLL_MS ?? fileCfg.pollMs ?? 15_000),
    intentsDir: process.env.OPENZAPS_INTENTS_DIR ?? fileCfg.intentsDir ?? join(HOME_DIR, "intents"),
    doneDir: fileCfg.doneDir ?? join(HOME_DIR, "done"),
    stateFile: fileCfg.stateFile ?? join(HOME_DIR, "state.json"),
    // Optional: the protocol lottery pot. When set AND a key is present, the daemon periodically
    // converts accrued fee assets into 0xZAPS via pot.buyZaps.
    lotteryPot: process.env.OPENZAPS_LOTTERY_POT ?? fileCfg.lotteryPot ?? null,
    // Max gas price the executor will ever pay, in wei (griefing guard for our own key).
    maxFeePerGasWei: BigInt(process.env.OPENZAPS_MAX_FEE_PER_GAS ?? fileCfg.maxFeePerGasWei ?? 2_000_000_000n),
  };

  for (const dir of [HOME_DIR, cfg.intentsDir, cfg.doneDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return cfg;
}

/// The ONLY secret. Absent => watch-only. Never logged, never echoed, never written.
export function loadExecutorKey() {
  const inline = process.env.OPENZAPS_EXECUTOR_PRIVATE_KEY;
  if (inline && /^0x[0-9a-fA-F]{64}$/.test(inline)) return inline;
  const keyFile = process.env.OPENZAPS_EXECUTOR_KEYFILE;
  if (keyFile && existsSync(keyFile)) {
    const raw = readFileSync(keyFile, "utf8").trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw;
    throw new Error(`Keyfile ${keyFile} does not contain a 0x-prefixed 32-byte hex key`);
  }
  return null;
}
