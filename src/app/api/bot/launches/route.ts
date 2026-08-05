import { type NextRequest, NextResponse } from "next/server";
import { serverRateLimit } from "@/lib/relay-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

const RPC_URL = "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const WETH = "0x4200000000000000000000000000000000000006";
const STRATEGY = "0x23f8209572b4a1C2AD88A42749E830791Fb027f1";
const STRATEGY_FEES_OFF = "0xAD44D55E7f8337C3cE113fBb591486E85be104b2";
const LAUNCHER = "0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0";

const SYSTEM_ADDRESSES = new Set([
  LAUNCHER.toLowerCase(), STRATEGY.toLowerCase(), STRATEGY_FEES_OFF.toLowerCase(),
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  "0x222d6d4f1ce59b0d48d5505114ec8addc90a4359",
  "0x000000000000000000000000000000000000dead",
  "0x4f5e3fbb9745358a92da5674305fab8d2b8a73ce",
  "0xf9526dd3361fe0ba6b7a99533ed471d3e808e99a",
  "0xd35e9ca72f64c7f93be30fad67524323396b36d7",
  "0x6cc1b74fc1be1ff373fa07f3381856f38103e653",
  "0x7198c32a497c09497e04c86cf8f77a244a9e4b8f",
  "0xdf50f4ea2207f9d2a753a3dae729b36fdef13b23",
]);

// ── Types ──────────────────────────────────────────────────────────────────

interface DexData {
  vol5m: number; vol1h: number; vol6h: number; vol24h: number;
  liq: number; fdv: number; mcap: number;
  price: string; priceChange5m: number; priceChange1h: number; priceChange24h: number;
  buys24h: number; sells24h: number; buys1h: number; sells1h: number;
  created: number; url: string; dexId: string;
}

interface ScoreBreakdown {
  buyerCount: number; buyerScore: number; buyerWeight: number;
  nameQuality: number; nameScore: number; nameWeight: number;
  timingBlocks: number | null; timingScore: number; timingWeight: number;
  velocity: number; velocityScore: number; velocityWeight: number;
  diversity: number; diversityScore: number; diversityWeight: number;
}

interface LaunchResult {
  token: string; name: string; symbol: string;
  block: number; txHash: string;
  realBuyers: number; firstBuyerBlock: number | null;
  ageMinutes: number; ageBlocks: number;
  isWethToken0: boolean; supply: string;
  dex: DexData | null;
  score: number; decision: "BUY" | "SKIP"; reason: string;
  scoreBreakdown: ScoreBreakdown;
}

interface LeaderboardEntry {
  token: string; symbol: string; name: string;
  vol24h: number; liq: number; fdv: number; price: string;
  priceChange24h: number; ageHours: number; buys24h: number; sells24h: number;
  realBuyers: number; score: number; url: string;
}

interface AnalyticsResponse {
  launches: LaunchResult[];
  leaderboard: LeaderboardEntry[];
  analytics: {
    totalRecent: number; totalFetched: number;
    avgBuyers: number; medianBuyers: number;
    buySignals: number; withVolume: number;
    scoreDistribution: Record<number, number>;
    buyerDistribution: { bucket: string; count: number }[];
    launchVelocity: number; // launches per hour
    topVolumeSum: number;
  };
  meta: { chainId: number; strategy: string; cached: boolean; stale?: boolean; fetchedAt: number };
}

// ── Scoring engine (high-fidelity) ────────────────────────────────────────

const MEME_PATTERNS = [/frog/i, /pepe/i, /uni/i, /pool/i, /chad/i, /based/i, /ai/i, /agent/i, /meme/i, /defi/i, /swap/i, /inu/i, /cat/i, /doge/i, /wojak/i, /claw/i, /zap/i, /bonk/i, /narwhal/i, /peng/i];
const SPAM_PATTERNS = [/^[a-z]{1,2}$/i, /test/i, /spam/i, /^0x[a-f0-9]+$/i, /^[^a-zA-Z]*$/, /^(.)\1{2,}$/i];
const GIBBERISH = new Set(["daw","fse","fwe","efw","dwa","fef","grt","jkl","qwe","zxc","asd"]);

