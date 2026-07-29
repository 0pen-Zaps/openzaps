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
  toBytes
} from "viem";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";
import {
  assertSafeStateMatches,
  readSafeStateAtBlock,
  serializeSafeState,
  validateSafeDeploymentEvidence
} from "./lib/safe-deployment-evidence.mjs";
import {
  validateReviewedDeploymentSimulationManifest
} from "./lib/deployment-simulation-manifest.mjs";

const EXPECTED_CHAIN_ID = 4663;
const DEFAULT_BLOCKSCOUT_API_URL =
  "https://robinhoodchain.blockscout.com/api/v2";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EXPECTED = {
  positionManager: getAddress("0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3"),
  v3Factory: getAddress("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"),
  swapRouter: getAddress("0xCaf681a66D020601342297493863E78C959E5cb2"),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  wethImplementation: {
    address: getAddress("0xC6B81b429797E0f555440b70cD99e032D7AE947e"),
    codeHash: "0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650"
  },
  usdgImplementation: {
    address: getAddress("0x68184C449E1a8f34fA18d289737129FD27B66f8F"),
    codeHash: "0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf"
  }
};
const EXPECTED_DEPENDENCY_CODE_HASHES = {
  positionManager:
    "0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f",
  v3Factory:
    "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739",
  swapRouter:
    "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc",
  weth:
    "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353",
  usdg:
    "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6"
};
const EXPECTED_SOURCE_NAMES = {
  bootstrap: "ZapPadBootstrap",
  launchpad: "ZapPadLaunchpad",
  tokenFactory: "ZapTokenFactory",
  feeVaultFactory: "ZapFeeVaultFactory"
};
const DEFAULT_MIN_CONFIRMATIONS = 12n;
const EXPECTED_LAUNCH_CONFIG_DOMAIN = keccak256(
  toBytes("ZapPadLaunchConfig:v1")
);
const BOOTSTRAP_ARTIFACT = new URL(
  "../../contracts/zappad/out/ZapPadBootstrap.sol/ZapPadBootstrap.json",
  import.meta.url
);

const ADDRESS_ABI = (name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "address" }]
});
const BYTES32_ABI = (name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "bytes32" }]
});

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

function manifestAddress(manifest, name) {
  const value = manifest[name];
  if (!isAddress(value)) throw new Error(`Manifest ${name} is invalid`);
  return getAddress(value);
}

async function rpcCall(label, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`RPC request failed while reading ${label}`);
  }
}

async function readSourceVerification(name, address) {
  const apiUrl = (
    process.env.BLOCKSCOUT_API_URL ?? DEFAULT_BLOCKSCOUT_API_URL
  ).replace(/\/+$/, "");
  const response = await fetch(`${apiUrl}/smart-contracts/${address}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(
      `${name} Blockscout lookup failed with HTTP ${response.status}`
    );
  }
  const result = await response.json();
  if (result.name !== EXPECTED_SOURCE_NAMES[name]) {
    throw new Error(
      `${name} source name mismatch: expected ${EXPECTED_SOURCE_NAMES[name]}, received ${result.name ?? "none"}`
    );
  }
  if (result.is_verified !== true) {
    throw new Error(`${name} is not source-verified in Blockscout`);
  }
  if (result.is_fully_verified !== true) {
    throw new Error(`${name} is only partially verified in Blockscout`);
  }
  if (result.is_changed_bytecode === true) {
    throw new Error(`${name} Blockscout record reports changed bytecode`);
  }
  if (
    result.compiler_version
      && result.compiler_version !== "v0.8.28+commit.7893614a"
  ) {
    throw new Error(`${name} Blockscout compiler version mismatch`);
  }
  if (
    result.optimization_enabled != null
      && result.optimization_enabled !== true
  ) {
    throw new Error(`${name} Blockscout optimizer setting mismatch`);
  }
  if (
    result.optimization_runs != null
      && Number(result.optimization_runs) !== 1_000_000
  ) {
    throw new Error(`${name} Blockscout optimizer runs mismatch`);
  }
  if (
    result.evm_version != null
      && result.evm_version !== "cancun"
  ) {
    throw new Error(`${name} Blockscout EVM version mismatch`);
  }
  return {
    name: result.name,
    fullyVerified: true,
    compilerVersion: result.compiler_version,
    optimizationEnabled: result.optimization_enabled,
    optimizationRuns: result.optimization_runs,
    evmVersion: result.evm_version,
    verifiedAt: result.verified_at
  };
}

async function main() {
  const rpcUrl = requiredEnv("ROBINHOOD_RPC_URL");
  if (new URL(rpcUrl).protocol !== "https:") {
    throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
  }
  const manifestPath = resolve(
    process.argv[2] ?? requiredEnv("DEPLOYMENT_SIMULATION_MANIFEST")
  );
  const releaseCommit = requiredEnv("EXPECTED_RELEASE_COMMIT");
  const manifestRaw = await readFile(manifestPath);
  const {
    manifest,
    approvedHash: approvedSimulationManifestHash
  } = validateReviewedDeploymentSimulationManifest(manifestRaw, {
    expectedHash: requiredEnv(
      "EXPECTED_DEPLOYMENT_SIMULATION_MANIFEST_HASH"
    ),
    expectedReleaseCommit: releaseCommit
  });
  const deploymentTransactionHash = requiredEnv("DEPLOYMENT_TX_HASH");
  if (!isHash(deploymentTransactionHash)) {
    throw new Error("DEPLOYMENT_TX_HASH is invalid");
  }
  const deployer = requiredEnv("DEPLOYER_ADDRESS");
  if (!isAddress(deployer)) throw new Error("DEPLOYER_ADDRESS is invalid");
  await verifyReleaseCheckout(releaseCommit);
  const safeEvidencePath = resolve(requiredEnv("SAFE_DEPLOYMENT_EVIDENCE"));
  const safeEvidenceJson = await readFile(safeEvidencePath, "utf8");
  const safeDeploymentEvidenceHash = keccak256(toBytes(safeEvidenceJson));
  const safeEvidence = validateSafeDeploymentEvidence(
    JSON.parse(safeEvidenceJson),
    releaseCommit
  );
  const minimumConfirmations = positiveIntegerEnv(
    "DEPLOYMENT_MIN_CONFIRMATIONS",
    DEFAULT_MIN_CONFIRMATIONS.toString()
  );

  const addresses = {
    bootstrap: manifestAddress(manifest, "bootstrap"),
    launchpad: manifestAddress(manifest, "launchpad"),
    tokenFactory: manifestAddress(manifest, "tokenFactory"),
    feeVaultFactory: manifestAddress(manifest, "feeVaultFactory"),
    positionManager: EXPECTED.positionManager,
    v3Factory: EXPECTED.v3Factory,
    swapRouter: EXPECTED.swapRouter,
    weth: EXPECTED.weth,
    usdg: EXPECTED.usdg
  };
  const protocolTreasury = manifestAddress(manifest, "protocolTreasury");
  if (
    !isHash(manifest.safeDeploymentEvidenceHash)
      || manifest.safeDeploymentEvidenceHash.toLowerCase()
        !== safeDeploymentEvidenceHash
  ) {
    throw new Error(
      "Simulation manifest Safe deployment evidence hash mismatch"
    );
  }
  if (!sameAddress(protocolTreasury, safeEvidence.config.safe)) {
    throw new Error(
      "Simulation manifest protocolTreasury does not match the verified Safe deployment"
    );
  }
  if (
    typeof manifest.launchConfigDomain !== "string"
      || manifest.launchConfigDomain.toLowerCase()
        !== EXPECTED_LAUNCH_CONFIG_DOMAIN.toLowerCase()
  ) {
    throw new Error("Simulation manifest launch config domain mismatch");
  }

  const client = createPublicClient({ transport: http(rpcUrl) });
  const [chainId, blockNumber, transaction, receipt] = await Promise.all([
    rpcCall("chain id", () => client.getChainId()),
    rpcCall("head block", () => client.getBlockNumber()),
    rpcCall("deployment transaction", () =>
      client.getTransaction({ hash: deploymentTransactionHash })
    ),
    rpcCall("deployment receipt", () =>
      client.getTransactionReceipt({ hash: deploymentTransactionHash })
    )
  ]);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${EXPECTED_CHAIN_ID}, received ${chainId}`);
  }
  const simulatedAtBlock = BigInt(manifest.simulatedAtBlock);
  if (simulatedAtBlock <= 0n || simulatedAtBlock > blockNumber) {
    throw new Error("Simulation manifest block is invalid");
  }
  if (
    receipt.status !== "success"
      || transaction.to != null
      || receipt.contractAddress == null
      || !sameAddress(receipt.contractAddress, addresses.bootstrap)
      || !sameAddress(transaction.from, deployer)
      || !sameAddress(receipt.from, deployer)
      || transaction.value !== 0n
      || transaction.blockHash == null
      || transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
      || transaction.blockNumber !== receipt.blockNumber
  ) {
    throw new Error("Deployment transaction or receipt does not match the reviewed bootstrap");
  }
  if (blockNumber < receipt.blockNumber) {
    throw new Error("Deployment receipt block is ahead of the RPC head");
  }
  if (
    safeEvidence.deploymentBlock >= receipt.blockNumber
      || safeEvidence.checkedAtBlock > receipt.blockNumber
  ) {
    throw new Error(
      "Verified Safe evidence must predate the ZapPad stack deployment"
    );
  }
  const confirmations = blockNumber - receipt.blockNumber + 1n;
  if (confirmations < minimumConfirmations) {
    throw new Error(
      `Deployment has ${confirmations} confirmations; ${minimumConfirmations} required`
    );
  }
  const checkedBlock = await rpcCall("checked block", () =>
    client.getBlock({ blockNumber })
  );
  if (!checkedBlock.hash || checkedBlock.number !== blockNumber) {
    throw new Error("Unable to establish an exact deployment verification block");
  }

  const artifact = JSON.parse(await readFile(BOOTSTRAP_ARTIFACT, "utf8"));
  const bootstrapBytecode = artifact?.bytecode?.object;
  if (
    typeof bootstrapBytecode !== "string"
      || !/^0x(?:[0-9a-fA-F]{2})+$/.test(bootstrapBytecode)
  ) {
    throw new Error("Local ZapPadBootstrap artifact has invalid creation bytecode");
  }
  const constructorArguments = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" }
    ],
    [
      protocolTreasury,
      EXPECTED.positionManager,
      EXPECTED.swapRouter,
      EXPECTED.weth,
      EXPECTED.usdg
    ]
  );
  const expectedInitCode = concatHex([bootstrapBytecode, constructorArguments]);
  if (transaction.input.toLowerCase() !== expectedInitCode.toLowerCase()) {
    throw new Error("Deployment initcode does not match the local reviewed bootstrap build");
  }

  const codeEntries = await Promise.all(
    Object.entries(addresses).map(async ([name, address]) => {
      const code = await client.getCode({ address, blockNumber });
      if (!code || code === "0x") throw new Error(`${name} has no runtime bytecode`);
      return [name, { bytes: (code.length - 2) / 2, codeHash: keccak256(code) }];
    })
  );
  const code = Object.fromEntries(codeEntries);
  for (const [name, expectedCodeHash] of Object.entries(
    EXPECTED_DEPENDENCY_CODE_HASHES
  )) {
    if (code[name].codeHash !== expectedCodeHash) {
      throw new Error(`${name} runtime code hash mismatch`);
    }
  }

  const safeState = await rpcCall("verified Safe state", () =>
    readSafeStateAtBlock(client, protocolTreasury, blockNumber)
  );
  assertSafeStateMatches(
    safeState,
    safeEvidence.config,
    safeEvidence.runtimeCodeHash
  );

  const proxyImplementations = {};
  for (const proxyName of ["weth", "usdg"]) {
    const stored = await client.getStorageAt({
      address: addresses[proxyName],
      slot: IMPLEMENTATION_SLOT,
      blockNumber
    });
    if (!stored) throw new Error(`${proxyName} implementation slot is empty`);
    const implementation = getAddress(`0x${stored.slice(-40)}`);
    const expectedImplementation = EXPECTED[`${proxyName}Implementation`];
    if (!sameAddress(implementation, expectedImplementation.address)) {
      throw new Error(`${proxyName} implementation mismatch`);
    }
    const implementationCode = await client.getCode({
      address: implementation,
      blockNumber
    });
    if (!implementationCode || implementationCode === "0x") {
      throw new Error(`${proxyName} implementation has no code`);
    }
    const implementationCodeHash = keccak256(implementationCode);
    if (implementationCodeHash !== expectedImplementation.codeHash) {
      throw new Error(`${proxyName} implementation code hash mismatch`);
    }
    proxyImplementations[proxyName] = {
      address: implementation,
      codeHash: implementationCodeHash
    };
  }

  const [bootstrapTokenFactory, bootstrapFeeVaultFactory, bootstrapLaunchpad] =
    await Promise.all(
      ["tokenFactory", "feeVaultFactory", "launchpad"].map((name) =>
        client.readContract({
          address: addresses.bootstrap,
          abi: [ADDRESS_ABI(name)],
          functionName: name,
          blockNumber
        })
      )
    );
  const expectedBootstrapReads = [
    [bootstrapTokenFactory, addresses.tokenFactory, "bootstrap tokenFactory"],
    [
      bootstrapFeeVaultFactory,
      addresses.feeVaultFactory,
      "bootstrap feeVaultFactory"
    ],
    [bootstrapLaunchpad, addresses.launchpad, "bootstrap launchpad"]
  ];
  for (const [actual, expected, label] of expectedBootstrapReads) {
    if (!sameAddress(actual, expected)) {
      throw new Error(`${label} readback mismatch`);
    }
  }

  const launcherReads = await Promise.all([
    "protocolTreasury",
    "tokenFactory",
    "feeVaultFactory",
    "positionManager",
    "v3Factory",
    "swapRouter",
    "weth",
    "usdg"
  ].map((name) => client.readContract({
    address: addresses.launchpad,
    abi: [ADDRESS_ABI(name)],
    functionName: name,
    blockNumber
  })));

  const [
    treasury,
    tokenFactory,
    feeVaultFactory,
    positionManager,
    v3Factory,
    swapRouter,
    weth,
    usdg
  ] = launcherReads;

  const expectedReads = [
    [treasury, protocolTreasury, "protocolTreasury"],
    [tokenFactory, addresses.tokenFactory, "tokenFactory"],
    [feeVaultFactory, addresses.feeVaultFactory, "feeVaultFactory"],
    [positionManager, EXPECTED.positionManager, "positionManager"],
    [v3Factory, EXPECTED.v3Factory, "v3Factory"],
    [swapRouter, EXPECTED.swapRouter, "swapRouter"],
    [weth, EXPECTED.weth, "weth"],
    [usdg, EXPECTED.usdg, "usdg"]
  ];
  for (const [actual, expected, label] of expectedReads) {
    if (!sameAddress(actual, expected)) {
      throw new Error(`${label} readback mismatch`);
    }
  }
  const launchConfigDomain = await client.readContract({
    address: addresses.launchpad,
    abi: [BYTES32_ABI("LAUNCH_CONFIG_DOMAIN")],
    functionName: "LAUNCH_CONFIG_DOMAIN",
    blockNumber
  });
  if (
    launchConfigDomain.toLowerCase()
      !== EXPECTED_LAUNCH_CONFIG_DOMAIN.toLowerCase()
  ) {
    throw new Error("Launch config domain readback mismatch");
  }

  const factoryAbi = [ADDRESS_ABI("launchpad")];
  const [tokenFactoryLaunchpad, feeVaultFactoryLaunchpad] = await Promise.all([
    client.readContract({
      address: addresses.tokenFactory,
      abi: factoryAbi,
      functionName: "launchpad",
      blockNumber
    }),
    client.readContract({
      address: addresses.feeVaultFactory,
      abi: factoryAbi,
      functionName: "launchpad",
      blockNumber
    })
  ]);
  if (
    !sameAddress(tokenFactoryLaunchpad, addresses.launchpad)
      || !sameAddress(feeVaultFactoryLaunchpad, addresses.launchpad)
  ) {
    throw new Error("Factory binding mismatch");
  }

  let sourceVerification = "skipped";
  if (process.env.SKIP_SOURCE_VERIFICATION !== "1") {
    sourceVerification = Object.fromEntries(
      await Promise.all(
        Object.keys(EXPECTED_SOURCE_NAMES).map(async (name) => [
          name,
          await readSourceVerification(name, addresses[name])
        ])
      )
    );
  }
  const checkedBlockReadback = await rpcCall("checked block readback", () =>
    client.getBlock({ blockNumber })
  );
  if (
    !checkedBlockReadback.hash ||
    checkedBlockReadback.hash.toLowerCase() !== checkedBlock.hash.toLowerCase()
  ) {
    throw new Error("Deployment verification block changed during readback");
  }

  const evidence = {
    ok: true,
    kind: "zappad-deployment-verification",
    chainId,
    releaseCommit,
    checkedAtBlock: blockNumber.toString(),
    checkedAtBlockHash: checkedBlock.hash,
    minimumConfirmations: minimumConfirmations.toString(),
    simulationManifestHash: approvedSimulationManifestHash,
    safeDeploymentEvidenceHash,
    safeDeployment: {
      transactionHash: safeEvidence.deploymentTransactionHash,
      deployer: safeEvidence.deployer,
      evidenceCheckedAtBlock: safeEvidence.checkedAtBlock.toString(),
      liveState: serializeSafeState(safeState)
    },
    deployment: {
      transactionHash: deploymentTransactionHash.toLowerCase(),
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber.toString(),
      confirmations: confirmations.toString(),
      deployer: getAddress(deployer),
      bootstrapInitCodeHash: keccak256(expectedInitCode)
    },
    bootstrap: addresses.bootstrap,
    launchpad: addresses.launchpad,
    protocolTreasury: getAddress(treasury),
    launchConfigDomain,
    bootstrapBindings: true,
    factoryBindings: true,
    sourceVerification,
    proxyImplementations,
    code
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = resolve(requiredEnv("DEPLOYMENT_VERIFICATION_EVIDENCE"));
  await writeFile(evidencePath, json, { flag: "wx" });
  process.stderr.write(
    `Deployment verification evidence hash: ${keccak256(toBytes(json))}\n`
  );
  process.stdout.write(json);
}

main().catch((error) => {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const raw = error instanceof Error ? error.message : String(error);
  const message = rpcUrl ? raw.split(rpcUrl).join("[redacted RPC]") : raw;
  console.error(message);
  process.exitCode = 1;
});
