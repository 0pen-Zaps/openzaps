import { describe, expect, it, vi } from "vitest";
import { getAddress, zeroAddress } from "viem";

import {
  ACROSS_SPOKE_POOL,
  BRIDGE_ROUTES,
  BridgeQuoteError,
  bridgeFeeBps,
  buildBridgeDeposit,
  fetchBridgeQuote,
  findBridgeRoute,
  MAX_BRIDGE_SPREAD_BPS,
  quoteIsStale,
  type BridgeQuote,
} from "@/lib/bridge";
import { ROBINHOOD_ASSETS, ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";

const ROUTE = BRIDGE_ROUTES[0];
const CAPSULE = getAddress("0x1111111111111111111111111111111111111111");
const DEPOSITOR = getAddress("0x2222222222222222222222222222222222222222");

/**
 * Shape copied from a real `app.across.to/api/suggested-fees` response for
 * 100 USDC Base → Robinhood, read 2026-07-27. Kept verbatim so a change in the
 * upstream contract shows up here as a failure rather than in production.
 */
function quoteBody(overrides: Record<string, unknown> = {}) {
  return {
    outputAmount: "99928619",
    timestamp: "1785138623",
    fillDeadline: "1785145823",
    exclusiveRelayer: "0xFD03AbCAdaF3F930fA4E37Eb2f6ea3A44a41b7F0",
    exclusivityDeadline: 5,
    estimatedFillTimeSec: 1,
    isAmountTooLow: false,
    spokePoolAddress: ACROSS_SPOKE_POOL.origin,
    destinationSpokePoolAddress: ACROSS_SPOKE_POOL.destination,
    limits: { minDeposit: "500089", maxDeposit: "346090153121" },
    outputToken: { address: ROBINHOOD_ASSETS.usdg, symbol: "USDG", decimals: 6, chainId: ROBINHOOD_CHAIN_ID },
    ...overrides,
  };
}

function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body }) as unknown as typeof fetch;
}

async function validQuote(): Promise<BridgeQuote> {
  return fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(quoteBody()));
}

describe("the shipped bridge route table", () => {
  it("delivers USDG at the address and decimals the rest of the app pins", () => {
    expect(ROUTE.outputToken).toBe(ROBINHOOD_ASSETS.usdg);
    expect(ROUTE.outputDecimals).toBe(6);
    expect(ROUTE.inputDecimals).toBe(6);
    expect(ROUTE.destinationChainId).toBe(ROBINHOOD_CHAIN_ID);
  });

  /**
   * THE REGRESSION GUARD. Across's destination SpokePool unwraps unconditionally
   * when `outputToken == wrappedNativeToken` — there is no `code.length` check,
   * so contracts are unwrapped to native ETH exactly like EOAs. On chain 4663
   * the wrapped native token IS aeWETH, and a capsule can never route native
   * ETH. A route delivering aeWETH would therefore fund capsules with a balance
   * only `emergencyExit` can retrieve.
   */
  it("never delivers aeWETH, because the spoke pool would unwrap it to unroutable native ETH", () => {
    for (const route of BRIDGE_ROUTES) {
      expect(route.outputToken).not.toBe(ROBINHOOD_ASSETS.weth);
    }
  });

  it("resolves a known route by id and fails closed on an unknown one", () => {
    expect(findBridgeRoute(ROUTE.id)).toEqual(ROUTE);
    expect(findBridgeRoute("across-base-weth-robinhood-aeweth")).toBeNull();
  });
});

