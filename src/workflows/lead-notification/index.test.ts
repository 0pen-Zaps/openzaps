import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  send: vi.fn(),
}));

vi.mock("workflow", () => ({
  getWorkflowMetadata: vi.fn(() => ({
    workflowRunId: "wrun_lead_notification_1",
  })),
}));
vi.mock("@/workflows/lead-notification/steps", () => ({
  completeLeadNotificationStep: mocks.complete,
  sendNextLeadNotificationStep: mocks.send,
}));

import { openZapsLeadNotificationWorkflow } from "@/workflows/lead-notification";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.complete.mockResolvedValue(undefined);
});

describe("lead notification workflow", () => {
  it("drains claims with one separate completion step per provider receipt", async () => {
    mocks.send
      .mockResolvedValueOnce({
        status: "sent",
        leadId: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
        providerMessageId: "provider-1",
      })
      .mockResolvedValueOnce({
        status: "sent",
        leadId: "019fab5e-be72-72d2-809b-0a1d4a35c86c",
        providerMessageId: "provider-2",
      })
      .mockResolvedValueOnce({ status: "empty" });

    await expect(openZapsLeadNotificationWorkflow()).resolves.toEqual({
      processedCount: 2,
      drained: true,
    });
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(mocks.complete).toHaveBeenNthCalledWith(
      1,
      "wrun_lead_notification_1",
      {
        status: "sent",
        leadId: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
        providerMessageId: "provider-1",
      },
    );
    expect(mocks.complete).toHaveBeenNthCalledWith(
      2,
      "wrun_lead_notification_1",
      {
        status: "sent",
        leadId: "019fab5e-be72-72d2-809b-0a1d4a35c86c",
        providerMessageId: "provider-2",
      },
    );
  });

  it("stops after the bounded batch without exposing lead or provider data", async () => {
    mocks.send.mockResolvedValue({
      status: "sent",
      leadId: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
      providerMessageId: "provider-message",
    });

    await expect(openZapsLeadNotificationWorkflow()).resolves.toEqual({
      processedCount: 25,
      drained: false,
    });
    expect(mocks.send).toHaveBeenCalledTimes(25);
    expect(mocks.complete).toHaveBeenCalledTimes(25);
  });
});
