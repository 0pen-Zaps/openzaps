import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import {
  assertCanonicalReleaseSnapshot,
  assertDeploymentEvidenceBinding,
  assertDeploymentEvidenceReadback,
  assertPreparedSafeTransactionHashes,
} from "./safe-canary-pre-sign.mjs";

const RELEASE = "a".repeat(40);
const SAFE = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const LAUNCHPAD = "0x3333333333333333333333333333333333333333";
const TOKEN_FACTORY = "0x4444444444444444444444444444444444444444";
const VAULT_FACTORY = "0x5555555555555555555555555555555555555555";
const POSITION_MANAGER = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const DEPLOYMENT_HASH = `0x${"10".repeat(32)}`;
const BLOCK_HASH = `0x${"20".repeat(32)}`;
const LAUNCHPAD_CODE = "0x6001";
const TOKEN_FACTORY_CODE = "0x6002";
const VAULT_FACTORY_CODE = "0x6003";
const RUNTIME_CODE = "0x6004";
const SHARE_SUPPLY = 100n * 10n ** 18n;
const CREATOR_SHARES = 70n * 10n ** 18n;
const SAFE_SHARES = 30n * 10n ** 18n;

function canary({
  token,
  vault,
  pool,
  pair,
  positionId,
  floorTick,
  expectedToken,
  expectedPair,
}) {
  return {
    prepared: {
      token,
      vault,
      pool,
      pair,
      positionId,
      feeTier: 3000,
      floorTick,
    },
    claim: {
      expectedToken,
      expectedPair,
      safeTransactionHash: `0x${positionId.toString(16).padStart(64, "0")}`,
    },
    live: {
      token,
      tokenCode: RUNTIME_CODE,
      poolCode: RUNTIME_CODE,
      vaultCode: RUNTIME_CODE,
      launch: {
        exists: true,
        creator: CREATOR,
        pool,
        feeVault: vault,
        positionId,
        pairedAsset: pair,
        feeTier: 3000,
        floorTick,
      },
      vault: {
        launchpad: LAUNCHPAD,
        launchToken: token,
        pairedAsset: pair,
        positionManager: POSITION_MANAGER,
        positionId,
        totalSupply: SHARE_SUPPLY,
        safeShares: SAFE_SHARES,
        creatorShares: CREATOR_SHARES,
        safeTokenClaimable: expectedToken,
        safePairClaimable: expectedPair,
      },
    },
  };
}

function fixture() {
  const weth = canary({
    token: "0x6666666666666666666666666666666666666666",
    vault: "0x7777777777777777777777777777777777777777",
    pool: "0x8888888888888888888888888888888888888888",
    pair: WETH,
    positionId: 101n,
    floorTick: -276_300,
    expectedToken: 11n,
    expectedPair: 12n,
  });
  const usdg = canary({
    token: "0x9999999999999999999999999999999999999999",
    vault: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pool: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pair: USDG,
    positionId: 102n,
    floorTick: -460_020,
    expectedToken: 21n,
    expectedPair: 22n,
  });
  return {
    prepared: {
      releaseCommit: RELEASE,
      deploymentVerificationEvidenceHash: DEPLOYMENT_HASH,
      launchpad: LAUNCHPAD,
      safe: SAFE,
      creator: CREATOR,
      canaries: {
        weth: weth.prepared,
        usdg: usdg.prepared,
      },
      claims: {
        weth: weth.claim,
        usdg: usdg.claim,
      },
    },
    deployment: {
      releaseCommit: RELEASE,
      hash: DEPLOYMENT_HASH,
      launchpad: LAUNCHPAD,
      protocolTreasury: SAFE,
      checkedAtBlockHash: BLOCK_HASH,
      launchpadCodeHash: keccak256(LAUNCHPAD_CODE),
      code: {
        tokenFactory: { codeHash: keccak256(TOKEN_FACTORY_CODE) },
        feeVaultFactory: { codeHash: keccak256(VAULT_FACTORY_CODE) },
      },
    },
    readback: {
      evidenceBlockHash: BLOCK_HASH,
      launchpadCodeAtEvidence: LAUNCHPAD_CODE,
      launchpadCodeCurrent: LAUNCHPAD_CODE,
    },
    snapshot: {
      launchpad: {
        protocolTreasury: SAFE,
        tokenFactory: TOKEN_FACTORY,
        feeVaultFactory: VAULT_FACTORY,
        positionManager: POSITION_MANAGER,
      },
      factories: {
        token: {
          address: TOKEN_FACTORY,
          launchpad: LAUNCHPAD,
          code: TOKEN_FACTORY_CODE,
        },
        feeVault: {
          address: VAULT_FACTORY,
          launchpad: LAUNCHPAD,
          code: VAULT_FACTORY_CODE,
        },
      },
      canaries: {
        weth: weth.live,
        usdg: usdg.live,
      },
    },
  };
}

describe("Safe canary pre-sign provenance", () => {
  it("accepts an exact deployment binding and pinned release snapshot", () => {
    const value = fixture();
    expect(() =>
      assertDeploymentEvidenceBinding(value.prepared, value.deployment),
    ).not.toThrow();
    expect(() =>
      assertDeploymentEvidenceReadback(value.deployment, value.readback),
    ).not.toThrow();
    expect(() =>
      assertCanonicalReleaseSnapshot(
        value.prepared,
        value.deployment,
        value.snapshot,
      ),
    ).not.toThrow();
  });

  it("rejects deployment evidence, release, launchpad, or Safe drift", () => {
    for (const mutate of [
      (value) => {
        value.prepared.deploymentVerificationEvidenceHash =
          `0x${"30".repeat(32)}`;
      },
      (value) => {
        value.deployment.releaseCommit = "b".repeat(40);
      },
      (value) => {
        value.deployment.launchpad =
          "0xcccccccccccccccccccccccccccccccccccccccc";
      },
      (value) => {
        value.deployment.protocolTreasury =
          "0xdddddddddddddddddddddddddddddddddddddddd";
      },
    ]) {
      const value = fixture();
      mutate(value);
      expect(() =>
        assertDeploymentEvidenceBinding(value.prepared, value.deployment),
      ).toThrow();
    }
  });

  it("rejects historical block/code or current launchpad code drift", () => {
    for (const mutate of [
      (value) => {
        value.readback.evidenceBlockHash = `0x${"31".repeat(32)}`;
      },
      (value) => {
        value.readback.launchpadCodeAtEvidence = "0x6031";
      },
      (value) => {
        value.readback.launchpadCodeCurrent = "0x6032";
      },
    ]) {
      const value = fixture();
      mutate(value);
      expect(() =>
        assertDeploymentEvidenceReadback(value.deployment, value.readback),
      ).toThrow();
    }
  });

  it("rejects factory address, binding, or runtime-code drift", () => {
    for (const mutate of [
      (value) => {
        value.snapshot.factories.token.address = VAULT_FACTORY;
      },
      (value) => {
        value.snapshot.factories.feeVault.launchpad =
          "0xcccccccccccccccccccccccccccccccccccccccc";
      },
      (value) => {
        value.snapshot.factories.token.code = "0x6033";
      },
    ]) {
      const value = fixture();
      mutate(value);
      expect(() =>
        assertCanonicalReleaseSnapshot(
          value.prepared,
          value.deployment,
          value.snapshot,
        ),
      ).toThrow();
    }
  });

  it("rejects any live launch-record drift", () => {
    for (const mutate of [
      (value) => {
        value.snapshot.canaries.weth.launch.creator = SAFE;
      },
      (value) => {
        value.snapshot.canaries.weth.launch.pool =
          value.prepared.canaries.usdg.pool;
      },
      (value) => {
        value.snapshot.canaries.weth.launch.feeVault =
          value.prepared.canaries.usdg.vault;
      },
      (value) => {
        value.snapshot.canaries.weth.launch.pairedAsset = USDG;
      },
      (value) => {
        value.snapshot.canaries.weth.launch.positionId = 999n;
      },
      (value) => {
        value.snapshot.canaries.weth.launch.feeTier = 500;
      },
      (value) => {
        value.snapshot.canaries.weth.launch.floorTick = -276_240;
      },
    ]) {
      const value = fixture();
      mutate(value);
      expect(() =>
        assertCanonicalReleaseSnapshot(
          value.prepared,
          value.deployment,
          value.snapshot,
        ),
      ).toThrow();
    }
  });

  it("rejects vault immutable, position, share, or claimable drift", () => {
    for (const mutate of [
      (value) => {
        value.snapshot.canaries.usdg.vault.launchpad = TOKEN_FACTORY;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.launchToken =
          value.prepared.canaries.weth.token;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.pairedAsset = WETH;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.positionManager = TOKEN_FACTORY;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.positionId = 999n;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.totalSupply -= 1n;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.safeShares -= 1n;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.safeTokenClaimable += 1n;
      },
      (value) => {
        value.snapshot.canaries.usdg.vault.safePairClaimable = 0n;
      },
    ]) {
      const value = fixture();
      mutate(value);
      expect(() =>
        assertCanonicalReleaseSnapshot(
          value.prepared,
          value.deployment,
          value.snapshot,
        ),
      ).toThrow();
    }
  });
});

describe("Safe canary pre-sign hashes", () => {
  it("accepts exact independently recomputed hashes", () => {
    const { prepared } = fixture();
    expect(() =>
      assertPreparedSafeTransactionHashes(prepared, {
        weth: prepared.claims.weth.safeTransactionHash,
        usdg: prepared.claims.usdg.safeTransactionHash,
      }),
    ).not.toThrow();
  });

  it("rejects either recomputed hash drifting", () => {
    const { prepared } = fixture();
    expect(() =>
      assertPreparedSafeTransactionHashes(prepared, {
        weth: `0x${"33".repeat(32)}`,
        usdg: prepared.claims.usdg.safeTransactionHash,
      }),
    ).toThrow(/WETH Safe transaction hash/);
  });
});
