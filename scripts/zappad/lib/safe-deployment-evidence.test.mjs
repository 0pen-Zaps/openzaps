import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  toBytes,
} from "viem";
import {
  assertProxyCreationLog,
  assertSafeStateMatches,
  createSafeDeploymentExpectation,
  parseSafeSimulationManifest,
  SAFE_DEPLOYMENT_CONSTANTS,
  SAFE_PROXY_FACTORY_ABI,
  serializeSafeState,
  validateReviewedSafeSimulationManifest,
  validateSafeDeploymentEvidence,
} from "./safe-deployment-evidence.mjs";

const RELEASE_COMMIT = "a".repeat(40);
const TRANSACTION_HASH = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const CHECKED_BLOCK_HASH = `0x${"33".repeat(32)}`;
const SAFE_RUNTIME_CODE_HASH = `0x${"44".repeat(32)}`;

const MANIFEST = Object.freeze({
  chainId: 4663,
  create2Salt:
    "0xabfbbd33507997efbdd2fd444fc3f2cf6d75aceb7538034e231248b5bc84ba18",
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  fallbackHandlerCodeHash:
    "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  initializerHash:
    "0xe4311245ea7d1a003d6f0e055cc733003a7efa391562c2f4435a01e7f89ff487",
  kind: "zappad-safe-treasury-simulation",
  owners: [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ],
  proxyDeploymentCodeHash:
    "0x76733d705f71b79841c0ee960a0ca880f779cde7ef446c989e6d23efc0a4adfb",
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  proxyFactoryCodeHash:
    "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  safe: "0x8A0AdA275dcf21222d1E65E460687c8818d87B16",
  safeVersion: "1.4.1",
  saltNonce: 20260728,
  schemaVersion: 1,
  simulatedAtBlock: 22019952,
  singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  singletonCodeHash:
    "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
  status: "simulation-only",
  threshold: 2,
});

function expectation() {
  return createSafeDeploymentExpectation(
    parseSafeSimulationManifest(structuredClone(MANIFEST)),
  );
}

function validState(expected = expectation()) {
  return {
    address: expected.safe,
    runtimeCodeHash: SAFE_RUNTIME_CODE_HASH,
    singleton: SAFE_DEPLOYMENT_CONSTANTS.singleton,
    version: SAFE_DEPLOYMENT_CONSTANTS.version,
    chainId: BigInt(SAFE_DEPLOYMENT_CONSTANTS.chainId),
    owners: [...expected.owners].reverse(),
    threshold: expected.threshold,
    nonce: 0n,
    fallbackHandler: SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
    guard: SAFE_DEPLOYMENT_CONSTANTS.zeroAddress,
    modules: [],
    moduleCursor: SAFE_DEPLOYMENT_CONSTANTS.sentinel,
    dependencies: {
      proxyFactoryCodeHash:
        SAFE_DEPLOYMENT_CONSTANTS.proxyFactoryCodeHash,
      singletonCodeHash: SAFE_DEPLOYMENT_CONSTANTS.singletonCodeHash,
      fallbackHandlerCodeHash:
        SAFE_DEPLOYMENT_CONSTANTS.fallbackHandlerCodeHash,
    },
  };
}

function proxyCreationLog(safe = MANIFEST.safe) {
  return {
    address: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [safe, SAFE_DEPLOYMENT_CONSTANTS.singleton],
    ),
    topics: encodeEventTopics({
      abi: SAFE_PROXY_FACTORY_ABI,
      eventName: "ProxyCreation",
    }),
  };
}

function validEvidence() {
  const expected = expectation();
  return {
    ok: true,
    kind: "zappad-safe-deployment-verification",
    schemaVersion: 1,
    chainId: 4663,
    releaseCommit: RELEASE_COMMIT,
    checkedAtBlock: "22020000",
    checkedAtBlockHash: CHECKED_BLOCK_HASH,
    minimumConfirmations: "12",
    simulationManifestHash: `0x${"55".repeat(32)}`,
    deployment: {
      transactionHash: TRANSACTION_HASH,
      factory: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
      deployer: getAddress("0x5555555555555555555555555555555555555555"),
      factoryCalldataHash: expected.factoryCalldataHash,
      blockNumber: "22019960",
      blockHash: BLOCK_HASH,
      confirmations: "41",
      status: "success",
      proxyCreationEventVerified: true,
      absentAtPreviousBlock: true,
    },
    config: {
      safe: expected.safe,
      owners: expected.owners,
      threshold: expected.threshold.toString(),
      saltNonce: expected.saltNonce.toString(),
      initializerHash: expected.initializerHash,
      create2Salt: expected.create2Salt,
      proxyDeploymentCodeHash: expected.proxyDeploymentCodeHash,
      factoryCalldataHash: expected.factoryCalldataHash,
      proxyFactory: SAFE_DEPLOYMENT_CONSTANTS.proxyFactory,
      singleton: SAFE_DEPLOYMENT_CONSTANTS.singleton,
      fallbackHandler: SAFE_DEPLOYMENT_CONSTANTS.fallbackHandler,
    },
    safeState: serializeSafeState(validState(expected)),
  };
}

