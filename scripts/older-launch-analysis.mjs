// Target: established tokens (1-7 days old) from Uniswap Instant Launch.
// Find what separates winners from losers.
// Looks at blocks 28,500,000 - 28,700,000 (roughly 1-3 days ago based on ~12s blocks).

import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const RPC = 'https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2';

const STRATEGIES = [
  { addr: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1', label: 'fees-on',  gen: '2026-08-05' },
  { addr: '0xAD44D55E7f8337C3cE113fBb591486E85be104b2', label: 'fees-off', gen: '2026-08-05' },
];

const distAbi = parseAbi(['event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)']);
const erc20Abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)']);
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const client = createPublicClient({
  chain: { id: 4663, name: 'Robinhood', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 30000, batch: true, batchSize: 10 }),
});

async function getDexData(addr) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    if (d.pairs?.length) {
      const p = d.pairs.find(x => x.chainId === 'robinhood') || d.pairs[0];
      return {
        volume24h: parseFloat(p.volume?.h24 || '0'),
        liquidityUsd: parseFloat(p.liquidity?.usd || '0'),
        fdv: parseFloat(p.fdv || '0'),
        priceUsd: p.priceUsd || '0',
        txns24hBuys: parseInt(p.txns?.h24?.buys || '0'),
        txns24hSells: parseInt(p.txns?.h24?.sells || '0'),
        pairCreatedAt: parseInt(p.pairCreatedAt || '0'),
        url: p.url,
        priceChange24h: parseFloat(p.priceChange?.h24 || '0'),
        volume5m: parseFloat(p.volume?.m5 || '0'),
        volume1h: parseFloat(p.volume?.h1 || '0'),
        volume6h: parseFloat(p.volume?.h6 || '0'),
      };
    }
  } catch {}
  return null;
}

