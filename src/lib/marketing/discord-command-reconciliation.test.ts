import { describe, expect, it, vi } from "vitest";

import { DISCORD_COMMAND_MANIFEST } from "@/lib/marketing/discord-commands";
import {
  DiscordCommandReconciliationError,
  parseCliArguments,
  reconcileDiscordCommands,
  validateDiscordEnvironment,
} from "../../../scripts/reconcile-discord-commands.mjs";

const APPLICATION_ID = "123456789012345678";
const GUILD_ID = "987654321098765432";
const BOT_TOKEN = "OpenZaps_test.bot-token_1234567890";
const ENVIRONMENT = {
  OPENZAPS_DISCORD_APPLICATION_ID: APPLICATION_ID,
  OPENZAPS_DISCORD_GUILD_ID: GUILD_ID,
  DISCORD_BOT_TOKEN: BOT_TOKEN,
};

function command(name: "ask" | "openzaps" | "status") {
  const value = DISCORD_COMMAND_MANIFEST.find((entry) => entry.name === name);
  if (!value) throw new Error(`Missing test command ${name}.`);
  return value;
}

describe("Discord command reconciliation", () => {
  it("defaults to a content-free read-only guild diff", async () => {
    const remote = [
      {
        ...command("ask"),
        id: "111111111111111111",
        application_id: APPLICATION_ID,
        guild_id: GUILD_ID,
      },
      {
        ...command("status"),
        description: "Outdated status description",
        id: "222222222222222222",
      },
      {
        name: "legacy",
        description: "Old command",
        type: 1,
        id: "333333333333333333",
      },
    ];
    const fetchMock = vi.fn(async () => Response.json(remote));

    const result = await reconcileDiscordCommands({
      environment: ENVIRONMENT,
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      mode: "dry-run",
      scope: "guild",
      inSync: false,
      managedCommandsInSync: false,
      applied: false,
      verified: true,
      counts: { desired: 3, remote: 3, create: 1, update: 1, delete: 1 },
      changes: {
        create: ["/openzaps"],
        update: [{ command: "/status", fields: ["description"] }],
        delete: ["/legacy"],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
    );
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    expect(init.headers).toMatchObject({ authorization: `Bot ${BOT_TOKEN}` });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(APPLICATION_ID);
    expect(JSON.stringify(result)).not.toContain("Outdated status description");
  });

  it("creates only managed commands when apply is explicit and verifies the returned command set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ ...command("ask"), id: "111111111111111111" }))
      .mockResolvedValueOnce(Response.json({ ...command("openzaps"), id: "222222222222222222" }))
      .mockResolvedValueOnce(Response.json({ ...command("status"), id: "333333333333333333" }))
      .mockResolvedValueOnce(Response.json(DISCORD_COMMAND_MANIFEST));

    const result = await reconcileDiscordCommands({
      environment: ENVIRONMENT,
      apply: true,
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      mode: "apply",
      applied: true,
      verified: true,
      inSync: true,
      managedCommandsInSync: true,
      counts: { desired: 3, remote: 0, create: 3, update: 0, delete: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls.slice(1, 4)) {
      const [, applyInit] = call as unknown as [string, RequestInit];
      expect(applyInit.method).toBe("POST");
      expect(applyInit.redirect).toBe("error");
    }
    expect(JSON.parse(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    )).toEqual(command("ask"));
    expect((fetchMock.mock.calls[4] as unknown as [string, RequestInit])[1].method).toBe(
      "GET",
    );
  });

  it("patches managed drift without deleting unrelated guild commands", async () => {
    const legacy = {
      name: "legacy",
      description: "Owned by another integration",
      type: 1,
      id: "444444444444444444",
    };
    const current = DISCORD_COMMAND_MANIFEST.map((entry, index) => ({
      ...entry,
      id: `${index + 1}`.repeat(18),
      ...(entry.name === "ask" ? { description: "Drifted" } : {}),
    })).concat(legacy as never);
    const verified = DISCORD_COMMAND_MANIFEST.map((entry, index) => ({
      ...entry,
      id: `${index + 1}`.repeat(18),
    })).concat(legacy as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(current))
      .mockResolvedValueOnce(Response.json({ ...command("ask"), id: "111111111111111111" }))
      .mockResolvedValueOnce(Response.json(verified));

    const result = await reconcileDiscordCommands({
      environment: ENVIRONMENT,
      apply: true,
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      applied: true,
      verified: true,
      inSync: false,
      managedCommandsInSync: true,
      changes: { delete: ["/legacy"] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(patchUrl.endsWith("/commands/111111111111111111")).toBe(true);
    expect(patchInit.method).toBe("PATCH");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit).method === "DELETE")).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit).method === "PUT")).toBe(
      false,
    );
  });

  it("detects behavior-changing option drift", async () => {
    const remote = DISCORD_COMMAND_MANIFEST.map((entry) => entry.name === "ask"
      ? {
          ...entry,
          options: entry.options?.map((option) => ({
            ...option,
            choices: [{ name: "Hidden route", value: "hidden" }],
          })),
        }
      : entry);
    const fetchMock = vi.fn(async () => Response.json(remote));

    const result = await reconcileDiscordCommands({
      environment: ENVIRONMENT,
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      inSync: false,
      managedCommandsInSync: false,
      changes: { update: [{ command: "/ask", fields: ["options"] }] },
    });
  });

  it("does not PUT an already-synchronized guild even in apply mode", async () => {
    const fetchMock = vi.fn(async () => Response.json(DISCORD_COMMAND_MANIFEST));

    const result = await reconcileDiscordCommands({
      environment: ENVIRONMENT,
      apply: true,
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      mode: "apply",
      inSync: true,
      applied: false,
      verified: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: "GET" });
  });

  it("accepts only the explicit --apply mutation flag", () => {
    expect(parseCliArguments([])).toEqual({ apply: false });
    expect(parseCliArguments(["--apply"])).toEqual({ apply: true });
    expect(() => parseCliArguments(["--apply", "--force"])).toThrow(
      DiscordCommandReconciliationError,
    );
    expect(() => parseCliArguments(["--dry-run"])).toThrow(
      DiscordCommandReconciliationError,
    );
  });

  it("fails before fetch for malformed ids or token values without echoing secrets", async () => {
    const secret = "bad token value that must not be logged";
    const fetchMock = vi.fn();
    let thrown: unknown;
    try {
      await reconcileDiscordCommands({
        environment: {
          ...ENVIRONMENT,
          OPENZAPS_DISCORD_GUILD_ID: "123",
          DISCORD_BOT_TOKEN: secret,
        },
        desiredCommands: DISCORD_COMMAND_MANIFEST,
        fetchImpl: fetchMock as typeof fetch,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "invalid-environment" });
    expect((thrown as Error).message).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => validateDiscordEnvironment({
      ...ENVIRONMENT,
      OPENZAPS_DISCORD_APPLICATION_ID: ` ${APPLICATION_ID}`,
    })).toThrow(DiscordCommandReconciliationError);
  });

  it("bounds provider responses and never includes provider bodies in errors", async () => {
    const providerSecret = "provider-body-secret";
    const providerErrorFetch = vi.fn(async () => Response.json(
      { message: providerSecret },
      { status: 401 },
    ));
    let providerError: unknown;
    try {
      await reconcileDiscordCommands({
        environment: ENVIRONMENT,
        desiredCommands: DISCORD_COMMAND_MANIFEST,
        fetchImpl: providerErrorFetch as typeof fetch,
      });
    } catch (error) {
      providerError = error;
    }
    expect(providerError).toMatchObject({ code: "provider-error" });
    expect((providerError as Error).message).not.toContain(providerSecret);

    const oversizedFetch = vi.fn(async () => new Response("[]", {
      headers: {
        "content-type": "application/json",
        "content-length": String(256 * 1_024 + 1),
      },
    }));
    await expect(reconcileDiscordCommands({
      environment: ENVIRONMENT,
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: oversizedFetch as typeof fetch,
    })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("aborts stalled requests using a bounded timeout", async () => {
    const stalledFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("sensitive network detail")),
            { once: true },
          );
        }),
    );

    await expect(reconcileDiscordCommands({
      environment: ENVIRONMENT,
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: stalledFetch,
      timeoutMs: 1,
    })).rejects.toMatchObject({
      code: "network-error",
      message: "Discord API request failed before a response was received.",
    });
  });
});
