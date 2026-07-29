import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchZapAddresses: vi.fn<() => Promise<Address[]>>(),
  fetchZapPadTokenAddresses: vi.fn<() => Promise<Address[]>>(),
}));

vi.mock("@/lib/zap-server", () => ({
  fetchZapAddresses: mocks.fetchZapAddresses,
}));

vi.mock("@/lib/zappad-sitemap", () => ({
  fetchZapPadTokenAddresses: mocks.fetchZapPadTokenAddresses,
}));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { SITE_URL, STATIC_PAGE_SEO } from "@/lib/seo";

const ZAP_ADDRESS = "0x0000000000000000000000000000000000000001" as Address;
const LAUNCH_ADDRESS = "0x0000000000000000000000000000000000000002" as Address;

describe("sitemap", () => {
  afterEach(() => {
    mocks.fetchZapAddresses.mockReset();
    mocks.fetchZapPadTokenAddresses.mockReset();
    vi.restoreAllMocks();
  });

  it("includes every indexable static route and both canonical dynamic route families", async () => {
    mocks.fetchZapAddresses.mockResolvedValue([ZAP_ADDRESS]);
    mocks.fetchZapPadTokenAddresses.mockResolvedValue([LAUNCH_ADDRESS]);

    const entries = await sitemap();
    const expectedPerFamilyLimit = Math.floor(
      (50_000 - Object.keys(STATIC_PAGE_SEO).length) / 2,
    );

    for (const page of Object.values(STATIC_PAGE_SEO)) {
      expect(entries).toContainEqual(
        expect.objectContaining({
          url: page.path === "/" ? SITE_URL : `${SITE_URL}${page.path}`,
          changeFrequency: page.changeFrequency,
          priority: page.priority,
        }),
      );
    }
    expect(mocks.fetchZapAddresses).toHaveBeenCalledWith(
      expectedPerFamilyLimit,
    );
    expect(mocks.fetchZapPadTokenAddresses).toHaveBeenCalledWith(
      expectedPerFamilyLimit,
    );
    expect(
      Object.keys(STATIC_PAGE_SEO).length + expectedPerFamilyLimit * 2,
    ).toBeLessThanOrEqual(50_000);
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: `${SITE_URL}/explore/${ZAP_ADDRESS}`,
        changeFrequency: "daily",
        priority: 0.7,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: `${SITE_URL}/launch/token/${LAUNCH_ADDRESS.toLowerCase()}`,
        changeFrequency: "daily",
        priority: 0.7,
      }),
    );
  });

  it("keeps ZapPad discovery when the OpenZap index is unavailable", async () => {
    mocks.fetchZapAddresses.mockRejectedValue(new Error("RPC unavailable"));
    mocks.fetchZapPadTokenAddresses.mockResolvedValue([LAUNCH_ADDRESS]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const entries = await sitemap();

    expect(entries).toHaveLength(Object.keys(STATIC_PAGE_SEO).length + 1);
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: `${SITE_URL}/launch/token/${LAUNCH_ADDRESS.toLowerCase()}`,
      }),
    );
    expect(warning).toHaveBeenCalledWith(
      "[sitemap] Onchain zap enumeration unavailable; omitting Zap detail routes.",
    );
  });

  it("keeps OpenZap discovery when the ZapPad index is unavailable", async () => {
    mocks.fetchZapAddresses.mockResolvedValue([ZAP_ADDRESS]);
    mocks.fetchZapPadTokenAddresses.mockRejectedValue(new Error("RPC unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const entries = await sitemap();

    expect(entries).toHaveLength(Object.keys(STATIC_PAGE_SEO).length + 1);
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: `${SITE_URL}/explore/${ZAP_ADDRESS}`,
      }),
    );
    expect(warning).toHaveBeenCalledWith(
      "[sitemap] ZapPad launch enumeration unavailable; omitting token detail routes.",
    );
  });

  it("falls back to static discovery when both onchain indexes are unavailable", async () => {
    mocks.fetchZapAddresses.mockRejectedValue(new Error("Zap RPC unavailable"));
    mocks.fetchZapPadTokenAddresses.mockRejectedValue(
      new Error("ZapPad RPC unavailable"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const entries = await sitemap();

    expect(entries).toHaveLength(Object.keys(STATIC_PAGE_SEO).length);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      "[sitemap] Onchain zap enumeration unavailable; omitting Zap detail routes.",
    );
    expect(console.warn).toHaveBeenCalledWith(
      "[sitemap] ZapPad launch enumeration unavailable; omitting token detail routes.",
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
