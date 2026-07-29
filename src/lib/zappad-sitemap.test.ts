import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const mocks = vi.hoisted(() => {
  const launcher =
    "0x1000000000000000000000000000000000000001" as Address;
  const addresses = Array.from(
    { length: 205 },
    (_, index) =>
      `0x${(index + 1).toString(16).padStart(40, "0")}` as Address,
  );
  let activeReads = 0;
  let maxActiveReads = 0;
  const pageCalls: Array<{
    args: readonly [bigint, bigint];
    blockNumber: bigint;
  }> = [];
  const client = {
    getBlockNumber: vi.fn(async () => 12_345n),
    readContract: vi.fn(async (request: {
      functionName: string;
      args?: readonly [bigint, bigint];
      blockNumber: bigint;
    }) => {
      if (request.functionName === "tokenCount") return 205n;
      const args = request.args;
      if (!args) throw new Error("Missing page arguments");
      pageCalls.push({ args, blockNumber: request.blockNumber });
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeReads -= 1;
      const [offset, limit] = args;
      return addresses.slice(Number(offset), Number(offset + limit));
    }),
  };
  return {
    launcher,
    addresses,
    client,
    pageCalls,
    maxActiveReads: () => maxActiveReads,
  };
});

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => mocks.client,
    http: () => ({}),
  };
});

vi.mock("@/lib/zappad/chain", () => ({
  robinhoodChain: { id: 4_663 },
}));

vi.mock("@/lib/zappad/contracts", () => ({
  LAUNCHER_ABI: [],
}));

vi.mock("@/lib/zappad/server-config", () => ({
  getRpcUrl: () => "https://rpc.example",
  getVerifiedRuntimeConfig: async () => ({
    launcherAddress: mocks.launcher,
    readEnabled: true,
  }),
}));

import { fetchZapPadTokenAddresses } from "./zappad-sitemap";

describe("ZapPad sitemap enumeration", () => {
  it("pins one block, preserves order, and bounds page-read concurrency", async () => {
    const result = await fetchZapPadTokenAddresses(205);

    expect(result).toEqual(mocks.addresses);
    expect(mocks.pageCalls).toHaveLength(5);
    expect(
      mocks.pageCalls.every(({ blockNumber }) => blockNumber === 12_345n),
    ).toBe(true);
    expect(mocks.maxActiveReads()).toBeLessThanOrEqual(6);
  });
});
