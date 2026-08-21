#!/usr/bin/env node
// Campaign 2's deliberately tiny keeper. It can call four exact, permissionless, zero-value
// methods on two runtime-hash-pinned contracts. It cannot approve, transfer, claim for a user,
// pause/unpause, sweep, or target an address supplied by config or the network.
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";

import { readState, writeState } from "./store.mjs";
import {
  CAMPAIGN2_ACTIONS,
  CAMPAIGN2_MANIFEST,
  CAMPAIGN2_PRICE_POLICY,
  assertCampaign2Action,
  campaign2BurnAction,
  campaign2EffectiveBuyInput,
  campaign2PriceX96,
  deriveCampaign2MedianFloor,
  fetchCampaign2KeeperSnapshot,
  fetchCampaign2PoolSqrtPriceAtBlock,
  planCampaign2Maintenance,
  simulateCampaign2Action,
  verifyCampaign2Receipt,
} from "./campaign2-keeper.mjs";

const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const DEFAULT_HOME = join(homedir(), ".openzaps", "campaign2-keeper");
const STATE_VERSION = 1;
const MAX_RECEIPTS = 100;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW_TRANSACTION = /^0x[0-9a-fA-F]{2,}$/;
const execFile = promisify(execFileCallback);
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
export const CAMPAIGN2_BURN_REBROADCAST_TTL_SECONDS = 600n;
export const CAMPAIGN2_HEAD_MAX_AGE_SECONDS = 120n;
export const CAMPAIGN2_HEAD_MAX_FUTURE_SECONDS = 30n;

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}\n`);
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`campaign-2 keeper config at ${path} is not valid JSON`);
  }
}

function strictBoolean(name, value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function boundedInteger(name, value, fallback, minimum, maximum) {
  const resolved = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function strictPositiveBigInt(name, value, fallback) {
  const resolved = value === undefined || value === null || value === "" ? fallback : value;
  let parsed;
  try {
    parsed = BigInt(resolved);
  } catch {
    throw new Error(`${name} must be a positive integer wei amount`);
  }
  if (parsed <= 0n) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function cappedPositiveBigInt(name, value, fallback, maximum) {
  const parsed = strictPositiveBigInt(name, value, fallback);
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return parsed;
}

function credentialFreeRpc(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OPENZAPS_CAMPAIGN2_RPC_URL must be a credential-free HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("OPENZAPS_CAMPAIGN2_RPC_URL must be a credential-free HTTPS origin");
  }
  return parsed.origin;
}

export function loadCampaign2DaemonConfig(env = process.env) {
  if (env.OPENZAPS_CAMPAIGN2_KEEPER_PRIVATE_KEY || env.OPENZAPS_CAMPAIGN2_KEEPER_KEYFILE) {
    throw new Error(
      "raw campaign-2 private keys are refused; use an encrypted keystore and password file",
    );
  }
  const home = env.OPENZAPS_CAMPAIGN2_HOME ?? DEFAULT_HOME;
  if (!isAbsolute(home)) throw new Error("OPENZAPS_CAMPAIGN2_HOME must be an absolute path");
  const file = readJsonIfPresent(join(home, "config.json"));
  const enabled = strictBoolean(
    "OPENZAPS_CAMPAIGN2_ENABLED",
    env.OPENZAPS_CAMPAIGN2_ENABLED ?? file.enabled,
    false,
  );
  if (enabled && home !== DEFAULT_HOME) {
    throw new Error(`live campaign-2 state is pinned to ${DEFAULT_HOME}`);
  }
  const rpcUrl = credentialFreeRpc(env.OPENZAPS_CAMPAIGN2_RPC_URL ?? file.rpcUrl ?? DEFAULT_RPC_URL);
  const cadenceSeconds = boundedInteger(
    "OPENZAPS_CAMPAIGN2_CADENCE_SECONDS",
    env.OPENZAPS_CAMPAIGN2_CADENCE_SECONDS ?? file.cadenceSeconds,
    86_400,
    86_400,
    172_800,
  );
  const pollMs = boundedInteger(
    "OPENZAPS_CAMPAIGN2_POLL_MS",
    env.OPENZAPS_CAMPAIGN2_POLL_MS ?? file.pollMs,
    300_000,
    30_000,
    3_600_000,
  );
  const confirmations = boundedInteger(
    "OPENZAPS_CAMPAIGN2_CONFIRMATIONS",
    env.OPENZAPS_CAMPAIGN2_CONFIRMATIONS ?? file.confirmations,
    12,
    12,
    128,
  );
  const maxBroadcastsPerDay = boundedInteger(
    "OPENZAPS_CAMPAIGN2_MAX_TX_PER_DAY",
    env.OPENZAPS_CAMPAIGN2_MAX_TX_PER_DAY ?? file.maxBroadcastsPerDay,
    4,
    1,
    4,
  );
  const maxFeePerGasWei = cappedPositiveBigInt(
    "OPENZAPS_CAMPAIGN2_MAX_FEE_PER_GAS_WEI",
    env.OPENZAPS_CAMPAIGN2_MAX_FEE_PER_GAS_WEI ?? file.maxFeePerGasWei,
    100_000_000n,
    100_000_000n,
  );
  const autoFinalize = strictBoolean(
    "OPENZAPS_CAMPAIGN2_AUTO_FINALIZE",
    env.OPENZAPS_CAMPAIGN2_AUTO_FINALIZE ?? file.autoFinalize,
    true,
  );
  const automateBurns = strictBoolean(
    "OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS",
    env.OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS ?? file.automateBurns,
    false,
  );
  const gasWarnBalanceWei = strictPositiveBigInt(
    "OPENZAPS_CAMPAIGN2_GAS_WARN_BALANCE_WEI",
    env.OPENZAPS_CAMPAIGN2_GAS_WARN_BALANCE_WEI ?? file.gasWarnBalanceWei,
    300_000_000_000_000n,
  );
  const keystoreFile = env.OPENZAPS_CAMPAIGN2_KEYSTORE_FILE ?? null;
  const passwordFile = env.OPENZAPS_CAMPAIGN2_PASSWORD_FILE ?? null;
  const castBin = env.OPENZAPS_CAMPAIGN2_CAST_BIN ?? null;
  const approvedCommit = env.OPENZAPS_CAMPAIGN2_APPROVED_COMMIT ?? null;
  const bundleSha256 = env.OPENZAPS_CAMPAIGN2_BUNDLE_SHA256 ?? null;
  const chunkSha256 = env.OPENZAPS_CAMPAIGN2_CHUNK_SHA256 ?? null;
  const nodeSha256 = env.OPENZAPS_CAMPAIGN2_NODE_SHA256 ?? null;
  const castSha256 = env.OPENZAPS_CAMPAIGN2_CAST_SHA256 ?? null;
  const archiveRpcFile = env.OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE
    || file.archiveRpcFile
    || null;
  for (const [name, value] of [
    ["OPENZAPS_CAMPAIGN2_KEYSTORE_FILE", keystoreFile],
    ["OPENZAPS_CAMPAIGN2_PASSWORD_FILE", passwordFile],
    ["OPENZAPS_CAMPAIGN2_CAST_BIN", castBin],
    ["OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE", archiveRpcFile],
  ]) {
    if (value && !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  const credentialCount = Number(Boolean(keystoreFile)) + Number(Boolean(passwordFile));
  if (credentialCount === 1) {
    throw new Error(
      "OPENZAPS_CAMPAIGN2_KEYSTORE_FILE and OPENZAPS_CAMPAIGN2_PASSWORD_FILE must be configured together",
    );
  }
  if (enabled && (!keystoreFile || !passwordFile || !castBin)) {
    throw new Error("live campaign-2 activation requires the complete encrypted signer configuration");
  }
  if (automateBurns && !archiveRpcFile) {
    throw new Error(
      "automated campaign-2 burns require an owner-only archive RPC file for historical price verification",
    );
  }
  const releasePins = [approvedCommit, bundleSha256, chunkSha256, nodeSha256];
  const releasePinCount = releasePins.filter(Boolean).length;
  if (releasePinCount !== 0 && releasePinCount !== releasePins.length) {
    throw new Error("campaign-2 release commit, bundle, chunk, and Node hashes must be configured together");
  }
  if (
    (approvedCommit && !GIT_COMMIT.test(approvedCommit))
    || [bundleSha256, chunkSha256, nodeSha256, castSha256].some(
      (value) => value && !SHA256.test(value),
    )
  ) {
    throw new Error("campaign-2 release pins must be lowercase SHA-256 hashes and a 40-character commit");
  }
  if (enabled && (releasePinCount !== releasePins.length || !castSha256)) {
    throw new Error("live campaign-2 activation requires immutable bundle, runtime, and Cast pins");
  }
  return {
    enabled,
    home,
    rpcUrl,
    cadenceSeconds: BigInt(cadenceSeconds),
    pollMs,
    confirmations,
    maxBroadcastsPerDay,
    maxFeePerGasWei,
    autoFinalize,
    automateBurns,
    gasWarnBalanceWei,
    keystoreFile,
    passwordFile,
    castBin,
    approvedCommit,
    bundleSha256,
    chunkSha256,
    nodeSha256,
    castSha256,
    archiveRpcFile,
    stateFile: join(home, "state.json"),
    lockFile: join(home, "campaign2-keeper.lock"),
  };
}

function requireProtectedRegularFile(
  path,
  label,
  { executable = false, privateFile = true } = {},
) {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (privateFile && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or others`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the daemon user`);
  }
  if (executable && (stat.mode & 0o100) === 0) throw new Error(`${label} is not owner-executable`);
}

function loadKeeperSigner(cfg) {
  if (!cfg.enabled || !cfg.keystoreFile || !cfg.passwordFile || !cfg.castBin) return null;
  requireProtectedRegularFile(cfg.keystoreFile, "campaign-2 encrypted keystore");
  requireProtectedRegularFile(cfg.passwordFile, "campaign-2 password file");
  requireProtectedRegularFile(cfg.castBin, "campaign-2 Cast binary", {
    executable: true,
    privateFile: false,
  });
  return {
    address: CAMPAIGN2_MANIFEST.keeper,
    keystoreFile: cfg.keystoreFile,
    passwordFile: cfg.passwordFile,
    castBin: cfg.castBin,
  };
}

function loadArchiveRpcUrl(cfg) {
  if (!cfg.archiveRpcFile) return null;
  requireProtectedRegularFile(cfg.archiveRpcFile, "campaign-2 archive RPC file");
  const raw = readFileSync(cfg.archiveRpcFile, "utf8");
  if (raw.length === 0 || raw.length > 4_096 || raw !== raw.trim() || /[\r\n]/u.test(raw)) {
    throw new Error("campaign-2 archive RPC file must contain one HTTPS URL without surrounding whitespace");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("campaign-2 archive RPC file does not contain a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("campaign-2 archive RPC must use HTTPS without URL userinfo or a fragment");
  }
  return parsed.href;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyRuntimeArtifacts(cfg) {
  if (!cfg.bundleSha256) return;
  const entryPath = process.argv[1];
  if (!entryPath || !isAbsolute(entryPath)) {
    throw new Error("campaign-2 bundled entry path is not absolute");
  }
  const resolvedEntry = entryPath;
  const chunkPath = join(dirname(resolvedEntry), "254.index.mjs");
  const checks = [
    [resolvedEntry, cfg.bundleSha256, "campaign-2 release bundle"],
    [chunkPath, cfg.chunkSha256, "campaign-2 release chunk"],
    [process.execPath, cfg.nodeSha256, "campaign-2 Node runtime"],
  ];
  if (cfg.enabled) checks.push([cfg.castBin, cfg.castSha256, "campaign-2 Cast runtime"]);
  for (const [path, expected, label] of checks) {
    const actual = sha256File(path);
    if (actual !== expected) throw new Error(`${label} hash mismatch`);
  }
}

export function normalizeState(state) {
  state.version ??= STATE_VERSION;
  if (state.version !== STATE_VERSION) throw new Error("unsupported campaign-2 keeper state version");
  state.identity ??= {
    chainId: CAMPAIGN2_MANIFEST.chainId,
    campaign: CAMPAIGN2_MANIFEST.campaign.address,
    hookBlocks: CAMPAIGN2_MANIFEST.hookBlocks.address,
    keeper: CAMPAIGN2_MANIFEST.keeper,
  };
  state.identity.keeper ??= CAMPAIGN2_MANIFEST.keeper;
  if (
    state.identity.chainId !== CAMPAIGN2_MANIFEST.chainId
    || state.identity.campaign?.toLowerCase() !== CAMPAIGN2_MANIFEST.campaign.address.toLowerCase()
    || state.identity.hookBlocks?.toLowerCase() !== CAMPAIGN2_MANIFEST.hookBlocks.address.toLowerCase()
    || state.identity.keeper?.toLowerCase() !== CAMPAIGN2_MANIFEST.keeper.toLowerCase()
  ) {
    throw new Error("campaign-2 keeper state belongs to a different chain or deployment");
  }
  state.lastHarvestWindow ??= "0";
  if (!/^-?[0-9]+$/.test(String(state.lastHarvestWindow))) {
    throw new Error("campaign-2 keeper lastHarvestWindow is malformed");
  }
  state.pending ??= null;
  state.receipts ??= [];
  if (!Array.isArray(state.receipts)) throw new Error("campaign-2 keeper receipts must be an array");
  state.priceObservations ??= [];
  if (!Array.isArray(state.priceObservations) || state.priceObservations.length > 100) {
    throw new Error("campaign-2 keeper price observations are malformed or unbounded");
  }
  const seenBuckets = new Set();
  const seenBlockNumbers = new Set();
  const seenBlockHashes = new Set();
  let previousObservation = null;
  for (const observation of state.priceObservations) {
    if (
      !/^[0-9]+$/.test(String(observation?.blockNumber))
      || !TX_HASH.test(observation?.blockHash)
      || !/^[0-9]+$/.test(String(observation?.blockTimestamp))
      || !/^[1-9][0-9]*$/.test(String(observation?.sqrtPriceX96))
      || !/^[0-9]+$/.test(String(observation?.bucket))
      || !/^[1-9][0-9]*$/.test(String(observation?.priceX96))
      || BigInt(observation.priceX96)
        !== campaign2PriceX96(BigInt(observation.sqrtPriceX96))
    ) {
      throw new Error("campaign-2 keeper contains a malformed pool-price observation");
    }
    const bucket = BigInt(observation.bucket);
    const blockNumber = BigInt(observation.blockNumber);
    const blockTimestamp = BigInt(observation.blockTimestamp);
    const normalizedHash = observation.blockHash.toLowerCase();
    if (
      bucket !== blockTimestamp / CAMPAIGN2_PRICE_POLICY.sampleBucketSeconds
      || seenBuckets.has(bucket.toString())
      || seenBlockNumbers.has(blockNumber.toString())
      || seenBlockHashes.has(normalizedHash)
      || (previousObservation && (
        bucket <= previousObservation.bucket
        || blockNumber <= previousObservation.blockNumber
        || blockTimestamp <= previousObservation.blockTimestamp
      ))
    ) {
      throw new Error("campaign-2 keeper pool-price observations must be unique and monotonic");
    }
    seenBuckets.add(bucket.toString());
    seenBlockNumbers.add(blockNumber.toString());
    seenBlockHashes.add(normalizedHash);
    previousObservation = { bucket, blockNumber, blockTimestamp };
  }
  state.daily ??= { day: null, broadcasts: 0 };
  if (
    !state.daily
    || typeof state.daily !== "object"
    || (state.daily.day !== null && !/^[0-9]+$/.test(String(state.daily.day)))
    || !Number.isSafeInteger(state.daily.broadcasts)
    || state.daily.broadcasts < 0
    || state.daily.broadcasts > 4
  ) {
    throw new Error("campaign-2 keeper daily broadcast state is malformed");
  }
  return state;
}

function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      fd = undefined;
      break;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (error?.code !== "EEXIST") throw error;
      const recorded = readFileSync(path, "utf8").trim();
      if (!/^[1-9][0-9]*$/.test(recorded)) {
        throw new Error(`campaign-2 keeper lock ${path} has a malformed owner PID`);
      }
      const ownerPid = Number(recorded);
      let ownerAlive = true;
      try {
        process.kill(ownerPid, 0);
      } catch (probeError) {
        if (probeError?.code === "ESRCH") ownerAlive = false;
      }
      if (ownerAlive) throw new Error(`campaign-2 keeper already holds ${path} as PID ${ownerPid}`);
      if (attempt !== 0) throw new Error(`campaign-2 keeper could not reclaim stale lock ${path}`);
      // Recheck the recorded PID before unlinking so a concurrent successful claimant is retained.
      if (existsSync(path) && readFileSync(path, "utf8").trim() === recorded) unlinkSync(path);
    }
  }
  if (!existsSync(path) || readFileSync(path, "utf8").trim() !== String(process.pid)) {
    throw new Error(`campaign-2 keeper failed to establish ${path}`);
  }
  return () => {
    try {
      if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
        unlinkSync(path);
      }
    } catch {
      // Best-effort release; a stale lock fails the next start closed for operator inspection.
    }
  };
}

function currentUtcDay(blockTimestamp) {
  return (blockTimestamp / 86_400n).toString();
}

function admitDailyBudget(state, blockTimestamp, maximum) {
  const day = currentUtcDay(blockTimestamp);
  if (state.daily.day !== day) state.daily = { day, broadcasts: 0 };
  if (state.daily.broadcasts >= maximum) {
    return { allowed: false, reason: `${maximum}-transaction UTC-day budget is exhausted` };
  }
  return { allowed: true, day };
}

export function recordPriceObservation(state, snapshot) {
  const cutoff = snapshot.blockTimestamp > CAMPAIGN2_PRICE_POLICY.maximumAgeSeconds
    ? snapshot.blockTimestamp - CAMPAIGN2_PRICE_POLICY.maximumAgeSeconds
    : 0n;
  let observations = state.priceObservations
    .filter((entry) => BigInt(entry.blockTimestamp) >= cutoff)
    .sort((left, right) => Number(BigInt(left.blockTimestamp) - BigInt(right.blockTimestamp)));
  const last = observations.at(-1);
  const bucket = snapshot.blockTimestamp / CAMPAIGN2_PRICE_POLICY.sampleBucketSeconds;
  const sufficientlyNew = !last
    || (
      snapshot.blockTimestamp > BigInt(last.blockTimestamp)
      && BigInt(last.bucket) !== bucket
    );
  if (sufficientlyNew) {
    observations.push({
      bucket: bucket.toString(),
      blockNumber: snapshot.blockNumber.toString(),
      blockHash: snapshot.blockHash,
      blockTimestamp: snapshot.blockTimestamp.toString(),
      sqrtPriceX96: snapshot.sqrtPriceX96.toString(),
      priceX96: campaign2PriceX96(snapshot.sqrtPriceX96).toString(),
    });
  }
  observations = observations.slice(-32);
  const changed = JSON.stringify(observations) !== JSON.stringify(state.priceObservations);
  state.priceObservations = observations;
  return changed;
}

function priceObservationsForFloor(state) {
  return state.priceObservations.map((entry) => ({
    bucket: BigInt(entry.bucket),
    blockNumber: BigInt(entry.blockNumber),
    blockHash: entry.blockHash,
    blockTimestamp: BigInt(entry.blockTimestamp),
    sqrtPriceX96: BigInt(entry.sqrtPriceX96),
  }));
}

export async function verifyCampaign2PriceObservationJournal(
  publicClient,
  archiveClient,
  state,
  nowSec,
) {
  if (!archiveClient) {
    return {
      valid: false,
      changed: false,
      reason: "an owner-only archive RPC is not configured",
    };
  }
  const observations = priceObservationsForFloor(state);
  const cutoff = nowSec > CAMPAIGN2_PRICE_POLICY.maximumAgeSeconds
    ? nowSec - CAMPAIGN2_PRICE_POLICY.maximumAgeSeconds
    : 0n;
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    if (observation.blockTimestamp < cutoff) continue;
    let block;
    let archiveBlock;
    let archivedSqrtPriceX96;
    try {
      [block, archiveBlock, archivedSqrtPriceX96] = await Promise.all([
        publicClient.getBlock({ blockNumber: observation.blockNumber }),
        archiveClient.getBlock({ blockNumber: observation.blockNumber }),
        fetchCampaign2PoolSqrtPriceAtBlock(archiveClient, observation.blockNumber),
      ]);
    } catch {
      return {
        valid: false,
        changed: false,
        reason: "canonical header or archived pool state is unavailable",
      };
    }
    if (
      block.hash?.toLowerCase() !== observation.blockHash.toLowerCase()
      || block.timestamp !== observation.blockTimestamp
      || archiveBlock.hash?.toLowerCase() !== observation.blockHash.toLowerCase()
      || archiveBlock.timestamp !== observation.blockTimestamp
    ) {
      state.priceObservations = state.priceObservations.slice(0, index);
      return {
        valid: false,
        changed: true,
        reason: `pool-price sample at block ${observation.blockNumber} was reorged`,
      };
    }
    if (archivedSqrtPriceX96 !== observation.sqrtPriceX96) {
      return {
        valid: false,
        changed: false,
        reason: `archived slot0 does not match the journal at block ${observation.blockNumber}`,
      };
    }
  }
  return { valid: true, changed: false };
}

function requiredPostcondition(actionId, before, after) {
  if (actionId === "campaign-finalize" && !after.campaign.finalized) {
    throw new Error("campaign finalize receipt settled but finalized() is still false");
  }
  if (actionId === "hook-blocks-finalize" && !after.hookBlocks.finalized) {
    throw new Error("HookBlocks finalize receipt settled but finalized() is still false");
  }
  if (actionId === "hookr-buy-and-burn") {
    if (after.hookBlocks.blockCount <= BigInt(before.hookBlockCount)) {
      throw new Error("buy-and-burn receipt settled without advancing the Hook Blocks ledger");
    }
    if (after.hookBlocks.totalHookrBurned <= BigInt(before.totalHookrBurned)) {
      throw new Error("buy-and-burn receipt settled without increasing totalHookrBurned");
    }
  }
}

export function buildCampaign2CastMktxArgs({
  action,
  cfg,
  nonce,
  priorityFee,
}) {
  assertCampaign2Action(action);
  return [
    "mktx",
    "--chain",
    String(CAMPAIGN2_MANIFEST.chainId),
    "--nonce",
    String(nonce),
    "--gas-limit",
    String(action.gas),
    "--gas-price",
    String(cfg.maxFeePerGasWei),
    "--priority-gas-price",
    String(priorityFee),
    "--keystore",
    cfg.keystoreFile,
    "--password-file",
    cfg.passwordFile,
    action.target,
    action.functionSignature,
    ...action.args.map(String),
  ];
}

export async function verifyCampaign2SignedTransaction({
  serializedTransaction,
  action,
  expectedSigner = CAMPAIGN2_MANIFEST.keeper,
  nonce,
  maxFeePerGasWei,
  priorityFeeWei,
}) {
  if (!RAW_TRANSACTION.test(serializedTransaction)) {
    throw new Error("Cast did not return one raw signed campaign-2 transaction");
  }
  const parsed = parseTransaction(serializedTransaction);
  const signer = await recoverTransactionAddress({ serializedTransaction });
  const expectedData = encodeFunctionData({
    abi: action.abi,
    functionName: action.functionName,
    args: action.args,
  });
  if (signer.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new Error(`signed campaign-2 transaction recovered unexpected signer ${signer}`);
  }
  if (parsed.type !== "eip1559") {
    throw new Error("signed campaign-2 transaction must be plain EIP-1559");
  }
  if (
    (parsed.authorizationList?.length ?? 0) !== 0
    || (parsed.blobVersionedHashes?.length ?? 0) !== 0
    || parsed.maxFeePerBlobGas !== undefined
  ) {
    throw new Error("signed campaign-2 transaction carries forbidden delegation or blob fields");
  }
  if (BigInt(parsed.chainId ?? 0) !== BigInt(CAMPAIGN2_MANIFEST.chainId)) {
    throw new Error("signed campaign-2 transaction has the wrong chain ID");
  }
  if (parsed.to?.toLowerCase() !== action.target.toLowerCase()) {
    throw new Error("signed campaign-2 transaction has the wrong target");
  }
  if ((parsed.data ?? "0x").toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error("signed campaign-2 transaction has the wrong calldata");
  }
  if (BigInt(parsed.value ?? 0n) !== 0n) {
    throw new Error("signed campaign-2 transaction unexpectedly transfers native value");
  }
  if (BigInt(parsed.nonce) !== BigInt(nonce)) {
    throw new Error("signed campaign-2 transaction has the wrong nonce");
  }
  if (BigInt(parsed.gas) !== action.gas) {
    throw new Error("signed campaign-2 transaction has the wrong gas limit");
  }
  if (BigInt(parsed.maxFeePerGas ?? 0n) !== maxFeePerGasWei) {
    throw new Error("signed campaign-2 transaction has the wrong max fee");
  }
  if (BigInt(parsed.maxPriorityFeePerGas ?? 0n) !== priorityFeeWei) {
    throw new Error("signed campaign-2 transaction has the wrong priority fee");
  }
  return {
    signer,
    txHash: keccak256(serializedTransaction),
  };
}

async function signCampaign2Action({ action, cfg, nonce, priorityFee }) {
  if (!cfg.castSha256 || sha256File(cfg.castBin) !== cfg.castSha256) {
    throw new Error("campaign-2 Cast runtime hash changed before signing");
  }
  const args = buildCampaign2CastMktxArgs({ action, cfg, nonce, priorityFee });
  let stdout;
  try {
    ({ stdout } = await execFile(cfg.castBin, args, {
      encoding: "utf8",
      maxBuffer: 1_048_576,
      timeout: 30_000,
    }));
  } catch (error) {
    throw new Error(`Cast could not sign ${action.id}`, { cause: error });
  }
  const serializedTransaction = stdout.trim();
  const verified = await verifyCampaign2SignedTransaction({
    serializedTransaction,
    action,
    expectedSigner: CAMPAIGN2_MANIFEST.keeper,
    nonce,
    maxFeePerGasWei: cfg.maxFeePerGasWei,
    priorityFeeWei: priorityFee,
  });
  return { serializedTransaction, ...verified };
}

export function actionFromPending(pending) {
  const base = CAMPAIGN2_ACTIONS[pending?.actionId];
  if (!base) throw new Error("campaign-2 pending action is unknown");
  const args = pending.actionArgs;
  if (!Array.isArray(args) || args.some((value) => !/^[0-9]+$/.test(String(value)))) {
    throw new Error("campaign-2 pending action arguments are malformed");
  }
  if (base.id === "hookr-buy-and-burn") {
    if (args.length !== 1) throw new Error("campaign-2 pending burn floor is missing");
    const evidence = pending.floorEvidence;
    if (
      evidence?.source !== "hookr-v4-full-batch-archive-median-v3"
      || evidence.minHookrOut !== args[0]
      || evidence.minOutBps !== CAMPAIGN2_MANIFEST.minOutBps.toString()
      || !TX_HASH.test(evidence.decisionBlockHash)
      || !/^[0-9]+$/.test(String(evidence.decisionBlockNumber))
      || !/^[0-9]+$/.test(String(evidence.decisionBlockTimestamp))
      || !/^[0-9]+$/.test(String(evidence.effectiveEthInWei))
      || !/^[1-9][0-9]*$/.test(String(evidence.medianPriceX96))
      || !Number.isSafeInteger(evidence.sampleCount)
      || evidence.sampleCount < CAMPAIGN2_PRICE_POLICY.minimumSamples
      || !/^[0-9]+$/.test(String(evidence.sampleSpanSeconds))
      || !/^[0-9]+$/.test(String(evidence.firstBlockNumber))
      || !/^[0-9]+$/.test(String(evidence.lastBlockNumber))
      || !Array.isArray(evidence.samples)
      || !/^[0-9]+$/.test(String(pending.signedAtBlockNumber))
      || !TX_HASH.test(pending.signedAtBlockHash)
      || !/^[0-9]+$/.test(String(pending.signedAtBlockTimestamp))
    ) {
      throw new Error("campaign-2 pending burn floor evidence is malformed");
    }
    const effectiveEthIn = BigInt(evidence.effectiveEthInWei);
    if (
      effectiveEthIn !== CAMPAIGN2_MANIFEST.maxBuyWei
    ) {
      throw new Error("campaign-2 pending burn input evidence is outside immutable bounds");
    }
    const samples = evidence.samples.map((sample) => {
      if (
        !/^[0-9]+$/.test(String(sample?.bucket))
        || !/^[0-9]+$/.test(String(sample?.blockNumber))
        || !TX_HASH.test(sample?.blockHash)
        || !/^[0-9]+$/.test(String(sample?.blockTimestamp))
        || !/^[1-9][0-9]*$/.test(String(sample?.sqrtPriceX96))
      ) {
        throw new Error("campaign-2 pending burn sample evidence is malformed");
      }
      return {
        bucket: BigInt(sample.bucket),
        blockNumber: BigInt(sample.blockNumber),
        blockHash: sample.blockHash,
        blockTimestamp: BigInt(sample.blockTimestamp),
        sqrtPriceX96: BigInt(sample.sqrtPriceX96),
      };
    });
    if (
      samples.length !== evidence.sampleCount
      || samples.length === 0
      || samples.at(-1).blockNumber >= BigInt(evidence.decisionBlockNumber)
      || samples.at(-1).blockTimestamp >= BigInt(evidence.decisionBlockTimestamp)
    ) {
      throw new Error("campaign-2 pending burn sample bounds are malformed");
    }
    const derived = deriveCampaign2MedianFloor({
      observations: samples,
      nowSec: BigInt(evidence.decisionBlockTimestamp),
      ethIn: effectiveEthIn,
    });
    if (
      !derived.ready
      || derived.minHookrOut.toString() !== args[0]
      || derived.medianPriceX96.toString() !== evidence.medianPriceX96
      || derived.sampleCount !== evidence.sampleCount
      || derived.sampleSpanSeconds.toString() !== evidence.sampleSpanSeconds
      || derived.firstBlockNumber.toString() !== evidence.firstBlockNumber
      || derived.lastBlockNumber.toString() !== evidence.lastBlockNumber
    ) {
      throw new Error("campaign-2 pending burn floor does not reproduce from its evidence");
    }
    return campaign2BurnAction(derived.minHookrOut);
  }
  if (args.length !== 0) throw new Error("campaign-2 pending zero-argument action was widened");
  return base;
}

export function campaign2BurnRebroadcastFreshness(
  pending,
  signedBlock,
  latestBlock,
  ttlSeconds = CAMPAIGN2_BURN_REBROADCAST_TTL_SECONDS,
  wallClockSeconds = BigInt(Math.floor(Date.now() / 1_000)),
) {
  if (pending.actionId !== "hookr-buy-and-burn") return { allowed: true, ageSeconds: 0n };
  const signedBlockNumber = BigInt(pending.signedAtBlockNumber);
  const signedBlockTimestamp = BigInt(pending.signedAtBlockTimestamp);
  if (
    signedBlock.number !== signedBlockNumber
    || signedBlock.hash?.toLowerCase() !== pending.signedAtBlockHash.toLowerCase()
    || signedBlock.timestamp !== signedBlockTimestamp
  ) {
    return { allowed: false, reason: "the burn signing block is no longer canonical" };
  }
  if (
    typeof latestBlock.number !== "bigint"
    || !latestBlock.hash
    || latestBlock.timestamp < signedBlockTimestamp
  ) {
    return { allowed: false, reason: "the canonical burn retry clock is unavailable" };
  }
  if (
    latestBlock.timestamp > wallClockSeconds + CAMPAIGN2_HEAD_MAX_FUTURE_SECONDS
    || wallClockSeconds > latestBlock.timestamp + CAMPAIGN2_HEAD_MAX_AGE_SECONDS
  ) {
    return { allowed: false, reason: "the canonical burn retry head is outside the wall-clock bound" };
  }
  const ageSeconds = latestBlock.timestamp - signedBlockTimestamp;
  if (ageSeconds > ttlSeconds) {
    return {
      allowed: false,
      ageSeconds,
      reason: `the signed burn is ${ageSeconds}s old; manual nonce replacement is required`,
    };
  }
  return { allowed: true, ageSeconds };
}

async function requireFreshBurnRebroadcast(publicClient, archiveClient, pending) {
  if (pending.actionId !== "hookr-buy-and-burn") return;
  let publicSignedBlock;
  let archiveSignedBlock;
  let publicLatest;
  let archiveLatest;
  let publicCanonicalLatest;
  let archiveCanonicalLatest;
  let publicSharedBlock;
  let archiveSharedBlock;
  try {
    [publicSignedBlock, archiveSignedBlock, publicLatest, archiveLatest] = await Promise.all([
      publicClient.getBlock({ blockNumber: BigInt(pending.signedAtBlockNumber) }),
      archiveClient.getBlock({ blockNumber: BigInt(pending.signedAtBlockNumber) }),
      publicClient.getBlock({ blockTag: "latest" }),
      archiveClient.getBlock({ blockTag: "latest" }),
    ]);
    if (typeof publicLatest.number !== "bigint" || typeof archiveLatest.number !== "bigint") {
      throw new Error("latest block numbers are unavailable");
    }
    const sharedBlockNumber = publicLatest.number < archiveLatest.number
      ? publicLatest.number
      : archiveLatest.number;
    [
      publicCanonicalLatest,
      archiveCanonicalLatest,
      publicSharedBlock,
      archiveSharedBlock,
    ] = await Promise.all([
      publicClient.getBlock({ blockNumber: publicLatest.number }),
      archiveClient.getBlock({ blockNumber: archiveLatest.number }),
      publicClient.getBlock({ blockNumber: sharedBlockNumber }),
      archiveClient.getBlock({ blockNumber: sharedBlockNumber }),
    ]);
  } catch {
    throw new Error("campaign-2 providers could not establish a canonical burn retry clock");
  }
  if (
    publicCanonicalLatest.hash?.toLowerCase() !== publicLatest.hash?.toLowerCase()
    || archiveCanonicalLatest.hash?.toLowerCase() !== archiveLatest.hash?.toLowerCase()
    || publicSharedBlock.hash?.toLowerCase() !== archiveSharedBlock.hash?.toLowerCase()
    || publicSignedBlock.hash?.toLowerCase() !== archiveSignedBlock.hash?.toLowerCase()
    || publicSignedBlock.timestamp !== archiveSignedBlock.timestamp
  ) {
    throw new Error("campaign-2 providers disagree on the canonical burn retry clock");
  }
  const wallClockSeconds = BigInt(Math.floor(Date.now() / 1_000));
  for (const providerHead of [publicCanonicalLatest, archiveCanonicalLatest]) {
    const headFreshness = campaign2BurnRebroadcastFreshness(
      pending,
      publicSignedBlock,
      providerHead,
      CAMPAIGN2_BURN_REBROADCAST_TTL_SECONDS,
      wallClockSeconds,
    );
    if (!headFreshness.allowed) {
      throw new Error(`campaign-2 burn rebroadcast refused: ${headFreshness.reason}`);
    }
  }
}

async function verifyPendingFloorEvidence(publicClient, archiveClient, pending) {
  if (pending.actionId !== "hookr-buy-and-burn") return;
  if (!archiveClient) {
    throw new Error("campaign-2 pending burn requires its owner-only archive RPC for verification");
  }
  const evidence = pending.floorEvidence;
  const decisionHeader = {
    blockNumber: evidence.decisionBlockNumber,
    blockHash: evidence.decisionBlockHash,
    blockTimestamp: evidence.decisionBlockTimestamp,
  };
  const decisionBlock = await publicClient.getBlock({
    blockNumber: BigInt(decisionHeader.blockNumber),
  });
  if (
    decisionBlock.hash?.toLowerCase() !== decisionHeader.blockHash.toLowerCase()
    || decisionBlock.timestamp !== BigInt(decisionHeader.blockTimestamp)
  ) {
    throw new Error(`campaign-2 burn floor evidence reorged at block ${decisionHeader.blockNumber}`);
  }
  for (const sample of evidence.samples) {
    const blockNumber = BigInt(sample.blockNumber);
    let block;
    let archiveBlock;
    let archivedSqrtPriceX96;
    try {
      [block, archiveBlock, archivedSqrtPriceX96] = await Promise.all([
        publicClient.getBlock({ blockNumber }),
        archiveClient.getBlock({ blockNumber }),
        fetchCampaign2PoolSqrtPriceAtBlock(archiveClient, blockNumber),
      ]);
    } catch {
      // Do not attach the provider error: credentialed archive URLs may be
      // embedded in transport diagnostics and must never enter daemon logs.
      throw new Error("campaign-2 archive RPC could not verify pending burn evidence");
    }
    if (
      block.hash?.toLowerCase() !== sample.blockHash.toLowerCase()
      || block.timestamp !== BigInt(sample.blockTimestamp)
      || archiveBlock.hash?.toLowerCase() !== sample.blockHash.toLowerCase()
      || archiveBlock.timestamp !== BigInt(sample.blockTimestamp)
    ) {
      throw new Error(`campaign-2 burn floor evidence reorged at block ${sample.blockNumber}`);
    }
    if (archivedSqrtPriceX96 !== BigInt(sample.sqrtPriceX96)) {
      throw new Error(`campaign-2 archived burn price differs at block ${sample.blockNumber}`);
    }
  }
}

async function verifyPendingJournal(publicClient, archiveClient, pending) {
  const action = actionFromPending(pending);
  const verified = await verifyCampaign2SignedTransaction({
    serializedTransaction: pending.rawTransaction,
    action,
    expectedSigner: CAMPAIGN2_MANIFEST.keeper,
    nonce: BigInt(pending.nonce),
    maxFeePerGasWei: BigInt(pending.maxFeePerGasWei),
    priorityFeeWei: BigInt(pending.maxPriorityFeePerGasWei),
  });
  if (verified.txHash.toLowerCase() !== pending.txHash.toLowerCase()) {
    throw new Error("persisted campaign-2 raw transaction hash does not match its journal");
  }
  await verifyPendingFloorEvidence(publicClient, archiveClient, pending);
  return { action, verified };
}

async function rebroadcastSignedTransaction(publicClient, archiveClient, pending) {
  await verifyPendingJournal(publicClient, archiveClient, pending);
  await requireFreshBurnRebroadcast(publicClient, archiveClient, pending);
  try {
    const hash = await publicClient.sendRawTransaction({
      serializedTransaction: pending.rawTransaction,
    });
    if (hash.toLowerCase() !== pending.txHash.toLowerCase()) {
      throw new Error("RPC returned a different hash for the persisted campaign-2 transaction");
    }
    return hash;
  } catch (error) {
    const message = error?.shortMessage ?? error?.message ?? String(error);
    if (/already known|known transaction/i.test(message)) return pending.txHash;
    log("info", `${pending.actionId}: signed transaction could not be rebroadcast yet (${message})`);
    return null;
  }
}

export async function handleMissingPendingReceipt({ pending, allowBroadcast, rebroadcast }) {
  if (allowBroadcast) {
    await rebroadcast();
    log("info", `${pending.actionId}: transaction ${pending.txHash} is still awaiting a receipt`);
  } else {
    log(
      "info",
      `${pending.actionId}: signed transaction is held without rebroadcast while watch-only or status is active`,
    );
  }
  return { handled: true, pending: true };
}

export function pendingBroadcastAllowed({ command, cfg, signer, pending }) {
  if (command === "status" || !cfg.enabled || !signer) return false;
  if (pending?.actionId === "hookr-buy-and-burn" && !cfg.automateBurns) return false;
  return true;
}

export function assertCampaign2SettlementBindings({ pending, receipt, transaction, block, after }) {
  const expectedHash = pending.txHash.toLowerCase();
  const expectedBlockHash = receipt.blockHash?.toLowerCase();
  const expectedBlockNumber = receipt.blockNumber;
  if (
    receipt.transactionHash?.toLowerCase() !== expectedHash
    || transaction.hash?.toLowerCase() !== expectedHash
    || !expectedBlockHash
    || transaction.blockHash?.toLowerCase() !== expectedBlockHash
    || transaction.blockNumber !== expectedBlockNumber
    || block.hash?.toLowerCase() !== expectedBlockHash
    || block.number !== expectedBlockNumber
    || after.blockHash?.toLowerCase() !== expectedBlockHash
    || after.blockNumber !== expectedBlockNumber
  ) {
    throw new Error("campaign-2 receipt, transaction, canonical block, and readback are not one settlement");
  }
}

export async function reconcilePending({ publicClient, archiveClient, cfg, state, allowBroadcast }) {
  const pending = state.pending;
  if (!pending) return { handled: false };
  if (!TX_HASH.test(pending.txHash) || !CAMPAIGN2_ACTIONS[pending.actionId]) {
    throw new Error("campaign-2 pending receipt identity is malformed");
  }
  const { action } = await verifyPendingJournal(publicClient, archiveClient, pending);
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: pending.txHash });
  } catch {
    return handleMissingPendingReceipt({
      pending,
      allowBroadcast,
      rebroadcast: () => rebroadcastSignedTransaction(publicClient, archiveClient, pending),
    });
  }
  const head = await publicClient.getBlockNumber();
  const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
  if (confirmations < cfg.confirmations) {
    log("info", `${pending.actionId}: receipt has ${confirmations}/${cfg.confirmations} confirmations`);
    return { handled: true, pending: true };
  }
  const [transaction, block] = await Promise.all([
    publicClient.getTransaction({ hash: pending.txHash }),
    publicClient.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (transaction.from?.toLowerCase() !== CAMPAIGN2_MANIFEST.keeper.toLowerCase()) {
    throw new Error("settled campaign-2 transaction was not sent by the pinned keeper");
  }
  if (transaction.hash?.toLowerCase() !== pending.txHash.toLowerCase()) {
    throw new Error("settled campaign-2 transaction hash does not match the pending journal");
  }
  const verification = verifyCampaign2Receipt(action, receipt, transaction, block);
  const after = await fetchCampaign2KeeperSnapshot(
    publicClient,
    CAMPAIGN2_MANIFEST,
    { blockNumber: receipt.blockNumber },
  );
  assertCampaign2SettlementBindings({ pending, receipt, transaction, block, after });
  if (verification.outcome === "finalized") requiredPostcondition(action.id, pending.before, after);

  const document = {
    txHash: pending.txHash,
    actionId: action.id,
    target: action.target,
    outcome: verification.outcome,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    blockTime: new Date(Number(block.timestamp) * 1_000).toISOString(),
    confirmations,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
    signer: transaction.from,
    valueWei: String(transaction.value ?? 0n),
    eventObserved: verification.eventObserved,
    eventDetails: verification.eventDetails,
    floorEvidence: pending.floorEvidence ?? null,
    postconditionBlock: after.blockNumber.toString(),
    postconditionBlockHash: after.blockHash,
    recordedAt: new Date().toISOString(),
  };
  state.receipts.push(document);
  state.receipts = state.receipts.slice(-MAX_RECEIPTS);
  if (verification.outcome === "finalized" && action.id === "staker-harvest") {
    state.lastHarvestWindow = String(pending.harvestWindow);
  }
  state.pending = null;
  writeState(cfg.stateFile, state);
  log("info", `${action.id}: ${verification.outcome} at block ${receipt.blockNumber} (${pending.txHash})`);
  return { handled: true, pending: false, document };
}

async function feeAdmission(publicClient, maximum) {
  let baseFee;
  let blockTimestamp;
  try {
    const pending = await publicClient.getBlock({ blockTag: "pending" });
    baseFee = pending.baseFeePerGas;
    blockTimestamp = pending.timestamp;
  } catch {
    throw new Error("pending base fee is unavailable; refusing the campaign-2 write");
  }
  if (typeof baseFee !== "bigint") {
    throw new Error("pending block has no EIP-1559 base fee; refusing the campaign-2 write");
  }
  if (baseFee > maximum) {
    throw new Error(`pending base fee ${baseFee} exceeds the campaign-2 cap ${maximum}`);
  }
  if (typeof blockTimestamp !== "bigint") {
    throw new Error("pending block has no timestamp; refusing the campaign-2 write");
  }
  return { baseFee, blockTimestamp };
}

async function runOnePass({ publicClient, archiveClient, signer, cfg, command }) {
  const state = normalizeState(readState(cfg.stateFile));
  const allowBroadcast = pendingBroadcastAllowed({ command, cfg, signer, pending: state.pending });
  const reconciliation = await reconcilePending({
    publicClient,
    archiveClient,
    cfg,
    state,
    allowBroadcast,
  });
  if (reconciliation.handled) return reconciliation;

  const snapshot = await fetchCampaign2KeeperSnapshot(publicClient);
  const observationChanged = recordPriceObservation(state, snapshot);
  if (command !== "status" && observationChanged) writeState(cfg.stateFile, state);
  const keeperBalance = await publicClient.getBalance({
    address: CAMPAIGN2_MANIFEST.keeper,
    blockNumber: snapshot.blockNumber,
  });
  if (keeperBalance < cfg.gasWarnBalanceWei) {
    log(
      "warn",
      `keeper gas balance ${keeperBalance} wei is below the ${cfg.gasWarnBalanceWei} wei warning floor`,
    );
  }
  let plan = planCampaign2Maintenance({
    snapshot,
    lastHarvestWindow: BigInt(state.lastHarvestWindow),
    cadenceSeconds: cfg.cadenceSeconds,
    autoFinalize: cfg.autoFinalize,
  });
  let floorEvidence = null;
  if (plan.action?.id === "hookr-buy-and-burn") {
    if (!cfg.automateBurns) {
      plan = {
        ...plan,
        action: null,
        outcome: "blocked",
        reason: "HOOKR burn automation is disabled; harvest and finalization remain available",
      };
    }
  }
  if (plan.action?.id === "hookr-buy-and-burn") {
    const observationValidation = await verifyCampaign2PriceObservationJournal(
      publicClient,
      archiveClient,
      state,
      snapshot.blockTimestamp,
    );
    if (observationValidation.changed && command !== "status") writeState(cfg.stateFile, state);
    if (!observationValidation.valid) {
      plan = {
        ...plan,
        action: null,
        outcome: "blocked",
        reason: `HOOKR burn floor unavailable: ${observationValidation.reason}`,
      };
    } else {
      const ethIn = campaign2EffectiveBuyInput(snapshot.hookBlocks.pendingWeth);
      floorEvidence = deriveCampaign2MedianFloor({
        observations: priceObservationsForFloor(state),
        nowSec: snapshot.blockTimestamp,
        ethIn,
      });
      if (!floorEvidence.ready) {
        plan = {
          ...plan,
          action: null,
          outcome: "blocked",
          reason: `HOOKR burn floor unavailable: ${floorEvidence.reason}`,
        };
      } else {
        plan = {
          ...plan,
          action: campaign2BurnAction(floorEvidence.minHookrOut),
          reason: `${plan.reason}; caller floor uses ${floorEvidence.sampleCount}-sample median`,
        };
      }
    }
  }
  const mode = cfg.enabled && signer ? "live" : "watch-only";
  log(
    "info",
    `block ${snapshot.blockNumber} · ${mode} · ${plan.outcome}`
      + `${plan.action ? ` · ${plan.action.id}` : ""} — ${plan.reason}`,
  );
  if (!plan.action || plan.outcome !== "ready") return { handled: true, plan };

  await simulateCampaign2Action({
    publicClient,
    action: plan.action,
    account: CAMPAIGN2_MANIFEST.keeper,
    blockNumber: snapshot.blockNumber,
  });
  if (command === "status" || !cfg.enabled || !signer) {
    log("info", `${plan.action.id}: simulation passed; no signer-enabled broadcast was allowed`);
    return { handled: true, plan, simulation: "passed" };
  }

  const feeDecision = await feeAdmission(publicClient, cfg.maxFeePerGasWei);
  const budget = admitDailyBudget(state, feeDecision.blockTimestamp, cfg.maxBroadcastsPerDay);
  if (!budget.allowed) throw new Error(budget.reason);
  const currentBalance = await publicClient.getBalance({ address: CAMPAIGN2_MANIFEST.keeper });
  const maximumTransactionCost = plan.action.gas * cfg.maxFeePerGasWei;
  if (currentBalance < maximumTransactionCost) {
    throw new Error(
      `keeper balance ${currentBalance} cannot cover the ${maximumTransactionCost} wei transaction cap`,
    );
  }
  const priorityFee = cfg.maxFeePerGasWei < 5_000_000n ? cfg.maxFeePerGasWei : 5_000_000n;
  const [latestNonce, pendingNonce] = await Promise.all([
    publicClient.getTransactionCount({
      address: CAMPAIGN2_MANIFEST.keeper,
      blockTag: "latest",
    }),
    publicClient.getTransactionCount({
      address: CAMPAIGN2_MANIFEST.keeper,
      blockTag: "pending",
    }),
  ]);
  if (latestNonce !== pendingNonce) {
    throw new Error(
      `keeper nonce lane is not clean (latest ${latestNonce}, pending ${pendingNonce})`,
    );
  }
  const nonce = latestNonce;
  // The lagged snapshot remains the decision evidence, but readiness can
  // change before inclusion (permissionless crank, pause, finalization, pool
  // movement). Re-simulate against the latest mined state immediately before
  // asking the external signer for bytes.
  const latestSimulationBlock = await publicClient.getBlock({ blockTag: "latest" });
  if (
    typeof latestSimulationBlock.number !== "bigint"
    || !latestSimulationBlock.hash
    || typeof latestSimulationBlock.timestamp !== "bigint"
  ) {
    throw new Error("latest canonical block is unavailable before campaign-2 signing");
  }
  await simulateCampaign2Action({
    publicClient,
    action: plan.action,
    account: CAMPAIGN2_MANIFEST.keeper,
    blockNumber: latestSimulationBlock.number,
  });
  const signed = await signCampaign2Action({
    action: plan.action,
    cfg,
    nonce,
    priorityFee,
  });
  state.daily.day = budget.day;
  state.daily.broadcasts += 1;
  state.pending = {
    txHash: signed.txHash,
    rawTransaction: signed.serializedTransaction,
    phase: "signed",
    actionId: plan.action.id,
    actionArgs: plan.action.args.map(String),
    floorEvidence: floorEvidence?.ready
      ? {
          source: "hookr-v4-full-batch-archive-median-v3",
          decisionBlockNumber: snapshot.blockNumber.toString(),
          decisionBlockHash: snapshot.blockHash,
          decisionBlockTimestamp: snapshot.blockTimestamp.toString(),
          effectiveEthInWei: floorEvidence.effectiveEthIn.toString(),
          minHookrOut: floorEvidence.minHookrOut.toString(),
          medianPriceX96: floorEvidence.medianPriceX96.toString(),
          minOutBps: CAMPAIGN2_MANIFEST.minOutBps.toString(),
          sampleCount: floorEvidence.sampleCount,
          sampleSpanSeconds: floorEvidence.sampleSpanSeconds.toString(),
          firstBlockNumber: floorEvidence.firstBlockNumber.toString(),
          lastBlockNumber: floorEvidence.lastBlockNumber.toString(),
          samples: floorEvidence.samples.map((sample) => ({
            bucket: sample.bucket.toString(),
            blockNumber: sample.blockNumber.toString(),
            blockHash: sample.blockHash,
            blockTimestamp: sample.blockTimestamp.toString(),
            sqrtPriceX96: sample.sqrtPriceX96.toString(),
          })),
        }
      : null,
    harvestWindow: plan.harvestWindow?.toString() ?? null,
    signedAt: new Date().toISOString(),
    signedAtBlockNumber: latestSimulationBlock.number.toString(),
    signedAtBlockHash: latestSimulationBlock.hash,
    signedAtBlockTimestamp: latestSimulationBlock.timestamp.toString(),
    nonce: String(nonce),
    signer: signed.signer,
    admittedBaseFeeWei: feeDecision.baseFee.toString(),
    maxFeePerGasWei: cfg.maxFeePerGasWei.toString(),
    maxPriorityFeePerGasWei: priorityFee.toString(),
    before: {
      blockNumber: snapshot.blockNumber.toString(),
      blockHash: snapshot.blockHash,
      hookBlockCount: snapshot.hookBlocks.blockCount.toString(),
      totalHookrBurned: snapshot.hookBlocks.totalHookrBurned.toString(),
    },
  };
  // Persist the exact, policy-verified signed payload before publication. If the process exits
  // after this fsync but before submission, the next pass rebroadcasts this same nonce/hash.
  writeState(cfg.stateFile, state);
  const hash = await rebroadcastSignedTransaction(publicClient, archiveClient, state.pending);
  if (!hash) {
    log("info", `${plan.action.id}: signed ${signed.txHash}; broadcast retry remains pending`);
    return { handled: true, plan, txHash: signed.txHash, broadcast: false };
  }
  state.pending.phase = "broadcast";
  state.pending.broadcastAt = new Date().toISOString();
  writeState(cfg.stateFile, state);
  log("info", `${plan.action.id}: broadcast ${hash}; receipt and postcondition readback pending`);
  return { handled: true, plan, txHash: hash, broadcast: true };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function main() {
  const command = process.argv[2] ?? "status";
  if (!["start", "once", "status"].includes(command)) {
    throw new Error("use campaign2-daemon.mjs start | once | status");
  }
  const cfg = loadCampaign2DaemonConfig();
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  verifyRuntimeArtifacts(cfg);
  const chain = defineChain({
    id: CAMPAIGN2_MANIFEST.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(cfg.rpcUrl, { retryCount: 2, timeout: 8_000 }),
  });
  const archiveRpcUrl = loadArchiveRpcUrl(cfg);
  const archiveClient = archiveRpcUrl
    ? createPublicClient({
        chain,
        transport: http(archiveRpcUrl, { retryCount: 1, timeout: 12_000 }),
      })
    : null;
  if (archiveClient) {
    let archiveChainId;
    try {
      archiveChainId = await archiveClient.getChainId();
    } catch {
      throw new Error("campaign-2 archive RPC is unavailable");
    }
    if (archiveChainId !== CAMPAIGN2_MANIFEST.chainId) {
      throw new Error("campaign-2 archive RPC reports the wrong chain ID");
    }
  }
  const signer = loadKeeperSigner(cfg);
  log(
    "info",
    cfg.enabled
      ? signer
        ? `campaign-2 policy enabled for signer ${signer.address}`
        : "campaign-2 policy enabled but the encrypted signer is incomplete — WATCH-ONLY"
      : "campaign-2 policy disabled — WATCH-ONLY",
  );
  log(
    "info",
    `authority: chain 4663 · 2 pinned contracts · 4 zero-value selectors · `
      + `${cfg.maxBroadcastsPerDay} tx/day · burns ${cfg.automateBurns ? "archive-verified" : "disabled"} · no sweeps`,
  );

  if (command === "status") {
    await runOnePass({ publicClient, archiveClient, signer: null, cfg, command });
    return;
  }

  const release = acquireLock(cfg.lockFile);
  let released = false;
  const clean = () => {
    if (released) return;
    released = true;
    release();
  };
  process.once("SIGINT", () => { clean(); process.exit(0); });
  process.once("SIGTERM", () => { clean(); process.exit(0); });
  process.once("exit", clean);

  if (command === "once") {
    await runOnePass({ publicClient, archiveClient, signer, cfg, command });
    clean();
    return;
  }

  while (true) {
    try {
      await runOnePass({ publicClient, archiveClient, signer, cfg, command });
      await sleep(cfg.pollMs);
    } catch (error) {
      log("error", error?.shortMessage ?? error?.message ?? String(error));
      await sleep(Math.max(30_000, Math.floor(cfg.pollMs / 4)));
    }
  }
}
