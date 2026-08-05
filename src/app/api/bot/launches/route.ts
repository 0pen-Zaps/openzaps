import { type NextRequest, NextResponse } from "next/server";

import { serverRateLimit } from "@/lib/relay-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

const RPC_URL = "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const STRATEGY = "0x23f8209572b4a1C2AD88A42749E830791Fb027f1";
const SYSTEM_ADDRESSES = new Set([
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  STRATEGY.toLowerCase(),
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  "0x000000000000000000000000000000000000dead",
  "0x4f5e3fbb9745358a92da5674305fab8d2b8a73ce",
  "0xf9526dd3361fe0ba6b7a99533ed471d3e808e99a",
  "0xd35e9ca72f64c7f93be30fad67524323396b36d7",
  "0x222d6d4f1ce59b0d48d5505114ec8addc90a4359",
  "0x6cc1b74fc1be1ff373fa07f3381856f38103e653",
  "0x7198c32a497c09497e04c86cf8f77a244a9e4b8f",
  "0xdf50f4ea2207f9d2a753a3dae729b36fdef13b23",
]);

interface DexData {
  vol24h: number;
  liq: number;
  fdv: number;
  price: string;
  buys: number;
  sells: number;
  created: number;
  url: string;
  priceChange24h: number;
}

interface LaunchResult {
  token: string;
  name: string;
  symbol: string;
  block: number;
  txHash: string;
  realBuyers: number;
  ageMinutes: number;
  dex: DexData | null;
  score: number;
  decision: "BUY" | "SKIP";
  reason: string;
}

// Scoring: simplified for API (matches bot logic but without async complexities)
function scoreLaunch(buyers: number, name: string, symbol: string): { score: number; decision: "BUY" | "SKIP"; reason: string } {
  if (buyers < 6) return { score: 0, decision: "SKIP", reason: `too_few_buyers_${buyers}` };

  // Spam check
  const spamPatterns = [/^[a-z]{1,2}$/i, /test/i, /spam/i, /^0x[a-f0-9]+$/i, /^[^a-zA-Z]*$/];
  for (const p of spamPatterns) {
    if (p.test(symbol)) return { score: 0, decision: "SKIP", reason: "spam_name" };
  }

  let nameScore = 1;
  const memePatterns = [/frog/i, /pepe/i, /uni/i, /pool/i, /chad/i, /based/i, /ai/i, /agent/i, /meme/i, /defi/i, /swap/i, /inu/i, /cat/i, /doge/i];
  for (const p of memePatterns) {
    if (p.test(name) || p.test(symbol)) { nameScore = 3; break; }
  }

  let buyerScore = buyers >= 25 ? 3 : buyers >= 12 ? 2 : 1;
  const totalScore = buyerScore * 0.35 + (nameScore / 3) * 0.25 + 0.15 + 0.15 + 0.10;
  const scaled = Math.round(totalScore * 10);

  if (scaled >= 6) return { score: scaled, decision: "BUY", reason: "criteria_met" };
  return { score: scaled, decision: "SKIP", reason: `score_${scaled}` };
}

async function fetchLaunches(): Promise<LaunchResult[]> {
  const { createPublicClient, http, parseAbi, getAddress } = await import("viem");

  const client = createPublicClient({
    chain: { id: 4663, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
    transport: http(RPC_URL, { timeout: 15000, batch: true }),
  });

  const currentBlock = await client.getBlockNumber();
  const distAbi = parseAbi(["event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)"]);
  const erc20Abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
  const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

  // Get last 30 launches from current strategy
  const fromBlock = currentBlock - 1000n;
  const logs = await client.getContractEvents({
    address: STRATEGY,
    abi: distAbi,
    eventName: "DistributionInitialized",
    fromBlock,
    toBlock: currentBlock,
  });

  const recent = logs.slice(-30).reverse();
  const results: LaunchResult[] = [];

  for (const log of recent) {
    const tokenAddr = log.args.token;
    if (!tokenAddr) continue;
    const token = getAddress(tokenAddr.toLowerCase());
    const block = Number(log.blockNumber);

    try {
      // Token info + buyers in parallel
      const [nameRes, symbolRes, txLogs] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
        client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        client.getLogs({ address: token, event: transferAbi[0], fromBlock: BigInt(block), toBlock: BigInt(block) + 50n }).catch(() => []),
      ]);

      const buyers = new Set<string>();
      for (const tl of txLogs) {
        const to = (tl.args as { to?: string }).to?.toLowerCase();
        if (to && !SYSTEM_ADDRESSES.has(to)) buyers.add(to);
      }

      // DexScreener
      let dex: DexData | null = null;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await resp.json();
        if (data.pairs?.length) {
          const p = data.pairs.find((x: { chainId: string }) => x.chainId === "robinhood") || data.pairs[0];
          dex = {
            vol24h: parseFloat(p.volume?.h24 || "0"),
            liq: parseFloat(p.liquidity?.usd || "0"),
            fdv: parseFloat(p.fdv || "0"),
            price: p.priceUsd || "0",
            buys: parseInt(p.txns?.h24?.buys || "0", 10),
            sells: parseInt(p.txns?.h24?.sells || "0", 10),
            created: parseInt(p.pairCreatedAt || "0", 10),
            url: p.url || "",
            priceChange24h: parseFloat(p.priceChange?.h24 || "0"),
          };
        }
      } catch { /* DexScreener unavailable */ }

      const ageBlocks = Number(currentBlock) - block;
      const ageMinutes = Math.round((ageBlocks * 12) / 60);

      const { score, decision, reason } = scoreLaunch(buyers.size, nameRes, symbolRes);

      results.push({
        token,
        name: nameRes,
        symbol: symbolRes,
        block,
        txHash: log.transactionHash,
        realBuyers: buyers.size,
        ageMinutes,
        dex,
        score,
        decision,
        reason,
      });
    } catch {
      results.push({
        token,
        name: "ERR",
        symbol: "ERR",
        block,
        txHash: log.transactionHash,
        realBuyers: 0,
        ageMinutes: 0,
        dex: null,
        score: 0,
        decision: "SKIP",
        reason: "read_error",
      });
    }
  }

  return results;
}

// Cache launches for 30s to avoid hammering RPC
let cachedLaunches: LaunchResult[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const quota = serverRateLimit(request, "bot-launches", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } });
  }

  const now = Date.now();
  if (cachedLaunches && now - cacheTimestamp < CACHE_TTL) {
    return NextResponse.json({ launches: cachedLaunches, cached: true, chainId: 4663, strategy: STRATEGY }, { headers: { "cache-control": CACHE } });
  }

  try {
    const launches = await fetchLaunches();
    cachedLaunches = launches;
    cacheTimestamp = now;
    return NextResponse.json({ launches, cached: false, chainId: 4663, strategy: STRATEGY }, { headers: { "cache-control": CACHE } });
  } catch (e) {
    // Return stale cache if available
    if (cachedLaunches) {
      return NextResponse.json({ launches: cachedLaunches, cached: true, stale: true, chainId: 4663, strategy: STRATEGY }, { headers: { "cache-control": "public, s-maxage=10" } });
    }
    return NextResponse.json({ error: "Unable to fetch launch data. Robinhood RPC may be degraded.", launches: [] }, { status: 503, headers: { "cache-control": "public, s-maxage=5" } });
  }
}