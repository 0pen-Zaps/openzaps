import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";

import {
  ACROSS_API_BASE,
  ACROSS_SPOKE_POOL,
  baseChain,
  BridgeQuoteError,
  findBridgeRoute,
  parseAcrossSwapQuote,
  type BridgeProtocolEvidence,
  type BridgeQuote,
} from "@/lib/bridge";

type AcrossEnvironment = {
  readonly ACROSS_API_KEY?: string;
  readonly ACROSS_INTEGRATOR_ID?: string;
  readonly ACROSS_ALLOW_UNAUTHENTICATED?: string;
  readonly NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED?: string;
  readonly OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED?: string;
  readonly NODE_ENV?: string;
};

export type AcrossQuoteRequest = {
  readonly routeId: string;
  readonly outputAmount: bigint;
  readonly depositor: Address;
  readonly recipient: Address;
};

const acrossSpokePoolConfigAbi = [
  {
    type: "function",
    name: "depositQuoteTimeBuffer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "fillDeadlineBuffer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "MAX_EXCLUSIVITY_PERIOD_SECONDS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
] as const;

export interface AcrossProtocolReader {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{
    number: bigint;
    hash: Hex | null;
    timestamp: bigint;
  }>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

const baseProtocolClient = createPublicClient({
  chain: baseChain,
  transport: http(
    process.env.BASE_RPC_URL
      ?? process.env.NEXT_PUBLIC_BASE_RPC_URL
      ?? baseChain.rpcUrls.default.http[0],
  ),
});

function protocolUint32(raw: unknown, field: string): number {
  const value =
    typeof raw === "bigint"
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new BridgeQuoteError(`The pinned Across ${field} is unusable.`);
  }
  return value;
}

/**
 * Capture the exact Base block and the three mutable SpokePool timing limits
 * that decide whether the returned deposit calldata can be accepted safely.
 * A same-height hash re-read rejects mixed-fork evidence.
 */
export async function readAcrossProtocolEvidence(
  reader: AcrossProtocolReader = baseProtocolClient,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): Promise<BridgeProtocolEvidence> {
  try {
    const head = await reader.getBlockNumber({ cacheTime: 0 });
    const before = await reader.getBlock({ blockNumber: head });
    if (!before.hash || before.number !== head) {
      throw new BridgeQuoteError("The Base RPC returned no canonical head hash.");
    }
    const blockTimestamp = Number(before.timestamp);
    if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp <= 0 || blockTimestamp > 0xffff_ffff) {
      throw new BridgeQuoteError("The Base RPC returned an unusable head timestamp.");
    }
    if (blockTimestamp > nowSeconds + 30 || nowSeconds - blockTimestamp > 5 * 60) {
      throw new BridgeQuoteError("The Base RPC head is too far from the server clock.");
    }

    const [quoteBufferRaw, fillBufferRaw, maxExclusivityRaw] = await Promise.all([
      reader.readContract({
        address: ACROSS_SPOKE_POOL.origin,
        abi: acrossSpokePoolConfigAbi,
        functionName: "depositQuoteTimeBuffer",
        blockNumber: head,
      }),
      reader.readContract({
        address: ACROSS_SPOKE_POOL.origin,
        abi: acrossSpokePoolConfigAbi,
        functionName: "fillDeadlineBuffer",
        blockNumber: head,
      }),
      reader.readContract({
        address: ACROSS_SPOKE_POOL.origin,
        abi: acrossSpokePoolConfigAbi,
        functionName: "MAX_EXCLUSIVITY_PERIOD_SECONDS",
        blockNumber: head,
      }),
    ]);
    const after = await reader.getBlock({ blockNumber: head });
    if (!after.hash || after.hash.toLowerCase() !== before.hash.toLowerCase()) {
      throw new BridgeQuoteError("The Base head changed while Across limits were being read.");
    }

    return {
      blockNumber: head.toString(),
      blockHash: before.hash.toLowerCase() as Hex,
      blockTimestamp,
      depositQuoteTimeBuffer: protocolUint32(quoteBufferRaw, "deposit quote buffer"),
      fillDeadlineBuffer: protocolUint32(fillBufferRaw, "fill deadline buffer"),
      maxExclusivityPeriodSeconds: protocolUint32(
        maxExclusivityRaw,
        "maximum exclusivity period",
      ),
    };
  } catch (error) {
    if (error instanceof BridgeQuoteError) throw error;
    throw new BridgeQuoteError(
      `The pinned Across limits could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The browser flag is not an API boundary: a caller can address the route
 * directly. Production therefore requires both the product launch flag and an
 * explicit acknowledgement that a durable edge quota is active.
 */
export function acrossBridgeApiEnabled(
  environment: AcrossEnvironment = process.env,
): boolean {
  if (environment.NODE_ENV !== "production") return true;
  return (
    environment.NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED === "true"
    && environment.OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED === "true"
  );
}

/**
 * Obtain a minimum-output quote without exposing the Across API key in the
 * browser. Both credentials are optional for local development because Across
 * currently permits a tightly rate-limited unauthenticated request, but a
 * half-configured credential pair fails closed.
 */
export async function fetchAcrossBridgeQuote(
  request: AcrossQuoteRequest,
  fetchImpl: typeof fetch = fetch,
  environment: AcrossEnvironment = {
    ACROSS_API_KEY: process.env.ACROSS_API_KEY,
    ACROSS_INTEGRATOR_ID: process.env.ACROSS_INTEGRATOR_ID,
    ACROSS_ALLOW_UNAUTHENTICATED: process.env.ACROSS_ALLOW_UNAUTHENTICATED,
    NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED: process.env.NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED,
    OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED: process.env.OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED,
    NODE_ENV: process.env.NODE_ENV,
  },
  nowSeconds: number = Math.floor(Date.now() / 1_000),
  protocolReader: AcrossProtocolReader = baseProtocolClient,
): Promise<BridgeQuote> {
  const route = findBridgeRoute(request.routeId);
  if (!route) throw new BridgeQuoteError("Unknown bridge route.");
  if (request.outputAmount <= 0n) throw new BridgeQuoteError("The requested output must be greater than zero.");

  const apiKey = environment.ACROSS_API_KEY?.trim() ?? "";
  const integratorId = environment.ACROSS_INTEGRATOR_ID?.trim() ?? "";
  if (Boolean(apiKey) !== Boolean(integratorId)) {
    throw new BridgeQuoteError("Across credentials must include both an API key and an integrator ID.");
  }
  if (
    !apiKey
    && environment.NODE_ENV === "production"
    && environment.ACROSS_ALLOW_UNAUTHENTICATED !== "true"
  ) {
    throw new BridgeQuoteError("Authenticated Across production credentials are not configured.");
  }
  if (integratorId && !/^0x[0-9a-fA-F]{4}$/.test(integratorId)) {
    throw new BridgeQuoteError("The Across integrator ID must be a two-byte 0x-prefixed value.");
  }

  const depositor = getAddress(request.depositor);
  const recipient = getAddress(request.recipient);
  const params = new URLSearchParams({
    tradeType: "minOutput",
    amount: request.outputAmount.toString(),
    inputToken: route.inputToken,
    outputToken: route.outputToken,
    originChainId: route.originChainId.toString(),
    destinationChainId: route.destinationChainId.toString(),
    depositor,
    recipient,
    refundAddress: depositor,
    refundOnOrigin: "true",
    slippage: "auto",
  });
  if (integratorId) params.set("integratorId", integratorId);

  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetchImpl(`${ACROSS_API_BASE}/swap/approval?${params}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new BridgeQuoteError(
      `Across could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new BridgeQuoteError(`Across answered ${response.status}; no deposit transaction was accepted.`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new BridgeQuoteError("Across returned a response that was not JSON.");
  }

  // Read after the API responds so the quote timestamp cannot post-date the
  // pinned block merely because the provider answered between two Base blocks.
  const protocol = await readAcrossProtocolEvidence(protocolReader, nowSeconds);
  return parseAcrossSwapQuote(
    route,
    request.outputAmount,
    depositor,
    recipient,
    raw,
    Boolean(apiKey && integratorId),
    protocol,
    nowSeconds,
  );
}
