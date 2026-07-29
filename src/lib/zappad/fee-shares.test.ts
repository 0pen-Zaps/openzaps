import { describe, expect, it } from "vitest";
import { parseFeeShareTransfer } from "./fee-shares";

const HOLDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const BALANCE = 80n * 10n ** 18n;

describe("fee-share transfer parsing", () => {
  it("returns an exact 18-decimal transfer", () => {
    expect(
      parseFeeShareTransfer({
        recipient: RECIPIENT,
        amount: "10.125",
        balance: BALANCE,
        holder: HOLDER,
      }),
    ).toEqual({
      valid: true,
      recipient: RECIPIENT,
      amount: 10_125_000_000_000_000_000n,
    });
  });

  it.each([
    ["", "1", "recipient"],
    ["not-an-address", "1", "valid address"],
    ["0x0000000000000000000000000000000000000000", "1", "zero address"],
    [HOLDER, "1", "different wallet"],
    [RECIPIENT, "", "number"],
    [RECIPIENT, "0", "greater than zero"],
    [RECIPIENT, "80.000000000000000001", "exceeds"],
    [RECIPIENT, "0.0000000000000000001", "18 decimal"],
  ])(
    "rejects recipient %s and amount %s",
    (recipient, amount, expectedError) => {
      const parsed = parseFeeShareTransfer({
        recipient,
        amount,
        balance: BALANCE,
        holder: HOLDER,
      });
      expect(parsed.valid).toBe(false);
      if (!parsed.valid) expect(parsed.error).toMatch(new RegExp(expectedError, "i"));
    },
  );
});
