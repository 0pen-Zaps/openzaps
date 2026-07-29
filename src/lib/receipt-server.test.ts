import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, type Hex, type PublicClient } from "viem";

import {
  ReceiptVerificationError,
  decodeExecutionInput,
  encodeRelayExecution,
  executionReceiptAbi,
  latestReceiptForIntent,
  parseReceiptRequest,
  storeExecutionReceipt,
  verifyCapsuleProvenance,
  verifyExecutionReceipt,
  type ExecutionReceiptRecord,
  type RelayReceiptBinding,
} from "@/lib/receipt-server";
import { expectedCloneRuntime } from "@/lib/openzap";
import { OPENZAP_V3_CONTRACTS } from "@/lib/robinhood";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033";
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("receipt request and calldata verification", () => {
  it("accepts only a transaction hash plus relay UUID", () => {
    const parsed = parseReceiptRequest({ txHash: `0x${"AB".repeat(32)}`, relayIntentId: ID });
    expect(parsed.txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(() => parseReceiptRequest({ txHash: "0x12", relayIntentId: ID })).toThrow(ReceiptVerificationError);
    expect(() => parseReceiptRequest({ txHash: `0x${"ab".repeat(32)}`, relayIntentId: "nope" })).toThrow(
      ReceiptVerificationError,
    );
  });

  it("derives kind, nonce, zap, and executor pin from signed calldata", () => {
    const data = encodeFunctionData({
      abi: executionReceiptAbi,
      functionName: "executeTrigger",
      args: [
        {
          zap: ZAP,
          chainId: 4663n,
          nonce: 7n,
          validAfter: 0n,
          deadline: 2_000n,
          priceSource: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          baselinePriceX96: 1n << 96n,
          thresholdBps: 1_000,
          above: true,
          recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          executor: "0x0000000000000000000000000000000000000000",
          maxGas: 3_000_000n,
          maxFeePerGas: 10_000_000_000n,
          policyHash: `0x${"34".repeat(32)}`,
          outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
          minOut: 0n,
        },
        `0x${"ab".repeat(65)}`,
      ],
    });
    expect(decodeExecutionInput(data)).toMatchObject({
      kind: "trigger",
      nonce: 7n,
      zap: ZAP,
      signedExecutor: "0x0000000000000000000000000000000000000000",
    });
    expect(() => decodeExecutionInput("0x12345678" as Hex)).toThrow("not a supported OpenZaps execution");
  });

  it("cannot attribute calldata from a different same-nonce signature to a relay row", async () => {
    const intent = {
      zap: ZAP,
      chainId: "4663",
      nonce: "7",
      validAfter: "0",
      deadline: "2000",
      priceSource: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      baselinePriceX96: (1n << 96n).toString(),
      thresholdBps: "1000",
      above: true,
      recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      executor: "0x0000000000000000000000000000000000000000",
      maxGas: "3000000",
      maxFeePerGas: "10000000000",
      policyHash: `0x${"34".repeat(32)}`,
      outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
      minOut: "0",
    };
    const stored: RelayReceiptBinding = {
      id: ID,
      zap: ZAP,
      owner: OWNER,
      kind: "trigger",
      nonce: "7",
      executor: "0x0000000000000000000000000000000000000000",
      intent,
      signature: `0x${"ab".repeat(65)}`,
    };
    // Same zap/kind/nonce/executor, but a different signature. The old field-only binding accepted it.
    const differentArtifact = encodeRelayExecution({ ...stored, signature: `0x${"cd".repeat(65)}` });
    const client = {
      getTransaction: async () => ({
        to: ZAP,
        from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        input: differentArtifact,
      }),
      getTransactionReceipt: async () => ({
        blockNumber: 10n,
        status: "reverted",
      }),
    } as unknown as PublicClient;

    await expect(
      verifyExecutionReceipt(client, 4663, `0x${"12".repeat(32)}`, stored, 1),
    ).rejects.toThrow("does not byte-for-byte match");
  });

  it("requires the canonical factory log and exact clone runtime, rejecting a lookalike", async () => {
    const binding = triggerBinding();
    const implementationRuntime = "0x6001600055" as Hex;
    const client = provenanceClient(binding, implementationRuntime);
    const proven = await verifyCapsuleProvenance(client, provenanceClaim(binding), 100n);
    expect(proven).toMatchObject({
      verified: true,
      lineage: "v3",
      factory: OPENZAP_V3_CONTRACTS.factory.toLowerCase(),
      implementation: OPENZAP_V3_CONTRACTS.implementation.toLowerCase(),
      implementationCodeHash: keccak256(implementationRuntime),
      creationBlock: "90",
    });

    const lookalike = provenanceClient(binding, implementationRuntime, {
      capsuleRuntime: expectedCloneRuntime(OPENZAP_V3_CONTRACTS.implementation),
      creationLogs: [],
    });
    await expect(verifyCapsuleProvenance(lookalike, provenanceClaim(binding), 100n)).rejects.toThrow(
      "no matching ZapCreated provenance",
    );
  });

  it("pins receipt evidence to the same captured block as guardian chain reads", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(latestReceiptForIntent(ID, 123n)).resolves.toBeNull();
      expect(seenUrls[0]).toContain("block_number=lte.123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to finalize receipt evidence from a different block hash at the same height", async () => {
    const binding = triggerBinding();
    const implementationRuntime = "0x6001600055" as Hex;
    const provenance = provenanceClient(binding, implementationRuntime) as unknown as Record<string, unknown>;
    const receiptBlockHash = `0x${"45".repeat(32)}` as Hex;
    const client = {
      ...provenance,
      getTransaction: async () => ({
        to: binding.zap,
        from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        input: encodeRelayExecution(binding),
      }),
      getTransactionReceipt: async () => ({
        blockNumber: 100n,
        blockHash: receiptBlockHash,
        status: "reverted",
        logs: [],
        transactionIndex: 0,
        gasUsed: 123n,
        effectiveGasPrice: 2n,
      }),
      getBlockNumber: async () => 112n,
      getBlock: async () => ({
        hash: `0x${"67".repeat(32)}`,
        timestamp: 1_785_000_000n,
      }),
    } as unknown as PublicClient;

    await expect(
      verifyExecutionReceipt(client, 4663, `0x${"12".repeat(32)}`, binding, 12),
    ).rejects.toMatchObject({
      code: "not-final",
      message: expect.stringContaining("not canonical"),
    });
  });
});

describe("receipt storage immutability", () => {
  it("replays by ignoring the conflict and returning the unchanged stored evidence", async () => {
    const stored = receiptRow({ confirmations: 12 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("[]", { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([stored]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await storeExecutionReceipt(executionReceipt(40));
      expect(result.confirmations).toBe(12);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [, insertInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(insertInit.headers).toMatchObject({
        prefer: "return=representation,resolution=ignore-duplicates",
      });
      expect(insertInit.headers).not.toMatchObject({
        prefer: expect.stringContaining("merge-duplicates"),
      });
      expect(fetchMock.mock.calls[1]?.[0]).toContain("chain_id=eq.4663");
      expect(fetchMock.mock.calls[1]?.[0]).toContain(`tx_hash=eq.${RECEIPT_TX}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a conflicting row instead of treating the unique key as proof", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("[]", { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        receiptRow({ executor: "0x0000000000000000000000000000000000000001" }),
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(storeExecutionReceipt(executionReceipt(40))).rejects.toMatchObject({
        code: "mismatch",
        message: "Stored receipt conflicts on immutable field executor.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const RECEIPT_TX = `0x${"12".repeat(32)}` as Hex;

function executionReceipt(confirmations: number): ExecutionReceiptRecord {
  return {
    receiptVersion: 1,
    chainId: 4663,
    txHash: RECEIPT_TX,
    relayIntentId: ID,
    zap: ZAP,
    executor: OWNER,
    intentKind: "trigger",
    intentNonce: "7",
    outcome: "reverted",
    blockNumber: "100",
    blockHash: `0x${"45".repeat(32)}`,
    blockTime: "2026-07-28T12:00:00.000Z",
    transactionIndex: 0,
    logIndex: null,
    gasUsed: "123",
    effectiveGasPrice: "2",
    confirmations,
    eventName: null,
    eventPayload: {},
    provenance: {
      verified: true,
      lineage: "v3",
      factory: OPENZAP_V3_CONTRACTS.factory,
      implementation: OPENZAP_V3_CONTRACTS.implementation,
      implementationCodeHash: `0x${"34".repeat(32)}`,
      capsuleRuntimeHash: `0x${"56".repeat(32)}`,
      creationTxHash: `0x${"78".repeat(32)}`,
      creationBlock: "90",
    },
    authorityScope: "none",
  };
}

function receiptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const receipt = executionReceipt(12);
  return {
    id: "123e4567-e89b-42d3-a456-426614174001",
    receipt_version: receipt.receiptVersion,
    chain_id: receipt.chainId,
    tx_hash: receipt.txHash,
    relay_intent_id: receipt.relayIntentId,
    zap: receipt.zap,
    executor: receipt.executor,
    intent_kind: receipt.intentKind,
    intent_nonce: receipt.intentNonce,
    outcome: receipt.outcome,
    block_number: receipt.blockNumber,
    block_hash: receipt.blockHash,
    block_time: "2026-07-28 12:00:00+00",
    transaction_index: receipt.transactionIndex,
    log_index: receipt.logIndex,
    gas_used: receipt.gasUsed,
    effective_gas_price: receipt.effectiveGasPrice,
    confirmations: receipt.confirmations,
    event_name: receipt.eventName,
    event_payload: receipt.eventPayload,
    provenance_verified: true,
    factory: receipt.provenance?.factory,
    implementation: receipt.provenance?.implementation,
    implementation_code_hash: receipt.provenance?.implementationCodeHash,
    capsule_runtime_hash: receipt.provenance?.capsuleRuntimeHash,
    creation_tx_hash: receipt.provenance?.creationTxHash,
    creation_block: receipt.provenance?.creationBlock,
    recorded_at: "2026-07-28 12:01:00+00",
    authority_scope: receipt.authorityScope,
    ...overrides,
  };
}

function triggerBinding(): RelayReceiptBinding {
  return {
    id: ID,
    zap: ZAP,
    owner: OWNER,
    kind: "trigger",
    nonce: "7",
    executor: "0x0000000000000000000000000000000000000000",
    intent: {
      zap: ZAP,
      chainId: "4663",
      nonce: "7",
      validAfter: "0",
      deadline: "2000",
      priceSource: OWNER,
      baselinePriceX96: (1n << 96n).toString(),
      thresholdBps: "1000",
      above: true,
      recipient: OWNER,
      executor: "0x0000000000000000000000000000000000000000",
      maxGas: "3000000",
      maxFeePerGas: "10000000000",
      policyHash: `0x${"34".repeat(32)}`,
      outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
      minOut: "0",
    },
    signature: `0x${"ab".repeat(65)}`,
  };
}

function provenanceClaim(binding: RelayReceiptBinding) {
  return {
    zap: binding.zap,
    owner: binding.owner,
    kind: binding.kind,
    policyHash: binding.intent.policyHash as Hex,
  };
}

function provenanceClient(
  binding: RelayReceiptBinding,
  implementationRuntime: Hex,
  overrides: {
    capsuleRuntime?: Hex;
    creationLogs?: unknown[];
  } = {},
): PublicClient {
  const implementationHash = keccak256(implementationRuntime);
  return {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      if (address.toLowerCase() === OPENZAP_V3_CONTRACTS.factory.toLowerCase()) {
        if (functionName === "implementation") return OPENZAP_V3_CONTRACTS.implementation;
        if (functionName === "implCodeHash") return implementationHash;
      }
      if (address.toLowerCase() === binding.zap.toLowerCase()) {
        if (functionName === "FACTORY") return OPENZAP_V3_CONTRACTS.factory;
        if (functionName === "policyHash") return binding.intent.policyHash;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getBytecode: async ({ address }: { address: string }) => {
      if (address.toLowerCase() === OPENZAP_V3_CONTRACTS.factory.toLowerCase()) return "0x60006000" as Hex;
      if (address.toLowerCase() === OPENZAP_V3_CONTRACTS.implementation.toLowerCase()) return implementationRuntime;
      if (address.toLowerCase() === binding.zap.toLowerCase()) {
        return overrides.capsuleRuntime ?? expectedCloneRuntime(OPENZAP_V3_CONTRACTS.implementation);
      }
      return undefined;
    },
    getLogs: async () =>
      (overrides.creationLogs ?? [{
        address: OPENZAP_V3_CONTRACTS.factory,
        args: {
          zap: binding.zap,
          owner: binding.owner,
          policyHash: binding.intent.policyHash,
          implCodeHash: implementationHash,
          salt: `0x${"56".repeat(32)}`,
        },
        transactionHash: `0x${"78".repeat(32)}`,
        blockNumber: 90n,
        logIndex: 0,
      }]),
  } as unknown as PublicClient;
}
