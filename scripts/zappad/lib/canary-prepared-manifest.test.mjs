import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";
import {
  hashPreparedCanaryManifest,
  parsePreparedCanaryManifest,
} from "./canary-prepared-manifest.mjs";

const SAFE = "0x1111111111111111111111111111111111111111";
const WETH_TOKEN = "0x1212121212121212121212121212121212121212";
const WETH_VAULT = "0x2222222222222222222222222222222222222222";
const WETH_POOL = "0x2323232323232323232323232323232323232323";
const USDG_TOKEN = "0x3131313131313131313131313131313131313131";
const USDG_VAULT = "0x3333333333333333333333333333333333333333";
const USDG_POOL = "0x3434343434343434343434343434343434343434";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const RELEASE = "a".repeat(40);
const SAFE_EVIDENCE_HASH = `0x${"44".repeat(32)}`;
const CLAIM_ABI = parseAbi([
  "function claimAll(address beneficiary) returns (uint256 tokenAmount,uint256 pairAmount)",
]);

function rawManifest(overrides = {}) {
  const claimData = encodeFunctionData({
    abi: CLAIM_ABI,
    functionName: "claimAll",
    args: [SAFE],
  });
  const manifest = {
    kind: "zappad-canary-prepared-safe-claims",
    schemaVersion: 1,
    status: "prepared-safe-claims-pending",
    chainId: 4663,
    releaseCommit: RELEASE,
    launchpad: "0x4444444444444444444444444444444444444444",
    creator: "0x5555555555555555555555555555555555555555",
    safeTreasury: SAFE,
    startingSafeNonce: 0,
    broadcastEvidenceHash: `0x${"11".repeat(32)}`,
    safeDeploymentEvidenceHash: SAFE_EVIDENCE_HASH,
    deploymentVerificationEvidenceHash: `0x${"22".repeat(32)}`,
    observedAtBlock: "1234",
    wethToken: WETH_TOKEN,
    wethVault: WETH_VAULT,
    wethPool: WETH_POOL,
    wethPair: WETH,
    wethPositionId: "101",
    wethSafeClaimTarget: WETH_VAULT,
    wethSafeClaimData: claimData,
    wethSafeClaimNonce: 0,
    wethSafeTransactionHash: `0x${"66".repeat(32)}`,
    wethSafeClaimExpectedToken: "1",
    wethSafeClaimExpectedPair: "2",
    usdgToken: USDG_TOKEN,
    usdgVault: USDG_VAULT,
    usdgPool: USDG_POOL,
    usdgPair: USDG,
    usdgPositionId: "102",
    usdgSafeClaimTarget: USDG_VAULT,
    usdgSafeClaimData: claimData,
    usdgSafeClaimNonce: 1,
    usdgSafeTransactionHash: `0x${"77".repeat(32)}`,
    usdgSafeClaimExpectedToken: "3",
    usdgSafeClaimExpectedPair: "4",
    ...overrides,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parse(raw) {
  return parsePreparedCanaryManifest(raw, {
    expectedHash: hashPreparedCanaryManifest(raw),
    expectedReleaseCommit: RELEASE,
    expectedSafeDeploymentEvidenceHash: SAFE_EVIDENCE_HASH,
  });
}

describe("prepared canary manifest", () => {
  it("accepts exact approved sequential claimAll(Safe) plans", () => {
    const raw = rawManifest();
    const parsed = parse(raw);
    expect(parsed.hash).toBe(keccak256(toBytes(raw)));
    expect(parsed.observedAtBlock).toBe(1234n);
    expect(parsed.canaries.weth).toMatchObject({
      token: WETH_TOKEN,
      vault: WETH_VAULT,
      pool: WETH_POOL,
      pair: WETH,
      positionId: 101n,
      feeTier: 3000,
      floorTick: -276_300,
    });
    expect(parsed.claims.weth.expectedToken).toBe(1n);
    expect(parsed.claims.weth.expectedPair).toBe(2n);
    expect(parsed.claims.weth.nonce).toBe(0n);
    expect(parsed.claims.usdg.nonce).toBe(1n);
  });

  it("rejects zero, wrong, or raw-byte-drifted approval hashes", () => {
    const raw = rawManifest();
    expect(() =>
      parsePreparedCanaryManifest(raw, {
        expectedHash: `0x${"0".repeat(64)}`,
        expectedReleaseCommit: RELEASE,
      }),
    ).toThrow(/EXPECTED_CANARY_PREPARED_MANIFEST_HASH/);
    expect(() =>
      parsePreparedCanaryManifest(`${raw}\n`, {
        expectedHash: hashPreparedCanaryManifest(raw),
        expectedReleaseCommit: RELEASE,
      }),
    ).toThrow(/does not match its approval/);
  });

  it("rejects a beneficiary, target, nonce, or Safe evidence drift", () => {
    const badBeneficiary = rawManifest({
      wethSafeClaimData: encodeFunctionData({
        abi: CLAIM_ABI,
        functionName: "claimAll",
        args: ["0x9999999999999999999999999999999999999999"],
      }),
    });
    expect(() => parse(badBeneficiary)).toThrow(/claimAll\(Safe\)/);

    const badTarget = rawManifest({
      wethSafeClaimTarget: "0x9999999999999999999999999999999999999999",
    });
    expect(() => parse(badTarget)).toThrow(/reviewed vault/);

    const badNonce = rawManifest({ usdgSafeClaimNonce: 2 });
    expect(() => parse(badNonce)).toThrow(/not sequential/);

    const badSafeEvidence = rawManifest({
      safeDeploymentEvidenceHash: `0x${"88".repeat(32)}`,
    });
    expect(() => parse(badSafeEvidence)).toThrow(/evidence hash changed/);
  });

  it("rejects drift in a prepared canary identity or observed claim state", () => {
    expect(() =>
      parse(rawManifest({ wethPair: USDG })),
    ).toThrow(/pair is not canonical/);
    expect(() =>
      parse(rawManifest({ wethPositionId: "0" })),
    ).toThrow(/position must be a positive integer/);
    expect(() =>
      parse(rawManifest({ usdgPool: WETH_POOL })),
    ).toThrow(/records must be distinct/);
    expect(() =>
      parse(rawManifest({ wethSafeClaimExpectedToken: "0" })),
    ).toThrow(/claims must be nonzero/);
  });
});
