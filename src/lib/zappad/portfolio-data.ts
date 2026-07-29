import type { Address, PublicClient } from "viem";
import { ERC20_ABI, FEE_VAULT_ABI } from "./contracts";
import { shortAddress } from "./launch-math";
import type { LaunchRecord } from "./read-chain";

export interface PortfolioPosition {
  launch: LaunchRecord;
  feeShares: bigint;
  totalShares: bigint;
  claims: Array<{
    address: Address;
    symbol: string;
    decimals: number;
    amount: bigint;
  }>;
}

export async function readPortfolioLaunchPage(
  client: PublicClient,
  account: Address,
  launches: LaunchRecord[],
  blockNumber?: bigint,
) {
  const created = launches.filter(
    (launch) => launch.creator.toLowerCase() === account.toLowerCase(),
  );
  const shareRows = await Promise.allSettled(
    launches.map(async (launch): Promise<PortfolioPosition | null> => {
      const [feeShares, totalShares, claimable] = await Promise.all([
        client.readContract({
          address: launch.feeVault,
          abi: FEE_VAULT_ABI,
          functionName: "balanceOf",
          args: [account],
          blockNumber,
        }),
        client.readContract({
          address: launch.feeVault,
          abi: FEE_VAULT_ABI,
          functionName: "totalSupply",
          blockNumber,
        }),
        client.readContract({
          address: launch.feeVault,
          abi: FEE_VAULT_ABI,
          functionName: "claimableAll",
          args: [account],
          blockNumber,
        }),
      ]);
      const [assets, amounts] = claimable;
      if (assets.length !== amounts.length || assets.length !== 2) {
        throw new Error("Fee vault returned an invalid claimable-asset set");
      }
      if (feeShares === 0n && amounts.every((amount) => amount === 0n)) {
        return null;
      }
      const claims = await Promise.all(
        assets.map(async (asset, index) => {
          const [symbol, decimals] = await Promise.all([
            client
              .readContract({
                address: asset,
                abi: ERC20_ABI,
                functionName: "symbol",
                blockNumber,
              })
              .catch(() => shortAddress(asset)),
            client
              .readContract({
                address: asset,
                abi: ERC20_ABI,
                functionName: "decimals",
                blockNumber,
              })
              .catch(() => 18),
          ]);
          return {
            address: asset,
            symbol,
            decimals,
            amount: amounts[index] ?? 0n,
          };
        }),
      );
      return { launch, feeShares, totalShares, claims };
    }),
  );
  const failedRows = shareRows.filter(
    (row) => row.status === "rejected",
  ).length;
  if (failedRows > 0) {
    throw new Error(
      `Unable to verify fee rights for ${failedRows} of ${launches.length} launches${blockNumber == null ? "" : ` at block ${blockNumber}`}; the page was not accepted.`,
    );
  }

  return {
    created,
    positions: shareRows.flatMap((row) =>
      row.status === "fulfilled" && row.value ? [row.value] : [],
    ),
  };
}
