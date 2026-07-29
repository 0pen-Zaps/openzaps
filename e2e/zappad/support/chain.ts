import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hash,
} from "viem";
import type { ZapPadE2eRunState } from "./run-state";

const launcherAbi = parseAbi([
  "function launches(address token) view returns (bool exists, address creator, address pool, address feeVault, uint256 positionId, address pairedAsset, uint24 feeTier, int24 floorTick)",
]);

const feeVaultAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function claimableAll(address holder) view returns (address[] assets, uint256[] amounts)",
  "function assetState(address asset) view returns (uint256 accRevenuePerShare, uint256 lastBalance, uint256 totalSynced, uint256 totalClaimed)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const positionManagerAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

const swapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface LaunchReadback {
  exists: boolean;
  creator: Address;
  pool: Address;
  feeVault: Address;
  positionId: bigint;
  pairedAsset: Address;
  feeTier: number;
  floorTick: number;
}

export interface ClaimableSnapshot {
  assets: readonly Address[];
  amounts: readonly bigint[];
}

export interface AssetState {
  accRevenuePerShare: bigint;
  lastBalance: bigint;
  totalSynced: bigint;
  totalClaimed: bigint;
}

function chain(state: ZapPadE2eRunState) {
  return defineChain({
    id: state.chainId,
    name: "Robinhood Chain E2E",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [state.rpcUrl] } },
  });
}

export function publicClient(state: ZapPadE2eRunState) {
  return createPublicClient({
    chain: chain(state),
    transport: http(state.rpcUrl, { retryCount: 0, timeout: 20_000 }),
  });
}

function walletClient(state: ZapPadE2eRunState, account: Address) {
  return createWalletClient({
    account,
    chain: chain(state),
    transport: http(state.rpcUrl, { retryCount: 0, timeout: 20_000 }),
  });
}

async function included(state: ZapPadE2eRunState, hash: Hash) {
  const receipt = await publicClient(state).waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 30_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`Loopback transaction reverted: ${hash}`);
  }
  return receipt;
}

export async function readLaunch(
  state: ZapPadE2eRunState,
  token: Address,
): Promise<LaunchReadback> {
  const result = await publicClient(state).readContract({
    address: state.launcher,
    abi: launcherAbi,
    functionName: "launches",
    args: [token],
  });
  return {
    exists: result[0],
    creator: result[1],
    pool: result[2],
    feeVault: result[3],
    positionId: result[4],
    pairedAsset: result[5],
    feeTier: result[6],
    floorTick: result[7],
  };
}

export async function readClaimables(
  state: ZapPadE2eRunState,
  vault: Address,
  holder: Address,
): Promise<ClaimableSnapshot> {
  const [assets, amounts] = await publicClient(state).readContract({
    address: vault,
    abi: feeVaultAbi,
    functionName: "claimableAll",
    args: [holder],
  });
  return { assets, amounts };
}

export async function readAssetState(
  state: ZapPadE2eRunState,
  vault: Address,
  asset: Address,
): Promise<AssetState> {
  const result = await publicClient(state).readContract({
    address: vault,
    abi: feeVaultAbi,
    functionName: "assetState",
    args: [asset],
  });
  return {
    accRevenuePerShare: result[0],
    lastBalance: result[1],
    totalSynced: result[2],
    totalClaimed: result[3],
  };
}

export async function readVaultShares(
  state: ZapPadE2eRunState,
  vault: Address,
  holder: Address,
) {
  return publicClient(state).readContract({
    address: vault,
    abi: feeVaultAbi,
    functionName: "balanceOf",
    args: [holder],
  });
}

export async function readVaultSupply(
  state: ZapPadE2eRunState,
  vault: Address,
) {
  return publicClient(state).readContract({
    address: vault,
    abi: feeVaultAbi,
    functionName: "totalSupply",
  });
}

export async function readTokenBalance(
  state: ZapPadE2eRunState,
  token: Address,
  holder: Address,
) {
  return publicClient(state).readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
}

export async function readAllowance(
  state: ZapPadE2eRunState,
  token: Address,
  owner: Address,
  spender: Address,
) {
  return publicClient(state).readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export async function readPositionOwner(
  state: ZapPadE2eRunState,
  positionId: bigint,
) {
  return publicClient(state).readContract({
    address: state.contracts.positionManager,
    abi: positionManagerAbi,
    functionName: "ownerOf",
    args: [positionId],
  });
}

export async function transferToken(
  state: ZapPadE2eRunState,
  token: Address,
  from: Address,
  to: Address,
  amount: bigint,
) {
  const hash = await walletClient(state, from).writeContract({
    account: from,
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  return included(state, hash);
}

export async function approveToken(
  state: ZapPadE2eRunState,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
) {
  const hash = await walletClient(state, owner).writeContract({
    account: owner,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  return included(state, hash);
}

export async function sellTokenForWeth(
  state: ZapPadE2eRunState,
  token: Address,
  trader: Address,
  amount: bigint,
  fee: number,
) {
  const wallet = walletClient(state, trader);
  const approvalHash = await wallet.writeContract({
    account: trader,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [state.contracts.swapRouter, amount],
  });
  await included(state, approvalHash);

  const before = await readTokenBalance(
    state,
    state.contracts.weth,
    trader,
  );
  const swapHash = await wallet.writeContract({
    account: trader,
    address: state.contracts.swapRouter,
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: token,
        tokenOut: state.contracts.weth,
        fee,
        recipient: trader,
        amountIn: amount,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const receipt = await included(state, swapHash);
  const after = await readTokenBalance(state, state.contracts.weth, trader);
  if (after <= before) throw new Error("External token-to-WETH swap returned no WETH.");
  return { receipt, amountOut: after - before };
}
