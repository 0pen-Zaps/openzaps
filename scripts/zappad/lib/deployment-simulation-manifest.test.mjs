import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import {
  DEPLOYMENT_SIMULATION_CONSTANTS,
  validateReviewedDeploymentSimulationManifest,
} from "./deployment-simulation-manifest.mjs";

const RELEASE_COMMIT = "a".repeat(40);

function rawManifest(overrides = {}, suffix = "\n") {
  return Buffer.from(
    `${JSON.stringify({
      ...DEPLOYMENT_SIMULATION_CONSTANTS,
      releaseCommit: RELEASE_COMMIT,
      ...overrides,
    })}${suffix}`,
  );
}

function validate(raw, expectedHash = keccak256(raw)) {
  return validateReviewedDeploymentSimulationManifest(raw, {
    expectedHash,
    expectedReleaseCommit: RELEASE_COMMIT,
  });
}

describe("reviewed ZapPad deployment simulation manifest", () => {
  it("accepts the exact independently approved raw bytes", () => {
    const raw = rawManifest();
    expect(validate(raw)).toEqual({
      manifest: JSON.parse(raw.toString("utf8")),
      approvedHash: keccak256(raw),
    });
  });

  it("rejects missing, zero, wrong, or byte-drifted approval hashes", () => {
    const raw = rawManifest();
    expect(() =>
      validateReviewedDeploymentSimulationManifest(raw, {
        expectedHash: undefined,
        expectedReleaseCommit: RELEASE_COMMIT,
      }),
    ).toThrow("EXPECTED_DEPLOYMENT_SIMULATION_MANIFEST_HASH");
    expect(() => validate(raw, `0x${"00".repeat(32)}`)).toThrow(
      "non-zero hash",
    );
    expect(() => validate(raw, `0x${"11".repeat(32)}`)).toThrow(
      "raw bytes do not match",
    );

    const approvedWithoutNewline = rawManifest({}, "");
    expect(() => validate(raw, keccak256(approvedWithoutNewline))).toThrow(
      "raw bytes do not match",
    );
  });

  it("checks the raw approval before attempting to parse JSON", () => {
    const invalidJson = Buffer.from("{");
    expect(() => validate(invalidJson, `0x${"22".repeat(32)}`)).toThrow(
      "raw bytes do not match",
    );
  });

  it.each([
    ["kind", { kind: "different-stack" }],
    ["schema", { schemaVersion: 2 }],
    ["chain", { chainId: 1 }],
    ["status", { status: "broadcast" }],
  ])("rejects independently rehashed %s drift", (_label, overrides) => {
    const raw = rawManifest(overrides);
    expect(() => validate(raw)).toThrow(
      "identity, schema, chain, or status mismatch",
    );
  });

  it("rejects an independently rehashed release-commit change", () => {
    const raw = rawManifest({ releaseCommit: "b".repeat(40) });
    expect(() => validate(raw)).toThrow(
      "release commit does not match its approval",
    );
  });
});
