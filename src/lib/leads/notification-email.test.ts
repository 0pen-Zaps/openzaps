import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ClaimedLeadEmailSchema,
  DEFAULT_LEAD_NOTIFICATION_OPERATOR_URL,
  LEAD_NOTIFICATION_EMAIL_SUBJECT,
  LEAD_NOTIFICATION_RECIPIENT,
  LeadNotificationEmailError,
  leadNotificationEmailConfigured,
  leadNotificationIdempotencyKey,
  readLeadNotificationEmailConfig,
  renderLeadNotificationEmail,
  sendLeadNotificationEmail,
  type ClaimedLeadEmail,
  type LeadNotificationEmailClient,
} from "@/lib/leads/notification-email";

const ENV = {
  NODE_ENV: "production",
  VERCEL_ENV: "production",
  OPENZAPS_LEAD_NOTIFICATION_ENABLED: "true",
  OPENZAPS_LEAD_NOTIFICATION_TO: "nodar.janashia@gmail.com",
  OPENZAPS_LEAD_NOTIFICATION_FROM:
    "OpenZaps Leads <submissions@notify.0xzaps.com>",
  RESEND_API_KEY: `re_${"a".repeat(32)}`,
} as const;

const LEAD = {
  lead_id: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
  persona: "protocol_team",
  name: "OpenZaps Partner",
  email: "partner@example.com",
  project: "Partner Protocol",
  project_url:
    "https://partner.example.com/request?campaign=private#submission",
  workflow:
    "Route a fixed USDC amount into one reviewed position when the protocol emits a verified event.",
  protocols_assets: "Partner Protocol, USDC",
  trigger_description: "A verified protocol event is observed.",
  guardrails:
    "Spend at most 500 USDC and allow only one reviewed destination.",
  timeline: "within_30_days",
  qualification_score: 5,
  created_at: "2026-07-30T14:15:00.000+00:00",
} satisfies ClaimedLeadEmail;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lead notification email configuration", () => {
  it("requires the exact private enable gate and complete server-only configuration", () => {
    expect(leadNotificationEmailConfigured(ENV)).toBe(true);
    expect(
      readLeadNotificationEmailConfig(ENV),
    ).toEqual({
      apiKey: ENV.RESEND_API_KEY,
      from: ENV.OPENZAPS_LEAD_NOTIFICATION_FROM,
      operatorUrl: DEFAULT_LEAD_NOTIFICATION_OPERATOR_URL,
      to: LEAD_NOTIFICATION_RECIPIENT,
    });

    for (const candidate of [
      { ...ENV, OPENZAPS_LEAD_NOTIFICATION_ENABLED: undefined },
      { ...ENV, OPENZAPS_LEAD_NOTIFICATION_ENABLED: "TRUE" },
      { ...ENV, VERCEL_ENV: "preview" },
      { ...ENV, VERCEL_ENV: "development" },
      { ...ENV, VERCEL_ENV: undefined },
      {
        ...ENV,
        OPENZAPS_LEAD_NOTIFICATION_TO: "attacker@example.com",
      },
      {
        ...ENV,
        OPENZAPS_LEAD_NOTIFICATION_FROM: "not a mailbox",
      },
      { ...ENV, RESEND_API_KEY: "not-a-resend-key" },
      {
        ...ENV,
        OPENZAPS_LEAD_NOTIFICATION_OPERATOR_URL:
          "https://attacker.example/marketing",
      },
      {
        ...ENV,
        OPENZAPS_LEAD_NOTIFICATION_OPERATOR_URL:
          "https://www.0xzaps.com:444/marketing",
      },
    ]) {
      expect(leadNotificationEmailConfigured(candidate)).toBe(false);
      expect(() => readLeadNotificationEmailConfig(candidate)).toThrow(
        LeadNotificationEmailError,
      );
    }
  });

  it("never treats a NEXT_PUBLIC value as sending configuration", () => {
    expect(
      leadNotificationEmailConfigured({
        NEXT_PUBLIC_RESEND_API_KEY: ENV.RESEND_API_KEY,
        NEXT_PUBLIC_OPENZAPS_LEAD_NOTIFICATION_ENABLED: "true",
        OPENZAPS_LEAD_NOTIFICATION_TO: LEAD_NOTIFICATION_RECIPIENT,
        OPENZAPS_LEAD_NOTIFICATION_FROM:
          ENV.OPENZAPS_LEAD_NOTIFICATION_FROM,
      }),
    ).toBe(false);
  });

  it("allows only clean HTTPS operator paths on an OpenZaps origin", () => {
    expect(
      readLeadNotificationEmailConfig({
        ...ENV,
        OPENZAPS_LEAD_NOTIFICATION_OPERATOR_URL:
          "https://0xzaps.com/marketing/leads",
      }).operatorUrl,
    ).toBe("https://0xzaps.com/marketing/leads");

    expect(
      leadNotificationEmailConfigured({
        ...ENV,
        OPENZAPS_LEAD_NOTIFICATION_OPERATOR_URL:
          "https://www.0xzaps.com/marketing?token=secret",
      }),
    ).toBe(false);
  });
});

