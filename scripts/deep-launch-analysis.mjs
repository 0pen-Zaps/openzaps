// Deep analysis of established (1+ day old) Uniswap Instant Launch tokens.
// Focus: what separates successful launches from failures.
// Outputs full JSON report + summary stats.

import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const RPC = 'https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2';

const STRATEGIES = [
  { addr: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1', label: 'fees-on',  gen: '2026-08-05' },
  { addr: '0xAD44D55E7f8337C3cE113fBb591486E85be104b2', label: 'fees-off', gen: '2026-08-05' },
  { addr: '0x3f556B542105D5EFBBefe7C766a4919C76B960Fb', label: 'fees-on',  gen: 'v3.1.1' },
  { addr: '0x36bdB859518C89F764337cd5C24762d2Aa650f3C', label: 'fees-off', gen: 'v3.1.1' },
  { addr: '0x9F67B864B565966dfCc2E0C6bA2483b2D5fF4b00', label: 'fees-on',  gen: '3e05da8' },
  { addr: '0x16b63f1c8415FD68591c31FB3c6796a333DD640C', label: 'fees-off', gen: '3e05da8' },
  { addr: '0xcE57498D3474DCC244dFb6710fFbE6D4441cD2b2', label: 'fees-on',  gen: '8e40a35' },
  { addr: '0x583a7903152b95831e82ffF534448Dee081754ec', label: 'fees-off', gen: '8e40a35' },
  { addr: '0x60D73b21cDf2EA846ab3d58699BBbb8F29d72491', label: 'fees-on',  gen: 'c3f9506' },
  { addr: '0xFCe92C70f1fc017b72f6DD7a00D9E38725C7fBd1', label: 'fees-off', gen: 'c3f9506' },
];

const LIQUIDITY_LAUNCHER = '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0';

const distAbi = parseAbi(['event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)']);
const tokenLaunchedAbi = parseAbi(['event TokenLaunched(bytes32 indexed poolId, address indexed token, address indexed finalPositionRecipient, (address currency0, address currency1, uint24 fee, int24 tickSpacing, bytes hooks) key)']);
const erc20Abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function decimals() view returns (uint8)']);
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const launcherAbi = parseAbi(['event TokenCreated(address indexed tokenAddress)']);
const strategyAbi = parseAbi(['function beneficiaryVault() view returns (address)', 'function feeSplitter() view returns (address)']);

const client = createPublicClient({
  chain: { id: 4663, name: 'Robinhood', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 30000, batch: true }),
});

async function getDexData(addr) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
    const d = await r.json();
    if (d.pairs?.length) {
      const p = d.pairs.find(x => x.chainId === 'robinhood') || d.pairs[0];
      return {
        volume24h: parseFloat(p.volume?.h24 || '0'),
        liquidityUsd: parseFloat(p.liquidity?.usd || '0'),
        fdv: parseFloat(p.fdv || '0'),
        marketCap: parseFloat(p.marketCap || '0'),
        priceUsd: p.priceUsd || '0',
        txns24hBuys: parseInt(p.txns?.h24?.buys || '0'),
        txns24hSells: parseInt(p.txns?.h24?.sells || '0'),
        pairCreatedAt: parseInt(p.pairCreatedAt || '0'),
        url: p.url,
        priceChange24h: parseFloat(p.priceChange?.h24 || '0'),
      };
    }
  } catch {}
  return null;
}

async function getCreatorAddress(tokenAddr, launchBlock) {
  // Get TokenCreated event from launcher
  try {
    const logs = await client.getLogs({
      address: LIQUIDITY_LAUNCHER,
      event: launcherAbi[0],
      fromBlock: launchBlock,
      toBlock: launchBlock,
    });
    // The creator is the tx sender — we need to get the transaction
    return null; // Need tx-level data
  } catch { return null; }
}

async function getEarlyBuyersDetailed(tokenAddr, launchBlock) {
  try {
    // Get transfers in the first 200 blocks
    const logs = await client.getLogs({
      address: tokenAddr,
      event: transferAbi[0],
      fromBlock: launchBlock,
      toBlock: launchBlock + 200n,
    });
    
    const buyers = new Map();
    for (const log of logs) {
      const from = log.args.from?.toLowerCase();
      const to = log.args.to?.toLowerCase();
      if (to && to !== '0x0000000000000000000000000000000000000000' && to !== LIQUIDITY_LAUNCHER.toLowerCase()) {
        const existing = buyers.get(to);
        if (!existing) {
          buyers.set(to, {
            address: getAddress(to),
            firstBlock: Number(log.blockNumber),
            blocksAfterLaunch: Number(log.blockNumber) - Number(launchBlock),
            txHash: log.transactionHash,
          });
        }
      }
    }
    
    return {
      uniqueBuyers: buyers.size,
      buyers: Array.from(buyers.values()).sort((a, b) => a.blocksAfterLaunch - b.blocksAfterLaunch),
    };
  } catch (e) {
    return { uniqueBuyers: 0, buyers: [], error: e.shortMessage };
  }
}

