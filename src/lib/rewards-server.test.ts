import { beforeEach, describe, expect, it, vi } from "vitest";

import { FEE_REWARDS_MANIFEST } from "@/lib/rewards";

const BLOCK_NUMBER = 25_624_465n;
const BLOCK_HASH = `0x${"a".repeat(64)}` as const;
const REORG_HASH = `0x${"b".repeat(64)}` as const;
const DOMAIN_HASH = `0x${"d".repeat(64)}` as const;

const { clientMock, keccak256Mock, hashDomainMock, cacheState } = vi.hoisted(() => ({
  clientMock: {
    getChainId: vi.fn(),
    getBlock: vi.fn(),
    getBytecode: vi.fn(),
    readContract: vi.fn(),
  },
  keccak256Mock: vi.fn(),
  hashDomainMock: vi.fn(),
  cacheState: { value: null as unknown },
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => clientMock),
    http: vi.fn(() => ({ type: "http" })),
    keccak256: keccak256Mock,
    hashDomain: hashDomainMock,
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: (read: () => Promise<unknown>) => async () =>
    cacheState.value ?? read(),
}));

import { fetchFeeRewards, fetchFeeRewardsUncached } from "@/lib/rewards-server";

const address = (value: unknown): string => String(value).toLowerCase();

function mockReadContract(call: {
  address: string;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
}): unknown {
  const manifest = FEE_REWARDS_MANIFEST;
  const target = address(call.address);

  if (target === address(manifest.adapter.address)) {
    switch (call.functionName) {
      case "LP_LOCKER_FEE_CONVERSION":
        return manifest.source.lpLockerFeeConversion;
      case "FEE_LOCKER":
        return manifest.source.feeLocker;
      case "isPositionConfigured":
        return true;
    }
  }

  if (target === address(manifest.vault.address)) {
    switch (call.functionName) {
      case "FEE_SOURCE":
        return manifest.adapter.address;
      case "activated":
        return true;
      case "clankerToken":
        return manifest.token;
      case "adminIndex":
        return manifest.source.adminIndex;
      case "initialShareRecipient":
        return manifest.vault.initialShareRecipient;
      case "rewardAssetCount":
        return 1n;
      case "rewardAssets":
        return manifest.weth;
      case "TOTAL_SHARES":
      case "totalSupply":
        return manifest.vault.totalShares;
      case "balanceOf":
        return call.args?.[0] === manifest.campaign.sponsor ? 50n * 10n ** 18n : 4n;
      case "claimable":
      case "accountedRewardBalance":
      case "queuedRewards":
        return 0n;
    }
  }

  if (target === address(manifest.campaign.address)) {
    switch (call.functionName) {
      case "STAKING_TOKEN":
        return manifest.token;
      case "FEE_SHARE_TOKEN":
        return manifest.vault.address;
      case "rewardAssetCount":
        return 1n;
      case "rewardAssets":
        return manifest.weth;
      case "startAt":
        return manifest.campaign.startAt;
      case "endAt":
        return manifest.campaign.endAt;
      case "claimDeadline":
        return manifest.campaign.claimDeadline;
      case "feeSharesFunded":
        return true;
      case "finalized":
      case "rewardsSwept":
        return false;
      case "feeSharePrincipal":
        return manifest.campaign.feeShareAllocation;
      case "sponsor":
        return manifest.campaign.sponsor;
      case "totalStaked":
      case "totalRewardWeight":
        return 11n;
      case "rewardState":
        return [2n, 3n, 5n, 7n] as const;
      case "lastUpdateAt":
        return manifest.campaign.startAt;
      case "balanceOf":
        return 11n;
      case "rewardWeight":
        return 13n;
      case "earned":
        return 17n;
    }
  }

  if (target === address(manifest.token)) {
    switch (call.functionName) {
      case "name":
        return manifest.permit.name;
      case "symbol":
        return "0xZAPS";
      case "decimals":
        return 18;
      case "eip712Domain":
        return [
          "0x0f",
          manifest.permit.name,
          manifest.permit.version,
          BigInt(manifest.chainId),
          manifest.token,
          `0x${"0".repeat(64)}`,
          [],
        ] as const;
      case "DOMAIN_SEPARATOR":
        return DOMAIN_HASH;
      case "balanceOf":
        return 19n;
      case "allowance":
        return 23n;
      case "nonces":
        return 29n;
    }
  }

  if (target === address(manifest.weth) && call.functionName === "balanceOf") {
    return 31n;
  }

  throw new Error(`Unexpected read: ${call.address} ${call.functionName}`);
}

