import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from "viem";

import {
  ACROSS_SPOKE_POOL,
  BRIDGE_SUBMISSION_RUNWAY_SECONDS,
  BRIDGE_ROUTES,
  MAX_BRIDGE_EXCLUSIVITY_SECONDS,
  MAX_BRIDGE_QUOTE_AGE_SECONDS,
  MAX_BRIDGE_SPREAD_BPS,
  MIN_BRIDGE_FILL_RUNWAY_SECONDS,
  acrossSwapDepositAbi,
  bridgeApprovalAmounts,
  bridgeFeeBps,
  buildBridgeDeposit,
  fetchBridgeQuote,
  findBridgeRoute,
  parseAcrossSwapQuote,
  parseBridgeQuoteWire,
  quoteIsStale,
  serializeBridgeQuote,
  type BridgeProtocolEvidence,
  type BridgeQuote,
} from "@/lib/bridge";
import {
  acrossBridgeApiEnabled,
  fetchAcrossBridgeQuote,
  readAcrossProtocolEvidence,
  type AcrossProtocolReader,
} from "@/lib/bridge-server";
import { ROBINHOOD_ASSETS, ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";

const ROUTE = BRIDGE_ROUTES[0];
const CAPSULE = getAddress("0x1111111111111111111111111111111111111111");
const DEPOSITOR = getAddress("0x2222222222222222222222222222222222222222");
const OTHER = getAddress("0x3333333333333333333333333333333333333333");
const NOW = Math.floor(Date.now() / 1_000);
const REQUESTED_OUTPUT = 100_000_000n;
const INPUT_AMOUNT = 100_550_274n;
const OUTPUT_AMOUNT = 100_481_999n;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;
const PROTOCOL: BridgeProtocolEvidence = {
  blockNumber: "49246707",
  blockHash: BLOCK_HASH,
  blockTimestamp: NOW,
  depositQuoteTimeBuffer: 3_600,
  fillDeadlineBuffer: 21_600,
  maxExclusivityPeriodSeconds: 31_536_000,
};

function addressWord(address: Address): Hex {
  return `0x${"0".repeat(24)}${address.slice(2)}` as Hex;
}

function depositData({
  depositor = DEPOSITOR,
  recipient = CAPSULE,
  inputToken = ROUTE.inputToken,
  outputToken = ROUTE.outputToken,
  inputAmount = INPUT_AMOUNT,
  outputAmount = OUTPUT_AMOUNT,
  destinationChainId = BigInt(ROBINHOOD_CHAIN_ID),
  exclusiveRelayer = addressWord(zeroAddress),
  quoteTimestamp = NOW,
  fillDeadline = NOW + 7_200,
  exclusivityParameter = 0,
  message = "0x" as Hex,
}: {
  depositor?: Address;
  recipient?: Address;
  inputToken?: Address;
  outputToken?: Address;
  inputAmount?: bigint;
  outputAmount?: bigint;
  destinationChainId?: bigint;
  exclusiveRelayer?: Hex;
  quoteTimestamp?: number;
  fillDeadline?: number;
  exclusivityParameter?: number;
  message?: Hex;
} = {}): Hex {
  const encoded = encodeFunctionData({
    abi: acrossSwapDepositAbi,
    functionName: "deposit",
    args: [
      addressWord(depositor),
      addressWord(recipient),
      addressWord(inputToken),
      addressWord(outputToken),
      inputAmount,
      outputAmount,
      destinationChainId,
      exclusiveRelayer,
      quoteTimestamp,
      fillDeadline,
      exclusivityParameter,
      message,
    ],
  });
  // Across appends tracking bytes after the ABI payload. The contract ignores
  // the suffix and viem still decodes the bound deposit arguments.
  return `${encoded}73c0de` as Hex;
}

function protocolReader(
  evidence: BridgeProtocolEvidence = PROTOCOL,
  options: { reorgHash?: Hex; fail?: Error } = {},
): AcrossProtocolReader {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(BigInt(evidence.blockNumber)),
    getBlock: vi
      .fn()
      .mockResolvedValueOnce({
        number: BigInt(evidence.blockNumber),
        hash: evidence.blockHash,
        timestamp: BigInt(evidence.blockTimestamp),
      })
      .mockResolvedValueOnce({
        number: BigInt(evidence.blockNumber),
        hash: options.reorgHash ?? evidence.blockHash,
        timestamp: BigInt(evidence.blockTimestamp),
      }),
    readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName?: string }) => {
      if (options.fail) throw options.fail;
      if (functionName === "depositQuoteTimeBuffer") return BigInt(evidence.depositQuoteTimeBuffer);
      if (functionName === "fillDeadlineBuffer") return BigInt(evidence.fillDeadlineBuffer);
      if (functionName === "MAX_EXCLUSIVITY_PERIOD_SECONDS") {
        return BigInt(evidence.maxExclusivityPeriodSeconds);
      }
      throw new Error(`unexpected getter ${functionName}`);
    }),
  };
}

function quoteBody({
  inputAmount = INPUT_AMOUNT,
  outputAmount = OUTPUT_AMOUNT,
  data = depositData({ inputAmount, outputAmount }),
  to = ACROSS_SPOKE_POOL.origin,
  chainId = 8453,
  value,
  expiry = NOW + 120,
  expectedFillTime = 1,
  simulationSuccess = true,
}: {
  inputAmount?: bigint;
  outputAmount?: bigint;
  data?: Hex;
  to?: Address;
  chainId?: number;
  value?: string;
  expiry?: number;
  expectedFillTime?: number;
  simulationSuccess?: boolean;
} = {}) {
  return {
    inputAmount: inputAmount.toString(),
    expectedOutputAmount: outputAmount.toString(),
    minOutputAmount: outputAmount.toString(),
    expectedFillTime,
    quoteExpiryTimestamp: expiry,
    swapTx: {
      ecosystem: "evm",
      simulationSuccess,
      chainId,
      to,
      data,
      ...(value === undefined ? {} : { value }),
    },
  };
}

function responseReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: ok ? status : Math.max(400, status),
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function validQuote(authenticated = true): BridgeQuote {
  return parseAcrossSwapQuote(
    ROUTE,
    REQUESTED_OUTPUT,
    DEPOSITOR,
    CAPSULE,
    quoteBody(),
    authenticated,
    PROTOCOL,
    NOW,
  );
}

describe("the shipped bridge route", () => {
  it("delivers real USDG, never wrapped native aeWETH", () => {
    expect(ROUTE.outputToken).toBe(ROBINHOOD_ASSETS.usdg);
    expect(ROUTE.outputToken).not.toBe(ROBINHOOD_ASSETS.weth);
    expect(ROUTE.outputDecimals).toBe(6);
    expect(ROUTE.destinationChainId).toBe(ROBINHOOD_CHAIN_ID);
  });

  it("resolves only a pinned route", () => {
    expect(findBridgeRoute(ROUTE.id)).toEqual(ROUTE);
    expect(findBridgeRoute("across-base-weth-robinhood-aeweth")).toBeNull();
  });
});

