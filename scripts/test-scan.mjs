// Test scan function in isolation
import { createPublicClient, http, parseAbi, getAddress } from "viem";

const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const STRATEGY = "0x23f8209572b4a1C2AD88A42749E830791Fb027f1";

const SYSTEM = new Set([
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0", STRATEGY.toLowerCase(),
  "0x58daec3116aae6d93017baaea7749052e8a04fa7", "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  "0x000000000000000000000000000000000000dead", "0x4f5e3fbb9745358a92da5674305fab8d2b8a73ce",
  "0xf9526dd3361fe0ba6b7a99533ed471d3e808e99a", "0xd35e9ca72f64c7f93be30fad67524323396b36d7",
  "0x8366a39cc670b4001a1121b8f6a443a643e40951",
]);

const MEME = [/frog/i, /pepe/i, /uni/i, /pool/i, /chad/i, /based/i, /ai/i, /agent/i, /meme/i, /defi/i, /swap/i, /inu/i, /cat/i, /doge/i, /wojak/i, /claw/i, /zap/i, /bonk/i, /narwhal/i, /peng/i];
const SPAM = [/^[a-z]{1,2}$/i, /test/i, /spam/i, /^0x[a-f0-9]+$/i, /^[^a-zA-Z]*$/, /^(.)\1{2,}$/i];

function scoreLaunch(buyers, name, symbol, firstBlk) {
  if (buyers < 1) return { s: 0, pass: false };
  for (const p of SPAM) { if (p.test(symbol)) return { s: 0, pass: false }; }
  let ns = 1;
  for (const p of MEME) { if (p.test(name) || p.test(symbol)) { ns = 3; break; } }
  if (/^[A-Z][a-z]/.test(name)) ns = Math.max(ns, 2);
  const bs = buyers >= 30 ? 3 : buyers >= 15 ? 2 : buyers >= 5 ? 1 : buyers >= 1 ? 0.5 : 0;
  const ts = firstBlk !== null ? (firstBlk >= 0 && firstBlk <= 4 ? 3 : firstBlk <= 15 ? 2 : firstBlk <= 30 ? 1 : 0) : 0;
  const vs = buyers / 50 >= 0.3 ? 3 : buyers / 50 >= 0.15 ? 2 : buyers / 50 >= 0.02 ? 1 : 0;
  const ds = buyers >= 20 ? 3 : buyers >= 10 ? 2 : buyers >= 1 ? 1 : 0;
  const tot = (bs/3)*0.30 + (ns/3)*0.25 + (ts/3)*0.15 + (vs/3)*0.15 + (ds/3)*0.15;
  return { s: Math.round(tot*10), pass: Math.round(tot*10) >= 3, tot };
}

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const erc20Abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);

const client = createPublicClient({
  chain: { id: 4663, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { timeout: 20000 }),
});

async function scan(block) {
  let logs;
  try {
    logs = await client.getLogs({ address: STRATEGY, fromBlock: block - 200n, toBlock: block });
  } catch (e) {
    console.log("getLogs error:", e.message?.slice(0, 60));
    return [];
  }

  const distLogs = logs.filter(l => l.topics[0] === "0x0afd26d7f0833a451173acef122d058906aa7708ceb6f67ea7471a649d88b44b");
  console.log("DistributionInitialized:", distLogs.length);

  const signals = [];
  for (const log of distLogs.slice(-10).reverse()) {
    const tokenAddr = "0x" + log.topics[2].slice(26);
    const token = getAddress(tokenAddr.toLowerCase());
    const blk = Number(log.blockNumber);
    const age = Number(block) - blk;

    console.log("  Checking age=" + age + " blk=" + blk);
    if (age > 120) { console.log("    -> too old"); continue; }

    try {
      const [name, sym, txLogs] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
        client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        client.getLogs({ address: token, event: transferAbi[0], fromBlock: BigInt(blk), toBlock: BigInt(blk) + 50n }).catch(() => []),
      ]);

      const buyers = new Set(); let fbb = null;
      for (const tl of txLogs) {
        const to = tl.args.to?.toLowerCase();
        if (to && !SYSTEM.has(to)) { buyers.add(to); const b = Number(tl.blockNumber); if (fbb === null || b < fbb) fbb = b; }
      }

      const result = scoreLaunch(buyers.size, name, sym, fbb !== null ? fbb - blk : null);
      console.log("    $" + sym + " buyers=" + buyers.size + " fbb=" + (fbb !== null ? fbb - blk : "null") + " score=" + result.s + " pass=" + result.pass);

      if (!result.pass) continue;
      signals.push({ token, sym, score: result.s, buyers: buyers.size, age });
    } catch (e) {
      console.log("    error:", e.message?.slice(0, 60));
    }
  }

  return signals;
}

async function main() {
  const block = await client.getBlockNumber();
  console.log("Block:", block);
  const signals = await scan(block);
  console.log("\nSignals:", signals.length);
  for (const s of signals) console.log("  $" + s.sym, "score=" + s.score, "buyers=" + s.buyers, "age=" + s.age);
}

main().catch(console.error);