describe("Safe deployment evidence", () => {
  it("reconstructs the reviewed initializer, salt, CREATE2 address, and calldata", () => {
    const expected = expectation();
    expect(expected.initializerHash).toBe(MANIFEST.initializerHash);
    expect(expected.create2Salt).toBe(MANIFEST.create2Salt);
    expect(expected.predictedSafe).toBe(MANIFEST.safe);
    expect(expected.factoryCalldataHash).toBe(
      "0x21600a0133eb94b7e8df0965871d8d6bb24e483cec97e058a9be3e0af0e0119b",
    );
  });

  it("binds approval to the exact raw simulation bytes", () => {
    const raw = `${JSON.stringify(MANIFEST, null, 2)}\n`;
    const hash = keccak256(toBytes(raw));
    const reviewed = validateReviewedSafeSimulationManifest(raw, hash);
    expect(reviewed.safe).toBe(MANIFEST.safe);
    expect(reviewed.simulationManifestHash).toBe(hash);

    expect(() =>
      validateReviewedSafeSimulationManifest(raw.trimEnd(), hash),
    ).toThrow("raw hash mismatch");
    expect(() =>
      validateReviewedSafeSimulationManifest(raw, `0x${"00".repeat(32)}`),
    ).toThrow("must be non-zero");
  });

  it("rejects an independently hashed artifact with the wrong simulation identity", () => {
    for (const tampered of [
      { ...MANIFEST, kind: "zappad-safe-deployment-verification" },
      { ...MANIFEST, schemaVersion: 2 },
      { ...MANIFEST, status: "approved-for-broadcast" },
      { ...MANIFEST, chainId: "4663" },
    ]) {
      const raw = JSON.stringify(tampered);
      expect(() =>
        validateReviewedSafeSimulationManifest(raw, keccak256(toBytes(raw))),
      ).toThrow("identity, schema, chain, or status mismatch");
    }
  });

  it("rejects independently hashed derivation and dependency tampering", () => {
    for (const tampered of [
      { ...MANIFEST, initializerHash: `0x${"99".repeat(32)}` },
      { ...MANIFEST, proxyFactoryCodeHash: `0x${"99".repeat(32)}` },
      {
        ...MANIFEST,
        owners: [
          MANIFEST.owners[1],
          MANIFEST.owners[0],
          MANIFEST.owners[2],
        ],
      },
    ]) {
      const raw = JSON.stringify(tampered);
      expect(() =>
        validateReviewedSafeSimulationManifest(raw, keccak256(toBytes(raw))),
      ).toThrow();
    }
  });

  it("rejects a Safe plan that is not the required fresh 2-of-3 multisig", () => {
    expect(() =>
      parseSafeSimulationManifest({
        ...structuredClone(MANIFEST),
        threshold: 1,
      }),
    ).toThrow("Manifest threshold must be 2");
    expect(() =>
      parseSafeSimulationManifest({
        ...structuredClone(MANIFEST),
        owners: MANIFEST.owners.slice(0, 2),
      }),
    ).toThrow("exactly 3");
  });

  it("requires one exact canonical ProxyCreation event", () => {
    expect(() =>
      assertProxyCreationLog([proxyCreationLog()], MANIFEST.safe),
    ).not.toThrow();
    expect(() =>
      assertProxyCreationLog(
        [proxyCreationLog("0x9999999999999999999999999999999999999999")],
        MANIFEST.safe,
      ),
    ).toThrow("ProxyCreation event mismatch");
    expect(() =>
      assertProxyCreationLog(
        [proxyCreationLog(), proxyCreationLog()],
        MANIFEST.safe,
      ),
    ).toThrow("exactly one");
  });

  it("rejects post-deployment authority drift", () => {
    const expected = expectation();
    expect(() =>
      assertSafeStateMatches(
        { ...validState(expected), nonce: 1n },
        expected,
      ),
    ).toThrow("nonce is not fresh");
    expect(() =>
      assertSafeStateMatches(
        {
          ...validState(expected),
          modules: ["0x9999999999999999999999999999999999999999"],
        },
        expected,
      ),
    ).toThrow("modules must be empty");
  });

  it("validates a complete evidence artifact and rejects calldata tampering", () => {
    const evidence = validEvidence();
    const parsed = validateSafeDeploymentEvidence(evidence, RELEASE_COMMIT);
    expect(parsed.config.safe).toBe(MANIFEST.safe);
    expect(parsed.runtimeCodeHash).toBe(SAFE_RUNTIME_CODE_HASH);

    const tampered = structuredClone(evidence);
    tampered.config.factoryCalldataHash = `0x${"99".repeat(32)}`;
    expect(() =>
      validateSafeDeploymentEvidence(tampered, RELEASE_COMMIT),
    ).toThrow("factory calldata hash mismatch");
  });

  it("rejects missing receipt proofs and inconsistent confirmation arithmetic", () => {
    const missingEvent = validEvidence();
    missingEvent.deployment.proxyCreationEventVerified = false;
    expect(() =>
      validateSafeDeploymentEvidence(missingEvent, RELEASE_COMMIT),
    ).toThrow("receipt proofs are incomplete");

    const inconsistent = validEvidence();
    inconsistent.deployment.confirmations = "40";
    expect(() =>
      validateSafeDeploymentEvidence(inconsistent, RELEASE_COMMIT),
    ).toThrow("not finalized and successful");
  });
});