async function main() {
  const currentBlock = await client.getBlockNumber();
  console.error(`Current block: ${currentBlock}\n`);
  
  // Query from ~1 day ago to ~3 days ago
  // At ~12s blocks: 1 day ≈ 7200 blocks, 3 days ≈ 21600 blocks
  const endBlock = currentBlock - 7200n;   // ~1 day ago
  const startBlock = 28500000n;            // ~3-4 days ago
  
  console.error(`Scanning blocks ${startBlock} to ${endBlock} (1-4 days ago)\n`);
  
  const all = [];
  
  for (const s of STRATEGIES) {
    try {
      const logs = await client.getContractEvents({
        address: s.addr, abi: distAbi, eventName: 'DistributionInitialized',
        fromBlock: startBlock, toBlock: endBlock,
      });
      console.error(`  ${s.label} (${s.gen}): ${logs.length} launches`);
      for (const log of logs) {
        all.push({
          token: log.args.token,
          supply: log.args.totalSupply.toString(),
          block: Number(log.blockNumber),
          txHash: log.transactionHash,
          feesLabel: s.label,
          gen: s.gen,
        });
      }
    } catch (e) { console.error(`  ${s.label}: err ${e.shortMessage}`); }
  }
  
  console.error(`\nTotal: ${all.length} launches in window`);
  
  // Limit to manageable number
  const sample = all.slice(0, 80);
  
  console.error(`\nAnalyzing ${sample.length} tokens...\n`);
  
  const results = [];
  
  for (let i = 0; i < sample.length; i++) {
    const l = sample[i];
    const addr = getAddress(l.token.toLowerCase());
    
    const [tokenInfo, dex, buyers] = await Promise.all([
      (async () => {
        try {
          const [name, symbol] = await Promise.all([
            client.readContract({ address: addr, abi: erc20Abi, functionName: 'name' }).catch(() => '?'),
            client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
          ]);
          return { name, symbol };
        } catch { return { name: '?', symbol: '?' }; }
      })(),
      getDexData(addr),
      // Get early buyers (first 100 blocks)
      (async () => {
        try {
          const logs = await client.getLogs({
            address: addr, event: transferAbi[0],
            fromBlock: BigInt(l.block), toBlock: BigInt(l.block) + 100n,
          });
          const buyerSet = new Set();
          for (const log of logs) {
            const to = log.args.to?.toLowerCase();
            if (to && to !== '0x0000000000000000000000000000000000000000') buyerSet.add(to);
          }
          return buyerSet.size;
        } catch { return 0; }
      })(),
    ]);
    
    const ageDays = dex?.pairCreatedAt ? ((Date.now() - dex.pairCreatedAt) / 86400000).toFixed(2) : 'N/A';
    
    results.push({
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      token: addr,
      feesLabel: l.feesLabel,
      launchBlock: l.block,
      ageDays,
      vol24h: dex?.volume24h || 0,
      liq: dex?.liquidityUsd || 0,
      fdv: dex?.fdv || 0,
      price: dex?.priceUsd || '0',
      buys: dex?.txns24hBuys || 0,
      sells: dex?.txns24hSells || 0,
      priceChg24: dex?.priceChange24h || 0,
      earlyBuyers: buyers,
    });
    
    if (i % 10 === 0) console.error(`  [${i+1}/${sample.length}]`);
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Output and analysis
  console.error('\n=== RESULTS ===');
  
  const withDex = results.filter(r => r.vol24h > 0 || r.liq > 0);
  console.error(`DexScreener data: ${withDex.length}/${results.length}`);
  
  const winners = withDex.filter(r => r.vol24h > 5000);
  const mid = withDex.filter(r => r.vol24h > 1000 && r.vol24h <= 5000);
  const small = withDex.filter(r => r.vol24h > 0 && r.vol24h <= 1000);
  const ghosts = results.filter(r => r.vol24h === 0 && r.liq === 0);
  
  console.error(`\nVolume tiers:`);
  console.error(`  >$5k vol: ${winners.length} (WINNERS)`);
  console.error(`  $1k-$5k: ${mid.length}`);
  console.error(`  $0-$1k: ${small.length}`);
  console.error(`  No DexScreener data: ${ghosts.length}`);
  
  if (winners.length > 0) {
    console.error('\n=== WINNERS (>$5k 24h volume) ===');
    for (const r of winners.sort((a,b) => b.vol24h - a.vol24h)) {
      console.error(`  $${r.symbol} | vol=$${r.vol24h.toLocaleString()} | liq=$${r.liq.toLocaleString()} | fdv=$${r.fdv.toLocaleString()} | age=${r.ageDays}d | chg=${r.priceChg24}% | buys=${r.buys}s/${r.sells}s | fees=${r.feesLabel} | early=${r.earlyBuyers}`);
    }
  }
  
  // Aggregate stats
  console.error('\n=== AGGREGATE STATS ===');
  for (const label of ['fees-on', 'fees-off']) {
    const sub = withDex.filter(r => r.feesLabel === label);
    if (sub.length === 0) continue;
    const avgVol = sub.reduce((s,r) => s + r.vol24h, 0) / sub.length;
    const avgLiq = sub.reduce((s,r) => s + r.liq, 0) / sub.length;
    console.error(`  ${label}: ${sub.length} tokens, avg vol=$${avgVol.toFixed(0)}, avg liq=$${avgLiq.toFixed(0)}`);
  }
  
  // Full CSV
  console.error('\n=== CSV OUTPUT ===');
  console.log('symbol,name,token,fees,block,age_days,vol24h,liq,fdv,price,buys,sells,price_chg24,early_buyers');
  for (const r of results.sort((a,b) => b.vol24h - a.vol24h)) {
    console.log(`${r.symbol},${r.name},${r.token},${r.feesLabel},${r.launchBlock},${r.ageDays},${r.vol24h},${r.liq},${r.fdv},${r.price},${r.buys},${r.sells},${r.priceChg24},${r.earlyBuyers}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });