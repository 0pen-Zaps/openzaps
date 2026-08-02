import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));

import {
  getDiscordCommandInvocationReadback,
  scheduleDiscordCommandInvocationReceipt,
} from "@/lib/marketing/discord-command-invocation-receipt-server";
import { DISCORD_COMMAND_MANIFEST_SHA256 } from "@/lib/marketing/discord-command-manifest";

const APPLICATION_ID = "123456789012345678";
const GUILD_ID = "987654321098765432";
const SERVICE_ROLE_KEY = "service-role-secret";
const PUBLIC_KEY = "ab".repeat(32);
const FIRST_VERIFIED_AT = "2026-08-02T08:17:00.000Z";

function binding(
  applicationId = APPLICATION_ID,
  guildId = GUILD_ID,
  publicKey = PUBLIC_KEY,
  secret = SERVICE_ROLE_KEY,
): string {
  const signingKeyFingerprint = createHash("sha256")
    .update(Buffer.from(publicKey, "hex"))
    .digest("hex");
  return createHmac("sha256", secret)
    .update(
      `openzaps:discord-command-invocation-target:v2\0application:${applicationId}\0guild:${guildId}\0signing-key-sha256:${signingKeyFingerprint}`,
      "utf8",
    )
    .digest("hex");
}

function configure(): void {
  vi.stubEnv("OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_SUPABASE_PROJECT_REF", "abcdefghijklmnopqrst");
  vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("OPENZAPS_DISCORD_APPLICATION_ID", APPLICATION_ID);
  vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", GUILD_ID);
  vi.stubEnv("DISCORD_APPLICATION_PUBLIC_KEY", PUBLIC_KEY);
}

function recordResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json([{
    result_code: "recorded",
    target_binding_hmac: binding(),
    command_name: "ask",
    manifest_sha256: DISCORD_COMMAND_MANIFEST_SHA256,
    first_verified_at: FIRST_VERIFIED_AT,
    ...overrides,
  }]);
}

function readbackRows(overrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return ["ask", "openzaps", "status"].map((command, index) => ({
    target_binding_hmac: binding(),
    manifest_sha256: DISCORD_COMMAND_MANIFEST_SHA256,
    command_name: command,
    observed: index === 0,
    first_verified_at: index === 0 ? FIRST_VERIFIED_AT : null,
    ...overrides,
  }));
}

async function scheduledCallback(): Promise<void> {
  expect(mocks.after).toHaveBeenCalledOnce();
  const callback = mocks.after.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
  expect(callback).toBeTypeOf("function");
  await callback?.();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Discord command invocation receipts", () => {
  it("schedules an opaque current-manifest receipt after the response path", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(recordResponse());
    vi.stubGlobal("fetch", fetchMock);

    scheduleDiscordCommandInvocationReceipt("ask");

    expect(fetchMock).not.toHaveBeenCalled();
    await scheduledCallback();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/record_marketing_discord_command_invocation_receipt",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({
        p_target_binding_hmac: binding(),
        p_command_name: "ask",
        p_manifest_sha256: DISCORD_COMMAND_MANIFEST_SHA256,
      }),
    });
    expect(init.headers).toMatchObject({
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    });
    expect(init.body).not.toContain(APPLICATION_ID);
    expect(init.body).not.toContain(GUILD_ID);
    expect(init.body).not.toContain(PUBLIC_KEY);
    expect(init.body).not.toContain(SERVICE_ROLE_KEY);
  });

  it("performs only one idempotent retry for a network or 5xx failure", async () => {
    configure();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(recordResponse({ result_code: "already_recorded" }));
    vi.stubGlobal("fetch", fetchMock);

    scheduleDiscordCommandInvocationReceipt("ask");
    await scheduledCallback();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      fetchMock.mock.calls[1]?.[1]?.body,
    );
  });

  it("does not retry a 4xx and logs only the fixed sanitized failure", async () => {
    configure();
    const secretProviderError = `provider leaked ${SERVICE_ROLE_KEY}`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(secretProviderError, { status: 400 }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    scheduleDiscordCommandInvocationReceipt("ask");
    await scheduledCallback();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "OpenZaps Discord command invocation receipt could not be recorded.",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(SERVICE_ROLE_KEY);
    expect(JSON.stringify(error.mock.calls)).not.toContain(secretProviderError);
  });

  it("keeps missing config, invalid commands, and after registration failures out of the response", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduleDiscordCommandInvocationReceipt("ask");
    scheduleDiscordCommandInvocationReceipt("other" as never);
    expect(mocks.after).not.toHaveBeenCalled();

    configure();
    mocks.after.mockImplementationOnce(() => {
      throw new Error(`registration leaked ${SERVICE_ROLE_KEY}`);
    });
    expect(() => scheduleDiscordCommandInvocationReceipt("ask")).not.toThrow();

    expect(error).toHaveBeenCalledTimes(3);
    expect(new Set(error.mock.calls.map(([message]) => message))).toEqual(
      new Set([
        "OpenZaps Discord command invocation receipt could not be recorded.",
      ]),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(SERVICE_ROLE_KEY);
  });

  it("returns exact current-target readback without claiming counts or delivery", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(Response.json(readbackRows()));
    vi.stubGlobal("fetch", fetchMock);

    const readback = await getDiscordCommandInvocationReadback();

    expect(readback).toEqual({
      schemaVersion: 1,
      status: "current_manifest_seen",
      scope: "privacy_safe_configured_target_receipts",
      manifestSha256: DISCORD_COMMAND_MANIFEST_SHA256,
      commands: [
        { command: "ask", observed: true, firstVerifiedAt: FIRST_VERIFIED_AT },
        { command: "openzaps", observed: false, firstVerifiedAt: null },
        { command: "status", observed: false, firstVerifiedAt: null },
      ],
      anyVerifiedInvocationObserved: true,
      allCommandsObserved: false,
      uniqueInvocationsCounted: false,
      responseDeliveryVerified: false,
      writesPerformed: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString().endsWith(
      "/rest/v1/rpc/get_marketing_discord_command_invocation_readback",
    )).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({
      p_target_binding_hmac: binding(),
      p_manifest_sha256: DISCORD_COMMAND_MANIFEST_SHA256,
    });
  });

  it("reports not observed only when every exact row is absent", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      readbackRows({ observed: false, first_verified_at: null }),
    )));

    await expect(getDiscordCommandInvocationReadback()).resolves.toMatchObject({
      status: "not_observed",
      anyVerifiedInvocationObserved: false,
      allCommandsObserved: false,
      commands: [
        { command: "ask", observed: false, firstVerifiedAt: null },
        { command: "openzaps", observed: false, firstVerifiedAt: null },
        { command: "status", observed: false, firstVerifiedAt: null },
      ],
    });
  });

  it("fails closed for missing configuration and malformed provider evidence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getDiscordCommandInvocationReadback()).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    configure();
    for (const rows of [
      readbackRows().slice(0, 2),
      readbackRows({ manifest_sha256: "a".repeat(64) }),
      readbackRows({ target_binding_hmac: "b".repeat(64) }),
      readbackRows({ first_verified_at: "2026-08-02T08:17:01.000Z" }),
      readbackRows({ observed: false, first_verified_at: FIRST_VERIFIED_AT }),
      readbackRows().map((row, index) => ({
        ...row,
        command_name: ["openzaps", "ask", "status"][index],
      })),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(rows)));
      await expect(getDiscordCommandInvocationReadback()).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("invalidates old receipts when the configured target changes", async () => {
    configure();
    vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "111111111111111111");
    const oldRows = readbackRows();
    const fetchMock = vi.fn().mockResolvedValue(Response.json(oldRows));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDiscordCommandInvocationReadback()).rejects.toMatchObject({
      code: "invalid_response",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.p_target_binding_hmac).toBe(
      binding(APPLICATION_ID, "111111111111111111"),
    );
    expect(body.p_target_binding_hmac).not.toBe(binding());
  });

  it("invalidates old receipts when the validated Discord signing key rotates", async () => {
    configure();
    const rotatedPublicKey = "cd".repeat(32);
    vi.stubEnv("DISCORD_APPLICATION_PUBLIC_KEY", rotatedPublicKey);
    const oldRows = readbackRows();
    const fetchMock = vi.fn().mockResolvedValue(Response.json(oldRows));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDiscordCommandInvocationReadback()).rejects.toMatchObject({
      code: "invalid_response",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.p_target_binding_hmac).toBe(
      binding(APPLICATION_ID, GUILD_ID, rotatedPublicKey),
    );
    expect(body.p_target_binding_hmac).not.toBe(binding());
  });

  it("fails closed when the Discord signing key is absent or not exact hex", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const publicKey of ["", "not-a-public-key", ` ${PUBLIC_KEY} `]) {
      configure();
      vi.stubEnv("DISCORD_APPLICATION_PUBLIC_KEY", publicKey);
      await expect(getDiscordCommandInvocationReadback()).rejects.toMatchObject({
        code: "not_configured",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
