#!/usr/bin/env node
/**
 * ZapBot Strategy Engine — Autonomous buy/sell/reinvest cycle
 *
 * State machine:
 *   IDLE → SCANNING (find qualifying launch) → ENTERING (execute buy)
 *   → MONITORING (track PnL, check exits) → EXITING (execute sell)
 *   → REINVESTING (compound profits) → SCANNING
 *
 * Exit rules (whichever hits first):
 *   +20% → sell 50% position
 *   +50% → sell remaining 50%
 *   -12% → stop-loss: sell 100%
 *   No movement after 3 min → dead trade: sell 100%
 *   Max hold 5 min → force sell 100%
 *
 * Position sizing:
 *   Base: 20% of bankroll per trade
 *   After loss: halve size for next trade (cool-down)
 *   After 3 consecutive wins: increase by 25%
 *   Reserve: 0.01 ETH minimum for gas
 */

import { createPublicClient, http, parseAbi, getAddress, formatEther } from "viem";
import * as fs from "fs";
import * as path from "path";

// ─── Configuration ─────────────────────────────────────────────────────────

const RPC_URL = process.env.ROBINHOOD_RPC_URL || "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const STRATEGY = "0x23f8209572b4a1C2AD88A42749E830791Fb027f1";

const CONFIG = {
  basePositionPct: 0.20,        // 20% of bankroll per trade
  maxPositionPct: 0.35,         // Never exceed 35%
  minPositionEth: 0.005,        // Minimum 0.005 ETH per trade
  gasReserveEth: 0.01,          // Keep 0.01 ETH for gas
  cooldownMultiplier: 0.5,      // After loss: halve position
  winStreakMultiplier: 1.25,    // After 3 wins: +25% size
  winStreakThreshold: 3,

  minScore: 6,
  minRealBuyers: 10,
  maxAgeBlocks: 200,

  takeProfit1Pct: 20,
  takeProfit1Fraction: 0.50,
  takeProfit2Pct: 50,
  takeProfit2Fraction: 0.50,
  stopLossPct: -12,
  stopLossFraction: 1.0,
  deadTradeMinutes: 3,
  deadTradeThresholdPct: 2,
  maxHoldMinutes: 5,

  buySlippageBps: 1500,
  sellSlippageBps: 1500,
  pollIntervalMs: 2000,
  scanCooldownMs: 5000,

  stateFile: path.join(process.cwd(), "data", "zapbot-state.json"),
};

const SYSTEM_ADDRESSES = new Set([
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  STRATEGY.toLowerCase(),
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  "0x000000000000000000000000000000000000dead",
  "0x4f5e3fbb9745358a92da5674305fab8d2b8a73ce",
  "0xf9526dd3361fe0ba6b7a99533ed471d3e808e99a",
  "0xd35e9ca72f64c7f93be30fad67524323396b36d7",
]);

const robinhoodChain = {
  id: 4663, name: "Robinhood",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC_URL, { timeout: 15000 }) });

const abis = {
  distInit: parseAbi(["event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply)"]),
  transfer: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
  erc20: parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]),
};

// ─── Scoring ───────────────────────────────────────────────────────────────

const MEME_PATTERNS = [/frog/i, /pepe/i, /uni/i, /pool/i, /chad/i, /based/i, /ai/i, /agent/i, /meme/i, /defi/i, /swap/i, /inu/i, /cat/i, /doge/i, /wojak/i, /claw/i, /zap/i, /bonk/i, /narwhal/i, /peng/i];
const SPAM_PATTERNS = [/^[a-z]{1,2}$/i, /test/i, /spam/i, /^0x[a-f0-9]+$/i, /^[^a-zA-Z]*$/, /^(.)\1{2,}$/i];

