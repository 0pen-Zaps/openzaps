type RequestOrigin = Pick<Request, "headers" | "url">;

/**
 * Public intake is callable only by a browser already on the same origin.
 * This is an abuse/CSRF control, not authentication; durable quota and strict
 * validation remain mandatory.
 */
export function isSameOriginLeadRequest(request: RequestOrigin): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  try {
    const supplied = new URL(origin);
    const destination = new URL(request.url);
    return (
      supplied.origin === destination.origin
      && supplied.username.length === 0
      && supplied.password.length === 0
    );
  } catch {
    return false;
  }
}
