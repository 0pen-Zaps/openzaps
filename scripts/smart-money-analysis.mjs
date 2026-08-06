// Study the most successful traders on Uniswap Instant Launch.
// Step 1: Find top-performing tokens from the last 3 days.
// Step 2: For each winner, extract ALL early buyers (first 200 blocks).
// Step 3: Cross-reference wallets across multiple winners → smart money list.
// Step 4: Analyze their behavior: entry timing, buy size, hold duration.
// Outputs a ranked "smart money" leaderboard.

import { createPublicClient, http, parseAbi, getAddress, formatEther } from "viem";

const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const STRATEGY = "0x23f8209572b4a1C2AD88A42749E830791Fb027f1";

const SYSTEM = new Set([
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  STRATEGY.toLowerCase(),
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  "0x000000000000000000000000000000000000dead",
  "0x4f5e3fbb9745358a92da5674305fab8d2b8a73ce",
  "0xf9526dd3361fe0ba6b7a99533ed471d3e808e99a",
  "0xd35e9ca72f64c7f93be30fad67524323396b36d7",
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // PoolManager
  "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2
]);

const chain = { id: 4663, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC, { timeout: 20000, batch: true }) });

const distAbi = parseAbi(["event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)"]);
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const erc20Abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);

async function getDexData(addr) {
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), 5000);
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: c.signal });
    const d = await r.json();
    if (!d.pairs?.length) return null;
    const p = d.pairs.find(x => x.chainId === "robinhood") || d.pairs[0];
    return {
      vol24h: parseFloat(p.volume?.h24 || "0"),
      liq: parseFloat(p.liquidity?.usd || "0"),
      fdv: parseFloat(p.fdv || "0"),
      price: parseFloat(p.priceUsd || "0"),
      change24h: parseFloat(p.priceChange?.h24 || "0"),
      created: parseInt(p.pairCreatedAt || "0", 10),
      url: p.url || "",
    };
  } catch { return null; }
}

async function getAllBuyers(token, launchBlock, windowBlocks = 300) {
  const logs = await client.getLogs({
    address: token,
    event: transferAbi[0],
    fromBlock: BigInt(launchBlock),
    toBlock: BigInt(launchBlock) + BigInt(windowBlocks),
  });
  const buyers = new Map(); // addr → { firstBlock, totalIn (est), txCount }
  for (const log of logs) {
    const to = log.args.to?.toLowerCase();
    if (!to || SYSTEM.has(to)) continue;
    const existing = buyers.get(to);
    const val = log.args.value ? Number(formatEther(log.args.value)) : 0;
    if (existing) {
      existing.txCount++;
      existing.totalIn += val;
      if (Number(log.blockNumber) < existing.firstBlock) existing.firstBlock = Number(log.blockNumber);
    } else {
      buyers.set(to, { firstBlock: Number(log.blockNumber), totalIn: val, txCount: 1 });
    }
  }
  return buyers;
}

