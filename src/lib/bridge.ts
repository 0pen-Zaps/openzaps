import {
  decodeFunctionData,
  defineChain,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";

import { ROBINHOOD_ASSETS, ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";

/**
 * Funding a Robinhood Chain capsule from Base, over Across.
 *
 * A bridge is NOT a step. `OpenZap.execute()` settles by measuring one ERC-20
 * balance delta on ONE chain, so a step whose output lands on another chain
 * cannot be settled by the capsule. The bridge therefore sits outside the
 * policy and delivers an ERC-20 directly to the deterministic capsule address.
 *
 * There is deliberately no Base WETH -> Robinhood aeWETH route. The destination
 * SpokePool unwraps its configured wrapped-native token even when the recipient
 * is a contract. A capsule would receive native ETH, which its token-only
 * adapters cannot route. USDG is delivered as an ERC-20 and can be consumed by
 * the policy's verified USDG routes.
 */

export const BRIDGE_ORIGIN_CHAIN_ID = 8453;

export const baseChain = defineChain({
  id: BRIDGE_ORIGIN_CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
});

/**
 * Pinned Across SpokePools. The origin address is also checked against the
 * transaction returned by the Swap API; an API response cannot redirect funds
 * to a newly supplied contract.
 */
export const ACROSS_SPOKE_POOL = {
  origin: getAddress("0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64"),
  destination: getAddress("0xD29C85F15DF544bA632C9E25829fd29d767d7978"),
} as const;

export const ACROSS_API_BASE = "https://app.across.to/api";
export const MAX_BRIDGE_SPREAD_BPS = 300;
/** Product-level freshness cap, stricter than the SpokePool's live quote buffer. */
export const MAX_BRIDGE_QUOTE_AGE_SECONDS = 10 * 60;
/** Product-level cap on how long one nominated relayer may exclude the wider network. */
export const MAX_BRIDGE_EXCLUSIVITY_SECONDS = 10 * 60;
/** Leave enough quote life for the final eth_call and wallet hand-off. */
export const BRIDGE_SUBMISSION_RUNWAY_SECONDS = 30;
/** A fill deadline shorter than this is too fragile for an interactive wallet flow. */
export const MIN_BRIDGE_FILL_RUNWAY_SECONDS = 10 * 60;
/** Keep the production control hidden until authenticated Across credentials are installed. */
export const BRIDGE_FUNDING_ENABLED =
  process.env.NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED === "true";

export type BridgeRoute = {
  readonly id: string;
  readonly originChainId: number;
  readonly destinationChainId: number;
  readonly inputToken: Address;
  readonly inputSymbol: string;
  readonly inputDecimals: number;
  readonly outputToken: Address;
  readonly outputSymbol: string;
  readonly outputDecimals: number;
  readonly catalogSymbol: string;
};

export const BRIDGE_ROUTES: readonly BridgeRoute[] = [
  {
    id: "across-base-usdc-robinhood-usdg",
    originChainId: BRIDGE_ORIGIN_CHAIN_ID,
    destinationChainId: ROBINHOOD_CHAIN_ID,
    inputToken: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    inputSymbol: "USDC",
    inputDecimals: 6,
    outputToken: ROBINHOOD_ASSETS.usdg,
    outputSymbol: "USDG",
    outputDecimals: 6,
    catalogSymbol: "USDG",
  },
] as const;

export function findBridgeRoute(id: string): BridgeRoute | null {
  return BRIDGE_ROUTES.find((route) => route.id === id) ?? null;
}

/**
 * ERC-20 approval sequence for one bound bridge quote.
 *
 * A mismatched non-zero allowance is reset before the exact amount is granted;
 * accepting a larger historical allowance would silently preserve wider
 * authority than the quote needs.
 */
export function bridgeApprovalAmounts(currentAllowance: bigint, requiredAmount: bigint): readonly bigint[] {
  if (currentAllowance < 0n || requiredAmount <= 0n) {
    throw new BridgeQuoteError("Bridge allowances must be non-negative and the required amount must be positive.");
  }
  if (currentAllowance === requiredAmount) return [];
  return currentAllowance === 0n ? [requiredAmount] : [0n, requiredAmount];
}

export type BridgeTransaction = {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
};

export type BridgeProtocolEvidence = {
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly blockTimestamp: number;
  readonly depositQuoteTimeBuffer: number;
  readonly fillDeadlineBuffer: number;
  readonly maxExclusivityPeriodSeconds: number;
};

/**
 * The minimum-output quote is tied to one wallet and one capsule. It can never
 * be reused with a different depositor or recipient without obtaining a new
 * quote whose calldata names those addresses.
 */
export type BridgeQuote = {
  readonly route: BridgeRoute;
  readonly requestedOutputAmount: bigint;
  readonly inputAmount: bigint;
  readonly outputAmount: bigint;
  readonly depositor: Address;
  readonly recipient: Address;
  readonly spokePool: Address;
  readonly estimatedFillSeconds: number;
  readonly quoteExpiryTimestamp: number;
  readonly quoteTimestamp: number;
  readonly fillDeadline: number;
  readonly exclusiveRelayer: Address;
  /** The raw calldata parameter; small values are interpreted as relative periods. */
  readonly exclusivityParameter: number;
  readonly effectiveExclusivityDeadline: number;
  readonly protocol: BridgeProtocolEvidence;
  readonly providerSimulationSucceeded: true;
  readonly providerAuthenticated: boolean;
  readonly transaction: BridgeTransaction;
};

export type BridgeQuoteWire = {
  readonly routeId: string;
  readonly requestedOutputAmount: string;
  readonly inputAmount: string;
  readonly outputAmount: string;
  readonly depositor: string;
  readonly recipient: string;
  readonly spokePool: string;
  readonly estimatedFillSeconds: number;
  readonly quoteExpiryTimestamp: number;
  readonly quoteTimestamp: number;
  readonly fillDeadline: number;
  readonly exclusiveRelayer: string;
  readonly exclusivityParameter: number;
  readonly effectiveExclusivityDeadline: number;
  readonly protocol: BridgeProtocolEvidence;
  readonly providerSimulationSucceeded: true;
  readonly providerAuthenticated: boolean;
  readonly transaction: {
    readonly chainId: number;
    readonly to: string;
    readonly data: string;
    readonly value: string;
  };
};

export class BridgeQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeQuoteError";
  }
}

