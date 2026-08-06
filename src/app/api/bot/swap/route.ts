import { type NextRequest, NextResponse } from "next/server";
import { serverRateLimit } from "@/lib/relay-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Robinhood chain uses a custom Uniswap routing endpoint
// The standard trading API requires an API key. We proxy through
// our server to keep the key secure and handle chain-specific routing.
//
// Robinhood (4663) is a special case:
// - V4 PoolManager view calls revert (known limitation)
// - No Universal Router deployed on-chain
// - Swaps go through Uniswap's off-chain routing infrastructure
// - The Uniswap Labs API handles this transparently
//
// API reference: https://api.uniswap.org/v2/

const UNISWAP_API = "https://api.uniswap.org/v2";
const WETH = "0x4200000000000000000000000000000000000006";

async function getQuote(params: {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  type: "exactIn" | "exactOut";
  slippage: number;
}) {
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) {
    throw new Error("UNISWAP_API_KEY not configured");
  }

  const url = new URL(`${UNISWAP_API}/quote`);
  url.searchParams.set("tokenInChainId", "4663");
  url.searchParams.set("tokenOutChainId", "4663");
  url.searchParams.set("tokenIn", params.tokenIn === "ETH" ? "ETH" : params.tokenIn);
  url.searchParams.set("tokenOut", params.tokenOut === "ETH" ? "ETH" : params.tokenOut);
  url.searchParams.set("amount", params.amount);
  url.searchParams.set("type", params.type);
  url.searchParams.set("slippageTolerance", (params.slippage / 100).toString());
  url.searchParams.set("protocols", "v4,v3,v2");

  const resp = await fetch(url.toString(), {
    headers: {
      "x-api-key": apiKey,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Uniswap API ${resp.status}: ${err.slice(0, 200)}`);
  }

  return resp.json();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const quota = serverRateLimit(request, "bot-swap", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } });
  }

  const { searchParams } = new URL(request.url);
  const tokenIn = searchParams.get("tokenIn") || "ETH";
  const tokenOut = searchParams.get("tokenOut");
  const amount = searchParams.get("amount");
  const slippage = parseInt(searchParams.get("slippage") || "1500", 10); // bps

  if (!tokenOut || !amount) {
    return NextResponse.json({ error: "Missing tokenOut or amount" }, { status: 400 });
  }

  try {
    const quote = await getQuote({
      tokenIn,
      tokenOut,
      amount,
      type: "exactIn",
      slippage,
    });

    return NextResponse.json({
      quote,
      meta: {
        chainId: 4663,
        tokenIn,
        tokenOut,
        amount,
      },
    }, {
      headers: { "cache-control": "public, s-maxage=5, stale-while-revalidate=15" },
    });
  } catch (e) {
    return NextResponse.json({
      error: "Swap quote unavailable",
      detail: e instanceof Error ? e.message : "Unknown error",
      fallback: "V4 PoolManager direct swap may work for transactions even if view calls fail. Try direct path.",
    }, {
      status: 503,
      headers: { "cache-control": "public, s-maxage=3" },
    });
  }
}

// POST: generate swap transaction calldata
export async function POST(request: NextRequest): Promise<NextResponse> {
  const quota = serverRateLimit(request, "bot-swap-post", 5, RATE_LIMIT_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { tokenIn, tokenOut, amount, slippage = 1500, wallet } = body;

    if (!tokenOut || !amount || !wallet) {
      return NextResponse.json({ error: "Missing required fields: tokenOut, amount, wallet" }, { status: 400 });
    }

    const apiKey = process.env.UNISWAP_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "UNISWAP_API_KEY not configured on server" }, { status: 500 });
    }

    // Use Uniswap swap endpoint to get executable transaction
    const resp = await fetch(`${UNISWAP_API}/swap`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tokenInChainId: 4663,
        tokenOutChainId: 4663,
        tokenIn: tokenIn === "ETH" ? "ETH" : tokenIn,
        tokenOut: tokenOut === "ETH" ? "ETH" : tokenOut,
        amount,
        type: "exactIn",
        slippageTolerance: (slippage / 100).toString(),
        recipient: wallet,
        deadline: Math.floor(Date.now() / 1000) + 1800, // 30 min
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return NextResponse.json({ error: `Uniswap API ${resp.status}`, detail: errText.slice(0, 300) }, { status: 502 });
    }

    const swapData = await resp.json();

    return NextResponse.json({
      swap: swapData,
      meta: { chainId: 4663, tokenIn, tokenOut, amount },
    }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (e) {
    return NextResponse.json({
      error: "Swap generation failed",
      detail: e instanceof Error ? e.message : "Unknown error",
    }, { status: 503 });
  }
}