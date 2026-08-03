import { beforeEach, describe, expect, it, vi } from "vitest";

import { FEE_REWARDS_MANIFEST } from "@/lib/rewards";
import { STAKER_ENUMERATION_LIMIT } from "@/lib/rewards-stakers";

const BLOCK_NUMBER = 25_624_465n;
const BLOCK_HASH = `0x${"a".repeat(64)}` as const;
const REORG_HASH = `0x${"b".repeat(64)}` as const;

const STAKER_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const STAKER_B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const OUTSIDER = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";

const { clientMock, keccak256Mock, cacheState } = vi.hoisted(() => ({
  clientMock: {
    getChainId: vi.fn(),
    getBlock: vi.fn(),
    getBytecode: vi.fn(),
    readContract: vi.fn(),
    getLogs: vi.fn(),
  },
  keccak256Mock: vi.fn(),
  cacheState: { value: null as unknown },
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => clientMock),
    http: vi.fn(() => ({ type: "http" })),
    keccak256: keccak256Mock,
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: (read: () => Promise<unknown>) => async () =>
    cacheState.value ?? read(),
}));

import {
  StaleStakersSnapshotError,
  fetchFeeRewardsStakers,
  fetchFeeRewardsStakersUncached,
} from "@/lib/rewards-stakers-server";

const balances = new Map<string, { balance: bigint; weight: bigint; earned: bigint }>([
  [STAKER_A.toLowerCase(), { balance: 7n, weight: 14n, earned: 3n }],
  [STAKER_B.toLowerCase(), { balance: 4n, weight: 10n, earned: 2n }],
]);

function mockReadContract(call: {
  address: string;
  functionName: string;
  args?: readonly unknown[];
}): unknown {
  if (call.address.toLowerCase() !== FEE_REWARDS_MANIFEST.campaign.address.toLowerCase()) {
    throw new Error(`Unexpected read target: ${call.address}`);
  }
  const account = typeof call.args?.[0] === "string" ? call.args[0].toLowerCase() : null;
  switch (call.functionName) {
    case "totalStaked":
      return 11n;
    case "totalRewardWeight":
      return 24n;
    case "balanceOf":
      return balances.get(account ?? "")?.balance ?? 0n;
    case "rewardWeight":
      return balances.get(account ?? "")?.weight ?? 0n;
    case "earned":
      return balances.get(account ?? "")?.earned ?? 0n;
  }
  throw new Error(`Unexpected read: ${call.functionName}`);
}

function stakedLog(account: string): { args: { account: string } } {
  return { args: { account } };
}

function rewardPaidLog(account: string, amount: bigint): {
  args: { caller: string; account: string; asset: string; amount: bigint };
} {
  return {
    args: {
      caller: account,
      account,
      asset: FEE_REWARDS_MANIFEST.weth,
      amount,
    },
  };
}

function primeHappyPath(): void {
  clientMock.getChainId.mockResolvedValue(FEE_REWARDS_MANIFEST.chainId);
  clientMock.getBlock.mockImplementation((request: { blockTag?: string; blockNumber?: bigint }) =>
    Promise.resolve({
      number: request.blockNumber ?? BLOCK_NUMBER,
      hash: BLOCK_HASH,
      timestamp: 1_785_686_400n,
    }),
  );
  clientMock.getBytecode.mockResolvedValue("0xfeed");
  keccak256Mock.mockReturnValue(FEE_REWARDS_MANIFEST.campaign.runtimeCodeHash);
  clientMock.readContract.mockImplementation((call: never) => Promise.resolve(mockReadContract(call)));
  clientMock.getLogs.mockImplementation((request: { event: { name: string } }) => {
    if (request.event.name === "Staked") {
      return Promise.resolve([stakedLog(STAKER_A), stakedLog(STAKER_B), stakedLog(STAKER_A)]);
    }
    if (request.event.name === "RewardPaid") {
      return Promise.resolve([rewardPaidLog(STAKER_B, 5n)]);
    }
    throw new Error(`Unexpected log query: ${request.event.name}`);
  });
}

