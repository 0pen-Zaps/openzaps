// Quick analysis of Uniswap Instant Launch tokens on Robinhood (4663).
// Outputs CSV-like summary to stdout for parsing.

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

const eventAbi = parseAbi([
  'event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)',
]);
const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);
const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

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
      return [p.volume?.h24 || '0', p.liquidity?.usd || '0', p.fdv || '0', p.priceUsd || '0', p.txns?.h24?.buys || '0', p.txns?.h24?.sells || '0', p.pairCreatedAt || '0'];
    }
  } catch {}
  return null;
}

async function main() {
  const block = await client.getBlockNumber();
  const limit = parseInt(process.argv[2]) || 30;
  
  // Gather all events
  const all = [];
  for (const s of STRATEGIES) {
    try {
      const logs = await client.getContractEvents({ address: s.addr, abi: eventAbi, eventName: 'DistributionInitialized', fromBlock: 0n, toBlock: block });
      for (const log of logs) {
        all.push({ token: log.args.token, supply: log.args.totalSupply.toString(), block: Number(log.blockNumber), txHash: log.transactionHash, feesLabel: s.label, gen: s.gen });
      }
    } catch {}
  }
  
  all.sort((a,b) => b.block - a.block);
  const recent = all.slice(0, limit);
  
  // Header
  console.log('SYMBOL\tNAME\tSUPPLY\tBLOCK\tFEES\tGEN\tVOL24H\tLIQ_USD\tFDV\tPRICE\tBUYS\tSELLS\tPAIR_AGE_H\tBUYERS_100BLK');
  
  for (const l of recent) {
    const addr = getAddress(l.token.toLowerCase());
    const [name, symbol, dex, buyerLogs] = await Promise.all([
      client.readContract({ address: addr, abi: erc20Abi, functionName: 'name' }).catch(() => 'ERR'),
      client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'ERR'),
      getDexData(addr),
      client.getLogs({ address: addr, event: transferAbi[0], fromBlock: BigInt(l.block), toBlock: BigInt(l.block) + 100n }).catch(() => []),
    ]);
    
    // Count unique buyers
    const buyers = new Set();
    for (const log of buyerLogs) {
      const to = log.args.to?.toLowerCase();
      if (to && to !== '0x0000000000000000000000000000000000000000') buyers.add(to);
    }
    
    let vol = '0', liq = '0', fdv = '0', price = '0', buys = '0', sells = '0', age = '0';
    if (dex) {
      [vol, liq, fdv, price, buys, sells] = dex;
      // Calculate pair age in hours
      const created = parseInt(dex[6] || '0');
      age = created > 0 ? ((Date.now() - created) / 3600000).toFixed(1) : '0';
    }
    
    console.log(`${symbol}\t${name}\t${l.supply}\t${l.block}\t${l.feesLabel}\t${l.gen}\t${vol}\t${liq}\t${fdv}\t${price}\t${buys}\t${sells}\t${age}\t${buyers.size}`);
    
    await new Promise(r => setTimeout(r, 200));
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });