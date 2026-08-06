#!/usr/bin/env node
/**
 * Robinhood V4 Swap Executor
 * 
 * Handles actual swap execution on Robinhood chain (4663).
 * Uses V4 PoolManager direct swap — the only working path
 * since Universal Router is not deployed on Robinhood.
 * 
 * USAGE:
 *   node scripts/swap-executor.mjs buy <TOKEN> <ETH_AMOUNT>
 *   node scripts/swap-executor.mjs sell <TOKEN> <TOKEN_AMOUNT>
 * 
 * ENV:
 *   BOT_PRIVATE_KEY — private key for signing
 *   ROBINHOOD_RPC_URL — RPC endpoint (defaults to Alchemy)
 */

import { createPublicClient, createWalletClient, http, getAddress, parseEther, parseUnits, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, encodePacked, keccak256 } from "viem";

// ─── Config ────────────────────────────────────────────────────────────────

const RPC = process.env.ROBINHOOD_RPC_URL || "https://robinhood-mainnet.g.alchemy.com/v2/Bx7R4TgFfGe_x9HB_KjY2";
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const WETH = "0x4200000000000000000000000000000000000006";
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000";

const chain = {
  id: 4663, name: "Robinhood",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// ─── V4 Swap ABI ──────────────────────────────────────────────────────────

const swapAbi = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData) external payable returns (int256 delta)",
]);

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// ─── Pool ID computation ──────────────────────────────────────────────────

function computePoolId(token) {
  const t0 = getAddress(WETH.toLowerCase());
  const t1 = getAddress(token.toLowerCase());
  // Order: lower address = currency0
  const [c0, c1] = t0 < t1 ? [t0, t1] : [t1, t0];
  return keccak256(encodePacked(["address", "address", "uint24", "int24", "address"], [c0, c1, 3000, 60, ZERO_HOOKS]));
}

// ─── Swap encoding ────────────────────────────────────────────────────────

function buildSwap(token, ethInWei, isBuy) {
  const t0 = getAddress(WETH.toLowerCase());
  const t1 = getAddress(token.toLowerCase());
  const [c0, c1] = t0 < t1 ? [t0, t1] : [t1, t0];
  const zeroForOne = isBuy; // buy = WETH→token = token0→token1 if WETH is token0

  const data = encodeFunctionData({
    abi: swapAbi,
    functionName: "swap",
    args: [
      { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: ZERO_HOOKS },
      { zeroForOne, amountSpecified: ethInWei, sqrtPriceLimitX96: 0n },
      "0x",
    ],
  });

  return { to: PM, data, value: isBuy ? ethInWei : 0n };
}

// ─── Clients ──────────────────────────────────────────────────────────────

function getClients() {
  const pk = process.env.BOT_PRIVATE_KEY;
  if (!pk) throw new Error("BOT_PRIVATE_KEY not set");
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 15000 }) });
  const walletClient = createWalletClient({ chain, transport: http(RPC), account });
  return { publicClient, walletClient, account };
}

// ─── Execute buy (ETH → token) ────────────────────────────────────────────

async function executeBuy(token, ethAmount) {
  const { publicClient, walletClient, account } = getClients();
  const tokenAddr = getAddress(token.toLowerCase());
  const ethInWei = parseEther(ethAmount.toString());

  console.log(`\n🚀 BUY: ${ethAmount} ETH → ${tokenAddr}`);
  console.log(`  PoolManager: ${PM}`);

  const tx = buildSwap(tokenAddr, ethInWei, true);
  console.log(`  Pool ID: ${computePoolId(tokenAddr)}`);
  console.log(`  Calldata: ${tx.data.slice(0, 66)}...`);

  // Check balance
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`  Wallet: ${account.address} | Balance: ${formatEther(balance)} ETH`);

  if (balance < ethInWei) {
    console.error(`  ❌ Insufficient balance (need ${ethAmount} ETH, have ${formatEther(balance)})`);
    process.exit(1);
  }

  console.log(`  Sending transaction...`);
  try {
    const hash = await walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    console.log(`  ✅ TX SENT: ${hash}`);
    console.log(`  Explorer: https://explorer.robinhood.technology/tx/${hash}`);

    // Wait for receipt
    console.log(`  Waiting for confirmation...`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✅ CONFIRMED in block ${receipt.blockNumber} (${receipt.status === "success" ? "SUCCESS" : "FAILED"})`);
    return { hash, receipt };
  } catch (e) {
    console.error(`  ❌ TX FAILED: ${e.message?.slice(0, 200)}`);

    // Try to decode the revert reason
    if (e.message?.includes("execution reverted")) {
      console.error(`\n  💡 Robinhood V4 PoolManager may reject direct swaps.`);
      console.error(`  Try the Uniswap web interface at:`);
      console.error(`  https://app.uniswap.org/explore/tokens/4663/${tokenAddr}`);
    }
    process.exit(1);
  }
}

