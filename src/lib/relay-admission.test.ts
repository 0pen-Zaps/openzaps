import { describe, expect, it } from "vitest";
import { keccak256, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildRecurringTypedData, serializeIntentFile } from "@/lib/executions";
import { expectedCloneRuntime } from "@/lib/openzap";
import { RelayAdmissionError, verifyRelaySubmissionAdmission } from "@/lib/relay-admission";
import { parseRelaySubmission } from "@/lib/relay";
import { OPENZAP_V3_CONTRACTS } from "@/lib/robinhood";

const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033";
const POLICY_HASH = `0x${"34".repeat(32)}` as Hex;

describe("relay capsule admission", () => {
  it("rejects an owner-signed ABI lookalike even when it copies the canonical clone runtime", async () => {
    const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const intent = {
      zap: ZAP,
      chainId: 4663n,
      seriesId: 7n,
      validAfter: 0n,
      deadline: 2_000_000_000n,
      interval: 3_600n,
      maxRuns: 10,
      recipient: owner.address,
      executor: "0x0000000000000000000000000000000000000000",
      maxGas: 3_000_000n,
      maxFeePerGas: 10_000_000_000n,
      policyHash: POLICY_HASH,
      outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
      minOutPerRun: 0n,
    } as const;
    const signature = await owner.signTypedData(buildRecurringTypedData(intent));
    const submission = parseRelaySubmission(
      JSON.parse(serializeIntentFile("recurring", intent, signature)),
    );
    const implementationRuntime = "0x6001600055" as Hex;
    const implementationHash = keccak256(implementationRuntime);
    const client = {
      getBlockNumber: async () => 100n,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === OPENZAP_V3_CONTRACTS.factory.toLowerCase()) {
          if (functionName === "implementation") return OPENZAP_V3_CONTRACTS.implementation;
          if (functionName === "implCodeHash") return implementationHash;
        }
        if (address.toLowerCase() === ZAP.toLowerCase()) {
          if (functionName === "owner") return owner.address;
          if (functionName === "policyHash") return POLICY_HASH;
          if (functionName === "FACTORY") return OPENZAP_V3_CONTRACTS.factory;
        }
        throw new Error(`unexpected read ${functionName}`);
      },
      getBytecode: async ({ address }: { address: string }) => {
        if (address.toLowerCase() === OPENZAP_V3_CONTRACTS.factory.toLowerCase()) return "0x60006000" as Hex;
        if (address.toLowerCase() === OPENZAP_V3_CONTRACTS.implementation.toLowerCase()) return implementationRuntime;
        if (address.toLowerCase() === ZAP.toLowerCase()) {
          // An attacker can deploy this exact proxy bytecode themselves. The
          // canonical factory event is what distinguishes provenance.
          return expectedCloneRuntime(OPENZAP_V3_CONTRACTS.implementation);
        }
        return undefined;
      },
      getLogs: async () => [],
    } as unknown as PublicClient;

    await expect(verifyRelaySubmissionAdmission(client, submission)).rejects.toMatchObject({
      name: RelayAdmissionError.name,
      status: 422,
    });
    await expect(verifyRelaySubmissionAdmission(client, submission)).rejects.toThrow(
      "no matching ZapCreated provenance",
    );
  });
});