function requireRecord(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeQuoteError(`The bridge quote is missing a usable "${field}".`);
  }
  return raw as Record<string, unknown>;
}

function requireBigInt(raw: unknown, field: string): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new BridgeQuoteError(`The bridge quote is missing a usable "${field}".`);
  }
  return BigInt(raw);
}

function requireUint(raw: unknown, field: string): number {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BridgeQuoteError(`The bridge quote's "${field}" is not a usable unsigned integer.`);
  }
  return value;
}

function requireAddress(raw: unknown, field: string): Address {
  if (typeof raw !== "string" || !isAddress(raw)) {
    throw new BridgeQuoteError(`The bridge quote's "${field}" is not an address.`);
  }
  return getAddress(raw);
}

function requireHex(raw: unknown, field: string): Hex {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw)) {
    throw new BridgeQuoteError(`The bridge quote's "${field}" is not byte-aligned calldata.`);
  }
  return raw as Hex;
}

function addressWord(address: Address): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function requireAddressWord(raw: Hex, expected: Address, field: string): void {
  if (raw.toLowerCase() !== addressWord(expected)) {
    throw new BridgeQuoteError(`The bridge transaction's "${field}" does not match the bound ${field}.`);
  }
}

function addressFromWord(raw: Hex, field: string): Address {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(raw)) {
    throw new BridgeQuoteError(`The bridge transaction's "${field}" is not a canonical EVM address word.`);
  }
  return getAddress(`0x${raw.slice(-40)}`);
}