describe("lead notification email rendering", () => {
  it("strictly validates the private claim-row contract", () => {
    expect(ClaimedLeadEmailSchema.parse(LEAD)).toEqual(LEAD);
    expect(
      ClaimedLeadEmailSchema.safeParse({
        ...LEAD,
        id: LEAD.lead_id,
      }).success,
    ).toBe(false);
    expect(
      ClaimedLeadEmailSchema.safeParse({
        ...LEAD,
        attribution: { utmSource: "private" },
      }).success,
    ).toBe(false);
  });

  it("renders every submitted detail with fixed subject and private metadata", () => {
    const rendered = renderLeadNotificationEmail(LEAD);

    expect(rendered.subject).toBe(LEAD_NOTIFICATION_EMAIL_SUBJECT);
    for (const expected of [
      LEAD.lead_id,
      "2026-07-30T14:15:00.000Z",
      "5/5",
      LEAD.persona,
      LEAD.timeline,
      LEAD.name,
      LEAD.email,
      LEAD.project,
      "https://partner.example.com/request",
      LEAD.workflow,
      LEAD.protocols_assets,
      LEAD.trigger_description,
      LEAD.guardrails,
      DEFAULT_LEAD_NOTIFICATION_OPERATOR_URL,
    ]) {
      expect(rendered.text).toContain(expected);
    }
    expect(rendered.text).not.toContain("campaign=private");
    expect(rendered.text).not.toContain("#submission");
    expect(rendered.text).not.toContain("attribution");
    expect(rendered.text).not.toContain("fingerprint");
    expect(rendered.text).not.toContain("quota");
  });

  it("labels every absent optional submission field", () => {
    const rendered = renderLeadNotificationEmail({
      ...LEAD,
      project: null,
      project_url: null,
      protocols_assets: null,
    });

    expect(rendered.text.match(/\(not provided\)/gu)).toHaveLength(3);
    expect(rendered.text).toContain("Project: (not provided)");
    expect(rendered.text).toContain("Project URL: (not provided)");
  });

  it("withholds each complete free-text field that contains credential-like data", () => {
    const leakedCredential =
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456789";
    const rendered = renderLeadNotificationEmail({
      ...LEAD,
      name: `Builder ${leakedCredential}`,
      project: `Project API key: ${leakedCredential}`,
      workflow: `Use ${leakedCredential} to route the position.`,
      protocols_assets: `USDC token=${leakedCredential}`,
      trigger_description: `Authorization: Bearer ${"b".repeat(32)}`,
      guardrails: `Never reveal ${leakedCredential}.`,
    });

    expect(rendered.text).not.toContain(leakedCredential);
    expect(
      rendered.text.match(
        /\[withheld: credential-like data detected\]/gu,
      ),
    ).toHaveLength(6);
  });

  it("uses a stable lead-scoped provider idempotency key", () => {
    expect(leadNotificationIdempotencyKey(LEAD.lead_id)).toBe(
      `lead-submission/${LEAD.lead_id}`,
    );
    expect(() => leadNotificationIdempotencyKey("not-a-uuid")).toThrow(
      LeadNotificationEmailError,
    );
  });
});

