import {
  encodeAbiParameters,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import {
  buildOpenZapPolicy,
  buildUnsignedOpenZapIntent,
  hashOpenZapPolicy,
  type OpenZapPolicy,
} from "../../packages/sdk/index.js";
import { encodeStepData, MAX_EXECUTION_FEE_PER_GAS, MAX_EXECUTION_GAS, MAX_ROUTER_AMOUNT } from "@/lib/openzap";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_LIQUIDITY,
  openZapFactoryAbi,
  rangeVaultAbi,
  v4QuoterAbi,
  zapVaultAbi,
} from "@/lib/robinhood";
import { resolveRouteById, type Route } from "@/lib/routes";

const BPS = 10_000n;
const MAX_SLIPPAGE_BPS = 5_000;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

const factoryRegistryAbi = [
  {
    type: "function",
    name: "adapters",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokens",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "implementation",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "implCodeHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
] as const;

const allowlistAbi = [
  {
    type: "function",
    name: "isAllowed",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

export interface ExactPolicyRequest {
  routeId: string;
  owner: string;
  recipient?: string;
  amount: string;
  slippageBps?: number;
  salt?: string;
  nonce?: string;
  validAfter?: string;
  deadline?: string;
  relayer?: string;
  maxRelayerFee?: string;
  maxGas?: string;
  maxFeePerGas?: string;
}

/**
 * Narrow structural client boundary. Keeping it smaller than viem's full
 * `PublicClient` makes the compiler independently testable without an RPC.
 */
export interface PolicyChainReader {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null; number: bigint; timestamp: bigint }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
  simulateContract(args: Record<string, unknown>): Promise<{ result: unknown }>;
}

export class PolicyInputError extends Error {
  readonly code = "INVALID_POLICY_INPUT";
}

export class PolicyBlockedError extends Error {
  readonly code = "POLICY_BLOCKED";
  constructor(message: string, readonly evidence?: Record<string, unknown>) {
    super(message);
  }
}

export class PolicyRpcError extends Error {
  readonly code = "RPC_FAILURE";
  constructor(
    message: string,
    readonly stage: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface ExactPolicyArtifact {
  status: "pass" | "warn";
  mode: "chain-exact";
  chain: {
    chainId: number;
    blockNumber: string;
    blockHash: Hex;
    blockTimestamp: string;
    rpcStatus: "verified";
  };
  route: {
    id: string;
    adapter: Address;
    tokenIn: { address: Address; symbol: string; decimals: number };
    tokenOut: { address: Address; symbol: string; decimals: number };
  };
  allowlists: {
    adapterRegistry: Address;
    tokenAllowlist: Address;
    adapterAllowed: true;
    tokens: Array<{ address: Address; allowed: true }>;
  };
  runtimeCode: {
    factory: { address: Address; codeHash: Hex };
    implementation: { address: Address; codeHash: Hex; matchesFactoryCommitment: true };
    adapters: Array<{ address: Address; codeHash: Hex; allowedAtBlock: true }>;
  };
  quote: {
    source: Route["quote"]["source"];
    amountIn: string;
    amountOut: string;
    minOut: string;
    display: string;
    gasEstimate: string | null;
    blockNumber: string;
  };
  vaultReadiness: {
    vault: Address;
    totalSupply: string;
    seeded: true;
    blockNumber: string;
  } | null;
  compiled: {
    policy: OpenZapPolicy;
    policyHash: Hex;
    salt: Hex;
    predictedZap: Address;
    unsignedEip712: ReturnType<typeof buildUnsignedOpenZapIntent>;
  };
  ethCall: {
    status: "pass";
    method: "eth_call";
    target: Address;
    function: "createZap";
    result: Address;
    blockNumber: string;
    broadcast: false;
    note: string;
  };
  stressCases: StressCase[];
  authority: {
    signed: false;
    broadcast: false;
    discoveryCredentialsAreAuthority: false;
    note: string;
  };
}

export type StressCase =
  | {
      id: string;
      derivedFrom: string;
      status: "quoted";
      rpcFailure: false;
      amountIn: string;
      amountOut: string;
      minOut: string;
      blockNumber: string;
    }
  | {
      id: string;
      derivedFrom: string;
      status: "rpc-failure";
      rpcFailure: true;
      amountIn: string;
      blockNumber: string;
      error: string;
    };

/**
 * Compile and simulate against one canonical block. Every state-dependent
 * statement in the returned artifact is read at `head`; a hash re-read rejects
 * a same-height reorg rather than mixing two states.
 */
export async function compileExactPolicy(
  client: PolicyChainReader,
  request: ExactPolicyRequest,
): Promise<ExactPolicyArtifact> {
  const parsed = parseRequest(request);
  const route = resolveRouteById(parsed.routeId);
  if (!route) throw new PolicyInputError(`Route ${parsed.routeId} is not deployed in the current route manifest.`);

  const amountIn = parseExactAmount(parsed.amount, route.tokenIn.decimals);
  const head = await rpc("capture-head", () => client.getBlockNumber({ cacheTime: 0 }));
  const blockBefore = await rpc("read-head", () => client.getBlock({ blockNumber: head }));
  if (!blockBefore.hash) throw new PolicyRpcError("RPC head block has no canonical hash.", "read-head", "Missing block hash.");

  const owner = getAddress(parsed.owner);
  const recipient = getAddress(parsed.recipient ?? parsed.owner);
  const factory = OPENZAP_CONTRACTS.factory;

  const [adapterRegistryRaw, tokenAllowlistRaw, implementationRaw, committedImplHashRaw, factoryCode, adapterCode, implementationCode] =
    await rpc("read-policy-surface", () =>
      Promise.all([
        client.readContract({
          address: factory,
          abi: factoryRegistryAbi,
          functionName: "adapters",
          blockNumber: head,
        }),
        client.readContract({
          address: factory,
          abi: factoryRegistryAbi,
          functionName: "tokens",
          blockNumber: head,
        }),
        client.readContract({
          address: factory,
          abi: factoryRegistryAbi,
          functionName: "implementation",
          blockNumber: head,
        }),
        client.readContract({
          address: factory,
          abi: factoryRegistryAbi,
          functionName: "implCodeHash",
          blockNumber: head,
        }),
        client.getCode({ address: factory, blockNumber: head }),
        client.getCode({ address: route.adapter, blockNumber: head }),
        client.getCode({ address: OPENZAP_CONTRACTS.implementation, blockNumber: head }),
      ]),
    );

  const adapterRegistry = getAddress(String(adapterRegistryRaw));
  const tokenAllowlist = getAddress(String(tokenAllowlistRaw));
  const implementation = getAddress(String(implementationRaw));
  const committedImplHash = asHex32(committedImplHashRaw, "Factory implementation code hash");
  const factoryHash = runtimeHash(factoryCode, "Factory");
  const adapterHash = runtimeHash(adapterCode, "Adapter");
  const implementationHash = runtimeHash(implementationCode, "Implementation");

  if (implementation.toLowerCase() !== OPENZAP_CONTRACTS.implementation.toLowerCase()) {
    throw new PolicyBlockedError("The live factory implementation does not match this release.", {
      configured: OPENZAP_CONTRACTS.implementation,
      live: implementation,
      blockNumber: head.toString(),
    });
  }
  if (implementationHash.toLowerCase() !== committedImplHash.toLowerCase()) {
    throw new PolicyBlockedError("The live implementation bytecode does not match the factory commitment.", {
      committedImplHash,
      runtimeCodeHash: implementationHash,
      blockNumber: head.toString(),
    });
  }

  const tokenAddresses = uniqueAddresses([
    route.tokenIn.address,
    route.tokenOut.address,
    ...route.trackedAssets,
  ]);
  const [adapterAllowedRaw, ...tokenAllowedRaw] = await rpc("read-allowlists", () =>
    Promise.all([
      client.readContract({
        address: adapterRegistry,
        abi: allowlistAbi,
        functionName: "isAllowed",
        args: [route.adapter],
        blockNumber: head,
      }),
      ...tokenAddresses.map((token) =>
        client.readContract({
          address: tokenAllowlist,
          abi: allowlistAbi,
          functionName: "isAllowed",
          args: [token],
          blockNumber: head,
        }),
      ),
    ]),
  );

  if (adapterAllowedRaw !== true) {
    throw new PolicyBlockedError("The route adapter is not allowlisted at the pinned block.", {
      adapter: route.adapter,
      adapterRegistry,
      blockNumber: head.toString(),
    });
  }
  const deniedTokens = tokenAddresses.filter((_, index) => tokenAllowedRaw[index] !== true);
  if (deniedTokens.length > 0) {
    throw new PolicyBlockedError("One or more route tokens are not allowlisted at the pinned block.", {
      tokens: deniedTokens,
      tokenAllowlist,
      blockNumber: head.toString(),
    });
  }

  let vaultReadiness: ExactPolicyArtifact["vaultReadiness"] = null;
  if (route.requiresSeededVault) {
    const vault = "vault" in route.quote ? route.quote.vault : null;
    if (!vault) {
      throw new PolicyBlockedError("This route requires a seeded vault but has no verifiable vault address.", {
        routeId: route.id,
        blockNumber: head.toString(),
      });
    }
    const totalSupply = asBigint(
      await rpc("read-vault-seeding", () =>
        client.readContract({
          address: vault,
          abi: zapVaultAbi,
          functionName: "totalSupply",
          blockNumber: head,
        }),
      ),
      "vault totalSupply",
    );
    if (totalSupply <= 0n) {
      throw new PolicyBlockedError(
        "The route's vault is unseeded at the pinned block, so this policy is not deployable.",
        {
          routeId: route.id,
          vault,
          totalSupply: totalSupply.toString(),
          blockNumber: head.toString(),
        },
      );
    }
    vaultReadiness = {
      vault,
      totalSupply: totalSupply.toString(),
      seeded: true,
      blockNumber: head.toString(),
    };
  }

  const exactQuote = await rpc("quote-requested-amount", () =>
    quoteRouteAtBlock(client, route, amountIn, owner, head),
  );
  const minOut = applySlippage(exactQuote.amountOut, parsed.slippageBps);
  if (minOut <= 0n) {
    throw new PolicyBlockedError("The block-pinned quote produces a zero output floor.", {
      amountOut: exactQuote.amountOut.toString(),
      slippageBps: parsed.slippageBps,
      blockNumber: head.toString(),
    });
  }

  const policy = buildOpenZapPolicy({
    owner,
    recipient,
    adapter: route.adapter,
    spender: route.spender,
    tokenIn: route.tokenIn.address,
    amountIn,
    data: encodeStepData(route, 0n),
    trackedAssets: route.trackedAssets,
    maxRelayerFeeCap: parsed.maxRelayerFee,
    optimization: true,
  });
  const policyHash = hashOpenZapPolicy(policy);
  const salt = parsed.salt ?? keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [policyHash, head],
    ),
  );
  const predictedZapRaw = await rpc("predict-capsule", () =>
    client.readContract({
      address: factory,
      abi: openZapFactoryAbi,
      functionName: "predict",
      args: [policy, salt],
      blockNumber: head,
    }),
  );
  const predictedZap = getAddress(String(predictedZapRaw));
  const nonce = parsed.nonce ?? BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [policyHash, head, owner],
      ),
    ),
  );
  const validAfter = parsed.validAfter ?? blockBefore.timestamp;
  const deadline = parsed.deadline ?? validAfter + 3_600n;
  const unsignedEip712 = buildUnsignedOpenZapIntent({
    zap: predictedZap,
    chainId: ROBINHOOD_CHAIN_ID,
    nonce,
    validAfter,
    deadline,
    recipient,
    relayer: parsed.relayer,
    maxRelayerFee: parsed.maxRelayerFee,
    maxGas: parsed.maxGas,
    maxFeePerGas: parsed.maxFeePerGas,
    policyHash,
    outAsset: route.tokenOut.address,
    minOut,
  });

  // This call executes factory deployment + initialize in an ephemeral EVM
  // state at `head`. It exercises the factory's own allowlist checks and returns
  // a value, but eth_call persists nothing.
  const createSimulation = await rpc("eth-call-create-zap", () =>
    client.simulateContract({
      account: owner,
      address: factory,
      abi: openZapFactoryAbi,
      functionName: "createZap",
      args: [policy, salt],
      blockNumber: head,
    }),
  );
  const simulatedZap = getAddress(String(createSimulation.result));
  if (simulatedZap.toLowerCase() !== predictedZap.toLowerCase()) {
    throw new PolicyBlockedError("Factory prediction and eth_call result disagree.", {
      predictedZap,
      simulatedZap,
      blockNumber: head.toString(),
    });
  }

  const stressCases = await buildStressCases(client, route, owner, amountIn, parsed.slippageBps, head, exactQuote);
  const blockAfter = await rpc("confirm-head", () => client.getBlock({ blockNumber: head }));
  if (!blockAfter.hash || blockAfter.hash.toLowerCase() !== blockBefore.hash.toLowerCase()) {
    throw new PolicyRpcError(
      "The pinned block changed while the policy was compiled.",
      "confirm-head",
      "Same-height block hash mismatch; retry against the new canonical head.",
    );
  }

  return {
    status: stressCases.some((entry) => entry.status === "rpc-failure") ? "warn" : "pass",
    mode: "chain-exact",
    chain: {
      chainId: ROBINHOOD_CHAIN_ID,
      blockNumber: head.toString(),
      blockHash: blockBefore.hash,
      blockTimestamp: blockBefore.timestamp.toString(),
      rpcStatus: "verified",
    },
    route: {
      id: route.id,
      adapter: route.adapter,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
    },
    allowlists: {
      adapterRegistry,
      tokenAllowlist,
      adapterAllowed: true,
      tokens: tokenAddresses.map((address) => ({ address, allowed: true })),
    },
    runtimeCode: {
      factory: { address: factory, codeHash: factoryHash },
      implementation: { address: implementation, codeHash: implementationHash, matchesFactoryCommitment: true },
      adapters: [{ address: route.adapter, codeHash: adapterHash, allowedAtBlock: true }],
    },
    quote: {
      source: route.quote.source,
      amountIn: amountIn.toString(),
      amountOut: exactQuote.amountOut.toString(),
      minOut: minOut.toString(),
      display: `${formatUnits(exactQuote.amountOut, route.tokenOut.decimals)} ${route.tokenOut.symbol}`,
      gasEstimate: exactQuote.gasEstimate?.toString() ?? null,
      blockNumber: head.toString(),
    },
    vaultReadiness,
    compiled: { policy, policyHash, salt, predictedZap, unsignedEip712 },
    ethCall: {
      status: "pass",
      method: "eth_call",
      target: factory,
      function: "createZap",
      result: simulatedZap,
      blockNumber: head.toString(),
      broadcast: false,
      note: "Ephemeral factory create + initialize simulation. No state was persisted.",
    },
    stressCases,
    authority: {
      signed: false,
      broadcast: false,
      discoveryCredentialsAreAuthority: false,
      note: "Only the capsule owner's EIP-712 signature can authorize a run. This artifact is unsigned.",
    },
  };
}

