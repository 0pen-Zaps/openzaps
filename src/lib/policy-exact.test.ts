import { describe, expect, it } from "vitest";
import { getAddress, keccak256, type Address, type Hex } from "viem";

import { hashOpenZapPolicy } from "../../packages/sdk/index.js";
import {
  PolicyInputError,
  compileExactPolicy,
  type PolicyChainReader,
} from "@/lib/policy-exact";
import { EXACT_POLICY_QUICKSTART_BODY } from "@/lib/policy-exact-example";
import { OPENZAP_CONTRACTS, ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";

const OWNER = getAddress("0x1000000000000000000000000000000000000001");
const REGISTRY = getAddress("0x2000000000000000000000000000000000000002");
const TOKENS = getAddress("0x3000000000000000000000000000000000000003");
const PREDICTED = getAddress("0x4000000000000000000000000000000000000004");
const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;
const FACTORY_CODE = "0x6001600055" as Hex;
const ADAPTER_CODE = "0x6002600055" as Hex;
const IMPLEMENTATION_CODE = "0x6003600055" as Hex;

describe("compileExactPolicy", () => {
  it("pins every live read, compiles the Solidity hash, and only eth_calls creation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient(calls);
    const artifact = await compileExactPolicy(client, {
      ...EXACT_POLICY_QUICKSTART_BODY,
      owner: OWNER,
    });

    expect(artifact.mode).toBe("chain-exact");
    expect(artifact.chain).toMatchObject({
      chainId: ROBINHOOD_CHAIN_ID,
      blockNumber: "123",
      blockHash: BLOCK_HASH,
      rpcStatus: "verified",
    });
    expect(artifact.allowlists.adapterAllowed).toBe(true);
    expect(artifact.runtimeCode.adapters[0]).toMatchObject({
      allowedAtBlock: true,
      codeHash: keccak256(ADAPTER_CODE),
    });
    expect(artifact.runtimeCode.implementation).toMatchObject({
      codeHash: keccak256(IMPLEMENTATION_CODE),
      matchesFactoryCommitment: true,
    });
    expect(artifact.compiled.policyHash).toBe(hashOpenZapPolicy(artifact.compiled.policy));
    expect(artifact.compiled.predictedZap).toBe(PREDICTED);
    expect(artifact.compiled.unsignedEip712).toMatchObject({
      domain: {
        name: "OpenZap",
        version: "1",
        chainId: ROBINHOOD_CHAIN_ID,
        verifyingContract: PREDICTED,
      },
      primaryType: "OpenZapIntent",
      message: {
        policyHash: artifact.compiled.policyHash,
        minOut: 985n,
      },
    });
    expect(artifact.ethCall).toMatchObject({
      method: "eth_call",
      function: "createZap",
      result: PREDICTED,
      broadcast: false,
    });
    expect(artifact.authority).toEqual({
      signed: false,
      broadcast: false,
      discoveryCredentialsAreAuthority: false,
      note: expect.stringContaining("owner's EIP-712 signature"),
    });
    expect(artifact.stressCases).toHaveLength(3);

    for (const call of calls) {
      if ("blockNumber" in call) expect(call.blockNumber).toBe(123n);
    }
    expect(calls.some((call) => call.functionName === "createZap")).toBe(true);
    expect(calls.some((call) => call.method === "sendTransaction")).toBe(false);
    expect(calls.some((call) => call.method === "signTypedData")).toBe(false);
  });

  it("keeps a nonessential stress quote failure explicit instead of inventing output", async () => {
    const requested = 10_000_000_000_000_000n;
    const client = fakeClient([], requested * 2n);
    const artifact = await compileExactPolicy(client, {
      routeId: "robinhood-v4-weth-zaps",
      owner: OWNER,
      amount: "0.01",
    });

    expect(artifact.status).toBe("warn");
    expect(artifact.stressCases.find((entry) => entry.id === "double-input")).toMatchObject({
      status: "rpc-failure",
      rpcFailure: true,
      blockNumber: "123",
      error: "test RPC unavailable",
    });
  });

  it("labels a required RPC failure with its exact stage", async () => {
    const client = {
      ...fakeClient([]),
      getBlockNumber: async () => {
        throw new Error("offline");
      },
    };

    await expect(
      compileExactPolicy(client, {
        routeId: "robinhood-v4-weth-zaps",
        owner: OWNER,
        amount: "0.01",
      }),
    ).rejects.toMatchObject({
      code: "RPC_FAILURE",
      stage: "capture-head",
      detail: "offline",
    });
  });

  it("rejects malformed input before making a chain claim", async () => {
    await expect(
      compileExactPolicy(fakeClient([]), {
        routeId: "robinhood-v4-weth-zaps",
        owner: "not-an-address",
        amount: "0.01",
      }),
    ).rejects.toBeInstanceOf(PolicyInputError);
  });

  it.each([
    ["nonce", ((1n << 256n)).toString()],
    ["maxRelayerFee", ((1n << 256n)).toString()],
    ["validAfter", ((1n << 64n)).toString()],
    ["deadline", ((1n << 64n)).toString()],
  ] as const)("rejects %s overflow before any chain read", async (field, value) => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(
      compileExactPolicy(fakeClient(calls), {
        routeId: "robinhood-v4-weth-zaps",
        owner: OWNER,
        amount: "0.01",
        [field]: value,
        ...(field === "maxRelayerFee" ? { relayer: OWNER } : {}),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_POLICY_INPUT",
      message: `${field} exceeds its Solidity integer width.`,
    });
    expect(calls).toEqual([]);
  });

  it("fails closed when a required vault is unseeded at the pinned block", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(
      compileExactPolicy(fakeClient(calls, undefined, 0n), {
        routeId: "robinhood-zap-vault-deposit",
        owner: OWNER,
        amount: "1",
      }),
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      evidence: {
        routeId: "robinhood-zap-vault-deposit",
        totalSupply: "0",
        blockNumber: "123",
      },
    });
    expect(calls).toContainEqual(expect.objectContaining({
      functionName: "totalSupply",
      blockNumber: 123n,
    }));
  });

  it("reports seeded-vault evidence from the same pinned block as the quote", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const artifact = await compileExactPolicy(fakeClient(calls, undefined, 5_000n), {
      routeId: "robinhood-zap-vault-redeem",
      owner: OWNER,
      amount: "1",
    });

    expect(artifact.vaultReadiness).toMatchObject({
      totalSupply: "5000",
      seeded: true,
      blockNumber: "123",
    });
    for (const call of calls.filter((entry) =>
      entry.functionName === "totalSupply" || entry.functionName === "previewRedeem"
    )) {
      expect(call.blockNumber).toBe(123n);
    }
  });
});