function requireUint32(raw: unknown, field: string): number {
  const value = typeof raw === "bigint" ? Number(raw) : requireUint(raw, field);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new BridgeQuoteError(`The bridge quote's "${field}" is not a usable uint32.`);
  }
  return value;
}

function requireProtocolEvidence(raw: unknown): BridgeProtocolEvidence {
  const protocol = requireRecord(raw, "protocol");
  if (typeof protocol.blockNumber !== "string" || !/^(?:0|[1-9]\d*)$/.test(protocol.blockNumber)) {
    throw new BridgeQuoteError("The bridge quote's protocol block number is malformed.");
  }
  if (
    typeof protocol.blockHash !== "string"
    || !/^0x[0-9a-fA-F]{64}$/.test(protocol.blockHash)
  ) {
    throw new BridgeQuoteError("The bridge quote's protocol block hash is malformed.");
  }
  const evidence = {
    blockNumber: protocol.blockNumber,
    blockHash: protocol.blockHash.toLowerCase() as Hex,
    blockTimestamp: requireUint32(protocol.blockTimestamp, "protocol.blockTimestamp"),
    depositQuoteTimeBuffer: requireUint32(
      protocol.depositQuoteTimeBuffer,
      "protocol.depositQuoteTimeBuffer",
    ),
    fillDeadlineBuffer: requireUint32(protocol.fillDeadlineBuffer, "protocol.fillDeadlineBuffer"),
    maxExclusivityPeriodSeconds: requireUint32(
      protocol.maxExclusivityPeriodSeconds,
      "protocol.maxExclusivityPeriodSeconds",
    ),
  };
  if (
    evidence.depositQuoteTimeBuffer === 0
    || evidence.fillDeadlineBuffer === 0
    || evidence.maxExclusivityPeriodSeconds === 0
  ) {
    throw new BridgeQuoteError("The bridge quote's pinned protocol limits are unusable.");
  }
  return evidence;
}

/**
 * The current Swap API emits the bytes32 `deposit` entrypoint. The final bytes
 * after the ABI payload may carry Across's tracking delimiter/integrator ID;
 * viem decodes the ABI payload and ignores that permitted suffix.
 */
