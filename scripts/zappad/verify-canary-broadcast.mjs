import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
} from "viem";
import {
  CANARY_POLICY,
  CANARY_POLICY_HASH,
  extractCanaryLaunches,
  LAUNCH_PROVENANCE_ABI,
  parseForgeBroadcast,
  validateCanaryTransactionSequence,
} from "./lib/forge-broadcast-evidence.mjs";
import {
  parseDeploymentVerificationEvidence,
  parseReviewedCanaryPlan,
} from "./lib/canary-reviewed-plan.mjs";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";

const EXPECTED_CHAIN_ID = 4663;

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

async function main() {
  const rpcUrl = requiredEnv("ROBINHOOD_RPC_URL");
  if (new URL(rpcUrl).protocol !== "https:") {
    throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
  }
  const broadcastFile = resolve(requiredEnv("CANARY_FORGE_BROADCAST"));
  const expectedSender = requiredEnv("CANARY_CREATOR");
  if (!isAddress(expectedSender)) throw new Error("CANARY_CREATOR is invalid");
  const launchpad = requiredEnv("ZAPPAD_LAUNCHPAD");
  if (!isAddress(launchpad)) throw new Error("ZAPPAD_LAUNCHPAD is invalid");
  const safeTreasury = requiredEnv("SAFE_TREASURY");
  if (!isAddress(safeTreasury)) throw new Error("SAFE_TREASURY is invalid");
  const expectedCommit = requiredEnv("EXPECTED_RELEASE_COMMIT");
  await verifyReleaseCheckout(expectedCommit);
  const deploymentVerificationJson = await readFile(
    resolve(requiredEnv("DEPLOYMENT_VERIFICATION_EVIDENCE")),
    "utf8",
  );
  const deploymentVerification = parseDeploymentVerificationEvidence(
    deploymentVerificationJson,
    {
      expectedHash: requiredEnv(
        "EXPECTED_DEPLOYMENT_VERIFICATION_EVIDENCE_HASH",
      ),
      expectedReleaseCommit: expectedCommit,
    },
  );
  const reviewedPlanJson = await readFile(
    resolve(requiredEnv("CANARY_REVIEWED_PLAN")),
    "utf8",
  );
  const reviewedPlan = parseReviewedCanaryPlan(reviewedPlanJson, {
    expectedHash: requiredEnv("EXPECTED_CANARY_REVIEWED_PLAN_HASH"),
    expectedReleaseCommit: expectedCommit,
    expectedLaunchpad: launchpad,
    expectedCreator: expectedSender,
    expectedTreasury: safeTreasury,
    deploymentVerification,
  });
  const minimumConfirmations = positiveIntegerEnv(
    "CANARY_MIN_CONFIRMATIONS",
    "12",
  );
  const broadcast = JSON.parse(await readFile(broadcastFile, "utf8"));
  const entries = parseForgeBroadcast(broadcast, {
    expectedSender,
    expectedCommit,
    minimumTransactions: 30,
  });
  const client = createPublicClient({ transport: http(rpcUrl) });
  const [
    chainId,
    verificationBlock,
    deploymentEvidenceBlock,
    launchpadCodeAtDeploymentVerification,
  ] = await Promise.all([
    rpcCall("chain id", () => client.getChainId()),
    rpcCall("verification block", () => client.getBlock()),
    rpcCall("deployment evidence block", () =>
      client.getBlock({
        blockNumber: deploymentVerification.checkedAtBlock,
      }),
    ),
    rpcCall("deployment-evidence launchpad code", () =>
      client.getCode({
        address: deploymentVerification.launchpad,
        blockNumber: deploymentVerification.checkedAtBlock,
      }),
    ),
  ]);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${EXPECTED_CHAIN_ID}, received ${chainId}`);
  }
  if (
    !verificationBlock.hash ||
    verificationBlock.number == null ||
    reviewedPlan.simulatedAtBlock > verificationBlock.number
  ) {
    throw new Error("Unable to establish an exact canary verification block");
  }
  if (
    !deploymentEvidenceBlock.hash ||
    deploymentEvidenceBlock.hash.toLowerCase() !==
      deploymentVerification.checkedAtBlockHash ||
    !launchpadCodeAtDeploymentVerification ||
    launchpadCodeAtDeploymentVerification === "0x" ||
    keccak256(launchpadCodeAtDeploymentVerification) !==
      deploymentVerification.launchpadCodeHash
  ) {
    throw new Error(
      "Deployment verification evidence no longer matches Robinhood Chain",
    );
  }

  const verified = [];
  const liveReceipts = [];
  for (const entry of entries) {
    const [transaction, receipt] = await Promise.all([
      rpcCall(`transaction ${entry.index}`, () =>
        client.getTransaction({ hash: entry.transactionHash }),
      ),
      rpcCall(`receipt ${entry.index}`, () =>
        client.getTransactionReceipt({ hash: entry.transactionHash }),
      ),
    ]);
    if (
      receipt.status !== "success" ||
      receipt.blockHash.toLowerCase() !== entry.blockHash ||
      receipt.blockNumber !== entry.blockNumber ||
      Boolean(transaction.to) !== Boolean(entry.to) ||
      (transaction.to && entry.to && !sameAddress(transaction.to, entry.to)) ||
      !sameAddress(transaction.from, entry.from) ||
      BigInt(transaction.nonce) !== entry.nonce ||
      transaction.value !== entry.value ||
      transaction.input.toLowerCase() !== entry.input
    ) {
      throw new Error(`Onchain transaction ${entry.index} does not match Forge evidence`);
    }
    const confirmations =
      verificationBlock.number - receipt.blockNumber + 1n;
    if (confirmations < minimumConfirmations) {
      throw new Error(
        `Transaction ${entry.index} has ${confirmations} confirmations; ${minimumConfirmations} required`,
      );
    }
    verified.push({
      index: entry.index,
      transactionHash: entry.transactionHash,
      blockHash: entry.blockHash,
      blockNumber: entry.blockNumber.toString(),
      confirmations: confirmations.toString(),
      nonce: entry.nonce.toString(),
      to: entry.to,
      function: entry.function,
      status: "success",
    });
    liveReceipts.push(receipt);
  }
  const launches = extractCanaryLaunches(liveReceipts, {
    expectedLaunchpad: launchpad,
    expectedCreator: expectedSender,
    transactions: entries,
  });
  validateCanaryTransactionSequence(entries, {
    expectedLaunchpad: launchpad,
    expectedCreator: expectedSender,
    expectedTreasury: safeTreasury,
    launches,
    receipts: liveReceipts,
    reviewedPlan,
  });
  for (const [key, launch] of Object.entries(launches)) {
    const blockNumber = BigInt(launch.blockNumber);
    const [provenance, block] = await Promise.all([
      rpcCall(`${key} launch provenance`, () =>
        client.readContract({
          address: getAddress(launchpad),
          abi: LAUNCH_PROVENANCE_ABI,
          functionName: "launchProvenance",
          args: [launch.token],
          blockNumber,
        }),
      ),
      rpcCall(`${key} launch block`, () => client.getBlock({ blockNumber })),
    ]);
    const [
      configHash,
      launchedAt,
      firstBuyAmountIn,
      firstBuyAmountOut,
    ] = provenance;
    if (
      !block.hash ||
      block.hash.toLowerCase() !== launch.blockHash.toLowerCase() ||
      configHash.toLowerCase() !== launch.configHash.toLowerCase() ||
      launchedAt !== BigInt(launch.launchedAt) ||
      launchedAt !== block.timestamp ||
      firstBuyAmountIn !== BigInt(launch.firstBuyAmountIn) ||
      firstBuyAmountOut !== BigInt(launch.firstBuyAmountOut)
    ) {
      throw new Error(`${key.toUpperCase()} provenance readback mismatch`);
    }
  }
  const verificationBlockReadback = await rpcCall(
    "verification block readback",
    () => client.getBlock({ blockNumber: verificationBlock.number }),
  );
  if (
    !verificationBlockReadback.hash ||
    verificationBlockReadback.hash.toLowerCase() !==
      verificationBlock.hash.toLowerCase()
  ) {
    throw new Error("Canary verification block changed during readback");
  }

  const evidence = {
    ok: true,
    kind: "zappad-canary-creator-broadcast",
    chainId,
    releaseCommit: expectedCommit,
    forgeCommit: broadcast.commit,
    creator: getAddress(expectedSender),
    launchpad: getAddress(launchpad),
    safeTreasury: getAddress(safeTreasury),
    checkedAtBlock: verificationBlock.number.toString(),
    checkedAtBlockHash: verificationBlock.hash,
    minimumConfirmations: minimumConfirmations.toString(),
    canaryPolicy: CANARY_POLICY,
    canaryPolicyHash: CANARY_POLICY_HASH,
    reviewedPlanHash: reviewedPlan.hash,
    reviewedPlanSourceSimulationHash: reviewedPlan.sourceSimulationHash,
    reviewedPlanApprovedAt: reviewedPlan.approvedAt,
    reviewedPlanSimulatedAtBlock: reviewedPlan.simulatedAtBlock.toString(),
    deploymentVerificationEvidenceHash:
      reviewedPlan.deploymentVerification.evidenceHash,
    transactionCount: verified.length,
    transactions: verified,
    launches,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.CANARY_BROADCAST_EVIDENCE) {
    await writeFile(resolve(process.env.CANARY_BROADCAST_EVIDENCE), json, {
      flag: "wx",
    });
  }
  process.stdout.write(json);
}

main().catch((error) => {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const raw = error instanceof Error ? error.message : String(error);
  const message = rpcUrl ? raw.split(rpcUrl).join("[redacted RPC]") : raw;
  console.error(message);
  process.exitCode = 1;
});
