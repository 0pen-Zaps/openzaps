import type { Address, Hex, PublicClient } from "viem";
import { LAUNCHER_ABI, ERC20_ABI } from "./contracts";

export interface LaunchRecord {
  token: Address;
  name: string;
  symbol: string;
  exists: boolean;
  creator: Address;
  pool: Address;
  feeVault: Address;
  positionId: bigint;
  pairedAsset: Address;
  feeTier: number;
  floorTick: number;
  configHash: Hex;
  launchedAt: bigint;
  firstBuyAmountIn: bigint;
  firstBuyAmountOut: bigint;
}

export interface LaunchPage {
  count: bigint;
  launches: LaunchRecord[];
  nextOffset: number;
  hasMore: boolean;
  snapshotBlock: bigint;
}

export async function readLaunch(
  client: PublicClient,
  launcher: Address,
  token: Address,
  blockNumber?: bigint,
): Promise<LaunchRecord> {
  const [name, symbol, launch, provenance] = await Promise.all([
    client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "name",
      blockNumber,
    }),
    client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "symbol",
      blockNumber,
    }),
    client.readContract({
      address: launcher,
      abi: LAUNCHER_ABI,
      functionName: "launches",
      args: [token],
      blockNumber,
    }),
    client.readContract({
      address: launcher,
      abi: LAUNCHER_ABI,
      functionName: "launchProvenance",
      args: [token],
      blockNumber,
    }),
  ]);

  const [
    exists,
    creator,
    pool,
    feeVault,
    positionId,
    pairedAsset,
    feeTier,
    floorTick,
  ] = launch;
  const [configHash, launchedAt, firstBuyAmountIn, firstBuyAmountOut] =
    provenance;

  return {
    token,
    name,
    symbol,
    exists,
    creator,
    pool,
    feeVault,
    positionId,
    pairedAsset,
    feeTier,
    floorTick,
    configHash,
    launchedAt,
    firstBuyAmountIn,
    firstBuyAmountOut,
  };
}

export async function readLatestLaunches(
  client: PublicClient,
  launcher: Address,
  limit = 12,
) {
  const page = await readLaunchPage(client, launcher, 0, limit);
  return { count: page.count, launches: page.launches };
}

export async function readLaunchPage(
  client: PublicClient,
  launcher: Address,
  offset = 0,
  limit = 24,
  snapshotBlock?: bigint,
): Promise<LaunchPage> {
  const blockNumber = snapshotBlock ?? await client.getBlockNumber();
  const count = await client.readContract({
    address: launcher,
    abi: LAUNCHER_ABI,
    functionName: "tokenCount",
    blockNumber,
  });
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const remaining =
    BigInt(safeOffset) < count ? count - BigInt(safeOffset) : 0n;
  const pageSize = Number(
    remaining < BigInt(safeLimit) ? remaining : BigInt(safeLimit),
  );
  if (pageSize === 0) {
    return {
      count,
      launches: [],
      nextOffset: safeOffset,
      hasMore: false,
      snapshotBlock: blockNumber,
    };
  }
  const tokens = await client.readContract({
    address: launcher,
    abi: LAUNCHER_ABI,
    functionName: "launchedTokens",
    args: [BigInt(safeOffset), BigInt(pageSize)],
    blockNumber,
  });

  const settled = await Promise.allSettled(
    tokens.map((token) => readLaunch(client, launcher, token, blockNumber)),
  );
  const failedReads = settled.filter(
    (result) =>
      result.status === "rejected" ||
      (result.status === "fulfilled" && !result.value.exists),
  ).length;
  if (failedReads > 0) {
    throw new Error(
      `Unable to verify ${failedReads} of ${tokens.length} launch records at block ${blockNumber}; the page cursor was not advanced.`,
    );
  }
  const nextOffset = safeOffset + tokens.length;
  return {
    count,
    launches: settled.map((result) => {
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    }),
    nextOffset,
    hasMore: BigInt(nextOffset) < count,
    snapshotBlock: blockNumber,
  };
}
