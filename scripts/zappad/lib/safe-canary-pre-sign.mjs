import {
  getAddress,
  isAddress,
  isHash,
  keccak256,
  parseAbi,
} from "viem";

export const SAFE_TRANSACTION_HASH_ABI = parseAbi([
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
]);
export const RELEASE_LAUNCHPAD_ABI = parseAbi([
  "function protocolTreasury() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function feeVaultFactory() view returns (address)",
  "function positionManager() view returns (address)",
  "function launches(address token) view returns (bool exists,address creator,address pool,address feeVault,uint256 positionId,address pairedAsset,uint24 feeTier,int24 floorTick)",
]);
export const RELEASE_FACTORY_ABI = parseAbi([
  "function launchpad() view returns (address)",
]);
export const RELEASE_VAULT_ABI = parseAbi([
  "function launchpad() view returns (address)",
  "function launchToken() view returns (address)",
  "function pairedAsset() view returns (address)",
  "function positionManager() view returns (address)",
  "function positionId() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address holder) view returns (uint256)",
  "function claimable(address holder,address asset) view returns (uint256)",
]);

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const POSITION_MANAGER = getAddress(
  "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
);
const SHARE_SUPPLY = 100n * 10n ** 18n;
const CREATOR_SHARES = 70n * 10n ** 18n;
const SAFE_SHARES = 30n * 10n ** 18n;

