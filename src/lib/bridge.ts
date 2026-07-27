import { defineChain, getAddress, isAddress, type Address, type EIP1193Provider, type Hex } from "viem";

import { ROBINHOOD_ASSETS, ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";

/**
 * Funding a Robinhood Chain capsule from Base, over Across.
 *
 * A bridge is NOT a step. `OpenZap.execute()` settles by measuring one ERC-20
 * balance delta on ONE chain (`out = balanceOf(outAsset) - preOut`), so a step
 * whose output lands on a different chain makes that subtraction underflow and
 * reverts the whole run. No adapter can fix that; it is the settlement model.
 *
 * So the bridge sits OUTSIDE the capsule, and its only job is to deliver an
 * ERC-20 into an address the capsule already owns. The capsule address is
 * `CREATE2` over the policy, so it is knowable — and fundable — before anything
 * executes. Arrival IS the funding; the executor then submits the signed run.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO WETH ROUTE HERE. READ THIS BEFORE ADDING ONE.
 *
 * Across offers Base WETH → Robinhood aeWETH, and it looks like the obvious
 * route because aeWETH is exactly what the bounded swap adapter consumes. It
 * cannot be used to fund a capsule, and the failure is silent and expensive.
 *
 * The destination SpokePool's `_transferTokensToRecipient` reads:
 *
 *     if (outputToken == address(wrappedNativeToken)) {
 *         ...
 *         _unwrapwrappedNativeTokenTo(payable(recipientToSend), amountToSend);
 *     } else { ...transfer the ERC-20... }
 *
 * There is NO `recipient.code.length == 0` check — contracts are unwrapped to
 * just like EOAs. And on chain 4663 `wrappedNativeToken()` IS aeWETH
 * (`0x0Bd7D308…AD73`, read from the live SpokePool at
 * `0xD29C85F15DF544bA632C9E25829fd29d767d7978`).
 *
 * So a WETH bridge to a capsule delivers NATIVE ETH. A capsule can receive ETH
 * but can never route it: `TokenAllowlist.setToken(address(0))` reverts
 * `ZeroAddress`, adapters are non-payable, and the only `call{value:}` in the
 * core is `emergencyExit` → owner. The funds would arrive, be unspendable, and
 * come back only through the owner's manual exit.
 *
 * USDG is not the wrapped native token, so it takes the `else` branch and lands
 * as a real ERC-20 the capsule can actually spend. That is the whole reason
 * this module ships a stablecoin route and not the "obvious" one.
 * ---------------------------------------------------------------------------
 */

/** Where funds come FROM. Across supports ~25 origins into 4663; we ship one. */
export const BRIDGE_ORIGIN_CHAIN_ID = 8453;

export const baseChain = defineChain({
  id: BRIDGE_ORIGIN_CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
});

/**
 * Across SpokePools, pinned. Verified live 2026-07-27 against
 * `app.across.to/api/chains` and, for Base, against the deployed implementation
 * (`OP_SpokePool` at `0x77aa19d4…72d8`) which exposes the `depositV3` overload
 * encoded below.
 *
 * These are pinned rather than read from the quote response so that a changed
 * or compromised API cannot redirect a deposit: the quote's own spoke pool is
 * compared against these and a mismatch fails the quote closed.
 */
export const ACROSS_SPOKE_POOL = {
  origin: getAddress("0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64"),
  destination: getAddress("0xD29C85F15DF544bA632C9E25829fd29d767d7978"),
} as const;

export const ACROSS_API_BASE = "https://app.across.to/api";

/**
 * The widest spread this route will accept between what leaves Base and what
 * lands on 4663, in basis points. A live USDC → USDG quote keeps single-digit
 * bps; 300 leaves a wide margin for congestion while still refusing anything
 * that would quietly eat a material share of the deposit. See the check in
 * `fetchBridgeQuote` for why an upper bound alone is not enough.
 */
export const MAX_BRIDGE_SPREAD_BPS = 300;

/** A bridge leg we are willing to offer, with both ends pinned. */
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
  /** The catalog symbol `chains.ts` speaks, so a funded capsule can be matched to a route. */
  readonly catalogSymbol: string;
};

/**
 * The shipped legs. Exactly one today.
 *
 * Base USDC → Robinhood USDG, which then reaches 0xZAPS through the live
 * `RobinhoodV4RouteAdapter` (USDG → aeWETH → 0xZAPS,
 * `0x132e65D4A28ec1687D3B2b2a6e2DfD75afCf4900`, allowlisted, verified
 * 2026-07-27). Both tokens are 6-decimal; USDG's six decimals are a load-bearing
 * money fact and are stated here rather than assumed.
 */
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
 * A validated Across quote.
 *
 * `outputAmount` is the exact quantity the relayer must deliver — Across V3
 * fills are exact-output, not best-effort — which is what lets a capsule freeze
 * `Step.amountIn` at signing time instead of guessing at what will arrive.
 */
export type BridgeQuote = {
  readonly route: BridgeRoute;
  readonly inputAmount: bigint;
  readonly outputAmount: bigint;
  readonly spokePool: Address;
  readonly quoteTimestamp: number;
  readonly fillDeadline: number;
  readonly exclusiveRelayer: Address;
  readonly exclusivityDeadline: number;
  readonly estimatedFillSeconds: number;
  readonly minDeposit: bigint;
  readonly maxDeposit: bigint;
};

export class BridgeQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeQuoteError";
  }
}

/** Read a required decimal-string field, or fail the whole quote. */
function requireBigInt(raw: unknown, field: string): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new BridgeQuoteError(`The bridge quote is missing a usable "${field}", so it cannot be trusted.`);
  }
  return BigInt(raw);
}

function requireUint32(raw: unknown, field: string): number {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff_ff_ff) {
    throw new BridgeQuoteError(`The bridge quote's "${field}" is not a usable uint32.`);
  }
  return value;
}

function requireAddress(raw: unknown, field: string): Address {
  if (typeof raw !== "string" || !isAddress(raw)) {
    throw new BridgeQuoteError(`The bridge quote's "${field}" is not an address.`);
  }
  return getAddress(raw);
}

/**
 * Quote one leg, and refuse anything that does not match what we pinned.
 *
 * Every check here is a redirect defence, not a formality. The response decides
 * where a user's funds are sent and what is expected back, so a quote naming a
 * different spoke pool, a different output token, or a different chain is
 * rejected outright rather than reconciled — an unknown is never treated as the
 * value we hoped for.
 */
