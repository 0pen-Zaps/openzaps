import { describe, expect, it } from "vitest";

import { formatPulseAmount } from "@/lib/vault-server";

describe("formatPulseAmount — the vault pulse's only derived number", () => {
  it("formats whole and fractional parts at the token's real decimals", () => {
    expect(formatPulseAmount(0n, 18)).toBe("0");
    expect(formatPulseAmount(1_234_567n, 6)).toBe("1.234567");
    expect(formatPulseAmount(1_910_218n, 6)).toBe("1.910218");
    expect(formatPulseAmount(500_000_000_000_000n, 18)).toBe("0.0005");
  });

  it("trims trailing zeros and never pads", () => {
    expect(formatPulseAmount(1_000_000n, 6)).toBe("1");
    expect(formatPulseAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("caps the fraction without rounding up (display, not accounting)", () => {
    expect(formatPulseAmount(1_999_999_999_999_999_999n, 18, 6)).toBe("1.999999");
  });

  it("groups large whole parts", () => {
    expect(formatPulseAmount(21_951_737_506_000_000_000_000n, 18)).toBe("21,951.737506");
  });
});
