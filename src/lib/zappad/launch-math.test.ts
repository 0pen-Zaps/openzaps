import { describe, expect, it } from "vitest";
import {
  alignTickDown,
  feeTierSpacing,
  isRecoverableLaunchSaltError,
  isSortedBelow,
  marketCapToFloorTick,
  parseMetadataUri,
  predictFactoryTokenAddress,
} from "./launch-math";

describe("launch market math", () => {
  it("aligns positive and negative ticks down like Solidity", () => {
    expect(alignTickDown(121, 60)).toBe(120);
    expect(alignTickDown(-121, 60)).toBe(-180);
    expect(alignTickDown(-120, 60)).toBe(-120);
  });

  it("returns a spacing-aligned floor tick for WETH and USDG", () => {
    const wethTick = marketCapToFloorTick(5, 18, 10_000);
    const usdgTick = marketCapToFloorTick(5_000, 6, 10_000);

    expect(Math.abs(wethTick % feeTierSpacing(10_000))).toBe(0);
    expect(Math.abs(usdgTick % feeTierSpacing(10_000))).toBe(0);
    expect(usdgTick).toBeLessThan(wethTick);
  });

  it("clamps extreme market caps inside usable tick bounds", () => {
    expect(marketCapToFloorTick(Number.MAX_VALUE, 18, 500)).toBeLessThan(887_270);
    expect(marketCapToFloorTick(Number.MIN_VALUE, 18, 500)).toBeGreaterThanOrEqual(
      -887_270,
    );
  });
});

describe("CREATE2 prediction", () => {
  it("matches the ZapTokenFactory effective salt construction", () => {
    const predicted = predictFactoryTokenAddress({
      factory: "0x1111111111111111111111111111111111111111",
      creator: "0x2222222222222222222222222222222222222222",
      userSalt:
        "0x000000000000000000000000000000000000000000000000000000000000002a",
      initCodeHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
    });

    expect(predicted).toBe("0x2C5C7ee2aa2b1c9f35F3aF24d62F9fc1f9d917d8");
  });

  it("compares addresses by uint160 ordering", () => {
    expect(
      isSortedBelow(
        "0x0000000000000000000000000000000000000001",
        "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      ),
    ).toBe(true);
    expect(
      isSortedBelow(
        "0xffffffffffffffffffffffffffffffffffffffff",
        "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      ),
    ).toBe(false);
  });
});

describe("metadata URI parsing", () => {
  it.each([
    ["ipfs://bafybeigdyrzt/metadata.json", "ipfs"],
    ["ar://aBc_123-xyz", "arweave"],
    ["https://example.com/token.json", "https"],
  ])("accepts %s as %s", (uri, kind) => {
    expect(parseMetadataUri(uri)).toMatchObject({ valid: true, kind });
  });

  it("trims input and rejects insecure or malformed metadata", () => {
    expect(parseMetadataUri("  ipfs://bafy123  ").normalized).toBe(
      "ipfs://bafy123",
    );
    expect(parseMetadataUri("http://example.com/token.json").valid).toBe(false);
    expect(parseMetadataUri("https://").valid).toBe(false);
    expect(parseMetadataUri("").error).toMatch(/required/i);
  });
});

describe("recoverable launch salt failures", () => {
  it.each([
    "PoolAlreadyInitialized",
    "TokenAlreadyExists",
    "TokenNotBelowPair",
  ])("recognizes decoded %s errors through a viem-style cause chain", (errorName) => {
    expect(
      isRecoverableLaunchSaltError({
        shortMessage: "Contract function reverted",
        cause: { data: { errorName } },
      }),
    ).toBe(true);
  });

  it("does not discard the salt for slippage or wallet failures", () => {
    expect(
      isRecoverableLaunchSaltError(
        new Error("The contract function reverted: Too little received"),
      ),
    ).toBe(false);
    expect(isRecoverableLaunchSaltError(new Error("User rejected request"))).toBe(
      false,
    );
  });
});
