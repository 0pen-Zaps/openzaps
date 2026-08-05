#!/usr/bin/env node
/**
 * Uniswap Instant Launch Bot — Robinhood chain (4663)
 * 
 * Monitors new token launches via DistributionInitialized events,
 * scores them based on early buyer patterns, and optionally executes buys.
 * 
 * Usage:
 *   node scripts/instant-launch-bot.mjs --dry-run          (monitor only, no buys)
 *   node scripts/instant-launch-bot.mjs --live             (monitor + execute buys)
 *   node scripts/instant-launch-bot.mjs --backtest N       (analyze last N launches)
 * 
 * Environment:
 *   BOT_PRIVATE_KEY — private key for the buyer wallet (required for --live)
 *   BOT_MAX_ETH_PER_BUY — max ETH per buy (default: 0.05)
 *   BOT_MAX_CONCURRENT — max concurrent positions (default: 3)
 *   BOT_SLIPPAGE_BPS — slippage in bps (default: 1500 = 15%)
 *   ROBINHOOD_RPC_URL — override RPC URL
 */

import { createPublicClient, createWalletClient, http, parseAbi, getAddress, formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ─────────────────────────────────────────────────────────

const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2';
const WETH = '0x4200000000000000000000000000000000000006';

const CONFIG = {
  strategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1', // Current fees-on strategy
  launcher: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  feeSplitter: '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf',
  
  // Scoring thresholds
  minRealBuyers: 6,           // Minimum real buyers in scoring window (lowered from 8 for 50-block window)
  scoringWindowBlocks: 50,    // Blocks to observe after launch
  waitBlocksBeforeScore: 15,  // Blocks to wait before scoring (let dust settle)
  
  // Buy parameters
  maxEthPerBuy: parseFloat(process.env.BOT_MAX_ETH_PER_BUY || '0.05'),
  maxConcurrent: parseInt(process.env.BOT_MAX_CONCURRENT || '3'),
  slippageBps: parseInt(process.env.BOT_SLIPPAGE_BPS || '1500'),
  
  // Position management
  stopLossPercent: -50,
  takeProfitTiers: [
    { percent: 50, sellFraction: 0.25 },
    { percent: 100, sellFraction: 0.50 },
    { percent: 300, sellFraction: 0.75 },
  ],
  maxHoldDays: 7,
  
  // State file
  stateFile: path.join(process.cwd(), 'data', 'bot-state.json'),
};

// System contracts to exclude from buyer count
const SYSTEM_ADDRESSES = new Set([
  CONFIG.launcher.toLowerCase(),
  CONFIG.strategy.toLowerCase(),
  CONFIG.positionManager.toLowerCase(),
  CONFIG.feeSplitter.toLowerCase(),
  '0x000000000000000000000000000000000000dead',
  '0x4F5E3FBb9745358A92Da5674305FAb8D2B8a73cE'.toLowerCase(), // TokenSplitter
  '0xf9526Dd3361fe0ba6b7a99533ed471D3E808E99a'.toLowerCase(), // CompoundingClaimRecipient
  '0xd35E9CA72F64C7F93BE30fad67524323396B36D7'.toLowerCase(), // BeneficiaryVault
]);

// ─── ABIs ──────────────────────────────────────────────────────────────────

const abis = {
  distInit: parseAbi(['event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)']),
  transfer: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
  erc20: parseAbi([
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]),
};

// ─── Chain definition ──────────────────────────────────────────────────────

const robinhoodChain = {
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

// ─── Client setup ──────────────────────────────────────────────────────────

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL, { timeout: 30000 }),
});

function getWalletClient() {
  const pk = process.env.BOT_PRIVATE_KEY;
  if (!pk) throw new Error('BOT_PRIVATE_KEY not set');
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  return createWalletClient({ chain: robinhoodChain, transport: http(RPC_URL), account });
}

// ─── State management ──────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    }
  } catch {}
  return { positions: [], processedLaunches: {}, stats: { totalSeen: 0, totalBought: 0, totalPnl: 0 } };
}

