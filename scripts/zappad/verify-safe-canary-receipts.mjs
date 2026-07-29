import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  isHash,
} from "viem";
import { parsePreparedCanaryManifest } from "./lib/canary-prepared-manifest.mjs";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";
import {
  hasPreparedExecutionSuccess,
  SAFE_ABI,
} from "./lib/safe-canary-receipts.mjs";

const EXPECTED_CHAIN_ID = 4663;
const ZERO_ADDRESS = getAddress("0x0000000000000000000000000000000000000000");
const DEFAULT_MIN_CONFIRMATIONS = 12n;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

function parseMinimumConfirmations() {
  const raw = process.env.CANARY_MIN_CONFIRMATIONS ?? "12";
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("CANARY_MIN_CONFIRMATIONS must be a positive integer");
  }
  return BigInt(raw);
}

async function rpcCall(label, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`RPC request failed while reading ${label}`);
  }
}

async function verifyExecution({
  client,
  headBlock,
  minimumConfirmations,
  safe,
  outerTransactionHash,
  plan,
  label,
}) {
  const [transaction, receipt] = await Promise.all([
    rpcCall(`${label} transaction`, () =>
      client.getTransaction({ hash: outerTransactionHash }),
    ),
    rpcCall(`${label} receipt`, () =>
      client.getTransactionReceipt({ hash: outerTransactionHash }),
    ),
  ]);

  if (receipt.status !== "success") {
    throw new Error(`${label} Safe execution reverted`);
  }
  if (
    !transaction.to ||
    !receipt.to ||
    !sameAddress(transaction.to, safe) ||
    !sameAddress(receipt.to, safe)
  ) {
    throw new Error(`${label} outer transaction did not call the Safe`);
  }
  if (headBlock < receipt.blockNumber) {
    throw new Error(`${label} receipt block is ahead of the RPC head`);
  }
  const confirmations = headBlock - receipt.blockNumber + 1n;
  if (confirmations < minimumConfirmations) {
    throw new Error(
      `${label} has ${confirmations} confirmations; ${minimumConfirmations} required`,
    );
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: SAFE_ABI, data: transaction.input });
  } catch {
    throw new Error(`${label} calldata is not Safe execTransaction`);
  }
  if (decoded.functionName !== "execTransaction") {
    throw new Error(`${label} calldata is not Safe execTransaction`);
  }

  const [
    target,
    value,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    signatures,
  ] = decoded.args;
  if (!sameAddress(target, plan.target)) {
    throw new Error(`${label} claim target does not match the prepared plan`);
  }
  if (data.toLowerCase() !== plan.data) {
    throw new Error(`${label} claim calldata does not match the prepared plan`);
  }
  if (
    value !== 0n ||
    operation !== 0 ||
    safeTxGas !== 0n ||
    baseGas !== 0n ||
    gasPrice !== 0n ||
    !sameAddress(gasToken, ZERO_ADDRESS) ||
    !sameAddress(refundReceiver, ZERO_ADDRESS)
  ) {
    throw new Error(`${label} Safe transaction parameters changed after preparation`);
  }
  if (signatures === "0x") {
    throw new Error(`${label} Safe transaction has no owner authorization`);
  }

  if (
    !hasPreparedExecutionSuccess(
      receipt.logs,
      safe,
      plan.safeTransactionHash,
    )
  ) {
    throw new Error(
      `${label} receipt lacks ExecutionSuccess for the prepared Safe transaction hash`,
    );
  }

  return {
    outerTransactionHash,
    safeTransactionHash: plan.safeTransactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    confirmations: confirmations.toString(),
    status: "success",
    target: plan.target,
  };
}

async function main() {
  const releaseCommit = requiredEnv("EXPECTED_RELEASE_COMMIT");
  await verifyReleaseCheckout(releaseCommit);
  const rpcUrl = requiredEnv("ROBINHOOD_RPC_URL");
  const parsedRpc = new URL(rpcUrl);
  if (parsedRpc.protocol !== "https:") {
    throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
  }

  const preparedManifestPath = resolve(
    process.argv[2] ?? requiredEnv("CANARY_PREPARED_MANIFEST"),
  );
  const preparedManifestJson = await readFile(preparedManifestPath, "utf8");
  const prepared = parsePreparedCanaryManifest(preparedManifestJson, {
    expectedHash: requiredEnv("EXPECTED_CANARY_PREPARED_MANIFEST_HASH"),
    expectedReleaseCommit: releaseCommit,
  });
  const safe = prepared.safe;
  const minimumConfirmations =
    process.env.CANARY_MIN_CONFIRMATIONS == null
      ? DEFAULT_MIN_CONFIRMATIONS
      : parseMinimumConfirmations();
  const outerHashes = {
    weth: requiredEnv("WETH_SAFE_EXECUTION_TX_HASH"),
    usdg: requiredEnv("USDG_SAFE_EXECUTION_TX_HASH"),
  };
  for (const [label, hash] of Object.entries(outerHashes)) {
    if (!isHash(hash)) throw new Error(`${label} execution transaction hash is invalid`);
  }
  if (outerHashes.weth.toLowerCase() === outerHashes.usdg.toLowerCase()) {
    throw new Error("Safe execution transaction hashes must be distinct");
  }

  const client = createPublicClient({ transport: http(rpcUrl) });
  const [chainId, headBlock] = await Promise.all([
    rpcCall("chain id", () => client.getChainId()),
    rpcCall("head block", () => client.getBlockNumber()),
  ]);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${EXPECTED_CHAIN_ID}, received ${chainId}`);
  }

  const weth = await verifyExecution({
    client,
    headBlock,
    minimumConfirmations,
    safe,
    outerTransactionHash: outerHashes.weth,
    plan: prepared.claims.weth,
    label: "WETH",
  });
  const usdg = await verifyExecution({
    client,
    headBlock,
    minimumConfirmations,
    safe,
    outerTransactionHash: outerHashes.usdg,
    plan: prepared.claims.usdg,
    label: "USDG",
  });

  const evidence = {
    ok: true,
    kind: "zappad-safe-canary-receipts",
    chainId,
    releaseCommit: prepared.releaseCommit,
    checkedAtBlock: headBlock.toString(),
    minimumConfirmations: minimumConfirmations.toString(),
    preparedManifestHash: prepared.hash,
    safeDeploymentEvidenceHash: prepared.safeDeploymentEvidenceHash,
    safe,
    executions: { weth, usdg },
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.CANARY_SAFE_RECEIPT_EVIDENCE) {
    await writeFile(resolve(process.env.CANARY_SAFE_RECEIPT_EVIDENCE), json, {
      flag: "wx",
    });
  }
  process.stdout.write(json);
}

main().catch((error) => {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const raw = error instanceof Error ? error.message : String(error);
  const message = rpcUrl ? raw.split(rpcUrl).join("[redacted RPC]") : raw;
  console.error(message);
  process.exitCode = 1;
});
