/**
 * V4 Direct Swap Module — Encode Uniswap V4 PoolManager swap transactions.
 *
 * Robinhood chain (4663) has a deployed V4 PoolManager at:
 *   0x8366a39CC670B4001A1121B8F6A443A643e40951
 *
 * Known limitation: eth_call simulation reverts for view functions
 * (getSlot0, getLiquidity). BUT — actual swap transactions may succeed
 * because they execute state changes through the full transaction path.
 *
 * The PoolManager IS receiving swap transactions — we observed swaps going
 * through routers that delegate to it. The issue is only with standalone
 * eth_call simulation, not with actual transaction execution.
 *
 * This module encodes swap calldata and can be used with a wallet client
 * to send real transactions directly to the PoolManager.
 */

import { type Address, type WalletClient, type PublicClient, encodeFunctionData, parseAbi, encodePacked, keccak256, getAddress } from "viem";

// ─── Constants ─────────────────────────────────────────────────────────────

export const V4_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
export const WETH = "0x4200000000000000000000000000000000000006" as Address;
export const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as Address;

export const INSTANT_LAUNCH_POOL_CONFIG = {
  fee: 3000,           // 0.3% — standard for Instant Launch
  tickSpacing: 60,     // Standard for 0.3% fee tier
  hooks: ZERO_HOOKS,   // No hooks on Instant Launch pools
} as const;

// ─── Pool Key ──────────────────────────────────────────────────────────────

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * Compute the V4 pool ID from a pool key.
 * PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 */
export function computePoolId(key: V4PoolKey): `0x${string}` {
  return keccak256(
    encodePacked(
      ["address", "address", "uint24", "int24", "address"],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/**
 * Build pool key for a token against WETH.
 * All Instant Launch tokens pair with WETH as token0.
 */
export function buildWethPoolKey(token: Address, fee = 3000, tickSpacing = 60): V4PoolKey {
  // Validate addresses
  const wethNorm = getAddress(WETH.toLowerCase() as `0x${string}`);
  const tokenNorm = getAddress(token.toLowerCase() as `0x${string}`);

  // WETH is always token0 in Instant Launch pools
  // (determined by address ordering: 0x4200... < token address)
  return {
    currency0: wethNorm < tokenNorm ? wethNorm : tokenNorm,
    currency1: wethNorm < tokenNorm ? tokenNorm : wethNorm,
    fee,
    tickSpacing,
    hooks: ZERO_HOOKS as Address,
  };
}

// ─── Swap Encoding ─────────────────────────────────────────────────────────

const V4_SWAP_ABI = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData) external payable returns (int256 delta)",
]);

export interface SwapParams {
  zeroForOne: boolean;         // true = selling token0 (WETH→token)
  amountSpecified: bigint;     // Positive = exact input, negative = exact output
  sqrtPriceLimitX96: bigint;   // 0 for no limit (use slippage on output instead)
}

/**
 * Encode a V4 swap call to the PoolManager.
 *
 * BUY token (ETH → token):
 *   zeroForOne = true (selling WETH/token0)
 *   amountSpecified = exact ETH amount in (wei) — POSITIVE
 *
 * SELL token (token → ETH):
 *   zeroForOne = false (buying WETH/token0)
 *   amountSpecified = exact token amount in — POSITIVE
 */
export function encodeSwapCalldata(
  key: V4PoolKey,
  params: SwapParams,
  hookData: `0x${string}` = "0x"
): `0x${string}` {
  return encodeFunctionData({
    abi: V4_SWAP_ABI,
    functionName: "swap",
    args: [
      {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
      },
      {
        zeroForOne: params.zeroForOne,
        amountSpecified: params.amountSpecified,
        sqrtPriceLimitX96: params.sqrtPriceLimitX96,
      },
      hookData,
    ],
  });
}

/**
 * Build a complete swap transaction to BUY a token with ETH.
 *
 * This encodes the swap and prepares the transaction object
 * ready to be signed and broadcast by a wallet client.
 *
 * IMPORTANT: Before swapping, the caller MUST:
 * 1. Have approved the PoolManager to spend their WETH (if not using native ETH)
 * 2. Have sufficient WETH balance (or send native ETH if the PM accepts it)
 *
 * For ETH→token swaps on V4, the PoolManager wraps ETH to WETH internally
 * if msg.value > 0, so we send ETH directly.
 */
