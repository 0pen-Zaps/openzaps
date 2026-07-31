import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseLateBlockRpcUrls } from "./late-block.mjs";
import { registerExecutorSensitiveValues } from "./redaction.mjs";

export const MAX_EXECUTOR_SECRET_CONFIG_BYTES = 64 * 1024;

const MIN_PROVIDER_ORIGINS = 2;
const MAX_PROVIDER_ORIGINS = 8;
const DEFAULT_CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOP_LEVEL_KEYS = new Set(["rpcUrls", "lateBlockRpcUrls", "privateRelays"]);
const PRIVATE_RELAY_KEYS = new Set([
  "id",
  "url",
  "classification",
  "operator",
  "authorization",
]);
const RELAY_ID = /^[a-zA-Z0-9._-]+$/;

export class ExecutorSecretConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutorSecretConfigError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExecutorSecretConfigError(code, message);
}

function configured(value) {
  return value !== undefined && value !== null && String(value) !== "";
}

function inside(path, root) {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function insideGitCheckout(path) {
  let cursor = dirname(path);
  while (true) {
    try {
      lstatSync(join(cursor, ".git"));
      return true;
    } catch (error) {
      if (
        !error
        || typeof error !== "object"
        || !["ENOENT", "ENOTDIR"].includes(error.code)
      ) {
        fail(
          "path-check-failed",
          "executor provider secret config path could not be verified",
        );
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function verifyFileMetadata(stat, expectedUid) {
  if (!stat.isFile()) {
    fail("not-regular", "executor provider secret config must be a regular file");
  }
  if (stat.nlink !== 1) {
    fail(
      "hardlink",
      "executor provider secret config must not have hard links",
    );
  }
  if (!Number.isInteger(expectedUid) || stat.uid !== expectedUid) {
    fail(
      "wrong-owner",
      "executor provider secret config must be owned by the current user",
    );
  }
  if ((stat.mode & 0o7777) !== 0o600) {
    fail(
      "wrong-mode",
      "executor provider secret config permissions must be exactly 0600",
    );
  }
  if (stat.size > MAX_EXECUTOR_SECRET_CONFIG_BYTES) {
    fail(
      "too-large",
      "executor provider secret config exceeds the 64 KiB limit",
    );
  }
}

function readBoundedRegularFile(path, expectedUid) {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    fail("unreadable", "executor provider secret config is not readable");
  }
  if (before.isSymbolicLink()) {
    fail("symlink", "executor provider secret config must not be a symbolic link");
  }
  verifyFileMetadata(before, expectedUid);

  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    fail("unreadable", "executor provider secret config is not readable");
  }

  try {
    const opened = fstatSync(descriptor);
    verifyFileMetadata(opened, expectedUid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail(
        "changed-during-open",
        "executor provider secret config changed while it was being opened",
      );
    }

    const buffer = Buffer.alloc(MAX_EXECUTOR_SECRET_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_EXECUTOR_SECRET_CONFIG_BYTES) {
      fail(
        "too-large",
        "executor provider secret config exceeds the 64 KiB limit",
      );
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseStrictObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("invalid-json", "executor provider secret config must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-schema", "executor provider secret config must be a JSON object");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== TOP_LEVEL_KEYS.size
    || keys.some((key) => !TOP_LEVEL_KEYS.has(key))
    || !["rpcUrls", "lateBlockRpcUrls", "privateRelays"].every((key) =>
      Object.hasOwn(value, key))
  ) {
    fail(
      "invalid-schema",
      "executor provider secret config must contain only rpcUrls, lateBlockRpcUrls, and privateRelays",
    );
  }
  return value;
}

function hiddenRpcEndpoint({ url, origin }) {
  const endpoint = {};
  Object.defineProperties(endpoint, {
    url: { value: url, enumerable: false },
    origin: { value: origin, enumerable: false },
  });
  return Object.freeze(endpoint);
}

function validateSecretRpcUrls(value, { field, code }) {
  if (
    !Array.isArray(value)
    || value.length < MIN_PROVIDER_ORIGINS
    || value.length > MAX_PROVIDER_ORIGINS
    || value.some(
      (candidate) =>
        typeof candidate !== "string"
        || candidate !== candidate.trim()
        || candidate.length < 1
        || candidate.length > 2_048,
    )
  ) {
    fail(
      code,
      `${field} must contain 2 to 8 distinct RPC URL strings`,
    );
  }
  for (const candidate of value) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      fail(
        code,
        `${field} must contain 2 to 8 distinct valid RPC URL strings`,
      );
    }
    if (url.protocol !== "https:") {
      fail(
        code,
        `${field} must contain 2 to 8 distinct HTTPS RPC URL strings`,
      );
    }
  }
  let endpoints;
  try {
    endpoints = parseLateBlockRpcUrls(JSON.stringify(value));
  } catch {
    fail(
      code,
      `${field} must contain 2 to 8 distinct valid RPC URL strings`,
    );
  }
  return Object.freeze(endpoints.map(hiddenRpcEndpoint));
}

function validatePrimaryRpcUrls(value) {
  return validateSecretRpcUrls(value, {
    field: "rpcUrls",
    code: "invalid-rpc-schema",
  });
}

function validateLateBlockRpcUrls(value) {
  return validateSecretRpcUrls(value, {
    field: "lateBlockRpcUrls",
    code: "invalid-late-block-schema",
  });
}

function boundedString(value, { minimum = 1, maximum, pattern } = {}) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  if (value.length < minimum || value.length > maximum) return null;
  if (pattern && !pattern.test(value)) return null;
  return value;
}

function validatePrivateRelay(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(
      "invalid-private-relay-schema",
      `privateRelays entry ${index + 1} must be an object`,
    );
  }
  const keys = Object.keys(entry);
  if (
    keys.some((key) => !PRIVATE_RELAY_KEYS.has(key))
    || !["id", "url", "classification", "operator"].every((key) =>
      Object.hasOwn(entry, key))
  ) {
    fail(
      "invalid-private-relay-schema",
      `privateRelays entry ${index + 1} has an invalid schema`,
    );
  }

  const id = boundedString(entry.id, { maximum: 64, pattern: RELAY_ID });
  const urlText = boundedString(entry.url, { maximum: 2_048 });
  const operator = boundedString(entry.operator, { maximum: 96 });
  if (!id || !urlText || !operator || entry.classification !== "private-relay") {
    fail(
      "invalid-private-relay-schema",
      `privateRelays entry ${index + 1} has invalid required fields`,
    );
  }
  let url;
  try {
    url = new URL(urlText);
  } catch {
    fail(
      "invalid-private-relay-schema",
      `privateRelays entry ${index + 1} has an invalid HTTPS URL`,
    );
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
  ) {
    fail(
      "invalid-private-relay-schema",
      `privateRelays entry ${index + 1} has an invalid HTTPS URL`,
    );
  }

  let authorization = "";
  if (Object.hasOwn(entry, "authorization")) {
    authorization = boundedString(entry.authorization, { maximum: 4_096 });
    if (!authorization || /[\r\n\0]/.test(authorization)) {
      fail(
        "invalid-private-relay-schema",
        `privateRelays entry ${index + 1} has an invalid authorization value`,
      );
    }
  }

  const relay = {};
  Object.defineProperties(relay, {
    id: { value: id, enumerable: false },
    classification: { value: "private-relay", enumerable: false },
    operator: { value: operator, enumerable: false },
    url: { value: urlText, enumerable: false },
    authorization: { value: authorization, enumerable: false },
    origin: { value: url.origin, enumerable: false },
  });
  return Object.freeze(relay);
}

