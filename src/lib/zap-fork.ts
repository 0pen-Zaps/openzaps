import { formatUnits } from "viem";

import { encodeChain, makeNode, type ChainNode } from "@/lib/blocks";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/deployable";
import { resolveRouteFromStep, routeCatalogReady, type Route } from "@/lib/routes";
import type { ZapPolicyView } from "@/lib/zap";

/**
 * Rebuild a verified single-step capsule as an owner-neutral builder chain.
 *
 * Only fields proven by the onchain snapshot travel: the exact input amount,
 * deployed adapter route and its token pair. Owner, recipient, executor,
 * nonce/salt and prior signatures never enter the returned chain. The new
 * design settles to its future owner's wallet and obtains a fresh live floor at
 * signing time; it does not pretend an old execution intent is reusable.
 */
export function forkChainFromVerifiedPolicy(policy: ZapPolicyView): ChainNode[] | null {
  if (
    !policy.canonicalClone
    || !policy.hashMatches
    || !policy.matchesLiveRoute
    || policy.stepCount !== "1"
    || !policy.step
  ) {
    return null;
  }

  const route = resolveRouteFromStep(
    policy.step.adapter,
    policy.step.tokenIn,
    policy.trackedAssets,
    policy.step.data,
  );
  if (!route || !routeCatalogReady(route.id)) return null;

  const amount = formatUnits(BigInt(policy.step.amountIn), route.tokenIn.decimals);
  const source = sourceFor(route, amount);
  const action = actionFor(route);
  if (!source || !action) return null;

  const nodes: ChainNode[] = [makeNode(source.id, "fork-source", source.params)];
  if (route.kind === "swap" || route.kind === "swap-route" || route.kind === "lp-deposit" || route.kind === "lp-withdraw") {
    nodes.push(makeNode("guard-slippage", "fork-slippage", { bps: DEFAULT_SLIPPAGE_BPS }));
  }
  nodes.push(makeNode(action.id, "fork-action", action.params));

  if (route.kind === "lp-deposit") {
    nodes.push(makeNode("hold-lp", "fork-settle"));
  } else if (route.kind !== "vault-deposit") {
    nodes.push(makeNode("send", "fork-settle", { recipient: "owner wallet" }));
  }
  return nodes;
}

export function forkHrefFromVerifiedPolicy(policy: ZapPolicyView): string | null {
  const chain = forkChainFromVerifiedPolicy(policy);
  return chain ? `/zap?view=design&d=${encodeURIComponent(encodeChain(chain))}` : null;
}

function sourceFor(route: Route, amount: string): { id: string; params: Record<string, string> } | null {
  if (route.kind === "lp-withdraw") {
    return { id: "lp-position", params: { asset: "ozRANGE", amount } };
  }
  if (route.kind === "vault-redeem") {
    return { id: "vault-position", params: { asset: "ozUSDG", amount } };
  }
  return {
    id: "wallet-balance",
    params: { asset: builderSymbol(route.tokenIn.symbol), amount },
  };
}

function actionFor(route: Route): { id: string; params: Record<string, string | number> } | null {
  switch (route.kind) {
    case "swap":
    case "swap-route":
      return { id: "swap", params: { into: builderSymbol(route.tokenOut.symbol), venue: "Uniswap v4" } };
    case "vault-deposit":
      return { id: "supply", params: { market: "ZapVault" } };
    case "vault-redeem":
      return { id: "redeem", params: { vault: "ZapVault" } };
    case "lp-deposit":
      return { id: "add-liquidity", params: { pool: "WETH/USDG", range: "Full range" } };
    case "lp-withdraw":
      return { id: "remove-liquidity", params: { settle: builderSymbol(route.tokenOut.symbol), portion: 100 } };
  }
}

function builderSymbol(symbol: string): string {
  return symbol === "aeWETH" ? "WETH" : symbol;
}