describe("fetchFeeRewardsStakersUncached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheState.value = null;
    primeHappyPath();
  });

  it("returns the complete register, pinned and reconciled at one block", async () => {
    const payload = await fetchFeeRewardsStakersUncached();

    expect(payload.headBlock).toBe(BLOCK_NUMBER.toString());
    expect(payload.blockHash).toBe(BLOCK_HASH);
    expect(payload.campaignCodeHash).toBe(FEE_REWARDS_MANIFEST.campaign.runtimeCodeHash);
    expect(payload.totalStaked).toBe("11");
    expect(payload.totalRewardWeight).toBe("24");
    expect(payload.activeStakerCount).toBe(2);
    expect(payload.allTimeStakerCount).toBe(2);
    expect(payload.totalEarnedWeth).toBe("5");
    expect(payload.totalClaimedWeth).toBe("5");
    expect(payload.truncated).toBe(false);
    expect(payload.stakers).toEqual([
      { account: STAKER_A, stakedBalance: "7", rewardWeight: "14", earnedWeth: "3", claimedWeth: "0" },
      { account: STAKER_B, stakedBalance: "4", rewardWeight: "10", earnedWeth: "2", claimedWeth: "5" },
    ]);
    // Log scans are pinned to the same block as every read.
    for (const call of clientMock.getLogs.mock.calls) {
      expect(call[0].fromBlock).toBe(FEE_REWARDS_MANIFEST.campaign.deploymentBlock);
      expect(call[0].toBlock).toBe(BLOCK_NUMBER);
    }
  });

  it("rejects the wrong chain before reading anything else", async () => {
    clientMock.getChainId.mockResolvedValue(1);
    await expect(fetchFeeRewardsStakersUncached()).rejects.toThrow("wrong chain");
  });

  it("rejects a runtime hash that does not match the reviewed release", async () => {
    keccak256Mock.mockReturnValue(`0x${"e".repeat(64)}`);
    await expect(fetchFeeRewardsStakersUncached()).rejects.toThrow(
      "runtime identity does not match",
    );
  });

  it("rejects an enumeration whose balances do not reconcile, instead of a partial list", async () => {
    clientMock.readContract.mockImplementation((call: { functionName: string }) =>
      Promise.resolve(
        call.functionName === "totalStaked" ? 12n : mockReadContract(call as never),
      ),
    );
    await expect(fetchFeeRewardsStakersUncached()).rejects.toThrow("does not reconcile");
  });

  it("rejects a paid claim from outside the enumerated staker set", async () => {
    clientMock.getLogs.mockImplementation((request: { event: { name: string } }) => {
      if (request.event.name === "Staked") {
        return Promise.resolve([stakedLog(STAKER_A), stakedLog(STAKER_B)]);
      }
      return Promise.resolve([rewardPaidLog(OUTSIDER, 1n)]);
    });
    await expect(fetchFeeRewardsStakersUncached()).rejects.toThrow("does not reconcile");
  });

  it("rejects a canonical hash change after the reads", async () => {
    clientMock.getBlock.mockImplementation((request: { blockTag?: string }) =>
      Promise.resolve({
        number: BLOCK_NUMBER,
        hash: request.blockTag === "latest" ? BLOCK_HASH : REORG_HASH,
        timestamp: 1_785_686_400n,
      }),
    );
    await expect(fetchFeeRewardsStakersUncached()).rejects.toThrow(
      "changed during the staker-list read",
    );
  });

  it("fails closed once the staker set exceeds the complete-read bound", async () => {
    const flood = Array.from({ length: STAKER_ENUMERATION_LIMIT + 1 }, (_, index) =>
      stakedLog(`0x${(index + 1).toString(16).padStart(40, "0")}`),
    );
    clientMock.getLogs.mockImplementation((request: { event: { name: string } }) =>
      Promise.resolve(request.event.name === "Staked" ? flood : []),
    );
    await expect(fetchFeeRewardsStakersUncached()).rejects.toThrow("complete-read bound");
  });
});

describe("fetchFeeRewardsStakers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheState.value = null;
    primeHappyPath();
  });

  it("serves a fresh shared snapshot", async () => {
    const payload = await fetchFeeRewardsStakers();
    expect(payload.stakers).toHaveLength(2);
  });

  it("rejects an old shared snapshot instead of serving it as current", async () => {
    cacheState.value = {
      readAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    await expect(fetchFeeRewardsStakers()).rejects.toBeInstanceOf(StaleStakersSnapshotError);
  });
});
