#!/usr/bin/env node
/**
 * ZapBot Autonomous — Full autonomous trading bot for Robinhood V4.
 *
 * Integrates:
 *  - Launch scanner (DistributionInitialized events)
 *  - Scoring engine (buyer count, name quality, timing, velocity, diversity)
 *  - Position sizing (dynamic, streak-aware)
 *  - V4 PoolManager direct swap execution
 *  - Exit strategy (TP1/TP2/stop-loss/dead-trade/max-hold)
 *  - Reinvestment loop
 *
 * USAGE:
 *   node scripts/zapbot-autonomous.mjs --dry-run
 *   BOT_PRIVATE_KEY=0x... node scripts/zapbot-autonomous.mjs --live
 *
 * REQUIREMENTS for --live:
 *   BOT_PRIVATE_KEY — wallet private key (never committed)
 *   Wallet must have ETH on Robinhood chain (4663)
 *   Recommended: 0.05 ETH minimum for useful testing
 *
 * SECURITY:
 *   - Private key is read from env only, never logged or saved
 *   - Position sizing limits exposure (20% base, 35% max)
 *   - Stop-loss at -12% protects downside
 *   - Max hold 5 minutes prevents bag-holding
 *   - Gas reserve of 0.01 ETH always maintained
 */

import { createPublicClient, createWalletClient, http, parseAbi, getAddress, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";

// ─── Configuration ─────────────────────────────────────────────────────────

const RPC = process.env.ROBINHOOD_RPC_URL || "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const WETH = "0x4200000000000000000000000000000000000006";
const STRATEGY = "0x23f8209572b4a1C2AD88A42749E830791Fb027f1";

// V4 swap config
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000";
const POOL_FEE = 3000;
const POOL_TICK_SPACING = 60;

const CONFIG = {
  // Entry — smart money buys at block 2-4, we target block 2-30
  minScore: 3, minBuyers: 1, maxAgeBlocks: 120, minFirstBuyerBlock: 0, maxFirstBuyerBlock: 20,
  // Exit — quick rotation: 2-4 min holds, tight targets
  tp1Pct: 15, tp1Fraction: 0.50,
  tp2Pct: 35, tp2Fraction: 0.50,
  stopLossPct: -8, stopLossFraction: 1.0,
  deadMinutes: 2, deadThresholdPct: 1.5,
  maxHoldMinutes: 4,
  // Position sizing
  basePct: 0.20, maxPct: 0.35, minEth: 0.005, gasReserve: 0.01,
  cooldownMult: 0.5, streakMult: 1.25, streakThreshold: 3,
  // Timing
  pollMs: 1500, scanCooldownMs: 3000,
  // State
  stateFile: path.join(process.cwd(), "data", "zapbot-state.json"),
};

// ─── System addresses ──────────────────────────────────────────────────────

const SYSTEM = new Set([
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  STRATEGY.toLowerCase(), PM.toLowerCase(),
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  "0x000000000000000000000000000000000000dead",
  "0x4f5e3fbb9745358a92da5674305fab8d2b8a73ce",
  "0xf9526dd3361fe0ba6b7a99533ed471d3e808e99a",
  "0xd35e9ca72f64c7f93be30fad67524323396b36d7",
]);

// ─── ABIs ──────────────────────────────────────────────────────────────────

const distAbi = parseAbi(["event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)"]);
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const erc20Abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);

const { encodeFunctionData, encodePacked, keccak256 } = await import("viem");

function encodeSwap(token, ethInWei, isBuy) {
  const t0 = getAddress(WETH.toLowerCase());
  const t1 = getAddress(token.toLowerCase());
  const [c0, c1] = t0 < t1 ? [t0, t1] : [t1, t0];
  return encodeFunctionData({
    abi: parseAbi(["function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes) payable returns (int256)"]),
    functionName: "swap",
    args: [{ currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks: ZERO_HOOKS }, { zeroForOne: isBuy, amountSpecified: ethInWei, sqrtPriceLimitX96: 0n }, "0x"],
  });
}

// ─── Chain ─────────────────────────────────────────────────────────────────

const chain = { id: 4663, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 15000 }) });

