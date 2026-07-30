import { createHash, timingSafeEqual } from "node:crypto";

type RequestWithHeaders = Pick<Request, "headers">;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isCronAuthorized(request: RequestWithHeaders): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer[ \t]+([^\s,]+)$/iu);
  const supplied = match?.[1] ?? "";
  return (
    expected.trim().length > 0
    && supplied.length > 0
    && timingSafeEqual(digest(expected), digest(supplied))
  );
}
