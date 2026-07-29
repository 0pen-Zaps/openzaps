import { describe, expect, it } from "vitest";
import {
  buildReviewedCanaryPlan,
  hashDeploymentVerificationEvidence,
  hashReviewedCanaryPlan,
  parseDeploymentVerificationEvidence,
  parseReviewedCanaryPlan,
} from "./canary-reviewed-plan.mjs";
import { keccak256, toBytes } from "viem";

const COMMIT = "a".repeat(40);
const LAUNCHPAD = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const TREASURY = "0x3333333333333333333333333333333333333333";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const DEPLOYMENT_BLOCK = 21_999_988;
const DEPLOYMENT_CHECKED_BLOCK = 21_999_999;
const DEPLOYMENT_TRANSACTION_HASH = `0x${"c".repeat(64)}`;
const DEPLOYMENT_BLOCK_HASH = `0x${"d".repeat(64)}`;
const DEPLOYMENT_CHECKED_BLOCK_HASH = `0x${"e".repeat(64)}`;
const LAUNCHPAD_CODE_HASH = `0x${"f".repeat(64)}`;

function deploymentEvidence() {
  return {
    ok: true,
    kind: "zappad-deployment-verification",
    chainId: 4663,
    releaseCommit: COMMIT,
    checkedAtBlock: String(DEPLOYMENT_CHECKED_BLOCK),
    checkedAtBlockHash: DEPLOYMENT_CHECKED_BLOCK_HASH,
    minimumConfirmations: "12",
    simulationManifestHash: `0x${"1".repeat(64)}`,
    deployment: {
      transactionHash: DEPLOYMENT_TRANSACTION_HASH,
      blockHash: DEPLOYMENT_BLOCK_HASH,
      blockNumber: String(DEPLOYMENT_BLOCK),
      confirmations: "12",
    },
    launchpad: LAUNCHPAD,
    protocolTreasury: TREASURY,
    launchConfigDomain: keccak256(toBytes("ZapPadLaunchConfig:v1")),
    bootstrapBindings: true,
    factoryBindings: true,
    sourceVerification: {
      bootstrap: { fullyVerified: true },
      launchpad: { fullyVerified: true },
      tokenFactory: { fullyVerified: true },
      feeVaultFactory: { fullyVerified: true },
    },
    code: {
      launchpad: {
        bytes: 1,
        codeHash: LAUNCHPAD_CODE_HASH,
      },
    },
  };
}

function parsedDeploymentEvidence(source = deploymentEvidence()) {
  const raw = `${JSON.stringify(source, null, 2)}\n`;
  return parseDeploymentVerificationEvidence(raw, {
    expectedHash: hashDeploymentVerificationEvidence(raw),
    expectedReleaseCommit: COMMIT,
  });
}

function canaryFields(prefix, index, pair, firstBuyPairIn) {
  return {
    [`${prefix}Token`]: `0x${String(index).padStart(40, "0")}`,
    [`${prefix}Vault`]: `0x${String(index + 10).padStart(40, "0")}`,
    [`${prefix}Pool`]: `0x${String(index + 20).padStart(40, "0")}`,
    [`${prefix}Pair`]: pair,
    [`${prefix}Salt`]: `0x${String(index).padStart(64, "0")}`,
    [`${prefix}FirstBuyPairIn`]: firstBuyPairIn,
    [`${prefix}FirstBuyTokenOut`]: "10000",
    [`${prefix}MinFirstBuyTokenOut`]: "9500",
    [`${prefix}FirstSellTokenIn`]: "2500",
    [`${prefix}FirstSellPairOut`]: "1000",
    [`${prefix}MinFirstSellPairOut`]: "950",
    [`${prefix}SecondBuyPairIn`]: "500",
    [`${prefix}SecondBuyTokenOut`]: "800",
    [`${prefix}MinSecondBuyTokenOut`]: "760",
    [`${prefix}SecondSellTokenIn`]: "400",
    [`${prefix}SecondSellPairOut`]: "400",
    [`${prefix}MinSecondSellPairOut`]: "380",
  };
}

function simulation() {
  return {
    status: "simulation-only",
    chainId: 4663,
    simulatedAtBlock: 22_000_000,
    launchpad: LAUNCHPAD,
    creator: CREATOR,
    safeTreasury: TREASURY,
    ...canaryFields("weth", 1, WETH, "100000000000000"),
    ...canaryFields("usdg", 2, USDG, "1000000"),
  };
}

function build(source = simulation()) {
  return buildReviewedCanaryPlan(source, {
    releaseCommit: COMMIT,
    sourceSimulationHash: `0x${"b".repeat(64)}`,
    deploymentVerification: parsedDeploymentEvidence(),
    approvedAt: "2026-07-28T12:00:00.000Z",
  });
}

describe("reviewed canary plans", () => {
  it("requires the exact approved deployment-verification evidence bytes", () => {
    const raw = `${JSON.stringify(deploymentEvidence(), null, 2)}\n`;
    expect(() =>
      parseDeploymentVerificationEvidence(
        raw.replace(LAUNCHPAD_CODE_HASH, `0x${"0".repeat(64)}`),
        {
          expectedHash: hashDeploymentVerificationEvidence(raw),
          expectedReleaseCommit: COMMIT,
        },
      ),
    ).toThrow(/hash does not match/);
  });

  it("builds a hash-bound plan with exact ratios and five-percent minima", () => {
    const plan = build();
    const raw = `${JSON.stringify(plan, null, 2)}\n`;
    const hash = hashReviewedCanaryPlan(raw);
    const parsed = parseReviewedCanaryPlan(raw, {
      expectedHash: hash,
      expectedReleaseCommit: COMMIT,
      expectedLaunchpad: LAUNCHPAD,
      expectedCreator: CREATOR,
      expectedTreasury: TREASURY,
      deploymentVerification: parsedDeploymentEvidence(),
    });

    expect(parsed.hash).toBe(hash);
    expect(parsed.launches.weth.firstBuyPairIn).toBe(100_000_000_000_000n);
    expect(parsed.launches.usdg.minSecondSellPairOut).toBe(380n);
    expect(parsed.deploymentVerification.evidenceHash).toBe(
      parsedDeploymentEvidence().hash,
    );
  });

  it("rejects a simulation for a different deployment-verified launchpad", () => {
    const source = simulation();
    source.launchpad = "0x4444444444444444444444444444444444444444";
    expect(() => build(source)).toThrow(/does not match deployment verification/);
  });

  it("rejects a nominal one-unit minimum", () => {
    const source = simulation();
    source.wethMinFirstBuyTokenOut = "1";
    expect(() => build(source)).toThrow(/within 500 bps/);
  });

  it("rejects a rehashed plan that lowers a minimum to one unit", () => {
    const plan = build();
    plan.launches.weth.minFirstSellPairOut = "1";
    const raw = `${JSON.stringify(plan, null, 2)}\n`;
    expect(() =>
      parseReviewedCanaryPlan(raw, {
        expectedHash: hashReviewedCanaryPlan(raw),
        expectedReleaseCommit: COMMIT,
        expectedLaunchpad: LAUNCHPAD,
        expectedCreator: CREATOR,
        expectedTreasury: TREASURY,
        deploymentVerification: parsedDeploymentEvidence(),
      }),
    ).toThrow(/within 500 bps/);
  });

  it("rejects a simulation that changed a reviewed ratio", () => {
    const source = simulation();
    source.wethFirstSellTokenIn = "2499";
    expect(() => build(source)).toThrow(/reviewed canary ratio/);
  });

  it("rejects a rehashed plan whose embedded simulation changes a ratio", () => {
    const plan = build();
    plan.launches.weth.simulated.secondSellTokenIn = "399";
    const raw = `${JSON.stringify(plan, null, 2)}\n`;
    expect(() =>
      parseReviewedCanaryPlan(raw, {
        expectedHash: hashReviewedCanaryPlan(raw),
        expectedReleaseCommit: COMMIT,
        expectedLaunchpad: LAUNCHPAD,
        expectedCreator: CREATOR,
        expectedTreasury: TREASURY,
        deploymentVerification: parsedDeploymentEvidence(),
      }),
    ).toThrow(/reviewed canary ratio/);
  });

  it("rejects a plan whose bytes no longer match the approved hash", () => {
    const plan = build();
    const raw = `${JSON.stringify(plan, null, 2)}\n`;
    expect(() =>
      parseReviewedCanaryPlan(raw.replace('"500"', '"499"'), {
        expectedHash: hashReviewedCanaryPlan(raw),
        expectedReleaseCommit: COMMIT,
        expectedLaunchpad: LAUNCHPAD,
        expectedCreator: CREATOR,
        expectedTreasury: TREASURY,
        deploymentVerification: parsedDeploymentEvidence(),
      }),
    ).toThrow(/hash does not match/);
  });

  it("rejects a rehashed plan with a non-canonical approval timestamp", () => {
    const plan = build();
    plan.approvedAt = "2026-07-28";
    const raw = `${JSON.stringify(plan, null, 2)}\n`;
    expect(() =>
      parseReviewedCanaryPlan(raw, {
        expectedHash: hashReviewedCanaryPlan(raw),
        expectedReleaseCommit: COMMIT,
        expectedLaunchpad: LAUNCHPAD,
        expectedCreator: CREATOR,
        expectedTreasury: TREASURY,
        deploymentVerification: parsedDeploymentEvidence(),
      }),
    ).toThrow(/canonical ISO timestamp/);
  });

  it("rejects a rehashed plan with an invalid simulation block", () => {
    const plan = build();
    plan.simulatedAtBlock = "0";
    const raw = `${JSON.stringify(plan, null, 2)}\n`;
    expect(() =>
      parseReviewedCanaryPlan(raw, {
        expectedHash: hashReviewedCanaryPlan(raw),
        expectedReleaseCommit: COMMIT,
        expectedLaunchpad: LAUNCHPAD,
        expectedCreator: CREATOR,
        expectedTreasury: TREASURY,
        deploymentVerification: parsedDeploymentEvidence(),
      }),
    ).toThrow(/positive integer/);
  });

  it("rejects a rehashed plan bound to another deployment artifact", () => {
    const plan = build();
    plan.deploymentVerification.evidenceHash = `0x${"9".repeat(64)}`;
    const raw = `${JSON.stringify(plan, null, 2)}\n`;
    expect(() =>
      parseReviewedCanaryPlan(raw, {
        expectedHash: hashReviewedCanaryPlan(raw),
        expectedReleaseCommit: COMMIT,
        expectedLaunchpad: LAUNCHPAD,
        expectedCreator: CREATOR,
        expectedTreasury: TREASURY,
        deploymentVerification: parsedDeploymentEvidence(),
      }),
    ).toThrow(/deployment verification binding changed/);
  });
});