export function jsonSafePolicyArtifact(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafePolicyArtifact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonSafePolicyArtifact(entry)]),
    );
  }
  return value;
}

async function buildStressCases(
  client: PolicyChainReader,
  route: Route,
  owner: Address,
  requested: bigint,
  slippageBps: number,
  blockNumber: bigint,
  requestedQuote: { amountOut: bigint; gasEstimate: bigint | null },
): Promise<StressCase[]> {
  const definitions = [
    { id: "thin-input", derivedFrom: "requested amount / 10", amountIn: requested / 10n || 1n },
    { id: "requested", derivedFrom: "requested amount", amountIn: requested },
    {
      id: "double-input",
      derivedFrom: "requested amount × 2, capped at uint128",
      amountIn: requested > MAX_ROUTER_AMOUNT / 2n ? MAX_ROUTER_AMOUNT : requested * 2n,
    },
  ] as const;

  return Promise.all(
    definitions.map(async (definition): Promise<StressCase> => {
      try {
        const quote =
          definition.id === "requested"
            ? requestedQuote
            : await quoteRouteAtBlock(client, route, definition.amountIn, owner, blockNumber);
        return {
          id: definition.id,
          derivedFrom: definition.derivedFrom,
          status: "quoted",
          rpcFailure: false,
          amountIn: definition.amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minOut: applySlippage(quote.amountOut, slippageBps).toString(),
          blockNumber: blockNumber.toString(),
        };
      } catch (error) {
        return {
          id: definition.id,
          derivedFrom: definition.derivedFrom,
          status: "rpc-failure",
          rpcFailure: true,
          amountIn: definition.amountIn.toString(),
          blockNumber: blockNumber.toString(),
          error: rpcDetail(error),
        };
      }
    }),
  );
}