function getWallet() {
  const pk = process.env.BOT_PRIVATE_KEY;
  if (!pk) throw new Error("BOT_PRIVATE_KEY env required for live mode");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  return { account, client: createWalletClient({ chain, transport: http(RPC), account }) };
}

// ─── State ─────────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"));
      // Always start fresh: reset status to IDLE so the scan loop runs
      state.status = "IDLE";
      return state;
    }
  } catch {}
  return defaultState();
}
function saveState(s) { const d = path.dirname(CONFIG.stateFile); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(CONFIG.stateFile, JSON.stringify(s, null, 2)); }

function defaultState() { return { bankroll: 0, available: 0, trade: null, history: [], wins: 0, losses: 0, trades: 0, pnl: 0, volume: 0, start: Date.now(), status: "IDLE", action: "init", actionTime: Date.now() }; }

// ─── Scoring ───────────────────────────────────────────────────────────────

const MEME = [/frog/i, /pepe/i, /uni/i, /pool/i, /chad/i, /based/i, /ai/i, /agent/i, /meme/i, /defi/i, /swap/i, /inu/i, /cat/i, /doge/i, /wojak/i, /claw/i, /zap/i, /bonk/i, /narwhal/i, /peng/i];
const SPAM = [/^[a-z]{1,2}$/i, /test/i, /spam/i, /^0x[a-f0-9]+$/i, /^[^a-zA-Z]*$/, /^(.)\1{2,}$/i];

function scoreLaunch(buyers, name, symbol, firstBlk) {
  if (buyers < CONFIG.minBuyers) return { s: 0, pass: false };
  for (const p of SPAM) { if (p.test(symbol)) return { s: 0, pass: false }; }
  let ns = 1; for (const p of MEME) { if (p.test(name) || p.test(symbol)) { ns = 3; break; } }
  if (/^[A-Z][a-z]/.test(name)) ns = Math.max(ns, 2);
  const bs = buyers >= 30 ? 3 : buyers >= 15 ? 2 : buyers >= 5 ? 1 : buyers >= 1 ? 0.5 : 0;
  const ts = firstBlk !== null ? (firstBlk >= 0 && firstBlk <= 4 ? 3 : firstBlk <= 15 ? 2 : firstBlk <= 30 ? 1 : 0) : 0;
  const vs = buyers / 50 >= 0.3 ? 3 : buyers / 50 >= 0.15 ? 2 : buyers / 50 >= 0.02 ? 1 : 0;
  const ds = buyers >= 20 ? 3 : buyers >= 10 ? 2 : buyers >= 1 ? 1 : 0;
  const tot = (bs/3)*0.30 + (ns/3)*0.25 + (ts/3)*0.15 + (vs/3)*0.15 + (ds/3)*0.15;
  return { s: Math.round(tot*10), pass: Math.round(tot*10) >= CONFIG.minScore };
}

// ─── Price ─────────────────────────────────────────────────────────────────

// Price estimation using on-chain data (fallback when DexScreener lags)
// Uses initial tick price + swap event analysis for real-time tracking

const Q96 = 2n ** 96n;
const INITIAL_TICK = 198060;
const WETH_ADDR = "0x4200000000000000000000000000000000000006";