function computeScore(buyers: number, name: string, symbol: string, firstBuyerBlock: number | null): { score: number; decision: "BUY" | "SKIP"; reason: string; breakdown: ScoreBreakdown } {
  const breakdown: ScoreBreakdown = {
    buyerCount: buyers, buyerScore: 0, buyerWeight: 0.30,
    nameQuality: 0, nameScore: 0, nameWeight: 0.25,
    timingBlocks: firstBuyerBlock, timingScore: 0, timingWeight: 0.15,
    velocity: 0, velocityScore: 0, velocityWeight: 0.15,
    diversity: 0, diversityScore: 0, diversityWeight: 0.15,
  };

  // Disqualifiers
  if (buyers < 5) return { score: 0, decision: "SKIP", reason: "too_few_buyers", breakdown };

  for (const p of SPAM_PATTERNS) {
    if (p.test(symbol)) return { score: 0, decision: "SKIP", reason: "spam_name", breakdown };
  }
  if (symbol.length === 3 && GIBBERISH.has(symbol.toLowerCase())) return { score: 0, decision: "SKIP", reason: "gibberish", breakdown };
  if (symbol.length === 3 && !/[aeiou]/i.test(symbol)) return { score: 0, decision: "SKIP", reason: "consonant_only", breakdown };

  // Buyer score (30%)
  breakdown.buyerScore = buyers >= 30 ? 3 : buyers >= 15 ? 2 : buyers >= 8 ? 1 : 0;

  // Name quality (25%)
  let nameScore = 1;
  for (const p of MEME_PATTERNS) { if (p.test(name) || p.test(symbol)) { nameScore = 3; break; } }
  if (/^[A-Z][a-z]/.test(name)) nameScore = Math.max(nameScore, 2);
  if (name.length >= 8  && name.length <= 24) nameScore = Math.max(nameScore, 2);
  breakdown.nameQuality = nameScore;
  breakdown.nameScore = nameScore;

  // Timing score (15%) — mid-range is organic, too fast = sniper wave
  if (firstBuyerBlock !== null) {
    breakdown.timingScore = (firstBuyerBlock >= 3 && firstBuyerBlock <= 8) ? 3 :
                           (firstBuyerBlock >= 9 && firstBuyerBlock <= 20) ? 2 :
                           (firstBuyerBlock >= 21 && firstBuyerBlock <= 40) ? 1 : 0;
  }

  // Velocity (15%) — estimated buyers per block over 50-block window
  breakdown.velocity = buyers / 50;
  breakdown.velocityScore = breakdown.velocity >= 0.5 ? 3 : breakdown.velocity >= 0.2 ? 2 : breakdown.velocity >= 0.1 ? 1 : 0;

  // Diversity (15%) — more unique buyers = better signal
  breakdown.diversity = buyers;
  breakdown.diversityScore = buyers >= 25 ? 3 : buyers >= 12 ? 2 : 1;

  // Weighted total
  const total =
    (breakdown.buyerScore / 3) * breakdown.buyerWeight +
    (breakdown.nameScore / 3) * breakdown.nameWeight +
    (breakdown.timingScore / 3) * breakdown.timingWeight +
    (breakdown.velocityScore / 3) * breakdown.velocityWeight +
    (breakdown.diversityScore / 3) * breakdown.diversityWeight;

  const scaled = Math.round(total * 10);
  return { score: scaled, decision: scaled >= 6 ? "BUY" : "SKIP", reason: scaled >= 6 ? "criteria_met" : `score_${scaled}`, breakdown };
}

// ── Data fetching ─────────────────────────────────────────────────────────

async function fetchDexData(token: string): Promise<DexData | null> {
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), 5000);
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: c.signal });
    const d = await r.json();
    if (!d.pairs?.length) return null;
    const p = d.pairs.find((x: { chainId: string }) => x.chainId === "robinhood") || d.pairs[0];
    return {
      vol5m: parseFloat(p.volume?.m5 || "0"), vol1h: parseFloat(p.volume?.h1 || "0"),
      vol6h: parseFloat(p.volume?.h6 || "0"), vol24h: parseFloat(p.volume?.h24 || "0"),
      liq: parseFloat(p.liquidity?.usd || "0"), fdv: parseFloat(p.fdv || "0"), mcap: parseFloat(p.marketCap || "0"),
      price: p.priceUsd || "0",
      priceChange5m: parseFloat(p.priceChange?.m5 || "0"), priceChange1h: parseFloat(p.priceChange?.h1 || "0"), priceChange24h: parseFloat(p.priceChange?.h24 || "0"),
      buys24h: parseInt(p.txns?.h24?.buys || "0", 10), sells24h: parseInt(p.txns?.h24?.sells || "0", 10),
      buys1h: parseInt(p.txns?.h1?.buys || "0", 10), sells1h: parseInt(p.txns?.h1?.sells || "0", 10),
      created: parseInt(p.pairCreatedAt || "0", 10), url: p.url || "", dexId: p.dexId || "",
    };
  } catch { return null; }
}