async function quoteRouteAtBlock(
  client: PolicyChainReader,
  route: Route,
  amountIn: bigint,
  account: Address,
  blockNumber: bigint,
): Promise<{ amountOut: bigint; gasEstimate: bigint | null }> {
  if (amountIn <= 0n) throw new Error("Quote amount must be greater than zero.");

  if (route.quote.source === "v4") {
    const { result } = await client.simulateContract({
      account,
      address: ROBINHOOD_LIQUIDITY.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: route.quote.poolKey,
        zeroForOne: route.quote.zeroForOne,
        exactAmount: amountIn,
        hookData: "0x",
      }],
      blockNumber,
    });
    const [amountOut, gasEstimate] = asBigintTuple(result, "v4 quote");
    if (amountOut <= 0n) throw new Error("The route quoted zero output.");
    return { amountOut, gasEstimate };
  }

  if (route.quote.source === "v4-route") {
    let amountOut = amountIn;
    let gasEstimate = 0n;
    for (const hop of route.quote.hops) {
      const response = await client.simulateContract({
        account,
        address: ROBINHOOD_LIQUIDITY.v4Quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{
          poolKey: hop.poolKey,
          zeroForOne: hop.zeroForOne,
          exactAmount: amountOut,
          hookData: "0x",
        }],
        blockNumber,
      });
      const tuple = asBigintTuple(response.result, "v4 route quote");
      amountOut = tuple[0];
      gasEstimate += tuple[1];
    }
    if (amountOut <= 0n) throw new Error("The stitched route quoted zero output.");
    return { amountOut, gasEstimate };
  }

  if (route.quote.source === "erc4626-deposit" || route.quote.source === "erc4626-redeem") {
    const amountOut = asBigint(
      await client.readContract({
        address: route.quote.vault,
        abi: zapVaultAbi,
        functionName: route.quote.source === "erc4626-deposit" ? "previewDeposit" : "previewRedeem",
        args: [amountIn],
        blockNumber,
      }),
      "vault preview",
    );
    if (amountOut <= 0n) throw new Error("The vault preview returned zero output.");
    return { amountOut, gasEstimate: null };
  }

  if (route.quote.source === "range-deposit") {
    const swapAmount = amountIn / 2n;
    const keep = amountIn - swapAmount;
    const response = await client.simulateContract({
      account,
      address: ROBINHOOD_LIQUIDITY.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: route.quote.poolKey,
        zeroForOne: route.quote.zeroForOne,
        exactAmount: swapAmount,
        hookData: "0x",
      }],
      blockNumber,
    });
    const swapped = asBigintTuple(response.result, "range deposit quote")[0];
    const [amount0, amount1] = route.quote.zeroForOne ? [keep, swapped] : [swapped, keep];
    const preview = await client.readContract({
      address: route.quote.vault,
      abi: rangeVaultAbi,
      functionName: "previewDeposit",
      args: [amount0, amount1],
      blockNumber,
    });
    const shares = asBigintTuple(preview, "range deposit preview")[0];
    if (shares <= 0n) throw new Error("The range deposit preview returned zero shares.");
    return { amountOut: shares, gasEstimate: null };
  }

  const preview = asBigintTuple(
    await client.readContract({
      address: route.quote.vault,
      abi: rangeVaultAbi,
      functionName: "previewRedeem",
      args: [amountIn],
      blockNumber,
    }),
    "range redeem preview",
  );
  const target = route.quote.assetOutIsCurrency0 ? preview[0] : preview[1];
  const offTarget = route.quote.assetOutIsCurrency0 ? preview[1] : preview[0];
  let swapped = 0n;
  if (offTarget > 0n) {
    const response = await client.simulateContract({
      account,
      address: ROBINHOOD_LIQUIDITY.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: route.quote.poolKey,
        zeroForOne: !route.quote.assetOutIsCurrency0,
        exactAmount: offTarget,
        hookData: "0x",
      }],
      blockNumber,
    });
    swapped = asBigintTuple(response.result, "range redeem swap quote")[0];
  }
  const amountOut = target + swapped;
  if (amountOut <= 0n) throw new Error("The range redeem preview returned zero output.");
  return { amountOut, gasEstimate: null };
}

