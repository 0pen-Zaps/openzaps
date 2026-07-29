import {
  encodeFunctionData,
  getAddress,
  isAddress,
  isHash,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";

export const PREPARED_CANARY_KIND = "zappad-canary-prepared-safe-claims";
export const PREPARED_CANARY_SCHEMA_VERSION = 1;
export const EXPECTED_CHAIN_ID = 4663;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const EXPECTED_CANARIES = Object.freeze({
  weth: {
    pair: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
    feeTier: 3000,
    floorTick: -276_300,
  },
  usdg: {
    pair: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
    feeTier: 3000,
    floorTick: -460_020,
  },
});
const CLAIM_ABI = parseAbi([
  "function claimAll(address beneficiary) returns (uint256 tokenAmount,uint256 pairAmount)",
]);

function requiredHash(value, label, { nonzero = true } = {}) {
  if (
    !isHash(value) ||
    (nonzero && value.toLowerCase() === ZERO_HASH)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function requiredAddress(value, label) {
  if (!isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${label} is invalid`);
  }
  return getAddress(value);
}

function requiredInteger(value, label, { positive = false } = {}) {
  let normalized;
  if (
    typeof value === "bigint" &&
    value >= 0n
  ) {
    normalized = value;
  } else if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    normalized = BigInt(value);
  } else if (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*)$/.test(value)
  ) {
    normalized = BigInt(value);
  }
  if (normalized == null || (positive && normalized === 0n)) {
    throw new Error(
      `${label} must be a ${positive ? "positive" : "non-negative"} integer`,
    );
  }
  return normalized;
}

function requiredData(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function parseClaim(manifest, prefix, safe, expectedNonce) {
  const target = requiredAddress(
    manifest[`${prefix}SafeClaimTarget`],
    `${prefix} Safe claim target`,
  );
  const vault = requiredAddress(
    manifest[`${prefix}Vault`],
    `${prefix} canary vault`,
  );
  if (target !== vault) {
    throw new Error(`${prefix} Safe claim target is not its reviewed vault`);
  }
  const data = requiredData(
    manifest[`${prefix}SafeClaimData`],
    `${prefix} Safe claim calldata`,
  );
  const expectedData = encodeFunctionData({
    abi: CLAIM_ABI,
    functionName: "claimAll",
    args: [safe],
  }).toLowerCase();
  if (data !== expectedData) {
    throw new Error(`${prefix} Safe claim calldata is not claimAll(Safe)`);
  }
  const nonce = requiredInteger(
    manifest[`${prefix}SafeClaimNonce`],
    `${prefix} Safe claim nonce`,
  );
  if (nonce !== expectedNonce) {
    throw new Error(`${prefix} Safe claim nonce is not sequential`);
  }
  const safeTransactionHash = requiredHash(
    manifest[`${prefix}SafeTransactionHash`],
    `${prefix} Safe transaction hash`,
  );
  const expectedToken = requiredInteger(
    manifest[`${prefix}SafeClaimExpectedToken`],
    `${prefix} expected Safe token claim`,
  );
  const expectedPair = requiredInteger(
    manifest[`${prefix}SafeClaimExpectedPair`],
    `${prefix} expected Safe pair claim`,
  );
  if (expectedToken === 0n || expectedPair === 0n) {
    throw new Error(`${prefix} prepared Safe claims must be nonzero`);
  }
  return {
    target,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: getAddress("0x0000000000000000000000000000000000000000"),
    refundReceiver: getAddress(
      "0x0000000000000000000000000000000000000000",
    ),
    nonce,
    safeTransactionHash,
    expectedToken,
    expectedPair,
  };
}

function parseCanary(manifest, prefix) {
  const policy = EXPECTED_CANARIES[prefix];
  const token = requiredAddress(
    manifest[`${prefix}Token`],
    `${prefix} canary token`,
  );
  const vault = requiredAddress(
    manifest[`${prefix}Vault`],
    `${prefix} canary vault`,
  );
  const pool = requiredAddress(
    manifest[`${prefix}Pool`],
    `${prefix} canary pool`,
  );
  const pair = requiredAddress(
    manifest[`${prefix}Pair`],
    `${prefix} canary pair`,
  );
  if (pair !== policy.pair) {
    throw new Error(`${prefix} canary pair is not canonical`);
  }
  return {
    token,
    vault,
    pool,
    pair,
    positionId: requiredInteger(
      manifest[`${prefix}PositionId`],
      `${prefix} canary position`,
      { positive: true },
    ),
    feeTier: policy.feeTier,
    floorTick: policy.floorTick,
  };
}

export function hashPreparedCanaryManifest(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Prepared canary manifest is empty");
  }
  return keccak256(toBytes(raw));
}

export function parsePreparedCanaryManifest(
  raw,
  {
    expectedHash,
    expectedReleaseCommit,
    expectedSafeDeploymentEvidenceHash,
  },
) {
  const approvedHash = requiredHash(
    expectedHash,
    "EXPECTED_CANARY_PREPARED_MANIFEST_HASH",
  );
  const actualHash = hashPreparedCanaryManifest(raw);
  if (actualHash.toLowerCase() !== approvedHash) {
    throw new Error(
      "Prepared canary manifest hash does not match its approval",
    );
  }
  if (
    typeof expectedReleaseCommit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(expectedReleaseCommit)
  ) {
    throw new Error("EXPECTED_RELEASE_COMMIT must be a full Git commit");
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error("Prepared canary manifest is not valid JSON");
  }
  if (
    manifest?.kind !== PREPARED_CANARY_KIND ||
    Number(manifest?.schemaVersion) !== PREPARED_CANARY_SCHEMA_VERSION ||
    manifest?.status !== "prepared-safe-claims-pending" ||
    Number(manifest?.chainId) !== EXPECTED_CHAIN_ID ||
    manifest?.releaseCommit?.toLowerCase() !==
      expectedReleaseCommit.toLowerCase()
  ) {
    throw new Error("Prepared canary manifest identity changed");
  }

  const safe = requiredAddress(manifest.safeTreasury, "Prepared Safe");
  const startingSafeNonce = requiredInteger(
    manifest.startingSafeNonce,
    "Prepared starting Safe nonce",
  );
  const safeDeploymentEvidenceHash = requiredHash(
    manifest.safeDeploymentEvidenceHash,
    "Prepared Safe deployment evidence hash",
  );
  if (
    expectedSafeDeploymentEvidenceHash != null &&
    safeDeploymentEvidenceHash !==
      requiredHash(
        expectedSafeDeploymentEvidenceHash,
        "SAFE_DEPLOYMENT_EVIDENCE_HASH",
      )
  ) {
    throw new Error(
      "Prepared manifest Safe deployment evidence hash changed",
    );
  }
  const canaries = {
    weth: parseCanary(manifest, "weth"),
    usdg: parseCanary(manifest, "usdg"),
  };
  if (
    canaries.weth.token === canaries.usdg.token ||
    canaries.weth.vault === canaries.usdg.vault ||
    canaries.weth.pool === canaries.usdg.pool ||
    canaries.weth.positionId === canaries.usdg.positionId
  ) {
    throw new Error("Prepared canary records must be distinct");
  }
  const claims = {
    weth: parseClaim(manifest, "weth", safe, startingSafeNonce),
    usdg: parseClaim(manifest, "usdg", safe, startingSafeNonce + 1n),
  };
  if (claims.weth.safeTransactionHash === claims.usdg.safeTransactionHash) {
    throw new Error("Prepared Safe transaction hashes must be distinct");
  }

  return {
    manifest,
    hash: actualHash,
    releaseCommit: expectedReleaseCommit.toLowerCase(),
    launchpad: requiredAddress(manifest.launchpad, "Prepared launchpad"),
    creator: requiredAddress(manifest.creator, "Prepared creator"),
    safe,
    startingSafeNonce,
    observedAtBlock: requiredInteger(
      manifest.observedAtBlock,
      "Prepared observation block",
      { positive: true },
    ),
    broadcastEvidenceHash: requiredHash(
      manifest.broadcastEvidenceHash,
      "Prepared creator-broadcast evidence hash",
    ),
    safeDeploymentEvidenceHash,
    deploymentVerificationEvidenceHash: requiredHash(
      manifest.deploymentVerificationEvidenceHash,
      "Prepared deployment-verification evidence hash",
    ),
    canaries,
    claims,
  };
}