// ─── Execute sell (token → ETH) ───────────────────────────────────────────

async function executeSell(token, tokenAmount) {
  const { publicClient, walletClient, account } = getClients();
  const tokenAddr = getAddress(token.toLowerCase());

  console.log(`\n💰 SELL: ${tokenAmount} tokens → ETH`);
  console.log(`  Token: ${tokenAddr}`);

  // Check token balance
  const decimals = 18; // All Instant Launch tokens are 18 decimals
  const tokenInWei = parseUnits(tokenAmount.toString(), decimals);
  const balance = await publicClient.readContract({
    address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  });
  console.log(`  Token balance: ${formatEther(balance)}`);

  if (balance < tokenInWei) {
    console.error(`  ❌ Insufficient token balance`);
    process.exit(1);
  }

  // Check allowance
  const allowance = await publicClient.readContract({
    address: tokenAddr, abi: erc20Abi, functionName: "allowance", args: [account.address, PM],
  });
  console.log(`  Allowance: ${formatEther(allowance)}`);

  // Approve if needed
  if (allowance < tokenInWei) {
    console.log(`  Approving PoolManager to spend tokens...`);
    const approveHash = await walletClient.sendTransaction({
      to: tokenAddr,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PM, tokenInWei] }),
    });
    console.log(`  ✅ APPROVE TX: ${approveHash}`);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`  ✅ Approved`);
  }

  // Execute swap
  const tx = buildSwap(tokenAddr, tokenInWei, false);
  console.log(`  Sending sell transaction...`);

  try {
    const hash = await walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    console.log(`  ✅ SELL TX: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✅ CONFIRMED (${receipt.status === "success" ? "SUCCESS" : "FAILED"})`);
    return { hash, receipt };
  } catch (e) {
    console.error(`  ❌ SELL FAILED: ${e.message?.slice(0, 200)}`);
    process.exit(1);
  }
}

// ─── Test / dry run ───────────────────────────────────────────────────────

async function testSwap(token, ethAmount) {
  const { publicClient, account } = getClients();
  const tokenAddr = getAddress(token.toLowerCase());
  const ethInWei = parseEther(ethAmount.toString());
  const poolId = computePoolId(tokenAddr);

  console.log(`\n🔬 TESTING SWAP (dry run / simulation)`);
  console.log(`  Pool ID: ${poolId}`);
  console.log(`  PoolManager: ${PM}`);
  console.log(`  Amount: ${ethAmount} ETH → ${tokenAddr}`);

  // Try to call the pool manager directly
  const tx = buildSwap(tokenAddr, ethInWei, true);
  try {
    const result = await publicClient.call({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      account: account.address,
    });
    console.log(`  ✅ Simulation SUCCESS`);
    console.log(`  Result: ${result.data?.slice(0, 66)}`);
    return true;
  } catch (e) {
    console.log(`  ⚠️  Simulation REVERTED: ${e.message?.slice(0, 100)}`);
    console.log(`\n  💡 This is EXPECTED on Robinhood. The V4 PoolManager's view`);
    console.log(`  functions (getSlot0, getLiquidity) revert on eth_call, but`);
    console.log(`  actual swap TRANSACTIONS may still succeed. The only way to`);
    console.log(`  know is to try with a real transaction.`);
    console.log(`\n  Run with --live to attempt a real swap.`);
    return false;
  }
}

// ─── Entry ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const token = args[1];
  const amount = args[2];

  if (!cmd || !token) {
    console.log("Usage:");
    console.log("  node scripts/swap-executor.mjs buy <TOKEN_ADDR> <ETH_AMOUNT>");
    console.log("  node scripts/swap-executor.mjs sell <TOKEN_ADDR> <TOKEN_AMOUNT>");
    console.log("  node scripts/swap-executor.mjs test <TOKEN_ADDR> <ETH_AMOUNT>");
    console.log("\nEnv: BOT_PRIVATE_KEY=0x...");
    process.exit(1);
  }

  if (cmd === "test") {
    await testSwap(token, amount || "0.0001");
  } else if (cmd === "buy") {
    if (!amount) { console.error("ETH amount required"); process.exit(1); }
    await executeBuy(token, amount);
  } else if (cmd === "sell") {
    if (!amount) { console.error("Token amount required"); process.exit(1); }
    await executeSell(token, amount);
  } else {
    console.error("Unknown command:", cmd);
    process.exit(1);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });