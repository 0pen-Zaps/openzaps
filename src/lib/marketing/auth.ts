import { createHash, timingSafeEqual } from "node:crypto";

const ADMIN_TOKEN_ENV = "OPENZAPS_MARKETING_ADMIN_TOKEN";
const BEARER_PATTERN = /^Bearer[ \t]+([^\s,]+)$/i;

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
