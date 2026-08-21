import { beforeEach, describe, expect, it, vi } from "vitest";

import { FEE_REWARDS_MANIFEST } from "@/lib/rewards";
import { FEE_REWARDS_2_MANIFEST } from "@/lib/rewards2";

const BLOCK_NUMBER = 36_100_000n;
const BLOCK_HASH = `0x${"a".repeat(64)}` as const;
// A realistic sqrtPriceX96 for the live pool's magnitude (~3.58M HOOKR/ETH).
const SQRT_PRICE = 149_925_983_770_813_717_870_352_760_454_399n;

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getChainId: vi.fn(),
    getBlock: vi.fn(),
    getBytecode: vi.fn(),
    readContract: vi.fn(),
  },
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => clientMock),
    http: vi.fn(() => ({ type: "http" })),
  };
});

import {
  campaign2StakingPulseIsFresh,
  createCampaign2StakingPulseCoalescer,
  fetchCampaign2Preflight,
  fetchCampaign2StakingPulseUncached,
  type Campaign2StakingPulse,
} from "@/lib/rewards2-server";

const address = (value: unknown): string => String(value).toLowerCase();

type ReadCall = {
  address: string;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
};

function happyReadContract(call: ReadCall): unknown {
  const target = address(call.address);
  if (target === address(FEE_REWARDS_MANIFEST.campaign.address) && call.functionName === "finalized") {
    return true;
  }
  if (target === address(FEE_REWARDS_2_MANIFEST.vault.address)) {
    if (call.functionName === "activated") return true;
    if (call.functionName === "balanceOf") return 100n * 10n ** 18n;
  }
  if (target === address(FEE_REWARDS_MANIFEST.source.feeLocker) && call.functionName === "availableFees") {
    return 12_350_534_378_365_823n;
  }
  if (target === address(FEE_REWARDS_2_MANIFEST.hookrPool.poolManager) && call.functionName === "extsload") {
    return `0x${SQRT_PRICE.toString(16).padStart(64, "0")}`;
  }
  throw new Error(`Unexpected read ${call.functionName} on ${call.address}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.getChainId.mockResolvedValue(FEE_REWARDS_2_MANIFEST.chainId);
  clientMock.getBlock.mockResolvedValue({
    number: BLOCK_NUMBER,
    hash: BLOCK_HASH,
    timestamp: 1_786_500_000n,
  });
  clientMock.readContract.mockImplementation((call: ReadCall) => {
    return Promise.resolve(happyReadContract(call));
  });
});

describe("campaign-2 preflight snapshot", () => {
  it("refuses cached homepage staking reads after two minutes or future clock drift", () => {
    const now = Date.parse("2026-08-21T01:00:00.000Z");
    const pulse = {
      readAt: new Date(now - 120_000).toISOString(),
      blockTimestamp: String((now - 120_000) / 1_000),
    } as Campaign2StakingPulse;
    expect(campaign2StakingPulseIsFresh(pulse, now)).toBe(true);
    expect(campaign2StakingPulseIsFresh({ ...pulse, readAt: new Date(now - 120_001).toISOString() }, now)).toBe(false);
    expect(campaign2StakingPulseIsFresh({ ...pulse, blockTimestamp: String((now - 121_000) / 1_000) }, now)).toBe(false);
    expect(campaign2StakingPulseIsFresh({ ...pulse, readAt: new Date(now + 5_001).toISOString() }, now)).toBe(false);
    expect(campaign2StakingPulseIsFresh({ ...pulse, blockTimestamp: String((now + 6_000) / 1_000) }, now)).toBe(false);
    expect(campaign2StakingPulseIsFresh({ ...pulse, readAt: "not-a-date" }, now)).toBe(false);
    expect(campaign2StakingPulseIsFresh({ ...pulse, blockTimestamp: "not-a-block-time" }, now)).toBe(false);
  });

  it("coalesces concurrent RPC work per runtime and resets after rejection", async () => {
    const snapshot = {
      readAt: "2026-08-21T01:00:00.000Z",
      blockTimestamp: "1787274000",
    } as Campaign2StakingPulse;
    let release: ((value: Campaign2StakingPulse) => void) | undefined;
    const read = vi.fn(() => new Promise<Campaign2StakingPulse>((resolve) => {
      release = resolve;
    }));
    const coalesced = createCampaign2StakingPulseCoalescer(read);

    const first = coalesced();
    const second = coalesced();
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    release?.(snapshot);
    await expect(first).resolves.toBe(snapshot);

    const failure = new Error("RPC unavailable");
    read.mockRejectedValueOnce(failure);
    await expect(coalesced()).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(2);

    read.mockResolvedValueOnce(snapshot);
    await expect(coalesced()).resolves.toBe(snapshot);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("reads the homepage staking pulse without touching unrelated campaign-2 legs", async () => {
    const { keccak256 } = await import("viem");
    const campaignCode = "0xc0de03" as const;
    const released = {
      ...FEE_REWARDS_2_MANIFEST,
      deployment: {
        ...FEE_REWARDS_2_MANIFEST.deployment,
        campaign: {
          ...FEE_REWARDS_2_MANIFEST.deployment.campaign,
          runtimeCodeHash: keccak256(campaignCode),
        },
      },
    } as unknown as typeof FEE_REWARDS_2_MANIFEST;
    clientMock.getBytecode.mockResolvedValue(campaignCode);
    clientMock.readContract.mockImplementation((call: ReadCall) => {
      switch (call.functionName) {
        case "STAKING_TOKEN": return Promise.resolve(released.token);
        case "feeSharesFunded": return Promise.resolve(true);
        case "finalized": return Promise.resolve(false);
        case "totalStaked": return Promise.resolve(9_500_000_000n * 10n ** 18n);
        case "startAt": return Promise.resolve(released.deployment.campaign.startAt);
        case "endAt": return Promise.resolve(released.deployment.campaign.endAt);
        case "claimDeadline": return Promise.resolve(released.deployment.campaign.claimDeadline);
        default: throw new Error(`Unexpected minimal staking read ${call.functionName}`);
      }
    });

    const payload = await fetchCampaign2StakingPulseUncached(released);
    expect(payload.blockHash).toBe(BLOCK_HASH);
    expect(payload.campaign.totalStaked).toBe((9_500_000_000n * 10n ** 18n).toString());
    expect(clientMock.readContract).toHaveBeenCalledTimes(7);
    for (const call of clientMock.readContract.mock.calls) {
      expect((call[0] as ReadCall).blockNumber).toBe(BLOCK_NUMBER);
    }
  });

  it("pins every read to one block and passes the runbook preconditions", async () => {
    const payload = await fetchCampaign2Preflight({ ...FEE_REWARDS_2_MANIFEST, deployment: null });

    expect(payload.deployment).toBe("absent");
    expect(payload.headBlock).toBe(BLOCK_NUMBER.toString());
    expect(payload.blockHash).toBe(BLOCK_HASH);
    for (const call of clientMock.readContract.mock.calls) {
      expect((call[0] as ReadCall).blockNumber).toBe(BLOCK_NUMBER);
    }

    const byId = Object.fromEntries(payload.checks.map((check) => [check.id, check]));
    expect(byId["campaign-1-finalized"]?.ok).toBe(true);
    expect(byId["vault-activated"]?.ok).toBe(true);
    expect(byId["pool-initialized"]?.ok).toBe(true);
    expect(byId["sponsor-can-fund"]?.ok).toBe(true);
    expect(payload.live).toBeNull();

    expect(payload.figures.sponsorShares).toBe((100n * 10n ** 18n).toString());
    expect(payload.figures.pendingLockerWeth).toBe("12350534378365823");
    // ~3.58M HOOKR per ETH survives the fixed-point derivation.
    const hookrPerEth = Number(payload.figures.hookrPerEthMilli) / 1000;
    expect(hookrPerEth).toBeGreaterThan(3_400_000);
    expect(hookrPerEth).toBeLessThan(3_700_000);
  });

  it("fails a precondition honestly instead of hiding it", async () => {
    clientMock.readContract.mockImplementation((call: ReadCall) => {
      if (call.functionName === "balanceOf") return Promise.resolve(50n * 10n ** 18n);
      return Promise.resolve(happyReadContract(call));
    });
    const payload = await fetchCampaign2Preflight({ ...FEE_REWARDS_2_MANIFEST, deployment: null });
    const check = payload.checks.find((entry) => entry.id === "sponsor-can-fund");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("cannot fund");
  });

  it("reports an uninitialized pool as a failed check, never a zero price", async () => {
    clientMock.readContract.mockImplementation((call: ReadCall) => {
      if (call.functionName === "extsload") return Promise.resolve(`0x${"0".repeat(64)}`);
      return Promise.resolve(happyReadContract(call));
    });
    const payload = await fetchCampaign2Preflight({ ...FEE_REWARDS_2_MANIFEST, deployment: null });
    const check = payload.checks.find((entry) => entry.id === "pool-initialized");
    expect(check?.ok).toBe(false);
    expect(payload.figures.hookrPerEthMilli).toBe("0");
  });

  it("throws (all-or-nothing) when any pinned read fails", async () => {
    clientMock.readContract.mockImplementation((call: ReadCall) => {
      if (call.functionName === "availableFees") return Promise.reject(new Error("rpc down"));
      return Promise.resolve(happyReadContract(call));
    });
    await expect(fetchCampaign2Preflight()).rejects.toThrow();
  });

  it("verifies runtime hashes and reads both legs when the release is configured", async () => {
    const campaignAddress = "0x1111111111111111111111111111111111111111" as const;
    const hookBlocksAddress = "0x2222222222222222222222222222222222222222" as const;
    const campaignCode = "0xc0de01" as const;
    const hookBlocksCode = "0xc0de02" as const;
    const { keccak256 } = await import("viem");

    const configured = {
      ...FEE_REWARDS_2_MANIFEST,
      deployment: {
        campaign: {
          address: campaignAddress,
          runtimeCodeHash: keccak256(campaignCode),
          startAt: 1_786_600_000n,
          endAt: 1_787_809_600n,
          claimDeadline: 1_790_401_600n,
        },
        hookBlocks: {
          address: hookBlocksAddress,
          runtimeCodeHash: keccak256(hookBlocksCode),
        },
      },
    };

    clientMock.getBytecode.mockImplementation(({ address: target }: { address: string }) =>
      Promise.resolve(address(target) === address(campaignAddress) ? campaignCode : hookBlocksCode),
    );
    clientMock.readContract.mockImplementation((call: ReadCall) => {
      const target = address(call.address);
      if (target === address(hookBlocksAddress)) {
        switch (call.functionName) {
          case "feeSharesFunded": return Promise.resolve(true);
          case "buybackPaused": return Promise.resolve(false);
          case "finalized": return Promise.resolve(false);
          case "feeSharePrincipal": return Promise.resolve(50n * 10n ** 18n);
          case "totalEthSpent": return Promise.resolve(30_000_000_000_000_000n);
          case "totalHookrBought": return Promise.resolve(100_000n * 10n ** 18n);
          case "totalHookrBurned": return Promise.resolve(105_000n * 10n ** 18n);
          case "blockCount": return Promise.resolve(3n);
          case "pendingWeth": return Promise.resolve(1_000_000_000_000_000n);
          case "hookBlock": {
            const index = (call.args?.[0] ?? 0n) as bigint;
            return Promise.resolve({
              ethIn: 10_000_000_000_000_000n + index,
              hookrBought: 35_000n * 10n ** 18n + index,
              burnedAt: 1_787_260_000n + index,
            });
          }
        }
      }
      if (target === address(campaignAddress)) {
        switch (call.functionName) {
          case "feeSharesFunded": return Promise.resolve(true);
          case "finalized": return Promise.resolve(false);
          case "totalStaked": return Promise.resolve(2n * 10n ** 27n);
        }
      }
      return Promise.resolve(happyReadContract(call));
    });

    const payload = await fetchCampaign2Preflight(configured);
    expect(payload.deployment).toBe("configured");
    const byId = Object.fromEntries(payload.checks.map((check) => [check.id, check]));
    expect(byId["runtime-hashes-verified"]?.ok).toBe(true);
    expect(byId["both-legs-funded"]?.ok).toBe(true);
    expect(payload.live?.hookBlocks.blockCount).toBe("3");
    expect(payload.live?.hookBlocks.buybackPaused).toBe(false);
    // Bought and burned are published separately: the burn total includes
    // donated HOOKR, so only the bought figure is an honest rate numerator.
    expect(payload.live?.hookBlocks.totalHookrBought).toBe((100_000n * 10n ** 18n).toString());
    expect(payload.live?.hookBlocks.totalHookrBurned).toBe((105_000n * 10n ** 18n).toString());
    // The ledger tail is read at the same pinned block, most recent first.
    expect(payload.live?.hookBlocks.recentBlocks).toHaveLength(3);
    expect(payload.live?.hookBlocks.recentBlocks[0]?.burnedAt).toBe((1_787_260_000n + 2n).toString());
    expect(payload.live?.campaign.totalStaked).toBe((2n * 10n ** 27n).toString());
  });

  it("refuses to bless a release whose bytecode drifted", async () => {
    const { keccak256 } = await import("viem");
    const configured = {
      ...FEE_REWARDS_2_MANIFEST,
      deployment: {
        campaign: {
          address: "0x1111111111111111111111111111111111111111",
          runtimeCodeHash: keccak256("0xc0de01"),
          startAt: 1n,
          endAt: 2n,
          claimDeadline: 3n,
        },
        hookBlocks: {
          address: "0x2222222222222222222222222222222222222222",
          runtimeCodeHash: keccak256("0xc0de02"),
        },
      },
    };
    clientMock.getBytecode.mockResolvedValue("0xdeadbeef");
    clientMock.readContract.mockImplementation((call: ReadCall) => {
      const target = address(call.address);
      if (target.startsWith("0x1111") || target.startsWith("0x2222")) {
        if (call.functionName === "feeSharesFunded") return Promise.resolve(false);
        if (call.functionName === "buybackPaused") return Promise.resolve(false);
        if (call.functionName === "finalized") return Promise.resolve(false);
        if (call.functionName === "totalStaked") return Promise.resolve(0n);
        return Promise.resolve(0n);
      }
      return Promise.resolve(happyReadContract(call));
    });

    const payload = await fetchCampaign2Preflight(configured);
    const check = payload.checks.find((entry) => entry.id === "runtime-hashes-verified");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("Do not operate");
  });
});
