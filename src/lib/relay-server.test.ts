import { describe, expect, it } from "vitest";

import { RelayQueryError, relayListFilter } from "@/lib/relay-server";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as const;

describe("relayListFilter", () => {
  it("is empty for an unfiltered query", () => {
    expect(relayListFilter({ limit: 100 })).toBe("");
  });

  it("accepts only the two real statuses", () => {
    expect(relayListFilter({ status: "open", limit: 100 })).toBe("&status=eq.open");
    expect(relayListFilter({ status: "consumed", limit: 100 })).toBe("&status=eq.consumed");
    // A junk status must be ignored, not passed through into the query string.
    expect(relayListFilter({ status: "everything" as never, limit: 100 })).toBe("");
  });

  it("checksums owner and zap, which are plain address columns", () => {
    expect(relayListFilter({ owner: OWNER.toLowerCase(), limit: 100 })).toBe(`&owner=eq.${OWNER}`);
    expect(relayListFilter({ zap: ZAP.toLowerCase(), limit: 100 })).toBe(`&zap=eq.${ZAP}`);
  });

  it("lowercases executor, because that column is a generated jsonb projection", () => {
    // The executor lives inside the signed intent, so its case is whatever the
    // signer wrote. Comparing it checksummed would silently miss valid pins —
    // the address-comparison bug, in SQL.
    expect(relayListFilter({ executor: AGENT, limit: 100 })).toBe(`&executor=eq.${AGENT.toLowerCase()}`);
    expect(relayListFilter({ executor: AGENT.toLowerCase(), limit: 100 })).toBe(
      `&executor=eq.${AGENT.toLowerCase()}`,
    );
  });

  it("combines filters in a stable order", () => {
    expect(relayListFilter({ status: "open", owner: OWNER, zap: ZAP, executor: AGENT, limit: 100 })).toBe(
      `&status=eq.open&owner=eq.${OWNER}&zap=eq.${ZAP}&executor=eq.${AGENT.toLowerCase()}`,
    );
  });

  it("rejects a malformed address rather than injecting it", () => {
    expect(() => relayListFilter({ owner: "not-an-address", limit: 100 })).toThrow(RelayQueryError);
    expect(() => relayListFilter({ executor: "0xdeadbeef", limit: 100 })).toThrow(RelayQueryError);
    expect(() => relayListFilter({ zap: `${ZAP}&status=eq.open`, limit: 100 })).toThrow(RelayQueryError);
  });

  it("names the offending parameter so the route can say which one", () => {
    expect(() => relayListFilter({ zap: "nope", limit: 100 })).toThrow("zap must be a valid address.");
  });

  it("treats null and undefined as absent", () => {
    expect(relayListFilter({ owner: null, zap: undefined, executor: null, limit: 100 })).toBe("");
  });
});