function requiredAddress(value, label) {
  if (!isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${label} is invalid`);
  }
  return getAddress(value);
}

function requiredHash(value, label) {
  if (!isHash(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function requireSameAddress(actual, expected, label) {
  if (
    requiredAddress(actual, label) !==
    requiredAddress(expected, `expected ${label}`)
  ) {
    throw new Error(`${label} changed`);
  }
}

function requireExactUint(actual, expected, label) {
  if (typeof actual !== "bigint" || actual !== expected) {
    throw new Error(`${label} changed`);
  }
}

function requireCodeHash(code, expectedHash, label) {
  if (
    typeof code !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)
  ) {
    throw new Error(`${label} has no runtime bytecode`);
  }
  const actualHash = keccak256(code);
  if (actualHash !== requiredHash(expectedHash, `${label} expected code hash`)) {
    throw new Error(`${label} runtime code hash changed`);
  }
  return actualHash;
}

function requireRuntimeCode(code, label) {
  if (
    typeof code !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)
  ) {
    throw new Error(`${label} has no runtime bytecode`);
  }
}

export function assertDeploymentEvidenceBinding(prepared, deployment) {
  if (
    prepared.releaseCommit !== deployment.releaseCommit ||
    requiredHash(
      prepared.deploymentVerificationEvidenceHash,
      "Prepared deployment verification evidence hash",
    ) !== requiredHash(deployment.hash, "Deployment verification evidence hash")
  ) {
    throw new Error(
      "Prepared manifest deployment verification binding changed",
    );
  }
  requireSameAddress(
    prepared.launchpad,
    deployment.launchpad,
    "Prepared launchpad",
  );
  requireSameAddress(
    prepared.safe,
    deployment.protocolTreasury,
    "Prepared Safe",
  );
}

export function assertDeploymentEvidenceReadback(deployment, readback) {
  if (
    requiredHash(
      readback.evidenceBlockHash,
      "Deployment evidence block readback hash",
    ) !==
    requiredHash(
      deployment.checkedAtBlockHash,
      "Deployment evidence block hash",
    )
  ) {
    throw new Error("Deployment verification evidence block changed");
  }
  requireCodeHash(
    readback.launchpadCodeAtEvidence,
    deployment.launchpadCodeHash,
    "Deployment-evidence launchpad",
  );
  requireCodeHash(
    readback.launchpadCodeCurrent,
    deployment.launchpadCodeHash,
    "Current launchpad",
  );
}

function assertFactory(
  label,
  factory,
  expectedAddress,
  expectedLaunchpad,
  expectedCodeHash,
) {
  requireSameAddress(factory.address, expectedAddress, `${label} address`);
  requireSameAddress(
    factory.launchpad,
    expectedLaunchpad,
    `${label} launchpad binding`,
  );
  requireCodeHash(factory.code, expectedCodeHash, label);
}

function assertCanary(label, prepared, live, launchpad, positionManager) {
  const expected = prepared.canaries[label];
  const claim = prepared.claims[label];
  const launch = live.launch;
  const vault = live.vault;

  requireSameAddress(live.token, expected.token, `${label} canary token`);
  requireRuntimeCode(live.tokenCode, `${label} canary token`);
  requireRuntimeCode(live.poolCode, `${label} canary pool`);
  requireRuntimeCode(live.vaultCode, `${label} canary vault`);
  if (launch.exists !== true) {
    throw new Error(`${label} launch record no longer exists`);
  }
  requireSameAddress(launch.creator, prepared.creator, `${label} launch creator`);
  requireSameAddress(launch.pool, expected.pool, `${label} launch pool`);
  requireSameAddress(launch.feeVault, expected.vault, `${label} launch vault`);
  requireSameAddress(
    launch.pairedAsset,
    expected.pair,
    `${label} launch pair`,
  );
  requireExactUint(
    launch.positionId,
    expected.positionId,
    `${label} launch position`,
  );
  if (
    Number(launch.feeTier) !== expected.feeTier ||
    Number(launch.floorTick) !== expected.floorTick
  ) {
    throw new Error(`${label} launch market policy changed`);
  }

  requireSameAddress(vault.launchpad, launchpad, `${label} vault launchpad`);
  requireSameAddress(
    vault.launchToken,
    expected.token,
    `${label} vault launch token`,
  );
  requireSameAddress(
    vault.pairedAsset,
    expected.pair,
    `${label} vault paired asset`,
  );
  requireSameAddress(
    vault.positionManager,
    positionManager,
    `${label} vault position manager`,
  );
  requireExactUint(
    vault.positionId,
    expected.positionId,
    `${label} vault position`,
  );
  requireExactUint(
    vault.totalSupply,
    SHARE_SUPPLY,
    `${label} vault share supply`,
  );
  requireExactUint(
    vault.safeShares,
    SAFE_SHARES,
    `${label} Safe fee shares`,
  );
  requireExactUint(
    vault.creatorShares,
    CREATOR_SHARES,
    `${label} creator fee shares`,
  );
  requireExactUint(
    vault.safeTokenClaimable,
    claim.expectedToken,
    `${label} Safe token claimable`,
  );
  requireExactUint(
    vault.safePairClaimable,
    claim.expectedPair,
    `${label} Safe pair claimable`,
  );
  if (vault.safeTokenClaimable === 0n || vault.safePairClaimable === 0n) {
    throw new Error(`${label} Safe claimables must remain nonzero`);
  }
}

export function assertCanonicalReleaseSnapshot(
  prepared,
  deployment,
  snapshot,
) {
  requireSameAddress(
    snapshot.launchpad.protocolTreasury,
    prepared.safe,
    "Launchpad protocol treasury",
  );
  requireSameAddress(
    snapshot.launchpad.positionManager,
    POSITION_MANAGER,
    "Launchpad position manager",
  );
  if (
    requiredAddress(
      snapshot.launchpad.tokenFactory,
      "Launchpad token factory",
    ) ===
    requiredAddress(
      snapshot.launchpad.feeVaultFactory,
      "Launchpad fee-vault factory",
    )
  ) {
    throw new Error("Launchpad factories must be distinct");
  }

  assertFactory(
    "Token factory",
    snapshot.factories.token,
    snapshot.launchpad.tokenFactory,
    prepared.launchpad,
    deployment.code?.tokenFactory?.codeHash,
  );
  assertFactory(
    "Fee-vault factory",
    snapshot.factories.feeVault,
    snapshot.launchpad.feeVaultFactory,
    prepared.launchpad,
    deployment.code?.feeVaultFactory?.codeHash,
  );
  assertCanary(
    "weth",
    prepared,
    snapshot.canaries.weth,
    prepared.launchpad,
    snapshot.launchpad.positionManager,
  );
  assertCanary(
    "usdg",
    prepared,
    snapshot.canaries.usdg,
    prepared.launchpad,
    snapshot.launchpad.positionManager,
  );
}

export function assertPreparedSafeTransactionHashes(prepared, recomputed) {
  for (const label of ["weth", "usdg"]) {
    const actual = recomputed[label];
    if (
      !isHash(actual) ||
      actual.toLowerCase() !==
        prepared.claims[label].safeTransactionHash.toLowerCase()
    ) {
      throw new Error(
        `${label.toUpperCase()} Safe transaction hash does not match the prepared manifest`,
      );
    }
  }
}

export function serializeSafeClaim(label, claim) {
  return {
    order: label === "weth" ? 1 : 2,
    label,
    target: claim.target,
    value: claim.value.toString(),
    data: claim.data,
    operation: claim.operation,
    safeTxGas: claim.safeTxGas.toString(),
    baseGas: claim.baseGas.toString(),
    gasPrice: claim.gasPrice.toString(),
    gasToken: claim.gasToken,
    refundReceiver: claim.refundReceiver,
    nonce: claim.nonce.toString(),
    safeTransactionHash: claim.safeTransactionHash,
  };
}