function parseRequest(request: ExactPolicyRequest) {
  if (!request || typeof request !== "object") throw new PolicyInputError("Request body must be an object.");
  if (typeof request.routeId !== "string" || request.routeId.length === 0 || request.routeId.length > 100) {
    throw new PolicyInputError("routeId is required.");
  }
  if (!isAddress(request.owner)) throw new PolicyInputError("owner must be a valid address.");
  if (request.recipient !== undefined && !isAddress(request.recipient)) {
    throw new PolicyInputError("recipient must be a valid address.");
  }
  const slippageBps = request.slippageBps ?? 100;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new PolicyInputError(`slippageBps must be an integer from 0 to ${MAX_SLIPPAGE_BPS}.`);
  }
  const salt = request.salt === undefined ? undefined : asHex32(request.salt, "salt");
  const nonce = request.nonce === undefined ? undefined : inputUint(request.nonce, "nonce", MAX_UINT256);
  const validAfter =
    request.validAfter === undefined
      ? undefined
      : inputUint(request.validAfter, "validAfter", MAX_UINT64);
  const deadline =
    request.deadline === undefined
      ? undefined
      : inputUint(request.deadline, "deadline", MAX_UINT64);
  if (validAfter !== undefined && deadline !== undefined && deadline <= validAfter) {
    throw new PolicyInputError("deadline must be after validAfter.");
  }
  const relayer = request.relayer === undefined ? zeroAddress : validAddress(request.relayer, "relayer");
  const maxRelayerFee =
    request.maxRelayerFee === undefined
      ? 0n
      : inputUint(request.maxRelayerFee, "maxRelayerFee", MAX_UINT256);
  if (maxRelayerFee > 0n && relayer === zeroAddress) {
    throw new PolicyInputError("A nonzero maxRelayerFee requires a nonzero relayer.");
  }
  const maxGas = request.maxGas === undefined ? MAX_EXECUTION_GAS : inputUint(request.maxGas, "maxGas");
  if (maxGas <= 0n || maxGas > MAX_EXECUTION_GAS) {
    throw new PolicyInputError(`maxGas must be from 1 to ${MAX_EXECUTION_GAS}.`);
  }
  const maxFeePerGas =
    request.maxFeePerGas === undefined
      ? MAX_EXECUTION_FEE_PER_GAS
      : inputUint(request.maxFeePerGas, "maxFeePerGas");
  if (maxFeePerGas <= 0n || maxFeePerGas > MAX_EXECUTION_FEE_PER_GAS) {
    throw new PolicyInputError(`maxFeePerGas must be from 1 to ${MAX_EXECUTION_FEE_PER_GAS}.`);
  }
  if (typeof request.amount !== "string") throw new PolicyInputError("amount is required as a decimal string.");
  return {
    routeId: request.routeId,
    owner: request.owner,
    recipient: request.recipient,
    amount: request.amount,
    slippageBps,
    salt,
    nonce,
    validAfter,
    deadline,
    relayer,
    maxRelayerFee,
    maxGas,
    maxFeePerGas,
  };
}

function parseExactAmount(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) throw new PolicyInputError("amount must be a positive decimal string.");
  if (normalized.length > 100) throw new PolicyInputError("amount is too long.");
  const [whole, fractional = ""] = normalized.split(".");
  if (fractional.length > decimals) {
    throw new PolicyInputError(`amount supports at most ${decimals} decimal places for this route.`);
  }
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fractional + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (amount <= 0n || amount > MAX_ROUTER_AMOUNT) {
    throw new PolicyInputError("amount must be greater than zero and fit the live uint128 router bound.");
  }
  return amount;
}

function inputUint(value: string, field: string, max: bigint = MAX_UINT256): bigint {
  if (!/^\d{1,78}$/.test(value)) throw new PolicyInputError(`${field} must be an unsigned integer string.`);
  const parsed = BigInt(value);
  if (parsed > max) throw new PolicyInputError(`${field} exceeds its Solidity integer width.`);
  return parsed;
}

function validAddress(value: string, field: string): Address {
  if (!isAddress(value)) throw new PolicyInputError(`${field} must be a valid address.`);
  return getAddress(value);
}

function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * (BPS - BigInt(slippageBps))) / BPS;
}

function runtimeHash(code: Hex | undefined, label: string): Hex {
  if (!code || code === "0x") throw new PolicyBlockedError(`${label} has no runtime code at the pinned block.`);
  return keccak256(code);
}