function saveState(state) {
  const dir = path.dirname(CONFIG.stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ─── Scoring engine ────────────────────────────────────────────────────────

const KNOWN_MEME_PATTERNS = [
  /frog/i, /pepe/i, /wojak/i, /chad/i, /doge/i, /shib/i, /inu/i, /cat/i,
  /uni/i, /pool/i, /swap/i, /defi/i, /based/i, /chad/i, /gigachad/i,
  /retard/i, /autist/i, /ai/i, /agent/i, /bot/i, /claw/i, /zap/i,
  /corn/i, /narwhal/i, /peng/i, /axolotl/i, /capy/i, /bear/i, /bull/i,
  /moon/i, /rocket/i, /alpha/i, /sigma/i, /chad/i, /wojak/i,
];

const SPAM_PATTERNS = [
  /^[a-z]{1,2}$/i,         // 1-2 random letters only
  /test/i, /spam/i, /fake/i, /scam/i,
  /^0x[a-f0-9]+$/i,        // Hex address as name
  /^[^a-zA-Z]*$/,           // No letters at all
  /^[a-z]{3}$/i,            // 3 random lowercase consonants (not common words)
  /^(.)\\1{2,}$/i,          // Repeating same character 3+ times
];

// Additional: 3-letter combos that look like keyboard spam
const GIBBERISH_TRIGRAMS = ['daw', 'fse', 'fwe', 'efw', 'ada', 'dwa', 'fef', 'grt', 'jkl', 'qwe', 'zxc', 'asd'];

function isGibberish3Letter(symbol) {
  if (symbol.length === 3) {
    const lower = symbol.toLowerCase();
    if (GIBBERISH_TRIGRAMS.includes(lower)) return true;
    // Check: is it all consonants or all lowercase random
    const vowels = (lower.match(/[aeiou]/gi) || []).length;
    if (vowels === 0) return true; // No vowels = likely spam
  }
  return false;
}

function scoreTokenName(name, symbol) {
  let score = 1; // Baseline generic
  
  // Check gibberish first
  if (isGibberish3Letter(symbol)) return 0;
  
  // Check meme patterns
  for (const pattern of KNOWN_MEME_PATTERNS) {
    if (pattern.test(name) || pattern.test(symbol)) {
      score = 3;
      break;
    }
  }
  
  // Check spam patterns
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(name) || pattern.test(symbol)) {
      return 0; // Hard disqualifier
    }
  }
  
  // Length heuristic: very short random names are suspicious
  if (symbol.length <= 2 && !/[A-Z]{2,}/.test(symbol)) return 0;
  
  // Capitalized / proper name is a mild positive
  if (/^[A-Z]/.test(name)) score = Math.max(score, 2);
  
  return score;
}

function calculateScore(buyerData, nameData) {
  const { realBuyers, firstRealBuyerBlock, buyerVelocity } = buyerData;
  const nameScore = scoreTokenName(nameData.name, nameData.symbol);
  
  // Disqualifiers
  if (nameScore === 0) return { score: 0, decision: 'REJECT', reason: 'spam_name' };
  if (realBuyers === 0) return { score: 0, decision: 'REJECT', reason: 'no_real_buyers' };
  if (realBuyers < CONFIG.minRealBuyers) return { score: 0, decision: 'REJECT', reason: `too_few_buyers_${realBuyers}` };
  
  // Buyer count score (35%)
  let buyerScore = 0;
  if (realBuyers >= 25) buyerScore = 3;
  else if (realBuyers >= 12) buyerScore = 2;
  else if (realBuyers >= 6) buyerScore = 1;
  
  // Name quality score (25%)
  const nameScoreNorm = nameScore; // Already 0-3 scale
  
  // First buyer timing score (15%) — mid-range = good (organic), too fast = bot wave
  let timingScore = 0;
  if (firstRealBuyerBlock >= 3 && firstRealBuyerBlock <= 7) timingScore = 2;
  else if (firstRealBuyerBlock >= 8 && firstRealBuyerBlock <= 15) timingScore = 1;
  // 0-2 blocks = likely bot wave, 0 points
  
  // Velocity score (15%)
  let velocityScore = 0;
  if (buyerVelocity >= 2.0) velocityScore = 3;
  else if (buyerVelocity >= 1.0) velocityScore = 2;
  else if (buyerVelocity >= 0.5) velocityScore = 1;
  
  // Diversity bonus (10%) — more unique wallets = better
  const diversityScore = realBuyers >= 25 ? 3 : realBuyers >= 15 ? 2 : 1;
  
  const totalScore = 
    buyerScore * 0.35 +
    nameScoreNorm * 0.25 / 3 +  // Normalize to 0-1
    timingScore * 0.15 / 2 +
    velocityScore * 0.15 / 3 +
    diversityScore * 0.10 / 3;
  
  const scaledScore = Math.round(totalScore * 10); // 0-10 scale
  
  return {
    score: scaledScore,
    decision: scaledScore >= 6 ? 'BUY' : 'SKIP',
    reason: scaledScore >= 6 ? 'criteria_met' : `score_too_low_${scaledScore}`,
    details: { realBuyers, firstRealBuyerBlock, buyerVelocity, nameScore, buyerScore, timingScore, velocityScore, diversityScore },
  };
}