function fakeClient(
  calls: Array<Record<string, unknown>>,
  failQuoteAmount?: bigint,
  vaultSupply: bigint = 1n,
): PolicyChainReader {
  return {
    async getBlockNumber() {
      return 123n;
    },
    async getBlock(args) {
      calls.push(args);
      return { hash: BLOCK_HASH, number: 123n, timestamp: 1_900_000_000n };
    },
    async getCode(args) {
      calls.push(args);
      if (same(args.address, OPENZAP_CONTRACTS.factory)) return FACTORY_CODE;
      if (same(args.address, OPENZAP_CONTRACTS.implementation)) return IMPLEMENTATION_CODE;
      return ADAPTER_CODE;
    },
    async readContract(args) {
      calls.push(args);
      switch (args.functionName) {
        case "adapters":
          return REGISTRY;
        case "tokens":
          return TOKENS;
        case "implementation":
          return OPENZAP_CONTRACTS.implementation;
        case "implCodeHash":
          return keccak256(IMPLEMENTATION_CODE);
        case "isAllowed":
          return true;
        case "totalSupply":
          return vaultSupply;
        case "previewDeposit":
        case "previewRedeem":
          return 1_000n;
        case "predict":
          return PREDICTED;
        default:
          throw new Error(`Unexpected read ${String(args.functionName)}`);
      }
    },
    async simulateContract(args) {
      calls.push(args);
      if (args.functionName === "createZap") return { result: PREDICTED };
      if (args.functionName === "quoteExactInputSingle") {
        const tuple = args.args as Array<{ exactAmount: bigint }>;
        if (tuple[0]?.exactAmount === failQuoteAmount) throw new Error("test RPC unavailable");
        return { result: [1_000n, 123n] };
      }
      throw new Error(`Unexpected simulation ${String(args.functionName)}`);
    },
  };
}

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
