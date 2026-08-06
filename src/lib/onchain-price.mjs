/**
 * On-chain price estimation for V4 Instant Launch tokens on Robinhood.
 *
 * Strategy:
 * 1. Compute initial price from the known launch tick (198,060) — all Instant Launch
 *    pools open at the same tick, so initial price is deterministic.
 * 2. Estimate current price from PoolManager Swap event logs — each swap
 *    emits the new sqrtPriceX96, from which we derive exact price.
 * 3. Blend: use swap events when available, fall back to initial tick price
 *    with a small spread assumption for very fresh pools.
 */

// V4 tick math
// price = (sqrtPriceX96 / 2^96)^2
// For token1 per token0 (WETH/token pair)
const Q96 = 2n ** 96n;

// Instant Launch initial tick (constructor immutable on all strategies)
const INITIAL_TICK = 198060;

// WETH address on Robinhood
const WETH = "0x4200000000000000000000000000000000000006";

// V4 PoolManager Swap event topic
// event Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
const SWAP_TOPIC = "0x19b47279256b2a23a1665c810c8d55a1758940a80e90e41ce151b2afbe23251a";

/**
 * Compute sqrtPriceX96 from a tick.
 * tick = log base 1.0001 of price
 * sqrtPriceX96 = sqrt(1.0001^tick) * 2^96
 */
function tickToSqrtPriceX96(tick) {
  // Use the formula: sqrtPrice = 1.0001^(tick/2)
  // sqrtPriceX96 = sqrtPrice * 2^96
  const absTick = Math.abs(tick);
  let ratio;
  
  if (absTick === 0) return Q96; // price = 1
  
  // For positive tick (token1 more expensive in terms of token0)
  // price = 1.0001^tick
  // For our case: token0=WETH, token1=token, so price = token per WETH
  // tick 198060 → price = 1.0001^198060 ≈ 4.27e8 tokens per WETH
  
  // Use logarithms: log(price) = tick * log(1.0001)
  const logPrice = tick * Math.log(1.0001);
  const price = Math.exp(logPrice);
  
  // sqrtPriceX96 = sqrt(price) * 2^96
  const sqrtPrice = Math.sqrt(price);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));
  
  return sqrtPriceX96;
}

/**
 * Compute price (tokens per WETH) from sqrtPriceX96.
 * price = (sqrtPriceX96 / 2^96)^2
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96) {
  const num = Number(sqrtPriceX96);
  const price = (num / Number(Q96)) ** 2;
  return price; // tokens per 1 WETH
}

/**
 * Compute price in USD given ETH price.
 */
export function priceToUsd(tokensPerWeth, ethPriceUsd) {
  if (tokensPerWeth === 0) return 0;
  return ethPriceUsd / tokensPerWeth; // USD per token
}

/**
 * Get the initial price for any Instant Launch token.
 * All pools open at tick 198,060.
 */
export function getInitialPrice() {
  const sqrtPriceX96 = tickToSqrtPriceX96(INITIAL_TICK);
  return sqrtPriceX96ToPrice(sqrtPriceX96);
}

/**
 * Extract current price from PoolManager Swap events.
 * Returns { price, sqrtPriceX96, tick, timestamp } or null if no swaps found.
 */
export async function getCurrentPriceFromSwaps(client, tokenAddr, launchBlock, currentBlock) {
  const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
  const token = tokenAddr.toLowerCase();
  
  // Compute pool ID
  const { encodePacked, keccak256 } = await import("viem");
  const poolKey = {
    currency0: WETH < token ? WETH : token,
    currency1: WETH < token ? token : WETH,
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000",
  };
  const poolId = keccak256(encodePacked(
    ["address", "address", "uint24", "int24", "address"],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
  ));
  
  // Query Swap events for this pool
  // Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
  // topics[1] = poolId (indexed)
  try {
    const logs = await client.getLogs({
      address: PM,
      fromBlock: BigInt(launchBlock),
      toBlock: BigInt(currentBlock),
    });
    
    // Filter for Swap events on this pool
    const swapLogs = logs.filter(l => 
      l.topics[0] === SWAP_TOPIC && 
      l.topics[1] === poolId.toLowerCase()
    );
    
    if (swapLogs.length === 0) return null;
    
    // Get the most recent swap
    const latest = swapLogs[swapLogs.length - 1];
    
    // Decode: data = amount0 (int128) + amount1 (int128) + sqrtPriceX96 (uint160) + liquidity (uint128) + tick (int24) + fee (uint24)
    // Actually in V4 the event data is: (int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
    // But only sqrtPriceX96 is a non-indexed field we need
    // The event structure:
    //   topics[0] = event signature
    //   topics[1] = poolId (indexed)
    //   topics[2] = sender (indexed)
    //   data = abi.encode(amount0, amount1, sqrtPriceX96, liquidity, tick, fee)
    
    // Parse the data field
    const data = latest.data;
    // data layout: amount0 (32 bytes) + amount1 (32 bytes) + sqrtPriceX96 (32 bytes) + liquidity (32 bytes) + tick (32 bytes) + fee (32 bytes)
    // sqrtPriceX96 is at offset 64 (after amount0 and amount1)
    const sqrtPriceX96 = BigInt("0x" + data.slice(66, 130));
    
    const price = sqrtPriceX96ToPrice(sqrtPriceX96);
    
    return {
      price,           // tokens per WETH
      sqrtPriceX96: sqrtPriceX96.toString(),
      timestamp: Number(latest.blockNumber),
      swapCount: swapLogs.length,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Estimate current price for a token.
 * Tries swap events first, falls back to initial price with spread.
 */
export async function estimatePrice(client, tokenAddr, launchBlock, currentBlock) {
  // Try to get real price from swap events
  const swapData = await getCurrentPriceFromSwaps(client, tokenAddr, launchBlock, currentBlock);
  
  if (swapData && swapData.price > 0) {
    return {
      price: swapData.price,       // tokens per WETH
      source: "swap_events",
      confidence: "high",
      swapCount: swapData.swapCount,
    };
  }
  
  // Fallback: use initial price
  const initialPrice = getInitialPrice();
  
  return {
    price: initialPrice,
    source: "initial_tick",
    confidence: "low",
    swapCount: 0,
  };
}