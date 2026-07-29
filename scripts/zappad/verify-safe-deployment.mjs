import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  isHash,
  keccak256,
} from "viem";
import {
  assertProxyCreationLog,
  assertSafeStateMatches,
  createSafeDeploymentExpectation,
  readSafeStateAtBlock,
  SAFE_DEPLOYMENT_CONSTANTS,
  SAFE_PROXY_FACTORY_ABI,
  serializeSafeState,
  validateReviewedSafeSimulationManifest,
} from "./lib/safe-deployment-evidence.mjs";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";

const DEFAULT_MIN_CONFIRMATIONS = 12n;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name] ?? fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(raw);
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

async function rpcCall(label, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`RPC request failed while reading ${label}`);
  }
}

function proxyDeploymentCodeHash(proxyCreationCode) {
  const singletonWord = encodeAbiParameters(
    [{ type: "uint256" }],
    [BigInt(SAFE_DEPLOYMENT_CONSTANTS.singleton)],
  );
  return keccak256(concatHex([proxyCreationCode, singletonWord]));
}

async function main() {
  const rpcUrl = requiredEnv("ROBINHOOD_RPC_URL");
  if (new URL(rpcUrl).protocol !== "https:") {
    throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
  }

  const manifestPath = resolve(
    process.argv[2] ?? requiredEnv("SAFE_SIMULATION_MANIFEST"),
  );
  const manifestJson = await readFile(manifestPath, "utf8");
  const manifest = validateReviewedSafeSimulationManifest(
    manifestJson,
    requiredEnv("EXPECTED_SAFE_SIMULATION_MANIFEST_HASH"),
  );

  const deploymentTransactionHash = requiredEnv("SAFE_DEPLOYMENT_TX_HASH");
  if (!isHash(deploymentTransactionHash)) {
    throw new Error("SAFE_DEPLOYMENT_TX_HASH is invalid");
  }
  const deployer = requiredEnv("SAFE_DEPLOYER_ADDRESS");
  if (!isAddress(deployer)) throw new Error("SAFE_DEPLOYER_ADDRESS is invalid");
  const normalizedDeployer = getAddress(deployer);
  const releaseCommit = requiredEnv("EXPECTED_RELEASE_COMMIT");
  await verifyReleaseCheckout(releaseCommit);
  const minimumConfirmations = positiveIntegerEnv(
    "SAFE_DEPLOYMENT_MIN_CONFIRMATIONS",
    DEFAULT_MIN_CONFIRMATIONS.toString(),
  );

  const client = createPublicClient({ transport: http(rpcUrl) });
  const [chainId, headBlock, transaction, receipt] = await Promise.all([
    rpcCall("chain id", () => client.getChainId()),
    rpcCall("head block", () => client.getBlockNumber()),
    rpcCall("Safe deployment transaction", () =>
      client.getTransaction({ hash: deploymentTransactionHash }),
    ),
    rpcCall("Safe deployment receipt", () =>
      client.getTransactionReceipt({ hash: deploymentTransactionHash }),
    ),
  ]);
  if (chainId !== SAFE_DEPLOYMENT_CONSTANTS.chainId) {
    throw new Error(
      `Wrong chain: expected ${SAFE_DEPLOYMENT_CONSTANTS.chainId}, received ${chainId}`,
    );
  }
  if (
    receipt.status !== "success" ||
    transaction.hash.toLowerCase() !== deploymentTransactionHash.toLowerCase() ||
    receipt.transactionHash.toLowerCase() !==
      deploymentTransactionHash.toLowerCase() ||
    !transaction.to ||
    !receipt.to ||
    !sameAddress(transaction.to, SAFE_DEPLOYMENT_CONSTANTS.proxyFactory) ||
    !sameAddress(receipt.to, SAFE_DEPLOYMENT_CONSTANTS.proxyFactory) ||
    !sameAddress(transaction.from, normalizedDeployer) ||
    !sameAddress(receipt.from, normalizedDeployer) ||
    transaction.value !== 0n ||
    receipt.contractAddress != null ||
    transaction.blockHash == null ||
    transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    transaction.blockNumber !== receipt.blockNumber
  ) {
    throw new Error(
      "Safe deployment transaction or receipt does not match the canonical factory call",
    );
  }
  if (
    transaction.chainId != null &&
    Number(transaction.chainId) !== SAFE_DEPLOYMENT_CONSTANTS.chainId
  ) {
    throw new Error("Safe deployment transaction chainId mismatch");
  }
  if (headBlock < receipt.blockNumber) {
    throw new Error("Safe deployment receipt block is ahead of the RPC head");
  }
  if (manifest.simulatedAtBlock > receipt.blockNumber) {
    throw new Error("Safe simulation manifest was produced after the deployment");
  }
  const confirmations = headBlock - receipt.blockNumber + 1n;
  if (confirmations < minimumConfirmations) {
    throw new Error(
      `Safe deployment has ${confirmations} confirmations; ${minimumConfirmations} required`,
    );
  }

  const checkedBlock = await rpcCall("checked block", () =>
    client.getBlock({ blockNumber: headBlock }),
  );
  if (!checkedBlock.hash || checkedBlock.number !== headBlock) {
    throw new Error("Unable to establish an exact Safe verification block");
  }

  const [
    factoryCodeAtDeployment,
    singletonCodeAtDeployment,
    fallbackHandlerCodeAtDeployment,
    proxyCreationCodeAtDeployment,
  ] =
    await Promise.all([
      rpcCall("Safe proxy factory deployment-block code", () =>
        client.getCode({
          address: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
          blockNumber: receipt.blockNumber,
        }),
      ),
      rpcCall("Safe singleton deployment-block code", () =>
        client.getCode({
          address: SAFE_DEPLOYMENT_CONSTANTS.singleton,
          blockNumber: receipt.blockNumber,
        }),
      ),
      rpcCall("Safe fallback handler deployment-block code", () =>
        client.getCode({
          address: SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
          blockNumber: receipt.blockNumber,
        }),
      ),
      rpcCall("Safe proxy creation code", () =>
        client.readContract({
          address: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
          abi: SAFE_PROXY_FACTORY_ABI,
          functionName: "proxyCreationCode",
          blockNumber: receipt.blockNumber,
        }),
      ),
    ]);
  if (
    !factoryCodeAtDeployment ||
    factoryCodeAtDeployment === "0x" ||
    keccak256(factoryCodeAtDeployment) !==
      SAFE_DEPLOYMENT_CONSTANTS.proxyFactoryCodeHash
  ) {
    throw new Error("Safe proxy factory deployment-block code hash mismatch");
  }
  if (
    !singletonCodeAtDeployment ||
    singletonCodeAtDeployment === "0x" ||
    keccak256(singletonCodeAtDeployment) !==
      SAFE_DEPLOYMENT_CONSTANTS.singletonCodeHash
  ) {
    throw new Error("Safe singleton deployment-block code hash mismatch");
  }
  if (
    !fallbackHandlerCodeAtDeployment ||
    fallbackHandlerCodeAtDeployment === "0x" ||
    keccak256(fallbackHandlerCodeAtDeployment) !==
      SAFE_DEPLOYMENT_CONSTANTS.fallbackHandlerCodeHash
  ) {
    throw new Error(
      "Safe fallback handler deployment-block code hash mismatch",
    );
  }

  const expectation = createSafeDeploymentExpectation(
    manifest,
    proxyDeploymentCodeHash(proxyCreationCodeAtDeployment),
  );
  if (transaction.input.toLowerCase() !== expectation.factoryCalldata.toLowerCase()) {
    throw new Error(
      "Safe factory calldata does not match the exact reviewed initializer and salt",
    );
  }
  assertProxyCreationLog(receipt.logs, expectation.safe);

  if (receipt.blockNumber === 0n) {
    throw new Error("Safe deployment cannot occur in the genesis block");
  }
  const [codeBeforeDeployment, codeAtDeployment] = await Promise.all([
    rpcCall("Safe pre-deployment code", () =>
      client.getCode({
        address: expectation.safe,
        blockNumber: receipt.blockNumber - 1n,
      }),
    ),
    rpcCall("Safe deployment-block code", () =>
      client.getCode({
        address: expectation.safe,
        blockNumber: receipt.blockNumber,
      }),
    ),
  ]);
  if (codeBeforeDeployment && codeBeforeDeployment !== "0x") {
    throw new Error("Predicted Safe address already had code before deployment");
  }
  if (!codeAtDeployment || codeAtDeployment === "0x") {
    throw new Error("Predicted Safe has no code in the deployment block");
  }

  const safeState = await rpcCall("finalized Safe state", () =>
    readSafeStateAtBlock(client, expectation.safe, headBlock),
  );
  assertSafeStateMatches(safeState, expectation);
  if (keccak256(codeAtDeployment) !== safeState.runtimeCodeHash) {
    throw new Error("Safe runtime code changed after deployment");
  }

  const checkedBlockReadback = await rpcCall("checked block readback", () =>
    client.getBlock({ blockNumber: headBlock }),
  );
  if (
    !checkedBlockReadback.hash ||
    checkedBlockReadback.hash.toLowerCase() !== checkedBlock.hash.toLowerCase()
  ) {
    throw new Error("Safe verification block changed during readback");
  }

  const evidence = {
    ok: true,
    kind: "zappad-safe-deployment-verification",
    schemaVersion: 1,
    chainId,
    releaseCommit: releaseCommit.toLowerCase(),
    checkedAtBlock: headBlock.toString(),
    checkedAtBlockHash: checkedBlock.hash,
    minimumConfirmations: minimumConfirmations.toString(),
    simulationManifestHash: manifest.simulationManifestHash,
    deployment: {
      transactionHash: deploymentTransactionHash.toLowerCase(),
      factory: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
      deployer: normalizedDeployer,
      nonce: transaction.nonce.toString(),
      factoryCalldataHash: expectation.factoryCalldataHash,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      confirmations: confirmations.toString(),
      status: "success",
      proxyCreationEventVerified: true,
      absentAtPreviousBlock: true,
    },
    config: {
      safe: expectation.safe,
      owners: expectation.owners,
      threshold: expectation.threshold.toString(),
      saltNonce: expectation.saltNonce.toString(),
      initializerHash: expectation.initializerHash,
      create2Salt: expectation.create2Salt,
      proxyDeploymentCodeHash: expectation.proxyDeploymentCodeHash,
      factoryCalldataHash: expectation.factoryCalldataHash,
      proxyFactory: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
      singleton: SAFE_DEPLOYMENT_CONSTANTS.singleton,
      fallbackHandler: SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
    },
    safeState: serializeSafeState(safeState),
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = resolve(requiredEnv("SAFE_DEPLOYMENT_EVIDENCE"));
  await writeFile(evidencePath, json, { flag: "wx" });
  process.stdout.write(json);
}

main().catch((error) => {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const raw = error instanceof Error ? error.message : String(error);
  const message = rpcUrl ? raw.split(rpcUrl).join("[redacted RPC]") : raw;
  console.error(message);
  process.exitCode = 1;
});
