import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";

const V3_2_ENV_NAMES = [
  "NEXT_PUBLIC_OPENZAP_V3_2_IMPLEMENTATION",
  "NEXT_PUBLIC_OPENZAP_V3_2_FACTORY",
  "NEXT_PUBLIC_OPENZAP_V3_2_LOTTERY_POT",
  "NEXT_PUBLIC_OPENZAP_V3_2_PRICE_SOURCE_REGISTRY",
  "NEXT_PUBLIC_OPENZAP_V3_2_ORIENTED_PRICE_SOURCE",
  "NEXT_PUBLIC_OPENZAP_V3_2_CREATION_GATEWAY",
  "NEXT_PUBLIC_OPENZAP_V3_2_CREATION_FEE_POT",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("v3.2 deployment environment overrides", () => {
  it("fails closed when every address is explicitly disabled", async () => {
    for (const name of V3_2_ENV_NAMES) vi.stubEnv(name, zeroAddress);
    vi.resetModules();

    const {
      OPENZAP_V3_2_CONTRACTS,
      openZapV3_2Configured,
      optionalContractSetState,
    } = await import("@/lib/robinhood");

    expect(optionalContractSetState(OPENZAP_V3_2_CONTRACTS)).toBe("absent");
    expect(openZapV3_2Configured()).toBe(false);
  });

  it("fails closed when one explicit override makes the deployment set partial", async () => {
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_V3_2_CREATION_FEE_POT", zeroAddress);
    vi.resetModules();

    const {
      OPENZAP_V3_2_CONTRACTS,
      openZapV3_2Configured,
      optionalContractSetState,
    } = await import("@/lib/robinhood");

    expect(optionalContractSetState(OPENZAP_V3_2_CONTRACTS)).toBe("partial");
    expect(openZapV3_2Configured()).toBe(false);
  });
});