function uniqueAddresses(addresses: readonly Address[]): Address[] {
  return [...new Map(addresses.map((address) => [address.toLowerCase(), getAddress(address)])).values()];
}

function asHex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new PolicyInputError(`${label} must be a 32-byte hex value.`);
  }
  return value as Hex;
}

function asBigint(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  throw new Error(`${label} returned a non-integer value.`);
}

function asBigintTuple(value: unknown, label: string): readonly [bigint, bigint] {
  if (!Array.isArray(value) || typeof value[0] !== "bigint" || typeof value[1] !== "bigint") {
    throw new Error(`${label} returned an unexpected result.`);
  }
  return [value[0], value[1]];
}

async function rpc<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PolicyInputError || error instanceof PolicyBlockedError || error instanceof PolicyRpcError) {
      throw error;
    }
    throw new PolicyRpcError(`The ${stage} RPC call failed.`, stage, rpcDetail(error));
  }
}

function rpcDetail(error: unknown): string {
  if (!error || typeof error !== "object") return String(error).slice(0, 500);
  const record = error as Record<string, unknown>;
  const message =
    (typeof record.shortMessage === "string" && record.shortMessage) ||
    (typeof record.message === "string" && record.message) ||
    "Unknown RPC failure.";
  return message.replace(/\s+/g, " ").slice(0, 500);
}
