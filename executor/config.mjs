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
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_V3_FACTORY = "0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9";
const DEFAULT_V3_IMPLEMENTATION = "0x0309E72Ffd1c6855FF519d9E923AEFc0C52bFdb5";
const DEFAULT_V3_1_FACTORY = "0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1";
const DEFAULT_V3_1_IMPLEMENTATION = "0x0fE5bC78b2bAc5f09E940C2aCcC0c3B785d91063";

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

function boundedInteger(name, value, fallback, min, max) {
  const parsed = safeNumber(name, value, fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.error(`[config] ${name}=${JSON.stringify(value)} must be an integer from ${min} to ${max} — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * An explicit malformed deployment override must disable that lineage instead
 * of silently falling back to a different contract. Zero is the fail-closed
 * sentinel used for the intentionally undeployed v3.2 lineage too.
 */
function safeAddress(name, value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && ADDRESS.test(value)) return value;
  console.error(`[config] ${name}=${JSON.stringify(value)} is not an EVM address — disabling that capsule lineage`);
  return ZERO_ADDRESS;
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
    // Exact factory + implementation pins used before any untrusted relay item
    // reaches simulation or broadcast. The public app env names are accepted as
    // a fallback so one deployment manifest can configure both processes.
    capsuleLineages: {
      v3: {
        factory: safeAddress(
          "OPENZAPS_V3_FACTORY",
          process.env.OPENZAPS_V3_FACTORY
            ?? process.env.NEXT_PUBLIC_OPENZAP_V3_FACTORY
            ?? fileCfg.capsuleLineages?.v3?.factory,
          DEFAULT_V3_FACTORY,
        ),
        implementation: safeAddress(
          "OPENZAPS_V3_IMPLEMENTATION",
          process.env.OPENZAPS_V3_IMPLEMENTATION
            ?? process.env.NEXT_PUBLIC_OPENZAP_V3_IMPLEMENTATION
            ?? fileCfg.capsuleLineages?.v3?.implementation,
          DEFAULT_V3_IMPLEMENTATION,
        ),
      },
      "v3.1": {
        factory: safeAddress(
          "OPENZAPS_V3_1_FACTORY",
          process.env.OPENZAPS_V3_1_FACTORY
            ?? process.env.NEXT_PUBLIC_OPENZAP_V3_1_FACTORY
            ?? fileCfg.capsuleLineages?.["v3.1"]?.factory,
          DEFAULT_V3_1_FACTORY,
        ),
        implementation: safeAddress(
          "OPENZAPS_V3_1_IMPLEMENTATION",
          process.env.OPENZAPS_V3_1_IMPLEMENTATION
            ?? process.env.NEXT_PUBLIC_OPENZAP_V3_1_IMPLEMENTATION
            ?? fileCfg.capsuleLineages?.["v3.1"]?.implementation,
          DEFAULT_V3_1_IMPLEMENTATION,
        ),
      },
      "v3.2": {
        factory: safeAddress(
          "OPENZAPS_V3_2_FACTORY",
          process.env.OPENZAPS_V3_2_FACTORY
            ?? process.env.NEXT_PUBLIC_OPENZAP_V3_2_FACTORY
            ?? fileCfg.capsuleLineages?.["v3.2"]?.factory,
          ZERO_ADDRESS,
        ),
        implementation: safeAddress(
          "OPENZAPS_V3_2_IMPLEMENTATION",
          process.env.OPENZAPS_V3_2_IMPLEMENTATION
            ?? process.env.NEXT_PUBLIC_OPENZAP_V3_2_IMPLEMENTATION
            ?? fileCfg.capsuleLineages?.["v3.2"]?.implementation,
          ZERO_ADDRESS,
        ),
      },
    },
    // How often the loop re-evaluates every stored intent, in milliseconds.
    pollMs: safeNumber("OPENZAPS_POLL_MS", process.env.OPENZAPS_POLL_MS ?? fileCfg.pollMs, 15_000),
    intentsDir: process.env.OPENZAPS_INTENTS_DIR ?? fileCfg.intentsDir ?? join(HOME_DIR, "intents"),
    doneDir: fileCfg.doneDir ?? join(HOME_DIR, "done"),
    stateFile: fileCfg.stateFile ?? join(HOME_DIR, "state.json"),
    // The protocol lottery pot. When set, the daemon periodically converts accrued fee assets into
    // 0xZAPS via the pot's permissionless `buyZaps`, closing the lottery-prize loop.
    //
    // Defaults to the v3.1 pot, because that is the one the app's recurring flow actually pays into
    // (AutomateConsole creates every recurring capsule against OPENZAP_V3_1_CONTRACTS). The default
    // used to be the v3 pot, which no longer receives anything — so a sell-side run's aeWETH fee
    // would have sat in a pot no keeper was watching, and the prize loop would never have closed.
    lotteryPot: process.env.OPENZAPS_LOTTERY_POT ?? fileCfg.lotteryPot ?? "0x6ec3D07886Ea641e9d10D45A97a72E5f8ec836F1",
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
    // Relay discovery is a durable, bounded sweep. A pass never materializes the full open set;
    // state.json retains the next keyset cursor and the following pass resumes there.
    relayPageSize: boundedInteger(
      "OPENZAPS_RELAY_PAGE_SIZE",
      process.env.OPENZAPS_RELAY_PAGE_SIZE ?? fileCfg.relayPageSize,
      50,
      1,
      100,
    ),
    relayMaxPagesPerPass: boundedInteger(
      "OPENZAPS_RELAY_MAX_PAGES_PER_PASS",
      process.env.OPENZAPS_RELAY_MAX_PAGES_PER_PASS ?? fileCfg.relayMaxPagesPerPass,
      2,
      1,
      8,
    ),
    relayMaxRowsPerPass: boundedInteger(
      "OPENZAPS_RELAY_MAX_ROWS_PER_PASS",
      process.env.OPENZAPS_RELAY_MAX_ROWS_PER_PASS ?? fileCfg.relayMaxRowsPerPass,
      100,
      1,
      500,
    ),
    relayMaxBytesPerPass: boundedInteger(
      "OPENZAPS_RELAY_MAX_BYTES_PER_PASS",
      process.env.OPENZAPS_RELAY_MAX_BYTES_PER_PASS ?? fileCfg.relayMaxBytesPerPass,
      512 * 1024,
      16 * 1024,
      4 * 1024 * 1024,
    ),
    evaluationConcurrency: boundedInteger(
      "OPENZAPS_EVALUATION_CONCURRENCY",
      process.env.OPENZAPS_EVALUATION_CONCURRENCY ?? fileCfg.evaluationConcurrency,
      4,
      1,
      16,
    ),
    // A transaction is not an execution receipt until this many canonical blocks include it.
    confirmations: boundedInteger(
      "OPENZAPS_CONFIRMATIONS",
      process.env.OPENZAPS_CONFIRMATIONS ?? fileCfg.confirmations,
      12,
      1,
      128,
    ),
    receiptTimeoutMs: boundedInteger(
      "OPENZAPS_RECEIPT_TIMEOUT_MS",
      process.env.OPENZAPS_RECEIPT_TIMEOUT_MS ?? fileCfg.receiptTimeoutMs,
      300_000,
      10_000,
      3_600_000,
    ),
    receiptsDir: process.env.OPENZAPS_RECEIPTS_DIR ?? fileCfg.receiptsDir ?? join(HOME_DIR, "receipts"),
    // Notification destinations are secrets/capabilities, so they are accepted from env only and
    // never echoed. Delivery additionally requires NODE_ENV=production and the explicit send flag.
    notificationsEnabled:
      process.env.NODE_ENV === "production" && process.env.OPENZAPS_NOTIFICATIONS_ENABLED === "true",
    notificationWebhookUrl: process.env.OPENZAPS_NOTIFICATION_WEBHOOK_URL ?? "",
    discordWebhookUrl: process.env.OPENZAPS_DISCORD_WEBHOOK_URL ?? "",
    telegramBotToken: process.env.OPENZAPS_TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: process.env.OPENZAPS_TELEGRAM_CHAT_ID ?? "",
    notificationTimeoutMs: boundedInteger(
      "OPENZAPS_NOTIFICATION_TIMEOUT_MS",
      process.env.OPENZAPS_NOTIFICATION_TIMEOUT_MS,
      8_000,
      1_000,
      60_000,
    ),
  };

  for (const dir of [HOME_DIR, cfg.intentsDir, cfg.doneDir, cfg.receiptsDir]) {
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
