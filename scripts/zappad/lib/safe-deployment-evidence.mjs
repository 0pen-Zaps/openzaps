import {
  decodeEventLog,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getCreate2Address,
  isAddress,
  isHash,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";

export const SAFE_DEPLOYMENT_CONSTANTS = Object.freeze({
  chainId: 4663,
  version: "1.4.1",
  simulationKind: "zappad-safe-treasury-simulation",
  simulationSchemaVersion: 1,
  ownerCount: 3,
  threshold: 2n,
  proxyFactory: getAddress("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"),
  proxyFactoryCodeHash:
    "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  singleton: getAddress("0x41675C099F32341bf84BFc5382aF534df5C7461a"),
  singletonCodeHash:
    "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
  fallbackHandler: getAddress(
    "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  ),
  fallbackHandlerCodeHash:
    "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  sentinel: getAddress("0x0000000000000000000000000000000000000001"),
  zeroAddress: getAddress("0x0000000000000000000000000000000000000000"),
});

const FALLBACK_HANDLER_STORAGE_SLOT =
  0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n;
const GUARD_STORAGE_SLOT =
  0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n;

export const SAFE_PROXY_FACTORY_ABI = parseAbi([
  "function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() pure returns (bytes)",
  "event ProxyCreation(address proxy,address singleton)",
]);

export const SAFE_SETUP_ABI = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
]);

export const SAFE_READ_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function masterCopy() view returns (address)",
  "function getChainId() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getStorageAt(uint256 offset,uint256 length) view returns (bytes)",
  "function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)",
]);

function fail(message) {
  throw new Error(message);
}

function normalizeAddress(value, label) {
  if (!isAddress(value)) fail(`${label} is invalid`);
  return getAddress(value);
}

function normalizeHash(value, label) {
  if (!isHash(value)) fail(`${label} is invalid`);
  return value.toLowerCase();
}

function normalizeBigInt(value, label, { positive = false } = {}) {
  if (typeof value === "bigint") {
    if (value < 0n) fail(`${label} must be a non-negative integer`);
    if (positive && value === 0n) fail(`${label} must be positive`);
    return value;
  }
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    fail(`${label} must be a safe non-negative integer`);
  }
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
  ) {
    fail(`${label} must be a non-negative integer`);
  }
  const normalized = BigInt(value);
  if (positive && normalized === 0n) fail(`${label} must be positive`);
  return normalized;
}

function normalizeOwners(value, label = "Safe owners") {
  if (
    !Array.isArray(value) ||
    value.length !== SAFE_DEPLOYMENT_CONSTANTS.ownerCount
  ) {
    fail(
      `${label} must contain exactly ${SAFE_DEPLOYMENT_CONSTANTS.ownerCount} addresses`,
    );
  }
  const owners = value.map((owner, index) =>
    normalizeAddress(owner, `${label}[${index}]`),
  );
  const unique = new Set(owners.map((owner) => owner.toLowerCase()));
  if (unique.size !== owners.length) fail(`${label} contains a duplicate`);
  if (
    owners.some(
      (owner) =>
        owner === SAFE_DEPLOYMENT_CONSTANTS.zeroAddress ||
        owner === SAFE_DEPLOYMENT_CONSTANTS.sentinel,
    )
  ) {
    fail(`${label} contains a forbidden address`);
  }
  return owners;
}

function requireExactAddress(actual, expected, label) {
  const normalized = normalizeAddress(actual, label);
  if (normalized !== expected) fail(`${label} mismatch`);
  return normalized;
}

function requireExactHash(actual, expected, label) {
  const normalized = normalizeHash(actual, label);
  if (normalized !== expected.toLowerCase()) fail(`${label} mismatch`);
  return normalized;
}

