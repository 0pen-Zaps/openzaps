import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { readPortfolioLaunchPage } from "./portfolio-data";
import type { LaunchRecord } from "./read-chain";

const ACCOUNT = "0x1000000000000000000000000000000000000001";
const CREATOR = "0x2000000000000000000000000000000000000002";
const TOKEN = "0x3000000000000000000000000000000000000003";
const POOL = "0x4000000000000000000000000000000000000004";
const VAULT = "0x5000000000000000000000000000000000000005";
const PAIR = "0x6000000000000000000000000000000000000006";
const REVENUE_TOKEN =
  "0x7000000000000000000000000000000000000007";

const launch: LaunchRecord = {
  token: TOKEN,
  name: "Older launch",
  symbol: "OLD",
  exists: true,
  creator: CREATOR,
  pool: POOL,
  feeVault: VAULT,
  positionId: 1n,
  pairedAsset: PAIR,
  feeTier: 10_000,
  floorTick: -191_200,
  configHash: `0x${"ab".repeat(32)}`,
  launchedAt: 1_785_000_000n,
  firstBuyAmountIn: 0n,
  firstBuyAmountOut: 0n,
};

describe("portfolio page reads", () => {
  it("retains an older zero-share position when the prior holder still has a claim", async () => {
    const readContract = vi.fn(async (request: {
      address: Address;
      functionName: string;
      blockNumber?: bigint;
    }) => {
      if (request.functionName === "balanceOf") return 0n;
      if (request.functionName === "totalSupply") {
        return 100n * 10n ** 18n;
      }
      if (request.functionName === "claimableAll") {
        return [[REVENUE_TOKEN, PAIR], [5n, 0n]] as const;
      }
      if (request.functionName === "symbol") {
        return request.address.toLowerCase() === REVENUE_TOKEN.toLowerCase()
          ? "OLD"
          : "PAIR";
      }
      if (request.functionName === "decimals") return 18;
      throw new Error(`Unexpected read: ${request.functionName}`);
    });
    const client = { readContract } as unknown as PublicClient;

    const page = await readPortfolioLaunchPage(
      client,
      ACCOUNT,
      [launch],
      12_345n,
    );

    expect(page.created).toEqual([]);
    expect(page.positions).toHaveLength(1);
    expect(page.positions[0]).toMatchObject({
      launch,
      feeShares: 0n,
      claims: [
        expect.objectContaining({
          address: REVENUE_TOKEN,
          amount: 5n,
        }),
        expect.objectContaining({
          address: PAIR,
          amount: 0n,
        }),
      ],
    });
    expect(
      readContract.mock.calls.every(
        ([request]) => request.blockNumber === 12_345n,
      ),
    ).toBe(true);
  });

  it("rejects the whole page on a transient vault read instead of omitting a position", async () => {
    let failBalance = true;
    const readContract = vi.fn(async (request: {
      address: Address;
      functionName: string;
      blockNumber?: bigint;
    }) => {
      if (request.functionName === "balanceOf" && failBalance) {
        throw new Error("transient vault read");
      }
      if (request.functionName === "balanceOf") return 1n;
      if (request.functionName === "totalSupply") return 100n;
      if (request.functionName === "claimableAll") {
        return [[TOKEN, PAIR], [0n, 0n]] as const;
      }
      if (request.functionName === "symbol") return "ASSET";
      if (request.functionName === "decimals") return 18;
      throw new Error(`Unexpected read: ${request.functionName}`);
    });
    const client = { readContract } as unknown as PublicClient;

    await expect(
      readPortfolioLaunchPage(client, ACCOUNT, [launch], 12_345n),
    ).rejects.toThrow("the page was not accepted");

    failBalance = false;
    const retry = await readPortfolioLaunchPage(
      client,
      ACCOUNT,
      [launch],
      12_345n,
    );
    expect(retry.positions).toHaveLength(1);
  });
});
