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

/**
 * Parse a wei amount that MUST be an integer. `BigInt("1e15")` and `BigInt("0.001")` THROW — and a
 * throw here happens at import time, hard-crashing the daemon into a launchd restart loop over a
 * typo'd env var. Fail soft instead: warn on stderr and keep the safe default.
 */
function safeBigInt(name, value, fallback) {
  if (value === undefined || value === null) return fallback;
  try {
    return BigInt(value);
  } catch {
    console.error(`[config] ${name}=${JSON.stringify(value)} is not an integer wei amount — using default ${fallback}`);
    return fallback;
  }
}

/** Same failure posture for plain numbers: NaN/garbage warns and keeps the default. */
function safeNumber(name, value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.error(`[config] ${name}=${JSON.stringify(value)} is not a number — using default ${fallback}`);
    return fallback;
  }
  return n;
}

export function loadConfig() {
  const fileCfg = readJsonIfPresent(join(HOME_DIR, "config.json"));

  // Comma-separated fallback list; the first entry is the primary. A single flaky endpoint must
  // not idle the bundler, so every URL is tried in order per request (viem fallback transport).
  const rpcUrlsRaw = process.env.OPENZAPS_RPC_URLS ?? fileCfg.rpcUrls;
  const rpcUrls = Array.isArray(rpcUrlsRaw)
    ? rpcUrlsRaw
    : typeof rpcUrlsRaw === "string"
      ? rpcUrlsRaw.split(",").map((u) => u.trim()).filter(Boolean)
      : [];

  const cfg = {
    rpcUrl: process.env.OPENZAPS_RPC_URL ?? fileCfg.rpcUrl ?? DEFAULT_RPC_URL,
    rpcUrls, // empty => single-URL mode on rpcUrl
    chainId: safeNumber("OPENZAPS_CHAIN_ID", process.env.OPENZAPS_CHAIN_ID ?? fileCfg.chainId, ROBINHOOD_CHAIN_ID),
    // How often the loop re-evaluates every stored intent, in milliseconds.
    pollMs: safeNumber("OPENZAPS_POLL_MS", process.env.OPENZAPS_POLL_MS ?? fileCfg.pollMs, 15_000),
    intentsDir: process.env.OPENZAPS_INTENTS_DIR ?? fileCfg.intentsDir ?? join(HOME_DIR, "intents"),
    doneDir: fileCfg.doneDir ?? join(HOME_DIR, "done"),
    stateFile: fileCfg.stateFile ?? join(HOME_DIR, "state.json"),
    // The protocol lottery pot. When set, the daemon periodically converts accrued fee assets into
    // 0xZAPS via the pot's permissionless `buyZaps`, closing the lottery-prize loop.
    lotteryPot: process.env.OPENZAPS_LOTTERY_POT ?? fileCfg.lotteryPot ?? "0xeB7a15CE1c969efBA43ecfc1A63960Ad0042CFe3",
    // The keeper's price feed, used to floor buyZaps output. PAIRED KNOBS: `poolPriceSource` must
    // quote 0xZAPS per one unit of `feeAsset` — reconfigure them TOGETHER or the computed floor is
    // in the wrong units (the pinned pot adapter still fails closed, but conversions stop).
    poolPriceSource:
      process.env.OPENZAPS_POOL_PRICE_SOURCE ?? fileCfg.poolPriceSource ?? "0x60C310586541763D7f4dcc777F495f0627Bb098f",
    // The non-0xZAPS asset the pot accrues on sell runs (aeWETH). The pinned pot adapter converts it.
    feeAsset: process.env.OPENZAPS_FEE_ASSET ?? fileCfg.feeAsset ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    // Don't bother converting dust: minimum fee-asset balance (wei) before a buyZaps is worth the gas.
    convertMinWei: safeBigInt(
      "OPENZAPS_CONVERT_MIN_WEI",
      process.env.OPENZAPS_CONVERT_MIN_WEI ?? fileCfg.convertMinWei,
      1_000_000_000_000_000n, // 0.001 aeWETH
    ),
    // Slippage tolerance on the buyZaps conversion, in bps.
    convertSlippageBps: safeNumber(
      "OPENZAPS_CONVERT_SLIPPAGE_BPS",
      process.env.OPENZAPS_CONVERT_SLIPPAGE_BPS ?? fileCfg.convertSlippageBps,
      300,
    ),
    // Run the conversion keeper at most this often (ms). Independent of the intent poll cadence.
    convertEveryMs: safeNumber("OPENZAPS_CONVERT_EVERY_MS", process.env.OPENZAPS_CONVERT_EVERY_MS ?? fileCfg.convertEveryMs, 300_000),
    // Executor self-monitoring: conservative gas cost per run (wei) and the low-balance warning line.
    gasPerRunWei: safeBigInt(
      "OPENZAPS_GAS_PER_RUN_WEI",
      process.env.OPENZAPS_GAS_PER_RUN_WEI ?? fileCfg.gasPerRunWei,
      300_000_000_000_000n, // ~0.0003 ETH
    ),
    gasWarnRuns: safeNumber("OPENZAPS_GAS_WARN_RUNS", process.env.OPENZAPS_GAS_WARN_RUNS ?? fileCfg.gasWarnRuns, 10),
    // Max gas price the executor will ever pay, in wei (griefing guard for our own key).
    maxFeePerGasWei: safeBigInt("OPENZAPS_MAX_FEE_PER_GAS", process.env.OPENZAPS_MAX_FEE_PER_GAS ?? fileCfg.maxFeePerGasWei, 2_000_000_000n),
    // Intent intake listener (localhost-only HTTP). 0 disables it.
    intakePort: safeNumber("OPENZAPS_INTAKE_PORT", process.env.OPENZAPS_INTAKE_PORT ?? fileCfg.intakePort, 8477),
    intakeTokenFile: fileCfg.intakeTokenFile ?? join(HOME_DIR, "intake.token"),
    // The hosted relay to poll for shared intents. Empty string disables relay polling (local
    // file store only). Defaults to the live site so the daemon discovers intents published there.
    relayUrl: (process.env.OPENZAPS_RELAY_URL ?? fileCfg.relayUrl ?? "https://www.0xzaps.com").replace(/\/$/, ""),
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
