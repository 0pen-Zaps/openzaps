import { isHash, keccak256 } from "viem";

export const DEPLOYMENT_SIMULATION_CONSTANTS = Object.freeze({
  kind: "zappad-stack-deployment-simulation",
  schemaVersion: 1,
  chainId: 4663,
  status: "simulation-only",
});

const ZERO_HASH = `0x${"00".repeat(32)}`;

export function validateReviewedDeploymentSimulationManifest(
  rawManifest,
  { expectedHash, expectedReleaseCommit },
) {
  if (!(rawManifest instanceof Uint8Array) || rawManifest.byteLength === 0) {
    throw new Error("Deployment simulation manifest raw bytes are missing");
  }
  if (!isHash(expectedHash) || expectedHash.toLowerCase() === ZERO_HASH) {
    throw new Error(
      "EXPECTED_DEPLOYMENT_SIMULATION_MANIFEST_HASH must be a non-zero hash",
    );
  }
  if (
    typeof expectedReleaseCommit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(expectedReleaseCommit)
  ) {
    throw new Error("EXPECTED_RELEASE_COMMIT must be a full Git commit");
  }

  const approvedHash = expectedHash.toLowerCase();
  const actualHash = keccak256(rawManifest);
  if (actualHash !== approvedHash) {
    throw new Error(
      "Deployment simulation manifest raw bytes do not match the approved hash",
    );
  }

  let rawJson;
  try {
    rawJson = new TextDecoder("utf-8", { fatal: true }).decode(rawManifest);
  } catch {
    throw new Error("Deployment simulation manifest is not valid UTF-8");
  }

  let manifest;
  try {
    manifest = JSON.parse(rawJson);
  } catch {
    throw new Error("Deployment simulation manifest is not valid JSON");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.kind !== DEPLOYMENT_SIMULATION_CONSTANTS.kind ||
    manifest.schemaVersion !== DEPLOYMENT_SIMULATION_CONSTANTS.schemaVersion ||
    manifest.chainId !== DEPLOYMENT_SIMULATION_CONSTANTS.chainId ||
    manifest.status !== DEPLOYMENT_SIMULATION_CONSTANTS.status
  ) {
    throw new Error(
      "Deployment simulation manifest identity, schema, chain, or status mismatch",
    );
  }
  if (manifest.releaseCommit !== expectedReleaseCommit) {
    throw new Error(
      "Deployment simulation manifest release commit does not match its approval",
    );
  }

  return { manifest, approvedHash };
}
