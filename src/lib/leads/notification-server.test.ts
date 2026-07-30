import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leads/notification-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/notification-email")>()),
  leadNotificationEmailConfigured: vi.fn(() => true),
}));

import { leadNotificationEmailConfigured } from "@/lib/leads/notification-email";
import {
  claimNextLeadNotification,
  completeLeadNotification,
  failLeadNotification,
  LeadNotificationStoreError,
  leadNotificationDeliveryConfigured,
  leadNotificationStoreConfigured,
} from "@/lib/leads/notification-server";

const ENV = {
  NODE_ENV: "production",
  OPENZAPS_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
} as const;
const WORKER_ID = "wrun_lead_notification_1";
const LEAD_ID = "019fab5e-be72-72d2-809b-0a1d4a35c86b";

const claim = {
  lead_id: LEAD_ID,
  persona: "protocol_team",
  name: "OpenZaps Partner",
  email: "partner@example.com",
  project: "Partner Protocol",
  project_url: "https://example.com",
  workflow:
    "Route a fixed USDC amount into one reviewed position after a verified event.",
  protocols_assets: "Partner Protocol, USDC",
  trigger_description: "A verified protocol event is observed.",
  guardrails: "Spend at most 500 USDC into one reviewed destination.",
  timeline: "within_30_days",
  qualification_score: 5,
  created_at: "2026-07-30T14:00:00.000Z",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lead notification store configuration", () => {
  it("requires the canonical Supabase binding and the separate email gate", () => {
    expect(leadNotificationStoreConfigured(ENV)).toBe(true);
    expect(leadNotificationDeliveryConfigured(ENV)).toBe(true);

    vi.mocked(leadNotificationEmailConfigured).mockReturnValueOnce(false);
    expect(leadNotificationDeliveryConfigured(ENV)).toBe(false);
    expect(
      leadNotificationStoreConfigured({
        ...ENV,
        SUPABASE_URL: "https://wrong-project.supabase.co",
      }),
    ).toBe(false);
    expect(
      leadNotificationStoreConfigured({
        ...ENV,
        SUPABASE_SERVICE_ROLE_KEY: " bad\nkey",
      }),
    ).toBe(false);
  });
});

describe("claimNextLeadNotification", () => {
  it("returns one strict, notification-safe row and never requests network metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([claim]));

    await expect(
      claimNextLeadNotification(WORKER_ID, {
        env: ENV,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual(claim);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/claim_next_lead_notification",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      p_worker_id: WORKER_ID,
    });
    expect(String(init.body)).not.toContain("fingerprint");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("maps an empty claim to null and rejects extra or malformed rows", async () => {
    await expect(
      claimNextLeadNotification(WORKER_ID, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(Response.json([])),
      }),
    ).resolves.toBeNull();

    await expect(
      claimNextLeadNotification(WORKER_ID, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json([claim, claim]),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });

    await expect(
      claimNextLeadNotification(WORKER_ID, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json([{ ...claim, client_fingerprint: "leak" }]),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("fails closed for invalid workers, missing configuration, and RPC failures", async () => {
    const fetchMock = vi.fn();
    await expect(
      claimNextLeadNotification("bad worker", {
        env: ENV,
        fetchImpl: fetchMock,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LeadNotificationStoreError>>({
        code: "invalid-input",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      claimNextLeadNotification(WORKER_ID, {
        env: {},
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "not-configured" });

    await expect(
      claimNextLeadNotification(WORKER_ID, {
        env: ENV,
        fetchImpl: vi.fn().mockRejectedValue(new Error("network")),
      }),
    ).rejects.toMatchObject({ code: "network-error" });

    await expect(
      claimNextLeadNotification(WORKER_ID, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json([], { status: 503 }),
        ),
      }),
    ).rejects.toMatchObject({ code: "rpc-error", status: 503 });
  });
});

describe("lead notification completion RPCs", () => {
  it("sends a strict provider receipt to the completion RPC", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json([{ result_code: "sent" }]));

    await expect(
      completeLeadNotification(
        LEAD_ID,
        WORKER_ID,
        "provider-message-1",
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).resolves.toBe("sent");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("/rpc/complete_lead_notification");
    expect(JSON.parse(String(init.body))).toEqual({
      p_lead_id: LEAD_ID,
      p_worker_id: WORKER_ID,
      p_provider_message_id: "provider-message-1",
    });
  });

  it("records only a finite failure code and permanent flag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json([{ result_code: "permanent_failure" }]),
      );

    await expect(
      failLeadNotification(
        LEAD_ID,
        WORKER_ID,
        "provider_rejected",
        true,
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).resolves.toBe("permanent_failure");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("/rpc/fail_lead_notification");
    expect(JSON.parse(String(init.body))).toEqual({
      p_lead_id: LEAD_ID,
      p_worker_id: WORKER_ID,
      p_failure_code: "provider_rejected",
      p_permanent: true,
    });
  });

  it("rejects invalid inputs and unknown database outcomes", async () => {
    const fetchMock = vi.fn();
    await expect(
      completeLeadNotification(
        "not-a-uuid",
        WORKER_ID,
        "provider-message-1",
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      failLeadNotification(
        LEAD_ID,
        WORKER_ID,
        "unsafe failure text",
        true,
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      completeLeadNotification(
        LEAD_ID,
        WORKER_ID,
        "provider-message-1",
        {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(
            Response.json([{ result_code: "surprise" }]),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});
