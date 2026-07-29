import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  toBytes,
} from "viem";
import {
  buildReviewedCanaryPlan,
  hashReviewedCanaryPlan,
  parseDeploymentVerificationEvidence,
} from "./lib/canary-reviewed-plan.mjs";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";

const EXPECTED_CHAIN_ID = 4663;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function rpcCall(label, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`RPC request failed while reading ${label}`);
  }
}

async function main() {
  const sourcePath = resolve(requiredEnv("CANARY_SIMULATION_MANIFEST"));
  const destinationPath = resolve(requiredEnv("CANARY_REVIEWED_PLAN"));
  if (sourcePath === destinationPath) {
    throw new Error("Reviewed plan must not overwrite its source simulation");
  }
  const expectedReleaseCommit = requiredEnv("EXPECTED_RELEASE_COMMIT");
  await verifyReleaseCheckout(expectedReleaseCommit);
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
      expectedReleaseCommit,
    },
  );

  const rpcUrl = requiredEnv("ROBINHOOD_RPC_URL");
  if (new URL(rpcUrl).protocol !== "https:") {
    throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
  }
  const sourceJson = await readFile(sourcePath, "utf8");
  let source;
  try {
    source = JSON.parse(sourceJson);
  } catch {
    throw new Error("Canary simulation manifest is not valid JSON");
  }
  const plan = buildReviewedCanaryPlan(source, {
    releaseCommit: expectedReleaseCommit,
    sourceSimulationHash: keccak256(toBytes(sourceJson)),
    deploymentVerification,
  });

  const client = createPublicClient({ transport: http(rpcUrl) });
  const [
    chainId,
    headBlock,
    deploymentVerificationBlock,
    launchpadCodeAtVerification,
    launchpadCode,
    safeCode,
    wethTokenCode,
    usdgTokenCode,
  ] = await Promise.all([
    rpcCall("chain id", () => client.getChainId()),
    rpcCall("head block", () => client.getBlock()),
    rpcCall("deployment verification block", () =>
      client.getBlock({
        blockNumber: deploymentVerification.checkedAtBlock,
      }),
    ),
    rpcCall("launchpad code at deployment verification", () =>
      client.getCode({
        address: deploymentVerification.launchpad,
        blockNumber: deploymentVerification.checkedAtBlock,
      }),
    ),
    rpcCall("launchpad code", () =>
      client.getCode({ address: deploymentVerification.launchpad }),
    ),
    rpcCall("protocol Safe code", () =>
      client.getCode({ address: deploymentVerification.protocolTreasury }),
    ),
    rpcCall("WETH canary token code", () =>
      client.getCode({ address: getAddress(plan.launches.weth.token) }),
    ),
    rpcCall("USDG canary token code", () =>
      client.getCode({ address: getAddress(plan.launches.usdg.token) }),
    ),
  ]);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${EXPECTED_CHAIN_ID}, received ${chainId}`);
  }
  if (
    !headBlock.hash ||
    headBlock.number == null ||
    BigInt(plan.simulatedAtBlock) > headBlock.number
  ) {
    throw new Error("Canary simulation block is not available on the current chain");
  }
  if (
    !deploymentVerificationBlock.hash ||
    deploymentVerificationBlock.hash.toLowerCase() !==
      deploymentVerification.checkedAtBlockHash ||
    !launchpadCodeAtVerification ||
    launchpadCodeAtVerification === "0x" ||
    keccak256(launchpadCodeAtVerification) !==
      deploymentVerification.launchpadCodeHash
  ) {
    throw new Error(
      "Deployment verification evidence no longer matches Robinhood Chain",
    );
  }
  if (
    !launchpadCode ||
    launchpadCode === "0x" ||
    keccak256(launchpadCode) !== deploymentVerification.launchpadCodeHash ||
    !safeCode ||
    safeCode === "0x"
  ) {
    throw new Error(
      "Deployment-verified launchpad or protocol Safe is not current",
    );
  }
  if (
    (wethTokenCode && wethTokenCode !== "0x") ||
    (usdgTokenCode && usdgTokenCode !== "0x")
  ) {
    throw new Error(
      "A reviewed canary token already exists; approve a fresh pre-broadcast simulation",
    );
  }

  const planJson = `${JSON.stringify(plan, null, 2)}\n`;
  await writeFile(destinationPath, planJson, { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        kind: "zappad-reviewed-canary-plan-created",
        plan: destinationPath,
        reviewedPlanHash: hashReviewedCanaryPlan(planJson),
        sourceSimulationHash: plan.sourceSimulationHash,
        deploymentVerificationEvidenceHash:
          plan.deploymentVerification.evidenceHash,
        releaseCommit: plan.releaseCommit,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const raw = error instanceof Error ? error.message : String(error);
  const message = rpcUrl ? raw.split(rpcUrl).join("[redacted RPC]") : raw;
  console.error(message);
  process.exitCode = 1;
});