describe("parseAcrossSwapQuote", () => {
  it("binds the minimum-output quote to its wallet, capsule, tokens, chains, and SpokePool", () => {
    const quote = validQuote();

    expect(quote.requestedOutputAmount).toBe(REQUESTED_OUTPUT);
    expect(quote.inputAmount).toBe(INPUT_AMOUNT);
    expect(quote.outputAmount).toBe(OUTPUT_AMOUNT);
    expect(quote.depositor).toBe(DEPOSITOR);
    expect(quote.recipient).toBe(CAPSULE);
    expect(quote.spokePool).toBe(ACROSS_SPOKE_POOL.origin);
    expect(quote.fillDeadline).toBe(NOW + 7_200);
  });

  it("refuses a redirect to another contract", () => {
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ to: OTHER }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/pinned Base SpokePool/);
  });

  it("refuses calldata bound to another recipient", () => {
    const data = depositData({ recipient: OTHER });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/recipient/);
  });

  it("refuses calldata bound to another token or chain", () => {
    const wrongToken = depositData({ outputToken: ROBINHOOD_ASSETS.zaps });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: wrongToken }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/outputToken/);

    const wrongChain = depositData({ destinationChainId: 8453n });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: wrongChain }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/destination chain/);
  });

  it("refuses a callback message because a capsule cannot execute it", () => {
    const data = depositData({ message: "0x1234" });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/callback message/);
  });

  it("refuses output below the capsule requirement", () => {
    const outputAmount = REQUESTED_OUTPUT - 1n;
    const data = depositData({ outputAmount });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ outputAmount, data }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/less than the capsule/);
  });

  it("refuses a spread past the bounded stablecoin route limit", () => {
    const inputAmount = 104_000_000n;
    const outputAmount = 100_000_000n;
    const data = depositData({ inputAmount, outputAmount });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ inputAmount, outputAmount, data }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(new RegExp(`${MAX_BRIDGE_SPREAD_BPS} bps`));
  });

  it("refuses native value and expired quotes", () => {
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ value: "1" }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/native value/);
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ expiry: NOW }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/expired/);
  });

  it("refuses calldata the provider says failed origin simulation", () => {
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ simulationSuccess: false }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/successful origin simulation/);
  });

  it("binds quote age to the pinned Base block and the stricter product cap", () => {
    const atLimit = depositData({ quoteTimestamp: NOW - MAX_BRIDGE_QUOTE_AGE_SECONDS });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: atLimit }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).not.toThrow();

    for (const quoteTimestamp of [
      NOW + 1,
      NOW - MAX_BRIDGE_QUOTE_AGE_SECONDS - 1,
    ]) {
      const data = depositData({ quoteTimestamp });
      expect(() =>
        parseAcrossSwapQuote(
          ROUTE,
          REQUESTED_OUTPUT,
          DEPOSITOR,
          CAPSULE,
          quoteBody({ data }),
          true,
          PROTOCOL,
          NOW,
        ),
      ).toThrow(/quote timestamp/i);
    }
  });

  it("enforces fill runway and the live SpokePool fill buffer at one-second boundaries", () => {
    const atMinimum = depositData({ fillDeadline: NOW + MIN_BRIDGE_FILL_RUNWAY_SECONDS });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: atMinimum }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/too little time/);

    const aboveMinimum = depositData({
      fillDeadline: NOW + MIN_BRIDGE_FILL_RUNWAY_SECONDS + 1,
    });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: aboveMinimum }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).not.toThrow();

    const atBuffer = depositData({ fillDeadline: NOW + PROTOCOL.fillDeadlineBuffer });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: atBuffer }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).not.toThrow();

    const overBuffer = depositData({ fillDeadline: NOW + PROTOCOL.fillDeadlineBuffer + 1 });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: overBuffer }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/SpokePool buffer/);
  });

  it("requires extra fill runway when the provider estimates a slower fill", () => {
    const data = depositData({ fillDeadline: NOW + 700 });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data, expectedFillTime: 400 }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/too little time/);
  });

  it("rejects noncanonical or ambiguous exclusive-relayer words", () => {
    const noncanonical = depositData({
      exclusiveRelayer: `0x${"11".repeat(32)}` as Hex,
      exclusivityParameter: 1,
    });
    expect(() =>
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: noncanonical }),
        true,
        PROTOCOL,
        NOW,
      ),
    ).toThrow(/canonical EVM address word/);

    for (const data of [
      depositData({ exclusivityParameter: 1 }),
      depositData({ exclusiveRelayer: addressWord(OTHER) }),
    ]) {
      expect(() =>
        parseAcrossSwapQuote(
          ROUTE,
          REQUESTED_OUTPUT,
          DEPOSITOR,
          CAPSULE,
          quoteBody({ data }),
          true,
          PROTOCOL,
          NOW,
        ),
      ).toThrow(/ambiguous exclusive-relayer/);
    }
  });

  it("resolves relative and absolute exclusivity exactly, then applies the product cap", () => {
    for (const exclusivityParameter of [1, MAX_BRIDGE_EXCLUSIVITY_SECONDS]) {
      const data = depositData({
        exclusiveRelayer: addressWord(OTHER),
        exclusivityParameter,
      });
      const quote = parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data }),
        true,
        PROTOCOL,
        NOW,
      );
      expect(quote.exclusiveRelayer).toBe(OTHER);
      expect(quote.effectiveExclusivityDeadline).toBe(NOW + exclusivityParameter);
    }

    const absoluteDeadline = NOW + MAX_BRIDGE_EXCLUSIVITY_SECONDS;
    const absolute = depositData({
      exclusiveRelayer: addressWord(OTHER),
      exclusivityParameter: absoluteDeadline,
    });
    expect(
      parseAcrossSwapQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        quoteBody({ data: absolute }),
        true,
        PROTOCOL,
        NOW,
      ).effectiveExclusivityDeadline,
    ).toBe(absoluteDeadline);

    for (const exclusivityParameter of [
      MAX_BRIDGE_EXCLUSIVITY_SECONDS + 1,
      PROTOCOL.maxExclusivityPeriodSeconds,
      absoluteDeadline + 1,
      PROTOCOL.maxExclusivityPeriodSeconds + 1,
    ]) {
      const data = depositData({
        exclusiveRelayer: addressWord(OTHER),
        exclusivityParameter,
      });
      expect(() =>
        parseAcrossSwapQuote(
          ROUTE,
          REQUESTED_OUTPUT,
          DEPOSITOR,
          CAPSULE,
          quoteBody({ data }),
          true,
          PROTOCOL,
          NOW,
        ),
      ).toThrow(/exclusivity window/);
    }
  });
});