async function fetchLaunches(): Promise<{ launches: LaunchResult[]; leaderboard: LeaderboardEntry[]; analytics: AnalyticsResponse["analytics"] }> {
  const { createPublicClient, http, parseAbi, getAddress } = await import("viem");

  const client = createPublicClient({
    chain: { id: 4663, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
    transport: http(RPC_URL, { timeout: 20000, batch: true }),
  });

  const currentBlock = await client.getBlockNumber();
  const distAbi = parseAbi(["event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)"]);
  const erc20Abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)"]);
  const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

  // Fetch from both strategies + launcher to get broader picture
  const allLogs: { token: string; supply: string; block: bigint; txHash: string }[] = [];

  for (const addr of [STRATEGY, STRATEGY_FEES_OFF]) {
    try {
      const logs = await client.getContractEvents({ address: addr as `0x${string}`, abi: distAbi, eventName: "DistributionInitialized", fromBlock: currentBlock - 2000n, toBlock: currentBlock });
      for (const log of logs) {
        if (log.args.token) allLogs.push({ token: log.args.token, supply: log.args.totalSupply?.toString() || "?", block: log.blockNumber, txHash: log.transactionHash });
      }
    } catch { /* strategy may have no events in window */ }
  }

  allLogs.sort((a, b) => Number(b.block) - Number(a.block));
  const recent = allLogs.slice(0, 60);

  // Process launches in parallel batches of 10
  const launches: LaunchResult[] = [];
  for (let i = 0; i < recent.length; i += 10) {
    const batch = recent.slice(i, i + 10);
    const batchResults = await Promise.all(batch.map(async (log) => {
      const token = getAddress(log.token.toLowerCase());
      const block = Number(log.block);
      try {
        const [nameRes, symbolRes, supplyRes, txLogs] = await Promise.all([
          client.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
          client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
          client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => BigInt(0)),
          client.getLogs({ address: token, event: transferAbi[0], fromBlock: BigInt(block), toBlock: BigInt(block) + 50n }).catch(() => []),
        ]);

        const buyers = new Set<string>();
        let firstBuyerBlock: number | null = null;
        for (const tl of txLogs) {
          const to = (tl.args as { to?: string }).to?.toLowerCase();
          if (to && !SYSTEM_ADDRESSES.has(to)) {
            buyers.add(to);
            const b = Number(tl.blockNumber);
            if (firstBuyerBlock === null || b < firstBuyerBlock) firstBuyerBlock = b;
          }
        }

        const firstBuyerDelta = firstBuyerBlock !== null ? firstBuyerBlock - block : null;
        const ageBlocks = Number(currentBlock) - block;
        const ageMin = Math.round((ageBlocks * 12) / 60);
        const isWethToken0 = true; // Instant Launch always pairs against WETH

        const dex = await fetchDexData(token);

        const { score, decision, reason, breakdown } = computeScore(buyers.size, nameRes, symbolRes, firstBuyerDelta);

        return {
          token, name: nameRes, symbol: symbolRes, block, txHash: log.txHash,
          realBuyers: buyers.size, firstBuyerBlock: firstBuyerDelta,
          ageMinutes: ageMin, ageBlocks, isWethToken0,
          supply: supplyRes?.toString() || "1000000000000000000000000000",
          dex, score, decision, reason, scoreBreakdown: breakdown,
        } satisfies LaunchResult;
      } catch {
        return {
          token, name: "ERR", symbol: "ERR", block, txHash: log.txHash,
          realBuyers: 0, firstBuyerBlock: null, ageMinutes: 0, ageBlocks: 0,
          isWethToken0: true, supply: "?", dex: null,
          score: 0, decision: "SKIP" as const, reason: "read_error",
          scoreBreakdown: { buyerCount: 0, buyerScore: 0, buyerWeight: 0.3, nameQuality: 0, nameScore: 0, nameWeight: 0.25, timingBlocks: null, timingScore: 0, timingWeight: 0.15, velocity: 0, velocityScore: 0, velocityWeight: 0.15, diversity: 0, diversityScore: 0, diversityWeight: 0.15 },
        };
      }
    }));
    launches.push(...batchResults);
  }

  // ── Leaderboard (top by volume across full window) ───────────────────────
  const leaderboard: LeaderboardEntry[] = launches
    .filter(l => l.dex && l.dex.vol24h > 0)
    .sort((a, b) => (b.dex?.vol24h ?? 0) - (a.dex?.vol24h ?? 0))
    .slice(0, 15)
    .map(l => ({
      token: l.token, symbol: l.symbol, name: l.name,
      vol24h: l.dex!.vol24h, liq: l.dex!.liq, fdv: l.dex!.fdv, price: l.dex!.price,
      priceChange24h: l.dex!.priceChange24h, ageHours: l.ageMinutes / 60,
      buys24h: l.dex!.buys24h, sells24h: l.dex!.sells24h,
      realBuyers: l.realBuyers, score: l.score, url: l.dex!.url,
    }));

  // ── Analytics ────────────────────────────────────────────────────────────
  const withBuyers = launches.filter(l => l.realBuyers > 0);
  const buyersSorted = [...withBuyers].map(l => l.realBuyers).sort((a, b) => a - b);

  const scoreDist: Record<number, number> = {};
  for (const l of launches) { scoreDist[l.score] = (scoreDist[l.score] || 0) + 1; }

  const buyerDist = [
    { bucket: "0", count: launches.filter(l => l.realBuyers === 0).length },
    { bucket: "1-2", count: launches.filter(l => l.realBuyers >= 1 && l.realBuyers <= 2).length },
    { bucket: "3-4", count: launches.filter(l => l.realBuyers >= 3 && l.realBuyers <= 4).length },
    { bucket: "5-7", count: launches.filter(l => l.realBuyers >= 5 && l.realBuyers <= 7).length },
    { bucket: "8-14", count: launches.filter(l => l.realBuyers >= 8 && l.realBuyers <= 14).length },
    { bucket: "15-29", count: launches.filter(l => l.realBuyers >= 15 && l.realBuyers <= 29).length },
    { bucket: "30+", count: launches.filter(l => l.realBuyers >= 30).length },
  ];

  // Launch velocity: launches per hour in the window
  const oldestBlock = Math.min(...launches.map(l => l.block));
  const newestBlock = Math.max(...launches.map(l => l.block));
  const blockSpan = newestBlock - oldestBlock || 1;
  const hourSpan = (blockSpan * 12) / 3600 || 0.01;
  const launchVelocity = Math.round(launches.length / hourSpan);

  const analytics = {
    totalRecent: launches.length,
    totalFetched: allLogs.length,
    avgBuyers: withBuyers.length > 0 ? Math.round(withBuyers.reduce((s, l) => s + l.realBuyers, 0) / withBuyers.length) : 0,
    medianBuyers: buyersSorted.length > 0 ? buyersSorted[Math.floor(buyersSorted.length / 2)] : 0,
    buySignals: launches.filter(l => l.decision === "BUY").length,
    withVolume: launches.filter(l => l.dex && l.dex.vol24h > 0).length,
    scoreDistribution: scoreDist,
    buyerDistribution: buyerDist,
    launchVelocity,
    topVolumeSum: launches.reduce((s, l) => s + (l.dex?.vol24h ?? 0), 0),
  };

  return { launches, leaderboard, analytics };
}