// ─── Launch analysis ───────────────────────────────────────────────────────

async function analyzeLaunch(tokenAddr, launchBlock) {
  const startBlock = BigInt(launchBlock);
  const endBlock = BigInt(launchBlock) + BigInt(CONFIG.scoringWindowBlocks);
  
  // Get all transfers in window
  const logs = await publicClient.getLogs({
    address: tokenAddr,
    event: abis.transfer[0],
    fromBlock: startBlock,
    toBlock: endBlock,
  });
  
  const buyers = new Map();
  for (const log of logs) {
    const to = log.args.to?.toLowerCase();
    if (to && !SYSTEM_ADDRESSES.has(to)) {
      if (!buyers.has(to)) {
        buyers.set(to, { block: Number(log.blockNumber), txHash: log.transactionHash });
      }
    }
  }
  
  const realBuyers = buyers.size;
  const buyerBlocks = Array.from(buyers.values()).map(b => b.block);
  const firstRealBuyerBlock = buyerBlocks.length > 0 ? Math.min(...buyerBlocks) - launchBlock : null;
  
  // Velocity: buyers per block
  const windowSize = Number(endBlock - startBlock);
  const buyerVelocity = windowSize > 0 ? realBuyers / windowSize : 0;
  
  return { realBuyers, firstRealBuyerBlock, buyerVelocity, buyers: Array.from(buyers.entries()) };
}

async function getTokenInfo(tokenAddr) {
  try {
    const [name, symbol] = await Promise.all([
      publicClient.readContract({ address: tokenAddr, abi: abis.erc20, functionName: 'name' }),
      publicClient.readContract({ address: tokenAddr, abi: abis.erc20, functionName: 'symbol' }),
    ]);
    return { name, symbol };
  } catch {
    return { name: 'UNKNOWN', symbol: '???' };
  }
}

async function getEthPrice() {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006');
    const d = await r.json();
    return parseFloat(d.pairs?.[0]?.priceUsd || '0');
  } catch { return 0; }
}

// ─── Trade execution ──────────────────────────────────────────────────────

async function executeBuy(tokenAddr, tokenSymbol, amountEth, walletClient) {
  console.log(`\n🚀 EXECUTING BUY: $${tokenSymbol} — ${amountEth} ETH`);
  
  // For now, log the intent. Actual swap execution requires:
  // 1. Uniswap V4 Quoter for exact quote
  // 2. Universal Router swap encoding
  // 3. Slippage protection
  
  // Placeholder — swap via Universal Router on Robinhood
  // The actual encoding needs @uniswap/universal-router-sdk or manual encoding
  
  console.log(`  Token: ${tokenAddr}`);
  console.log(`  Amount: ${amountEth} ETH`);
  console.log(`  Slippage: ${CONFIG.slippageBps / 100}%`);
  console.log(`  ⚠️  Swap execution requires Universal Router integration — logging intent only`);
  
  return {
    token: tokenAddr,
    symbol: tokenSymbol,
    ethIn: amountEth,
    timestamp: Date.now(),
    txHash: null, // Would be set after actual swap
    status: 'PENDING_EXECUTION',
  };
}