export async function fetchBridgeQuote(
  route: BridgeRoute,
  inputAmount: bigint,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeQuote> {
  if (inputAmount <= 0n) {
    throw new BridgeQuoteError("Enter an amount greater than zero before quoting the bridge.");
  }

  const url =
    `${ACROSS_API_BASE}/suggested-fees` +
    `?inputToken=${route.inputToken}` +
    `&outputToken=${route.outputToken}` +
    `&originChainId=${route.originChainId}` +
    `&destinationChainId=${route.destinationChainId}` +
    `&amount=${inputAmount.toString()}`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new BridgeQuoteError(
      `The bridge quote service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new BridgeQuoteError(`The bridge quote service answered ${response.status}. No quote, so no deposit.`);
  }

  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new BridgeQuoteError("The bridge quote service returned something that is not a quote.");
  }
  const data = body as Record<string, unknown>;

  if (data.isAmountTooLow === true) {
    throw new BridgeQuoteError("That amount is below the bridge's minimum deposit.");
  }

  // The output side is the one that decides what the capsule receives. A quote
  // naming any other token or chain is not this route, whatever it calls itself.
  const outputToken = data.outputToken as Record<string, unknown> | undefined;
  const quotedOut = requireAddress(outputToken?.address, "outputToken.address");
  if (quotedOut !== route.outputToken) {
    throw new BridgeQuoteError(
      `The bridge quote names output token ${quotedOut}, not the ${route.outputSymbol} this route delivers.`,
    );
  }
  if (Number(outputToken?.chainId) !== route.destinationChainId) {
    throw new BridgeQuoteError("The bridge quote names a different destination chain than this route.");
  }
  if (Number(outputToken?.decimals) !== route.outputDecimals) {
    throw new BridgeQuoteError(
      `The bridge quote reports ${String(outputToken?.decimals)} decimals for ${route.outputSymbol}; this route is pinned to ${route.outputDecimals}.`,
    );
  }

  // Where the deposit is sent. Compared against the pinned pool so a changed
  // API cannot point a deposit at a contract this build has never seen.
  const spokePool = requireAddress(data.spokePoolAddress, "spokePoolAddress");
  if (spokePool !== ACROSS_SPOKE_POOL.origin) {
    throw new BridgeQuoteError(
      `The bridge quote names spoke pool ${spokePool}, which is not the pinned Base spoke pool. Refusing to deposit.`,
    );
  }

  const outputAmount = requireBigInt(data.outputAmount, "outputAmount");
  if (outputAmount <= 0n) {
    throw new BridgeQuoteError("The bridge quote returns zero output. Nothing would arrive.");
  }
  if (outputAmount > inputAmount) {
    // A bridge charges a fee; it never mints. A quote claiming otherwise is
    // either a unit error or a lie, and both should stop here.
    throw new BridgeQuoteError("The bridge quote claims more output than input, which cannot be right.");
  }

  /**
   * THE FLOOR. Without this, every value in [1, inputAmount] is accepted and
   * copied verbatim into `depositV3` as the exact output the relayer must
   * deliver — so a crafted `outputAmount` of 1 unit takes the entire deposit
   * and hands back dust. The upper bound above guards the direction that costs
   * nobody anything; this guards the direction that costs the user everything.
   *
   * Every other value-moving quote in this codebase is bounded by a floor
   * before signing (the creation-fee conversion floor, the capsule's `minOut`,
   * the 500 bps cap on `guard-slippage`). The bridge is the one hop the policy
   * cannot re-check afterwards, which makes it the last place to leave
   * unbounded. Both legs are 6-decimal stablecoins moving over a liquidity
   * bridge, so a spread beyond this cap is not a market condition — it is a
   * broken or hostile response, and it fails closed.
   */
  const keptBps = ((inputAmount - outputAmount) * 10_000n) / inputAmount;
  if (keptBps > BigInt(MAX_BRIDGE_SPREAD_BPS)) {
    throw new BridgeQuoteError(
      `The bridge quote keeps ${keptBps} bps of the deposit, above the ${MAX_BRIDGE_SPREAD_BPS} bps this route will accept. Refusing to deposit.`,
    );
  }

  const limits = (data.limits ?? {}) as Record<string, unknown>;

  return {
    route,
    inputAmount,
    outputAmount,
    spokePool,
    quoteTimestamp: requireUint32(data.timestamp, "timestamp"),
    fillDeadline: requireUint32(data.fillDeadline, "fillDeadline"),
    exclusiveRelayer: requireAddress(
      data.exclusiveRelayer ?? "0x0000000000000000000000000000000000000000",
      "exclusiveRelayer",
    ),
    exclusivityDeadline: requireUint32(data.exclusivityDeadline ?? 0, "exclusivityDeadline"),
    estimatedFillSeconds: Number(data.estimatedFillTimeSec ?? 0) || 0,
    minDeposit: requireBigInt(limits.minDeposit ?? "0", "limits.minDeposit"),
    maxDeposit: requireBigInt(limits.maxDeposit ?? "0", "limits.maxDeposit"),
  };
}

/**
 * The `depositV3` overload carried by the live Base SpokePool implementation
 * (`OP_SpokePool` `0x77aa19d4…72d8`, read from the EIP-1967 slot 2026-07-27).
 * The newer `deposit(bytes32,…)` form exists too; this one is used because its
 * address-typed arguments need no left-padding dance to encode a recipient.
 */
export const acrossSpokePoolAbi = [
  {
    type: "function",
    name: "depositV3",
    stateMutability: "payable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "recipient", type: "address" },
      { name: "inputToken", type: "address" },
      { name: "outputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputAmount", type: "uint256" },
      { name: "destinationChainId", type: "uint256" },
      { name: "exclusiveRelayer", type: "address" },
      { name: "quoteTimestamp", type: "uint32" },
      { name: "fillDeadline", type: "uint32" },
      { name: "exclusivityDeadline", type: "uint32" },
      { name: "message", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

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
  readonly abi: typeof acrossSpokePoolAbi;
  readonly functionName: "depositV3";
  readonly args: readonly [
    Address,
    Address,
    Address,
    Address,
    bigint,
    bigint,
    bigint,
    Address,
    number,
    number,
    number,
    Hex,
  ];
};

/**
 * Turn a validated quote into the exact deposit call.
 *
 * `recipient` is the capsule, not the user. That is the entire trick: the
 * capsule's address is deterministic, so the bridge can deliver straight into
 * a contract whose policy was signed before the funds ever left Base.
 *
 * The message is empty on purpose. A non-empty message makes the SpokePool call
 * `handleV3AcrossMessage` on the recipient, and a capsule does not implement it
 * — the fill would revert. Arrival is observed by the executor instead.
 */
export function buildBridgeDeposit(quote: BridgeQuote, depositor: Address, recipient: Address): BridgeDeposit {
  if (recipient === "0x0000000000000000000000000000000000000000") {
    throw new BridgeQuoteError("A bridge deposit needs a destination capsule; refusing to send to the zero address.");
  }
  if (quote.minDeposit > 0n && quote.inputAmount < quote.minDeposit) {
    throw new BridgeQuoteError("That amount is below the bridge's minimum deposit.");
  }
  if (quote.maxDeposit > 0n && quote.inputAmount > quote.maxDeposit) {
    throw new BridgeQuoteError("That amount is above what the bridge can currently fill.");
  }

  return {
    address: quote.spokePool,
    abi: acrossSpokePoolAbi,
    functionName: "depositV3",
    args: [
      getAddress(depositor),
      getAddress(recipient),
      quote.route.inputToken,
      quote.route.outputToken,
      quote.inputAmount,
      quote.outputAmount,
      BigInt(quote.route.destinationChainId),
      quote.exclusiveRelayer,
      quote.quoteTimestamp,
      quote.fillDeadline,
      quote.exclusivityDeadline,
      "0x",
    ],
  };
}

/**
 * Put the wallet on Base before a deposit.
 *
 * Mirrors `ensureRobinhoodChain`. Base is a well-known chain in every wallet,
 * so `wallet_addEthereumChain` is only attempted on the 4902 "unrecognised
 * chain" path rather than pre-emptively.
 */
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

/**
 * Has this quote aged out?
 *
 * Across prices a quote at a block and a relayer will not fill past
 * `fillDeadline`. A quote held on screen while the user reads is fine; one
 * deposited against after it expired is a transaction that reverts or sits
 * unfilled, so the deposit path re-checks this rather than trusting that the
 * quote was fresh when it was fetched.
 */
export function quoteIsStale(quote: BridgeQuote, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  return nowSeconds >= quote.fillDeadline;
}

/** The fee the bridge keeps, in basis points of the input. For disclosure only. */
export function bridgeFeeBps(quote: BridgeQuote): number {
  if (quote.inputAmount <= 0n) return 0;
  const kept = quote.inputAmount - quote.outputAmount;
  return Number((kept * 10_000n) / quote.inputAmount);
}