function tickToSqrtPriceX96(tick) {
  const logPrice = tick * Math.log(1.0001);
  const price = Math.exp(logPrice);
  const sqrtPrice = Math.sqrt(price);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

function sqrtPriceX96ToPrice(sqrtPriceX96) {
  return (Number(sqrtPriceX96) / Number(Q96)) ** 2;
}

function getInitialPrice() {
  return sqrtPriceX96ToPrice(tickToSqrtPriceX96(INITIAL_TICK));
}

// Conservative flow-based price estimation
// Problem: the naive model inflates PnL because "more buyers" always
// translates to "price up". Real price depends on size, not just count.
//
// Calibrated: 0.5% per buyer (was 2%) — conservative enough that
// only genuine buyer surges trigger exits.
// Dead trade threshold: exit if no new buyers in 2 min (no momentum).
async function estimatePriceFromFlow(client, token, launchBlock, currentBlock) {
  const initialPrice = getInitialPrice();
  
  const txLogs = await client.getLogs({
    address: token,
    event: transferAbi[0],
    fromBlock: currentBlock - 20n,
    toBlock: currentBlock,
  }).catch(() => []);
  
  let recentBuys = 0;
  for (const tl of txLogs) {
    const to = tl.args.to?.toLowerCase();
    if (to && !SYSTEM.has(to) && to !== "0x0000000000000000000000000000000000000000") recentBuys++;
  }
  
  // Conservative: 0.5% per buyer for small counts, diminishing after 20
  const capped = Math.min(recentBuys, 40);
  const multiplier = capped <= 20 ? 1 + (capped * 0.005) : 1 + (20 * 0.005) + ((capped - 20) * 0.002);
  
  return {
    price: initialPrice / multiplier,  // tokens per WETH — more buyers = price up = fewer tokens per WETH
    source: "flow_estimate",
    recentBuys,
  };
}

async function getPrice(token, launchBlock, currentBlock) {
  // Try DexScreener first (best when available)
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), 4000);
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: c.signal });
    const d = await r.json();
    if (d.pairs?.length) {
      const p = d.pairs.find(x => x.chainId === "robinhood") || d.pairs[0];
      const priceUsd = parseFloat(p.priceUsd || "0");
      // Convert to tokens per WETH for consistent comparison
      // priceUsd = USD per token
      // tokensPerWeth = ETH price / priceUsd (approximate, using $2800/ETH)
      const ethPrice = 2800;
      const tokensPerWeth = priceUsd > 0 ? ethPrice / priceUsd : 0;
      return {
        price: tokensPerWeth,  // tokens per WETH
        priceUsd,              // USD per token
        fdv: parseFloat(p.fdv || "0"),
        liq: parseFloat(p.liquidity?.usd || "0"),
        vol1h: parseFloat(p.volume?.h1 || "0"),
        source: "dexscreener",
      };
    }
  } catch {}

  // Fallback: on-chain estimation (returns tokens per WETH directly)
  if (launchBlock && currentBlock) {
    const estimate = await estimatePriceFromFlow(publicClient, token, launchBlock, currentBlock);
    return {
      price: estimate.price,     // tokens per WETH
      priceUsd: estimate.price > 0 ? 2800 / estimate.price : 0,  // approximate USD
      fdv: estimate.price * 1e9,
      liq: 0,
      vol1h: 0,
      source: estimate.source,
      recentBuys: estimate.recentBuys,
    };
  }

  return null;
}

// ─── Scanner ───────────────────────────────────────────────────────────────

async function scan(block) {
  let logs;
  try {
    logs = await publicClient.getLogs({
      address: STRATEGY,
      fromBlock: block - 400n,
      toBlock: block,
    });
  } catch (e) {
    try {
      logs = await publicClient.getLogs({
        address: STRATEGY,
        fromBlock: block - 200n,
        toBlock: block,
      });
    } catch (e2) {
      console.log("  [scan] RPC error:", e2.message?.slice(0, 60));
      return [];
    }
  }

  const distLogs = logs.filter(l => l.topics[0] === "0x0afd26d7f0833a451173acef122d058906aa7708ceb6f67ea7471a649d88b44b");
  // Always log scan results
  console.log("  [scan] " + distLogs.length + " launches | " + logs.length + " raw logs");

  if (distLogs.length > 0) {
    for (const log of distLogs.slice(-3)) {
      const age = Number(block) - Number(log.blockNumber);
      console.log("  [scan] launch age=" + age + " blk=" + Number(log.blockNumber));
    }
  }

  const signals = [];

  for (const log of distLogs.slice(-40).reverse()) {
    const tokenAddr = "0x" + log.topics[2].slice(26);
    const token = getAddress(tokenAddr.toLowerCase());
    const blk = Number(log.blockNumber);
    const age = Number(block) - blk;
    if (age > CONFIG.maxAgeBlocks) continue;

    try {
      const [name, sym, txLogs] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        publicClient.getLogs({ address: token, event: transferAbi[0], fromBlock: BigInt(blk), toBlock: BigInt(blk) + 50n }).catch(() => []),
      ]);

      const buyers = new Set(); let fbb = null;
      for (const tl of txLogs) { const to = tl.args.to?.toLowerCase(); if (to && !SYSTEM.has(to)) { buyers.add(to); const b = Number(tl.blockNumber); if (fbb === null || b < fbb) fbb = b; } }
      const { s, pass } = scoreLaunch(buyers.size, name, sym, fbb !== null ? fbb - blk : null);

      if (!pass) continue;

      if (fbb !== null) {
        const firstBuyerDelta = fbb - blk;
        if (firstBuyerDelta > CONFIG.maxFirstBuyerBlock) continue;
      }

      const price = await getPrice(token, blk, block);
      signals.push({ token, name, sym, blk, txHash: log.transactionHash, buyers: buyers.size, fbb, score: s, age, price: price?.price ?? 0, fdv: price?.fdv ?? 0, liq: price?.liq ?? 0, vol1h: price?.vol1h ?? 0, priceSource: price?.source ?? "none" });
    } catch {}
  }

  return signals;
}