describe("the browser quote boundary", () => {
  it("round-trips a canonical wire quote and revalidates its calldata", () => {
    const quote = validQuote();
    expect(parseBridgeQuoteWire(serializeBridgeQuote(quote), undefined, NOW)).toEqual(quote);
  });

  it("calls the same-origin server rather than exposing Across credentials", async () => {
    const fetchSpy = responseReturning({ quote: serializeBridgeQuote(validQuote()) });
    const quote = await fetchBridgeQuote(ROUTE, REQUESTED_OUTPUT, DEPOSITOR, CAPSULE, fetchSpy);

    expect(quote.outputAmount).toBe(OUTPUT_AMOUNT);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/bridge/quote",
      expect.objectContaining({ method: "POST" }),
    );
    const request = vi.mocked(fetchSpy).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      routeId: ROUTE.id,
      outputAmount: REQUESTED_OUTPUT.toString(),
      depositor: DEPOSITOR,
      recipient: CAPSULE,
    });
  });

  it("rejects a server quote bound to another wallet", async () => {
    const wire = serializeBridgeQuote(validQuote());
    await expect(
      fetchBridgeQuote(ROUTE, REQUESTED_OUTPUT, OTHER, CAPSULE, responseReturning({ quote: wire })),
    ).rejects.toThrow(/different funding details/);
  });

  it("surfaces non-OK and unreachable server responses", async () => {
    await expect(
      fetchBridgeQuote(
        ROUTE,
        REQUESTED_OUTPUT,
        DEPOSITOR,
        CAPSULE,
        responseReturning({ error: "provider unavailable" }, false, 503),
      ),
    ).rejects.toThrow(/provider unavailable/);

    const boom = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(fetchBridgeQuote(ROUTE, REQUESTED_OUTPUT, DEPOSITOR, CAPSULE, boom)).rejects.toThrow(
      /could not be reached/,
    );
  });
});