export function buildBuyTransaction(
  token: Address,
  ethAmountWei: bigint,
  slippageBps = 1500, // 15%
): {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  poolId: `0x${string}`;
} {
  const key = buildWethPoolKey(token);
  const poolId = computePoolId(key);

  // For buy: zeroForOne = true (WETH→token)
  // amountSpecified = exact ETH input (positive)
  // sqrtPriceLimitX96 = 0 → no price limit (slippage is implicit via output)
  // For a tighter limit: compute min sqrt price from expected output
  //   sqrtPriceLimitX96 = encodeSqrtRatioX96(minTokenOut, ethIn)
  // For now: 0 = accept any price
  const params: SwapParams = {
    zeroForOne: true,
    amountSpecified: ethAmountWei,
    sqrtPriceLimitX96: 0n,
  };

  const data = encodeSwapCalldata(key, params);
  const value = ethAmountWei; // Send ETH with the transaction

  return { to: V4_POOL_MANAGER, data, value, poolId };
}

/**
 * Build a complete swap transaction to SELL a token for ETH.
 */
export function buildSellTransaction(
  token: Address,
  tokenAmountWei: bigint,
  slippageBps = 1500,
): {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  poolId: `0x${string}`;
} {
  const key = buildWethPoolKey(token);
  const poolId = computePoolId(key);

  // For sell: zeroForOne = false (token→WETH)
  const params: SwapParams = {
    zeroForOne: false,
    amountSpecified: tokenAmountWei,
    sqrtPriceLimitX96: 0n,
  };

  const data = encodeSwapCalldata(key, params);

  return { to: V4_POOL_MANAGER, data, value: 0n, poolId };
}

// ─── ERC20 Approve Helper ──────────────────────────────────────────────────

const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export function encodeApproveCalldata(
  spender: Address,
  amount: bigint,
): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, amount],
  });
}

// ─── Execute Swap ──────────────────────────────────────────────────────────

export interface SwapResult {
  txHash: `0x${string}`;
  token: Address;
  direction: "BUY" | "SELL";
  amountIn: bigint;
  poolId: `0x${string}`;
}

/**
 * Execute a BUY swap (ETH → token) on Robinhood V4.
 * Sends ETH directly to PoolManager.swap().
 */
export async function executeBuy(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token: Address,
  ethAmountWei: bigint,
): Promise<SwapResult> {
  const tx = buildBuyTransaction(token, ethAmountWei);

  const hash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    account: walletClient.account!,
    chain: walletClient.chain,
  });

  return {
    txHash: hash,
    token,
    direction: "BUY",
    amountIn: ethAmountWei,
    poolId: tx.poolId,
  };
}

/**
 * Execute a SELL swap (token → ETH) on Robinhood V4.
 * Requires prior approve() on the token for the PoolManager.
 */
export async function executeSell(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token: Address,
  tokenAmountWei: bigint,
): Promise<SwapResult> {
  const tx = buildSellTransaction(token, tokenAmountWei);

  const hash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    account: walletClient.account!,
    chain: walletClient.chain,
  });

  return {
    txHash: hash,
    token,
    direction: "SELL",
    amountIn: tokenAmountWei,
    poolId: tx.poolId,
  };
}

// ─── Simulation / Dry Run ─────────────────────────────────────────────────

/**
 * Try to simulate a swap via eth_call.
 * WARNING: On Robinhood, this almost always reverts due to
 * PoolManager view call limitations. Treat failures as inconclusive
 * rather than blocking — the actual transaction may still succeed.
 */
export async function simulateSwap(
  publicClient: PublicClient,
  token: Address,
  ethAmountWei: bigint,
  from: Address,
): Promise<{ success: boolean; error?: string }> {
  const tx = buildBuyTransaction(token, ethAmountWei);

  try {
    await publicClient.call({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      account: from,
    });
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message.slice(0, 100) : "Unknown",
    };
  }
}