import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RelayQueryError,
  decodeRelayCursor,
  encodeRelayCursor,
  insertRelayIntentImmutable,
  relayListFilter,
  relayListPath,
  relaySignedArtifactsEqual,
} from "@/lib/relay-server";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as const;
const ID = "123e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("relayListFilter", () => {
  it("is empty for an unfiltered query", () => {
    expect(relayListFilter({ limit: 100 })).toBe("");
  });

  it("accepts only the three durable relay statuses", () => {
    expect(relayListFilter({ status: "open", limit: 100 })).toBe("&status=eq.open");
    expect(relayListFilter({ status: "consumed", limit: 100 })).toBe("&status=eq.consumed");
    expect(relayListFilter({ status: "expired", limit: 100 })).toBe("&status=eq.expired");
    // A junk status must be ignored, not passed through into the query string.
    expect(relayListFilter({ status: "everything" as never, limit: 100 })).toBe("");
  });

  it("checksums owners and lowercases the zap identity used by the unique key", () => {
    expect(relayListFilter({ owner: OWNER.toLowerCase(), limit: 100 })).toBe(`&owner=eq.${OWNER}`);
    expect(relayListFilter({ zap: ZAP, limit: 100 })).toBe(`&zap=eq.${ZAP.toLowerCase()}`);
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
      `&status=eq.open&owner=eq.${OWNER}&zap=eq.${ZAP.toLowerCase()}&executor=eq.${AGENT.toLowerCase()}`,
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

describe("relay keyset cursor", () => {
  const createdAt = "2026-07-28T20:30:40.123Z";
  const id = "123e4567-e89b-42d3-a456-426614174000";

  it("round-trips a stable created_at + UUID tie-breaker", () => {
    const cursor = encodeRelayCursor({ createdAt, id });
    expect(decodeRelayCursor(cursor)).toEqual({ createdAt, id });
  });

  it("preserves Postgres sub-millisecond timestamp precision", () => {
    const precise = "2026-07-28T20:30:40.123456+00:00";
    expect(decodeRelayCursor(encodeRelayCursor({ createdAt: precise, id }))).toEqual({ createdAt: precise, id });
  });

  it("rejects malformed and structurally invalid cursors", () => {
    expect(() => decodeRelayCursor("not-base64-json")).toThrow("cursor is malformed");
    expect(() =>
      decodeRelayCursor(Buffer.from(JSON.stringify({ v: 1, createdAt, id: "not-a-uuid" })).toString("base64url")),
    ).toThrow("cursor is malformed");
  });

  it("builds a deterministic look-ahead keyset page", () => {
    const path = relayListPath({
      status: "open",
      executor: AGENT,
      limit: 2,
      cursor: encodeRelayCursor({ createdAt, id }),
    });
    const url = new URL(`https://relay.invalid/${path}`);
    expect(url.searchParams.get("order")).toBe("created_at.desc,id.desc");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("executor")).toBe(`eq.${AGENT.toLowerCase()}`);
    expect(url.searchParams.get("or")).toBe(
      `(created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id}))`,
    );
  });
});

describe("immutable relay admission", () => {
  const record = {
    zap: ZAP,
    owner: OWNER,
    chainId: 4663,
    kind: "trigger" as const,
    nonce: "7",
    intent: {
      zap: ZAP,
      chainId: "4663",
      nonce: "7",
      policyHash: `0x${"11".repeat(32)}`,
      executor: AGENT,
    },
    signature: `0x${"ab".repeat(65)}`,
    status: "open" as const,
  };

  it("normalizes canonical JSON key order and hex casing, but not signed terms", () => {
    expect(relaySignedArtifactsEqual(record, {
      ...record,
      zap: ZAP.toLowerCase(),
      intent: {
        executor: AGENT.toLowerCase(),
        policyHash: `0x${"11".repeat(32)}`.toUpperCase().replace("0X", "0x"),
        nonce: "7",
        chainId: "4663",
        zap: ZAP.toLowerCase(),
      },
      signature: record.signature.toUpperCase().replace("0X", "0x"),
    })).toBe(true);
    expect(relaySignedArtifactsEqual(record, {
      ...record,
      intent: { ...record.intent, nonce: "8" },
    })).toBe(false);
  });

  it("compares legacy leading-zero uint spellings by their EIP-712 numeric value", () => {
    expect(relaySignedArtifactsEqual(record, {
      ...record,
      nonce: "0007",
      intent: {
        ...record.intent,
        chainId: "0004663",
        nonce: "0007",
      },
    })).toBe(true);
  });

  it("keeps a terminal identical row terminal instead of merge-upserting it open", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unique", { status: 409 }))
      .mockResolvedValueOnce(Response.json([{
        id: ID,
        zap: record.zap,
        owner: record.owner,
        chain_id: record.chainId,
        kind: record.kind,
        nonce: record.nonce,
        intent: record.intent,
        signature: record.signature,
        status: "consumed",
      }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(insertRelayIntentImmutable(record)).resolves.toEqual({
      kind: "idempotent",
      id: ID,
      status: "consumed",
    });
    const [insertUrl, insertInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(insertUrl).not.toContain("on_conflict");
    expect(insertInit.headers).not.toMatchObject({ prefer: expect.stringContaining("merge-duplicates") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a conflict instead of overwriting an in-flight signed artifact", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unique", { status: 409 }))
      .mockResolvedValueOnce(Response.json([{
        id: ID,
        zap: record.zap,
        owner: record.owner,
        chain_id: record.chainId,
        kind: record.kind,
        nonce: record.nonce,
        intent: { ...record.intent, policyHash: `0x${"22".repeat(32)}` },
        signature: `0x${"cd".repeat(65)}`,
        status: "open",
      }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(insertRelayIntentImmutable(record)).resolves.toEqual({ kind: "conflict" });
  });
});
