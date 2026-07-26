import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from "viem";

import {
  aggregateWalletPortfolio,
  type PortfolioAssetKind,
  type PortfolioHoldingInput,
  type WalletPortfolioPayload,
} from "@/lib/profile-portfolio";
import { quoteRoute } from "@/lib/route-quote";
import { resolveRouteById } from "@/lib/routes";
import {
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_RPC_URL,
  ROBINHOOD_TOKENS,
  erc20Abi,
  robinhoodChain,
  type TokenInfo,
} from "@/lib/robinhood";

type ValuationPolicy =
  | { kind: "native"; sourceLabel: string }
  | { kind: "route"; routeId: string; sourceLabel: string }
  | { kind: "withheld"; reason: string };

interface TrackedAsset {
  id: string;
  symbol: string;
  name: string;
  address: Address | null;
  decimals: number;
  kind: PortfolioAssetKind;
  valuation: ValuationPolicy;
}

const token = (key: keyof typeof ROBINHOOD_TOKENS): TokenInfo | null => ROBINHOOD_TOKENS[key] ?? null;

const TRACKED_ASSETS = [
  {
    id: "native-eth",
    symbol: "ETH",
    name: "Native ETH",
    address: null,
    decimals: 18,
    kind: "native",
    valuation: { kind: "native", sourceLabel: "Native ETH denomination" },
  },
  trackedToken("weth", token("WETH"), "Wrapped ETH", "token", {
    kind: "native",
    sourceLabel: "aeWETH wrapper denomination (1:1 ETH units)",
  }),
  trackedToken("zaps", token("0xZAPS"), "OpenZaps", "token", {
    kind: "route",
    routeId: "robinhood-v4-zaps-weth",
    sourceLabel: "Pinned 0xZAPS → aeWETH onchain route quote",
  }),
  trackedToken("usdg", token("USDG"), "Global Dollar", "token", {
    kind: "route",
    routeId: "robinhood-v4-usdg-weth",
    sourceLabel: "Pinned USDG → aeWETH onchain route quote",
  }),
  trackedToken("ozusdg", token("ozUSDG"), "OpenZap USDG Vault share", "vault-share", {
    kind: "withheld",
    reason: "Vault-share valuation is withheld until seeded-vault redemption semantics and coverage are proven for this profile.",
  }),
  trackedToken("ozrange", token("ozRANGE"), "OpenZap range-vault share", "lp-share", {
    kind: "withheld",
    reason: "LP-share valuation is withheld; showing wallet shares without a verified two-asset redemption valuation avoids double-counting or a false ETH total.",
  }),
].filter((asset): asset is TrackedAsset => asset !== null);

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/** Read one wallet's curated holdings independently from its event-history index. */
export async function fetchWalletPortfolio(ownerInput: Address): Promise<WalletPortfolioPayload> {
  const owner = getAddress(ownerInput);
  const headBlock = await client.getBlockNumber({ cacheTime: 0 });
  return fetchWalletPortfolioAt(client, owner, headBlock);
}

async function fetchWalletPortfolioAt(
  publicClient: PublicClient,
  owner: Address,
  headBlock: bigint,
): Promise<WalletPortfolioPayload> {
  const balanceResults = await Promise.allSettled(
    TRACKED_ASSETS.map((asset) => readBalance(publicClient, owner, asset, headBlock)),
  );

  const holdings = await Promise.all(TRACKED_ASSETS.map(async (asset, index): Promise<PortfolioHoldingInput> => {
    const balanceResult = balanceResults[index];
    const balance = balanceResult.status === "fulfilled" ? balanceResult.value : null;
    if (balance === null) return holdingInput(asset, null, null, null, null);
    if (balance === 0n) {
      const source = sourceFor(asset);
      return holdingInput(asset, balance, null, source.label, source.url);
    }

    if (asset.valuation.kind === "native") {
      return holdingInput(
        asset,
        balance,
        balance,
        asset.valuation.sourceLabel,
        asset.address ? explorerAddress(asset.address) : null,
      );
    }

    if (asset.valuation.kind === "withheld") {
      return holdingInput(asset, balance, null, null, null, asset.valuation.reason);
    }

    const route = resolveRouteById(asset.valuation.routeId);
    if (!route) {
      return holdingInput(
        asset,
        balance,
        null,
        null,
        null,
        "The configured ETH-denominated route is unavailable, so this balance is unpriced.",
      );
    }

    try {
      const quote = await quoteRoute(publicClient, route, balance, owner);
      return holdingInput(
        asset,
        balance,
        quote.amountOut,
        asset.valuation.sourceLabel,
        explorerAddress(ROBINHOOD_LIQUIDITY.v4Quoter),
        "Executable-size quote at read time; pool price impact is included and this is not a guaranteed future exit value.",
      );
    } catch {
      return holdingInput(
        asset,
        balance,
        null,
        asset.valuation.sourceLabel,
        explorerAddress(ROBINHOOD_LIQUIDITY.v4Quoter),
        "The pinned onchain route quote failed at read time. The balance is retained and excluded from the subtotal.",
      );
    }
  }));

  return aggregateWalletPortfolio({
    owner,
    headBlock,
    updatedAt: new Date().toISOString(),
    holdings,
  });
}

function trackedToken(
  id: string,
  info: TokenInfo | null,
  name: string,
  kind: PortfolioAssetKind,
  valuation: ValuationPolicy,
): TrackedAsset | null {
  if (!info) return null;
  return {
    id,
    symbol: info.symbol,
    name,
    address: info.address,
    decimals: info.decimals,
    kind,
    valuation,
  };
}

async function readBalance(
  publicClient: PublicClient,
  owner: Address,
  asset: TrackedAsset,
  blockNumber: bigint,
): Promise<bigint> {
  if (asset.address === null) return publicClient.getBalance({ address: owner, blockNumber });
  return publicClient.readContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
    blockNumber,
  });
}

function holdingInput(
  asset: TrackedAsset,
  balance: bigint | null,
  valueEth: bigint | null,
  valuationSourceLabel: string | null,
  valuationSourceUrl: string | null,
  unpricedReason: string | null = null,
): PortfolioHoldingInput {
  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    address: asset.address,
    decimals: asset.decimals,
    kind: asset.kind,
    balance,
    valueEth,
    valuationSourceLabel,
    valuationSourceUrl,
    unpricedReason,
  };
}

function sourceFor(asset: TrackedAsset): { label: string | null; url: string | null } {
  if (asset.valuation.kind === "native") {
    return {
      label: asset.valuation.sourceLabel,
      url: asset.address ? explorerAddress(asset.address) : null,
    };
  }
  if (asset.valuation.kind === "route") {
    return {
      label: asset.valuation.sourceLabel,
      url: explorerAddress(ROBINHOOD_LIQUIDITY.v4Quoter),
    };
  }
  return { label: null, url: null };
}

function explorerAddress(address: Address): string {
  return `${ROBINHOOD_EXPLORER_URL}/address/${address}`;
}
