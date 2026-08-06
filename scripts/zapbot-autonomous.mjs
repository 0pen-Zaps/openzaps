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
  // Entry
  minScore: 6, minBuyers: 10, maxAgeBlocks: 200,
  // Exit
  tp1Pct: 20, tp1Fraction: 0.50,
  tp2Pct: 50, tp2Fraction: 0.50,
  stopLossPct: -12, stopLossFraction: 1.0,
  deadMinutes: 3, deadThresholdPct: 2,
  maxHoldMinutes: 5,
  // Position sizing
  basePct: 0.20, maxPct: 0.35, minEth: 0.005, gasReserve: 0.01,
  cooldownMult: 0.5, streakMult: 1.25, streakThreshold: 3,
  // Timing
  pollMs: 2000, scanCooldownMs: 5000,
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

function loadState() { try { if (fs.existsSync(CONFIG.stateFile)) return JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8")); } catch {} return null; }
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
  const bs = buyers >= 30 ? 3 : buyers >= 15 ? 2 : 1;
  const ts = firstBlk !== null ? (firstBlk >= 3 && firstBlk <= 10 ? 3 : firstBlk <= 25 ? 2 : 1) : 0;
  const vs = buyers / 50 >= 0.3 ? 3 : buyers / 50 >= 0.15 ? 2 : 1;
  const ds = buyers >= 20 ? 3 : buyers >= 10 ? 2 : 1;
  const tot = (bs/3)*0.30 + (ns/3)*0.25 + (ts/3)*0.15 + (vs/3)*0.15 + (ds/3)*0.15;
  return { s: Math.round(tot*10), pass: Math.round(tot*10) >= CONFIG.minScore };
}

// ─── Price ─────────────────────────────────────────────────────────────────

async function getPrice(token) {
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), 4000);
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: c.signal });
    const d = await r.json();
    if (!d.pairs?.length) return null;
    const p = d.pairs.find(x => x.chainId === "robinhood") || d.pairs[0];
    return { price: parseFloat(p.priceUsd||"0"), fdv: parseFloat(p.fdv||"0"), liq: parseFloat(p.liquidity?.usd||"0"), vol1h: parseFloat(p.volume?.h1||"0") };
  } catch { return null; }
}

// ─── Scanner ───────────────────────────────────────────────────────────────

async function scan(block) {
  const logs = await publicClient.getContractEvents({ address: STRATEGY, abi: distAbi, eventName: "DistributionInitialized", fromBlock: block - 1000n, toBlock: block });
  const signals = [];
  for (const log of logs.slice(-40).reverse()) {
    const addr = log.args.token; if (!addr) continue;
    const token = getAddress(addr.toLowerCase());
    const blk = Number(log.blockNumber);
    const age = Number(block) - blk;
    if (age > CONFIG.maxAgeBlocks) continue;
    try {
      const [name, sym, txLogs, price] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        publicClient.getLogs({ address: token, event: transferAbi[0], fromBlock: BigInt(blk), toBlock: BigInt(blk) + 50n }).catch(() => []),
        getPrice(token),
      ]);
      const buyers = new Set(); let fbb = null;
      for (const tl of txLogs) { const to = tl.args.to?.toLowerCase(); if (to && !SYSTEM.has(to)) { buyers.add(to); const b = Number(tl.blockNumber); if (fbb === null || b < fbb) fbb = b; } }
      const { s, pass } = scoreLaunch(buyers.size, name, sym, fbb !== null ? fbb - blk : null);
      if (!pass || !price || price.price === 0) continue;
      signals.push({ token, name, sym, blk, txHash: log.transactionHash, buyers: buyers.size, fbb, score: s, age, price: price.price, fdv: price.fdv, liq: price.liq, vol1h: price.vol1h });
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
  console.log(`  Entry: score≥${CONFIG.minScore}, buyers≥${CONFIG.minBuyers}, age<${CONFIG.maxAgeBlocks}blk`);
  console.log(`  Exit: +${CONFIG.tp1Pct}%/+${CONFIG.tp2Pct}%, ${CONFIG.stopLossPct}%, dead>${CONFIG.deadMinutes}m, max ${CONFIG.maxHoldMinutes}m`);
  console.log(`  Size: ${(CONFIG.basePct*100)}% base, ${(CONFIG.maxPct*100)}% max\n`);

  let state = loadState() || defaultState();
  if (state.bankroll === 0) {
    if (isLive) {
      const { account } = getWallet();
      const balance = await publicClient.getBalance({ address: account.address });
      state.bankroll = parseFloat(formatEther(balance));
    } else {
      state.bankroll = 1.0;
    }
    state.available = state.bankroll;
  }
  state.start = Date.now();
  saveState(state);

  let cycles = 0;
  const max = isLive ? 999999 : 15;

  while (cycles < max) {
    cycles++;
    const block = await publicClient.getBlockNumber();

    if (state.status === "IDLE" || state.status === "REINVESTING") {
      state.status = "SCANNING"; saveState(state);
      console.log(`\n🔍 [${cycles}] Scanning (bankroll: ${state.bankroll.toFixed(4)} ETH, PnL: ${state.pnl >= 0 ? "+" : ""}${state.pnl.toFixed(4)})`);

      const signals = await scan(block);
      if (signals.length === 0) { console.log("  No signals. Waiting..."); await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs)); continue; }

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
        const pd = await getPrice(t.token);
        const elapsed = (Date.now() - start) / 60000;
        if (!pd || pd.price === 0) {
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

        const pnlPct = t.entryPrice > 0 ? ((pd.price - t.entryPrice) / t.entryPrice) * 100 : 0;
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

        if (Date.now() % 10000 < CONFIG.pollMs) console.log(`  $${t.sym} | ${elapsed.toFixed(1)}m | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`);
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