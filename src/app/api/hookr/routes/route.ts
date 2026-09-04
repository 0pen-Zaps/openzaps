import { NextResponse } from "next/server";

import { DEFAULT_EXECUTION_POLICY } from "@/lib/execution-policy";
import {
  HOOKR_COORDINATORS,
  HOOKR_HOOK,
  HOOKR_KERNEL_V2,
  HOOKR_TOKEN,
  hookrLpContracts,
  hookrLpContractsState,
  hookrLpPools,
} from "@/lib/hookr-pools";
import { encodeLivePolicyPlan } from "@/lib/live-policy";
import { serverRateLimit } from "@/lib/relay-rate-limit";
import { ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";
import { resolveRouteById } from "@/lib/routes";

export const dynamic = "force-dynamic";

const HOOKR_BUY_ROUTE = "robinhood-v4-weth-hookr";
const DEFAULT_SLIPPAGE_BPS = 150;

/**
 * One-click deep link into the OpenZaps signer. Carries route ids and decimal
 * amounts ONLY — the signer resolves adapters, vaults and calldata from its
 * shipped manifest, so a link can never inject a target. Multi-step policies
 * travel as the same bounded `policy` token the builder emits.
 */
function signLink(
  origin: string,
  steps: readonly { routeId: string; amountIn: string }[],
  slippageBps = DEFAULT_SLIPPAGE_BPS,
): string {
  const params = new URLSearchParams({
    view: "sign",
    src: "build",
    route: steps[0].routeId,
    amount: steps[0].amountIn,
    bps: String(slippageBps),
    maxGas: String(DEFAULT_EXECUTION_POLICY.maxGas),
    maxFeeGwei: String(DEFAULT_EXECUTION_POLICY.maxFeePerGasGwei),
  });
  if (steps.length > 1) params.set("policy", encodeLivePolicyPlan(steps));
  return `${origin}/zap?${params.toString()}`;
}

/**
 * The Hookr integration manifest: every HOOKR-quoted pool this deployment can
 * zap in to, out of, or migrate between, with the exact route ids and
 * ready-made signing links a third-party UI (hookr.fun's included) can render
 * as one-click buttons. Read-only, unauthenticated, fail-closed: a pool with
 * no live route carries no links, and the whole set is `configured: false`
 * until the contracts are deployed and baked.
 *
 * Amounts in the links are placeholders the signer lets the user edit; a
 * caller that knows the user's balance should substitute its own decimal
 * amounts (18-decimal tokens throughout).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const quota = serverRateLimit(request, "hookr-routes", 120, 60_000);
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many reads. Try again shortly." },
      { status: 429, headers: { "cache-control": "no-store, max-age=0", "retry-after": String(quota.retryAfterSeconds) } },
    );
  }

  const origin = new URL(request.url).origin;
  const contracts = hookrLpContracts();
  const state = hookrLpContractsState();
  const configured = state === "configured";
  const buyRoute = resolveRouteById(HOOKR_BUY_ROUTE);

  const pools = hookrLpPools().map((pool) => {
    const zapIn = configured ? resolveRouteById(pool.depositRouteId) : null;
    const zapOut = configured ? resolveRouteById(pool.withdrawRouteId) : null;
    const marketBuy = configured && pool.marketBuyRouteId ? resolveRouteById(pool.marketBuyRouteId) : null;
    const marketSell = configured && pool.marketSellRouteId ? resolveRouteById(pool.marketSellRouteId) : null;
    const live = zapIn !== null && zapOut !== null;
    const tradable = marketBuy !== null && marketSell !== null;
    const quoteAmount = pool.quote === "ETH" ? "0.01" : "10000";
    return {
      key: pool.key,
      symbol: pool.symbol,
      name: pool.name,
      generation: pool.generation,
      quote: pool.quote,
      quoteToken: pool.quoteFaceAddress,
      pool: pool.poolLabel,
      token: pool.token,
      poolId: pool.poolId,
      poolKey: pool.poolKey,
      vault: pool.vaultAddress,
      shareSymbol: pool.shareSymbol,
      live,
      tradable,
      routes: {
        ...(live ? { zapIn: pool.depositRouteId, zapOut: pool.withdrawRouteId } : {}),
        ...(tradable ? { buy: pool.marketBuyRouteId, sell: pool.marketSellRouteId } : {}),
      },
      links: {
        ...(live
          ? {
              zapInFromQuote: signLink(origin, [{ routeId: pool.depositRouteId, amountIn: quoteAmount }]),
              zapOutToQuote: signLink(origin, [{ routeId: pool.withdrawRouteId, amountIn: "1" }]),
            }
          : {}),
        ...(live && pool.quote === "HOOKR" && buyRoute
          ? {
              zapInFromWeth: signLink(origin, [
                { routeId: HOOKR_BUY_ROUTE, amountIn: "0.01" },
                { routeId: pool.depositRouteId, amountIn: "1000000" },
              ]),
            }
          : {}),
        ...(tradable && pool.marketBuyRouteId && pool.marketSellRouteId
          ? {
              buy: signLink(origin, [{ routeId: pool.marketBuyRouteId, amountIn: quoteAmount }]),
              sell: signLink(origin, [{ routeId: pool.marketSellRouteId, amountIn: "1000" }]),
            }
          : {}),
      },
    };
  });

  // Migrations: same-quote pairs carry the quote directly (two steps); a V5 HOOKR-quoted
  // position moving into a native-quoted market sells the HOOKR on its native pool in between
  // (three steps). Every intermediate amount is a placeholder the signer lets the user size.
  const livePools = pools.filter((pool) => pool.live);
  const sellHookrRoute = resolveRouteById("robinhood-v4-hookr-weth");
  const migrations = livePools.flatMap((from) =>
    livePools
      .filter((to) => to.key !== from.key)
      .flatMap((to) => {
        const out = from.routes.zapOut ?? "";
        const inn = to.routes.zapIn ?? "";
        if (from.quote === to.quote) {
          return [{
            from: from.key,
            to: to.key,
            routes: [out, inn],
            link: signLink(origin, [{ routeId: out, amountIn: "1" }, { routeId: inn, amountIn: to.quote === "ETH" ? "0.01" : "10000" }]),
          }];
        }
        if (from.quote === "HOOKR" && to.quote === "ETH" && sellHookrRoute) {
          return [{
            from: from.key,
            to: to.key,
            routes: [out, "robinhood-v4-hookr-weth", inn],
            link: signLink(origin, [
              { routeId: out, amountIn: "1" },
              { routeId: "robinhood-v4-hookr-weth", amountIn: "10000" },
              { routeId: inn, amountIn: "0.01" },
            ]),
          }];
        }
        return [];
      }),
  );

  return NextResponse.json(
    {
      chainId: ROBINHOOD_CHAIN_ID,
      configured,
      contractsState: state,
      hookr: HOOKR_TOKEN,
      generations: {
        v5: { hook: HOOKR_HOOK, quote: "HOOKR" },
        v2: { kernel: HOOKR_KERNEL_V2, coordinators: [HOOKR_COORDINATORS[1], HOOKR_COORDINATORS[2]] },
        v3: { coordinator: HOOKR_COORDINATORS[0], note: "one hook instance per market; admitted by the coordinator's live record" },
      },
      contracts: configured ? contracts : null,
      buy: buyRoute
        ? { route: HOOKR_BUY_ROUTE, link: signLink(origin, [{ routeId: HOOKR_BUY_ROUTE, amountIn: "0.01" }]) }
        : null,
      pools,
      migrations,
      linkFormat: {
        oneStep: "/zap?view=sign&src=build&route=<routeId>&amount=<decimal>&bps=<10..500>&maxGas=<n>&maxFeeGwei=<n>",
        multiStep: "…&policy=<token from encodeLivePolicyPlan([{routeId, amountIn}, …])>",
        note: "Links carry route ids and decimal amounts only; addresses and calldata come from the signer's shipped manifest.",
      },
      docs: `${origin}/docs#hookr`,
    },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
