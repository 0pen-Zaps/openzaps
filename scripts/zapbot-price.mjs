/**
 * ZapBot price — real pool price from the V4 PoolManager.
 *
 * Replaces the previous "flow estimate" (a constant divided by a buyer count),
 * which produced a price that (a) never moved for most trades and (b) ran
 * backwards relative to the token's actual value. See the notes on units below.
 *
 * The pool key is NOT the one the swap encoder assumed. Verified on-chain
 * against the Initialize event emitted by the PoolManager at launch:
 *
 *   currency0   0x0000…0000   native ETH, not WETH
 *   currency1   <token>
 *   fee         2500          (not 3000)
 *   tickSpacing 25            (not 60)
 *   hooks       0x0000…0000
 *
 * Because currency0 is native ETH it always sorts first, so currency ordering
 * is fixed and a buy is always zeroForOne = true.
 *
 * UNITS — the trap that inverted the old PnL. With currency0 = ETH and
 * currency1 = token, the pool's raw price is currency1-per-currency0, i.e.
 * TOKENS PER ETH. That number goes UP as the token gets CHEAPER. Quote
 * everything as ethPerToken so "bigger is better" holds and a long position's
 * PnL has the sign a human expects.
 */

import { parseAbi, encodeAbiParameters, parseAbiParameters, keccak256, decodeEventLog } from "viem";

const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const NATIVE = "0x0000000000000000000000000000000000000000";

/** Uniswap V4 PoolManager: `mapping(PoolId => Pool.State) internal _pools` lives at slot 6, and slot0 is its first word. */
const POOLS_SLOT = 6n;

const extsloadAbi = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);

const initializeAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

/** Instant Launch pools have used these since launch; only a fallback when the Initialize event is out of log range. */
const DEFAULT_FEE = 2500;
const DEFAULT_TICK_SPACING = 25;

export function poolIdFor({ token, fee = DEFAULT_FEE, tickSpacing = DEFAULT_TICK_SPACING, hooks = NATIVE }) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [
      NATIVE,
      token,
      fee,
      tickSpacing,
      hooks,
    ]),
  );
}

/**
 * A pool key is immutable once initialized, but the scanner re-evaluates the
 * same launches every few seconds — without this the bot refetches a block
 * range per candidate per cycle for data that can never change.
 */
const poolKeyCache = new Map();

/**
 * Read the pool key straight off the Initialize event so a change to the
 * launcher's fee tier can't silently point us at an uninitialized pool.
 * Returns null when the event is outside the node's log retention.
 */
export async function readPoolKey(client, token, launchBlock) {
  const cacheKey = token.toLowerCase();
  if (poolKeyCache.has(cacheKey)) return poolKeyCache.get(cacheKey);

  const from = BigInt(launchBlock) - 2n;
  const to = BigInt(launchBlock) + 5n;
  const logs = await client.getLogs({ address: PM, fromBlock: from, toBlock: to }).catch(() => []);
  for (const log of logs) {
    try {
      const { args } = decodeEventLog({ abi: initializeAbi, data: log.data, topics: log.topics });
      if (args.currency1?.toLowerCase() === cacheKey) {
        const key = {
          fee: Number(args.fee),
          tickSpacing: Number(args.tickSpacing),
          hooks: args.hooks,
          initialTick: Number(args.tick),
          poolId: args.id,
        };
        poolKeyCache.set(cacheKey, key);
        return key;
      }
    } catch {
      // Not an Initialize log — the PoolManager emits several event types per launch.
    }
  }
  // Cache the miss too: a token whose Initialize we cannot see stays unreadable,
  // and retrying it every cycle is the same wasted range query.
  poolKeyCache.set(cacheKey, null);
  return null;
}

function decodeSlot0(raw) {
  const v = BigInt(raw);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  if (tick >= 1 << 23) tick -= 1 << 24; // int24 two's complement
  return { sqrtPriceX96, tick };
}

/**
 * Current pool price. Returns null when the pool is uninitialized (sqrtPriceX96 == 0)
 * or the read fails — callers must treat null as "no price", never as zero.
 */
export async function readPrice(client, token, poolKey) {
  const poolId = poolKey?.poolId ?? poolIdFor({ token, ...poolKey });
  const slot = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint256"), [poolId, POOLS_SLOT]));

  let raw;
  try {
    raw = await client.readContract({ address: PM, abi: extsloadAbi, functionName: "extsload", args: [slot] });
  } catch {
    return null;
  }

  const { sqrtPriceX96, tick } = decodeSlot0(raw);
  if (sqrtPriceX96 === 0n) return null; // pool not initialized — a real "no price", not a zero price

  const tokensPerEth = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  if (!Number.isFinite(tokensPerEth) || tokensPerEth <= 0) return null;

  return { tick, sqrtPriceX96, tokensPerEth, ethPerToken: 1 / tokensPerEth, source: "pool_slot0" };
}

/**
 * PnL of a long, in percent, from ticks alone.
 *
 * ethPerToken is proportional to 1.0001^(-tick), so the ratio between two
 * observations collapses to a tick difference — no float price division, and
 * no chance of comparing prices that came from two different oracles.
 */
export function pnlPercentFromTicks(entryTick, currentTick) {
  return (Math.pow(1.0001, entryTick - currentTick) - 1) * 100;
}

export { PM, NATIVE, DEFAULT_FEE, DEFAULT_TICK_SPACING };
