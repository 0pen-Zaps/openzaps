import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  closeMock,
  buildScheduledMock,
  collectMock,
  completeMock,
  createHookMock,
  emitMock,
  generateMock,
  notifyMock,
  publishMock,
  publishScheduledMock,
  scheduledRequestMock,
} = vi.hoisted(() => ({
  closeMock: vi.fn(),
  buildScheduledMock: vi.fn(),
  collectMock: vi.fn(),
  completeMock: vi.fn(),
  createHookMock: vi.fn(),
  emitMock: vi.fn(),
  generateMock: vi.fn(),
  notifyMock: vi.fn(),
  publishMock: vi.fn(),
  publishScheduledMock: vi.fn(),
  scheduledRequestMock: vi.fn(),
}));

vi.mock("workflow", () => ({
  defineHook: vi.fn(() => ({
    create: createHookMock,
    resume: vi.fn(),
  })),
  getWorkflowMetadata: vi.fn(() => ({ workflowRunId: "wrun_review_1" })),
}));

vi.mock("@/workflows/marketing-agent/steps", () => ({
  closeMarketingRunStreamStep: closeMock,
  buildScheduledMarketingDraftStep: buildScheduledMock,
  collectMarketingSourcesStep: collectMock,
  completeMarketingResultStep: completeMock,
  emitMarketingRunEventStep: emitMock,
  generateMarketingDraftStep: generateMock,
  notifyMarketingReviewStep: notifyMock,
  publishMarketingBundleStep: publishMock,
  publishScheduledMarketingBundleStep: publishScheduledMock,
  scheduledMarketingDraftRequest: scheduledRequestMock,
}));

import {
  marketingDeliveryResultStatus,
  openZapsMarketingWorkflow,
  openZapsScheduledMarketingWorkflow,
} from "@/workflows/marketing-agent";
import type {
  MarketingDelivery,
  MarketingWorkflowResult,
} from "@/workflows/marketing-agent/contracts";

function deliveries(
  ...statuses: MarketingDelivery["status"][]
): MarketingDelivery[] {
  return statuses.map((status, index) => ({
    channel: index === 0 ? "x" : index === 1 ? "discord" : "substack",
    candidateId: `candidate-${index}`,
    status,
    idempotencyKey: `delivery:${index}`,
  }));
}

describe("marketing delivery result aggregation", () => {
  it.each<{
    statuses: MarketingDelivery["status"][];
    expected: MarketingWorkflowResult["status"];
  }>([
    { statuses: ["published"], expected: "published" },
    { statuses: ["published", "published"], expected: "published" },
    { statuses: ["requires_human_publish"], expected: "requires_human_publish" },
    {
      statuses: ["published", "requires_human_publish"],
      expected: "partially_published",
    },
    { statuses: ["published", "failed"], expected: "partially_published" },
    { statuses: ["published", "blocked"], expected: "partially_published" },
    {
      statuses: ["requires_human_publish", "failed"],
      expected: "completed_with_errors",
    },
    { statuses: ["failed", "blocked"], expected: "completed_with_errors" },
    { statuses: ["failed"], expected: "failed" },
    { statuses: ["blocked"], expected: "blocked" },
    { statuses: ["dry_run"], expected: "dry_run_complete" },
    { statuses: ["dry_run", "dry_run"], expected: "dry_run_complete" },
    { statuses: [], expected: "failed" },
  ])("maps $statuses to $expected", ({ statuses, expected }) => {
    expect(marketingDeliveryResultStatus(deliveries(...statuses))).toBe(expected);
  });
});

describe("marketing review workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collectMock.mockResolvedValue({ id: "source-1" });
    generateMock.mockResolvedValue({
      id: "draft-1",
      policy: [{ disposition: "require_approval" }],
      candidates: [{ id: "candidate-1", channel: "x" }],
    });
    emitMock.mockResolvedValue(undefined);
    notifyMock.mockRejectedValue(new Error("review webhook unavailable"));
    publishMock.mockResolvedValue(deliveries("published"));
    completeMock.mockImplementation(async (result: MarketingWorkflowResult) => result);
    closeMock.mockResolvedValue(undefined);

    const approval = Promise.resolve({
      decision: "approve",
      approvedBy: "authenticated-operator",
    });
    Object.assign(approval, { [Symbol.dispose]: vi.fn() });
    createHookMock.mockReturnValue(approval);
  });

  it("creates the approval hook first and survives review-notification failure", async () => {
    const result = await openZapsMarketingWorkflow({
      kind: "product_update",
      brief: "Explain the verified OpenZaps update.",
      channels: ["x"],
      sourceUrls: [],
    });

    expect(createHookMock).toHaveBeenCalledWith({
      token: "openzaps:marketing:approval:wrun_review_1",
    });
    expect(createHookMock.mock.invocationCallOrder[0]).toBeLessThan(
      notifyMock.mock.invocationCallOrder[0] as number,
    );
    expect(publishMock).toHaveBeenCalledOnce();
    expect(result.status).toBe("published");
    expect(closeMock).toHaveBeenCalledOnce();
  });
});

describe("bounded scheduled marketing workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const sourceRequest = {
      kind: "product_update" as const,
      brief: "Publish the versioned bounded-authority education template.",
      channels: ["discord" as const],
      sourceUrls: [],
    };
    scheduledRequestMock.mockReturnValue(sourceRequest);
    collectMock.mockResolvedValue({ id: "source-1" });
    buildScheduledMock.mockResolvedValue({
      id: "scheduled-1",
      policy: [{ disposition: "allow" }],
      candidates: [{ id: "candidate-1", channel: "discord" }],
    });
    emitMock.mockResolvedValue(undefined);
    publishScheduledMock.mockResolvedValue(deliveries("published"));
    completeMock.mockImplementation(async (result: MarketingWorkflowResult) => result);
    closeMock.mockResolvedValue(undefined);
  });

  it("publishes an auto-authorized template without creating a human approval hook", async () => {
    const result = await openZapsScheduledMarketingWorkflow({
      campaignId: "virtual-trading-request-zap-v2",
      channel: "discord",
      slotDay: "2026-07-31",
      contentHash: "ab".repeat(32),
    });

    expect(scheduledRequestMock).toHaveBeenCalledWith({
      campaignId: "virtual-trading-request-zap-v2",
      channel: "discord",
      slotDay: "2026-07-31",
      contentHash: "ab".repeat(32),
    });
    expect(buildScheduledMock).toHaveBeenCalledOnce();
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "draft",
        state: "auto_authorized",
      }),
    );
    expect(createHookMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(publishScheduledMock).toHaveBeenCalledOnce();
    expect(result.approval).toBeNull();
    expect(result.status).toBe("published");
  });

  it("blocks instead of falling through to review when auto-authorization is absent", async () => {
    buildScheduledMock.mockResolvedValueOnce({
      id: "scheduled-1",
      policy: [{ disposition: "require_approval" }],
      candidates: [{ id: "candidate-1", channel: "discord" }],
    });

    const result = await openZapsScheduledMarketingWorkflow({
      campaignId: "virtual-trading-request-zap-v2",
      channel: "discord",
      slotDay: "2026-07-31",
      contentHash: "ab".repeat(32),
    });

    expect(result.status).toBe("blocked");
    expect(createHookMock).not.toHaveBeenCalled();
    expect(publishScheduledMock).not.toHaveBeenCalled();
  });
});