export const acrossSwapDepositAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "depositor", type: "bytes32" },
      { name: "recipient", type: "bytes32" },
      { name: "inputToken", type: "bytes32" },
      { name: "outputToken", type: "bytes32" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputAmount", type: "uint256" },
      { name: "destinationChainId", type: "uint256" },
      { name: "exclusiveRelayer", type: "bytes32" },
      { name: "quoteTimestamp", type: "uint32" },
      { name: "fillDeadline", type: "uint32" },
      { name: "exclusivityDeadline", type: "uint32" },
      { name: "message", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

type ValidatedQuoteFields = {
  route: BridgeRoute;
  requestedOutputAmount: bigint;
  inputAmount: bigint;
  outputAmount: bigint;
  depositor: Address;
  recipient: Address;
  estimatedFillSeconds: number;
  quoteExpiryTimestamp: number;
  protocol: BridgeProtocolEvidence;
  providerSimulationSucceeded: true;
  providerAuthenticated: boolean;
  transaction: BridgeTransaction;
};

function validateQuote(fields: ValidatedQuoteFields, nowSeconds?: number): BridgeQuote {
  const {
    route,
    requestedOutputAmount,
    inputAmount,
    outputAmount,
    depositor,
    recipient,
    transaction,
    quoteExpiryTimestamp,
    protocol,
  } = fields;

  if (requestedOutputAmount <= 0n) {
    throw new BridgeQuoteError("The capsule needs an output amount greater than zero.");
  }
  if (inputAmount <= 0n || outputAmount <= 0n) {
    throw new BridgeQuoteError("The bridge quote would move a zero amount.");
  }
  if (route.inputDecimals !== route.outputDecimals) {
    throw new BridgeQuoteError("This bridge route cannot compare its input and output units safely.");
  }
  if (outputAmount < requestedOutputAmount) {
    throw new BridgeQuoteError("The bridge quote would deliver less than the capsule still needs.");
  }
  if (outputAmount > inputAmount) {
    throw new BridgeQuoteError("The bridge quote claims more stablecoin output than input.");
  }

  const keptBps = ((inputAmount - outputAmount) * 10_000n) / inputAmount;
  if (keptBps > BigInt(MAX_BRIDGE_SPREAD_BPS)) {
    throw new BridgeQuoteError(
      `The bridge quote keeps ${keptBps} bps, above the ${MAX_BRIDGE_SPREAD_BPS} bps route limit.`,
    );
  }

  if (transaction.chainId !== route.originChainId) {
    throw new BridgeQuoteError("The bridge transaction is for a different origin chain.");
  }
  if (transaction.to !== ACROSS_SPOKE_POOL.origin) {
    throw new BridgeQuoteError("The bridge transaction does not target the pinned Base SpokePool.");
  }
  if (transaction.value !== 0n) {
    throw new BridgeQuoteError("The USDC bridge transaction unexpectedly asks for native value.");
  }

  let decoded: ReturnType<typeof decodeFunctionData<typeof acrossSwapDepositAbi>>;
  try {
    decoded = decodeFunctionData({ abi: acrossSwapDepositAbi, data: transaction.data });
  } catch {
    throw new BridgeQuoteError("The bridge transaction calldata is not the pinned Across deposit entrypoint.");
  }
  if (decoded.functionName !== "deposit" || !decoded.args) {
    throw new BridgeQuoteError("The bridge transaction calldata is not an Across deposit.");
  }

  const [
    encodedDepositor,
    encodedRecipient,
    encodedInputToken,
    encodedOutputToken,
    encodedInputAmount,
    encodedOutputAmount,
    encodedDestinationChainId,
    encodedExclusiveRelayer,
    encodedQuoteTimestamp,
    encodedFillDeadline,
    encodedExclusivityParameter,
    message,
  ] = decoded.args;

  requireAddressWord(encodedDepositor, depositor, "depositor");
  requireAddressWord(encodedRecipient, recipient, "recipient");
  requireAddressWord(encodedInputToken, route.inputToken, "inputToken");
  requireAddressWord(encodedOutputToken, route.outputToken, "outputToken");

  if (encodedInputAmount !== inputAmount || encodedOutputAmount !== outputAmount) {
    throw new BridgeQuoteError("The bridge transaction amounts do not match the displayed quote.");
  }
  if (encodedDestinationChainId !== BigInt(route.destinationChainId)) {
    throw new BridgeQuoteError("The bridge transaction names a different destination chain.");
  }
  if (message !== "0x") {
    throw new BridgeQuoteError("The bridge transaction contains a callback message the capsule cannot execute.");
  }

  const exclusiveRelayer = addressFromWord(encodedExclusiveRelayer, "exclusiveRelayer");
  const quoteTimestamp = requireUint32(encodedQuoteTimestamp, "quoteTimestamp");
  const fillDeadline = requireUint32(encodedFillDeadline, "fillDeadline");
  const exclusivityParameter = requireUint32(
    encodedExclusivityParameter,
    "exclusivityParameter",
  );
  if (fillDeadline <= 0) {
    throw new BridgeQuoteError("The bridge transaction has no usable fill deadline.");
  }
  if (quoteExpiryTimestamp >= fillDeadline) {
    throw new BridgeQuoteError("The bridge quote claims to remain valid after its fill deadline.");
  }
  if (nowSeconds !== undefined && quoteExpiryTimestamp <= nowSeconds) {
    throw new BridgeQuoteError("The bridge quote expired before it could be returned.");
  }
  if (quoteExpiryTimestamp <= quoteTimestamp) {
    throw new BridgeQuoteError("The bridge quote expires before its onchain quote timestamp.");
  }

  const originTimestamp = protocol.blockTimestamp;
  if (quoteTimestamp > originTimestamp) {
    throw new BridgeQuoteError("The bridge transaction's quote timestamp is in the future at the pinned Base block.");
  }
  const maximumQuoteAge = Math.min(
    protocol.depositQuoteTimeBuffer,
    MAX_BRIDGE_QUOTE_AGE_SECONDS,
  );
  if (originTimestamp - quoteTimestamp > maximumQuoteAge) {
    throw new BridgeQuoteError("The bridge transaction's quote timestamp is too old.");
  }

  const minimumFillRunway = Math.max(
    MIN_BRIDGE_FILL_RUNWAY_SECONDS,
    fields.estimatedFillSeconds + 300,
  );
  if (fillDeadline <= originTimestamp + minimumFillRunway) {
    throw new BridgeQuoteError("The bridge transaction leaves too little time for a safe destination fill.");
  }
  if (fillDeadline > originTimestamp + protocol.fillDeadlineBuffer) {
    throw new BridgeQuoteError("The bridge transaction's fill deadline exceeds the pinned SpokePool buffer.");
  }

  const effectiveExclusivityDeadline =
    exclusivityParameter === 0
      ? 0
      : exclusivityParameter <= protocol.maxExclusivityPeriodSeconds
        ? originTimestamp + exclusivityParameter
        : exclusivityParameter;
  const hasExclusiveRelayer = exclusiveRelayer !== zeroAddress;
  if (hasExclusiveRelayer !== (exclusivityParameter !== 0)) {
    throw new BridgeQuoteError("The bridge transaction has an ambiguous exclusive-relayer configuration.");
  }
  if (
    hasExclusiveRelayer
    && (
      effectiveExclusivityDeadline <= originTimestamp
      || effectiveExclusivityDeadline > fillDeadline
      || effectiveExclusivityDeadline - originTimestamp > MAX_BRIDGE_EXCLUSIVITY_SECONDS
    )
  ) {
    throw new BridgeQuoteError("The bridge transaction's relayer exclusivity window is unsafe.");
  }

  return {
    ...fields,
    depositor: getAddress(depositor),
    recipient: getAddress(recipient),
    spokePool: ACROSS_SPOKE_POOL.origin,
    quoteTimestamp,
    fillDeadline,
    exclusiveRelayer,
    exclusivityParameter,
    effectiveExclusivityDeadline,
    };
}

/**
 * Parse and validate an upstream `/swap/approval` response. The server calls
 * this before returning a quote, and the client validates the canonical wire
 * quote again before offering a wallet transaction.
 */
export function parseAcrossSwapQuote(
  route: BridgeRoute,
  requestedOutputAmount: bigint,
  depositor: Address,
  recipient: Address,
  raw: unknown,
  providerAuthenticated: boolean,
  protocol: BridgeProtocolEvidence,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): BridgeQuote {
  const body = requireRecord(raw, "response");
  const transaction = requireRecord(body.swapTx, "swapTx");
  if (transaction.simulationSuccess !== true) {
    throw new BridgeQuoteError("Across did not report a successful origin simulation.");
  }

  return validateQuote(
    {
      route,
      requestedOutputAmount,
      inputAmount: requireBigInt(body.inputAmount, "inputAmount"),
      outputAmount: requireBigInt(body.minOutputAmount ?? body.expectedOutputAmount, "minOutputAmount"),
      depositor: getAddress(depositor),
      recipient: getAddress(recipient),
      estimatedFillSeconds: requireUint(body.expectedFillTime ?? 0, "expectedFillTime"),
      quoteExpiryTimestamp: requireUint(body.quoteExpiryTimestamp, "quoteExpiryTimestamp"),
      protocol: requireProtocolEvidence(protocol),
      providerSimulationSucceeded: true,
      providerAuthenticated,
      transaction: {
        chainId: requireUint(transaction.chainId, "swapTx.chainId"),
        to: requireAddress(transaction.to, "swapTx.to"),
        data: requireHex(transaction.data, "swapTx.data"),
        value: requireBigInt(transaction.value ?? "0", "swapTx.value"),
      },
    },
    nowSeconds,
  );
}

export function serializeBridgeQuote(quote: BridgeQuote): BridgeQuoteWire {
  return {
    routeId: quote.route.id,
    requestedOutputAmount: quote.requestedOutputAmount.toString(),
    inputAmount: quote.inputAmount.toString(),
    outputAmount: quote.outputAmount.toString(),
    depositor: quote.depositor,
    recipient: quote.recipient,
    spokePool: quote.spokePool,
    estimatedFillSeconds: quote.estimatedFillSeconds,
    quoteExpiryTimestamp: quote.quoteExpiryTimestamp,
    quoteTimestamp: quote.quoteTimestamp,
    fillDeadline: quote.fillDeadline,
    exclusiveRelayer: quote.exclusiveRelayer,
    exclusivityParameter: quote.exclusivityParameter,
    effectiveExclusivityDeadline: quote.effectiveExclusivityDeadline,
    protocol: quote.protocol,
    providerSimulationSucceeded: quote.providerSimulationSucceeded,
    providerAuthenticated: quote.providerAuthenticated,
    transaction: {
      chainId: quote.transaction.chainId,
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: quote.transaction.value.toString(),
    },
  };
}

export function parseBridgeQuoteWire(
  raw: unknown,
  expected?: {
    readonly route: BridgeRoute;
    readonly requestedOutputAmount: bigint;
    readonly depositor: Address;
    readonly recipient: Address;
  },
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): BridgeQuote {
  const body = requireRecord(raw, "quote");
  const routeId = typeof body.routeId === "string" ? body.routeId : "";
  const route = findBridgeRoute(routeId);
  if (!route) throw new BridgeQuoteError("The server returned an unknown bridge route.");
  if (expected && route.id !== expected.route.id) {
    throw new BridgeQuoteError("The server returned a different bridge route.");
  }

  const transaction = requireRecord(body.transaction, "transaction");
  const requestedOutputAmount = requireBigInt(body.requestedOutputAmount, "requestedOutputAmount");
  const depositor = requireAddress(body.depositor, "depositor");
  const recipient = requireAddress(body.recipient, "recipient");
  const spokePool = requireAddress(body.spokePool, "spokePool");
  if (spokePool !== ACROSS_SPOKE_POOL.origin) {
    throw new BridgeQuoteError("The server returned an unpinned bridge contract.");
  }
  if (
    expected &&
    (requestedOutputAmount !== expected.requestedOutputAmount ||
      depositor !== getAddress(expected.depositor) ||
      recipient !== getAddress(expected.recipient))
  ) {
    throw new BridgeQuoteError("The server returned a quote bound to different funding details.");
  }
  if (typeof body.providerAuthenticated !== "boolean") {
    throw new BridgeQuoteError("The server did not disclose the quote provider's authentication state.");
  }
  if (body.providerSimulationSucceeded !== true) {
    throw new BridgeQuoteError("The server did not prove a successful provider simulation.");
  }

  const quote = validateQuote(
    {
      route,
      requestedOutputAmount,
      inputAmount: requireBigInt(body.inputAmount, "inputAmount"),
      outputAmount: requireBigInt(body.outputAmount, "outputAmount"),
      depositor,
      recipient,
      estimatedFillSeconds: requireUint(body.estimatedFillSeconds, "estimatedFillSeconds"),
      quoteExpiryTimestamp: requireUint(body.quoteExpiryTimestamp, "quoteExpiryTimestamp"),
      protocol: requireProtocolEvidence(body.protocol),
      providerSimulationSucceeded: true,
      providerAuthenticated: body.providerAuthenticated,
      transaction: {
        chainId: requireUint(transaction.chainId, "transaction.chainId"),
        to: requireAddress(transaction.to, "transaction.to"),
        data: requireHex(transaction.data, "transaction.data"),
        value: requireBigInt(transaction.value, "transaction.value"),
      },
    },
    nowSeconds,
  );
  if (quote.fillDeadline !== requireUint(body.fillDeadline, "fillDeadline")) {
    throw new BridgeQuoteError("The displayed fill deadline does not match the bridge transaction.");
  }
  if (
    quote.quoteTimestamp !== requireUint32(body.quoteTimestamp, "quoteTimestamp")
    || quote.exclusiveRelayer !== requireAddress(body.exclusiveRelayer, "exclusiveRelayer")
    || quote.exclusivityParameter
      !== requireUint32(body.exclusivityParameter, "exclusivityParameter")
    || quote.effectiveExclusivityDeadline
      !== requireUint32(body.effectiveExclusivityDeadline, "effectiveExclusivityDeadline")
  ) {
    throw new BridgeQuoteError("The displayed Across timing fields do not match the bridge transaction.");
  }
  return quote;
}

export async function fetchBridgeQuote(
  route: BridgeRoute,
  requestedOutputAmount: bigint,
  depositor: Address,
  recipient: Address,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeQuote> {
  if (requestedOutputAmount <= 0n) {
    throw new BridgeQuoteError("The capsule needs an output amount greater than zero.");
  }

  let response: Response;
  try {
    response = await fetchImpl("/api/bridge/quote", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        routeId: route.id,
        outputAmount: requestedOutputAmount.toString(),
        depositor,
        recipient,
      }),
    });
  } catch (error) {
    throw new BridgeQuoteError(
      `The bridge quote service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof raw === "object" && raw !== null && typeof (raw as { error?: unknown }).error === "string"
        ? (raw as { error: string }).error
        : `The bridge quote service answered ${response.status}.`;
    throw new BridgeQuoteError(message);
  }
  const payload = requireRecord(raw, "response");
  return parseBridgeQuoteWire(
    payload.quote,
    { route, requestedOutputAmount, depositor: getAddress(depositor), recipient: getAddress(recipient) },
  );
}

export const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export type BridgeDeposit = {
  readonly address: Address;
  readonly data: Hex;
  readonly value: bigint;
};

export function buildBridgeDeposit(quote: BridgeQuote, depositor: Address, recipient: Address): BridgeDeposit {
  if (getAddress(depositor) !== quote.depositor || getAddress(recipient) !== quote.recipient) {
    throw new BridgeQuoteError("This bridge quote is bound to a different depositor or capsule.");
  }
  if (recipient === "0x0000000000000000000000000000000000000000") {
    throw new BridgeQuoteError("A bridge deposit needs a destination capsule.");
  }
  return {
    address: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value,
  };
}

export async function ensureBaseChain(provider: EIP1193Provider): Promise<void> {
  const expected = `0x${BRIDGE_ORIGIN_CHAIN_ID.toString(16)}`;
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === expected) return;

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] });
  } catch (switchError) {
    const code = (switchError as { code?: number } | null)?.code;
    if (code !== 4902) throw switchError;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: expected,
          chainName: baseChain.name,
          nativeCurrency: baseChain.nativeCurrency,
          rpcUrls: [...baseChain.rpcUrls.default.http],
          blockExplorerUrls: [baseChain.blockExplorers.default.url],
        },
      ],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] });
  }
}

export function quoteIsStale(
  quote: BridgeQuote,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
  requiredRunwaySeconds = 0,
): boolean {
  if (!Number.isSafeInteger(requiredRunwaySeconds) || requiredRunwaySeconds < 0) {
    throw new BridgeQuoteError("Bridge quote runway must be a non-negative integer.");
  }
  return (
    nowSeconds + requiredRunwaySeconds >= quote.quoteExpiryTimestamp
    || nowSeconds + requiredRunwaySeconds >= quote.fillDeadline
    || nowSeconds + requiredRunwaySeconds
      >= quote.quoteTimestamp
        + Math.min(
          quote.protocol.depositQuoteTimeBuffer,
          MAX_BRIDGE_QUOTE_AGE_SECONDS,
        )
  );
}

export function bridgeFeeBps(quote: BridgeQuote): number {
  if (quote.inputAmount <= 0n || quote.outputAmount >= quote.inputAmount) return 0;
  return Number(((quote.inputAmount - quote.outputAmount) * 10_000n) / quote.inputAmount);
}