// ─── Position management ──────────────────────────────────────────────────

function checkPositions(state) {
  const now = Date.now();
  const alerts = [];
  
  for (const pos of state.positions) {
    if (pos.status !== 'ACTIVE') continue;
    
    // Check age
    const ageDays = (now - pos.timestamp) / 86400000;
    if (ageDays >= CONFIG.maxHoldDays) {
      alerts.push({ position: pos, action: 'SELL', reason: `max_hold_${CONFIG.maxHoldDays}d` });
    }
  }
  
  return alerts;
}

// ─── Main monitor loop ─────────────────────────────────────────────────────

async function handleNewLaunch(token, totalSupply, blockNumber, txHash) {
  const state = loadState();
  state.stats.totalSeen++;
  
  const tokenAddr = getAddress(token.toLowerCase());
  
  // Skip if already processed
  if (state.processedLaunches[txHash]) return;
  
  console.log(`\n📡 NEW LAUNCH: block ${blockNumber}`);
  console.log(`  Token: ${tokenAddr}`);
  console.log(`  Supply: ${totalSupply}`);
  console.log(`  Tx: ${txHash}`);
  
  // Wait for scoring window
  console.log(`  Waiting ${CONFIG.waitBlocksBeforeScore} blocks before scoring...`);
  
  // Mark as processing
  state.processedLaunches[txHash] = { token: tokenAddr, block: Number(blockNumber), status: 'WAITING', timestamp: Date.now() };
  saveState(state);
}

async function scoreAndDecide(tokenAddr, launchBlock, txHash) {
  const state = loadState();
  
  console.log(`\n🔍 SCORING: ${tokenAddr} (launched block ${launchBlock})`);
  
  const [buyerData, tokenInfo, ethPrice] = await Promise.all([
    analyzeLaunch(tokenAddr, launchBlock),
    getTokenInfo(tokenAddr),
    getEthPrice(),
  ]);
  
  console.log(`  Token: $${tokenInfo.symbol} — "${tokenInfo.name}"`);
  console.log(`  Real buyers: ${buyerData.realBuyers} (first at block +${buyerData.firstRealBuyerBlock})`);
  console.log(`  Velocity: ${buyerData.buyerVelocity.toFixed(2)} buyers/block`);
  console.log(`  ETH price: $${ethPrice}`);
  
  const result = calculateScore(buyerData, tokenInfo);
  
  console.log(`  Score: ${result.score}/10 → ${result.decision}`);
  console.log(`  Details: buyers=${result.details.realBuyers}, name=${result.details.nameScore}/3, timing=${result.details.timingScore}/2`);
  
  // Update state
  state.processedLaunches[txHash] = {
    ...state.processedLaunches[txHash],
    status: result.decision,
    score: result.score,
    tokenInfo,
    buyerData,
    scoredAt: Date.now(),
  };
  
  if (result.decision === 'BUY') {
    // Check concurrent position limit
    const activePositions = state.positions.filter(p => p.status === 'ACTIVE');
    if (activePositions.length >= CONFIG.maxConcurrent) {
      console.log(`  ⚠️  Max concurrent positions (${CONFIG.maxConcurrent}) reached — skipping`);
      state.processedLaunches[txHash].status = 'SKIP_MAX_POSITIONS';
    } else if (process.argv.includes('--live')) {
      const walletClient = getWalletClient();
      const buyResult = await executeBuy(tokenAddr, tokenInfo.symbol, CONFIG.maxEthPerBuy, walletClient);
      state.positions.push(buyResult);
      state.stats.totalBought++;
    } else {
      console.log(`  💡 DRY RUN — would buy $${tokenInfo.symbol} with ${CONFIG.maxEthPerBuy} ETH`);
      state.positions.push({
        token: tokenAddr,
        symbol: tokenInfo.symbol,
        ethIn: CONFIG.maxEthPerBuy,
        timestamp: Date.now(),
        status: 'DRY_RUN',
        score: result.score,
      });
    }
  }
  
  saveState(state);
}