describe("the server-side Across boundary", () => {
  it("pins live SpokePool timing limits to one canonical Base block", async () => {
    const reader = protocolReader();
    await expect(readAcrossProtocolEvidence(reader, NOW)).resolves.toEqual(PROTOCOL);
    expect(reader.readContract).toHaveBeenCalledTimes(3);
    for (const [call] of vi.mocked(reader.readContract).mock.calls) {
      expect(call).toEqual(expect.objectContaining({ blockNumber: BigInt(PROTOCOL.blockNumber) }));
    }
  });

  it("rejects stale or mixed-fork SpokePool timing evidence", async () => {
    const stale = { ...PROTOCOL, blockTimestamp: NOW - 301 };
    await expect(readAcrossProtocolEvidence(protocolReader(stale), NOW)).rejects.toThrow(/server clock/);
    await expect(
      readAcrossProtocolEvidence(
        protocolReader(PROTOCOL, { reorgHash: `0x${"cd".repeat(32)}` as Hex }),
        NOW,
      ),
    ).rejects.toThrow(/changed/);
  });

  it("keeps the direct production API off until flags and complete credentials are explicit", () => {
    expect(acrossBridgeApiEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(acrossBridgeApiEnabled({
      NODE_ENV: "production",
      NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED: "true",
    })).toBe(false);
    expect(acrossBridgeApiEnabled({
      NODE_ENV: "production",
      OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED: "true",
    })).toBe(false);
    expect(acrossBridgeApiEnabled({
      NODE_ENV: "production",
      NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED: "true",
      OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED: "true",
    })).toBe(false);
    expect(acrossBridgeApiEnabled({
      NODE_ENV: "production",
      NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED: "true",
      OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED: "true",
      ACROSS_API_KEY: "test-key",
    })).toBe(false);
    expect(acrossBridgeApiEnabled({
      NODE_ENV: "production",
      NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED: "true",
      OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED: "true",
      ACROSS_API_KEY: "test-key",
      ACROSS_INTEGRATOR_ID: "0xnot-valid",
    })).toBe(false);
    expect(acrossBridgeApiEnabled({
      NODE_ENV: "production",
      NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED: "true",
      OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED: "true",
      ACROSS_API_KEY: "test-key",
      ACROSS_INTEGRATOR_ID: "0xbeef",
    })).toBe(true);
    expect(acrossBridgeApiEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("uses minOutput, origin refunds, an Authorization header, and a two-byte integrator ID", async () => {
    const fetchSpy = responseReturning(quoteBody());
    const quote = await fetchAcrossBridgeQuote(
      { routeId: ROUTE.id, outputAmount: REQUESTED_OUTPUT, depositor: DEPOSITOR, recipient: CAPSULE },
      fetchSpy,
      { ACROSS_API_KEY: "test-key", ACROSS_INTEGRATOR_ID: "0xbeef" },
      NOW,
      protocolReader(),
    );

    expect(quote.providerAuthenticated).toBe(true);
    const [url, init] = vi.mocked(fetchSpy).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/swap/approval");
    expect(parsed.searchParams.get("tradeType")).toBe("minOutput");
    expect(parsed.searchParams.get("amount")).toBe(REQUESTED_OUTPUT.toString());
    expect(parsed.searchParams.get("recipient")).toBe(CAPSULE);
    expect(parsed.searchParams.get("refundAddress")).toBe(DEPOSITOR);
    expect(parsed.searchParams.get("refundOnOrigin")).toBe("true");
    expect(parsed.searchParams.get("integratorId")).toBe("0xbeef");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });

  it("discloses an unauthenticated development quote and rejects a half-configured pair", async () => {
    const quote = await fetchAcrossBridgeQuote(
      { routeId: ROUTE.id, outputAmount: REQUESTED_OUTPUT, depositor: DEPOSITOR, recipient: CAPSULE },
      responseReturning(quoteBody()),
      {},
      NOW,
      protocolReader(),
    );
    expect(quote.providerAuthenticated).toBe(false);

    const fetchSpy = responseReturning(quoteBody());
    await expect(
      fetchAcrossBridgeQuote(
        { routeId: ROUTE.id, outputAmount: REQUESTED_OUTPUT, depositor: DEPOSITOR, recipient: CAPSULE },
        fetchSpy,
        { ACROSS_API_KEY: "test-key" },
        NOW,
        protocolReader(),
      ),
    ).rejects.toThrow(/both an API key and an integrator ID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed without authenticated credentials in production", async () => {
    const fetchSpy = responseReturning(quoteBody());
    await expect(
      fetchAcrossBridgeQuote(
        { routeId: ROUTE.id, outputAmount: REQUESTED_OUTPUT, depositor: DEPOSITOR, recipient: CAPSULE },
        fetchSpy,
        { NODE_ENV: "production" },
        NOW,
        protocolReader(),
      ),
    ).rejects.toThrow(/production credentials/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const removedBypassAttempt = {
      NODE_ENV: "production",
      ACROSS_ALLOW_UNAUTHENTICATED: "true",
    };
    await expect(
      fetchAcrossBridgeQuote(
        { routeId: ROUTE.id, outputAmount: REQUESTED_OUTPUT, depositor: DEPOSITOR, recipient: CAPSULE },
        fetchSpy,
        removedBypassAttempt,
        NOW,
        protocolReader(),
      ),
    ).rejects.toThrow(/production credentials/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bounds declared and streamed Across responses before parsing them", async () => {
    const declared = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(256 * 1024 + 1),
        },
      }),
    ) as unknown as typeof fetch;
    await expect(
      fetchAcrossBridgeQuote(
        { routeId: ROUTE.id, outputAmount: REQUESTED_OUTPUT, depositor: DEPOSITOR, recipient: CAPSULE },
        declared,
        {},
        NOW,
        protocolReader(),
      ),
    ).rejects.toThrow(/larger than 256 KiB/);

    const chunk = new Uint8Array(140 * 1024).fill(0x20);
    const streamed = vi.fn().mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }), { headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    await expect(
      fetchAcrossBridgeQuote(
        { routeId: ROUTE.id, outputAmount: REQUESTED_OUTPUT, depositor: DEPOSITOR, recipient: CAPSULE },
        streamed,
        {},
        NOW,
        protocolReader(),
      ),
    ).rejects.toThrow(/larger than 256 KiB/);
  });
});

describe("deposit execution and status helpers", () => {
  it("resets every mismatched non-zero allowance before granting the exact quote amount", () => {
    expect(bridgeApprovalAmounts(0n, INPUT_AMOUNT)).toEqual([INPUT_AMOUNT]);
    expect(bridgeApprovalAmounts(INPUT_AMOUNT, INPUT_AMOUNT)).toEqual([]);
    expect(bridgeApprovalAmounts(INPUT_AMOUNT - 1n, INPUT_AMOUNT)).toEqual([0n, INPUT_AMOUNT]);
    expect(bridgeApprovalAmounts(INPUT_AMOUNT + 1n, INPUT_AMOUNT)).toEqual([0n, INPUT_AMOUNT]);
    expect(() => bridgeApprovalAmounts(0n, 0n)).toThrow(/required amount must be positive/);
  });

  it("returns only the already-validated raw transaction for the bound parties", () => {
    const quote = validQuote();
    expect(buildBridgeDeposit(quote, DEPOSITOR, CAPSULE)).toEqual({
      address: ACROSS_SPOKE_POOL.origin,
      data: quote.transaction.data,
      value: 0n,
    });
    expect(() => buildBridgeDeposit(quote, OTHER, CAPSULE)).toThrow(/different depositor/);
  });

  it("reports the spread and expires at the provider quote deadline", () => {
    const quote = validQuote();
    expect(bridgeFeeBps(quote)).toBe(6);
    expect(quoteIsStale(quote, quote.quoteExpiryTimestamp - 1)).toBe(false);
    expect(quoteIsStale(quote, quote.quoteExpiryTimestamp)).toBe(true);
    expect(
      quoteIsStale(
        quote,
        quote.quoteExpiryTimestamp - BRIDGE_SUBMISSION_RUNWAY_SECONDS - 1,
        BRIDGE_SUBMISSION_RUNWAY_SECONDS,
      ),
    ).toBe(false);
    expect(
      quoteIsStale(
        quote,
        quote.quoteExpiryTimestamp - BRIDGE_SUBMISSION_RUNWAY_SECONDS,
        BRIDGE_SUBMISSION_RUNWAY_SECONDS,
      ),
    ).toBe(true);

    const agingData = depositData({
      quoteTimestamp: NOW - MAX_BRIDGE_QUOTE_AGE_SECONDS + 1,
    });
    const agingQuote = parseAcrossSwapQuote(
      ROUTE,
      REQUESTED_OUTPUT,
      DEPOSITOR,
      CAPSULE,
      quoteBody({ data: agingData }),
      true,
      PROTOCOL,
      NOW,
    );
    expect(quoteIsStale(agingQuote, NOW)).toBe(false);
    expect(quoteIsStale(agingQuote, NOW + 1)).toBe(true);
  });
});
