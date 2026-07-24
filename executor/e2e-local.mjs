#!/usr/bin/env node
// End-to-end proof of the v3 execution types against a LOCAL anvil chain (never mainnet):
// deploys the full v3 stack from forge artifacts, signs real RecurringIntent/TriggerIntent typed
// data with the owner key, drops intent files in a scratch store, and drives the executor engine's
// `tick` — asserting that runs execute when owed and only when owed, and that the 1% fee lands
// 80/20 on the executor wallet and the lottery pot.
//
//   anvil --port 8547 &   # then:
//   node executor/e2e-local.mjs
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  defineChain,
  http,
  encodeAbiParameters,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tick, log } from "./engine.mjs";
import { convertPotFees } from "./keeper.mjs";
import { loadIntents, archiveIntent } from "./store.mjs";

const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:8547";
// anvil's well-known dev keys (public knowledge, valueless outside a local chain)
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const EXECUTOR_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const deployer = privateKeyToAccount(DEPLOYER_PK);
const ownerAccount = privateKeyToAccount(OWNER_PK);
const executorAccount = privateKeyToAccount(EXECUTOR_PK);

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const executorWallet = createWalletClient({ account: executorAccount, chain, transport: http(RPC) });

const OUT = join(import.meta.dirname, "..", "contracts", "out");
function artifact(file, name) {
  const a = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

async function deploy(file, name, args = []) {
  const { abi, bytecode } = artifact(file, name);
  const hash = await deployerWallet.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress, abi };
}

async function write(contract, functionName, args, wallet = deployerWallet) {
  const hash = await wallet.writeContract({ address: contract.address, abi: contract.abi, functionName, args });
  return publicClient.waitForTransactionReceipt({ hash });
}

const read = (contract, functionName, args = []) =>
  publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });

let failures = 0;
function assertEq(actual, expected, label) {
  const ok = actual === expected;
  log(ok ? "info" : "error", `${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${actual}, want ${expected})`}`);
  if (!ok) failures++;
}

async function main() {
  assertEq(await publicClient.getChainId(), 31337, "connected to local anvil (never mainnet)");

  // ---- deploy the v3 stack ----
  const registry = await deploy("AdapterRegistry.sol", "AdapterRegistry", [deployer.address]);
  const priceSources = await deploy("AdapterRegistry.sol", "AdapterRegistry", [deployer.address]);
  const allowlist = await deploy("TokenAllowlist.sol", "TokenAllowlist", [deployer.address]);
  const tokenIn = await deploy("MockERC20.sol", "MockERC20", ["In", "IN", 18]);
  const zapsToken = await deploy("MockERC20.sol", "MockERC20", ["Zaps", "ZAPS", 18]);
  const adapter = await deploy("MockSwapAdapter.sol", "MockSwapAdapter");
  const buyAdapter = await deploy("MockZapsBuyAdapter.sol", "MockZapsBuyAdapter", [zapsToken.address, parseEther("1")]);
  const priceSource = await deploy("MockPriceSource.sol", "MockPriceSource");
  const pot = await deploy("ZapLotteryPot.sol", "ZapLotteryPot", [deployer.address, zapsToken.address, buyAdapter.address]);
  const factory = await deploy("OpenZapFactoryV3.sol", "OpenZapFactoryV3", [
    registry.address,
    allowlist.address,
    priceSources.address,
    pot.address,
  ]);

  await write(registry, "setAdapter", [adapter.address, true]);
  await write(priceSources, "setAdapter", [priceSource.address, true]);
  await write(allowlist, "setToken", [tokenIn.address, true]);
  await write(allowlist, "setToken", [zapsToken.address, true]);
  await write(pot, "setFactory", [factory.address]);
  await write(zapsToken, "mint", [adapter.address, parseEther("1000000")]);
  await write(zapsToken, "mint", [buyAdapter.address, parseEther("1000000")]); // pot buyZaps reserve

  // ---- create + fund a zap owned by the OWNER key ----
  const amountIn = parseEther("100");
  const policy = {
    owner: ownerAccount.address,
    recipient: ownerAccount.address,
    maxRelayerFeeCap: 0n,
    optimization: true,
    trackedAssets: [tokenIn.address, zapsToken.address],
    steps: [
      {
        adapter: adapter.address,
        tokenIn: tokenIn.address,
        spender: adapter.address,
        amountIn,
        data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [zapsToken.address, parseEther("1")]),
      },
    ],
  };
  const salt = `0x${"e2".repeat(32)}`;
  const zapAddress = await read(factory, "predict", [policy, salt]);
  await write(factory, "createZap", [policy, salt]);
  await write(tokenIn, "mint", [zapAddress, amountIn * 3n]); // 2 recurring runs + 1 trigger run

  const zapArtifact = artifact("OpenZapV3.sol", "OpenZapV3");
  const zapContract = { address: zapAddress, abi: zapArtifact.abi };
  const policyHash = await read(zapContract, "policyHash");
  log("info", `zap deployed at ${zapAddress} (policyHash ${policyHash})`);

  // ---- sign standing intents exactly the way the app will (EIP-712, domain version "3") ----
  const domain = { name: "OpenZap", version: "3", chainId: 31337, verifyingContract: zapAddress };
  const block = await publicClient.getBlock();
  const deadline = block.timestamp + 86_400n * 30n;

  const recurringIntent = {
    zap: zapAddress,
    chainId: 31337n,
    seriesId: 1n,
    validAfter: 0n,
    deadline,
    interval: 3600n,
    maxRuns: 2n,
    recipient: ownerAccount.address,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: 5_000_000n,
    maxFeePerGas: 1_000_000_000_000n,
    policyHash,
    outAsset: zapsToken.address,
    minOutPerRun: parseEther("98"),
  };
  const recurringSig = await ownerAccount.signTypedData({
    domain,
    types: {
      RecurringIntent: [
        { name: "zap", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "seriesId", type: "uint256" },
        { name: "validAfter", type: "uint64" },
        { name: "deadline", type: "uint64" },
        { name: "interval", type: "uint64" },
        { name: "maxRuns", type: "uint32" },
        { name: "recipient", type: "address" },
        { name: "executor", type: "address" },
        { name: "maxGas", type: "uint256" },
        { name: "maxFeePerGas", type: "uint256" },
        { name: "policyHash", type: "bytes32" },
        { name: "outAsset", type: "address" },
        { name: "minOutPerRun", type: "uint256" },
      ],
    },
    primaryType: "RecurringIntent",
    message: recurringIntent,
  });

  const triggerIntent = {
    zap: zapAddress,
    chainId: 31337n,
    nonce: 7n,
    validAfter: 0n,
    deadline,
    priceSource: priceSource.address,
    baselinePriceX96: parseEther("1000"),
    thresholdBps: 1000n,
    above: true,
    recipient: ownerAccount.address,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: 5_000_000n,
    maxFeePerGas: 1_000_000_000_000n,
    policyHash,
    outAsset: zapsToken.address,
    minOut: parseEther("98"),
  };
  const triggerSig = await ownerAccount.signTypedData({
    domain,
    types: {
      TriggerIntent: [
        { name: "zap", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "validAfter", type: "uint64" },
        { name: "deadline", type: "uint64" },
        { name: "priceSource", type: "address" },
        { name: "baselinePriceX96", type: "uint256" },
        { name: "thresholdBps", type: "uint32" },
        { name: "above", type: "bool" },
        { name: "recipient", type: "address" },
        { name: "executor", type: "address" },
        { name: "maxGas", type: "uint256" },
        { name: "maxFeePerGas", type: "uint256" },
        { name: "policyHash", type: "bytes32" },
        { name: "outAsset", type: "address" },
        { name: "minOut", type: "uint256" },
      ],
    },
    primaryType: "TriggerIntent",
    message: triggerIntent,
  });

  // ---- drop the intents into a scratch store, exactly as an owner would ----
  const scratch = mkdtempSync(join(tmpdir(), "openzaps-e2e-"));
  const asJson = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(join(scratch, "recurring.json"), asJson({ kind: "recurring", intent: recurringIntent, signature: recurringSig }));
  writeFileSync(join(scratch, "trigger.json"), asJson({ kind: "trigger", intent: triggerIntent, signature: triggerSig }));

  const cfg = { chainId: 31337, maxFeePerGasWei: 1_000_000_000_000n };
  const doneDir = mkdtempSync(join(tmpdir(), "openzaps-e2e-done-"));
  const pass = async () => {
    const { ok, bad } = loadIntents(scratch);
    if (bad.length) bad.forEach((b) => log("error", `unparseable ${b.file}: ${b.error}`));
    return tick({
      publicClient,
      walletClient: executorWallet,
      cfg,
      intents: ok,
      archive: (item, reason) => archiveIntent(item, doneDir, reason),
    });
  };

  // ---- pass 1: recurring run 1 executes; trigger is unarmed (price below bound) ----
  await write(priceSource, "setPrice", [parseEther("1050")]); // +5%, below the +10% bound
  let results = await pass();
  const byLabel = (rs, frag) => rs.find((r) => r.label.includes(frag));
  assertEq(byLabel(results, "recurring")?.outcome, "executed", "recurring run 1 executes when owed");
  assertEq(byLabel(results, "trigger")?.status, "waiting", "trigger stays armed while below +10%");

  // ---- pass 2: nothing owed — the cadence gate holds ----
  results = await pass();
  assertEq(byLabel(results, "recurring")?.status, "waiting", "recurring run 2 NOT owed before the interval");

  // ---- pass 3: warp past the interval — run 2 executes and exhausts the series ----
  await testClient.increaseTime({ seconds: 3600 });
  await testClient.mine({ blocks: 1 });
  results = await pass();
  assertEq(byLabel(results, "recurring")?.outcome, "executed", "recurring run 2 executes after the interval");

  // ---- pass 4: exhausted series is archived; +10% move arms and fires the trigger ----
  await write(priceSource, "setPrice", [parseEther("1100")]); // exactly the +10% bound
  results = await pass();
  assertEq(byLabel(results, "recurring")?.status, "finished", "exhausted series archived");
  assertEq(byLabel(results, "trigger")?.outcome, "executed", "trigger fires at the +10% bound");

  // ---- economics: 3 runs of 100 => fee 1 each => executor 0.8*3, pot 0.2*3, owner 99*3 ----
  const zapsBal = (a) => publicClient.readContract({ address: zapsToken.address, abi: zapsToken.abi, functionName: "balanceOf", args: [a] });
  assertEq(await zapsBal(executorAccount.address), parseEther("2.4"), "executor earned 80% of 1% on all 3 runs");
  assertEq(await zapsBal(pot.address), parseEther("0.6"), "pot received 20% of 1% on all 3 runs");
  assertEq(await zapsBal(ownerAccount.address), parseEther("297"), "recipient received net output of all 3 runs");
  assertEq(await read(pot, "tickets", [1n, ownerAccount.address]), parseEther("0.6"), "owner holds lottery tickets equal to contributed fees");
  assertEq(await read(pot, "roundPrize", [1n]), parseEther("0.6"), "round 1 prize accrued in 0xZAPS");

  // ---- pot-conversion keeper: a sell run leaves aeWETH-denominated fees the keeper must convert ----
  // The prior runs settled in 0xZAPS (credited straight to the prize). Simulate a fee asset (aeWETH)
  // accruing in the pot and drive the real keeper: it reads the price source, floors output by
  // slippage, and calls the permissionless buyZaps to turn the fee into 0xZAPS prize.
  const feeAsset = await deploy("MockERC20.sol", "MockERC20", ["Fee", "FEE", 18]);
  await write(feeAsset, "mint", [pot.address, parseEther("1")]); // 1 aeWETH of accrued fee
  const keeperPrice = await deploy("MockPriceSource.sol", "MockPriceSource");
  await write(keeperPrice, "setPrice", [1n << 96n]); // 1 0xZAPS per fee-asset (Q96), matches the 1:1 mock adapter

  const keeperCfg = {
    chainId: 31337,
    maxFeePerGasWei: 1_000_000_000_000n,
    lotteryPot: pot.address,
    poolPriceSource: keeperPrice.address,
    feeAsset: feeAsset.address,
    convertMinWei: parseEther("0.001"),
    convertSlippageBps: 300,
  };

  const prizeBefore = await read(pot, "roundPrize", [1n]);
  const conv = await convertPotFees({ publicClient, walletClient: executorWallet, cfg: keeperCfg });
  assertEq(conv.outcome, "converted", "keeper converts accrued fee asset to 0xZAPS via buyZaps");
  assertEq(await read(pot, "roundPrize", [1n]), prizeBefore + parseEther("1"), "converted 0xZAPS added to the round prize");

  const feeBalAfter = await publicClient.readContract({ address: feeAsset.address, abi: feeAsset.abi, functionName: "balanceOf", args: [pot.address] });
  assertEq(feeBalAfter, 0n, "pot fully drained of the fee asset");
  const idle = await convertPotFees({ publicClient, walletClient: executorWallet, cfg: keeperCfg });
  assertEq(idle.outcome, "idle", "keeper idles when the pot holds no convertible fee");

  log(failures ? "error" : "info", failures ? `E2E FAILED — ${failures} assertion(s)` : "E2E PASSED — all assertions green");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  log("error", err.stack ?? String(err));
  process.exitCode = 1;
});
