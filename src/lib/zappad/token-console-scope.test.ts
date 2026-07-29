import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  tokenConsoleScope,
  tokenConsoleSnapshotIsCurrent,
} from "./token-console-scope";

const TOKEN = "0x1000000000000000000000000000000000000001" as Address;
const OLD_LAUNCHER =
  "0x2000000000000000000000000000000000000002" as Address;
const NEW_LAUNCHER =
  "0x3000000000000000000000000000000000000003" as Address;

describe("token console runtime scope", () => {
  it("hides a previously loaded snapshot when runtime verification is revoked", () => {
    const loadedScope = tokenConsoleScope(OLD_LAUNCHER, TOKEN);

    expect(
      tokenConsoleSnapshotIsCurrent({
        launcher: OLD_LAUNCHER,
        token: TOKEN,
        loadedScope,
      }),
    ).toBe(true);
    expect(
      tokenConsoleSnapshotIsCurrent({
        launcher: null,
        token: TOKEN,
        loadedScope,
      }),
    ).toBe(false);
  });

  it("does not expose the prior launcher's snapshot after a launcher switch", () => {
    const loadedScope = tokenConsoleScope(OLD_LAUNCHER, TOKEN);

    expect(
      tokenConsoleSnapshotIsCurrent({
        launcher: NEW_LAUNCHER,
        token: TOKEN,
        loadedScope,
      }),
    ).toBe(false);
  });
});
