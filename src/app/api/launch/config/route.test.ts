import { describe, expect, it, vi } from "vitest";

const { failClosedConfig } = vi.hoisted(() => ({
  failClosedConfig: {
    launcherAddress: null,
    deployBlock: 0,
    readEnabled: false,
    chain: {
      id: 4_663,
      name: "Robinhood Chain",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      explorerUrl: "https://robinhoodchain.blockscout.com",
      rpcPath: "/api/launch/rpc",
    },
    pairedAssets: [],
    launchEnabled: false,
  },
}));

vi.mock("@/lib/zappad/server-config", () => ({
  getVerifiedRuntimeConfig: async () => failClosedConfig,
}));

import { GET } from "./route";

describe("ZapPad runtime config endpoint", () => {
  it("returns the verified fail-closed state with restrictive headers", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(failClosedConfig);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
