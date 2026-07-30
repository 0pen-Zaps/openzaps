import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FatalError, RetryableError } from "workflow";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  send: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leads/notification-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/notification-server")>()),
  claimNextLeadNotification: mocks.claim,
  completeLeadNotification: mocks.complete,
  failLeadNotification: mocks.fail,
}));
vi.mock("@/lib/leads/notification-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/notification-email")>()),
  sendLeadNotificationEmail: mocks.send,
}));

import {
  LeadNotificationEmailError,
} from "@/lib/leads/notification-email";
import {
  LeadNotificationStoreError,
} from "@/lib/leads/notification-server";
import {
  completeLeadNotificationStep,
  sendNextLeadNotificationStep,
} from "@/workflows/lead-notification/steps";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue(claim);
  mocks.complete.mockResolvedValue("sent");
  mocks.fail.mockResolvedValue("permanent_failure");
  mocks.send.mockResolvedValue("provider-message-1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendNextLeadNotificationStep", () => {
  it("claims before sending and returns only the durable receipt identifiers", async () => {
    await expect(sendNextLeadNotificationStep(WORKER_ID)).resolves.toEqual({
      status: "sent",
      leadId: LEAD_ID,
      providerMessageId: "provider-message-1",
    });
    expect(mocks.claim).toHaveBeenCalledWith(WORKER_ID);
    expect(mocks.send).toHaveBeenCalledWith(claim);
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("returns an empty marker without calling the provider", async () => {
    mocks.claim.mockResolvedValue(null);

    await expect(sendNextLeadNotificationStep(WORKER_ID)).resolves.toEqual({
      status: "empty",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("retries transient provider failures without releasing the same-worker claim", async () => {
    mocks.send.mockRejectedValue(
      new LeadNotificationEmailError("provider-error", true, 429),
    );

    await expect(sendNextLeadNotificationStep(WORKER_ID)).rejects.toBeInstanceOf(
      RetryableError,
    );
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("treats an in-flight configuration rollback as recoverable", async () => {
    mocks.send.mockRejectedValue(
      new LeadNotificationEmailError("not-configured", false),
    );

    await expect(sendNextLeadNotificationStep(WORKER_ID)).rejects.toBeInstanceOf(
      RetryableError,
    );
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("records permanent provider failures before stopping retries", async () => {
    mocks.send.mockRejectedValue(
      new LeadNotificationEmailError("provider-error", false, 422),
    );

    await expect(sendNextLeadNotificationStep(WORKER_ID)).rejects.toBeInstanceOf(
      FatalError,
    );
    expect(mocks.fail).toHaveBeenCalledWith(
      LEAD_ID,
      WORKER_ID,
      "provider_rejected",
      true,
    );
  });

  it("retries transient store errors and fails closed on malformed claims", async () => {
    mocks.claim.mockRejectedValueOnce(
      new LeadNotificationStoreError(
        "rpc-error",
        "service unavailable",
        503,
      ),
    );
    await expect(sendNextLeadNotificationStep(WORKER_ID)).rejects.toBeInstanceOf(
      RetryableError,
    );

    mocks.claim.mockRejectedValueOnce(
      new LeadNotificationStoreError(
        "invalid-response",
        "malformed response",
      ),
    );
    await expect(sendNextLeadNotificationStep(WORKER_ID)).rejects.toBeInstanceOf(
      FatalError,
    );
  });

  it("uses a bounded retry budget for the idempotent provider step", () => {
    expect(sendNextLeadNotificationStep.maxRetries).toBe(5);
  });
});

describe("completeLeadNotificationStep", () => {
  const delivery = {
    leadId: LEAD_ID,
    providerMessageId: "provider-message-1",
  } as const;

  it.each(["sent", "already_sent"] as const)(
    "accepts the idempotent %s database outcome",
    async (result) => {
      mocks.complete.mockResolvedValue(result);
      await expect(
        completeLeadNotificationStep(WORKER_ID, delivery),
      ).resolves.toBeUndefined();
      expect(mocks.complete).toHaveBeenCalledWith(
        LEAD_ID,
        WORKER_ID,
        "provider-message-1",
      );
    },
  );

  it("retries completion independently without replaying the provider send", async () => {
    mocks.complete.mockRejectedValue(
      new LeadNotificationStoreError(
        "network-error",
        "network unavailable",
      ),
    );

    await expect(
      completeLeadNotificationStep(WORKER_ID, delivery),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails closed if the completion no longer owns the claim", async () => {
    mocks.complete.mockResolvedValue("ownership_lost");

    await expect(
      completeLeadNotificationStep(WORKER_ID, delivery),
    ).rejects.toBeInstanceOf(FatalError);
  });

  it("uses a bounded retry budget for receipt finalization", () => {
    expect(completeLeadNotificationStep.maxRetries).toBe(5);
  });
});
