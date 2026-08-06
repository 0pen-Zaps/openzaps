#!/usr/bin/env node
/**
 * ZapBot Autonomous — autonomous trading bot for Robinhood V4 Instant Launches.
 *
 * Integrates:
 *  - Launch scanner (DistributionInitialized events)
 *  - Scoring engine (buyer count, name quality, timing, velocity, diversity)
 *  - Position sizing (dynamic, streak-aware)
 *  - Real pool price from the V4 PoolManager (see scripts/zapbot-price.mjs)
 *  - Staged exits (TP1 partial / TP2 remainder / stop / dead / max-hold)
 *  - Reinvestment loop
 *
 * USAGE:
 *   node scripts/zapbot-autonomous.mjs --dry-run
 *   BOT_PRIVATE_KEY=0x... node scripts/zapbot-autonomous.mjs --live
 *
 * REQUIREMENTS for --live:
 *   BOT_PRIVATE_KEY  — wallet private key (never committed, never logged)
 *   ZAPBOT_SWAP_API  — base URL of the app serving /api/bot/swap, which holds
 *                      UNISWAP_API_KEY server-side and returns executable calldata.
 *   Wallet must have ETH on Robinhood chain (4663).
 *
 * SECURITY:
 *   - Private key is read from env only, never logged or saved
 *   - Position sizing limits exposure (20% base, 35% max)
 *   - Stop-loss protects downside; max hold prevents bag-holding
 *   - Gas reserve always maintained
 *   - Live mode refuses to guess: if the swap API cannot produce calldata the
 *     trade is skipped. There is deliberately no direct-PoolManager fallback —
 *     an EOA cannot call PoolManager.swap() outside an unlock callback.
 */

import { createPublicClient, createWalletClient, http, parseAbi, getAddress, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { readPoolKey, readPrice, pnlPercentFromTicks } from "./zapbot-price.mjs";

// ─── Configuration ─────────────────────────────────────────────────────────

const RPC = process.env.ROBINHOOD_RPC_URL || "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const STRATEGY = "0x23f8209572b4a1C2AD88A42749E830791Fb027f1";

/** Base URL of the app that proxies Uniswap routing; it keeps UNISWAP_API_KEY server-side. */
const SWAP_API = process.env.ZAPBOT_SWAP_API || "http://localhost:3000";

const CONFIG = {
  // Entry — smart money buys at block 2-4, we target block 2-30
  minScore: 3, minBuyers: 1, maxAgeBlocks: 120, minFirstBuyerBlock: 0, maxFirstBuyerBlock: 20,
  // Exit — quick rotation: 2-4 min holds, tight targets
  tp1Pct: 15, tp1Fraction: 0.50,
  tp2Pct: 35,
  stopLossPct: -8,
  deadMinutes: 2, deadThresholdPct: 1.5,
  maxHoldMinutes: 4,
  // Position sizing
  basePct: 0.20, maxPct: 0.35, minEth: 0.005, gasReserve: 0.01,
  cooldownMult: 0.5, streakMult: 1.25, streakThreshold: 3,
  // Execution
  slippageBps: 1500,
  // Timing
  pollMs: 1500, scanCooldownMs: 3000,
  /** Don't re-enter a token we already traded this session. */
  blacklistAfterExit: true,
  // State
  stateFile: path.join(process.cwd(), "data", "zapbot-state.json"),
};

// ─── System addresses ──────────────────────────────────────────────────────

const SYSTEM = new Set([
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  STRATEGY.toLowerCase(),
  "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  "0x000000000000000000000000000000000000dead",
  "0x4f5e3fbb9745358a92da5674305fab8d2b8a73ce",
  "0xf9526dd3361fe0ba6b7a99533ed471d3e808e99a",
  "0xd35e9ca72f64c7f93be30fad67524323396b36d7",
]);

// ─── ABIs ──────────────────────────────────────────────────────────────────

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

const DIST_TOPIC = "0x0afd26d7f0833a451173acef122d058906aa7708ceb6f67ea7471a649d88b44b";

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
      // Resume an open position rather than forcing IDLE. Forcing IDLE sends
      // the loop straight to scan → doBuy, which overwrites `state.trade` —
      // in live mode that abandons real tokens we still hold, with nothing
      // left in state pointing at them.
      state.status = state.trade ? "MONITORING" : "IDLE";
      return { ...defaultState(), ...state };
    }
  } catch {}
  return defaultState();
}