function validatePrivateRelays(value) {
  if (
    !Array.isArray(value)
    || value.length < MIN_PROVIDER_ORIGINS
    || value.length > MAX_PROVIDER_ORIGINS
  ) {
    fail(
      "invalid-private-relay-schema",
      "privateRelays must contain 2 to 8 private relay definitions",
    );
  }
  const relays = value.map(validatePrivateRelay);
  const ids = new Set();
  const origins = new Set();
  const operators = new Set();
  for (const relay of relays) {
    const id = relay.id.toLowerCase();
    const operator = relay.operator.toLowerCase();
    if (ids.has(id) || origins.has(relay.origin) || operators.has(operator)) {
      fail(
        "duplicate-private-relay",
        "privateRelays must use distinct ids, HTTPS origins, and operators",
      );
    }
    ids.add(id);
    origins.add(relay.origin);
    operators.add(operator);
  }
  return Object.freeze(relays);
}

/**
 * Load the executor's provider/relay credential file without allowing any Git checkout, a symlink,
 * or permissive filesystem metadata to become an authority source. Error messages are
 * intentionally value-free because the file may contain authenticated provider URLs and
 * Authorization headers.
 */
export function loadExecutorSecretConfigFile(
  path,
  {
    checkoutRoot = DEFAULT_CHECKOUT_ROOT,
    expectedUid =
      typeof process.getuid === "function" ? process.getuid() : Number.NaN,
  } = {},
) {
  if (
    typeof path !== "string"
    || path.trim() !== path
    || path.length > 4_096
    || /[\0\r\n]/.test(path)
    || !isAbsolute(path)
  ) {
    fail(
      "invalid-path",
      "OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE must be an absolute file path",
    );
  }

  let resolvedPath;
  let resolvedCheckout;
  try {
    resolvedPath = realpathSync(path);
    resolvedCheckout = realpathSync(checkoutRoot);
  } catch {
    fail("unreadable", "executor provider secret config is not readable");
  }
  if (resolve(path) !== resolvedPath) {
    fail(
      "symlink",
      "executor provider secret config path must be canonical and contain no symbolic links",
    );
  }
  if (inside(resolvedPath, resolvedCheckout)) {
    fail(
      "inside-checkout",
      "executor provider secret config must live outside the source checkout",
    );
  }
  if (insideGitCheckout(resolvedPath)) {
    fail(
      "inside-git-checkout",
      "executor provider secret config must live outside every Git checkout",
    );
  }

  const text = readBoundedRegularFile(resolvedPath, expectedUid);
  const parsed = parseStrictObject(text);
  const loaded = Object.freeze({
    rpcUrls: validatePrimaryRpcUrls(parsed.rpcUrls),
    lateBlockRpcUrls: validateLateBlockRpcUrls(parsed.lateBlockRpcUrls),
    privateRelays: validatePrivateRelays(parsed.privateRelays),
  });
  registerExecutorSensitiveValues({
    urls: [
      ...loaded.rpcUrls.map((endpoint) => endpoint.url),
      ...loaded.lateBlockRpcUrls.map((endpoint) => endpoint.url),
      ...loaded.privateRelays.map((relay) => relay.url),
    ],
    credentials: loaded.privateRelays.map((relay) => relay.authorization),
    labels: loaded.privateRelays.flatMap((relay) => [
      relay.origin,
      relay.operator,
    ]),
  });
  return loaded;
}