async function main() {
  const currentBlock = await client.getBlockNumber();
  const limit = parseInt(process.argv[2]) || 100;
  
  console.error(`Block: ${currentBlock}\n`);
  
  // Gather all DistributionInitialized events
  const all = [];
  const seen = new Set();
  
  for (const s of STRATEGIES) {
    try {
      const logs = await client.getContractEvents({
        address: s.addr, abi: distAbi, eventName: 'DistributionInitialized',
        fromBlock: 0n, toBlock: currentBlock,
      });
      console.error(`  ${s.label} (${s.gen}): ${logs.length} launches`);
      for (const log of logs) {
        const key = log.args.token.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          all.push({
            token: log.args.token,
            supply: log.args.totalSupply.toString(),
            block: Number(log.blockNumber),
            txHash: log.transactionHash,
            feesLabel: s.label,
            gen: s.gen,
            strategyAddr: s.addr,
          });
        }
      }
    } catch (e) { console.error(`  ${s.label} (${s.gen}): err ${e.shortMessage}`); }
  }
  
  console.error(`\nTotal unique launches: ${all.length}`);
  
  // Sort and sample: get tokens from ~200-2000 blocks ago, 5000-10000 blocks ago, and 20000+ blocks ago
  all.sort((a,b) => b.block - a.block);
  
  // Take a diverse sample: recent (200-1000), mid (3000-8000), old (15000+)
  const recent = all.filter(a => a.block >= Number(currentBlock) - 5000 && a.block <= Number(currentBlock) - 200);
  const mid = all.filter(a => a.block >= Number(currentBlock) - 15000 && a.block < Number(currentBlock) - 5000);
  const old = all.filter(a => a.block < Number(currentBlock) - 15000);
  
  // Sample from each
  const sample = [
    ...recent.slice(0, 40),
    ...mid.slice(0, 30),
    ...old.slice(0, 30),
  ];
  
  console.error(`\nSample: ${sample.length} tokens (${recent.length}R/${mid.length}M/${old.length}O)\n`);
  console.error('Analyzing...\n');
  
  const results = [];
  
  for (let i = 0; i < sample.length; i++) {
    const l = sample[i];
    const addr = getAddress(l.token.toLowerCase());
    
    console.error(`[${i+1}/${sample.length}] block ${l.block} — $${'...'}`);
    
    const [tokenInfo, dex, buyers, tokenLaunched] = await Promise.all([
      (async () => {
        const [name, symbol, supply, decimals] = await Promise.all([
          client.readContract({ address: addr, abi: erc20Abi, functionName: 'name' }).catch(() => '?'),
          client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
          client.readContract({ address: addr, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => 0n),
          client.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
        ]);
        return { name, symbol, supply: supply.toString(), decimals };
      })(),
      getDexData(addr),
      getEarlyBuyersDetailed(addr, l.block),
      // Try to get TokenLaunched event for pool details
      (async () => {
        for (const s of STRATEGIES) {
          if (s.addr.toLowerCase() === l.strategyAddr.toLowerCase()) {
            try {
              const logs = await client.getContractEvents({
                address: s.addr, abi: tokenLaunchedAbi, eventName: 'TokenLaunched',
                fromBlock: BigInt(l.block), toBlock: BigInt(l.block),
              });
              for (const log of logs) {
                if (log.args.token.toLowerCase() === l.token.toLowerCase()) {
                  return {
                    poolId: log.args.poolId,
                    currency0: log.args.key.currency0,
                    currency1: log.args.key.currency1,
                    fee: log.args.key.fee,
                    tickSpacing: log.args.key.tickSpacing,
                    finalPositionRecipient: log.args.finalPositionRecipient,
                  };
                }
              }
            } catch {}
          }
        }
        return null;
      })(),
    ]);
    
    const ageHours = dex?.pairCreatedAt ? ((Date.now() - dex.pairCreatedAt) / 3600000).toFixed(1) : 'N/A';
    
    results.push({
      tokenAddress: addr,
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      supply: tokenInfo.supply,
      decimals: tokenInfo.decimals,
      pool: tokenLaunched,
      feesLabel: l.feesLabel,
      gen: l.gen,
      launchBlock: l.block,
      launchTxHash: l.txHash,
      ageHours,
      dex,
      earlyBuyers: buyers ? {
        uniqueBuyers: buyers.uniqueBuyers,
        firstBuyer: buyers.buyers[0],
        first5: buyers.buyers.slice(0, 5),
      } : null,
    });
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Output
  console.log('__JSON_START__');
  console.log(JSON.stringify(results, null, 2));
  console.log('__JSON_END__');
  
  // Summary
  console.error('\n=== DEEP ANALYSIS ===');
  
  const withDex = results.filter(r => r.dex);
  console.error(`DexScreener data: ${withDex.length}/${results.length}`);
  
  // Success tiers
  const highVol = withDex.filter(r => r.dex.volume24h > 10000);
  const midVol = withDex.filter(r => r.dex.volume24h > 1000 && r.dex.volume24h <= 10000);
  const lowVol = withDex.filter(r => r.dex.volume24h > 0 && r.dex.volume24h <= 1000);
  const dead = withDex.filter(r => r.dex.volume24h === 0);
  
  console.error(`\nVolume tiers:`);
  console.error(`  >$10k: ${highVol.length}`);
  console.error(`  $1k-$10k: ${midVol.length}`);
  console.error(`  $1-$1k: ${lowVol.length}`);
  console.error(`  Dead (0 vol): ${dead.length}`);
  
  if (highVol.length > 0) {
    console.error('\n=== HIGH VOLUME TOKENS (>$10k 24h) ===');
    for (const r of highVol.sort((a,b) => b.dex.volume24h - a.dex.volume24h)) {
      console.error(`  $${r.symbol} — vol=$${r.dex.volume24h.toLocaleString()}, liq=$${r.dex.liquidityUsd?.toLocaleString()}, fdv=$${r.dex.fdv?.toLocaleString()}, age=${r.ageHours}h, fees=${r.feesLabel}, gen=${r.gen}, buyers=${r.earlyBuyers?.uniqueBuyers || '?'}`);
    }
  }
  
  if (midVol.length > 0) {
    console.error('\n=== MID VOLUME TOKENS ($1k-$10k) ===');
    for (const r of midVol.slice(0, 15)) {
      console.error(`  $${r.symbol} — vol=$${r.dex.volume24h.toLocaleString()}, liq=$${r.dex.liquidityUsd?.toLocaleString()}, fdv=$${r.dex.fdv?.toLocaleString()}, age=${r.ageHours}h, fees=${r.feesLabel}`);
    }
  }
  
  // Fee analysis
  console.error('\n=== FEES-ON vs FEES-OFF ===');
  for (const label of ['fees-on', 'fees-off']) {
    const subset = withDex.filter(r => r.feesLabel === label);
    if (subset.length === 0) continue;
    const avgVol = subset.reduce((s, r) => s + (r.dex?.volume24h || 0), 0) / subset.length;
    const medVol = subset.map(r => r.dex?.volume24h || 0).sort((a,b) => a-b)[Math.floor(subset.length/2)];
    console.error(`  ${label}: ${subset.length} tokens, avgVol=$${avgVol.toFixed(2)}, medVol=$${medVol.toFixed(2)}`);
  }
  
  // Common early buyer wallets
  console.error('\n=== FREQUENT EARLY BUYERS (across sample) ===');
  const walletFreq = new Map();
  const walletVols = new Map();
  for (const r of withDex) {
    for (const b of r.earlyBuyers?.buyers?.slice(0, 5) || []) {
      const w = b.address.toLowerCase();
      walletFreq.set(w, (walletFreq.get(w) || 0) + 1);
      if (!walletVols.has(w)) walletVols.set(w, []);
      walletVols.get(w).push(r.dex?.volume24h || 0);
    }
  }
  
  const frequent = Array.from(walletFreq.entries())
    .filter(([_, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1]);
  
  for (const [addr, count] of frequent.slice(0, 20)) {
    const vols = walletVols.get(addr) || [];
    const avgVol = vols.reduce((a,b) => a+b, 0) / vols.length;
    console.error(`  ${addr}: ${count} launches, avg token vol=$${avgVol.toFixed(0)}`);
  }
  
  // Launch velocity analysis
  console.error('\n=== LAUNCH VELOCITY ===');
  const byGen = {};
  for (const r of results) {
    byGen[r.gen] = (byGen[r.gen] || 0) + 1;
  }
  for (const [gen, count] of Object.entries(byGen).sort()) {
    console.error(`  ${gen}: ${count} in sample`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });