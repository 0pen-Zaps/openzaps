// Comprehensive Uniswap Instant Launch analysis on Robinhood chain (4663).
// Queries all strategy generations for DistributionInitialized events (emitted once per launch).
// For each launch: token details, DexScreener data, early buyer patterns.

import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2';
const WETH = '0x4200000000000000000000000000000000000006';

const robinhoodChain = {
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

// All strategy generations (append-only registry from SDK)
const STRATEGIES = [
  { address: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1', label: 'fees-on',  gen: '2026-08-05' },
  { address: '0xAD44D55E7f8337C3cE113fBb591486E85be104b2', label: 'fees-off', gen: '2026-08-05' },
  { address: '0x3f556B542105D5EFBBefe7C766a4919C76B960Fb', label: 'fees-on',  gen: 'v3.1.1' },
  { address: '0x36bdB859518C89F764337cd5C24762d2Aa650f3C', label: 'fees-off', gen: 'v3.1.1' },
  { address: '0x9F67B864B565966dfCc2E0C6bA2483b2D5fF4b00', label: 'fees-on',  gen: '3e05da8' },
  { address: '0x16b63f1c8415FD68591c31FB3c6796a333DD640C', label: 'fees-off', gen: '3e05da8' },
  { address: '0xcE57498D3474DCC244dFb6710fFbE6D4441cD2b2', label: 'fees-on',  gen: '8e40a35' },
  { address: '0x583a7903152b95831e82ffF534448Dee081754ec', label: 'fees-off', gen: '8e40a35' },
  { address: '0x60D73b21cDf2EA846ab3d58699BBbb8F29d72491', label: 'fees-on',  gen: 'c3f9506' },
  { address: '0xFCe92C70f1fc017b72f6DD7a00D9E38725C7fBd1', label: 'fees-off', gen: 'c3f9506' },
];

// FeeSplitters for checking fee accruals per generation
const FEE_SPLITTERS = {
  '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf': 'fees-on (2026-08-05)',
  '0x222D6d4f1ce59b0d48D5505114eC8Addc90A4359': 'fees-off (2026-08-05)',
  '0x6CC1b74Fc1BE1ff373Fa07f3381856f38103e653': 'fees-on (v3.1.1)',
  '0x7198C32a497c09497e04C86cf8F77A244A9E4b8F': 'fees-on (c3f9506)',
  '0xDF50f4ea2207F9D2A753a3DaE729B36FDEF13b23': 'fees-off (c3f9506)',
};

const compiledAbis = {
  distributionInitialized: parseAbi([
    'event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)',
  ]),
  tokenLaunched: parseAbi([
    'event TokenLaunched(bytes32 indexed poolId, address indexed token, address indexed finalPositionRecipient, (address currency0, address currency1, uint24 fee, int24 tickSpacing, bytes hooks) key)',
  ]),
  erc20: parseAbi([
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]),
  transfer: parseAbi([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]),
  feesCollected: parseAbi([
    'event FeesCollected(uint256 indexed tokenId, address indexed token, uint256 nativeAmount, uint256 tokenAmount)',
  ]),
  strategy: parseAbi([
    'function beneficiaryVault() view returns (address)',
    'function feeSplitter() view returns (address)',
    'function initialTick() view returns (int24)',
  ]),
};

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL, { timeout: 30000, batch: true }),
});

function getToken(launch) {
  return launch.token0.toLowerCase() === WETH.toLowerCase() ? launch.token1 : launch.token0;
}

async function getTokenDetails(tokenAddr) {
  try {
    const [name, symbol, totalSupply, decimals] = await Promise.all([
      client.readContract({ address: tokenAddr, abi: compiledAbis.erc20, functionName: 'name' }),
      client.readContract({ address: tokenAddr, abi: compiledAbis.erc20, functionName: 'symbol' }),
      client.readContract({ address: tokenAddr, abi: compiledAbis.erc20, functionName: 'totalSupply' }),
      client.readContract({ address: tokenAddr, abi: compiledAbis.erc20, functionName: 'decimals' }),
    ]);
    return { name, symbol, totalSupply: totalSupply.toString(), decimals };
  } catch (e) {
    return { name: 'ERR', symbol: 'ERR', totalSupply: '0', decimals: 18, error: e.shortMessage };
  }
}

async function getDexScreenerData(tokenAddr) {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`);
    const data = await resp.json();
    if (data.pairs?.length) {
      // Find the pair on Robinhood chain
      const pair = data.pairs.find(p => p.chainId === 'robinhood') || data.pairs[0];
      return {
        dex: pair.dexId,
        priceUsd: pair.priceUsd,
        volume24h: pair.volume?.h24,
        liquidityUsd: pair.liquidity?.usd,
        fdv: pair.fdv,
        marketCap: pair.marketCap,
        txns24hBuys: pair.txns?.h24?.buys,
        txns24hSells: pair.txns?.h24?.sells,
        pairCreatedAt: pair.pairCreatedAt,
        url: pair.url,
      };
    }
  } catch {}
  return null;
}

async function getEarlyBuyers(tokenAddr, launchBlock) {
  try {
    const logs = await client.getLogs({
      address: tokenAddr,
      event: compiledAbis.transfer[0],
      fromBlock: launchBlock,
      toBlock: launchBlock + 100n,
    });
    const buyers = new Map();
    for (const log of logs) {
      const to = log.args.to?.toLowerCase();
      if (to && to !== '0x0000000000000000000000000000000000000000') {
        const existing = buyers.get(to);
        if (!existing) {
          buyers.set(to, { block: Number(log.blockNumber), txHash: log.transactionHash });
        }
      }
    }
    return {
      uniqueBuyers: buyers.size,
      sampleBuyers: Array.from(buyers.entries()).slice(0, 15).map(([addr, info]) => ({
        address: addr, firstBlock: info.block, txHash: info.txHash
      })),
    };
  } catch (e) {
    return { uniqueBuyers: null, error: e.shortMessage };
  }
}

async function main() {
  const limit = parseInt(process.argv[process.argv.indexOf('--limit') + 1]) || 80;
  const currentBlock = await client.getBlockNumber();
  console.error(`Block: ${currentBlock}, chain: 4663\n`);

  // Fetch all DistributionInitialized events across all strategies
  console.error('Step 1: Querying DistributionInitialized events...\n');
  const allDistributions = [];

  for (const s of STRATEGIES) {
    try {
      const logs = await client.getContractEvents({
        address: s.address,
        abi: compiledAbis.distributionInitialized,
        eventName: 'DistributionInitialized',
        fromBlock: 0n,
        toBlock: currentBlock,
      });
      console.error(`  ${s.label} (${s.gen}): ${logs.length} launches`);
      for (const log of logs) {
        allDistributions.push({
          token: log.args.token,
          totalSupply: log.args.totalSupply.toString(),
          distributor: log.args.distributor,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          strategyAddress: s.address,
          strategyLabel: s.label,
          strategyGen: s.gen,
        });
      }
    } catch (e) {
      console.error(`  ${s.label} (${s.gen}): error — ${e.shortMessage}`);
    }
  }

  console.error(`\nTotal launches: ${allDistributions.length}`);

  // Sort newest first
  allDistributions.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
  const toAnalyze = allDistributions.slice(0, limit);

  // Also get TokenLaunched events for poolId/fee info for these launches
  console.error(`\nStep 2: Fetching TokenLaunched events for pool details...`);
  const poolInfoByToken = new Map();
  
  for (const s of STRATEGIES) {
    try {
      const logs = await client.getContractEvents({
        address: s.address,
        abi: compiledAbis.tokenLaunched,
        eventName: 'TokenLaunched',
        fromBlock: 0n,
        toBlock: currentBlock,
      });
      for (const log of logs) {
        const key = log.args.token.toLowerCase();
        poolInfoByToken.set(key, {
          poolId: log.args.poolId,
          token0: log.args.key.currency0,
          token1: log.args.key.currency1,
          fee: log.args.key.fee,
          tickSpacing: log.args.key.tickSpacing,
          finalPositionRecipient: log.args.finalPositionRecipient,
        });
      }
    } catch {}
  }
  console.error(`  Pool info available for: ${poolInfoByToken.size} tokens`);

  // Step 3: Detailed analysis
  console.error(`\nStep 3: Analyzing ${toAnalyze.length} launches...\n`);
  const results = [];

  for (let i = 0; i < toAnalyze.length; i++) {
    const d = toAnalyze[i];
    const tokenAddr = getAddress(d.token.toLowerCase());
    const poolInfo = poolInfoByToken.get(d.token.toLowerCase()) || {};

    console.error(`[${i + 1}/${toAnalyze.length}] ${d.txHash.slice(0, 10)}... block ${d.blockNumber} — ${d.strategyLabel} (${d.strategyGen})`);

    const [tokenDetails, dexData, buyerData] = await Promise.all([
      getTokenDetails(tokenAddr),
      getDexScreenerData(tokenAddr),
      getEarlyBuyers(tokenAddr, d.blockNumber),
    ]);

    results.push({
      tokenAddress: tokenAddr,
      name: tokenDetails.name,
      symbol: tokenDetails.symbol,
      totalSupply: tokenDetails.totalSupply,
      decimals: tokenDetails.decimals,
      poolId: poolInfo.poolId || null,
      poolToken0: poolInfo.token0 || null,
      poolToken1: poolInfo.token1 || null,
      poolFee: poolInfo.fee || null,
      poolTickSpacing: poolInfo.tickSpacing || null,
      finalPositionRecipient: poolInfo.finalPositionRecipient || null,
      launchBlock: Number(d.blockNumber),
      launchTxHash: d.txHash,
      strategyLabel: d.strategyLabel,
      strategyGen: d.strategyGen,
      dex: dexData,
      earlyBuyers: buyerData,
    });

    // Rate limiting
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 1000));
  }

  // Output
  console.log(JSON.stringify(results, null, 2));

  // Summary
  console.error('\n=== SUMMARY ===');
  console.error(`Total launches: ${allDistributions.length}`);
  console.error(`Analyzed: ${results.length}`);

  const feesOn = results.filter(r => r.strategyLabel === 'fees-on');
  const feesOff = results.filter(r => r.strategyLabel === 'fees-off');
  console.error(`Fees-on: ${feesOn.length}, Fees-off: ${feesOff.length}`);

  const withDex = results.filter(r => r.dex);
  console.error(`DexScreener data: ${withDex.length}/${results.length}`);

  if (withDex.length > 0) {
    const byVol = [...withDex].sort((a, b) => (parseFloat(b.dex?.volume24h) || 0) - (parseFloat(a.dex?.volume24h) || 0));
    const byLiq = [...withDex].sort((a, b) => (parseFloat(b.dex?.liquidityUsd) || 0) - (parseFloat(a.dex?.liquidityUsd) || 0));

    console.error('\nTop 15 by 24h volume:');
    for (const r of byVol.slice(0, 15)) {
      console.error(`  $${r.symbol} — vol:$${r.dex?.volume24h || '0'}, liq:$${r.dex?.liquidityUsd || '0'}, txns:${r.dex?.txns24hBuys || '0'}b/${r.dex?.txns24hSells || '0'}s, fees=${r.strategyLabel}, gen=${r.strategyGen}`);
    }

    console.error('\nTop 15 by liquidity:');
    for (const r of byLiq.slice(0, 15)) {
      console.error(`  $${r.symbol} — liq:$${r.dex?.liquidityUsd || '0'}, vol:$${r.dex?.volume24h || '0'}, fdv:$${r.dex?.fdv || '0'}, fees=${r.strategyLabel}`);
    }

    // Fee analysis
    console.error('\n=== FEE ANALYSIS ===');
    console.error('Fees-on launches with DexScreener data:');
    const feesOnDex = withDex.filter(r => r.strategyLabel === 'fees-on');
    if (feesOnDex.length > 0) {
      const avgVol = feesOnDex.reduce((s, r) => s + (parseFloat(r.dex?.volume24h) || 0), 0) / feesOnDex.length;
      console.error(`  Count: ${feesOnDex.length}, Avg vol: $${avgVol.toFixed(2)}`);
    }

    const feesOffDex = withDex.filter(r => r.strategyLabel === 'fees-off');
    if (feesOffDex.length > 0) {
      const avgVol = feesOffDex.reduce((s, r) => s + (parseFloat(r.dex?.volume24h) || 0), 0) / feesOffDex.length;
      console.error(`  Count: ${feesOffDex.length}, Avg vol: $${avgVol.toFixed(2)}`);
    }
  }

  // Early buyer analysis
  console.error('\n=== EARLY BUYER ANALYSIS ===');
  const withBuyers = results.filter(r => r.earlyBuyers?.uniqueBuyers);
  console.error(`Tokens with early buyer data: ${withBuyers.length}`);
  const avgBuyers = withBuyers.length > 0 ? withBuyers.reduce((s, r) => s + r.earlyBuyers.uniqueBuyers, 0) / withBuyers.length : 0;
  console.error(`Average unique buyers in first 100 blocks: ${avgBuyers.toFixed(1)}`);

  // Find common wallets across launches
  const walletFreq = new Map();
  for (const r of withBuyers) {
    for (const b of (r.earlyBuyers?.sampleBuyers || [])) {
      walletFreq.set(b.address, (walletFreq.get(b.address) || 0) + 1);
    }
  }
  const frequent = Array.from(walletFreq.entries())
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1]);
  
  console.error(`\nWallets appearing in >= 3 launches (likely sniper bots):`);
  for (const [addr, count] of frequent.slice(0, 20)) {
    console.error(`  ${addr}: ${count} launches`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });