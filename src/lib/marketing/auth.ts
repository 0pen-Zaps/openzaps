import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const ADMIN_TOKEN_ENV = "OPENZAPS_MARKETING_ADMIN_TOKEN";
const REPAIR_SECRET_ENV = "SUPABASE_SERVICE_ROLE_KEY";
const BEARER_PATTERN = /^Bearer[ \t]+([^\s,]+)$/i;
const ITEM_ID = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[^\s/\\]{1,200}$/u;
const REPAIR_PROOF = /^[A-Za-z0-9_-]{43}$/u;

type RequestWithHeaders = Pick<Request, "headers">;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearerToken(request: RequestWithHeaders): string {
  const authorization = request.headers.get("authorization");
  if (!authorization) return "";
  return authorization.match(BEARER_PATTERN)?.[1] ?? "";
}

/**
 * Checks the private operator credential at the API boundary.
 *
 * Both values are reduced to fixed-width digests before comparison, so valid
 * and invalid tokens of different lengths take the same comparison path.
 * Missing configuration always fails closed.
 */
export function isMarketingAdminAuthorized(request: RequestWithHeaders): boolean {
  const expected = process.env[ADMIN_TOKEN_ENV] ?? "";
  const supplied = bearerToken(request);
  const matches = timingSafeEqual(digest(expected), digest(supplied));

  return expected.trim().length > 0 && supplied.length > 0 && matches;
}

export function marketingAdminTokenConfigured(): boolean {
  return (process.env[ADMIN_TOKEN_ENV] ?? "").trim().length > 0;
}

function repairProofMaterial(itemId: string, runId: string): string {
  return `openzaps:syndication-attach:v1\0${itemId}\0${runId}`;
}

/**
 * Produces a narrow proof that this server paired one claimed inbox item with
 * the exact run returned by Workflow start. It grants no draft, approval, or
 * provider-write authority and rotates with the server-only durable-store
 * credential.
 */
export function createMarketingSyndicationRepairProof(
  itemId: string,
  runId: string,
): string | null {
  // The operator knows the bearer credential, so it cannot be the HMAC key.
  // Use the server-only durable-store credential with domain separation.
  const secret = process.env[REPAIR_SECRET_ENV] ?? "";
  if (!secret.trim() || !ITEM_ID.test(itemId) || !RUN_ID.test(runId)) return null;
  return createHmac("sha256", secret)
    .update(repairProofMaterial(itemId, runId), "utf8")
    .digest("base64url");
}

export function verifyMarketingSyndicationRepairProof(
  itemId: string,
  runId: string,
  proof: string,
): boolean {
  if (!REPAIR_PROOF.test(proof)) return false;
  const expected = createMarketingSyndicationRepairProof(itemId, runId);
  return Boolean(
    expected
    && timingSafeEqual(digest(expected), digest(proof)),
  );
}

export function marketingAdminUnauthorizedResponse(): Response {
  return Response.json(
    { error: "Unauthorized." },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store, private",
        "WWW-Authenticate": 'Bearer realm="OpenZaps Marketing"',
      },
    },
  );
}