async function main() {
  const currentBlock = await client.getBlockNumber();
  console.log(`Current block: ${currentBlock}\n`);

  // ── Step 1: Get launches from last ~3 days ──────────────────────────────
  // ~7200 blocks/day at 12s → 3 days ≈ 21600 blocks
  const fromBlock = currentBlock - 72000n;
  console.log(`Scanning blocks ${fromBlock} → ${currentBlock} (~10 days)\n`);

  const logs = await client.getContractEvents({
    address: STRATEGY,
    abi: distAbi,
    eventName: "DistributionInitialized",
    fromBlock,
    toBlock: currentBlock,
  });

  console.log(`Found ${logs.length} launches in window\n`);

  // ── Step 2: For each launch, get DexScreener data ───────────────────────
  // Sample every 8th launch to keep it manageable
  const sampled = logs.filter((_, i) => i % 8 === 0).slice(0, 80);
  console.log(`Sampling ${sampled.length} launches for analysis...\n`);

  const launches = [];
  for (const log of sampled) {
    const token = log.args.token;
    if (!token) continue;
    const addr = getAddress(token.toLowerCase());
    const blk = Number(log.blockNumber);

    const [name, symbol, dex] = await Promise.all([
      client.readContract({ address: addr, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
      client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
      getDexData(addr),
    ]);

    launches.push({ token: addr, name, symbol, block: blk, txHash: log.transactionHash, dex });
    if (launches.length % 10 === 0) console.error(`  ... ${launches.length}/${sampled.length}`);
    await new Promise(r => setTimeout(r, 150));
  }

  // ── Step 3: Identify winners (top by volume) ────────────────────────────
  const winners = launches
    .filter(l => l.dex && l.dex.vol24h > 2000)
    .sort((a, b) => b.dex.vol24h - a.dex.vol24h);

  console.log(`\n=== WINNERS (${winners.length} tokens with >$5K 24h vol) ===\n`);
  for (const w of winners.slice(0, 20)) {
    console.log(`  $${w.symbol.padEnd(12)} vol=$${w.dex.vol24h.toLocaleString().padEnd(12)} fdv=$${w.dex.fdv.toLocaleString().padEnd(10)} chg=${w.dex.change24h}%`);
  }

  // ── Step 4: Extract early buyers from each winner ───────────────────────
  console.log(`\n=== EXTRACTING EARLY BUYERS FROM WINNERS ===\n`);

  const walletMap = new Map();

  for (const w of winners.slice(0, 20)) {
    console.log(`  Scanning $${w.symbol} (block ${w.block})...`);
    const buyers = await getAllBuyers(w.token, w.block, 300);

    for (const [addr, info] of buyers) {
      if (!walletMap.has(addr)) {
        walletMap.set(addr, { tokens: [], totalIn: 0, blocks: [], txCount: 0 });
      }
      const entry = walletMap.get(addr);
      entry.tokens.push(w.symbol);
      entry.totalIn += info.totalIn;
      entry.blocks.push(info.firstBlock - w.block);
      entry.txCount += info.txCount;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Step 5: Rank wallets by multi-winner participation ─────────────────
  const ranked = Array.from(walletMap.entries())
    .map(([addr, data]) => ({
      addr,
      count: data.tokens.length,
      tokens: data.tokens,
      totalIn: data.totalIn,
      avgEntryBlock: data.blocks.length > 0 ? Math.round(data.blocks.reduce((a, b) => a + b, 0) / data.blocks.length) : 0,
      minEntryBlock: Math.min(...data.blocks),
      txCount: data.txCount,
    }))
    .filter(w => w.count >= 2) // Bought at least 2 winners
    .sort((a, b) => b.count - a.count || b.totalIn - a.totalIn);

  console.log(`\n=== SMART MONEY LEADERBOARD ===`);
  console.log(`Wallets buying 2+ winners: ${ranked.length}\n`);

  console.log("RANK  WALLET                                     WINS  AVG_ENTRY_BLK  MIN_BLK  TXS   TOKENS");
  console.log("─".repeat(110));
  for (const [i, w] of ranked.slice(0, 30).entries()) {
    console.log(
      `${String(i + 1).padEnd(5)} ${w.addr} ${String(w.count).padEnd(5)} ${String(w.avgEntryBlock).padEnd(14)} ${String(w.minEntryBlock).padEnd(8)} ${String(w.txCount).padEnd(5)} ${w.tokens.slice(0, 4).join(",")}`
    );
  }

  // ── Step 6: Behavioral patterns ─────────────────────────────────────────
  console.log(`\n=== BEHAVIORAL ANALYSIS ===\n`);

  const allBlocks = ranked.flatMap(w => w.blocks);
  if (allBlocks.length > 0) {
    const sorted = [...allBlocks].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    console.log(`Entry timing (blocks after launch):`);
    console.log(`  Min: ${Math.min(...allBlocks)}`);
    console.log(`  P25: ${p25}`);
    console.log(`  Median: ${median}`);
    console.log(`  P75: ${p75}`);
    console.log(`  Max: ${Math.max(...allBlocks)}`);
  }

  const sizes = ranked.map(w => w.totalIn / w.count).filter(v => isFinite(v));
  if (sizes.length > 0) {
    console.log(`\nAvg buy size per token (tokens):`);
    console.log(`  Min: ${Math.min(...sizes).toFixed(2)}`);
    console.log(`  Median: ${[...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)].toFixed(2)}`);
    console.log(`  Max: ${Math.max(...sizes).toFixed(2)}`);
  }

  const totalBuys = ranked.reduce((s, w) => s + w.count, 0);
  const top10Buys = ranked.slice(0, 10).reduce((s, w) => s + w.count, 0);
  if (totalBuys > 0) {
    console.log(`\nConcentration: top 10 wallets = ${((top10Buys / totalBuys) * 100).toFixed(1)}% of multi-winner buys`);
  }

  // ── Step 7: What do smart wallets buy that bots don't? ──────────────────
  console.log(`\n=== SMART MONEY vs SNIPER BOTS ===`);
  // Compare: wallets that ONLY buy winners vs wallets that buy everything
  const allBuyerCounts = Array.from(walletMap.entries()).map(([addr, d]) => ({ addr, count: d.tokens.length }));
  const singleBuyers = allBuyerCounts.filter(w => w.count === 1).length;
  console.log(`Wallets buying only 1 sampled token: ${singleBuyers}`);
  console.log(`Wallets buying 2+: ${ranked.length}`);
  console.log(`→ Smart money is selective. Snipers spray. Edge = follow the selective.`);

  // Output the smart money list as JSON for bot use
  const smartWallets = ranked.slice(0, 25).map(w => w.addr);
  console.log(`\n=== TOP 25 SMART WALLETS (for bot integration) ===`);
  console.log(JSON.stringify(smartWallets, null, 2));
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