function saveState(s) {
  const d = path.dirname(CONFIG.stateFile);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(s, null, 2));
}

/**
 * `wins`/`losses` are STREAK counters — position sizing reads them and they
 * reset on the opposite outcome. `winsTotal`/`lossesTotal` are the cumulative
 * counts. Keeping them separate is what makes a win rate meaningful; dividing
 * a streak by the trade count is not a rate of anything.
 */
function defaultState() {
  return {
    bankroll: 0, available: 0, trade: null, history: [],
    wins: 0, losses: 0, winsTotal: 0, lossesTotal: 0,
    trades: 0, pnl: 0, volume: 0, traded: [],
    start: Date.now(), status: "IDLE", action: "init", actionTime: Date.now(),
  };
}

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

// ─── Scanner ───────────────────────────────────────────────────────────────

async function scan(block, state) {
  let logs;
  try {
    logs = await publicClient.getLogs({ address: STRATEGY, fromBlock: block - 400n, toBlock: block });
  } catch {
    try {
      logs = await publicClient.getLogs({ address: STRATEGY, fromBlock: block - 200n, toBlock: block });
    } catch (e2) {
      console.log("  [scan] RPC error:", e2.message?.slice(0, 60));
      return [];
    }
  }

  const distLogs = logs.filter(l => l.topics[0] === DIST_TOPIC);
  console.log("  [scan] " + distLogs.length + " launches | " + logs.length + " raw logs");

  const traded = new Set((state.traded ?? []).map(a => a.toLowerCase()));
  const signals = [];

  for (const log of distLogs.slice(-40).reverse()) {
    const token = getAddress(("0x" + log.topics[2].slice(26)).toLowerCase());
    const blk = Number(log.blockNumber);
    const age = Number(block) - blk;
    if (age > CONFIG.maxAgeBlocks) continue;
    if (CONFIG.blacklistAfterExit && traded.has(token.toLowerCase())) continue;

    try {
      const [name, sym, txLogs] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        publicClient.getLogs({ address: token, event: transferAbi[0], fromBlock: BigInt(blk), toBlock: BigInt(blk) + 50n }).catch(() => []),
      ]);

      const buyers = new Set(); let fbb = null;
      for (const tl of txLogs) {
        const to = tl.args.to?.toLowerCase();
        if (to && !SYSTEM.has(to)) { buyers.add(to); const b = Number(tl.blockNumber); if (fbb === null || b < fbb) fbb = b; }
      }
      const { s, pass } = scoreLaunch(buyers.size, name, sym, fbb !== null ? fbb - blk : null);
      if (!pass) continue;
      if (fbb !== null && fbb - blk > CONFIG.maxFirstBuyerBlock) continue;

      // A signal is only tradable if we can read its pool. No pool, no price,
      // no position — we never enter something we cannot mark to market.
      const poolKey = await readPoolKey(publicClient, token, BigInt(blk));
      if (!poolKey) continue;
      const price = await readPrice(publicClient, token, poolKey);
      if (!price) continue;

      signals.push({ token, name, sym, blk, buyers: buyers.size, fbb, score: s, age, poolKey, tick: price.tick, ethPerToken: price.ethPerToken });
    } catch {}
  }

  // Highest score first — "best" should mean best, not most recent.
  signals.sort((a, b) => b.score - a.score || b.blk - a.blk);
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

// ─── Execution ─────────────────────────────────────────────────────────────

/**
 * Ask the app's /api/bot/swap for executable calldata.
 *
 * Routing lives server-side so UNISWAP_API_KEY is never in this process.
 * Returns null on any failure — callers must skip the trade rather than
 * fall back to hand-rolled calldata.
 */
