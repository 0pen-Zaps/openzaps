import { createHmac } from "node:crypto";
import { isIP } from "node:net";

type HeaderReader = Pick<Headers, "get">;

const FINGERPRINT_CONTEXT = "openzaps-lead-fingerprint:v1";

function firstAddress(value: string | null): string {
  const candidate = value?.split(",", 1)[0]?.trim().toLowerCase() ?? "";
  return isIP(candidate) > 0 ? candidate : "unknown";
}

/**
 * Produces a non-reversible, deployment-specific abuse-control key.
 *
 * The raw network address is never returned or persisted. Vercel's
 * platform-authored forwarding header wins; x-forwarded-for is deliberately
 * not trusted because public clients can spoof it.
 */
export function leadFingerprint(
  headers: HeaderReader,
  secret: string,
): string {
  const address = firstAddress(
    headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip"),
  );
  return createHmac("sha256", secret)
    .update(`${FINGERPRINT_CONTEXT}\0${address}`, "utf8")
    .digest("hex");
}