// ─── Live monitoring ───────────────────────────────────────────────────────

async function startMonitoring() {
  console.log('🤖 Uniswap Instant Launch Bot — Starting...');
  console.log(`  Chain: Robinhood (4663)`);
  console.log(`  Strategy: ${CONFIG.strategy}`);
  console.log(`  Mode: ${process.argv.includes('--live') ? 'LIVE' : 'DRY RUN'}`);
  console.log(`  Max ETH/buy: ${CONFIG.maxEthPerBuy}`);
  console.log(`  Max concurrent: ${CONFIG.maxConcurrent}`);
  console.log(`  Scoring window: ${CONFIG.scoringWindowBlocks} blocks`);
  console.log(`  Wait before score: ${CONFIG.waitBlocksBeforeScore} blocks`);
  console.log('');
  
  // Watch DistributionInitialized events
  console.log('📡 Watching for new launches...\n');
  
  const unwatch = publicClient.watchContractEvent({
    address: CONFIG.strategy,
    abi: abis.distInit,
    eventName: 'DistributionInitialized',
    onLogs: async (logs) => {
      for (const log of logs) {
        const { token, totalSupply } = log.args;
        const blockNumber = Number(log.blockNumber);
        const txHash = log.transactionHash;
        
        await handleNewLaunch(token, totalSupply, blockNumber, txHash);
        
        // Schedule scoring after wait period
        // In production, use a proper scheduler. Here we just wait inline.
        setTimeout(async () => {
          try {
            await scoreAndDecide(getAddress(token.toLowerCase()), blockNumber, txHash);
          } catch (e) {
            console.error(`  ❌ Scoring error: ${e.message}`);
          }
        }, CONFIG.waitBlocksBeforeScore * 12000); // Roughly 12s per block
      }
    },
  });
  
  // Position check loop
  setInterval(() => {
    const state = loadState();
    const alerts = checkPositions(state);
    for (const alert of alerts) {
      console.log(`\n📊 POSITION ALERT: ${alert.position.symbol} — ${alert.reason}`);
    }
  }, 60000); // Every minute
  
  // Keep alive
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    unwatch();
    process.exit(0);
  });
}

// ─── Backtest mode ─────────────────────────────────────────────────────────

async function runBacktest(count) {
  console.log(`🔬 BACKTEST: analyzing last ${count} launches...\n`);
  
  const currentBlock = await publicClient.getBlockNumber();
  const fromBlock = currentBlock - 50000n; // ~7 days
  
  const logs = await publicClient.getContractEvents({
    address: CONFIG.strategy,
    abi: abis.distInit,
    eventName: 'DistributionInitialized',
    fromBlock,
    toBlock: currentBlock,
  });
  
  const recent = logs.slice(-count).reverse();
  
  const results = [];
  for (const log of recent) {
    const token = getAddress(log.args.token.toLowerCase());
    const block = Number(log.blockNumber);
    
    const [buyerData, tokenInfo] = await Promise.all([
      analyzeLaunch(token, block),
      getTokenInfo(token),
    ]);
    
    const result = calculateScore(buyerData, tokenInfo);
    results.push({ token, block, ...tokenInfo, ...result });
    
    if (result.decision === 'BUY') {
      console.log(`✅ BUY  $${tokenInfo.symbol.padEnd(12)} score=${result.score}/10  buyers=${buyerData.realBuyers}  name="${tokenInfo.name}"`);
    } else {
      console.log(`❌ SKIP $${tokenInfo.symbol.padEnd(12)} score=${result.score}/10  ${result.reason}  buyers=${buyerData.realBuyers}`);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  const buys = results.filter(r => r.decision === 'BUY');
  console.log(`\n📊 Backtest complete: ${buys.length}/${results.length} would buy (${(buys.length/results.length*100).toFixed(1)}%)`);
}

// ─── Entry point ──────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--backtest')) {
    const idx = process.argv.indexOf('--backtest');
    const count = parseInt(process.argv[idx + 1]) || 20;
    await runBacktest(count);
  } else {
    await startMonitoring();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });