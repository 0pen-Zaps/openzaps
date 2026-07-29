import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchOpenIntentPage, type RelayRecord } from "@/lib/relay";

const row = (id: string): RelayRecord => ({
  id,
  zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
  owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  chainId: 4663,
  kind: "recurring",
  intent: {},
  signature: `0x${"ab".repeat(65)}`,
  status: "open",
  createdAt: "2026-07-28T00:00:00.000Z",
});

afterEach(() => vi.unstubAllGlobals());

describe("relay client pagination", () => {
  it("returns one bounded page and lets callers resume explicitly", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ intents: [row("a")], nextCursor: "cursor-2" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ intents: [row("b")], nextCursor: null }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchOpenIntentPage("https://relay.example", { limit: 1 });
    expect(first.intents).toMatchObject([{ id: "a" }]);
    expect(first.nextCursor).toBe("cursor-2");
    const second = await fetchOpenIntentPage("https://relay.example", {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.intents).toMatchObject([{ id: "b" }]);
    expect(second.nextCursor).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-2");
  });

  it("fails closed on a repeated or unbounded cursor", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ intents: [], nextCursor: "same-cursor" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchOpenIntentPage("https://relay.example", { cursor: "same-cursor" }),
    ).rejects.toThrow("repeated cursor");
    await expect(
      fetchOpenIntentPage("https://relay.example", { cursor: "x".repeat(513) }),
    ).rejects.toThrow("cursor is malformed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
