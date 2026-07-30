import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ChannelAdapterError } from "./shared";
import {
  createXOAuth1AuthorizationHeader,
  postXBroadcast,
  postXReply,
  publishXPost,
  verifyXAuthenticatedIdentity,
  verifyXReplyTarget,
} from "./x";

const X_IDENTITY = {
  expectedAccountId: "100",
  expectedUsername: "0xzaps",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("X channel adapter", () => {
  it("implements the RFC 5849 HMAC-SHA1 signature example exactly", () => {
    const header = createXOAuth1AuthorizationHeader(
      "GET",
      "http://photos.example.net/photos?file=vacation.jpg&size=original",
      {
        consumerKey: "dpf43f3p2l4k3l03",
        consumerSecret: "kd94hf93k423kf44",
        accessToken: ["nnch734d", "00sl2jdk"].join(""),
        accessTokenSecret: ["pfkkdhi9", "sl3r4s00"].join(""),
      },
      {
        nowMs: 1_191_242_096_000,
        oauth1Nonce: () => "kllo9940pd9333jh",
      },
    );

    expect(header).toContain(
      'oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"',
    );
  });

  it("publishes a broadcast through POST /2/tweets and carries the idempotency key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(Response.json(
        { data: { id: "1987654321098765432", text: "shipped" } },
        {
          status: 201,
          headers: {
            "x-rate-limit-limit": "200",
            "x-rate-limit-remaining": "199",
            "x-rate-limit-reset": "1800000000",
          },
        },
      ));

    await expect(
      postXBroadcast(
        { text: "OpenZaps shipped.", idempotencyKey: "release:42:x" },
        {
          ...X_IDENTITY,
          userAccessToken: "user-oauth-token",
          fetchImpl: fetchMock,
        },
      ),
    ).resolves.toEqual({
      channel: "x",
      mode: "broadcast",
      providerMessageId: "1987654321098765432",
      providerUrl: "https://x.com/i/web/status/1987654321098765432",
      idempotencyKey: "release:42:x",
      rateLimit: {
        limit: 200,
        remaining: 199,
        resetAt: "2027-01-15T08:00:00.000Z",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.com/2/users/me");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.x.com/2/tweets");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      authorization: "Bearer user-oauth-token",
      "content-type": "application/json",
    });
    expect(init.headers).not.toHaveProperty("idempotency-key");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "OpenZaps shipped.",
      made_with_ai: true,
    });
  });

  it("marks an exact server-authored broadcast as not AI-generated", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        Response.json({ data: { id: "200" } }, { status: 201 }),
      );

    await postXBroadcast(
      {
        text: "Versioned server template.",
        idempotencyKey: "scheduled:template:x",
        madeWithAi: false,
      },
      {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
      },
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Versioned server template.",
      made_with_ai: false,
    });
  });

  it("uses the official reply object for a reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        Response.json({ data: { id: "200" } }, { status: 201 }),
      );

    await expect(
      postXReply(
        {
          text: "Thanks for asking.",
          inReplyToTweetId: "100",
          authenticatedAccountId: "100",
          idempotencyKey: "mention:100",
        },
        { ...X_IDENTITY, userAccessToken: "token", fetchImpl: fetchMock },
      ),
    ).resolves.toMatchObject({ mode: "reply", providerMessageId: "200" });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Thanks for asking.",
      made_with_ai: true,
      reply: { in_reply_to_tweet_id: "100" },
    });
  });

  it("refuses a reply when current identity differs from immutable verification", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(xUserResponse());

    await expect(
      postXReply(
        {
          text: "This must not send.",
          inReplyToTweetId: "100",
          authenticatedAccountId: "999",
          idempotencyKey: "mention:mismatch",
        },
        { ...X_IDENTITY, userAccessToken: "token", fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.com/2/users/me");
  });

  it("prefers complete OAuth 1.0a user context over an OAuth2 bearer token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        Response.json({ data: { id: "200" } }, { status: 201 }),
      );

    await postXBroadcast(
      { text: "Signed.", idempotencyKey: "oauth1" },
      {
        userAccessToken: "bearer-must-not-win",
        ...X_IDENTITY,
        oauth1Credentials: {
          consumerKey: "consumer",
          consumerSecret: "consumer-secret",
          accessToken: "access",
          accessTokenSecret: "access-secret",
        },
        oauth1Nonce: () => "nonce",
        nowMs: 1_700_000_000_000,
        fetchImpl: fetchMock,
      },
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const authorization = new Headers(init.headers).get("authorization");
    expect(authorization).toMatch(/^OAuth /u);
    expect(authorization).toContain('oauth_consumer_key="consumer"');
    expect(authorization).not.toContain("bearer-must-not-win");
  });

  it("fails closed on partial OAuth 1.0a credentials instead of falling back", async () => {
    const fetchMock = vi.fn();
    await expect(
      postXBroadcast(
        { text: "No partial auth.", idempotencyKey: "partial-oauth" },
        {
          userAccessToken: "bearer",
          ...X_IDENTITY,
          oauth1Credentials: { consumerKey: "consumer" },
          fetchImpl: fetchMock,
        },
      ),
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before a request when the user token is missing", async () => {
    vi.stubEnv("X_USER_ACCESS_TOKEN", "");
    const fetchMock = vi.fn();

    await expect(
      postXBroadcast(
        { text: "No token.", idempotencyKey: "missing-token" },
        { ...X_IDENTITY, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({
      name: "ChannelAdapterError",
      channel: "x",
      code: "not-configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid and oversized posts before a request", async () => {
    const fetchMock = vi.fn();
    await expect(
      publishXPost(
        {
          text: "x".repeat(281),
          idempotencyKey: "oversized",
          replyToTweetId: "not-a-post-id",
        },
        { userAccessToken: "token", fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses retry and X rate-limit headers on a 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: {
          "retry-after": "3",
          "x-rate-limit-limit": "50",
          "x-rate-limit-remaining": "0",
          "x-rate-limit-reset": "1800000000",
        },
      }));

    await expect(
      postXBroadcast(
        { text: "Later.", idempotencyKey: "rate-limit" },
        { ...X_IDENTITY, userAccessToken: "token", fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({
      channel: "x",
      code: "rate-limited",
      details: {
        status: 429,
        retryAfterMs: 3_000,
        rateLimit: {
          limit: 50,
          remaining: 0,
          resetAt: "2027-01-15T08:00:00.000Z",
        },
      },
    });
  });

  it("never copies a network exception or token into its error", async () => {
    const secret = "secret-user-token";
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error(`failed with ${secret}`));

    let thrown: unknown;
    try {
      await postXBroadcast(
        { text: "Safe error.", idempotencyKey: "safe-error" },
        { ...X_IDENTITY, userAccessToken: secret, fetchImpl: fetchMock },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ChannelAdapterError);
    expect((thrown as Error).message).toBe("x could not be reached.");
    expect((thrown as Error).message).not.toContain(secret);
  });

  it("times out stalled provider requests and bounds success receipts", async () => {
    const stalledFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("provider timeout detail")),
            { once: true },
          );
        }),
    );
    await expect(
      postXBroadcast(
        { text: "Bounded request.", idempotencyKey: "bounded-timeout" },
        {
          userAccessToken: "token",
          ...X_IDENTITY,
          fetchImpl: stalledFetch,
          requestTimeoutMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "network-error" });

    const oversizedFetch = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        new Response("x".repeat(64 * 1_024 + 1), { status: 201 }),
      );
    await expect(
      postXBroadcast(
        { text: "Bounded response.", idempotencyKey: "bounded-response" },
        {
          ...X_IDENTITY,
          userAccessToken: "token",
          fetchImpl: oversizedFetch,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

function xUserResponse(id = "100", username = "0xzaps"): Response {
  return Response.json({ data: { id, username, name: "OpenZaps" } });
}

function xTargetResponse(input: {
  id?: string;
  authorId?: string;
  authorUsername?: string;
  mentions?: string[];
  quoted?: { id: string; authorId: string };
  text?: string;
} = {}): Response {
  const id = input.id ?? "123456789";
  const authorId = input.authorId ?? "200";
  return Response.json({
    data: {
      id,
      author_id: authorId,
      text: input.text ?? "Target text must never leave the adapter.",
      ...(input.mentions
        ? {
            entities: {
              mentions: input.mentions.map((username) => ({ username })),
            },
          }
        : {}),
      ...(input.quoted
        ? {
            referenced_tweets: [{ type: "quoted", id: input.quoted.id }],
          }
        : {}),
    },
    includes: {
      users: [
        {
          id: authorId,
          username: input.authorUsername ?? "community",
        },
      ],
      tweets: input.quoted
        ? [{ id: input.quoted.id, author_id: input.quoted.authorId, text: "quoted text" }]
        : [],
    },
  });
}

describe("X authenticated identity binding", () => {
  it("returns only the verified current identity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(xUserResponse());

    await expect(
      verifyXAuthenticatedIdentity({
        ...X_IDENTITY,
        userAccessToken: "secret-token",
        fetchImpl: fetchMock,
        nowMs: Date.parse("2026-07-29T12:00:00.000Z"),
      }),
    ).resolves.toEqual({
      authenticatedAccountId: "100",
      authenticatedUsername: "0xzaps",
      observedAt: "2026-07-29T12:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.com/2/users/me");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer secret-token",
    );
  });

  it.each([
    ["wrong account id", xUserResponse("999", "0xzaps")],
    ["wrong username", xUserResponse("100", "attacker")],
  ])("rejects %s without exposing identity credentials", async (_label, response) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    let thrown: unknown;
    try {
      await verifyXAuthenticatedIdentity({
        ...X_IDENTITY,
        userAccessToken: "secret-token",
        fetchImpl: fetchMock,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "invalid-input" });
    expect((thrown as Error).message).not.toContain("secret-token");
    expect((thrown as Error).message).not.toContain("attacker");
  });

  it("rejects missing or malformed expected identity before calling X", async () => {
    const fetchMock = vi.fn();
    await expect(
      verifyXAuthenticatedIdentity({
        userAccessToken: "token",
        expectedAccountId: "not-digits",
        expectedUsername: "@0xzaps",
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("X reply target verification", () => {
  it("verifies an explicit mention and returns metadata without target text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        xTargetResponse({
          mentions: ["0xzaps"],
          text: "private-to-the-adapter target body",
        }),
      );

    const evidence = await verifyXReplyTarget(
      "https://x.com/community/status/123456789",
      {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
        nowMs: Date.parse("2026-07-29T12:00:00.000Z"),
      },
    );

    expect(evidence).toEqual({
      id: "123456789",
      targetUrl: "https://x.com/community/status/123456789",
      authorId: "200",
      authenticatedAccountId: "100",
      trigger: "mention",
      observedAt: "2026-07-29T12:00:00.000Z",
    });
    expect(JSON.stringify(evidence)).not.toContain("private-to-the-adapter");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.com/2/users/me");
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      "https://api.x.com/2/tweets/123456789?",
    );
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer token");
    }
  });

  it("verifies a quote only when the quoted post belongs to the authenticated account", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        xTargetResponse({ quoted: { id: "900", authorId: "100" } }),
      );

    await expect(
      verifyXReplyTarget("https://x.com/community/status/123456789", {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
      }),
    ).resolves.toMatchObject({ trigger: "quote", id: "123456789" });
  });

  it.each([
    "http://x.com/community/status/123456789",
    "https://www.x.com/community/status/123456789",
    "https://x.com/community/status/123456789/",
    "https://x.com/community/status/123456789?trigger=mention",
    "https://x.com/community/status/1234567890abc",
    "https://x.com/community/status/12345678901234567890",
  ])("rejects non-canonical target URL %s before calling X", async (targetUrl) => {
    const fetchMock = vi.fn();
    await expect(
      verifyXReplyTarget(targetUrl, {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a URL whose username does not match the API-observed author", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        xTargetResponse({ authorUsername: "actual_author", mentions: ["0xzaps"] }),
      );

    await expect(
      verifyXReplyTarget("https://x.com/spoofed/status/123456789", {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects a self-authored target", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        xTargetResponse({
          authorId: "100",
          authorUsername: "0xzaps",
          mentions: ["0xzaps"],
        }),
      );

    await expect(
      verifyXReplyTarget("https://x.com/0xzaps/status/123456789", {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects a post without an explicit mention or owned quote", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(xTargetResponse({ mentions: ["someone_else"] }));

    await expect(
      verifyXReplyTarget("https://x.com/community/status/123456789", {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects a quote of someone else's post", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xUserResponse())
      .mockResolvedValueOnce(
        xTargetResponse({ quoted: { id: "900", authorId: "999" } }),
      );

    await expect(
      verifyXReplyTarget("https://x.com/community/status/123456789", {
        ...X_IDENTITY,
        userAccessToken: "token",
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});