// ─── Position size ─────────────────────────────────────────────────────────

function posSize(state) {
  const tradable = state.available - CONFIG.gasReserve;
  if (tradable < CONFIG.minEth) return 0;
  let pct = CONFIG.basePct;
  if (state.losses > 0) pct *= Math.pow(CONFIG.cooldownMult, state.losses);
  if (state.wins >= CONFIG.streakThreshold) pct *= CONFIG.streakMult;
  pct = Math.min(pct, CONFIG.maxPct);
  return Math.max(Math.min(state.bankroll * pct, tradable), CONFIG.minEth);
}

// ─── Execute swap ──────────────────────────────────────────────────────────

async function doBuy(state, signal, isLive) {
  const size = posSize(state);
  if (size < CONFIG.minEth) return null;
  const wei = parseEther(size.toFixed(6));

  if (isLive) {
    const { account, client: wallet } = getWallet();
    const data = encodeSwap(signal.token, wei, true);
    console.log(`\n🚀 LIVE BUY: $${signal.sym} — ${size} ETH`);
    console.log(`  PoolManager: ${PM}`);
    try {
      const hash = await wallet.sendTransaction({ to: PM, data, value: wei });
      console.log(`  ✅ TX: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ${receipt.status === "success" ? "✅ CONFIRMED" : "❌ FAILED"} block ${receipt.blockNumber}`);
      return { token: signal.token, sym: signal.sym, name: signal.name, entryBlock: signal.blk, entryPrice: signal.price, entryEth: size, txHash: hash, timestamp: Date.now() };
    } catch (e) {
      console.error(`  ❌ SWAP FAILED: ${e.message?.slice(0, 150)}`);
      console.error(`  💡 V4 PoolManager direct swap may not be supported on Robinhood.`);
      console.error(`  Try via Uniswap web: https://app.uniswap.org/explore/tokens/4663/${signal.token}`);
      return null;
    }
  }

  console.log(`\n📝 DRY BUY: $${signal.sym} — ${size} ETH`);
  return { token: signal.token, sym: signal.sym, name: signal.name, entryBlock: signal.blk, entryPrice: signal.price, entryEth: size, txHash: "dry", timestamp: Date.now() };
}