describe("Resend lead notification adapter", () => {
  it("sends only fixed addressing and plain text, then returns only the provider id", async () => {
    const send = vi.fn().mockResolvedValue({
      data: { id: "provider-message-123" },
      error: null,
      headers: {},
    });
    const client = {
      emails: { send },
    } as unknown as LeadNotificationEmailClient;

    await expect(
      sendLeadNotificationEmail(LEAD, { env: ENV, client }),
    ).resolves.toBe("provider-message-123");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      {
        from: ENV.OPENZAPS_LEAD_NOTIFICATION_FROM,
        to: LEAD_NOTIFICATION_RECIPIENT,
        subject: LEAD_NOTIFICATION_EMAIL_SUBJECT,
        text: expect.stringContaining(LEAD.workflow),
      },
      {
        idempotencyKey: `lead-submission/${LEAD.lead_id}`,
      },
    );
    const [payload] = send.mock.calls[0];
    expect(payload).not.toHaveProperty("replyTo");
    expect(payload).not.toHaveProperty("html");
    expect(payload).not.toHaveProperty("headers");
    expect(payload).not.toHaveProperty("cc");
    expect(payload).not.toHaveProperty("bcc");
  });

  it.each([408, 409, 429, 500, 503])(
    "classifies provider status %s as retryable without surfacing the provider body",
    async (statusCode) => {
      const providerSecret = "provider-body-secret";
      const client = {
        emails: {
          send: vi.fn().mockResolvedValue({
            data: null,
            error: {
              name: "application_error",
              message: providerSecret,
              statusCode,
            },
            headers: {},
          }),
        },
      } as unknown as LeadNotificationEmailClient;

      const thrown = await sendLeadNotificationEmail(LEAD, {
        env: ENV,
        client,
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(LeadNotificationEmailError);
      expect(thrown).toMatchObject({
        code: "provider-error",
        retryable: true,
        status: statusCode,
      });
      expect((thrown as Error).message).not.toContain(providerSecret);
    },
  );

  it.each([400, 401, 403, 404, 422])(
    "keeps repairable provider/configuration status %s recoverable",
    async (statusCode) => {
      const client = {
        emails: {
          send: vi.fn().mockResolvedValue({
            data: null,
            error: {
              name: "validation_error",
              message: "provider details must stay private",
              statusCode,
            },
            headers: {},
          }),
        },
      } as unknown as LeadNotificationEmailClient;

      const thrown = await sendLeadNotificationEmail(LEAD, {
        env: ENV,
        client,
      }).catch((error: unknown) => error);

      expect(thrown).toMatchObject({
        code: "provider-error",
        retryable: true,
        status: statusCode,
      });
    },
  );

  it.each([
    ["concurrent_idempotent_requests", true],
    ["invalid_idempotent_request", false],
  ] as const)(
    "classifies Resend 409 %s as retryable=%s",
    async (name, retryable) => {
      const client = {
        emails: {
          send: vi.fn().mockResolvedValue({
            data: null,
            error: {
              name,
              message: "provider details must stay private",
              statusCode: 409,
            },
            headers: {},
          }),
        },
      } as unknown as LeadNotificationEmailClient;

      const thrown = await sendLeadNotificationEmail(LEAD, {
        env: ENV,
        client,
      }).catch((error: unknown) => error);

      expect(thrown).toMatchObject({
        code: "provider-error",
        retryable,
        status: 409,
      });
    },
  );

  it("keeps a thrown invalid-idempotency 409 permanent", async () => {
    const client = {
      emails: {
        send: vi.fn().mockRejectedValue({
          name: "invalid_idempotent_request",
          message: "provider details must stay private",
          statusCode: 409,
        }),
      },
    } as unknown as LeadNotificationEmailClient;

    const thrown = await sendLeadNotificationEmail(LEAD, {
      env: ENV,
      client,
    }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      code: "provider-error",
      retryable: false,
      status: 409,
    });
  });

  it("classifies thrown network failures as retryable and secret-free", async () => {
    const client = {
      emails: {
        send: vi
          .fn()
          .mockRejectedValue(new Error(`network leaked ${ENV.RESEND_API_KEY}`)),
      },
    } as unknown as LeadNotificationEmailClient;

    const thrown = await sendLeadNotificationEmail(LEAD, {
      env: ENV,
      client,
    }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      code: "network-error",
      retryable: true,
    });
    expect((thrown as Error).message).not.toContain(ENV.RESEND_API_KEY);
  });

  it("rejects malformed provider success responses as retryable", async () => {
    const client = {
      emails: {
        send: vi.fn().mockResolvedValue({
          data: { id: "" },
          error: null,
          headers: {},
        }),
      },
    } as unknown as LeadNotificationEmailClient;

    const thrown = await sendLeadNotificationEmail(LEAD, {
      env: ENV,
      client,
    }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      code: "invalid-response",
      retryable: true,
    });
  });
});
