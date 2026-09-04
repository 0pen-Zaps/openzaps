import { NextResponse } from "next/server";

import { DEFAULT_EXECUTION_POLICY } from "@/lib/execution-policy";
import {
  HOOKR_HOOK,
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
    const live = zapIn !== null && zapOut !== null;
    return {
      key: pool.key,
      symbol: pool.symbol,
      name: pool.name,
      pool: pool.poolLabel,
      token: pool.token,
      poolId: pool.poolId,
      poolKey: pool.poolKey,
      vault: pool.vaultAddress,
      shareSymbol: pool.shareSymbol,
      live,
      routes: live ? { zapIn: pool.depositRouteId, zapOut: pool.withdrawRouteId } : null,
      links: live
        ? {
            zapInFromHookr: signLink(origin, [{ routeId: pool.depositRouteId, amountIn: "10000" }]),
            zapInFromWeth: buyRoute
              ? signLink(origin, [
                  { routeId: HOOKR_BUY_ROUTE, amountIn: "0.01" },
                  { routeId: pool.depositRouteId, amountIn: "1000000" },
                ])
              : null,
            zapOutToHookr: signLink(origin, [{ routeId: pool.withdrawRouteId, amountIn: "1" }]),
          }
        : null,
    };
  });

  const livePools = pools.filter((pool) => pool.live);
  const migrations = livePools.flatMap((from) =>
    livePools
      .filter((to) => to.key !== from.key)
      .map((to) => ({
        from: from.key,
        to: to.key,
        routes: [from.routes?.zapOut ?? "", to.routes?.zapIn ?? ""],
        link: signLink(origin, [
          { routeId: from.routes?.zapOut ?? "", amountIn: "1" },
          { routeId: to.routes?.zapIn ?? "", amountIn: "10000" },
        ]),
      })),
  );

  return NextResponse.json(
    {
      chainId: ROBINHOOD_CHAIN_ID,
      configured,
      contractsState: state,
      hookr: HOOKR_TOKEN,
      hook: HOOKR_HOOK,
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
