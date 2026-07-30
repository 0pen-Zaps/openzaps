import { describe, expect, it } from "vitest";

import { isSameOriginLeadRequest } from "@/lib/leads/origin";

function request(origin?: string, fetchSite?: string): Request {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (fetchSite) headers.set("sec-fetch-site", fetchSite);
  return new Request("https://www.0xzaps.com/api/leads/request", { headers });
}

describe("isSameOriginLeadRequest", () => {
  it("accepts an exact same-origin browser request", () => {
    expect(
      isSameOriginLeadRequest(
        request("https://www.0xzaps.com", "same-origin"),
      ),
    ).toBe(true);
  });

  it("rejects absent, opaque, cross-origin, and cross-site origins", () => {
    expect(isSameOriginLeadRequest(request())).toBe(false);
    expect(isSameOriginLeadRequest(request("null"))).toBe(false);
    expect(
      isSameOriginLeadRequest(request("https://0xzaps.com", "same-origin")),
    ).toBe(false);
    expect(
      isSameOriginLeadRequest(
        request("https://www.0xzaps.com", "cross-site"),
      ),
    ).toBe(false);
  });
});
