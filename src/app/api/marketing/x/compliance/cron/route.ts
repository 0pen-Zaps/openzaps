import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isCronAuthorized } from "@/lib/cron-auth";
import {
  lookupXComplianceSubjects,
  verifyXAuthenticatedIdentity,
} from "@/lib/marketing/channels/x";
import { ChannelAdapterError } from "@/lib/marketing/channels/shared";
import {
  initializeMarketingXComplianceAccount,
  listMarketingXComplianceSubjects,
  marketingXComplianceConfigured,
  recordMarketingXComplianceCheckpoint,
  type XComplianceObservation,
  type XComplianceSubject,
} from "@/lib/marketing/x-compliance-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = { "cache-control": "private, no-store" } as const;
const X_ACCOUNT_ID = /^[1-9][0-9]{0,18}$/u;
const SUBJECT_LIMIT = 5_000;
const PROVIDER_BATCH_SIZE = 100;
const LOOKUP_CONCURRENCY = 5;

type XComplianceFailureStage =
  | "list_subjects"
  | "verify_identity"
  | "initialize_account"
  | "relist_subjects"
  | "lookup_subjects"
  | "record_checkpoint";

function response(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function logReconciliationFailure(
  stage: XComplianceFailureStage,
  error: unknown,
): void {
  const adapterError = error instanceof ChannelAdapterError ? error : null;
  const providerStatus = adapterError?.details.status;
  console.error(JSON.stringify({
    event: "marketing_x_compliance_reconciliation_failed",
    stage,
    errorCode: adapterError?.code ?? "internal-error",
    ...(Number.isSafeInteger(providerStatus) ? { providerStatus } : {}),
  }));
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

async function observeSubjects(
  accountId: string,
  subjects: readonly XComplianceSubject[],
): Promise<XComplianceObservation[]> {
  const postIds = subjects
    .filter((subject) => subject.subjectKind === "post")
    .map((subject) => subject.subjectId);
  const userIds = [...new Set(
    subjects
      .filter((subject) => subject.subjectKind !== "post")
      .map((subject) => subject.subjectId),
  )];
  const postBatches = chunks(postIds, PROVIDER_BATCH_SIZE);
  const userBatches = chunks(userIds, PROVIDER_BATCH_SIZE);
  const batchCount = Math.max(postBatches.length, userBatches.length);
  if (batchCount === 0) throw new Error("The compliance subject set is empty.");

  const batches = Array.from({ length: batchCount }, (_, index) => ({
    postIds: postBatches[index] ?? [],
    userIds: userBatches[index] ?? [],
  }));
  const results = new Array<Awaited<ReturnType<typeof lookupXComplianceSubjects>>>(
    batches.length,
  );
  let nextBatch = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(LOOKUP_CONCURRENCY, batches.length) },
      async () => {
        for (;;) {
          const index = nextBatch;
          nextBatch += 1;
          if (index >= batches.length) return;
          results[index] = await lookupXComplianceSubjects(
            batches[index],
            { requestTimeoutMs: 8_000 },
          );
        }
      },
    ),
  );

  const postOutcomes = new Map<string, XComplianceObservation["outcome"]>();
  const userOutcomes = new Map<string, XComplianceObservation["outcome"]>();
  for (const lookup of results) {
    if (lookup.authenticatedAccountId !== accountId) {
      throw new Error("The X compliance identity changed.");
    }
    for (const observation of lookup.observations) {
      const outcomes = observation.subjectKind === "post"
        ? postOutcomes
        : userOutcomes;
      if (outcomes.has(observation.subjectId)) {
        throw new Error("X returned duplicate compliance observations.");
      }
      outcomes.set(observation.subjectId, observation.status);
    }
  }

  return subjects.map((subject) => {
    const outcome = subject.subjectKind === "post"
      ? postOutcomes.get(subject.subjectId)
      : userOutcomes.get(subject.subjectId);
    if (!outcome) throw new Error("X omitted a compliance observation.");
    return {
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      outcome,
    };
  });
}

export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return response({ error: "Unauthorized." }, 401);
  }
  const monitor = process.env.OPENZAPS_X_COMPLIANCE_MONITOR_ENABLED;
  if (monitor === undefined || monitor === "false") {
    return response({ skipped: true, reason: "X compliance monitor is disabled." });
  }
  if (monitor !== "true") {
    return response(
      { error: "X compliance monitor configuration is invalid." },
      503,
    );
  }
  const accountId = process.env.X_EXPECTED_ACCOUNT_ID;
  if (
    !accountId
    || !X_ACCOUNT_ID.test(accountId)
    || !marketingXComplianceConfigured()
  ) {
    return response({ error: "X compliance monitoring is not ready." }, 503);
  }

  let stage: XComplianceFailureStage = "list_subjects";
  try {
    let list = await listMarketingXComplianceSubjects(accountId, SUBJECT_LIMIT);
    let bootstrapped = false;
    if (list.result === "account_not_found") {
      stage = "verify_identity";
      const identity = await verifyXAuthenticatedIdentity({
        requestTimeoutMs: 8_000,
      });
      if (identity.authenticatedAccountId !== accountId) {
        throw new Error("The X compliance identity changed.");
      }
      stage = "initialize_account";
      const initialized = await initializeMarketingXComplianceAccount({
        accountId,
        verifiedAt: identity.observedAt,
      });
      if (initialized.accountId !== accountId) {
        throw new Error("The durable X compliance identity changed.");
      }
      stage = "relist_subjects";
      list = await listMarketingXComplianceSubjects(accountId, SUBJECT_LIMIT);
      if (list.result === "account_not_found") {
        throw new Error("The durable X compliance boundary is absent.");
      }
      bootstrapped = true;
    }
    if (list.result === "limit_exceeded") {
      return response({ error: "The X compliance subject limit was exceeded." }, 503);
    }
    const providerRunId = randomUUID();
    const startedAt = new Date().toISOString();
    stage = "lookup_subjects";
    const observations = await observeSubjects(accountId, list.subjects);
    const completedAt = new Date().toISOString();
    stage = "record_checkpoint";
    const checkpoint = await recordMarketingXComplianceCheckpoint({
      accountId,
      providerRunId,
      startedAt,
      completedAt,
      observations,
    });
    const healthy = ["recorded", "already_recorded"].includes(
      checkpoint.result,
    );
    return response(
      {
        healthy,
        result: checkpoint.result,
        checkedAt: checkpoint.checkedAt,
        validUntil: checkpoint.validUntil,
        subjectCount: checkpoint.subjectCount,
        suppressedCount: checkpoint.nonPresentCount,
        bootstrapped,
        providerWritesAttempted: false,
      },
      healthy ? 200 : 503,
    );
  } catch (error) {
    logReconciliationFailure(stage, error);
    return response(
      {
        error: "X compliance reconciliation failed closed.",
        providerWritesAttempted: false,
      },
      503,
    );
  }
}
