import { createHash, timingSafeEqual } from "node:crypto";

const LEAD_ADMIN_TOKEN_ENV = "OPENZAPS_LEAD_ADMIN_TOKEN";
const BEARER_PATTERN = /^Bearer[ \t]+([^\s,]+)$/iu;

type RequestWithHeaders = Pick<Request, "headers">;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearerToken(request: RequestWithHeaders): string {
  const authorization = request.headers.get("authorization");
  if (!authorization) return "";
  return authorization.match(BEARER_PATTERN)?.[1] ?? "";
}

function configuredToken(value: string): boolean {
  return (
    value === value.trim()
    && !/[\r\n]/u.test(value)
    && Buffer.byteLength(value, "utf8") >= 32
  );
}

/**
 * A read/write credential scoped to the private lead desk.
 *
 * It is deliberately distinct from the marketing publication credential:
 * compromise of one surface must not grant authority over the other.
 */
export function isLeadAdminAuthorized(request: RequestWithHeaders): boolean {
  const expected = process.env[LEAD_ADMIN_TOKEN_ENV] ?? "";
  const supplied = bearerToken(request);
  const matches = timingSafeEqual(digest(expected), digest(supplied));

  return configuredToken(expected) && supplied.length > 0 && matches;
}

export function leadAdminTokenConfigured(): boolean {
  return configuredToken(process.env[LEAD_ADMIN_TOKEN_ENV] ?? "");
}

export function leadAdminUnauthorizedResponse(): Response {
  return Response.json(
    { error: "Unauthorized." },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store, private",
        "WWW-Authenticate": 'Bearer realm="OpenZaps Lead Desk"',
      },
    },
  );
}