/**
 * The secret file supersedes the legacy JSON environment variables. Setting both is an ambiguous
 * authority source and therefore aborts configuration instead of choosing one by precedence.
 */
export function loadExecutorSecretConfigFromEnv(
  env = process.env,
  options = {},
) {
  const fileConfigured = configured(env.OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE);
  const legacyConfigured =
    configured(env.OPENZAPS_LATE_BLOCK_RPC_URLS)
    || configured(env.OPENZAPS_PRIVATE_RELAYS_JSON);
  if (fileConfigured && legacyConfigured) {
    fail(
      "source-conflict",
      "executor provider configuration is ambiguous; use only OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE",
    );
  }
  if (!fileConfigured) return null;
  return loadExecutorSecretConfigFile(
    String(env.OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE),
    options,
  );
}

const invokedDirectly =
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const loaded = loadExecutorSecretConfigFromEnv();
    if (!loaded) {
      fail(
        "missing-path",
        "OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE is required for validation",
      );
    }
    process.stdout.write("executor provider secret config: valid\n");
  } catch (error) {
    const message =
      error instanceof ExecutorSecretConfigError
        ? error.message
        : "executor provider secret config validation failed";
    process.stderr.write(`[secret-config] ${message}\n`);
    process.exitCode = 1;
  }
}
