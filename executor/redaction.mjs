const sensitiveValues = new Set();

const ENDPOINT =
  /https?:\/\/(?:\[[^\]]+\]|[^\s"'<>()[\]{}]+)(?:[^\s"'<>()[\]{}]*)?/gi;
const AUTHORIZATION =
  /\b(Bearer|Basic)\s+[^\s"'<>()[\]{}]+/gi;
const CREDENTIAL_FIELD =
  /(["']?(?:api[-_]?key|authorization|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

function addSensitiveValue(value) {
  if (typeof value !== "string" || value.length < 4) return;
  sensitiveValues.add(value);
}

function decoded(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function addPathParts(pathname) {
  const variants = new Set([pathname, decoded(pathname)].filter(Boolean));
  for (const variant of variants) {
    addSensitiveValue(variant);
    addSensitiveValue(variant.replace(/^\/+/, ""));
    const segments = variant.split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      addSensitiveValue(segments[index]);
      // Dependencies sometimes omit a public prefix (for example /rpc/) while retaining the
      // decoded credential-bearing suffix in an error.
      addSensitiveValue(segments.slice(index).join("/"));
    }
  }
}

function addUrlParts(value) {
  if (typeof value !== "string" || value.length === 0) return;
  addSensitiveValue(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }
  addSensitiveValue(parsed.href);
  addSensitiveValue(decoded(parsed.href));
  addSensitiveValue(parsed.origin);
  addSensitiveValue(parsed.hostname);
  addSensitiveValue(parsed.username);
  addSensitiveValue(decoded(parsed.username));
  addSensitiveValue(parsed.password);
  addSensitiveValue(decoded(parsed.password));
  addPathParts(parsed.pathname);
  for (const parameterValue of parsed.searchParams.values()) {
    addSensitiveValue(parameterValue);
    addSensitiveValue(decoded(parameterValue));
  }
}

/**
 * Register exact provider/relay material before any request can fail. Values remain process-local
 * and are never exposed. URL components are included because fetch/viem diagnostics may print only
 * an origin, hostname, path credential, or query credential instead of the configured string.
 */
export function registerExecutorSensitiveValues(values = {}) {
  for (const value of values.urls ?? []) addUrlParts(value);
  for (const value of values.credentials ?? []) {
    addSensitiveValue(value);
    if (typeof value === "string") {
      const separator = value.indexOf(" ");
      if (separator >= 0) addSensitiveValue(value.slice(separator + 1));
    }
  }
  for (const value of values.labels ?? []) addSensitiveValue(value);
}

function replaceExactValues(text) {
  let redacted = text;
  const ordered = [...sensitiveValues].sort((a, b) => b.length - a.length);
  for (const value of ordered) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

/**
 * Sanitize any operator-visible or durable text. Exact configured values are removed first, then
 * generic endpoint/auth patterns catch alternate formatting in dependency diagnostics.
 */
export function redactExecutorText(
  value,
  { fallback = "executor operation failed", maximum = 2_000 } = {},
) {
  const source = String(value ?? "");
  const redacted = replaceExactValues(source)
    .replace(ENDPOINT, "[endpoint]")
    .replace(AUTHORIZATION, "$1 [redacted]")
    .replace(CREDENTIAL_FIELD, "$1[redacted]")
    .replace(/\0/g, "")
    .slice(0, maximum);
  return redacted || fallback;
}

export function redactExecutorError(
  error,
  fallback = "executor operation failed",
  { includeStack = false, maximum = 2_000 } = {},
) {
  const source = includeStack
    ? error?.stack ?? error?.shortMessage ?? error?.message
    : error?.shortMessage ?? error?.message;
  return redactExecutorText(source ?? fallback, { fallback, maximum });
}

export function executorJsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return redactExecutorText(value, { fallback: "", maximum: 100_000 });
  }
  return value;
}

const DURABLE_DIAGNOSTIC_FIELDS = new Set([
  "accountingError",
  "detail",
  "error",
  "lastError",
  "message",
  "reason",
  "warning",
]);

/**
 * Durable executor evidence contains canonical hashes, addresses, signatures, and signed
 * transaction bytes that must round-trip byte-for-byte. Redacting every string can corrupt those
 * fields when an unrelated credential happens to be a hex substring. Restrict sanitization to the
 * schema's explicitly free-text diagnostic fields; all diagnostic producers also sanitize before
 * persistence, so this remains a defense-in-depth boundary without rewriting structural evidence.
 */
export function executorDurableJsonReplacer(key, value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && DURABLE_DIAGNOSTIC_FIELDS.has(key)) {
    return redactExecutorText(value, { fallback: "", maximum: 100_000 });
  }
  return value;
}