// ── Caching ────────────────────────────────────────────────────────────────

let cache: { data: Awaited<ReturnType<typeof fetchLaunches>>; ts: number } | null = null;
const CACHE_TTL = 30_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const quota = serverRateLimit(request, "bot-launches", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } });
  }

  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL) {
    return NextResponse.json({ ...cache.data, meta: { chainId: 4663, strategy: STRATEGY, cached: true, fetchedAt: cache.ts } }, { headers: { "cache-control": CACHE } });
  }

  try {
    const data = await fetchLaunches();
    cache = { data, ts: now };
    return NextResponse.json({ ...data, meta: { chainId: 4663, strategy: STRATEGY, cached: false, fetchedAt: now } }, { headers: { "cache-control": CACHE } });
  } catch (e) {
    if (cache) {
      return NextResponse.json({ ...cache.data, meta: { chainId: 4663, strategy: STRATEGY, cached: true, stale: true, fetchedAt: cache.ts } }, { headers: { "cache-control": "public, s-maxage=10" } });
    }
    return NextResponse.json({ error: "Robinhood RPC degraded", launches: [], leaderboard: [], analytics: null, meta: { chainId: 4663, strategy: STRATEGY, cached: false, fetchedAt: now } }, { status: 503, headers: { "cache-control": "public, s-maxage=5" } });
  }
}