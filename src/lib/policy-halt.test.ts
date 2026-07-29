import { describe, expect, it } from "vitest";

import {
  POLICY_HALT_CONFIRMATION,
  isHaltCapableLineage,
  matchesPolicyHaltCreation,
  policyHaltStatus,
  type CapsuleLineageId,
} from "@/lib/policy-halt";
import { openZapPolicyHaltAbi } from "@/lib/robinhood";

const ZAP = "0x1111111111111111111111111111111111111111" as const;
const OWNER = "0x2222222222222222222222222222222222222222" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const POLICY = `0x${"ab".repeat(32)}` as const;

describe("policy halt capability", () => {
  it("admits only v1.2 and v3.2", () => {
    const lineages: CapsuleLineageId[] = ["v1.1", "v1.2", "v3", "v3.1", "v3.2"];
    expect(lineages.filter(isHaltCapableLineage)).toEqual([
      "v1.2",
      "v3.2",
    ]);
  });

  it("never projects a selector result onto an unsupported lineage", () => {
    expect(policyHaltStatus("v1.1", null)).toBe("unsupported");
    expect(policyHaltStatus("v3", null)).toBe("unsupported");
    expect(policyHaltStatus("v3.1", null)).toBe("unsupported");
    expect(() => policyHaltStatus("v3.1", false)).toThrow(/does not expose/);
  });

  it("distinguishes active, permanently halted, and unavailable pinned reads", () => {
    expect(policyHaltStatus("v1.2", false)).toBe("active");
    expect(policyHaltStatus("v3.2", true)).toBe("halted");
    expect(policyHaltStatus("v3.2", null)).toBe("unavailable");
  });

  it("keeps the typed confirmation and shared v1.2/v3.2 ABI exact", () => {
    expect(POLICY_HALT_CONFIRMATION).toBe("HALT");
    expect(
      openZapPolicyHaltAbi
        .filter((item) => item.type === "function")
        .map((item) => item.name),
    ).toEqual(["FACTORY", "owner", "policyHash", "policyHalted", "haltPolicy"]);
    const event = openZapPolicyHaltAbi.find((item) => item.type === "event");
    expect(event).toMatchObject({
      name: "PolicyHalted",
      inputs: [
        { name: "owner", type: "address", indexed: true },
        { name: "policyHash", type: "bytes32", indexed: true },
      ],
    });
  });
});

describe("PolicyHalted provenance", () => {
  const creation = { zap: ZAP, owner: OWNER, policyHash: POLICY };

  it("requires the exact canonical emitter, owner, and policy hash", () => {
    expect(matchesPolicyHaltCreation(
      { emitter: ZAP, owner: OWNER, policyHash: POLICY },
      creation,
    )).toBe(true);
    expect(matchesPolicyHaltCreation(
      { emitter: OTHER, owner: OWNER, policyHash: POLICY },
      creation,
    )).toBe(false);
    expect(matchesPolicyHaltCreation(
      { emitter: ZAP, owner: OTHER, policyHash: POLICY },
      creation,
    )).toBe(false);
    expect(matchesPolicyHaltCreation(
      { emitter: ZAP, owner: OWNER, policyHash: `0x${"cd".repeat(32)}` },
      creation,
    )).toBe(false);
  });
});
