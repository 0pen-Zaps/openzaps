import { describe, expect, it } from "vitest";

import {
  accountFromWalletPayload,
  chainIdFromWalletPayload,
  shouldResetAccountScope,
} from "@/lib/wallet-session";

const OWNER = "0x1111111111111111111111111111111111111111" as const;

describe("accountFromWalletPayload", () => {
  it("checksums the first valid string account", () => {
    expect(accountFromWalletPayload([OWNER.toUpperCase().replace("0X", "0x")])).toBe(OWNER);
  });

  it("fails closed for empty, malformed, or non-array payloads", () => {
    expect(accountFromWalletPayload([])).toBeNull();
    expect(accountFromWalletPayload(["not-an-address"])).toBeNull();
    expect(accountFromWalletPayload({ account: OWNER })).toBeNull();
  });
});

describe("chainIdFromWalletPayload", () => {
  it("parses EIP-1193 hexadecimal chain ids", () => {
    expect(chainIdFromWalletPayload("0x1237")).toBe(4663);
  });

  it("accepts safe numeric test values and rejects ambiguous input", () => {
    expect(chainIdFromWalletPayload(4663)).toBe(4663);
    expect(chainIdFromWalletPayload("4663")).toBeNull();
    expect(chainIdFromWalletPayload("0xnope")).toBeNull();
    expect(chainIdFromWalletPayload(0)).toBeNull();
  });
});

describe("shouldResetAccountScope", () => {
  it("preserves a first connection but resets account scope on departure", () => {
    const second = "0x2222222222222222222222222222222222222222" as const;

    expect(shouldResetAccountScope(null, OWNER)).toBe(false);
    expect(shouldResetAccountScope(OWNER, OWNER)).toBe(false);
    expect(shouldResetAccountScope(OWNER, second)).toBe(true);
    expect(shouldResetAccountScope(OWNER, null)).toBe(true);
  });
});
