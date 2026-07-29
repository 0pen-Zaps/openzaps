const CREDENTIAL_PATTERNS = [
  /\bsk-(?:proj-|svcacct-|admin-)?[a-z0-9_-]{20,}\b/iu,
  /https:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[a-z0-9._-]+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*(?:bearer\s+)?[a-z0-9._~-]{20,}/iu,
  /\bbearer\s+[a-z0-9._~-]{20,}\b/iu,
  /[?&#](?:api[-_]?key|authorization|code|credential|password|refresh[-_]?token|secret|sig|signature|token|access[-_]?token)=/iu,
] as const;

const SENSITIVE_QUERY_KEYS = new Set([
  "apikey",
  "authorization",
  "code",
  "credential",
  "password",
  "refreshtoken",
  "secret",
  "sig",
  "signature",
  "token",
  "accesstoken",
]);

export function containsCredentialLikeData(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

function decodedComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function reviewedSourceOrigin(url: URL): boolean {
  if (["www.0xzaps.com", "0xzaps.com", "defitutorials.substack.com"].includes(url.hostname)) {
    return true;
  }
  return (
    url.hostname === "github.com"
    && /^\/0pen-Zaps\/openzaps(?:\/|$)/iu.test(url.pathname)
  );
}

/**
 * Validate and normalize a public evidence URL before it enters workflow state.
 *
 * Fragments never reach the origin and therefore are not evidence. They are
 * stripped after first being checked for accidentally pasted credentials.
 */
export function normalizeMarketingSourceUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Source URLs must use https.");
  }
  if (url.username || url.password || url.port || !reviewedSourceOrigin(url)) {
    throw new Error("Source URL is outside the reviewed OpenZaps origins.");
  }

  const decodedQuery = [...url.searchParams]
    .map(([key, value]) => `${decodedComponent(key)}=${decodedComponent(value)}`)
    .join("&");
  const decodedFragment = decodedComponent(url.hash.slice(1));
  const hasSensitiveQueryKey = [...url.searchParams.keys()].some((key) =>
    SENSITIVE_QUERY_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, ""))
  );
  if (
    hasSensitiveQueryKey
    || containsCredentialLikeData(raw)
    || containsCredentialLikeData(decodedQuery)
    || containsCredentialLikeData(decodedFragment)
  ) {
    throw new Error("Source URL query or fragment appears to contain a credential.");
  }

  url.hash = "";
  return url.toString();
}
