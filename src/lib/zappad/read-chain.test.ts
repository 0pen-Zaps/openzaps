import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { readLaunchPage } from "./read-chain";

const LAUNCHER = "0x1000000000000000000000000000000000000001";
const CREATOR = "0x2000000000000000000000000000000000000002";
const POOL = "0x3000000000000000000000000000000000000003";
const PAIR = "0x4000000000000000000000000000000000000004";

function addressFor(value: number): Address {
  return `0x${value.toString(16).padStart(40, "0")}` as Address;
}

describe("paginated launch reads", () => {
  it("reads launches beyond the first 24 without repeating or dropping tokens", async () => {
    const newestTokens = Array.from({ length: 30 }, (_, index) =>
      addressFor(1_000 + index),
    );
    const readContract = vi.fn(async (request: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) => {
      if (request.functionName === "tokenCount") return 30n;
      if (request.functionName === "launchedTokens") {
        const [offset, limit] = request.args as readonly [bigint, bigint];
        return newestTokens.slice(Number(offset), Number(offset + limit));
      }
      const tokenIndex = newestTokens.findIndex(
        (token) => token.toLowerCase() === request.address.toLowerCase(),
      );
      if (request.functionName === "name") return `Token ${tokenIndex}`;
      if (request.functionName === "symbol") return `T${tokenIndex}`;
      if (request.functionName === "launches") {
        return [
          true,
          CREATOR,
          POOL,
          addressFor(2_000 + tokenIndex),
          BigInt(tokenIndex + 1),
          PAIR,
          10_000,
          -191_200,
        ] as const;
      }
      if (request.functionName === "launchProvenance") {
        return [
          `0x${"ab".repeat(32)}`,
          1_785_000_000n + BigInt(tokenIndex),
          0n,
          0n,
        ] as const;
      }
      throw new Error(`Unexpected read: ${request.functionName}`);
    });
    const getBlockNumber = vi.fn(async () => 12_345n);
    const client = { getBlockNumber, readContract } as unknown as PublicClient;

    const first = await readLaunchPage(client, LAUNCHER, 0, 24);
    const second = await readLaunchPage(
      client,
      LAUNCHER,
      first.nextOffset,
      24,
      first.snapshotBlock,
    );

    expect(first.count).toBe(30n);
    expect(first.snapshotBlock).toBe(12_345n);
    expect(second.snapshotBlock).toBe(first.snapshotBlock);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    expect(first.nextOffset).toBe(24);
    expect(first.hasMore).toBe(true);
    expect(first.launches.map((launch) => launch.token)).toEqual(
      newestTokens.slice(0, 24),
    );
    expect(second.nextOffset).toBe(30);
    expect(second.hasMore).toBe(false);
    expect(second.launches.map((launch) => launch.token)).toEqual(
      newestTokens.slice(24),
    );
    expect(
      new Set(
        [...first.launches, ...second.launches].map((launch) =>
          launch.token.toLowerCase(),
        ),
      ).size,
    ).toBe(30);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "launchedTokens",
        args: [24n, 6n],
        blockNumber: 12_345n,
      }),
    );
    expect(
      readContract.mock.calls.every(
        ([request]) => request.blockNumber === 12_345n,
      ),
    ).toBe(true);
  });

  it("does not advance a page when one launch detail read fails transiently", async () => {
    const tokens = [addressFor(3_001), addressFor(3_002)];
    let failSecondName = true;
    const readContract = vi.fn(async (request: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) => {
      if (request.functionName === "tokenCount") return 2n;
      if (request.functionName === "launchedTokens") return tokens;
      const tokenIndex = tokens.findIndex(
        (token) => token.toLowerCase() === request.address.toLowerCase(),
      );
      if (
        request.functionName === "name" &&
        tokenIndex === 1 &&
        failSecondName
      ) {
        throw new Error("transient archive read");
      }
      if (request.functionName === "name") return `Token ${tokenIndex}`;
      if (request.functionName === "symbol") return `T${tokenIndex}`;
      if (request.functionName === "launches") {
        return [
          true,
          CREATOR,
          POOL,
          addressFor(4_000 + tokenIndex),
          BigInt(tokenIndex + 1),
          PAIR,
          10_000,
          -191_200,
        ] as const;
      }
      if (request.functionName === "launchProvenance") {
        return [
          `0x${"cd".repeat(32)}`,
          1_785_000_000n + BigInt(tokenIndex),
          0n,
          0n,
        ] as const;
      }
      throw new Error(`Unexpected read: ${request.functionName}`);
    });
    const client = {
      getBlockNumber: vi.fn(async () => 55_555n),
      readContract,
    } as unknown as PublicClient;

    await expect(readLaunchPage(client, LAUNCHER, 0, 24)).rejects.toThrow(
      "the page cursor was not advanced",
    );

    failSecondName = false;
    const retry = await readLaunchPage(client, LAUNCHER, 0, 24, 55_555n);
    expect(retry.nextOffset).toBe(2);
    expect(retry.hasMore).toBe(false);
    expect(retry.launches.map((record) => record.token)).toEqual(tokens);
  });
});