describe("fetchBridgeQuote", () => {
  it("returns the exact output amount the relayer must deliver", async () => {
    const quote = await validQuote();

    expect(quote.outputAmount).toBe(99_928_619n);
    expect(quote.inputAmount).toBe(100_000_000n);
    expect(quote.spokePool).toBe(ACROSS_SPOKE_POOL.origin);
    expect(quote.exclusivityDeadline).toBe(5);
    expect(quote.quoteTimestamp).toBe(1_785_138_623);
  });

  it("refuses a quote naming a different output token", async () => {
    const body = quoteBody({
      outputToken: { address: ROBINHOOD_ASSETS.zaps, symbol: "0xZAPS", decimals: 18, chainId: ROBINHOOD_CHAIN_ID },
    });
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(body))).rejects.toThrow(BridgeQuoteError);
  });

  it("refuses a quote naming a spoke pool this build has not pinned", async () => {
    const body = quoteBody({ spokePoolAddress: "0x000000000000000000000000000000000000dEaD" });
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(body))).rejects.toThrow(
      /not the pinned Base spoke pool/,
    );
  });

  it("refuses a quote whose decimals disagree with the pinned route", async () => {
    const body = quoteBody({
      outputToken: { address: ROBINHOOD_ASSETS.usdg, symbol: "USDG", decimals: 18, chainId: ROBINHOOD_CHAIN_ID },
    });
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(body))).rejects.toThrow(/decimals/);
  });

  it("refuses a quote for a different destination chain", async () => {
    const body = quoteBody({
      outputToken: { address: ROBINHOOD_ASSETS.usdg, symbol: "USDG", decimals: 6, chainId: 8453 },
    });
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(body))).rejects.toThrow(/destination chain/);
  });

  it("refuses a quote that claims more output than input", async () => {
    const body = quoteBody({ outputAmount: "100000001" });
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(body))).rejects.toThrow(/more output than input/);
  });

  it("refuses a zero-output quote rather than depositing into nothing", async () => {
    const body = quoteBody({ outputAmount: "0" });
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(body))).rejects.toThrow(/zero output/);
  });

  /**
   * The floor. Without it every value in [1, inputAmount] is accepted verbatim
   * as the exact output the relayer must deliver, so a crafted 1-unit quote
   * takes the whole deposit and returns dust. Bounding only the "more output
   * than input" direction guards the side that costs nobody anything.
   */
  it("refuses a quote that keeps more than the route's maximum spread", async () => {
    const body = quoteBody({ outputAmount: "1" }); // 100 USDC in, 0.000001 USDG out
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(body))).rejects.toThrow(
      new RegExp(`above the ${MAX_BRIDGE_SPREAD_BPS} bps`),
    );
  });

  it("accepts a spread exactly at the cap and refuses one past it", async () => {
    // 300 bps of 100 USDC (6dp) is 3,000,000 units, so the boundary output is
    // 97 USDG exactly. The comparison is `>`, so the cap itself is allowed.
    const atCap = quoteBody({ outputAmount: String(100_000_000 - 3_000_000) });
    const ok = await fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(atCap));
    expect(bridgeFeeBps(ok)).toBe(MAX_BRIDGE_SPREAD_BPS);

    const pastCap = quoteBody({ outputAmount: String(100_000_000 - 3_010_000) }); // 301 bps
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning(pastCap))).rejects.toThrow(/Refusing to deposit/);
  });

  it("surfaces the bridge's own too-low signal", async () => {
    const body = quoteBody({ isAmountTooLow: true });
    await expect(fetchBridgeQuote(ROUTE, 1n, fetchReturning(body))).rejects.toThrow(/minimum deposit/);
  });

  it("fails closed on a non-OK response instead of guessing a fee", async () => {
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, fetchReturning({}, false, 503))).rejects.toThrow(/503/);
  });

  it("fails closed when the service is unreachable", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(fetchBridgeQuote(ROUTE, 100_000_000n, boom)).rejects.toThrow(/could not be reached/);
  });

  it("rejects a non-positive amount before it ever calls the service", async () => {
    const spy = vi.fn() as unknown as typeof fetch;
    await expect(fetchBridgeQuote(ROUTE, 0n, spy)).rejects.toThrow(/greater than zero/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("buildBridgeDeposit", () => {
  it("sends the deposit to the capsule, not the depositor", async () => {
    const deposit = buildBridgeDeposit(await validQuote(), DEPOSITOR, CAPSULE);

    expect(deposit.address).toBe(ACROSS_SPOKE_POOL.origin);
    expect(deposit.functionName).toBe("depositV3");
    const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destChain] = deposit.args;
    expect(depositor).toBe(DEPOSITOR);
    expect(recipient).toBe(CAPSULE);
    expect(inputToken).toBe(ROUTE.inputToken);
    expect(outputToken).toBe(ROUTE.outputToken);
    expect(inputAmount).toBe(100_000_000n);
    expect(outputAmount).toBe(99_928_619n);
    expect(destChain).toBe(BigInt(ROBINHOOD_CHAIN_ID));
  });

  it("sends an empty message, because a capsule cannot handle an Across callback", async () => {
    const deposit = buildBridgeDeposit(await validQuote(), DEPOSITOR, CAPSULE);
    expect(deposit.args[11]).toBe("0x");
  });

  it("refuses to bridge into the zero address", async () => {
    await expect(async () => buildBridgeDeposit(await validQuote(), DEPOSITOR, zeroAddress)).rejects.toThrow(
      /zero address/,
    );
  });

  it("refuses an amount outside the bridge's own limits", async () => {
    const quote = await validQuote();
    expect(() => buildBridgeDeposit({ ...quote, inputAmount: 1n }, DEPOSITOR, CAPSULE)).toThrow(/minimum deposit/);
    expect(() => buildBridgeDeposit({ ...quote, inputAmount: 10n ** 18n }, DEPOSITOR, CAPSULE)).toThrow(
      /above what the bridge can currently fill/,
    );
  });
});

describe("bridgeFeeBps", () => {
  it("reports the kept spread in basis points", async () => {
    // 100 USDC in, 99.928619 out => 71.381 kept => 7 bps, truncated.
    expect(bridgeFeeBps(await validQuote())).toBe(7);
  });
});

describe("quoteIsStale", () => {
  it("is fresh before the fill deadline and stale from the deadline onward", async () => {
    const quote = await validQuote();
    expect(quoteIsStale(quote, quote.fillDeadline - 1)).toBe(false);
    expect(quoteIsStale(quote, quote.fillDeadline)).toBe(true);
    expect(quoteIsStale(quote, quote.fillDeadline + 3_600)).toBe(true);
  });
});
