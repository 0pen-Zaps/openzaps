import "server-only";

import { Buffer } from "node:buffer";
import { z } from "zod";

import { leadFingerprint } from "@/lib/leads/fingerprint";
import { qualificationScore } from "@/lib/leads/qualification";
import {
  LeadAttributionSchema,
  LeadRequestSchema,
  type LeadAttribution,
  type LeadPersona,
  type LeadRequest,
  type LeadTimeline,
} from "@/lib/leads/schema";
import { readBoundedJsonBody } from "@/lib/request-body";

const SUBMIT_RPC = "submit_lead_request";
const ROLLBACK_CANARY_RPC = "probe_lead_intake_write_path";
const LIST_RPC = "list_lead_requests";
const UPDATE_LIFECYCLE_RPC = "update_lead_request_lifecycle";
const DELETE_RPC = "delete_lead_request";
const PURGE_RPC = "purge_expired_lead_requests";
const RPC_TIMEOUT_MS = 12_000;
const MAX_SUBMIT_RESPONSE_BYTES = 4_096;
const MAX_CANARY_RESPONSE_BYTES = 4_096;
const MAX_LIST_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_READINESS_RESPONSE_BYTES = 5 * 1_024 * 1_024;
const ROLLBACK_CANARY_SQLSTATE = "PZC01";
const ROLLBACK_CANARY_MESSAGE =
  "OPENZAPS_LEAD_INTAKE_CANARY_ROLLED_BACK";
const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/u;

type Environment = Readonly<Record<string, string | undefined>>;
type HeaderReader = Pick<Headers, "get">;

interface LeadDependencies {
  env?: Environment;
  fetchImpl?: typeof fetch;
}

interface LeadConfiguration {
  restUrl: string;
  serviceRoleKey: string;
  fingerprintSecret: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type LeadStoreErrorCode =
  | "not-configured"
  | "invalid-input"
  | "network-error"
  | "rpc-error"
  | "invalid-response";

export class LeadStoreError extends Error {
  constructor(
    readonly code: LeadStoreErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LeadStoreError";
  }
}

export type LeadSubmissionResult = "accepted" | "quota_reached";
export type LeadStatus = "new" | "contacted" | "qualified" | "closed";

export interface LeadIntakeRollbackCanaryResult {
  result: "passed";
  transaction: "rolled_back";
  verified: Readonly<{
    quota: true;
    lead: true;
    lifecycle: true;
    notificationOutbox: true;
  }>;
  persistentRows: 0;
  notificationDispatched: false;
}

export type LeadLifecycleUpdateResult =
  | Readonly<{
      result: "updated";
      id: string;
      status: LeadStatus;
      updatedAt: string;
      expiresAt: string;
    }>
  | Readonly<{
      result: "not_found";
    }>
  | Readonly<{
      result: "expired";
    }>
  | Readonly<{
      result: "invalid_transition";
    }>;

export interface OperatorLead {
  id: string;
  persona: LeadPersona;
  name: string;
  email: string;
  project: string | null;
  projectUrl: string | null;
  workflow: string;
  protocolsAssets: string | null;
  trigger: string;
  guardrails: string;
  timeline: LeadTimeline;
  consentToContact: true;
  consentVersion: "lead-contact-v1";
  consentedAt: string;
  emailVerified: boolean;
  attribution: LeadAttribution;
  qualificationScore: number;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

function serverSecret(
  value: string | undefined,
  minimumBytes = 1,
): value is string {
  return (
    typeof value === "string"
    && value === value.trim()
    && !/[\r\n]/u.test(value)
    && Buffer.byteLength(value, "utf8") >= minimumBytes
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

function leadConfiguration(env: Environment): LeadConfiguration | null {
  const baseUrl = canonicalSupabaseUrl(
    env.SUPABASE_URL,
    env.OPENZAPS_SUPABASE_PROJECT_REF,
    env.NODE_ENV !== "production",
  );
  if (
    !baseUrl
    || !serverSecret(env.SUPABASE_SERVICE_ROLE_KEY)
    || !serverSecret(env.OPENZAPS_LEAD_FINGERPRINT_SECRET, 32)
  ) {
    return null;
  }
  return {
    restUrl: new URL(
      "rest/v1/",
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    ).toString(),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    fingerprintSecret: env.OPENZAPS_LEAD_FINGERPRINT_SECRET,
  };
}

export function leadStoreConfigured(
  env: Environment = process.env,
): boolean {
  return leadConfiguration(env) !== null;
}

/**
 * Verify the configured PostgREST origin, service-role authentication, and the
 * exact intake RPC without reading or mutating any lead rows.
 */
export async function probeLeadStoreReadiness(
  dependencies: LeadDependencies = {},
): Promise<boolean> {
  const configuration = leadConfiguration(
    dependencies.env ?? process.env,
  );
  if (!configuration) return false;

  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(configuration.restUrl, {
      headers: {
        accept: "application/openapi+json",
        apikey: configuration.serviceRoleKey,
        authorization: `Bearer ${configuration.serviceRoleKey}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  try {
    const schema = await readBoundedJsonBody(
      response,
      MAX_READINESS_RESPONSE_BYTES,
    );
    const root = isRecord(schema) ? schema : null;
    const paths = isRecord(root?.paths) ? root.paths : null;
    const intakeRpc = isRecord(paths?.["/rpc/submit_lead_request"])
      ? paths["/rpc/submit_lead_request"]
      : null;
    return isRecord(intakeRpc?.post);
  } catch {
    return false;
  }
}

function requireLeadConfiguration(env: Environment): LeadConfiguration {
  const configuration = leadConfiguration(env);
  if (!configuration) {
    throw new LeadStoreError(
      "not-configured",
      "The private lead store is not configured.",
    );
  }
  return configuration;
}

async function callLeadRpc(
  name:
    | typeof SUBMIT_RPC
    | typeof LIST_RPC
    | typeof UPDATE_LIFECYCLE_RPC
    | typeof DELETE_RPC
    | typeof PURGE_RPC,
  body: Record<string, unknown>,
  maxResponseBytes: number,
  dependencies: LeadDependencies,
): Promise<unknown> {
  const configuration = requireLeadConfiguration(
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
    throw new LeadStoreError(
      "network-error",
      "The private lead store could not be reached.",
    );
  }

  if (!response.ok) {
    throw new LeadStoreError(
      "rpc-error",
      `The private lead store rejected the request (${response.status}).`,
      response.status,
    );
  }

  try {
    return await readBoundedJsonBody(response, maxResponseBytes);
  } catch {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid response.",
    );
  }
}

function singleResultCode(value: unknown): string {
  if (
    !Array.isArray(value)
    || value.length !== 1
    || !value[0]
    || typeof value[0] !== "object"
  ) {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid response.",
    );
  }
  const keys = Object.keys(value[0] as Record<string, unknown>);
  const result = (value[0] as Record<string, unknown>).result_code;
  if (
    keys.length !== 1
    || keys[0] !== "result_code"
    || typeof result !== "string"
  ) {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid response.",
    );
  }
  return result;
}

export async function submitLeadRequest(
  input: LeadRequest,
  headers: HeaderReader,
  dependencies: LeadDependencies = {},
): Promise<LeadSubmissionResult> {
  const parsed = LeadRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.website.length > 0) {
    throw new LeadStoreError(
      "invalid-input",
      "Lead intake data did not pass server validation.",
    );
  }

  const configuration = requireLeadConfiguration(
    dependencies.env ?? process.env,
  );
  const result = singleResultCode(
    await callLeadRpc(
      SUBMIT_RPC,
      {
        p_fingerprint: leadFingerprint(
          headers,
          configuration.fingerprintSecret,
        ),
        p_persona: parsed.data.persona,
        p_name: parsed.data.name,
        p_email: parsed.data.email,
        p_project: parsed.data.project ?? null,
        p_project_url: parsed.data.projectUrl ?? null,
        p_workflow: parsed.data.workflow,
        p_protocols_assets: parsed.data.protocolsAssets ?? null,
        p_trigger: parsed.data.trigger,
        p_guardrails: parsed.data.guardrails,
        p_timeline: parsed.data.timeline,
        p_consent_to_contact: parsed.data.consent,
        p_attribution: parsed.data.attribution,
        p_qualification_score: qualificationScore(parsed.data),
      },
      MAX_SUBMIT_RESPONSE_BYTES,
      dependencies,
    ),
  );

  if (result === "accepted" || result === "quota_reached") return result;
  if (result === "invalid_input") {
    throw new LeadStoreError(
      "invalid-input",
      "The lead store rejected validated intake data.",
    );
  }
  throw new LeadStoreError(
    "invalid-response",
    "The private lead store returned an unknown result.",
  );
}

/**
 * Verify that the production intake RPC is present in the authenticated
 * PostgREST schema, then exercise its public wrapper and database triggers
 * without retaining quota, lead, lifecycle, or notification-outbox rows. The
 * database probe verifies those transient effects and then raises a dedicated
 * uncaught exception, forcing PostgreSQL to roll back the Data API transaction.
 * The lifecycle identity sequence still advances because PostgreSQL sequences
 * are non-transactional. Only the exact SQLSTATE/message pair is interpreted as
 * a healthy canary.
 */
export async function runLeadIntakeRollbackCanary(
  dependencies: LeadDependencies = {},
): Promise<LeadIntakeRollbackCanaryResult> {
  const configuration = requireLeadConfiguration(
    dependencies.env ?? process.env,
  );
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  if (
    !(await probeLeadStoreReadiness({
      env: dependencies.env ?? process.env,
      fetchImpl,
    }))
  ) {
    throw new LeadStoreError(
      "rpc-error",
      "The public lead-intake RPC is not ready.",
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(
      new URL(`rpc/${ROLLBACK_CANARY_RPC}`, configuration.restUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: configuration.serviceRoleKey,
          authorization: `Bearer ${configuration.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: "{}",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      },
    );
  } catch {
    throw new LeadStoreError(
      "network-error",
      "The private lead store rollback canary could not be reached.",
    );
  }

  let errorBody: unknown;
  try {
    errorBody = await readBoundedJsonBody(
      response,
      MAX_CANARY_RESPONSE_BYTES,
    );
  } catch {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid rollback-canary response.",
      response.status,
    );
  }

  if (
    response.status !== 400
    || !isRecord(errorBody)
    || errorBody.code !== ROLLBACK_CANARY_SQLSTATE
    || errorBody.message !== ROLLBACK_CANARY_MESSAGE
  ) {
    throw new LeadStoreError(
      "rpc-error",
      "The private lead store did not confirm a rolled-back canary.",
      response.status,
    );
  }

  return {
    result: "passed",
    transaction: "rolled_back",
    verified: {
      quota: true,
      lead: true,
      lifecycle: true,
      notificationOutbox: true,
    },
    persistentRows: 0,
    notificationDispatched: false,
  };
}

const OperatorLeadRowSchema = z
  .object({
    id: z.string().uuid(),
    persona: z.enum(["agent_builder", "protocol_team", "defi_user"]),
    name: z.string().min(2).max(100),
    email: z.string().max(254).email(),
    project: z.string().min(1).max(120).nullable(),
    project_url: z
      .string()
      .url()
      .max(500)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:"
            && url.username.length === 0
            && url.password.length === 0
          );
        } catch {
          return false;
        }
      })
      .nullable(),
    workflow: z.string().min(20).max(4000),
    protocols_assets: z.string().min(1).max(2000).nullable(),
    trigger_description: z.string().min(3).max(2000),
    guardrails: z.string().min(10).max(2000),
    timeline: z.enum([
      "immediately",
      "within_30_days",
      "within_90_days",
      "exploring",
    ]),
    consent_to_contact: z.literal(true),
    consent_version: z.literal("lead-contact-v1"),
    consented_at: z.iso.datetime({ offset: true }),
    email_verified: z.boolean(),
    attribution: LeadAttributionSchema,
    qualification_score: z.number().int().min(0).max(5),
    status: z.enum(["new", "contacted", "qualified", "closed"]),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();

const LeadIdSchema = z.string().uuid();
const LeadStatusSchema = z.enum([
  "new",
  "contacted",
  "qualified",
  "closed",
]);

export async function listLeadRequests(
  query: { limit: number; minScore: number },
  dependencies: LeadDependencies = {},
): Promise<OperatorLead[]> {
  if (
    !Number.isSafeInteger(query.limit)
    || query.limit < 1
    || query.limit > 100
    || !Number.isSafeInteger(query.minScore)
    || query.minScore < 0
    || query.minScore > 5
  ) {
    throw new LeadStoreError(
      "invalid-input",
      "The lead queue query is invalid.",
    );
  }

  const raw = await callLeadRpc(
    LIST_RPC,
    {
      p_limit: query.limit,
      p_min_score: query.minScore,
    },
    MAX_LIST_RESPONSE_BYTES,
    dependencies,
  );
  if (!Array.isArray(raw) || raw.length > query.limit) {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid queue.",
    );
  }

  return raw.map((candidate) => {
    const parsed = OperatorLeadRowSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new LeadStoreError(
        "invalid-response",
        "The private lead store returned an invalid lead.",
      );
    }
    const row = parsed.data;
    return {
      id: row.id,
      persona: row.persona,
      name: row.name,
      email: row.email,
      project: row.project,
      projectUrl: row.project_url,
      workflow: row.workflow,
      protocolsAssets: row.protocols_assets,
      trigger: row.trigger_description,
      guardrails: row.guardrails,
      timeline: row.timeline,
      consentToContact: row.consent_to_contact,
      consentVersion: row.consent_version,
      consentedAt: row.consented_at,
      emailVerified: row.email_verified,
      attribution: row.attribution,
      qualificationScore: row.qualification_score,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  });
}

const LeadLifecycleRowSchema = z
  .object({
    result_code: z.enum([
      "updated",
      "not_found",
      "expired",
      "invalid_transition",
      "invalid_input",
    ]),
    id: z.string().uuid().nullable(),
    status: LeadStatusSchema.nullable(),
    updated_at: z.iso.datetime({ offset: true }).nullable(),
    expires_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export async function updateLeadRequestLifecycle(
  id: string,
  status: LeadStatus,
  dependencies: LeadDependencies = {},
): Promise<LeadLifecycleUpdateResult> {
  const parsedId = LeadIdSchema.safeParse(id);
  const parsedStatus = LeadStatusSchema.safeParse(status);
  if (!parsedId.success || !parsedStatus.success) {
    throw new LeadStoreError(
      "invalid-input",
      "The lead lifecycle update is invalid.",
    );
  }

  const raw = await callLeadRpc(
    UPDATE_LIFECYCLE_RPC,
    {
      p_id: parsedId.data,
      p_status: parsedStatus.data,
    },
    MAX_SUBMIT_RESPONSE_BYTES,
    dependencies,
  );
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid lifecycle result.",
    );
  }

  const parsed = LeadLifecycleRowSchema.safeParse(raw[0]);
  if (!parsed.success) {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid lifecycle result.",
    );
  }
  const row = parsed.data;

  if (row.result_code === "updated") {
    if (
      row.id === null
      || row.status === null
      || row.updated_at === null
      || row.expires_at === null
    ) {
      throw new LeadStoreError(
        "invalid-response",
        "The private lead store returned an invalid lifecycle result.",
      );
    }
    return {
      result: "updated",
      id: row.id,
      status: row.status,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  if (
    row.id !== null
    || row.status !== null
    || row.updated_at !== null
    || row.expires_at !== null
  ) {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid lifecycle result.",
    );
  }
  if (row.result_code === "invalid_input") {
    throw new LeadStoreError(
      "invalid-input",
      "The lead store rejected a validated lifecycle update.",
    );
  }
  return { result: row.result_code };
}

function deletedCount(value: unknown, operation: string): number {
  if (
    !Array.isArray(value)
    || value.length !== 1
    || !isRecord(value[0])
    || Object.keys(value[0]).length !== 1
  ) {
    throw new LeadStoreError(
      "invalid-response",
      `The private lead store returned an invalid ${operation} result.`,
    );
  }
  const rawCount = value[0].deleted_count;
  const parsed =
    typeof rawCount === "number"
      ? rawCount
      : typeof rawCount === "string" && /^\d+$/u.test(rawCount)
        ? Number(rawCount)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new LeadStoreError(
      "invalid-response",
      `The private lead store returned an invalid ${operation} result.`,
    );
  }
  return parsed;
}

export async function deleteLeadRequest(
  id: string,
  dependencies: LeadDependencies = {},
): Promise<boolean> {
  const parsedId = LeadIdSchema.safeParse(id);
  if (!parsedId.success) {
    throw new LeadStoreError(
      "invalid-input",
      "The lead deletion target is invalid.",
    );
  }
  const count = deletedCount(
    await callLeadRpc(
      DELETE_RPC,
      { p_id: parsedId.data },
      MAX_SUBMIT_RESPONSE_BYTES,
      dependencies,
    ),
    "deletion",
  );
  if (count > 1) {
    throw new LeadStoreError(
      "invalid-response",
      "The private lead store returned an invalid deletion result.",
    );
  }
  return count === 1;
}

export async function purgeExpiredLeadRequests(
  dependencies: LeadDependencies = {},
): Promise<number> {
  return deletedCount(
    await callLeadRpc(
      PURGE_RPC,
      {},
      MAX_SUBMIT_RESPONSE_BYTES,
      dependencies,
    ),
    "retention",
  );
}
