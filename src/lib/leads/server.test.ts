import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { leadFingerprint } from "@/lib/leads/fingerprint";
import { LeadRequestSchema } from "@/lib/leads/schema";
import {
  deleteLeadRequest,
  LeadStoreError,
  leadStoreConfigured,
  listLeadRequests,
  probeLeadStoreReadiness,
  purgeExpiredLeadRequests,
  submitLeadRequest,
  updateLeadRequestLifecycle,
} from "@/lib/leads/server";

const ENV = {
  NODE_ENV: "production",
  OPENZAPS_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  OPENZAPS_LEAD_FINGERPRINT_SECRET: "f".repeat(32),
} as const;

const lead = LeadRequestSchema.parse({
  persona: "protocol_team",
  name: "OpenZaps Partner",
  email: "PARTNER@example.com",
  project: "Partner Protocol",
  projectUrl: "https://example.com",
  workflow:
    "Route a fixed USDC amount into one reviewed position when the protocol emits a verified event and liquidity is available.",
  protocolsAssets: "Partner Protocol, USDC",
  trigger: "A verified protocol event is observed.",
  guardrails:
    "Spend at most 500 USDC and allow only one reviewed destination.",
  timeline: "within_30_days",
  consent: true,
  website: "",
  attribution: { utmSource: "discord" },
});

const operatorRow = {
  id: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
  persona: "protocol_team",
  name: "OpenZaps Partner",
  email: "partner@example.com",
  project: "Partner Protocol",
  project_url: "https://example.com",
  workflow: lead.workflow,
  protocols_assets: "Partner Protocol, USDC",
  trigger_description: lead.trigger,
  guardrails: lead.guardrails,
  timeline: "within_30_days",
  consent_to_contact: true,
  consent_version: "lead-contact-v1",
  consented_at: "2026-07-30T02:00:00.0000+00:00",
  email_verified: false,
  attribution: { utmSource: "discord" },
  qualification_score: 5,
  status: "new",
  created_at: "2026-07-30T02:00:00.0000+00:00",
  updated_at: "2026-07-30T02:00:00.0000+00:00",
  expires_at: "2027-01-26T02:00:00.0000+00:00",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lead store configuration", () => {
  it("requires the canonical project, service credential, and 32-byte fingerprint secret", () => {
    expect(leadStoreConfigured(ENV)).toBe(true);
    expect(
      leadStoreConfigured({
        ...ENV,
        OPENZAPS_SUPABASE_PROJECT_REF: "anotherprojectrefxxx",
      }),
    ).toBe(false);
    expect(
      leadStoreConfigured({
        ...ENV,
        OPENZAPS_LEAD_FINGERPRINT_SECRET: "short",
      }),
    ).toBe(false);
    expect(
      leadStoreConfigured({ ...ENV, SUPABASE_SERVICE_ROLE_KEY: " bad\nkey" }),
    ).toBe(false);
    expect(
      leadStoreConfigured({
        ...ENV,
        SUPABASE_URL: "http://127.0.0.1:54321",
      }),
    ).toBe(false);
    expect(
      leadStoreConfigured({
        ...ENV,
        NODE_ENV: "development",
        SUPABASE_URL: "http://127.0.0.1:54321",
      }),
    ).toBe(true);
  });

  it("probes the authenticated OpenAPI surface without reading or mutating rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        paths: {
          "/rpc/submit_lead_request": { post: { responses: {} } },
        },
      }),
    );

    await expect(
      probeLeadStoreReadiness({ env: ENV, fetchImpl: fetchMock }),
    ).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/",
    );
    expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(init).not.toHaveProperty("method");
    expect(init).not.toHaveProperty("body");
    expect(init.headers).toMatchObject({
      accept: "application/openapi+json",
      apikey: "service-secret",
      authorization: "Bearer service-secret",
    });
  });

  it("fails readiness closed for configuration, auth, network, and schema gaps", async () => {
    const unused = vi.fn();
    await expect(
      probeLeadStoreReadiness({ env: {}, fetchImpl: unused }),
    ).resolves.toBe(false);
    expect(unused).not.toHaveBeenCalled();

    for (const fetchImpl of [
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue(Response.json({}, { status: 401 })),
      vi.fn().mockResolvedValue(Response.json({ paths: {} })),
      vi.fn().mockResolvedValue(new Response("not-json")),
    ]) {
      await expect(
        probeLeadStoreReadiness({ env: ENV, fetchImpl }),
      ).resolves.toBe(false);
    }
  });
});

