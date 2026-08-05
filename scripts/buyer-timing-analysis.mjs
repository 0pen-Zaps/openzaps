// Precise early buyer timing analysis: how fast do winners get bought vs losers?
// Takes specific token addresses from the analysis above.

import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const RPC = 'https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2';
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const client = createPublicClient({
  chain: { id: 4663, name: 'Robinhood', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 30000 }),
});

// Selected winners and losers from the analysis
const TOKENS = {
  winners: [
    { symbol: 'UNIFROG', addr: '0x87f1ed895B460C002E82075f1038E7f2ce4d51cD', block: 28520117 },
    { symbol: 'FRONG', addr: '0xDAC584a4A6BC36A7c4b41A4C7E435d4c1C8D46f5', block: 28523509 },
    { symbol: 'POOLS', addr: '0xF8E15eDedA99D0EA8A775228f20E79f3E56dDb24', block: 28525558 },
    { symbol: 'NARWHAL', addr: '0xfaf5213599836F108D4787Af5AB9f0164b99b717', block: 28548489 },
    { symbol: 'ABE', addr: '0x00000B2c4F503Aca609c451B9f9E11Af8b2AAa86', block: 28582473 },
  ],
  losers: [
    { symbol: 'DAW', addr: '0x7244bdADF4Ef1B37B3E6Ea4E497d08d1944C2004', block: 28564579 },
    { symbol: 'FSEF', addr: '0x86C98D8574F9D888e1E30114aAD013aB5dD47883', block: 28564023 },
    { symbol: 'FWEWE', addr: '0x7253b8E5A8706e66Ac05464A362D5239141777c4', block: 28558709 },
    { symbol: 'ADWAWD', addr: '0x92257BC0C318de69F0C6115d7e85049c33c229B3', block: 28556499 },
    { symbol: 'DWADAW', addr: '0x919b45D6A90A8fAc2dC322e7D497CB5389FDa8a9', block: 28557536 },
  ],
};

async function analyzeToken(symbol, addr, launchBlock) {
  const logs = await client.getLogs({
    address: addr,
    event: transferAbi[0],
    fromBlock: BigInt(launchBlock),
    toBlock: BigInt(launchBlock) + 200n,
  });
  
  const buyers = [];
  const seen = new Set();
  
  for (const log of logs) {
    const to = log.args.to?.toLowerCase();
    if (to && to !== '0x0000000000000000000000000000000000000000') {
      const addrNorm = getAddress(to);
      if (!seen.has(addrNorm)) {
        seen.add(addrNorm);
        buyers.push({
          address: addrNorm,
          block: Number(log.blockNumber),
          blocksAfterLaunch: Number(log.blockNumber) - launchBlock,
          txHash: log.transactionHash,
        });
      }
    }
  }
  
  // Sort by block
  buyers.sort((a, b) => a.block - b.block);
  
  // Timing analysis
  const t1 = buyers.length > 0 ? buyers[0].blocksAfterLaunch : null;
  const t5 = buyers.length >= 5 ? buyers[4].blocksAfterLaunch : null;
  const t10 = buyers.length >= 10 ? buyers[9].blocksAfterLaunch : null;
  const t20 = buyers.length >= 20 ? buyers[19].blocksAfterLaunch : null;
  
  // Group buyers by how fast they appeared
  const inBlock0 = buyers.filter(b => b.blocksAfterLaunch === 0).length; // Same block as launch
  const inBlock1 = buyers.filter(b => b.blocksAfterLaunch === 1).length;
  const inFirst5 = buyers.filter(b => b.blocksAfterLaunch <= 5).length;
  const inFirst20 = buyers.filter(b => b.blocksAfterLaunch <= 20).length;
  
  return {
    symbol,
    totalBuyers: buyers.length,
    t1, t5, t10, t20,
    inBlock0, inBlock1, inFirst5, inFirst20,
    firstBuyers: buyers.slice(0, 15).map(b => ({ addr: b.address.slice(0,10)+'...', blocks: b.blocksAfterLaunch })),
  };
}

async function main() {
  console.log('=== EARLY BUYER TIMING ANALYSIS ===\n');
  
  console.log('SYMBOL|TOTAL|T1|T5|T10|T20|@BLOCK0|@BLOCK1|≤5BLKS|≤20BLKS|FIRST_BUYERS');
  console.log('---|---|---|---|---|---|---|---|---|---');
  
  for (const category of ['winners', 'losers']) {
    for (const t of TOKENS[category]) {
      const data = await analyzeToken(t.symbol, t.addr, t.block);
      const firstBuyers = data.firstBuyers.map(b => `${b.addr}:${b.blocks}`).join(' ');
      console.log(`${category.toUpperCase().slice(0,4)}|${data.symbol}|${data.totalBuyers}|${data.t1}|${data.t5}|${data.t10}|${data.t20}|${data.inBlock0}|${data.inBlock1}|${data.inFirst5}|${data.inFirst20}|${firstBuyers}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Find overlapping wallets between winners
  console.log('\n=== WALLET OVERLAP: WINNERS ===');
  const winnerBuyers = {};
  for (const t of TOKENS.winners) {
    const logs = await client.getLogs({
      address: t.addr, event: transferAbi[0],
      fromBlock: BigInt(t.block), toBlock: BigInt(t.block) + 200n,
    });
    const buyers = new Set();
    for (const log of logs) {
      const to = log.args.to?.toLowerCase();
      if (to && to !== '0x0000000000000000000000000000000000000000') buyers.add(to);
    }
    winnerBuyers[t.symbol] = buyers;
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Find wallets that appear in multiple winners
  const walletCounts = {};
  for (const [symbol, buyers] of Object.entries(winnerBuyers)) {
    for (const addr of buyers) {
      if (!walletCounts[addr]) walletCounts[addr] = { count: 0, tokens: [] };
      walletCounts[addr].count++;
      walletCounts[addr].tokens.push(symbol);
    }
  }
  
  const multiBuyers = Object.entries(walletCounts)
    .filter(([_, data]) => data.count >= 2)
    .sort((a, b) => b[1].count - a[1].count);
  
  console.log(`Wallets buying >= 2 winners: ${multiBuyers.length}`);
  for (const [addr, data] of multiBuyers.slice(0, 30)) {
    console.log(`  ${addr}: ${data.count} launches — ${data.tokens.join(', ')}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });