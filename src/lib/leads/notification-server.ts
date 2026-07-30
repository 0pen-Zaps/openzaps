import "server-only";

import { Buffer } from "node:buffer";
import { z } from "zod";

import {
  ClaimedLeadEmailSchema,
  leadNotificationEmailConfigured,
  type ClaimedLeadEmail,
} from "@/lib/leads/notification-email";
import { readBoundedJsonBody } from "@/lib/request-body";

const CLAIM_RPC = "claim_next_lead_notification";
const COMPLETE_RPC = "complete_lead_notification";
const FAIL_RPC = "fail_lead_notification";
const RPC_TIMEOUT_MS = 12_000;
const MAX_RPC_RESPONSE_BYTES = 32 * 1_024;
const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/u;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROVIDER_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

type Environment = Readonly<Record<string, string | undefined>>;

interface NotificationStoreDependencies {
  env?: Environment;
  fetchImpl?: typeof fetch;
}

interface NotificationStoreConfiguration {
  restUrl: string;
  serviceRoleKey: string;
}

export type LeadNotificationStoreErrorCode =
  | "not-configured"
  | "invalid-input"
  | "network-error"
  | "rpc-error"
  | "invalid-response";

export class LeadNotificationStoreError extends Error {
  constructor(
    readonly code: LeadNotificationStoreErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LeadNotificationStoreError";
  }
}

export type CompleteLeadNotificationResult =
  | "sent"
  | "already_sent"
  | "ownership_lost"
  | "not_found"
  | "invalid_input";

export type FailLeadNotificationResult =
  | "released"
  | "permanent_failure"
  | "ownership_lost"
  | "not_found"
  | "invalid_input";

function serverSecret(value: string | undefined): value is string {
  return (
    typeof value === "string"
    && value === value.trim()
    && !/[\r\n]/u.test(value)
    && Buffer.byteLength(value, "utf8") > 0
  );
}

function canonicalSupabaseUrl(
  raw: string | undefined,
  expectedProjectRef: string | undefined,
  allowLoopback: boolean,
): string | null {
  if (!raw || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    const local =
      allowLoopback
      && url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const hosted =
      url.protocol === "https:"
      && !url.port
      && typeof expectedProjectRef === "string"
      && SUPABASE_PROJECT_REF.test(expectedProjectRef)
      && url.hostname === `${expectedProjectRef}.supabase.co`;
    if (
      (!local && !hosted)
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function notificationStoreConfiguration(
  env: Environment,
): NotificationStoreConfiguration | null {
  const baseUrl = canonicalSupabaseUrl(
    env.SUPABASE_URL,
    env.OPENZAPS_SUPABASE_PROJECT_REF,
    env.NODE_ENV !== "production",
  );
  if (!baseUrl || !serverSecret(env.SUPABASE_SERVICE_ROLE_KEY)) return null;
  return {
    restUrl: new URL(
      "rest/v1/",
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    ).toString(),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

export function leadNotificationStoreConfigured(
  env: Environment = process.env,
): boolean {
  return notificationStoreConfiguration(env) !== null;
}

export function leadNotificationDeliveryConfigured(
  env: Environment = process.env,
): boolean {
  try {
    return (
      leadNotificationStoreConfigured(env)
      && leadNotificationEmailConfigured(env)
    );
  } catch {
    return false;
  }
}

function requireNotificationStoreConfiguration(
  env: Environment,
): NotificationStoreConfiguration {
  const configuration = notificationStoreConfiguration(env);
  if (!configuration) {
    throw new LeadNotificationStoreError(
      "not-configured",
      "The private lead notification store is not configured.",
    );
  }
  return configuration;
}

function validWorkerId(workerId: string): boolean {
  return WORKER_ID.test(workerId);
}

async function callNotificationRpc(
  name: typeof CLAIM_RPC | typeof COMPLETE_RPC | typeof FAIL_RPC,
  body: Record<string, unknown>,
  dependencies: NotificationStoreDependencies,
): Promise<unknown> {
  const configuration = requireNotificationStoreConfiguration(
    dependencies.env ?? process.env,
  );
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(
      new URL(`rpc/${name}`, configuration.restUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: configuration.serviceRoleKey,
          authorization: `Bearer ${configuration.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      },
    );
  } catch {
    throw new LeadNotificationStoreError(
      "network-error",
      "The private lead notification store could not be reached.",
    );
  }

  if (!response.ok) {
    throw new LeadNotificationStoreError(
      "rpc-error",
      `The private lead notification store rejected the request (${response.status}).`,
      response.status,
    );
  }

  try {
    return await readBoundedJsonBody(response, MAX_RPC_RESPONSE_BYTES);
  } catch {
    throw new LeadNotificationStoreError(
      "invalid-response",
      "The private lead notification store returned an invalid response.",
    );
  }
}

function singleResult<T extends string>(
  value: unknown,
  schema: z.ZodEnum<Record<T, T>>,
): T {
  const resultSchema = z
    .array(z.object({ result_code: schema }).strict())
    .length(1);
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) {
    throw new LeadNotificationStoreError(
      "invalid-response",
      "The private lead notification store returned an invalid result.",
    );
  }
  return parsed.data[0].result_code;
}

export async function claimNextLeadNotification(
  workerId: string,
  dependencies: NotificationStoreDependencies = {},
): Promise<ClaimedLeadEmail | null> {
  if (!validWorkerId(workerId)) {
    throw new LeadNotificationStoreError(
      "invalid-input",
      "The lead notification worker id is invalid.",
    );
  }
  const raw = await callNotificationRpc(
    CLAIM_RPC,
    { p_worker_id: workerId },
    dependencies,
  );
  if (!Array.isArray(raw) || raw.length > 1) {
    throw new LeadNotificationStoreError(
      "invalid-response",
      "The private lead notification store returned an invalid claim.",
    );
  }
  if (raw.length === 0) return null;
  const parsed = ClaimedLeadEmailSchema.safeParse(raw[0]);
  if (!parsed.success) {
    throw new LeadNotificationStoreError(
      "invalid-response",
      "The private lead notification store returned an invalid claim.",
    );
  }
  return parsed.data;
}

const CompleteResultSchema = z.enum([
  "sent",
  "already_sent",
  "ownership_lost",
  "not_found",
  "invalid_input",
]);

export async function completeLeadNotification(
  leadId: string,
  workerId: string,
  providerMessageId: string,
  dependencies: NotificationStoreDependencies = {},
): Promise<CompleteLeadNotificationResult> {
  if (
    !z.string().uuid().safeParse(leadId).success
    || !validWorkerId(workerId)
    || !PROVIDER_MESSAGE_ID.test(providerMessageId)
  ) {
    throw new LeadNotificationStoreError(
      "invalid-input",
      "The lead notification completion is invalid.",
    );
  }
  return singleResult(
    await callNotificationRpc(
      COMPLETE_RPC,
      {
        p_lead_id: leadId,
        p_worker_id: workerId,
        p_provider_message_id: providerMessageId,
      },
      dependencies,
    ),
    CompleteResultSchema,
  );
}

const FailResultSchema = z.enum([
  "released",
  "permanent_failure",
  "ownership_lost",
  "not_found",
  "invalid_input",
]);

export async function failLeadNotification(
  leadId: string,
  workerId: string,
  failureCode: string,
  permanent: boolean,
  dependencies: NotificationStoreDependencies = {},
): Promise<FailLeadNotificationResult> {
  if (
    !z.string().uuid().safeParse(leadId).success
    || !validWorkerId(workerId)
    || !FAILURE_CODE.test(failureCode)
    || typeof permanent !== "boolean"
  ) {
    throw new LeadNotificationStoreError(
      "invalid-input",
      "The lead notification failure result is invalid.",
    );
  }
  return singleResult(
    await callNotificationRpc(
      FAIL_RPC,
      {
        p_lead_id: leadId,
        p_worker_id: workerId,
        p_failure_code: failureCode,
        p_permanent: permanent,
      },
      dependencies,
    ),
    FailResultSchema,
  );
}