async function doSell(state, trade, result, isLive) {
  if (isLive) {
    const { account, client: wallet } = getWallet();
    const tokenAddr = trade.token;

    // Check token balance
    const balance = await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    const sellAmount = balance; // Sell whatever we have (should match entry)

    if (sellAmount === 0n) {
      console.log(`  ⚠️  No token balance to sell`);
      return;
    }

    // Approve if needed
    const allowance = await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "allowance", args: [account.address, PM] });
    if (allowance < sellAmount) {
      console.log(`  Approving PoolManager...`);
      const approveHash = await wallet.sendTransaction({
        to: tokenAddr,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PM, sellAmount] }),
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    // Sell
    const data = encodeSwap(tokenAddr, sellAmount, false);
    try {
      const hash = await wallet.sendTransaction({ to: PM, data, value: 0n });
      console.log(`  💰 SELL TX: ${hash} (${result.reason})`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ${receipt.status === "success" ? "✅ SOLD" : "❌ FAILED"}`);
    } catch (e) {
      console.error(`  ❌ SELL FAILED: ${e.message?.slice(0, 100)}`);
    }
  } else {
    console.log(`  📝 DRY SELL: $${trade.sym} (${result.reason})`);
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function main() {
  const isLive = process.argv.includes("--live");
  if (isLive && !process.env.BOT_PRIVATE_KEY) { console.error("BOT_PRIVATE_KEY required for --live"); process.exit(1); }

  console.log(`🤖 ZapBot Autonomous — ${isLive ? "🔴 LIVE TRADING" : "📝 DRY RUN"}`);
    console.log(`  Chain: Robinhood (4663) | PoolManager: ${PM.slice(0, 10)}...`);
    console.log(`  Entry: score≥${CONFIG.minScore}, buyers≥${CONFIG.minBuyers}, age≤${CONFIG.maxAgeBlocks}blk, 1st buyer block ${CONFIG.minFirstBuyerBlock}-${CONFIG.maxFirstBuyerBlock}`);
    console.log(`  Exit: +${CONFIG.tp1Pct}%/+${CONFIG.tp2Pct}%, ${CONFIG.stopLossPct}%, dead>${CONFIG.deadMinutes}m, max ${CONFIG.maxHoldMinutes}m`);
    console.log(`  Size: ${(CONFIG.basePct*100)}% base, ${(CONFIG.maxPct*100)}% max`);
    console.log(`  Edge: Smart money enters block 2-4, exits block 9-32. We mirror this.`);

  let state = loadState() || defaultState();
  if (state.bankroll === 0) {
    if (isLive) {
      const { account } = getWallet();
      const balance = await publicClient.getBalance({ address: account.address });
      state.bankroll = parseFloat(formatEther(balance));
      const acct = account.address;
      console.log("  Wallet: " + acct);
      console.log("  Balance: " + state.bankroll.toFixed(4) + " ETH");
      if (state.bankroll < CONFIG.minEth + CONFIG.gasReserve) {
        console.error("INSUFFICIENT BALANCE: " + state.bankroll.toFixed(4) + " < " + (CONFIG.minEth + CONFIG.gasReserve).toFixed(4));
        process.exit(1);
      }
      console.log("  First trade in 5s...");
      await new Promise(r => setTimeout(r, 5000));
    } else {
      state.bankroll = 1.0;
    }
    state.available = state.bankroll;
  }
  state.start = Date.now();
  saveState(state);
  console.log("State loaded: status=" + state.status);

  let cycles = 0;
  const max = isLive ? 999999 : parseInt(process.env.DRY_RUN_CYCLES || "100");

  while (cycles < max) {
    cycles++;
    const block = await publicClient.getBlockNumber();
    console.log("\n[" + cycles + "] Block " + block + " | Bankroll: " + state.bankroll.toFixed(4) + " ETH");

    if (state.status === "IDLE" || state.status === "REINVESTING") {
      state.status = "SCANNING"; saveState(state);
      console.log("  [scan] starting...");

      let signals;
      try {
        signals = await scan(block);
        console.log("  [scan] result: " + (signals ? signals.length : "null") + " signals");
      } catch (e) {
        console.log("  [scan] ERROR:", e.message?.slice(0, 60));
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
        continue;
      }

      if (!signals || signals.length === 0) {
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
        continue;
      }

      const best = signals[0];
      const trade = await doBuy(state, best, isLive);
      if (!trade) { await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs * 2)); continue; }

      state.available -= trade.entryEth;
      state.trade = trade;
      state.status = "MONITORING";
      state.action = `bought_${best.sym}`;
      state.actionTime = Date.now();
      saveState(state);
    }

    if (state.status === "MONITORING" && state.trade) {
      const t = state.trade;
      const start = Date.now();

      console.log(`\n👁️  Monitoring $${t.sym} (${t.entryEth.toFixed(4)} ETH @ $${t.entryPrice})`);

      while (state.trade && state.status === "MONITORING") {
        const pd = await getPrice(t.token, t.entryBlock, await publicClient.getBlockNumber());
        const elapsed = (Date.now() - start) / 60000;

        // Normalize: use priceUsd for display, price (tokens/WETH) for comparison
        const currentPriceUsd = pd?.priceUsd ?? 0;
        const currentPriceTokens = pd?.price ?? 0;
        if (!pd || currentPriceTokens === 0) {
          if (elapsed > 2) {
            const exitEth = t.entryEth * (isLive ? 0.95 : 1); // Assume 5% loss if can't read
            const pnl = exitEth - t.entryEth;
            await doSell(state, t, { reason: "price_unavailable", pnlPct: pnl > 0 ? 0 : -5 }, isLive);
            state.available += exitEth; state.bankroll = state.available; state.trades++; state.pnl += pnl; state.losses++; state.wins = 0;
            state.trade = null; state.status = "REINVESTING";
            saveState(state);
          }
          await new Promise(r => setTimeout(r, CONFIG.pollMs));
          continue;
        }

        const pnlPct = t.entryPrice > 0 ? ((currentPriceTokens - t.entryPrice) / t.entryPrice) * 100 : 0;
        let action = null;

        if (elapsed >= CONFIG.maxHoldMinutes) action = { reason: `max_hold_${elapsed.toFixed(1)}m`, pnlPct };
        else if (pnlPct <= CONFIG.stopLossPct) action = { reason: `stop_${pnlPct.toFixed(1)}%`, pnlPct };
        else if (pnlPct >= CONFIG.tp2Pct) action = { reason: `tp2_${pnlPct.toFixed(1)}%`, pnlPct };
        else if (pnlPct >= CONFIG.tp1Pct) action = { reason: `tp1_${pnlPct.toFixed(1)}%`, pnlPct };
        else if (elapsed >= CONFIG.deadMinutes && Math.abs(pnlPct) < CONFIG.deadThresholdPct) action = { reason: `dead_${elapsed.toFixed(1)}m`, pnlPct };

        if (action) {
          await doSell(state, t, action, isLive);
          const exitEth = t.entryEth * (1 + pnlPct / 100);
          const pnl = exitEth - t.entryEth;
          state.available += exitEth; state.bankroll = state.available; state.trades++; state.pnl += pnl; state.volume += t.entryEth;
          state.history.push({ sym: t.sym, entry: t.entryPrice, exit: pd.price, eth: t.entryEth, exitEth, pnlPct, pnl, reason: action.reason, dur: elapsed, ts: Date.now() });
          state.trade = null; state.status = "REINVESTING";
          if (pnl > 0) { state.wins++; state.losses = 0; } else { state.losses++; state.wins = 0; }
          saveState(state);
          const emoji = pnlPct > 0 ? "🟢" : pnlPct < -5 ? "🔴" : "🟡";
          console.log(`  ${emoji} ${action.reason} | PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% | ${elapsed.toFixed(1)}m → bankroll: ${state.bankroll.toFixed(4)} ETH`);
          break;
        }

        if (Date.now() % 10000 < CONFIG.pollMs) console.log(`  $${t.sym} | ${elapsed.toFixed(1)}m | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% | src:${pd?.source ?? "?"}`);
        await new Promise(r => setTimeout(r, CONFIG.pollMs));
      }

      await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
      continue;
    }

    await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
  }

  // Summary
  const mins = ((Date.now() - state.start) / 60000).toFixed(1);
  console.log("\n" + "═".repeat(50));
  console.log("📊 SESSION COMPLETE");
  console.log(`  Duration: ${mins}m | Trades: ${state.trades}`);
  console.log(`  PnL: ${state.pnl >= 0 ? "+" : ""}${state.pnl.toFixed(4)} ETH`);
  console.log(`  Bankroll: ${state.bankroll.toFixed(4)} ETH`);
  console.log(`  Wins/Losses: ${state.wins}/${state.losses}`);
  if (state.trades > 0) {
    const wr = (state.history.filter(h => h.pnl > 0).length / state.trades * 100).toFixed(0);
    console.log(`  Win rate: ${wr}%`);
  }
  console.log("═".repeat(50));
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });