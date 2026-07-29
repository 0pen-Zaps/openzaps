import {
  getAddress,
  isAddress,
  isHash,
  keccak256,
  toBytes,
} from "viem";

export const REVIEWED_PLAN_SCHEMA = "zappad-reviewed-canary-plan/v2";
export const REVIEWED_PLAN_STATUS = "approved-for-broadcast";
export const MAX_REVIEWED_SLIPPAGE_BPS = 500n;
const BPS = 10_000n;
const EXPECTED_CHAIN_ID = 4663;
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const MAX_WETH_FIRST_BUY = 1_000_000_000_000_000n;
const MAX_USDG_FIRST_BUY = 10_000_000n;
const EXPECTED_LAUNCH_CONFIG_DOMAIN = keccak256(
  toBytes("ZapPadLaunchConfig:v1"),
);
const REQUIRED_SOURCE_VERIFICATIONS = [
  "bootstrap",
  "launchpad",
  "tokenFactory",
  "feeVaultFactory",
];
const EXPECTED_CANARIES = Object.freeze({
  weth: {
    name: "ZapPad WETH Canary",
    symbol: "ZPWC",
    metadataURI: "urn:zappad:canary:weth:v1",
    pair: WETH,
    feeTier: 3000,
    floorTick: -276_300,
    firstBuyCap: MAX_WETH_FIRST_BUY,
  },
  usdg: {
    name: "ZapPad USDG Canary",
    symbol: "ZPUC",
    metadataURI: "urn:zappad:canary:usdg:v1",
    pair: USDG,
    feeTier: 3000,
    floorTick: -460_020,
    firstBuyCap: MAX_USDG_FIRST_BUY,
  },
});

function requiredAddress(value, label) {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address`);
  return getAddress(value);
}

function requiredHash(value, label) {
  if (!isHash(value)) throw new Error(`${label} is not a valid hash`);
  return value.toLowerCase();
}

function requiredTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical ISO timestamp`);
  }
  return value;
}

function requiredInteger(value, label, { positive = false } = {}) {
  const normalized =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
          ? BigInt(value)
          : null;
  if (normalized == null || (positive && normalized <= 0n)) {
    throw new Error(`${label} must be ${positive ? "a positive" : "a non-negative"} integer`);
  }
  return normalized;
}

function simulationInteger(simulation, key, label, options) {
  return requiredInteger(simulation[key], label, options);
}

function assertRatio(actual, expected, label) {
  if (actual !== expected || actual <= 0n) {
    throw new Error(`${label} does not match the reviewed canary ratio`);
  }
}

function assertSlippageMinimum(minimum, simulatedOutput, label) {
  if (
    minimum <= 0n ||
    minimum > simulatedOutput ||
    minimum * BPS <
      simulatedOutput * (BPS - MAX_REVIEWED_SLIPPAGE_BPS)
  ) {
    throw new Error(
      `${label} must be nonzero and within ${MAX_REVIEWED_SLIPPAGE_BPS} bps of the simulated output`,
    );
  }
}

function buildCanary(simulation, key) {
  const expected = EXPECTED_CANARIES[key];
  const prefix = key;
  const token = requiredAddress(
    simulation[`${prefix}Token`],
    `${key} simulated token`,
  );
  const vault = requiredAddress(
    simulation[`${prefix}Vault`],
    `${key} simulated vault`,
  );
  const pool = requiredAddress(
    simulation[`${prefix}Pool`],
    `${key} simulated pool`,
  );
  const pair = requiredAddress(
    simulation[`${prefix}Pair`],
    `${key} simulated pair`,
  );
  if (pair !== expected.pair) {
    throw new Error(`${key} simulated pair is not canonical`);
  }

  const firstBuyPairIn = simulationInteger(
    simulation,
    `${prefix}FirstBuyPairIn`,
    `${key} first buy input`,
    { positive: true },
  );
  if (firstBuyPairIn > expected.firstBuyCap) {
    throw new Error(`${key} first buy exceeds the reviewed cap`);
  }
  const firstBuyTokenOut = simulationInteger(
    simulation,
    `${prefix}FirstBuyTokenOut`,
    `${key} first buy output`,
    { positive: true },
  );
  const firstSellTokenIn = simulationInteger(
    simulation,
    `${prefix}FirstSellTokenIn`,
    `${key} first sell input`,
    { positive: true },
  );
  const firstSellPairOut = simulationInteger(
    simulation,
    `${prefix}FirstSellPairOut`,
    `${key} first sell output`,
    { positive: true },
  );
  const secondBuyPairIn = simulationInteger(
    simulation,
    `${prefix}SecondBuyPairIn`,
    `${key} second buy input`,
    { positive: true },
  );
  const secondBuyTokenOut = simulationInteger(
    simulation,
    `${prefix}SecondBuyTokenOut`,
    `${key} second buy output`,
    { positive: true },
  );
  const secondSellTokenIn = simulationInteger(
    simulation,
    `${prefix}SecondSellTokenIn`,
    `${key} second sell input`,
    { positive: true },
  );
  const secondSellPairOut = simulationInteger(
    simulation,
    `${prefix}SecondSellPairOut`,
    `${key} second sell output`,
    { positive: true },
  );
  assertRatio(
    firstSellTokenIn,
    firstBuyTokenOut / 4n,
    `${key} first sell input`,
  );
  assertRatio(
    secondBuyPairIn,
    firstSellPairOut / 2n,
    `${key} second buy input`,
  );
  assertRatio(
    secondSellTokenIn,
    secondBuyTokenOut / 2n,
    `${key} second sell input`,
  );

  const minFirstBuyTokenOut = simulationInteger(
    simulation,
    `${prefix}MinFirstBuyTokenOut`,
    `${key} first buy minimum`,
    { positive: true },
  );
  const minFirstSellPairOut = simulationInteger(
    simulation,
    `${prefix}MinFirstSellPairOut`,
    `${key} first sell minimum`,
    { positive: true },
  );
  const minSecondBuyTokenOut = simulationInteger(
    simulation,
    `${prefix}MinSecondBuyTokenOut`,
    `${key} second buy minimum`,
    { positive: true },
  );
  const minSecondSellPairOut = simulationInteger(
    simulation,
    `${prefix}MinSecondSellPairOut`,
    `${key} second sell minimum`,
    { positive: true },
  );
  assertSlippageMinimum(
    minFirstBuyTokenOut,
    firstBuyTokenOut,
    `${key} first buy minimum`,
  );
  assertSlippageMinimum(
    minFirstSellPairOut,
    firstSellPairOut,
    `${key} first sell minimum`,
  );
  assertSlippageMinimum(
    minSecondBuyTokenOut,
    secondBuyTokenOut,
    `${key} second buy minimum`,
  );
  assertSlippageMinimum(
    minSecondSellPairOut,
    secondSellPairOut,
    `${key} second sell minimum`,
  );

  return {
    name: expected.name,
    symbol: expected.symbol,
    metadataURI: expected.metadataURI,
    token,
    vault,
    pool,
    pair,
    feeTier: expected.feeTier,
    floorTick: expected.floorTick,
    salt: requiredHash(simulation[`${prefix}Salt`], `${key} salt`),
    firstBuyPairIn: firstBuyPairIn.toString(),
    nativeValue: (key === "weth" ? firstBuyPairIn : 0n).toString(),
    minFirstBuyTokenOut: minFirstBuyTokenOut.toString(),
    minFirstSellPairOut: minFirstSellPairOut.toString(),
    minSecondBuyTokenOut: minSecondBuyTokenOut.toString(),
    minSecondSellPairOut: minSecondSellPairOut.toString(),
    simulated: {
      firstBuyTokenOut: firstBuyTokenOut.toString(),
      firstSellTokenIn: firstSellTokenIn.toString(),
      firstSellPairOut: firstSellPairOut.toString(),
      secondBuyPairIn: secondBuyPairIn.toString(),
      secondBuyTokenOut: secondBuyTokenOut.toString(),
      secondSellTokenIn: secondSellTokenIn.toString(),
      secondSellPairOut: secondSellPairOut.toString(),
    },
  };
}

export function hashReviewedCanaryPlan(rawPlan) {
  return keccak256(toBytes(rawPlan));
}

export function hashDeploymentVerificationEvidence(rawEvidence) {
  return keccak256(toBytes(rawEvidence));
}

export function parseDeploymentVerificationEvidence(
  rawEvidence,
  { expectedHash, expectedReleaseCommit },
) {
  if (typeof rawEvidence !== "string" || rawEvidence.length === 0) {
    throw new Error("Deployment verification evidence is empty");
  }
  if (!isHash(expectedHash)) {
    throw new Error(
      "EXPECTED_DEPLOYMENT_VERIFICATION_EVIDENCE_HASH is invalid",
    );
  }
  const actualHash = hashDeploymentVerificationEvidence(rawEvidence);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      "Deployment verification evidence hash does not match its approval",
    );
  }

  let evidence;
  try {
    evidence = JSON.parse(rawEvidence);
  } catch {
    throw new Error("Deployment verification evidence is not valid JSON");
  }
  if (
    evidence?.ok !== true ||
    evidence?.kind !== "zappad-deployment-verification" ||
    Number(evidence?.chainId) !== EXPECTED_CHAIN_ID ||
    evidence?.bootstrapBindings !== true ||
    evidence?.factoryBindings !== true ||
    requiredHash(
      evidence?.launchConfigDomain,
      "deployment launch config domain",
    ) !== EXPECTED_LAUNCH_CONFIG_DOMAIN
  ) {
    throw new Error("Deployment verification evidence policy changed");
  }
  if (
    typeof expectedReleaseCommit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(expectedReleaseCommit) ||
    evidence.releaseCommit?.toLowerCase() !==
      expectedReleaseCommit.toLowerCase()
  ) {
    throw new Error("Deployment verification release commit changed");
  }
  if (
    !evidence.sourceVerification ||
    typeof evidence.sourceVerification !== "object" ||
    Array.isArray(evidence.sourceVerification) ||
    REQUIRED_SOURCE_VERIFICATIONS.some(
      (name) => evidence.sourceVerification[name]?.fullyVerified !== true,
    )
  ) {
    throw new Error(
      "Deployment verification evidence lacks full source verification",
    );
  }

  const checkedAtBlock = requiredInteger(
    evidence.checkedAtBlock,
    "deployment verification block",
    { positive: true },
  );
  const minimumConfirmations = requiredInteger(
    evidence.minimumConfirmations,
    "deployment minimum confirmations",
    { positive: true },
  );
  const deploymentBlockNumber = requiredInteger(
    evidence.deployment?.blockNumber,
    "deployment block",
    { positive: true },
  );
  const deploymentConfirmations = requiredInteger(
    evidence.deployment?.confirmations,
    "deployment confirmations",
    { positive: true },
  );
  if (
    deploymentBlockNumber > checkedAtBlock ||
    deploymentConfirmations !== checkedAtBlock - deploymentBlockNumber + 1n ||
    deploymentConfirmations < minimumConfirmations
  ) {
    throw new Error("Deployment verification confirmation evidence changed");
  }
  const launchpadCodeBytes = requiredInteger(
    evidence.code?.launchpad?.bytes,
    "deployment launchpad code length",
    { positive: true },
  );

  return {
    ...evidence,
    hash: actualHash,
    releaseCommit: expectedReleaseCommit.toLowerCase(),
    launchpad: requiredAddress(
      evidence.launchpad,
      "deployment verified launchpad",
    ),
    protocolTreasury: requiredAddress(
      evidence.protocolTreasury,
      "deployment verified protocol Safe",
    ),
    checkedAtBlock,
    checkedAtBlockHash: requiredHash(
      evidence.checkedAtBlockHash,
      "deployment verification block hash",
    ),
    minimumConfirmations,
    simulationManifestHash: requiredHash(
      evidence.simulationManifestHash,
      "deployment simulation manifest hash",
    ),
    deployment: {
      ...evidence.deployment,
      transactionHash: requiredHash(
        evidence.deployment?.transactionHash,
        "deployment transaction hash",
      ),
      blockHash: requiredHash(
        evidence.deployment?.blockHash,
        "deployment block hash",
      ),
      blockNumber: deploymentBlockNumber,
      confirmations: deploymentConfirmations,
    },
    launchpadCodeHash: requiredHash(
      evidence.code?.launchpad?.codeHash,
      "deployment launchpad code hash",
    ),
    launchpadCodeBytes,
  };
}

export function buildReviewedCanaryPlan(
  simulation,
  {
    releaseCommit,
    sourceSimulationHash,
    deploymentVerification,
    approvedAt = new Date().toISOString(),
  },
) {
  if (
    !simulation ||
    typeof simulation !== "object" ||
    Array.isArray(simulation) ||
    simulation.status !== "simulation-only" ||
    Number(simulation.chainId) !== EXPECTED_CHAIN_ID
  ) {
    throw new Error("Canary source must be a chain-4663 simulation-only manifest");
  }
  if (typeof releaseCommit !== "string" || !/^[0-9a-f]{40}$/i.test(releaseCommit)) {
    throw new Error("Reviewed plan release commit must be a full Git commit");
  }
  requiredTimestamp(approvedAt, "reviewed plan approval timestamp");
  if (
    !deploymentVerification ||
    deploymentVerification.releaseCommit !== releaseCommit.toLowerCase() ||
    !isHash(deploymentVerification.hash)
  ) {
    throw new Error(
      "Reviewed plan requires matching deployment verification evidence",
    );
  }
  const launchpad = requiredAddress(
    simulation.launchpad,
    "simulation launchpad",
  );
  const safeTreasury = requiredAddress(
    simulation.safeTreasury,
    "simulation Safe treasury",
  );
  if (
    launchpad !== deploymentVerification.launchpad ||
    safeTreasury !== deploymentVerification.protocolTreasury
  ) {
    throw new Error(
      "Canary simulation identity does not match deployment verification evidence",
    );
  }
  const simulatedAtBlock = simulationInteger(
    simulation,
    "simulatedAtBlock",
    "simulation block",
    { positive: true },
  );
  if (simulatedAtBlock < deploymentVerification.checkedAtBlock) {
    throw new Error(
      "Canary simulation predates the deployment verification block",
    );
  }

  return {
    schema: REVIEWED_PLAN_SCHEMA,
    status: REVIEWED_PLAN_STATUS,
    chainId: EXPECTED_CHAIN_ID,
    releaseCommit: releaseCommit.toLowerCase(),
    sourceSimulationHash: requiredHash(
      sourceSimulationHash,
      "source simulation hash",
    ),
    approvedAt,
    simulatedAtBlock: simulatedAtBlock.toString(),
    deploymentVerification: {
      evidenceHash: deploymentVerification.hash,
      checkedAtBlock: deploymentVerification.checkedAtBlock.toString(),
      checkedAtBlockHash: deploymentVerification.checkedAtBlockHash,
      transactionHash: deploymentVerification.deployment.transactionHash,
      blockNumber: deploymentVerification.deployment.blockNumber.toString(),
      blockHash: deploymentVerification.deployment.blockHash,
      launchpadCodeHash: deploymentVerification.launchpadCodeHash,
    },
    launchpad,
    creator: requiredAddress(simulation.creator, "simulation creator"),
    safeTreasury,
    maxSlippageBps: Number(MAX_REVIEWED_SLIPPAGE_BPS),
    ratios: {
      firstSellFromFirstBuy: "1/4",
      secondBuyFromFirstSell: "1/2",
      secondSellFromSecondBuy: "1/2",
    },
    launches: {
      weth: buildCanary(simulation, "weth"),
      usdg: buildCanary(simulation, "usdg"),
    },
  };
}

function parseCanary(plan, key) {
  const value = plan?.launches?.[key];
  const expected = EXPECTED_CANARIES[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Reviewed ${key} plan is missing`);
  }
  if (
    value.name !== expected.name ||
    value.symbol !== expected.symbol ||
    value.metadataURI !== expected.metadataURI ||
    Number(value.feeTier) !== expected.feeTier ||
    Number(value.floorTick) !== expected.floorTick ||
    requiredAddress(value.pair, `${key} reviewed pair`) !== expected.pair
  ) {
    throw new Error(`Reviewed ${key} canary identity changed`);
  }
  const firstBuyPairIn = requiredInteger(
    value.firstBuyPairIn,
    `${key} reviewed first buy`,
    { positive: true },
  );
  if (firstBuyPairIn > expected.firstBuyCap) {
    throw new Error(`${key} reviewed first buy exceeds its cap`);
  }
  const nativeValue = requiredInteger(
    value.nativeValue,
    `${key} reviewed native value`,
  );
  if (nativeValue !== (key === "weth" ? firstBuyPairIn : 0n)) {
    throw new Error(`${key} reviewed native value changed`);
  }

  const minFirstBuyTokenOut = requiredInteger(
    value.minFirstBuyTokenOut,
    `${key} reviewed first buy minimum`,
    { positive: true },
  );
  const minFirstSellPairOut = requiredInteger(
    value.minFirstSellPairOut,
    `${key} reviewed first sell minimum`,
    { positive: true },
  );
  const minSecondBuyTokenOut = requiredInteger(
    value.minSecondBuyTokenOut,
    `${key} reviewed second buy minimum`,
    { positive: true },
  );
  const minSecondSellPairOut = requiredInteger(
    value.minSecondSellPairOut,
    `${key} reviewed second sell minimum`,
    { positive: true },
  );
  const simulated = {
    firstBuyTokenOut: requiredInteger(
      value.simulated?.firstBuyTokenOut,
      `${key} reviewed first buy output`,
      { positive: true },
    ),
    firstSellTokenIn: requiredInteger(
      value.simulated?.firstSellTokenIn,
      `${key} reviewed first sell input`,
      { positive: true },
    ),
    firstSellPairOut: requiredInteger(
      value.simulated?.firstSellPairOut,
      `${key} reviewed first sell output`,
      { positive: true },
    ),
    secondBuyPairIn: requiredInteger(
      value.simulated?.secondBuyPairIn,
      `${key} reviewed second buy input`,
      { positive: true },
    ),
    secondBuyTokenOut: requiredInteger(
      value.simulated?.secondBuyTokenOut,
      `${key} reviewed second buy output`,
      { positive: true },
    ),
    secondSellTokenIn: requiredInteger(
      value.simulated?.secondSellTokenIn,
      `${key} reviewed second sell input`,
      { positive: true },
    ),
    secondSellPairOut: requiredInteger(
      value.simulated?.secondSellPairOut,
      `${key} reviewed second sell output`,
      { positive: true },
    ),
  };
  assertRatio(
    simulated.firstSellTokenIn,
    simulated.firstBuyTokenOut / 4n,
    `${key} reviewed first sell input`,
  );
  assertRatio(
    simulated.secondBuyPairIn,
    simulated.firstSellPairOut / 2n,
    `${key} reviewed second buy input`,
  );
  assertRatio(
    simulated.secondSellTokenIn,
    simulated.secondBuyTokenOut / 2n,
    `${key} reviewed second sell input`,
  );
  assertSlippageMinimum(
    minFirstBuyTokenOut,
    simulated.firstBuyTokenOut,
    `${key} reviewed first buy minimum`,
  );
  assertSlippageMinimum(
    minFirstSellPairOut,
    simulated.firstSellPairOut,
    `${key} reviewed first sell minimum`,
  );
  assertSlippageMinimum(
    minSecondBuyTokenOut,
    simulated.secondBuyTokenOut,
    `${key} reviewed second buy minimum`,
  );
  assertSlippageMinimum(
    minSecondSellPairOut,
    simulated.secondSellPairOut,
    `${key} reviewed second sell minimum`,
  );

  return {
    ...value,
    token: requiredAddress(value.token, `${key} reviewed token`),
    vault: requiredAddress(value.vault, `${key} reviewed vault`),
    pool: requiredAddress(value.pool, `${key} reviewed pool`),
    pair: expected.pair,
    salt: requiredHash(value.salt, `${key} reviewed salt`),
    feeTier: expected.feeTier,
    floorTick: expected.floorTick,
    firstBuyPairIn,
    nativeValue,
    minFirstBuyTokenOut,
    minFirstSellPairOut,
    minSecondBuyTokenOut,
    minSecondSellPairOut,
    simulated,
  };
}

export function parseReviewedCanaryPlan(
  rawPlan,
  {
    expectedHash,
    expectedReleaseCommit,
    expectedLaunchpad,
    expectedCreator,
    expectedTreasury,
    deploymentVerification,
  },
) {
  if (typeof rawPlan !== "string" || rawPlan.length === 0) {
    throw new Error("Reviewed canary plan is empty");
  }
  if (!isHash(expectedHash)) {
    throw new Error("EXPECTED_CANARY_REVIEWED_PLAN_HASH is invalid");
  }
  const actualHash = hashReviewedCanaryPlan(rawPlan);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error("Reviewed canary plan hash does not match its approval");
  }

  let plan;
  try {
    plan = JSON.parse(rawPlan);
  } catch {
    throw new Error("Reviewed canary plan is not valid JSON");
  }
  if (
    plan?.schema !== REVIEWED_PLAN_SCHEMA ||
    plan?.status !== REVIEWED_PLAN_STATUS ||
    Number(plan?.chainId) !== EXPECTED_CHAIN_ID ||
    Number(plan?.maxSlippageBps) !== Number(MAX_REVIEWED_SLIPPAGE_BPS) ||
    plan?.ratios?.firstSellFromFirstBuy !== "1/4" ||
    plan?.ratios?.secondBuyFromFirstSell !== "1/2" ||
    plan?.ratios?.secondSellFromSecondBuy !== "1/2"
  ) {
    throw new Error("Reviewed canary plan policy changed");
  }
  if (
    typeof expectedReleaseCommit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(expectedReleaseCommit) ||
    plan.releaseCommit?.toLowerCase() !== expectedReleaseCommit.toLowerCase()
  ) {
    throw new Error("Reviewed canary plan release commit changed");
  }
  const launchpad = requiredAddress(plan.launchpad, "reviewed launchpad");
  const creator = requiredAddress(plan.creator, "reviewed creator");
  const safeTreasury = requiredAddress(
    plan.safeTreasury,
    "reviewed Safe treasury",
  );
  if (
    launchpad !== getAddress(expectedLaunchpad) ||
    creator !== getAddress(expectedCreator) ||
    safeTreasury !== getAddress(expectedTreasury)
  ) {
    throw new Error("Reviewed canary plan deployment identity changed");
  }
  requiredHash(plan.sourceSimulationHash, "reviewed source simulation hash");
  const approvedAt = requiredTimestamp(
    plan.approvedAt,
    "reviewed plan approval timestamp",
  );
  const simulatedAtBlock = requiredInteger(
    plan.simulatedAtBlock,
    "reviewed simulation block",
    { positive: true },
  );
  if (
    !deploymentVerification ||
    deploymentVerification.releaseCommit !== expectedReleaseCommit.toLowerCase()
  ) {
    throw new Error(
      "Reviewed canary plan lacks matching deployment verification evidence",
    );
  }
  const deployment = plan.deploymentVerification;
  if (
    !deployment ||
    requiredHash(
      deployment.evidenceHash,
      "reviewed deployment evidence hash",
    ) !== deploymentVerification.hash ||
    requiredInteger(
      deployment.checkedAtBlock,
      "reviewed deployment verification block",
      { positive: true },
    ) !== deploymentVerification.checkedAtBlock ||
    requiredHash(
      deployment.checkedAtBlockHash,
      "reviewed deployment verification block hash",
    ) !== deploymentVerification.checkedAtBlockHash ||
    requiredHash(
      deployment.transactionHash,
      "reviewed deployment transaction hash",
    ) !== deploymentVerification.deployment.transactionHash ||
    requiredInteger(
      deployment.blockNumber,
      "reviewed deployment block",
      { positive: true },
    ) !== deploymentVerification.deployment.blockNumber ||
    requiredHash(
      deployment.blockHash,
      "reviewed deployment block hash",
    ) !== deploymentVerification.deployment.blockHash ||
    requiredHash(
      deployment.launchpadCodeHash,
      "reviewed launchpad code hash",
    ) !== deploymentVerification.launchpadCodeHash ||
    simulatedAtBlock < deploymentVerification.checkedAtBlock
  ) {
    throw new Error(
      "Reviewed canary plan deployment verification binding changed",
    );
  }

  return {
    ...plan,
    hash: actualHash,
    approvedAt,
    simulatedAtBlock,
    deploymentVerification: {
      ...deployment,
      evidenceHash: deploymentVerification.hash,
      checkedAtBlock: deploymentVerification.checkedAtBlock,
      checkedAtBlockHash: deploymentVerification.checkedAtBlockHash,
      transactionHash: deploymentVerification.deployment.transactionHash,
      blockNumber: deploymentVerification.deployment.blockNumber,
      blockHash: deploymentVerification.deployment.blockHash,
      launchpadCodeHash: deploymentVerification.launchpadCodeHash,
    },
    launchpad,
    creator,
    safeTreasury,
    launches: {
      weth: parseCanary(plan, "weth"),
      usdg: parseCanary(plan, "usdg"),
    },
  };
}