describe("fetchFeeRewardsUncached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheState.value = null;
    clientMock.getChainId.mockResolvedValue(FEE_REWARDS_MANIFEST.chainId);
    clientMock.getBlock.mockImplementation(async (request: { blockTag?: string; blockNumber?: bigint }) => ({
      number: request.blockTag ? BLOCK_NUMBER : request.blockNumber,
      hash: BLOCK_HASH,
      timestamp: FEE_REWARDS_MANIFEST.campaign.startAt - 60n,
    }));
    clientMock.getBytecode.mockImplementation(async ({ address: target }: { address: string }) => {
      if (address(target) === address(FEE_REWARDS_MANIFEST.adapter.address)) return "0x01";
      if (address(target) === address(FEE_REWARDS_MANIFEST.vault.address)) return "0x02";
      if (address(target) === address(FEE_REWARDS_MANIFEST.campaign.address)) return "0x03";
      return undefined;
    });
    clientMock.readContract.mockImplementation(mockReadContract);
    keccak256Mock.mockImplementation((code: string) => {
      if (code === "0x01") return FEE_REWARDS_MANIFEST.adapter.runtimeCodeHash;
      if (code === "0x02") return FEE_REWARDS_MANIFEST.vault.runtimeCodeHash;
      if (code === "0x03") return FEE_REWARDS_MANIFEST.campaign.runtimeCodeHash;
      throw new Error(`Unexpected bytecode: ${code}`);
    });
    hashDomainMock.mockReturnValue(DOMAIN_HASH);
  });

  it("returns one JSON-safe anonymous snapshot with every read pinned", async () => {
    const payload = await fetchFeeRewardsUncached(null);

    expect(payload.phase).toBe("upcoming");
    expect(payload.viewer).toBeNull();
    expect(payload.campaign.feeSharePrincipal).toBe("50000000000000000000");
    expect(payload.campaign.rewardRate).toBe("2");
    expect(payload.vault.totalSupply).toBe("100000000000000000000");
    expect(() => JSON.stringify(payload)).not.toThrow();
    for (const [call] of clientMock.readContract.mock.calls) {
      expect(call.blockNumber).toBe(BLOCK_NUMBER);
    }
    for (const [call] of clientMock.getBytecode.mock.calls) {
      expect(call.blockNumber).toBe(BLOCK_NUMBER);
    }
    expect(clientMock.getBlock).toHaveBeenLastCalledWith({ blockNumber: BLOCK_NUMBER });
  });

  it("includes the complete viewer position at that same block", async () => {
    const viewer = "0x0000000000000000000000000000000000000001";
    const payload = await fetchFeeRewardsUncached(viewer);

    expect(payload.viewer).toEqual({
      account: viewer,
      tokenBalance: "19",
      allowance: "23",
      stakedBalance: "11",
      rewardWeight: "13",
      earnedWeth: "17",
      feeShareBalance: "4",
      directVaultClaimableWeth: "0",
      wethBalance: "31",
      permitNonce: "29",
    });
    for (const [call] of clientMock.readContract.mock.calls) {
      expect(call.blockNumber).toBe(BLOCK_NUMBER);
    }
  });

  it("reuses the verified public snapshot and reads only private viewer state", async () => {
    const snapshot = await fetchFeeRewardsUncached(null);
    cacheState.value = snapshot;
    vi.clearAllMocks();

    const payload = await fetchFeeRewards(
      "0x0000000000000000000000000000000000000001",
    );

    expect(payload.viewer?.earnedWeth).toBe("17");
    expect(clientMock.getBytecode).not.toHaveBeenCalled();
    expect(clientMock.readContract).toHaveBeenCalledTimes(9);
    for (const [call] of clientMock.readContract.mock.calls) {
      expect(call.blockNumber).toBe(BLOCK_NUMBER);
    }
    expect(clientMock.getBlock).toHaveBeenCalledTimes(1);
    expect(clientMock.getBlock).toHaveBeenCalledWith({ blockNumber: BLOCK_NUMBER });
  });

  it("rejects an old shared snapshot before any private wallet reads", async () => {
    const snapshot = await fetchFeeRewardsUncached(null);
    cacheState.value = {
      ...snapshot,
      readAt: new Date(Date.now() - 31_000).toISOString(),
    };
    vi.clearAllMocks();

    await expect(
      fetchFeeRewards("0x0000000000000000000000000000000000000001"),
    ).rejects.toThrow("shared rewards snapshot is too old");
    expect(clientMock.getChainId).not.toHaveBeenCalled();
    expect(clientMock.getBlock).not.toHaveBeenCalled();
    expect(clientMock.readContract).not.toHaveBeenCalled();
  });

  it("rejects a snapshot that ages out while private wallet reads are running", async () => {
    const snapshot = await fetchFeeRewardsUncached(null);
    cacheState.value = snapshot;
    vi.clearAllMocks();
    const acceptedAt = Date.parse(snapshot.readAt) + 1_000;
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(acceptedAt)
      .mockReturnValueOnce(acceptedAt + 31_000);

    try {
      await expect(
        fetchFeeRewards("0x0000000000000000000000000000000000000001"),
      ).rejects.toThrow("shared rewards snapshot is too old");
      expect(clientMock.readContract).toHaveBeenCalled();
      expect(clientMock.getBlock).toHaveBeenCalledWith({ blockNumber: BLOCK_NUMBER });
    } finally {
      now.mockRestore();
    }
  });

  it("rejects a runtime mismatch instead of returning partial state", async () => {
    keccak256Mock.mockReturnValue(`0x${"f".repeat(64)}`);
    await expect(fetchFeeRewardsUncached(null)).rejects.toThrow("runtime identity");
  });

  it("rejects a canonical hash change after the reads", async () => {
    clientMock.getBlock.mockImplementation(async (request: { blockTag?: string; blockNumber?: bigint }) => ({
      number: request.blockTag ? BLOCK_NUMBER : request.blockNumber,
      hash: request.blockTag ? BLOCK_HASH : REORG_HASH,
      timestamp: FEE_REWARDS_MANIFEST.campaign.startAt - 60n,
    }));
    await expect(fetchFeeRewardsUncached(null)).rejects.toThrow("pinned Robinhood block changed");
  });

  it("rejects a single failed contract read instead of substituting zero", async () => {
    clientMock.readContract.mockImplementation((call: Parameters<typeof mockReadContract>[0]) => {
      if (call.functionName === "totalStaked") throw new Error("RPC unavailable");
      return mockReadContract(call);
    });
    await expect(fetchFeeRewardsUncached(null)).rejects.toThrow("RPC unavailable");
  });
});
