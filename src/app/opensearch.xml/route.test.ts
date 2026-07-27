import { describe, expect, it } from "vitest";

import { GET } from "@/app/opensearch.xml/route";
import { SITE_URL } from "@/lib/seo";

describe("OpenSearch discovery", () => {
  it("publishes a canonical address-search template with durable caching", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.headers.get("content-type")).toBe("application/opensearchdescription+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
    expect(body).toContain("<ShortName>OpenZaps Zaps</ShortName>");
    expect(body).toContain(`template="${SITE_URL}/explore/{searchTerms}"`);
    expect(body).toContain(`template="${SITE_URL}/opensearch.xml"`);
    expect(body).toContain(`${SITE_URL}/icon-192.png`);
  });
});