describe("submitLeadRequest", () => {
  it("sends one pseudonymous, scored RPC admission without marketing opt-in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json([{ result_code: "accepted" }]));
    const requestHeaders = new Headers({
      "x-vercel-forwarded-for": "203.0.113.42",
    });

    await expect(
      submitLeadRequest(lead, requestHeaders, {
        env: ENV,
        fetchImpl: fetchMock,
      }),
    ).resolves.toBe("accepted");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/submit_lead_request",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    });
    expect(init.headers).toMatchObject({
      apikey: "service-secret",
      authorization: "Bearer service-secret",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      p_fingerprint: leadFingerprint(
        requestHeaders,
        ENV.OPENZAPS_LEAD_FINGERPRINT_SECRET,
      ),
      p_email: "partner@example.com",
      p_consent_to_contact: true,
      p_qualification_score: 5,
      p_attribution: { utmSource: "discord" },
    });
    expect(body).not.toHaveProperty("p_marketing_opt_in");
    expect(body).not.toHaveProperty("p_email_verified");
    expect(String(init.body)).not.toContain("203.0.113.42");
  });

  it("preserves the durable quota outcome", async () => {
    await expect(
      submitLeadRequest(lead, new Headers(), {
        env: ENV,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(
            Response.json([{ result_code: "quota_reached" }]),
          ),
      }),
    ).resolves.toBe("quota_reached");
  });

  it("fails closed for missing configuration, network errors, and malformed results", async () => {
    const fetchMock = vi.fn();
    await expect(
      submitLeadRequest(lead, new Headers(), {
        env: {},
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      submitLeadRequest(lead, new Headers(), {
        env: ENV,
        fetchImpl: vi.fn().mockRejectedValue(new Error("network")),
      }),
    ).rejects.toMatchObject({ code: "network-error" });

    await expect(
      submitLeadRequest(lead, new Headers(), {
        env: ENV,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(Response.json([{ result_code: "surprise" }])),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("listLeadRequests", () => {
  it("returns a bounded, fingerprint-free operator queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([operatorRow]));
    await expect(
      listLeadRequests(
        { limit: 25, minScore: 3 },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: operatorRow.id,
        email: "partner@example.com",
        projectUrl: "https://example.com",
        qualificationScore: 5,
        consentVersion: "lead-contact-v1",
        emailVerified: false,
        updatedAt: operatorRow.updated_at,
        expiresAt: operatorRow.expires_at,
      }),
    ]);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      p_limit: 25,
      p_min_score: 3,
    });
    expect(JSON.stringify(await listLeadRequests(
      { limit: 25, minScore: 3 },
      {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(Response.json([operatorRow])),
      },
    ))).not.toContain("fingerprint");
  });

  it("rejects invalid queries and malformed database rows", async () => {
    const fetchMock = vi.fn();
    await expect(
      listLeadRequests(
        { limit: 101, minScore: 0 },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LeadStoreError>>({
        code: "invalid-input",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      listLeadRequests(
        { limit: 10, minScore: 0 },
        {
          env: ENV,
          fetchImpl: vi
            .fn()
            .mockResolvedValue(
              Response.json([{ ...operatorRow, client_fingerprint: "leak" }]),
            ),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("updateLeadRequestLifecycle", () => {
  it("returns a strict fingerprint-free lifecycle update", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([{
      result_code: "updated",
      id: operatorRow.id,
      status: "contacted",
      updated_at: "2026-07-30T03:00:00.0000+00:00",
      expires_at: "2027-01-26T03:00:00.0000+00:00",
    }]));

    await expect(
      updateLeadRequestLifecycle(
        operatorRow.id,
        "contacted",
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).resolves.toEqual({
      result: "updated",
      id: operatorRow.id,
      status: "contacted",
      updatedAt: "2026-07-30T03:00:00.0000+00:00",
      expiresAt: "2027-01-26T03:00:00.0000+00:00",
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/update_lead_request_lifecycle",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      p_id: operatorRow.id,
      p_status: "contacted",
    });
    expect(String(init.body)).not.toContain("fingerprint");
  });

  it("preserves finite lifecycle outcomes and rejects malformed rows", async () => {
    for (const result of [
      "not_found",
      "expired",
      "invalid_transition",
    ] as const) {
      await expect(
        updateLeadRequestLifecycle(
          operatorRow.id,
          "closed",
          {
            env: ENV,
            fetchImpl: vi.fn().mockResolvedValue(Response.json([{
              result_code: result,
              id: null,
              status: null,
              updated_at: null,
              expires_at: null,
            }])),
          },
        ),
      ).resolves.toEqual({ result });
    }

    await expect(
      updateLeadRequestLifecycle(
        "not-a-uuid",
        "closed",
        { env: ENV, fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });

    await expect(
      updateLeadRequestLifecycle(
        operatorRow.id,
        "qualified",
        {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(Response.json([{
            result_code: "updated",
            id: operatorRow.id,
            status: "qualified",
            updated_at: null,
            expires_at: null,
          }])),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("deleteLeadRequest", () => {
  it("deletes at most one UUID-selected lead through its narrow RPC", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json([{ deleted_count: 1 }]));

    await expect(
      deleteLeadRequest(
        operatorRow.id,
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/delete_lead_request",
    );
    expect(JSON.parse(String(init.body))).toEqual({ p_id: operatorRow.id });
  });

  it("returns false for a missing lead and rejects impossible counts", async () => {
    await expect(
      deleteLeadRequest(
        operatorRow.id,
        {
          env: ENV,
          fetchImpl: vi
            .fn()
            .mockResolvedValue(Response.json([{ deleted_count: 0 }])),
        },
      ),
    ).resolves.toBe(false);

    await expect(
      deleteLeadRequest(
        operatorRow.id,
        {
          env: ENV,
          fetchImpl: vi
            .fn()
            .mockResolvedValue(Response.json([{ deleted_count: 2 }])),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("purgeExpiredLeadRequests", () => {
  it("returns the bounded deletion count from the retention RPC", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json([{ deleted_count: 4 }]));

    await expect(
      purgeExpiredLeadRequests({ env: ENV, fetchImpl: fetchMock }),
    ).resolves.toBe(4);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/purge_expired_lead_requests",
    );
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("rejects malformed retention results", async () => {
    await expect(
      purgeExpiredLeadRequests({
        env: ENV,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(Response.json([{ deleted_count: "-1" }])),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});
