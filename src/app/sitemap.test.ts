import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchZapAddresses: vi.fn<() => Promise<Address[]>>(),
}));

vi.mock("@/lib/zap-server", () => ({
  fetchZapAddresses: mocks.fetchZapAddresses,
}));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { SITE_URL, STATIC_PAGE_SEO } from "@/lib/seo";

const ZAP_ADDRESS = "0x0000000000000000000000000000000000000001" as Address;

describe("sitemap", () => {
  afterEach(() => {
    mocks.fetchZapAddresses.mockReset();
    vi.restoreAllMocks();
  });

  it("includes every indexable static route and canonical factory-created zap", async () => {
    mocks.fetchZapAddresses.mockResolvedValue([ZAP_ADDRESS]);

    const entries = await sitemap();

    for (const page of Object.values(STATIC_PAGE_SEO)) {
      expect(entries).toContainEqual(
        expect.objectContaining({
          url: page.path === "/" ? SITE_URL : `${SITE_URL}${page.path}`,
          changeFrequency: page.changeFrequency,
          priority: page.priority,
        }),
      );
    }
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: `${SITE_URL}/explore/${ZAP_ADDRESS}`,
        changeFrequency: "daily",
        priority: 0.7,
      }),
    );
  });

  it("falls back to static discovery when the onchain index is unavailable", async () => {
    mocks.fetchZapAddresses.mockRejectedValue(new Error("RPC unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const entries = await sitemap();

    expect(entries).toHaveLength(Object.keys(STATIC_PAGE_SEO).length);
    expect(warning).toHaveBeenCalledWith(
      "[sitemap] Onchain zap enumeration unavailable; serving static routes only.",
    );
  });
});

describe("robots", () => {
  it("allows public routes, excludes APIs, and advertises the canonical sitemap host", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: "/api/" },
      sitemap: `${SITE_URL}/sitemap.xml`,
      host: new URL(SITE_URL).host,
    });
  });
});
