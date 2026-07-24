// Intent store: one JSON file per standing authorization, dropped into the intents directory by
// the owner (exported from the app after signing). The executor treats these as UNTRUSTED input —
// every file is schema-checked here and every submission is re-verified by the zap contract
// itself, so a malformed or malicious file can only waste a simulation, never move funds.
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
// >= 65 bytes of even-length hex: a 65-byte ECDSA signature, or the longer wrapped signatures
// ERC-1271 contract wallets (Safe, Coinbase Smart Wallet) produce — the capsule verifies both.
const HEX_SIG = /^0x(?:[0-9a-fA-F]{2}){65,}$/;

const COMMON_FIELDS = [
  ["zap", HEX_ADDR],
  ["chainId", "bigint"],
  ["validAfter", "bigint"],
  ["deadline", "bigint"],
  ["recipient", HEX_ADDR],
  ["executor", HEX_ADDR],
  ["maxGas", "bigint"],
  ["maxFeePerGas", "bigint"],
  ["policyHash", HEX_32],
  ["outAsset", HEX_ADDR],
];

const KIND_FIELDS = {
  recurring: [...COMMON_FIELDS, ["seriesId", "bigint"], ["interval", "bigint"], ["maxRuns", "bigint"], ["minOutPerRun", "bigint"]],
  trigger: [
    ...COMMON_FIELDS,
    ["nonce", "bigint"],
    ["priceSource", HEX_ADDR],
    ["baselinePriceX96", "bigint"],
    ["thresholdBps", "bigint"],
    ["above", "boolean"],
    ["minOut", "bigint"],
  ],
};

function coerce(name, rule, value) {
  if (rule === "bigint") {
    // MUST be a decimal string. A JSON number cannot hold a uint256 without silent precision loss
    // (e.g. 2^96-1 round-trips wrong through a JS double), which would corrupt the signed value the
    // capsule re-hashes — so a numeric type is rejected outright, not coerced. The app always
    // serializes these as strings (serializeIntentFile), so this only rejects malformed input.
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
      throw new Error(`field ${name}: expected a decimal string, got ${typeof value}`);
    }
    return BigInt(value);
  }
  if (rule === "boolean") {
    if (typeof value !== "boolean") throw new Error(`field ${name}: expected boolean`);
    return value;
  }
  if (typeof value !== "string" || !rule.test(value)) throw new Error(`field ${name}: malformed`);
  return value;
}

/**
 * Validate a raw intent OBJECT (already JSON-parsed). Throws with a precise message on any
 * deviation. Shared by the file loader below and the intake listener — one schema gate,
 * regardless of how an intent arrives.
 */
export function validateIntentObject(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("intent payload must be a JSON object");
  const kind = raw.kind;
  if (kind !== "recurring" && kind !== "trigger") throw new Error(`kind must be "recurring" or "trigger"`);
  if (typeof raw.signature !== "string" || !HEX_SIG.test(raw.signature)) throw new Error("signature: malformed");
  if (typeof raw.intent !== "object" || raw.intent === null) throw new Error("intent: missing");

  const intent = {};
  for (const [name, rule] of KIND_FIELDS[kind]) {
    if (!(name in raw.intent)) throw new Error(`intent.${name}: missing`);
    intent[name] = coerce(name, rule, raw.intent[name]);
  }
  return { kind, intent, signature: raw.signature };
}

/** Parse + validate one intent file. Throws with a precise message on any deviation. */
export function parseIntentFile(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const { kind, intent, signature } = validateIntentObject(raw);
  return { file: basename(path), path, kind, intent, signature };
}

/** Load every parseable intent; report the broken ones instead of dying on them. */
export function loadIntents(intentsDir) {
  const ok = [];
  const bad = [];
  for (const name of readdirSync(intentsDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(intentsDir, name);
    try {
      ok.push(parseIntentFile(path));
    } catch (err) {
      bad.push({ file: name, error: err.message });
    }
  }
  return { ok, bad };
}

/** An intent that can never fire again (consumed, cancelled, expired) is archived, not deleted. */
export function archiveIntent(intent, doneDir, reason) {
  const target = join(doneDir, `${Date.now()}-${reason}-${intent.file}`);
  renameSync(intent.path, target);
  return target;
}

export function readState(stateFile) {
  if (!existsSync(stateFile)) return { submissions: {} };
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { submissions: {} };
  }
}

export function writeState(stateFile, state) {
  // Atomic: write a sibling temp file then rename over the target. A crash mid-write leaves the
  // previous good state.json intact instead of a truncated file that readState would silently
  // reset to empty — losing lifetime earnings and the convert throttle.
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}