function scoreLaunch(buyers, name, symbol, firstBuyerBlock) {
  if (buyers < CONFIG.minRealBuyers) return { score: 0, passes: false };
  for (const p of SPAM_PATTERNS) { if (p.test(symbol)) return { score: 0, passes: false }; }

  let nameScore = 1;
  for (const p of MEME_PATTERNS) { if (p.test(name) || p.test(symbol)) { nameScore = 3; break; } }
  if (/^[A-Z][a-z]/.test(name)) nameScore = Math.max(nameScore, 2);

  const buyerScore = buyers >= 30 ? 3 : buyers >= 15 ? 2 : 1;
  const timingScore = firstBuyerBlock !== null ? (firstBuyerBlock >= 3 && firstBuyerBlock <= 10 ? 3 : firstBuyerBlock <= 25 ? 2 : 1) : 0;
  const velocityScore = buyers / 50 >= 0.3 ? 3 : buyers / 50 >= 0.15 ? 2 : 1;
  const diversityScore = buyers >= 20 ? 3 : buyers >= 10 ? 2 : 1;

  const total = (buyerScore / 3) * 0.30 + (nameScore / 3) * 0.25 + (timingScore / 3) * 0.15 + (velocityScore / 3) * 0.15 + (diversityScore / 3) * 0.15;
  const scaled = Math.round(total * 10);
  return { score: scaled, passes: scaled >= CONFIG.minScore, breakdown: { buyerScore, nameScore, timingScore, velocityScore, diversityScore } };
}

// ─── Price fetching ────────────────────────────────────────────────────────

