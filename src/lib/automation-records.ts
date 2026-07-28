import { getAddress, type Address, type Hex } from "viem";

import type { AutomationMode } from "@/lib/automate";
import {
  parseRelaySubmission,
  relayIntentNonce,
  type RelayIntentKind,
  type RelaySubmission,
} from "@/lib/relay";

/**
 * Browser-local automation metadata. The signed intent is the portable source
 * of truth; the other fields only make the UI readable. Onchain nonce/series
 * state always wins over this cache.
 */
export interface AutomationRecord {
  address: Address;
  routeId: string;
  mode: AutomationMode;
  amountPerRun: string;
  createdAt: string;
  policyHash: Hex;
  createTx?: Hex;
  plannedRuns?: number;
  terms?: string;
  intentFile?: string;
  deliveredTo?: string;
  relayId?: string;
  revokedAt?: string;
  revocationTx?: Hex;
}

export interface ParsedAutomationIntent {
  submission: RelaySubmission;
  kind: RelayIntentKind;
  mode: AutomationMode;
  zap: Address;
  authorizationId: bigint;
  validAfter: bigint;
  deadline: bigint;
  recipient: Address;
  executor: Address;
  outAsset: Address;
  interval: bigint | null;
  maxRuns: number | null;
  thresholdBps: number | null;
  above: boolean | null;
  priceSource: Address | null;
  baselinePriceX96: bigint | null;
}

export const AUTOMATION_STORAGE_KEY = "openzap:v3:automations";
export const MAX_SAVED_AUTOMATIONS = 50;

/** Parse and normalize the signed executor artifact without trusting its JSON. */
export function parseAutomationIntent(raw: string): ParsedAutomationIntent | null {
  try {
    const submission = parseRelaySubmission(JSON.parse(raw) as unknown);
    const intent = submission.intent;
    const kind = submission.kind;
    const recurring = kind === "recurring" || kind === "recurring-relative" || kind === "recurring-stack";
    const authorizationId = BigInt(relayIntentNonce(submission));
    const maxRuns = recurring ? boundedNumber(intent.maxRuns, 1, 0xffff_ffff) : null;
    const thresholdBps = kind === "trigger" ? boundedNumber(intent.thresholdBps, 1, 10_000) : null;
    if ((recurring && maxRuns === null) || (kind === "trigger" && thresholdBps === null)) return null;

    return {
      submission,
      kind,
      mode: recurring ? "recurring" : "trigger",
      zap: getAddress(String(intent.zap)),
      authorizationId,
      validAfter: BigInt(String(intent.validAfter)),
      deadline: BigInt(String(intent.deadline)),
      recipient: getAddress(String(intent.recipient)),
      executor: getAddress(String(intent.executor)),
      outAsset: getAddress(String(intent.outAsset)),
      interval: recurring ? BigInt(String(intent.interval)) : null,
      maxRuns,
      thresholdBps,
      above: kind === "trigger" ? intent.above === true : null,
      priceSource: kind === "trigger" ? getAddress(String(intent.priceSource)) : null,
      baselinePriceX96: kind === "trigger" ? BigInt(String(intent.baselinePriceX96)) : null,
    };
  } catch {
    return null;
  }
}

/** Stable identity for one immutable nonce/series authorization. */
export function automationIntentKey(intent: ParsedAutomationIntent): string {
  return `${intent.zap.toLowerCase()}:${intent.authorizationId.toString()}`;
}

/** Match control metadata to one authorization, never merely to its capsule. */
export function automationRecordMatchesIntentKey(record: AutomationRecord, key: string): boolean {
  const parsed = record.intentFile ? parseAutomationIntent(record.intentFile) : null;
  return parsed !== null && automationIntentKey(parsed) === key;
}

/** Parse a localStorage value, dropping malformed or authority-inconsistent rows. */
export function parseAutomationRecords(raw: string | null): AutomationRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const records = parsed.flatMap(parseRecord);
    const byAddress = new Map<string, AutomationRecord>();
    for (const record of records) {
      const key = record.address.toLowerCase();
      const current = byAddress.get(key);
      if (!current || record.createdAt >= current.createdAt) byAddress.set(key, record);
    }
    return [...byAddress.values()].slice(0, MAX_SAVED_AUTOMATIONS);
  } catch {
    return [];
  }
}

export function readAutomationRecords(owner: Address, storage: Pick<Storage, "getItem"> = window.localStorage): AutomationRecord[] {
  try {
    return parseAutomationRecords(storage.getItem(storageKey(owner)));
  } catch {
    return [];
  }
}

export function saveAutomationRecords(
  owner: Address,
  records: readonly AutomationRecord[],
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(storageKey(owner), JSON.stringify(records.slice(0, MAX_SAVED_AUTOMATIONS)));
  } catch {
    // Persistence is optional. The capsule and its events remain authoritative.
  }
}

export function automationStorageKey(owner: Address): string {
  return storageKey(owner);
}

function storageKey(owner: Address): string {
  return `${AUTOMATION_STORAGE_KEY}:${owner.toLowerCase()}`;
}

function parseRecord(value: unknown): AutomationRecord[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  if (
    typeof row.address !== "string" ||
    typeof row.routeId !== "string" ||
    typeof row.amountPerRun !== "string" ||
    typeof row.policyHash !== "string" ||
    (row.mode !== "recurring" && row.mode !== "trigger") ||
    !/^0x[0-9a-fA-F]{64}$/.test(row.policyHash)
  ) {
    return [];
  }

  try {
    if (BigInt(row.amountPerRun) <= 0n) return [];
    const address = getAddress(row.address);
    const intentFile = typeof row.intentFile === "string" ? row.intentFile : undefined;
    const parsedIntent = intentFile ? parseAutomationIntent(intentFile) : null;
    if (
      intentFile && (
        !parsedIntent ||
        parsedIntent.zap !== address ||
        parsedIntent.mode !== row.mode ||
        String(parsedIntent.submission.intent.policyHash).toLowerCase() !== row.policyHash.toLowerCase()
      )
    ) return [];

    return [{
      address,
      routeId: row.routeId,
      mode: row.mode,
      amountPerRun: row.amountPerRun,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
      policyHash: row.policyHash as Hex,
      createTx: optionalHash(row.createTx),
      plannedRuns: boundedOptionalNumber(row.plannedRuns, 1, 0xffff_ffff),
      terms: optionalString(row.terms),
      intentFile,
      deliveredTo: optionalString(row.deliveredTo),
      relayId: optionalUuid(row.relayId),
      revokedAt: optionalString(row.revokedAt),
      revocationTx: optionalHash(row.revocationTx),
    }];
  } catch {
    return [];
  }
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function boundedOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const number = boundedNumber(value, min, max);
  return number === null ? undefined : number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 2_048 ? value : undefined;
}

function optionalUuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

function optionalHash(value: unknown): Hex | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value as Hex : undefined;
}