function addressFromStorageBytes(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${label} returned an invalid storage word`);
  }
  return getAddress(`0x${value.slice(-40)}`);
}

function sortedOwners(owners) {
  return owners.map((owner) => owner.toLowerCase()).sort();
}

function assertSameOwnerSet(actual, expected, label) {
  const normalizedActual = normalizeOwners(actual, `${label} actual owners`);
  const normalizedExpected = normalizeOwners(expected, `${label} expected owners`);
  if (
    JSON.stringify(sortedOwners(normalizedActual)) !==
    JSON.stringify(sortedOwners(normalizedExpected))
  ) {
    fail(`${label} owner set mismatch`);
  }
}

export function parseSafeSimulationManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Safe simulation manifest must be an object");
  }
  if (
    manifest.kind !== SAFE_DEPLOYMENT_CONSTANTS.simulationKind ||
    manifest.schemaVersion !== SAFE_DEPLOYMENT_CONSTANTS.simulationSchemaVersion ||
    manifest.chainId !== SAFE_DEPLOYMENT_CONSTANTS.chainId ||
    manifest.status !== "simulation-only"
  ) {
    fail(
      "Safe simulation manifest identity, schema, chain, or status mismatch",
    );
  }
  if (manifest.safeVersion !== SAFE_DEPLOYMENT_CONSTANTS.version) {
    fail("Safe simulation manifest version mismatch");
  }

  const owners = normalizeOwners(manifest.owners, "Manifest owners");
  const threshold = normalizeBigInt(manifest.threshold, "Manifest threshold", {
    positive: true,
  });
  if (threshold !== SAFE_DEPLOYMENT_CONSTANTS.threshold) {
    fail(
      `Manifest threshold must be ${SAFE_DEPLOYMENT_CONSTANTS.threshold.toString()}`,
    );
  }

  return {
    safe: normalizeAddress(manifest.safe, "Manifest safe"),
    owners,
    threshold,
    saltNonce: normalizeBigInt(manifest.saltNonce, "Manifest saltNonce"),
    simulatedAtBlock: normalizeBigInt(
      manifest.simulatedAtBlock,
      "Manifest simulatedAtBlock",
      { positive: true },
    ),
    initializerHash: normalizeHash(
      manifest.initializerHash,
      "Manifest initializerHash",
    ),
    create2Salt: normalizeHash(manifest.create2Salt, "Manifest create2Salt"),
    proxyDeploymentCodeHash: normalizeHash(
      manifest.proxyDeploymentCodeHash,
      "Manifest proxyDeploymentCodeHash",
    ),
    proxyFactory: requireExactAddress(
      manifest.proxyFactory,
      SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
      "Manifest proxyFactory",
    ),
    proxyFactoryCodeHash: requireExactHash(
      manifest.proxyFactoryCodeHash,
      SAFE_DEPLOYMENT_CONSTANTS.proxyFactoryCodeHash,
      "Manifest proxyFactoryCodeHash",
    ),
    singleton: requireExactAddress(
      manifest.singleton,
      SAFE_DEPLOYMENT_CONSTANTS.singleton,
      "Manifest singleton",
    ),
    singletonCodeHash: requireExactHash(
      manifest.singletonCodeHash,
      SAFE_DEPLOYMENT_CONSTANTS.singletonCodeHash,
      "Manifest singletonCodeHash",
    ),
    fallbackHandler: requireExactAddress(
      manifest.fallbackHandler,
      SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
      "Manifest fallbackHandler",
    ),
    fallbackHandlerCodeHash: requireExactHash(
      manifest.fallbackHandlerCodeHash,
      SAFE_DEPLOYMENT_CONSTANTS.fallbackHandlerCodeHash,
      "Manifest fallbackHandlerCodeHash",
    ),
  };
}

export function validateReviewedSafeSimulationManifest(
  manifestJson,
  expectedManifestHash,
) {
  if (typeof manifestJson !== "string" || manifestJson.length === 0) {
    fail("Safe simulation manifest raw bytes are missing");
  }
  const normalizedExpectedHash = normalizeHash(
    expectedManifestHash,
    "Expected Safe simulation manifest hash",
  );
  if (normalizedExpectedHash === `0x${"00".repeat(32)}`) {
    fail("Expected Safe simulation manifest hash must be non-zero");
  }
  const actualManifestHash = keccak256(toBytes(manifestJson));
  if (actualManifestHash !== normalizedExpectedHash) {
    fail("Safe simulation manifest raw hash mismatch");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    fail("Safe simulation manifest is not valid JSON");
  }
  const parsed = parseSafeSimulationManifest(manifest);
  createSafeDeploymentExpectation(parsed);
  return { ...parsed, simulationManifestHash: actualManifestHash };
}

export function createSafeDeploymentExpectation(
  parsedManifest,
  proxyDeploymentCodeHash = parsedManifest.proxyDeploymentCodeHash,
) {
  const normalizedProxyDeploymentCodeHash = normalizeHash(
    proxyDeploymentCodeHash,
    "Proxy deployment code hash",
  );
  if (
    normalizedProxyDeploymentCodeHash !==
    parsedManifest.proxyDeploymentCodeHash
  ) {
    fail("Proxy deployment code hash does not match the reviewed manifest");
  }

  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: "setup",
    args: [
      parsedManifest.owners,
      parsedManifest.threshold,
      SAFE_DEPLOYMENT_CONSTANTS.zeroAddress,
      "0x",
      SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
      SAFE_DEPLOYMENT_CONSTANTS.zeroAddress,
      0n,
      SAFE_DEPLOYMENT_CONSTANTS.zeroAddress,
    ],
  });
  const initializerHash = keccak256(initializer);
  if (initializerHash !== parsedManifest.initializerHash) {
    fail("Safe initializer does not match the reviewed manifest");
  }

  const create2Salt = keccak256(
    encodePacked(
      ["bytes32", "uint256"],
      [initializerHash, parsedManifest.saltNonce],
    ),
  );
  if (create2Salt !== parsedManifest.create2Salt) {
    fail("Safe CREATE2 salt does not match the reviewed manifest");
  }

  const predictedSafe = getCreate2Address({
    from: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
    salt: create2Salt,
    bytecodeHash: normalizedProxyDeploymentCodeHash,
  });
  if (predictedSafe !== parsedManifest.safe) {
    fail("Safe predicted address does not match the reviewed manifest");
  }

  const factoryCalldata = encodeFunctionData({
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args: [
      SAFE_DEPLOYMENT_CONSTANTS.singleton,
      initializer,
      parsedManifest.saltNonce,
    ],
  });

  return {
    ...parsedManifest,
    initializer,
    initializerHash,
    create2Salt,
    predictedSafe,
    proxyDeploymentCodeHash: normalizedProxyDeploymentCodeHash,
    factoryCalldata,
    factoryCalldataHash: keccak256(factoryCalldata),
  };
}

export function assertProxyCreationLog(logs, safe) {
  const events = [];
  for (const log of logs) {
    if (
      !isAddress(log.address) ||
      getAddress(log.address) !== SAFE_DEPLOYMENT_CONSTANTS.proxyFactory
    ) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: SAFE_PROXY_FACTORY_ABI,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName === "ProxyCreation") events.push(decoded.args);
    } catch {
      // Ignore unrelated canonical factory logs; the exact event is required below.
    }
  }
  if (events.length !== 1) {
    fail("Safe deployment receipt must contain exactly one ProxyCreation event");
  }
  if (
    getAddress(events[0].proxy) !== getAddress(safe) ||
    getAddress(events[0].singleton) !== SAFE_DEPLOYMENT_CONSTANTS.singleton
  ) {
    fail("Safe ProxyCreation event mismatch");
  }
}

async function readCodeHash(client, address, blockNumber, label) {
  const code = await client.getCode({ address, blockNumber });
  if (!code || code === "0x") fail(`${label} has no runtime bytecode`);
  return keccak256(code);
}

export async function readSafeStateAtBlock(client, safe, blockNumber) {
  const safeAddress = normalizeAddress(safe, "Safe address");
  const [
    runtimeCodeHash,
    proxyFactoryCodeHash,
    singletonCodeHash,
    fallbackHandlerCodeHash,
    singleton,
    version,
    chainId,
    owners,
    threshold,
    nonce,
    fallbackStorage,
    guardStorage,
    modulesResult,
  ] = await Promise.all([
    readCodeHash(client, safeAddress, blockNumber, "Safe"),
    readCodeHash(
      client,
      SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
      blockNumber,
      "Safe proxy factory",
    ),
    readCodeHash(
      client,
      SAFE_DEPLOYMENT_CONSTANTS.singleton,
      blockNumber,
      "Safe singleton",
    ),
    readCodeHash(
      client,
      SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
      blockNumber,
      "Safe fallback handler",
    ),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "masterCopy",
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "VERSION",
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "getChainId",
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "getOwners",
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "getThreshold",
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "nonce",
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "getStorageAt",
      args: [FALLBACK_HANDLER_STORAGE_SLOT, 1n],
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "getStorageAt",
      args: [GUARD_STORAGE_SLOT, 1n],
      blockNumber,
    }),
    client.readContract({
      address: safeAddress,
      abi: SAFE_READ_ABI,
      functionName: "getModulesPaginated",
      args: [SAFE_DEPLOYMENT_CONSTANTS.sentinel, 1n],
      blockNumber,
    }),
  ]);

  return {
    address: safeAddress,
    runtimeCodeHash,
    singleton: getAddress(singleton),
    version,
    chainId,
    owners: owners.map((owner) => getAddress(owner)),
    threshold,
    nonce,
    fallbackHandler: addressFromStorageBytes(
      fallbackStorage,
      "Safe fallback handler",
    ),
    guard: addressFromStorageBytes(guardStorage, "Safe guard"),
    modules: modulesResult[0].map((module) => getAddress(module)),
    moduleCursor: getAddress(modulesResult[1]),
    dependencies: {
      proxyFactoryCodeHash,
      singletonCodeHash,
      fallbackHandlerCodeHash,
    },
  };
}

export function assertSafeStateMatches(
  state,
  expected,
  expectedRuntimeCodeHash,
) {
  if (getAddress(state.address) !== expected.safe) fail("Safe address mismatch");
  if (getAddress(state.singleton) !== SAFE_DEPLOYMENT_CONSTANTS.singleton) {
    fail("Safe singleton readback mismatch");
  }
  if (state.version !== SAFE_DEPLOYMENT_CONSTANTS.version) {
    fail("Safe version readback mismatch");
  }
  if (state.chainId !== BigInt(SAFE_DEPLOYMENT_CONSTANTS.chainId)) {
    fail("Safe chainId readback mismatch");
  }
  assertSameOwnerSet(state.owners, expected.owners, "Safe");
  if (state.threshold !== expected.threshold) {
    fail("Safe threshold readback mismatch");
  }
  if (state.nonce !== 0n) fail("Safe nonce is not fresh");
  if (
    getAddress(state.fallbackHandler) !==
    SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler
  ) {
    fail("Safe fallback handler readback mismatch");
  }
  if (getAddress(state.guard) !== SAFE_DEPLOYMENT_CONSTANTS.zeroAddress) {
    fail("Safe guard must be empty");
  }
  if (
    state.modules.length !== 0 ||
    getAddress(state.moduleCursor) !== SAFE_DEPLOYMENT_CONSTANTS.sentinel
  ) {
    fail("Safe modules must be empty");
  }
  requireExactHash(
    state.dependencies.proxyFactoryCodeHash,
    SAFE_DEPLOYMENT_CONSTANTS.proxyFactoryCodeHash,
    "Safe proxy factory runtime code hash",
  );
  requireExactHash(
    state.dependencies.singletonCodeHash,
    SAFE_DEPLOYMENT_CONSTANTS.singletonCodeHash,
    "Safe singleton runtime code hash",
  );
  requireExactHash(
    state.dependencies.fallbackHandlerCodeHash,
    SAFE_DEPLOYMENT_CONSTANTS.fallbackHandlerCodeHash,
    "Safe fallback handler runtime code hash",
  );
  if (expectedRuntimeCodeHash) {
    requireExactHash(
      state.runtimeCodeHash,
      expectedRuntimeCodeHash,
      "Safe runtime code hash",
    );
  } else {
    normalizeHash(state.runtimeCodeHash, "Safe runtime code hash");
  }
}

export function serializeSafeState(state) {
  return {
    address: getAddress(state.address),
    runtimeCodeHash: normalizeHash(
      state.runtimeCodeHash,
      "Safe runtime code hash",
    ),
    singleton: getAddress(state.singleton),
    version: state.version,
    chainId: state.chainId.toString(),
    owners: state.owners.map((owner) => getAddress(owner)),
    threshold: state.threshold.toString(),
    nonce: state.nonce.toString(),
    fallbackHandler: getAddress(state.fallbackHandler),
    guard: getAddress(state.guard),
    modules: state.modules.map((module) => getAddress(module)),
    moduleCursor: getAddress(state.moduleCursor),
    dependencies: {
      proxyFactoryCodeHash: normalizeHash(
        state.dependencies.proxyFactoryCodeHash,
        "Safe proxy factory runtime code hash",
      ),
      singletonCodeHash: normalizeHash(
        state.dependencies.singletonCodeHash,
        "Safe singleton runtime code hash",
      ),
      fallbackHandlerCodeHash: normalizeHash(
        state.dependencies.fallbackHandlerCodeHash,
        "Safe fallback handler runtime code hash",
      ),
    },
  };
}

export function validateSafeDeploymentEvidence(
  evidence,
  expectedReleaseCommit,
) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("Safe deployment evidence must be an object");
  }
  if (
    evidence.ok !== true ||
    evidence.kind !== "zappad-safe-deployment-verification" ||
    evidence.schemaVersion !== 1 ||
    Number(evidence.chainId) !== SAFE_DEPLOYMENT_CONSTANTS.chainId
  ) {
    fail("Safe deployment evidence identity mismatch");
  }
  if (!/^[0-9a-f]{40}$/i.test(evidence.releaseCommit ?? "")) {
    fail("Safe deployment evidence releaseCommit is invalid");
  }
  if (
    expectedReleaseCommit &&
    evidence.releaseCommit.toLowerCase() !== expectedReleaseCommit.toLowerCase()
  ) {
    fail("Safe deployment evidence release commit mismatch");
  }
  const checkedAtBlock = normalizeBigInt(
    evidence.checkedAtBlock,
    "Safe evidence checkedAtBlock",
    { positive: true },
  );
  normalizeHash(
    evidence.checkedAtBlockHash,
    "Safe evidence checkedAtBlockHash",
  );
  const minimumConfirmations = normalizeBigInt(
    evidence.minimumConfirmations,
    "Safe evidence minimumConfirmations",
    { positive: true },
  );
  normalizeHash(
    evidence.simulationManifestHash,
    "Safe evidence simulationManifestHash",
  );

  const config = evidence.config;
  if (!config || typeof config !== "object") {
    fail("Safe deployment evidence config is missing");
  }
  const parsedConfig = {
    safe: normalizeAddress(config.safe, "Safe evidence config.safe"),
    owners: normalizeOwners(config.owners, "Safe evidence config.owners"),
    threshold: normalizeBigInt(
      config.threshold,
      "Safe evidence config.threshold",
      { positive: true },
    ),
    saltNonce: normalizeBigInt(
      config.saltNonce,
      "Safe evidence config.saltNonce",
    ),
    initializerHash: normalizeHash(
      config.initializerHash,
      "Safe evidence config.initializerHash",
    ),
    create2Salt: normalizeHash(
      config.create2Salt,
      "Safe evidence config.create2Salt",
    ),
    proxyDeploymentCodeHash: normalizeHash(
      config.proxyDeploymentCodeHash,
      "Safe evidence config.proxyDeploymentCodeHash",
    ),
    factoryCalldataHash: normalizeHash(
      config.factoryCalldataHash,
      "Safe evidence config.factoryCalldataHash",
    ),
    proxyFactory: requireExactAddress(
      config.proxyFactory,
      SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
      "Safe evidence config.proxyFactory",
    ),
    singleton: requireExactAddress(
      config.singleton,
      SAFE_DEPLOYMENT_CONSTANTS.singleton,
      "Safe evidence config.singleton",
    ),
    fallbackHandler: requireExactAddress(
      config.fallbackHandler,
      SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
      "Safe evidence config.fallbackHandler",
    ),
  };
  if (parsedConfig.threshold !== SAFE_DEPLOYMENT_CONSTANTS.threshold) {
    fail("Safe deployment evidence threshold policy mismatch");
  }
  const expectation = createSafeDeploymentExpectation({
    ...parsedConfig,
    predictedSafe: parsedConfig.safe,
  });
  if (expectation.factoryCalldataHash !== parsedConfig.factoryCalldataHash) {
    fail("Safe deployment evidence factory calldata hash mismatch");
  }

  const deployment = evidence.deployment;
  if (!deployment || typeof deployment !== "object") {
    fail("Safe deployment evidence receipt is missing");
  }
  normalizeHash(
    deployment.transactionHash,
    "Safe evidence deployment.transactionHash",
  );
  requireExactAddress(
    deployment.factory,
    SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
    "Safe evidence deployment.factory",
  );
  normalizeAddress(deployment.deployer, "Safe evidence deployment.deployer");
  requireExactHash(
    deployment.factoryCalldataHash,
    expectation.factoryCalldataHash,
    "Safe evidence deployment.factoryCalldataHash",
  );
  const deploymentBlock = normalizeBigInt(
    deployment.blockNumber,
    "Safe evidence deployment.blockNumber",
    { positive: true },
  );
  normalizeHash(
    deployment.blockHash,
    "Safe evidence deployment.blockHash",
  );
  const confirmations = normalizeBigInt(
    deployment.confirmations,
    "Safe evidence deployment.confirmations",
    { positive: true },
  );
  if (
    deployment.status !== "success" ||
    deployment.proxyCreationEventVerified !== true ||
    deployment.absentAtPreviousBlock !== true
  ) {
    fail("Safe deployment evidence receipt proofs are incomplete");
  }
  if (
    checkedAtBlock < deploymentBlock ||
    confirmations !== checkedAtBlock - deploymentBlock + 1n ||
    confirmations < minimumConfirmations
  ) {
    fail("Safe deployment evidence is not finalized and successful");
  }

  const state = evidence.safeState;
  if (!state || typeof state !== "object") {
    fail("Safe deployment evidence state is missing");
  }
  const normalizedState = {
    address: normalizeAddress(state.address, "Safe evidence state.address"),
    runtimeCodeHash: normalizeHash(
      state.runtimeCodeHash,
      "Safe evidence state.runtimeCodeHash",
    ),
    singleton: normalizeAddress(
      state.singleton,
      "Safe evidence state.singleton",
    ),
    version: state.version,
    chainId: normalizeBigInt(state.chainId, "Safe evidence state.chainId"),
    owners: normalizeOwners(state.owners, "Safe evidence state.owners"),
    threshold: normalizeBigInt(
      state.threshold,
      "Safe evidence state.threshold",
      { positive: true },
    ),
    nonce: normalizeBigInt(state.nonce, "Safe evidence state.nonce"),
    fallbackHandler: normalizeAddress(
      state.fallbackHandler,
      "Safe evidence state.fallbackHandler",
    ),
    guard: normalizeAddress(state.guard, "Safe evidence state.guard"),
    modules: Array.isArray(state.modules)
      ? state.modules.map((module, index) =>
          normalizeAddress(module, `Safe evidence state.modules[${index}]`),
        )
      : fail("Safe evidence state.modules is invalid"),
    moduleCursor: normalizeAddress(
      state.moduleCursor,
      "Safe evidence state.moduleCursor",
    ),
    dependencies: {
      proxyFactoryCodeHash: normalizeHash(
        state.dependencies?.proxyFactoryCodeHash,
        "Safe evidence state proxy factory code hash",
      ),
      singletonCodeHash: normalizeHash(
        state.dependencies?.singletonCodeHash,
        "Safe evidence state singleton code hash",
      ),
      fallbackHandlerCodeHash: normalizeHash(
        state.dependencies?.fallbackHandlerCodeHash,
        "Safe evidence state fallback handler code hash",
      ),
    },
  };
  assertSafeStateMatches(
    normalizedState,
    expectation,
    normalizedState.runtimeCodeHash,
  );

  return {
    releaseCommit: evidence.releaseCommit.toLowerCase(),
    checkedAtBlock,
    checkedAtBlockHash: evidence.checkedAtBlockHash.toLowerCase(),
    minimumConfirmations,
    deploymentBlock,
    deploymentTransactionHash: deployment.transactionHash.toLowerCase(),
    deployer: getAddress(deployment.deployer),
    config: expectation,
    runtimeCodeHash: normalizedState.runtimeCodeHash,
  };
}