async function getTokenPrice(tokenAddr) {
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), 4000);
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`, { signal: c.signal });
    const d = await r.json();
    if (!d.pairs?.length) return null;
    const p = d.pairs.find(x => x.chainId === "robinhood") || d.pairs[0];
    return {
      price: parseFloat(p.priceUsd || "0"),
      fdv: parseFloat(p.fdv || "0"),
      liq: parseFloat(p.liquidity?.usd || "0"),
      vol1h: parseFloat(p.volume?.h1 || "0"),
      vol24h: parseFloat(p.volume?.h24 || "0"),
      change1h: parseFloat(p.priceChange?.h1 || "0"),
      change5m: parseFloat(p.priceChange?.m5 || "0"),
    };
  } catch { return null; }
}

// ─── State management ──────────────────────────────────────────────────────

function defaultState() {
  return {
    bankrollEth: 0,
    availableEth: 0,
    activeTrade: null,
    tradeHistory: [],
    consecutiveWins: 0,
    consecutiveLosses: 0,
    totalTrades: 0,
    totalPnlEth: 0,
    totalVolumeEth: 0,
    sessionStart: Date.now(),
    status: "IDLE",
    lastAction: "initialized",
    lastActionTime: Date.now(),
  };
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) return JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"));
  } catch {}
  return defaultState();
}

function saveState(state) {
  const dir = path.dirname(CONFIG.stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ─── Position sizing ────────────────────────────────────────────────────────

function calcPositionSize(state) {
  const tradable = state.availableEth - CONFIG.gasReserveEth;
  if (tradable < CONFIG.minPositionEth) return 0;

  let pct = CONFIG.basePositionPct;
  if (state.consecutiveLosses > 0) pct *= Math.pow(CONFIG.cooldownMultiplier, state.consecutiveLosses);
  if (state.consecutiveWins >= CONFIG.winStreakThreshold) pct *= CONFIG.winStreakMultiplier;
  pct = Math.min(pct, CONFIG.maxPositionPct);

  const size = state.bankrollEth * pct;
  return Math.max(Math.min(size, tradable), CONFIG.minPositionEth);
}

// ─── Scanner ───────────────────────────────────────────────────────────────

async function scanForLaunches(currentBlock) {
  const fromBlock = currentBlock - 1000n;
  const logs = await publicClient.getContractEvents({
    address: STRATEGY,
    abi: abis.distInit,
    eventName: "DistributionInitialized",
    fromBlock,
    toBlock: currentBlock,
  });

  const signals = [];
  const recent = logs.slice(-40).reverse();

  for (const log of recent) {
    const tokenAddr = log.args.token;
    if (!tokenAddr) continue;
    const token = getAddress(tokenAddr.toLowerCase());
    const block = Number(log.blockNumber);
    const ageBlocks = Number(currentBlock) - block;
    if (ageBlocks > CONFIG.maxAgeBlocks) continue;

    try {
      const [nameRes, symbolRes, txLogs, priceData] = await Promise.all([
        publicClient.readContract({ address: token, abi: abis.erc20, functionName: "name" }).catch(() => "?"),
        publicClient.readContract({ address: token, abi: abis.erc20, functionName: "symbol" }).catch(() => "?"),
        publicClient.getLogs({ address: token, event: abis.transfer[0], fromBlock: BigInt(block), toBlock: BigInt(block) + 50n }).catch(() => []),
        getTokenPrice(token),
      ]);

      const buyers = new Set();
      let firstBuyerBlock = null;
      for (const tl of txLogs) {
        const to = tl.args.to?.toLowerCase();
        if (to && !SYSTEM_ADDRESSES.has(to)) {
          buyers.add(to);
          const b = Number(tl.blockNumber);
          if (firstBuyerBlock === null || b < firstBuyerBlock) firstBuyerBlock = b;
        }
      }

      const { score, passes, breakdown } = scoreLaunch(buyers.size, nameRes, symbolRes, firstBuyerBlock !== null ? firstBuyerBlock - block : null);
      if (!passes) continue;
      if (!priceData || priceData.price === 0) continue;

      signals.push({
        token, name: nameRes, symbol: symbolRes,
        block, txHash: log.transactionHash,
        realBuyers: buyers.size, firstBuyerBlock: firstBuyerBlock !== null ? firstBuyerBlock - block : null,
        score, ageBlocks, breakdown,
        price: priceData.price, fdv: priceData.fdv, liq: priceData.liq,
        vol1h: priceData.vol1h, vol24h: priceData.vol24h,
        change5m: priceData.change5m, change1h: priceData.change1h,
      });
    } catch { /* skip */ }
  }

  return signals;
}

// ─── Monitor position ──────────────────────────────────────────────────────

async function monitorPosition(trade, startTime, entryPrice) {
  const priceData = await getTokenPrice(trade.token);
  const elapsedMs = Date.now() - startTime;
  const elapsedMin = elapsedMs / 60000;
  const elapsedBlocks = Math.floor(elapsedMs / 12000);

  if (!priceData || priceData.price === 0) {
    return elapsedMin > 2
      ? { action: "SELL_ALL", fraction: 1, reason: "price_unavailable", price: 0, pnlPct: 0, elapsedMin, elapsedBlocks }
      : { action: "HOLD", fraction: 0, reason: "no_price", price: 0, pnlPct: 0, elapsedMin, elapsedBlocks };
  }

  const pnlPct = entryPrice > 0 ? ((priceData.price - entryPrice) / entryPrice) * 100 : 0;

  // Max hold
  if (elapsedMin >= CONFIG.maxHoldMinutes) {
    return { action: "SELL_ALL", fraction: 1, reason: `max_hold_${elapsedMin.toFixed(1)}m`, price: priceData.price, pnlPct, elapsedMin, elapsedBlocks };
  }

  // Stop loss
  if (pnlPct <= CONFIG.stopLossPct) {
    return { action: "SELL_ALL", fraction: CONFIG.stopLossFraction, reason: `stop_${pnlPct.toFixed(1)}%`, price: priceData.price, pnlPct, elapsedMin, elapsedBlocks };
  }

  // TP2
  if (pnlPct >= CONFIG.takeProfit2Pct) {
    return { action: "SELL_PARTIAL", fraction: CONFIG.takeProfit2Fraction, reason: `tp2_${pnlPct.toFixed(1)}%`, price: priceData.price, pnlPct, elapsedMin, elapsedBlocks };
  }

  // TP1
  if (pnlPct >= CONFIG.takeProfit1Pct) {
    return { action: "SELL_PARTIAL", fraction: CONFIG.takeProfit1Fraction, reason: `tp1_${pnlPct.toFixed(1)}%`, price: priceData.price, pnlPct, elapsedMin, elapsedBlocks };
  }

  // Dead trade
  if (elapsedMin >= CONFIG.deadTradeMinutes && Math.abs(pnlPct) < CONFIG.deadTradeThresholdPct) {
    return { action: "SELL_ALL", fraction: 1, reason: `dead_${elapsedMin.toFixed(1)}m`, price: priceData.price, pnlPct, elapsedMin, elapsedBlocks };
  }

  return { action: "HOLD", fraction: 0, reason: `mon_${pnlPct.toFixed(1)}%`, price: priceData.price, pnlPct, elapsedMin, elapsedBlocks };
}

// ─── Execute sell ──────────────────────────────────────────────────────────

function applySell(state, result, entryPrice, entryEth) {
  const sellFraction = result.fraction || 1;
  const exitEth = entryEth * (1 + result.pnlPct / 100) * sellFraction;
  const pnlEth = exitEth - entryEth * sellFraction;

  // Update state
  state.availableEth += exitEth;
  state.bankrollEth = state.availableEth + (state.activeTrade ? state.activeTrade.entryEth * (1 - sellFraction) : 0);
  state.totalTrades++;
  state.totalPnlEth += pnlEth;
  state.totalVolumeEth += entryEth;

  state.tradeHistory.push({
    symbol: state.activeTrade?.symbol,
    entryPrice, exitPrice: result.price,
    entryEth: entryEth * sellFraction, exitEth,
    pnlPct: result.pnlPct, pnlEth,
    reason: result.reason,
    durationMs: Date.now() - (state.activeTrade?.timestamp || Date.now()),
    closedAt: Date.now(),
  });

  if (pnlEth > 0) { state.consecutiveWins++; state.consecutiveLosses = 0; }
  else { state.consecutiveLosses++; state.consecutiveWins = 0; }

  state.activeTrade = null;
  state.status = "REINVESTING";
  state.lastAction = `sold_${result.reason}`;
  state.lastActionTime = Date.now();

  return state;
}

// ─── Session summary ────────────────────────────────────────────────────────

function printSummary(state) {
  const elapsedMin = ((Date.now() - state.sessionStart) / 60000).toFixed(1);
  const winRate = state.totalTrades > 0 ? (state.tradeHistory.filter(t => t.pnlEth > 0).length / state.totalTrades * 100).toFixed(0) : "0";
  const avgPnl = state.totalTrades > 0 ? (state.totalPnlEth / state.totalTrades).toFixed(4) : "0";
  const roi = state.totalVolumeEth > 0 ? ((state.totalPnlEth / state.totalVolumeEth) * 100).toFixed(1) : "0";

  console.log("\n" + "═".repeat(60));
  console.log("📊 SESSION SUMMARY");
  console.log("═".repeat(60));
  console.log(`  Duration:        ${elapsedMin} min`);
  console.log(`  Total trades:    ${state.totalTrades}`);
  console.log(`  Win rate:        ${winRate}%`);
  console.log(`  Total PnL:       ${state.totalPnlEth >= 0 ? "+" : ""}${state.totalPnlEth.toFixed(4)} ETH`);
  console.log(`  Avg PnL/trade:   ${avgPnl} ETH`);
  console.log(`  ROI on volume:   ${roi}%`);
  console.log(`  Final bankroll:  ${state.bankrollEth.toFixed(4)} ETH`);
  console.log(`  Consec wins:     ${state.consecutiveWins}`);
  console.log(`  Consec losses:   ${state.consecutiveLosses}`);

  if (state.tradeHistory.length > 0) {
    console.log("\n  Recent trades:");
    for (const t of state.tradeHistory.slice(-10).reverse()) {
      const dur = (t.durationMs / 1000).toFixed(0);
      console.log(`    $${(t.symbol || "?").padEnd(10)} ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct?.toFixed(1) || "?"}%  ${t.reason?.padEnd(20)}  ${dur}s  ${t.pnlEth >= 0 ? "+" : ""}${t.pnlEth?.toFixed(4) || "0"} ETH`);
    }
  }
  console.log("═".repeat(60) + "\n");
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function runAutonomousCycle(isLive) {
  console.log("🤖 ZapBot Strategy Engine\n");
  console.log(`  Entry: score≥${CONFIG.minScore}, buyers≥${CONFIG.minRealBuyers}, age<${CONFIG.maxAgeBlocks}blk, DEX confirmed`);
  console.log(`  Exit: +${CONFIG.takeProfit1Pct}%→sell${CONFIG.takeProfit1Fraction*100}%, +${CONFIG.takeProfit2Pct}%→sell${CONFIG.takeProfit2Fraction*100}%, ${CONFIG.stopLossPct}%→stop, dead>${CONFIG.deadTradeMinutes}m, max ${CONFIG.maxHoldMinutes}m`);
  console.log(`  Size: ${(CONFIG.basePositionPct*100).toFixed(0)}% base, ${(CONFIG.maxPositionPct*100).toFixed(0)}% max, cooldown ${CONFIG.cooldownMultiplier}x, streak ${CONFIG.winStreakMultiplier}x\n`);

  let state = loadState();
  if (state.bankrollEth === 0) state.bankrollEth = 1.0;
  if (state.availableEth === 0) state.availableEth = state.bankrollEth;
  state.sessionStart = Date.now();

  if (isLive) {
    const balance = await publicClient.getBalance({ address: process.env.BOT_WALLET || "0x0000000000000000000000000000000000000000" });
    state.bankrollEth = parseFloat(formatEther(balance));
    state.availableEth = state.bankrollEth;
    console.log(`  LIVE mode active — wallet balance: ${state.bankrollEth.toFixed(4)} ETH\n`);
  } else {
    console.log(`  DRY RUN — simulated bankroll: ${state.bankrollEth.toFixed(4)} ETH\n`);
  }

  saveState(state);

  let cycleCount = 0;
  const maxCycles = isLive ? 999999 : 20;

  while (cycleCount < maxCycles) {
    cycleCount++;
    const currentBlock = await publicClient.getBlockNumber();

    // SCANNING
    if (state.status === "IDLE" || state.status === "REINVESTING") {
      state.status = "SCANNING";
      saveState(state);

      console.log(`\n🔍 [${cycleCount}] Scanning... (bankroll: ${state.bankrollEth.toFixed(4)} ETH, PnL: ${state.totalPnlEth >= 0 ? "+" : ""}${state.totalPnlEth.toFixed(4)})`);

      const signals = await scanForLaunches(currentBlock);

      if (signals.length === 0) {
        console.log("  No qualifying signals. Waiting...");
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
        continue;
      }

      // Pick the best signal
      const best = signals[0];
      const sizeEth = calcPositionSize(state);

      if (sizeEth < CONFIG.minPositionEth) {
        console.log(`  ⚠️  Bankroll too small. Waiting...`);
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs * 3));
        continue;
      }

      // Execute buy
      const trade = {
        token: best.token, symbol: best.symbol, name: best.name,
        entryBlock: best.block, entryPrice: best.price,
        entryEth: sizeEth, score: best.score, timestamp: Date.now(),
      };

      state.availableEth -= sizeEth;
      state.activeTrade = trade;
      state.status = "MONITORING";
      state.lastAction = `bought_${best.symbol}`;
      state.lastActionTime = Date.now();
      saveState(state);

      if (isLive) {
        console.log(`\n🚀 LIVE BUY: $${best.symbol} — ${sizeEth.toFixed(4)} ETH @ $${best.price}`);
      } else {
        console.log(`\n📝 BUY: $${best.symbol} — ${sizeEth.toFixed(4)} ETH @ $${best.price} | ${best.realBuyers} buyers | ${best.score}/10 | vol1h=$${best.vol1h}`);
      }
    }

    // MONITORING
    if (state.status === "MONITORING" && state.activeTrade) {
      const trade = state.activeTrade;
      const monitorStart = Date.now();
      const entryPrice = trade.entryPrice;

      console.log(`👁️  Monitoring $${trade.symbol} (${trade.entryEth.toFixed(4)} ETH @ $${entryPrice})`);

      let lastLog = monitorStart;

      while (state.activeTrade && state.status === "MONITORING") {
        const result = await monitorPosition(trade, monitorStart, entryPrice);

        if (result.action !== "HOLD") {
          state = applySell(state, result, entryPrice, trade.entryEth);
          saveState(state);

          const emoji = result.pnlPct > 0 ? "🟢" : result.pnlPct < -5 ? "🔴" : "🟡";
          console.log(`  ${emoji} ${result.action}: $${trade.symbol} ${result.reason} | PnL: ${result.pnlPct >= 0 ? "+" : ""}${result.pnlPct.toFixed(1)}% | ${result.elapsedMin.toFixed(1)}m | Bankroll: ${state.bankrollEth.toFixed(4)} ETH`);
          break;
        }

        // Periodic status
        if (Date.now() - lastLog > 10000) {
          lastLog = Date.now();
          console.log(`  $${trade.symbol} | ${result.elapsedMin.toFixed(1)}m | ${result.pnlPct >= 0 ? "+" : ""}${result.pnlPct.toFixed(1)}% | ${result.reason}`);
        }

        await new Promise(r => setTimeout(r, CONFIG.pollIntervalMs));
      }

      if (state.status === "REINVESTING") {
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
      }
      continue;
    }

    if (state.status !== "SCANNING" && state.status !== "MONITORING" && state.status !== "REINVESTING") {
      state.status = "IDLE";
      saveState(state);
    }

    await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
  }

  // Done
  printSummary(state);
  console.log(`Dry run complete — ${cycleCount} cycles, ${state.totalTrades} trades simulated.`);
}

// ─── Backtest ──────────────────────────────────────────────────────────────

async function runBacktest(count) {
  console.log(`🔬 BACKTEST: analyzing last ${count} launches for viable trade signals...\n`);

  const currentBlock = await publicClient.getBlockNumber();
  const signals = await scanForLaunches(currentBlock);

  if (signals.length === 0) {
    console.log("No qualifying signals in current window.");
    console.log("This is expected — criteria are strict (score≥6, buyers≥10, DEX confirmed).");
    return;
  }

  console.log(`Found ${signals.length} qualifying signals:\n`);

  // Header
  console.log("SYMBOL        SCORE  BUYERS  1stBLK  VOL1H     VOL24H    PRICE      FDV     CHG5m   CHG1h");
  console.log("─".repeat(95));

  for (const s of signals) {
    console.log(
      `$${s.symbol.padEnd(12)} ${String(s.score).padEnd(6)} ${String(s.realBuyers).padEnd(7)} ${String(s.firstBuyerBlock ?? "?").padEnd(7)} ` +
      `$${String(s.vol1h || 0).padEnd(8)} $${String(s.vol24h || 0).padEnd(8)} $${String(s.price || 0).padEnd(9)} $${String(s.fdv || 0).padEnd(7)} ` +
      `${(s.change5m >= 0 ? "+" : "")}${s.change5m || 0}%    ${(s.change1h >= 0 ? "+" : "")}${s.change1h || 0}%`
    );
  }

  // Simulated PnL if we'd traded these
  console.log(`\n📊 Simulated strategy over these ${signals.length} signals:`);
  let simBankroll = 1.0;
  const simState = { ...defaultState(), bankrollEth: simBankroll, availableEth: simBankroll };

  for (const s of signals.slice(0, 5)) {
    const size = calcPositionSize(simState);
    if (size < CONFIG.minPositionEth) continue;

    // Simulate: buy at signal price
    simState.availableEth -= size;
    const entryPrice = s.price;

    // Check what happened: get current price
    const currentPrice = await getTokenPrice(s.token);
    if (!currentPrice || currentPrice.price === 0) continue;

    const pnlPct = ((currentPrice.price - entryPrice) / entryPrice) * 100;
    const exitEth = size * (1 + pnlPct / 100);
    const pnlEth = exitEth - size;

    simState.availableEth += exitEth;
    simState.bankrollEth = simState.availableEth;
    simState.totalTrades++;
    simState.totalPnlEth += pnlEth;

    if (pnlEth > 0) { simState.consecutiveWins++; simState.consecutiveLosses = 0; }
    else { simState.consecutiveLosses++; simState.consecutiveWins = 0; }

    simState.tradeHistory.push({ symbol: s.symbol, entryPrice, exitPrice: currentPrice.price, entryEth: size, exitEth, pnlPct, pnlEth, reason: "sim", durationMs: 0, closedAt: Date.now() });

    console.log(`  $${s.symbol.padEnd(12)} entry=$${entryPrice}  now=$${currentPrice.price}  PnL=${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%  bankroll=$${simBankroll.toFixed(4)}`);
  }

  printSummary(simState);
}

// ─── Entry ─────────────────────────────────────────────────────────────────

async function main() {
  const isLive = process.argv.includes("--live");
  const isBacktest = process.argv.includes("--backtest");

  if (isBacktest) {
    const idx = process.argv.indexOf("--backtest");
    const count = parseInt(process.argv[idx + 1]) || 50;
    await runBacktest(count);
    process.exit(0);
  }

  await runAutonomousCycle(isLive);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });