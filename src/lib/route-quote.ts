import type { Address, PublicClient } from "viem";

import { resolveRouteById, type Route } from "@/lib/routes";
import {
  OPENZAP_CREATION_FEE,
  OPENZAP_CREATION_FEE_SLIPPAGE_BPS,
  ROBINHOOD_LIQUIDITY,
  rangeVaultAbi,
  v4QuoterAbi,
  zapVaultAbi,
} from "@/lib/robinhood";

/** A live route estimate plus the quoter's gas estimate when one exists. */
export interface RouteQuoteResult {
  amountOut: bigint;
  gasEstimate: bigint | null;
}

/**
 * Quote one deployed route from the same sources its adapter uses.
 *
 * Swaps are simulated against the pinned v4 quoter. Vault and LP routes use
 * their live preview functions. A zero result is never accepted as a valid
 * quote because each corresponding adapter would revert or produce no usable
 * settlement.
 */
export async function quoteRoute(
  client: PublicClient,
  route: Route,
  amountIn: bigint,
  account: Address,
): Promise<RouteQuoteResult> {
  if (amountIn <= 0n) throw new Error("Enter an amount greater than zero before quoting.");

  if (route.quote.source === "v4") {
    const { result } = await client.simulateContract({
      account,
      address: ROBINHOOD_LIQUIDITY.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: route.quote.poolKey,
          zeroForOne: route.quote.zeroForOne,
          exactAmount: amountIn,
          hookData: "0x",
        },
      ],
    });
    if (result[0] <= 0n) throw new Error("The route quotes to zero output. Try a larger amount.");
    return { amountOut: result[0], gasEstimate: result[1] };
  }

  if (route.quote.source === "v4-route") {
    let carried = amountIn;
    let gasTotal = 0n;
    for (const hop of route.quote.hops) {
      const { result } = await client.simulateContract({
        account,
        address: ROBINHOOD_LIQUIDITY.v4Quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: hop.poolKey,
            zeroForOne: hop.zeroForOne,
            exactAmount: carried,
            hookData: "0x",
          },
        ],
      });
      carried = result[0];
      gasTotal += result[1];
    }
    if (carried <= 0n) throw new Error("The stitched route quotes to zero output. Try a larger amount.");
    return { amountOut: carried, gasEstimate: gasTotal };
  }

  if (route.quote.source === "range-deposit") {
    const swapAmount = amountIn / 2n;
    const keep = amountIn - swapAmount;
    const { result } = await client.simulateContract({
      account,
      address: ROBINHOOD_LIQUIDITY.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: route.quote.poolKey,
          zeroForOne: route.quote.zeroForOne,
          exactAmount: swapAmount,
          hookData: "0x",
        },
      ],
    });
    const swapped = result[0];
    const [amount0, amount1] = route.quote.zeroForOne ? [keep, swapped] : [swapped, keep];
    const [shares] = await client.readContract({
      address: route.quote.vault,
      abi: rangeVaultAbi,
      functionName: "previewDeposit",
      args: [amount0, amount1],
    });
    if (shares <= 0n) {
      throw new Error("The liquidity preview is zero, so this deposit would revert. Try a larger amount.");
    }
    return { amountOut: shares, gasEstimate: null };
  }

  if (route.quote.source === "range-withdraw") {
    const [amount0, amount1] = await client.readContract({
      address: route.quote.vault,
      abi: rangeVaultAbi,
      functionName: "previewRedeem",
      args: [amountIn],
    });
    const target = route.quote.assetOutIsCurrency0 ? amount0 : amount1;
    const offTarget = route.quote.assetOutIsCurrency0 ? amount1 : amount0;
    let swapped = 0n;
    if (offTarget > 0n) {
      const { result } = await client.simulateContract({
        account,
        address: ROBINHOOD_LIQUIDITY.v4Quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: route.quote.poolKey,
            zeroForOne: !route.quote.assetOutIsCurrency0,
            exactAmount: offTarget,
            hookData: "0x",
          },
        ],
      });
      swapped = result[0];
    }
    const amountOut = target + swapped;
    if (amountOut <= 0n) {
      throw new Error("The withdraw preview is zero, so this redeem would revert. Try a larger share amount.");
    }
    return { amountOut, gasEstimate: null };
  }

  const functionName = route.quote.source === "erc4626-deposit" ? "previewDeposit" : "previewRedeem";
  const amountOut = await client.readContract({
    address: route.quote.vault,
    abi: zapVaultAbi,
    functionName,
    args: [amountIn],
  });
  if (amountOut <= 0n) {
    throw new Error("The vault preview is zero, so this deposit or redeem would revert. Try a larger amount.");
  }
  return { amountOut, gasEstimate: null };
}

export interface CreationFeeQuote {
  readonly amountOut: bigint;
  readonly minZapsOut: bigint;
}

/** Quote the immutable native-fee conversion and derive the minimum passed to the gateway. */
export async function quoteCreationFee(client: PublicClient, account: Address): Promise<CreationFeeQuote> {
  const route = resolveRouteById("robinhood-v4-weth-zaps");
  if (!route) throw new Error("The pinned aeWETH to 0xZAPS fee route is unavailable.");
  const { amountOut } = await quoteRoute(client, route, OPENZAP_CREATION_FEE, account);
  const minZapsOut =
    (amountOut * BigInt(10_000 - OPENZAP_CREATION_FEE_SLIPPAGE_BPS)) / 10_000n;
  if (minZapsOut <= 0n) throw new Error("The creation fee quotes to zero 0xZAPS output.");
  return { amountOut, minZapsOut };
}
