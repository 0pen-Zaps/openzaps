import { createPublicClient, http, type Address } from "viem";

import { robinhoodChain } from "@/lib/zappad/chain";
import { LAUNCHER_ABI } from "@/lib/zappad/contracts";
import {
  getRpcUrl,
  getVerifiedRuntimeConfig,
} from "@/lib/zappad/server-config";

const PAGE_SIZE = 50;
const MAX_CONCURRENT_PAGE_READS = 6;

/**
 * Enumerate canonical ZapPad token addresses for crawl discovery.
 *
 * The verified runtime config is the authority boundary: a merely configured
 * address is never enough to publish token detail URLs. Reads are pinned to one
 * block so a launch during enumeration cannot duplicate or skip a token.
 */
export async function fetchZapPadTokenAddresses(
  limit: number,
): Promise<Address[]> {
  const config = await getVerifiedRuntimeConfig();
  if (!config.readEnabled || !config.launcherAddress) return [];
  const launcherAddress = config.launcherAddress;

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(getRpcUrl(), { retryCount: 1 }),
  });
  const blockNumber = await client.getBlockNumber();
  const count = await client.readContract({
    address: launcherAddress,
    abi: LAUNCHER_ABI,
    functionName: "tokenCount",
    blockNumber,
  });
  const cappedCount = Math.min(
    Number(count),
    Math.max(0, Math.trunc(limit)),
  );
  const pageCount = Math.ceil(cappedCount / PAGE_SIZE);
  const pages = new Array<readonly Address[]>(pageCount);
  let nextPage = 0;

  async function worker(): Promise<void> {
    while (true) {
      const pageIndex = nextPage;
      nextPage += 1;
      if (pageIndex >= pageCount) return;
      const offset = pageIndex * PAGE_SIZE;
      const pageSize = Math.min(PAGE_SIZE, cappedCount - offset);
      pages[pageIndex] = await client.readContract({
        address: launcherAddress,
        abi: LAUNCHER_ABI,
        functionName: "launchedTokens",
        args: [BigInt(offset), BigInt(pageSize)],
        blockNumber,
      });
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_PAGE_READS, pageCount) },
      () => worker(),
    ),
  );
  return pages.flat();
}
