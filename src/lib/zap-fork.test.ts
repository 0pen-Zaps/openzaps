import { describe, expect, it } from "vitest";

import { forkChainFromVerifiedPolicy } from "@/lib/zap-fork";
import { resolveRouteById } from "@/lib/routes";
import type { ZapPolicyView } from "@/lib/zap";

function policy(routeId: string): ZapPolicyView {
  const route = resolveRouteById(routeId);
  if (!route) throw new Error(`missing route ${routeId}`);
  return {
    owner: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    maxRelayerFeeCap: "0",
    optimization: true,
    trackedAssets: [...route.trackedAssets],
    stepCount: "1",
    step: {
      adapter: route.adapter,
      tokenIn: route.tokenIn.address,
      spender: route.spender,
      amountIn: (10n ** BigInt(route.tokenIn.decimals)).toString(),
      data: route.data === "empty" ? "0x" : (`0x${"0".repeat(64)}` as `0x${string}`),
    },
    policyHash: `0x${"1".repeat(64)}`,
    direction: route.direction,
    routeKind: route.kind,
    inputSymbol: route.tokenIn.symbol,
    outputSymbol: route.tokenOut.symbol,
    hashMatches: true,
    canonicalClone: true,
    matchesLiveRoute: true,
    deviations: [],
  };
}

describe("forking a verified Zap", () => {
  it("copies the exact route and amount but strips recipient identity", () => {
    const chain = forkChainFromVerifiedPolicy(policy("robinhood-v4-weth-zaps"));
    expect(chain?.map((node) => node.blockId)).toEqual(["wallet-balance", "guard-slippage", "swap", "send"]);
    expect(chain?.[0].params).toMatchObject({ asset: "WETH", amount: "1" });
    expect(chain?.at(-1)?.params.recipient).toBe("owner wallet");
    expect(JSON.stringify(chain)).not.toContain("0x2222222222222222222222222222222222222222");
  });

  it("reconstructs the receipt-shaped ozUSDG redemption route", () => {
    const chain = forkChainFromVerifiedPolicy(policy("robinhood-zap-vault-redeem"));
    expect(chain?.map((node) => node.blockId)).toEqual(["vault-position", "redeem", "send"]);
    expect(chain?.[0].params).toEqual({ asset: "ozUSDG", amount: "1" });
  });

  it("refuses an unverified or deviating policy", () => {
    expect(forkChainFromVerifiedPolicy({ ...policy("robinhood-v4-weth-zaps"), hashMatches: false })).toBeNull();
    expect(forkChainFromVerifiedPolicy({ ...policy("robinhood-v4-weth-zaps"), matchesLiveRoute: false })).toBeNull();
  });
});
