import { describe, expect, it } from "vitest";
import { RequestScopeGate } from "./request-scope";

describe("request scope gate", () => {
  it("rejects a stale wallet request after the active account changes", () => {
    const gate = new RequestScopeGate();
    const walletA = gate.begin("launcher|0xwallet-a");

    gate.activate("launcher|0xwallet-b");
    const walletB = gate.begin("launcher|0xwallet-b");

    expect(gate.isCurrent(walletA)).toBe(false);
    expect(gate.isCurrent(walletB)).toBe(true);
  });

  it("lets a refresh supersede an older request in the same scope", () => {
    const gate = new RequestScopeGate();
    const first = gate.begin("launcher|0xwallet");
    const refresh = gate.begin("launcher|0xwallet");

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(refresh)).toBe(true);
  });
});