async function fetchSwapCalldata({ tokenIn, tokenOut, amount, wallet }) {
  let resp;
  try {
    resp = await fetch(`${SWAP_API}/api/bot/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenIn, tokenOut, amount: amount.toString(), slippage: CONFIG.slippageBps, wallet }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    console.error(`  ❌ swap API unreachable at ${SWAP_API}: ${e.message?.slice(0, 80)}`);
    return null;
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(`  ❌ swap API ${resp.status}: ${detail.slice(0, 160)}`);
    return null;
  }

  const body = await resp.json().catch(() => null);
  const tx = body?.swap?.swap ?? body?.swap?.transaction ?? body?.swap;
  if (!tx?.to || !tx?.data) {
    console.error("  ❌ swap API returned no executable calldata; refusing to guess.");
    return null;
  }
  return { to: getAddress(tx.to), data: tx.data, value: BigInt(tx.value ?? 0) };
}

async function sendSwap(label, params) {
  const { account, client: wallet } = getWallet();
  const tx = await fetchSwapCalldata({ ...params, wallet: account.address });
  if (!tx) return null;
  try {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    console.log(`  ${label} TX: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const ok = receipt.status === "success";
    console.log(`  ${ok ? "✅ CONFIRMED" : "❌ REVERTED"} block ${receipt.blockNumber}`);
    return ok ? hash : null;
  } catch (e) {
    console.error(`  ❌ ${label} FAILED: ${e.message?.slice(0, 150)}`);
    return null;
  }
}

async function doBuy(state, signal, isLive) {
  const size = posSize(state);
  if (size < CONFIG.minEth) return null;
  const wei = parseEther(size.toFixed(6));

  // Mark at entry, not at discovery. scan() prices every candidate before
  // sorting, so signal.tick can be tens of seconds stale — on a launch that
  // is actively dumping, entering against it books an instant phantom loss.
  const entry = await readPrice(publicClient, signal.token, signal.poolKey);
  if (!entry) {
    console.log(`  ⚠️  $${signal.sym}: price went unreadable before entry — skipping`);
    return null;
  }

  let txHash = "dry";
  if (isLive) {
    console.log(`\n🚀 LIVE BUY: $${signal.sym} — ${size} ETH`);
    txHash = await sendSwap("BUY", { tokenIn: "ETH", tokenOut: signal.token, amount: wei });
    if (!txHash) return null;
  } else {
    console.log(`\n📝 DRY BUY: $${signal.sym} — ${size} ETH @ tick ${entry.tick}${entry.tick !== signal.tick ? ` (drifted ${entry.tick - signal.tick} ticks since scan)` : ""}`);
  }

  return {
    token: signal.token, sym: signal.sym, name: signal.name,
    entryBlock: signal.blk, entryTick: entry.tick, entryPrice: entry.ethPerToken,
    entryEth: size, poolKey: signal.poolKey, txHash, timestamp: Date.now(),
    // Staged-exit bookkeeping: what share of the original position is still
    // open, and what we have already banked from the legs closed so far.
    remainingFraction: 1, realizedEth: 0, tp1Done: false,
  };
}

/**
 * Close `fraction` of the ORIGINAL position. Returns the ETH realised on this
 * leg, or null if a live sell could not be executed (position stays open).
 */
async function doSell(state, trade, fraction, pnlPct, reason, isLive) {
  const costBasis = trade.entryEth * fraction;
  const proceeds = costBasis * (1 + pnlPct / 100);

  if (isLive) {
    const { account } = getWallet();
    const balance = await publicClient.readContract({
      address: trade.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
    }).catch(() => 0n);
    if (balance === 0n) {
      console.log("  ⚠️  No token balance to sell");
      return null;
    }
    // Sell this leg's share of what we still hold.
    const share = trade.remainingFraction > 0 ? fraction / trade.remainingFraction : 1;
    const sellAmount = share >= 1 ? balance : (balance * BigInt(Math.round(share * 1e6))) / 1000000n;
    if (sellAmount === 0n) return null;

    console.log(`  💰 LIVE SELL ${(fraction * 100).toFixed(0)}% of $${trade.sym} (${reason})`);
    const hash = await sendSwap("SELL", { tokenIn: trade.token, tokenOut: "ETH", amount: sellAmount });
    if (!hash) return null;
    // NOTE: proceeds below are still modelled from the pool price rather than
    // parsed from the swap receipt. Live PnL is therefore approximate until
    // receipt parsing lands — do not report it as realised revenue.
  } else {
    console.log(`  📝 DRY SELL ${(fraction * 100).toFixed(0)}% of $${trade.sym} (${reason})`);
  }

  return proceeds;
}

// ─── Main loop ─────────────────────────────────────────────────────────────

function parseMode(argv) {
  const live = argv.includes("--live");
  const dry = argv.includes("--dry-run");
  if (live && dry) throw new Error("Pass exactly one of --live or --dry-run, not both.");
  if (!live && !dry) throw new Error("Pass --dry-run (simulate) or --live (real funds).");
  return live;
}

async function main() {
  const isLive = parseMode(process.argv.slice(2));
  if (isLive && !process.env.BOT_PRIVATE_KEY) { console.error("BOT_PRIVATE_KEY required for --live"); process.exit(1); }

  console.log(`🤖 ZapBot Autonomous — ${isLive ? "🔴 LIVE TRADING" : "📝 DRY RUN"}`);
  console.log(`  Chain: Robinhood (4663) | price: V4 pool slot0`);
  console.log(`  Entry: score≥${CONFIG.minScore}, buyers≥${CONFIG.minBuyers}, age≤${CONFIG.maxAgeBlocks}blk, 1st buyer block ${CONFIG.minFirstBuyerBlock}-${CONFIG.maxFirstBuyerBlock}`);
  console.log(`  Exit: TP1 +${CONFIG.tp1Pct}% (sell ${CONFIG.tp1Fraction * 100}%), TP2 +${CONFIG.tp2Pct}% (rest), stop ${CONFIG.stopLossPct}%, dead>${CONFIG.deadMinutes}m, max ${CONFIG.maxHoldMinutes}m`);
  console.log(`  Size: ${CONFIG.basePct * 100}% base, ${CONFIG.maxPct * 100}% max`);
  if (isLive) console.log(`  Routing: ${SWAP_API}/api/bot/swap`);

  let state = loadState();
  if (state.bankroll === 0) {
    if (isLive) {
      const { account } = getWallet();
      const balance = await publicClient.getBalance({ address: account.address });
      state.bankroll = parseFloat(formatEther(balance));
      console.log("  Wallet: " + account.address);
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
  const max = isLive ? Infinity : parseInt(process.env.DRY_RUN_CYCLES || "100", 10);

  while (cycles < max) {
    cycles++;
    const block = await publicClient.getBlockNumber();
    console.log("\n[" + cycles + "] Block " + block + " | Bankroll: " + state.bankroll.toFixed(4) + " ETH");

    if (state.status === "IDLE" || state.status === "REINVESTING") {
      state.status = "SCANNING"; saveState(state);

      let signals;
      try {
        signals = await scan(block, state);
        console.log("  [scan] result: " + signals.length + " tradable signals");
      } catch (e) {
        console.log("  [scan] ERROR:", e.message?.slice(0, 60));
        state.status = "IDLE";
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
        continue;
      }

      if (signals.length === 0) {
        state.status = "IDLE";
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
        continue;
      }

      const trade = await doBuy(state, signals[0], isLive);
      if (!trade) {
        state.status = "IDLE";
        await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs * 2));
        continue;
      }

      state.available -= trade.entryEth;
      state.trade = trade;
      state.status = "MONITORING";
      state.action = `bought_${trade.sym}`;
      state.actionTime = Date.now();
      if (!state.traded.includes(trade.token)) state.traded.push(trade.token);
      saveState(state);
    }

    if (state.status === "MONITORING" && state.trade) {
      const t = state.trade;
      const start = t.timestamp;
      console.log(`\n👁️  Monitoring $${t.sym} (${t.entryEth.toFixed(4)} ETH @ ${t.entryPrice.toExponential(4)} ETH/token)`);

      while (state.trade && state.status === "MONITORING") {
        const pd = await readPrice(publicClient, t.token, t.poolKey);
        const elapsed = (Date.now() - start) / 60000;

        if (!pd) {
          // No price is not a zero price. Hold and retry; only bail once the
          // pool has been unreadable long enough that the position is stale.
          if (elapsed > CONFIG.maxHoldMinutes) {
            console.log(`  ⚠️  price unreadable for ${elapsed.toFixed(1)}m — closing at cost basis`);
            const out = t.entryEth * t.remainingFraction;
            closeLeg(state, t, t.remainingFraction, 0, "price_unavailable", out, elapsed);
            saveState(state);
            break;
          }
          await new Promise(r => setTimeout(r, CONFIG.pollMs));
          continue;
        }

        const pnlPct = pnlPercentFromTicks(t.entryTick, pd.tick);
        const { fraction, reason } = decideExit({ elapsed, pnlPct, remainingFraction: t.remainingFraction, tp1Done: t.tp1Done });

        if (reason) {
          const proceeds = await doSell(state, t, fraction, pnlPct, reason, isLive);
          if (proceeds === null) {
            // Live sell failed — keep the position open and retry next poll.
            await new Promise(r => setTimeout(r, CONFIG.pollMs));
            continue;
          }
          const closed = closeLeg(state, t, fraction, pnlPct, reason, proceeds, elapsed);
          saveState(state);
          const emoji = pnlPct > 0 ? "🟢" : pnlPct < -5 ? "🔴" : "🟡";
          console.log(`  ${emoji} ${reason} | leg ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% | ${elapsed.toFixed(1)}m${closed ? ` → bankroll: ${state.bankroll.toFixed(4)} ETH` : " → holding remainder"}`);
          if (closed) break;
          continue;
        }

        if (Date.now() % 10000 < CONFIG.pollMs) {
          console.log(`  $${t.sym} | ${elapsed.toFixed(1)}m | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% | tick ${pd.tick} | open ${(t.remainingFraction * 100).toFixed(0)}%`);
        }
        await new Promise(r => setTimeout(r, CONFIG.pollMs));
      }

      await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
      continue;
    }

    await new Promise(r => setTimeout(r, CONFIG.scanCooldownMs));
  }

  summarise(state);
}

/**
 * Which slice of the position to close, if any.
 *
 * Risk rules are evaluated before the profit ladder so a position that is both
 * past max-hold and in profit still closes rather than sitting on a TP1 that
 * only sells half. TP1 is the one rule that closes a fraction; everything else
 * closes whatever remains.
 */
export function decideExit({ elapsed, pnlPct, remainingFraction, tp1Done }, cfg = CONFIG) {
  if (elapsed >= cfg.maxHoldMinutes) return { fraction: remainingFraction, reason: `max_hold_${elapsed.toFixed(1)}m` };
  if (pnlPct <= cfg.stopLossPct) return { fraction: remainingFraction, reason: `stop_${pnlPct.toFixed(1)}%` };
  if (pnlPct >= cfg.tp2Pct) return { fraction: remainingFraction, reason: `tp2_${pnlPct.toFixed(1)}%` };
  if (pnlPct >= cfg.tp1Pct && !tp1Done) return { fraction: Math.min(cfg.tp1Fraction, remainingFraction), reason: `tp1_${pnlPct.toFixed(1)}%` };
  if (elapsed >= cfg.deadMinutes && Math.abs(pnlPct) < cfg.deadThresholdPct) return { fraction: remainingFraction, reason: `dead_${elapsed.toFixed(1)}m` };
  return { fraction: 0, reason: null };
}

/**
 * Bank one leg. A position counts as ONE trade decided on its aggregate PnL —
 * a TP1 partial that later stops out is not "one win and one loss".
 * Returns true when the position is fully closed.
 */
export function closeLeg(state, t, fraction, pnlPct, reason, proceeds, elapsed) {
  state.available += proceeds;
  state.volume += t.entryEth * fraction;
  t.realizedEth += proceeds;
  t.remainingFraction = Math.max(0, t.remainingFraction - fraction);
  if (reason.startsWith("tp1")) t.tp1Done = true;

  state.history.push({
    sym: t.sym, entryTick: t.entryTick, eth: t.entryEth * fraction, exitEth: proceeds,
    pnlPct, pnl: proceeds - t.entryEth * fraction, reason, dur: elapsed, ts: Date.now(),
    partial: t.remainingFraction > 0,
  });

  if (t.remainingFraction > 0.0001) return false;

  const totalPnl = t.realizedEth - t.entryEth;
  state.trades++;
  state.pnl += totalPnl;
  state.bankroll = state.available;
  if (totalPnl > 0) { state.wins++; state.losses = 0; state.winsTotal++; }
  else { state.losses++; state.wins = 0; state.lossesTotal++; }
  state.trade = null;
  state.status = "REINVESTING";
  state.action = `sold_${t.sym}`;
  state.actionTime = Date.now();
  return true;
}

function summarise(state) {
  const mins = ((Date.now() - state.start) / 60000).toFixed(1);
  console.log("\n" + "═".repeat(50));
  console.log("📊 SESSION COMPLETE");
  console.log(`  Duration: ${mins}m | Trades: ${state.trades}`);
  console.log(`  PnL: ${state.pnl >= 0 ? "+" : ""}${state.pnl.toFixed(4)} ETH`);
  console.log(`  Bankroll: ${state.bankroll.toFixed(4)} ETH`);
  console.log(`  Wins/Losses: ${state.winsTotal}/${state.lossesTotal}`);
  if (state.trades > 0) console.log(`  Win rate: ${Math.round((state.winsTotal / state.trades) * 100)}%`);
  console.log("═".repeat(50));
}

export { CONFIG, defaultState, posSize };

// Only trade when run as a program. Tests import decideExit/closeLeg, and an
// unguarded main() would start scanning the chain on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
}
