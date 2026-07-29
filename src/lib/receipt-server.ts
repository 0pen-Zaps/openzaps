import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { ACTIVITY_FROM_BLOCK, zapCreatedEvent } from "@/lib/activity";
import { expectedCloneRuntime } from "@/lib/openzap";
import type { RelayIntentKind } from "@/lib/relay";
import { RELAY_TABLE, relayHeaders, relayUrl } from "@/lib/relay-server";
import {
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  OPENZAP_V3_2_CONTRACTS,
  openZapFactoryV3Abi,
} from "@/lib/robinhood";

export const EXECUTION_RECEIPTS_TABLE = "execution_receipts";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The receipt verifier deliberately owns a small, exact ABI. Decoding calldata and emitted logs
 * means no caller-supplied executor, nonce, outcome, output, or fee ever becomes reputation data.
 */
export const executionReceiptAbi = parseAbi([
  "function executeRecurring((address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOutPerRun) intent,bytes sig)",
  "function executeRecurringRelative((address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps) intent,bytes sig)",
  "function executeRecurringStack((address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,address priceSource,uint32 maxSlippageBps,address stackPriceSource,uint32 stackBps) intent,bytes sig)",
  "function executeTrigger((address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address priceSource,uint256 baselinePriceX96,uint32 thresholdBps,bool above,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut) intent,bytes sig)",
  "event ExecutedRecurring(uint256 indexed seriesId,uint32 run,address indexed executor,address outAsset,uint256 amountOut,uint256 executorFee,uint256 potFee)",
  "event ExecutedRecurringRelative(uint256 indexed seriesId,uint32 run,address indexed executor,address indexed priceSource,uint256 priceX96,address outAsset,uint256 amountOut,uint256 executorFee,uint256 potFee,uint256 floor)",
  "event ExecutedRecurringStack(uint256 indexed seriesId,uint32 run,address indexed executor,address indexed priceSource,uint256 priceX96,address outAsset,uint256 amountOut,uint256 executorFee,uint256 potFee,uint256 floor,uint256 stackIn,uint256 zapsOut)",
  "event ExecutedTrigger(uint256 indexed nonce,address indexed executor,address priceSource,uint256 priceX96,address outAsset,uint256 amountOut,uint256 executorFee,uint256 potFee)",
]);

const KIND_BY_FUNCTION = {
  executeRecurring: "recurring",
  executeRecurringRelative: "recurring-relative",
  executeRecurringStack: "recurring-stack",
  executeTrigger: "trigger",
} as const satisfies Record<string, RelayIntentKind>;

const EVENT_BY_KIND: Record<RelayIntentKind, string> = {
  recurring: "ExecutedRecurring",
  "recurring-relative": "ExecutedRecurringRelative",
  "recurring-stack": "ExecutedRecurringStack",
  trigger: "ExecutedTrigger",
};

export type ExecutionReceiptOutcome = "reverted" | "finalized";

export interface ExecutionReceiptRecord {
  id?: string;
  receiptVersion: 1;
  chainId: number;
  txHash: Hex;
  relayIntentId: string;
  zap: Address;
  executor: Address;
  intentKind: RelayIntentKind;
  intentNonce: string;
  outcome: ExecutionReceiptOutcome;
  blockNumber: string;
  blockHash: Hex;
  blockTime: string;
  transactionIndex: number;
  logIndex: number | null;
  gasUsed: string;
  effectiveGasPrice: string | null;
  confirmations: number;
  eventName: string | null;
  eventPayload: Record<string, unknown>;
  provenance: ExecutionReceiptProvenance | null;
  recordedAt?: string;
  authorityScope: "none";
}

export interface RelayReceiptBinding {
  id: string;
  zap: Address;
  owner: Address;
  kind: RelayIntentKind;
  nonce: string;
  executor: Address;
  intent: Record<string, string | boolean>;
  signature: Hex;
}

export interface ExecutionReceiptProvenance {
  verified: true;
  lineage: "v3" | "v3.1" | "v3.2";
  factory: Address;
  implementation: Address;
  implementationCodeHash: Hex;
  capsuleRuntimeHash: Hex;
  creationTxHash: Hex;
  creationBlock: string;
}

/**
 * The minimum immutable claim needed to prove a capsule came from the exact
 * factory lineage assigned to an intent kind. Relay admission and receipt
 * attribution share this proof so neither can accidentally accept an ABI
 * lookalike.
 */
export interface CapsuleProvenanceClaim {
  zap: Address;
  owner: Address;
  kind: RelayIntentKind;
  policyHash: Hex;
}

type CapsuleCreationLog = {
  args?: {
    zap?: Address;
    owner?: Address;
    policyHash?: Hex;
    implCodeHash?: Hex;
  };
  transactionHash: Hex | null;
  blockNumber: bigint | null;
};

export class ReceiptVerificationError extends Error {
  constructor(
    message: string,
    readonly code: "malformed" | "not-found" | "not-final" | "mismatch" | "not-execution" | "storage",
  ) {
    super(message);
    this.name = "ReceiptVerificationError";
  }
}

export function parseReceiptRequest(body: unknown): { txHash: Hex; relayIntentId: string } {
  if (!body || typeof body !== "object") {
    throw new ReceiptVerificationError("body must be a JSON object.", "malformed");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.txHash !== "string" || !TX_HASH.test(raw.txHash)) {
    throw new ReceiptVerificationError("txHash must be a 32-byte hex hash.", "malformed");
  }
  if (typeof raw.relayIntentId !== "string" || !UUID.test(raw.relayIntentId)) {
    throw new ReceiptVerificationError("relayIntentId must be a UUID.", "malformed");
  }
  return { txHash: raw.txHash.toLowerCase() as Hex, relayIntentId: raw.relayIntentId.toLowerCase() };
}

export async function readRelayReceiptBinding(id: string): Promise<RelayReceiptBinding | null> {
  if (!UUID.test(id)) throw new ReceiptVerificationError("relayIntentId must be a UUID.", "malformed");
  const params = new URLSearchParams({
    select: "id,zap,owner,kind,nonce,intent,signature",
    id: `eq.${id}`,
    limit: "1",
  });
  const response = await fetch(relayUrl(`${RELAY_TABLE}?${params.toString()}`), {
    headers: relayHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ReceiptVerificationError(`Relay binding lookup failed (${response.status}).`, "storage");
  }
  const rows = (await response.json()) as Array<{
    id: string;
    zap: string;
    owner: string;
    kind: RelayIntentKind;
    nonce: string;
    intent: Record<string, unknown>;
    signature: string;
  }>;
  const row = rows[0];
  if (!row) return null;
  const executor = row.intent.executor;
  if (
    !isAddress(row.zap) ||
    !isAddress(row.owner) ||
    typeof executor !== "string" ||
    !isAddress(executor) ||
    typeof row.signature !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2}){65,2000}$/.test(row.signature)
  ) {
    throw new ReceiptVerificationError("Relay binding is malformed.", "storage");
  }
  return {
    id: row.id,
    zap: getAddress(row.zap),
    owner: getAddress(row.owner),
    kind: row.kind,
    nonce: row.nonce,
    executor: getAddress(executor),
    intent: row.intent as Record<string, string | boolean>,
    signature: row.signature as Hex,
  };
}

type ExpectedCapsuleLineage = {
  lineage: ExecutionReceiptProvenance["lineage"];
  factory: Address;
  implementation: Address;
};

function expectedCapsuleLineage(kind: RelayIntentKind): ExpectedCapsuleLineage {
  if (kind === "recurring-relative") {
    return {
      lineage: "v3.1",
      factory: OPENZAP_V3_1_CONTRACTS.factory,
      implementation: OPENZAP_V3_1_CONTRACTS.implementation,
    };
  }
  if (kind === "recurring-stack") {
    return {
      lineage: "v3.2",
      factory: OPENZAP_V3_2_CONTRACTS.factory,
      implementation: OPENZAP_V3_2_CONTRACTS.implementation,
    };
  }
  if (kind === "recurring" || kind === "trigger") {
    return {
      lineage: "v3",
      factory: OPENZAP_V3_CONTRACTS.factory,
      implementation: OPENZAP_V3_CONTRACTS.implementation,
    };
  }
  throw new ReceiptVerificationError("Intent kind has no configured capsule lineage.", "mismatch");
}

function lineageForFactory(factory: Address): ExecutionReceiptProvenance["lineage"] {
  if (isAddressEqual(factory, OPENZAP_V3_CONTRACTS.factory)) return "v3";
  if (isAddressEqual(factory, OPENZAP_V3_1_CONTRACTS.factory)) return "v3.1";
  if (
    OPENZAP_V3_2_CONTRACTS.factory !== zeroAddress
    && isAddressEqual(factory, OPENZAP_V3_2_CONTRACTS.factory)
  ) {
    return "v3.2";
  }
  throw new ReceiptVerificationError("Stored receipt names an unknown capsule factory.", "storage");
}

const capsuleProvenanceAbi = parseAbi([
  "function FACTORY() view returns (address)",
  "function policyHash() view returns (bytes32)",
]);

/**
 * Prove that the execution target is a clone emitted by the exact factory
 * lineage this release assigns to the intent kind. Runtime shape alone is not
 * provenance: a lookalike can clone the same implementation, so the canonical
 * factory's own indexed ZapCreated log is mandatory too.
 */
export async function verifyCapsuleProvenance(
  client: PublicClient,
  claim: CapsuleProvenanceClaim,
  atBlock: bigint,
): Promise<ExecutionReceiptProvenance> {
  const expected = expectedCapsuleLineage(claim.kind);
  if (expected.factory === zeroAddress || expected.implementation === zeroAddress) {
    throw new ReceiptVerificationError(
      `The ${expected.lineage} capsule lineage is not configured in this release.`,
      "mismatch",
    );
  }

  const policyHash = claim.policyHash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(policyHash)) {
    throw new ReceiptVerificationError("Relay intent has no valid policy hash.", "mismatch");
  }

  let factoryImplementation: Address;
  let committedImplementationHash: Hex;
  let capsuleFactory: Address;
  let capsulePolicyHash: Hex;
  let factoryRuntime: Hex | undefined;
  let implementationRuntime: Hex | undefined;
  let capsuleRuntime: Hex | undefined;
  let creationLogs: CapsuleCreationLog[];
  try {
    [
      factoryImplementation,
      committedImplementationHash,
      capsuleFactory,
      capsulePolicyHash,
      factoryRuntime,
      implementationRuntime,
      capsuleRuntime,
      creationLogs,
    ] = await Promise.all([
      client.readContract({
        address: expected.factory,
        abi: openZapFactoryV3Abi,
        functionName: "implementation",
        blockNumber: atBlock,
      }),
      client.readContract({
        address: expected.factory,
        abi: openZapFactoryV3Abi,
        functionName: "implCodeHash",
        blockNumber: atBlock,
      }),
      client.readContract({
        address: claim.zap,
        abi: capsuleProvenanceAbi,
        functionName: "FACTORY",
        blockNumber: atBlock,
      }),
      client.readContract({
        address: claim.zap,
        abi: capsuleProvenanceAbi,
        functionName: "policyHash",
        blockNumber: atBlock,
      }),
      client.getBytecode({ address: expected.factory, blockNumber: atBlock }),
      client.getBytecode({ address: expected.implementation, blockNumber: atBlock }),
      client.getBytecode({ address: claim.zap, blockNumber: atBlock }),
      client.getLogs({
        address: expected.factory,
        event: zapCreatedEvent,
        args: { zap: claim.zap },
        fromBlock: ACTIVITY_FROM_BLOCK,
        toBlock: atBlock,
        strict: true,
      }) as Promise<CapsuleCreationLog[]>,
    ]);
  } catch {
    throw new ReceiptVerificationError("Capsule factory provenance could not be read.", "not-found");
  }

  if (!factoryRuntime || factoryRuntime === "0x") {
    throw new ReceiptVerificationError("Expected capsule factory has no runtime code.", "mismatch");
  }
  if (!isAddressEqual(factoryImplementation, expected.implementation)) {
    throw new ReceiptVerificationError("Factory implementation does not match the configured lineage.", "mismatch");
  }
  if (!isAddressEqual(capsuleFactory, expected.factory)) {
    throw new ReceiptVerificationError("Capsule FACTORY does not match the configured lineage.", "mismatch");
  }
  if (capsulePolicyHash.toLowerCase() !== policyHash.toLowerCase()) {
    throw new ReceiptVerificationError("Capsule policy hash does not match the signed relay intent.", "mismatch");
  }
  if (!implementationRuntime || implementationRuntime === "0x") {
    throw new ReceiptVerificationError("Configured capsule implementation has no runtime code.", "mismatch");
  }
  const implementationCodeHash = keccak256(implementationRuntime);
  if (implementationCodeHash.toLowerCase() !== committedImplementationHash.toLowerCase()) {
    throw new ReceiptVerificationError("Implementation runtime does not match the factory codehash commitment.", "mismatch");
  }
  if (!capsuleRuntime || capsuleRuntime.toLowerCase() !== expectedCloneRuntime(expected.implementation).toLowerCase()) {
    throw new ReceiptVerificationError("Capsule runtime is not the expected canonical clone.", "mismatch");
  }

  const creation = creationLogs.find((log) =>
    log.args?.zap
    && isAddressEqual(log.args.zap, claim.zap)
    && log.args.owner
    && isAddressEqual(log.args.owner, claim.owner)
    && typeof log.args.policyHash === "string"
    && log.args.policyHash.toLowerCase() === policyHash.toLowerCase()
    && typeof log.args.implCodeHash === "string"
    && log.args.implCodeHash.toLowerCase() === implementationCodeHash.toLowerCase()
  );
  if (!creation || !creation.transactionHash || creation.blockNumber === null) {
    throw new ReceiptVerificationError(
      "Canonical factory has no matching ZapCreated provenance for this capsule.",
      "mismatch",
    );
  }

  return {
    verified: true,
    lineage: expected.lineage,
    factory: expected.factory.toLowerCase() as Address,
    implementation: expected.implementation.toLowerCase() as Address,
    implementationCodeHash: implementationCodeHash.toLowerCase() as Hex,
    capsuleRuntimeHash: keccak256(capsuleRuntime).toLowerCase() as Hex,
    creationTxHash: creation.transactionHash.toLowerCase() as Hex,
    creationBlock: creation.blockNumber.toString(),
  };
}

interface DecodedExecution {
  kind: RelayIntentKind;
  nonce: bigint;
  zap: Address;
  signedExecutor: Address;
}

export function decodeExecutionInput(input: Hex): DecodedExecution {
  try {
    const decoded = decodeFunctionData({ abi: executionReceiptAbi, data: input });
    const kind = KIND_BY_FUNCTION[decoded.functionName as keyof typeof KIND_BY_FUNCTION];
    if (!kind) throw new Error("unknown execution selector");
    const intent = decoded.args[0] as unknown as Record<string, unknown>;
    const nonce = kind === "trigger" ? intent.nonce : intent.seriesId;
    if (
      typeof nonce !== "bigint" ||
      typeof intent.zap !== "string" ||
      !isAddress(intent.zap) ||
      typeof intent.executor !== "string" ||
      !isAddress(intent.executor)
    ) {
      throw new Error("malformed execution tuple");
    }
    return {
      kind,
      nonce,
      zap: getAddress(intent.zap),
      signedExecutor: getAddress(intent.executor),
    };
  } catch {
    throw new ReceiptVerificationError("Transaction calldata is not a supported OpenZaps execution.", "not-execution");
  }
}

function relayIntentTuple(intent: RelayReceiptBinding["intent"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(intent).map(([key, value]) => [
      key,
      typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : value,
    ]),
  );
}

/** Canonical calldata for the exact relay artifact, including the exact owner signature bytes. */
export function encodeRelayExecution(binding: RelayReceiptBinding): Hex {
  return encodeFunctionData({
    abi: executionReceiptAbi,
    functionName: (
      {
        recurring: "executeRecurring",
        "recurring-relative": "executeRecurringRelative",
        "recurring-stack": "executeRecurringStack",
        trigger: "executeTrigger",
      } as const
    )[binding.kind],
    args: [relayIntentTuple(binding.intent), binding.signature],
  } as Parameters<typeof encodeFunctionData>[0]);
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonValue(nested)]));
  }
  return value;
}

function decodeExpectedEvent(
  kind: RelayIntentKind,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[]; logIndex: number | null }[],
  zap: Address,
  executor: Address,
): { name: string; payload: Record<string, unknown>; logIndex: number } {
  const expectedName = EVENT_BY_KIND[kind];
  for (const log of logs) {
    if (getAddress(log.address) !== zap) continue;
    if (log.topics.length === 0) continue;
    try {
      const event = decodeEventLog({
        abi: executionReceiptAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      if (event.eventName !== expectedName || log.logIndex === null) continue;
      const payload = jsonValue(event.args) as Record<string, unknown>;
      if (typeof payload.executor !== "string" || getAddress(payload.executor) !== executor) {
        throw new ReceiptVerificationError("Execution event executor does not match transaction sender.", "mismatch");
      }
      return { name: event.eventName, payload, logIndex: log.logIndex };
    } catch (error) {
      if (error instanceof ReceiptVerificationError) throw error;
      // Other logs from the capsule are expected; keep looking for the execution event.
    }
  }
  throw new ReceiptVerificationError(`Finalized transaction did not emit ${expectedName}.`, "not-execution");
}

/**
 * Verify one transaction against both the chain and the signed relay row. This function never
 * accepts claimed execution fields: calldata, sender, receipt, confirmations, and event data are
 * all read independently.
 */
export async function verifyExecutionReceipt(
  client: PublicClient,
  chainId: number,
  txHash: Hex,
  binding: RelayReceiptBinding,
  requiredConfirmations: number,
): Promise<ExecutionReceiptRecord> {
  let transaction;
  let receipt;
  try {
    [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
  } catch {
    throw new ReceiptVerificationError("Transaction or receipt was not found.", "not-found");
  }

  if (!transaction.to) throw new ReceiptVerificationError("Contract-creation transactions are not executions.", "not-execution");
  const expectedInput = encodeRelayExecution(binding);
  if (transaction.input.toLowerCase() !== expectedInput.toLowerCase()) {
    throw new ReceiptVerificationError(
      "Transaction calldata does not byte-for-byte match the stored signed relay artifact.",
      "mismatch",
    );
  }
  const decoded = decodeExecutionInput(transaction.input);
  const zap = getAddress(transaction.to);
  const executor = getAddress(transaction.from);
  if (decoded.zap !== zap || binding.zap !== zap || decoded.kind !== binding.kind || decoded.nonce.toString() !== binding.nonce) {
    throw new ReceiptVerificationError("Transaction does not match the signed relay intent.", "mismatch");
  }
  if (decoded.signedExecutor !== zeroAddress && decoded.signedExecutor !== executor) {
    throw new ReceiptVerificationError("Transaction sender does not match the signed executor pin.", "mismatch");
  }
  if (binding.executor !== zeroAddress && binding.executor !== executor) {
    throw new ReceiptVerificationError("Transaction sender does not match the relay executor pin.", "mismatch");
  }

  const head = await client.getBlockNumber();
  const confirmationsBig = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  const confirmations = Number(confirmationsBig);
  if (confirmations < requiredConfirmations) {
    throw new ReceiptVerificationError(
      `Transaction has ${confirmations}/${requiredConfirmations} confirmations.`,
      "not-final",
    );
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (
    typeof block.hash !== "string"
    || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
  ) {
    throw new ReceiptVerificationError(
      "Receipt block is not canonical at the observed height; retry after the RPC view converges.",
      "not-final",
    );
  }
  const policyHash = binding.intent.policyHash;
  if (typeof policyHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(policyHash)) {
    throw new ReceiptVerificationError("Relay intent has no valid policy hash.", "mismatch");
  }
  const provenance = await verifyCapsuleProvenance(
    client,
    {
      zap: binding.zap,
      owner: binding.owner,
      kind: binding.kind,
      policyHash: policyHash as Hex,
    },
    receipt.blockNumber,
  );
  const event =
    receipt.status === "success"
      ? decodeExpectedEvent(decoded.kind, receipt.logs, zap, executor)
      : { name: null, payload: {}, logIndex: null };

  return {
    receiptVersion: 1,
    chainId,
    txHash: txHash.toLowerCase() as Hex,
    relayIntentId: binding.id,
    zap: zap.toLowerCase() as Address,
    executor: executor.toLowerCase() as Address,
    intentKind: decoded.kind,
    intentNonce: decoded.nonce.toString(),
    outcome: receipt.status === "success" ? "finalized" : "reverted",
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash.toLowerCase() as Hex,
    blockTime: new Date(Number(block.timestamp) * 1_000).toISOString(),
    transactionIndex: receipt.transactionIndex,
    logIndex: event.logIndex,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
    confirmations,
    eventName: event.name,
    eventPayload: event.payload,
    provenance,
    authorityScope: "none",
  };
}

function receiptToRow(receipt: ExecutionReceiptRecord) {
  if (!receipt.provenance) {
    throw new ReceiptVerificationError("Receipt has no verified capsule provenance.", "mismatch");
  }
  return {
    receipt_version: receipt.receiptVersion,
    chain_id: receipt.chainId,
    tx_hash: receipt.txHash,
    relay_intent_id: receipt.relayIntentId,
    zap: receipt.zap,
    executor: receipt.executor,
    intent_kind: receipt.intentKind,
    intent_nonce: receipt.intentNonce,
    outcome: receipt.outcome,
    block_number: receipt.blockNumber,
    block_hash: receipt.blockHash,
    block_time: receipt.blockTime,
    transaction_index: receipt.transactionIndex,
    log_index: receipt.logIndex,
    gas_used: receipt.gasUsed,
    effective_gas_price: receipt.effectiveGasPrice,
    confirmations: receipt.confirmations,
    event_name: receipt.eventName,
    event_payload: receipt.eventPayload,
    provenance_verified: true,
    factory: receipt.provenance.factory,
    implementation: receipt.provenance.implementation,
    implementation_code_hash: receipt.provenance.implementationCodeHash,
    capsule_runtime_hash: receipt.provenance.capsuleRuntimeHash,
    creation_tx_hash: receipt.provenance.creationTxHash,
    creation_block: receipt.provenance.creationBlock,
    authority_scope: receipt.authorityScope,
  };
}

function rowToReceipt(row: Record<string, unknown>): ExecutionReceiptRecord {
  const provenance =
    row.provenance_verified === true
    && typeof row.factory === "string"
    && typeof row.implementation === "string"
    && typeof row.implementation_code_hash === "string"
    && typeof row.capsule_runtime_hash === "string"
    && typeof row.creation_tx_hash === "string"
    && row.creation_block !== null
    && row.creation_block !== undefined
      ? {
          verified: true as const,
          lineage: lineageForFactory(getAddress(row.factory)),
          factory: getAddress(row.factory),
          implementation: getAddress(row.implementation),
          implementationCodeHash: row.implementation_code_hash as Hex,
          capsuleRuntimeHash: row.capsule_runtime_hash as Hex,
          creationTxHash: row.creation_tx_hash as Hex,
          creationBlock: String(row.creation_block),
        }
      : null;
  return {
    id: String(row.id),
    receiptVersion: 1,
    chainId: Number(row.chain_id),
    txHash: String(row.tx_hash) as Hex,
    relayIntentId: String(row.relay_intent_id),
    zap: String(row.zap) as Address,
    executor: String(row.executor) as Address,
    intentKind: String(row.intent_kind) as RelayIntentKind,
    intentNonce: String(row.intent_nonce),
    outcome: String(row.outcome) as ExecutionReceiptOutcome,
    blockNumber: String(row.block_number),
    blockHash: String(row.block_hash) as Hex,
    blockTime: String(row.block_time),
    transactionIndex: Number(row.transaction_index),
    logIndex: row.log_index === null ? null : Number(row.log_index),
    gasUsed: String(row.gas_used),
    effectiveGasPrice: row.effective_gas_price === null ? null : String(row.effective_gas_price),
    confirmations: Number(row.confirmations),
    eventName: row.event_name === null ? null : String(row.event_name),
    eventPayload: (row.event_payload ?? {}) as Record<string, unknown>,
    provenance,
    recordedAt: String(row.recorded_at),
    authorityScope: "none",
  };
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function immutableReceiptFields(receipt: ExecutionReceiptRecord): Record<string, unknown> {
  return {
    receiptVersion: receipt.receiptVersion,
    chainId: receipt.chainId,
    txHash: receipt.txHash.toLowerCase(),
    relayIntentId: receipt.relayIntentId.toLowerCase(),
    zap: receipt.zap.toLowerCase(),
    executor: receipt.executor.toLowerCase(),
    intentKind: receipt.intentKind,
    intentNonce: receipt.intentNonce,
    outcome: receipt.outcome,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    blockTime: new Date(receipt.blockTime).toISOString(),
    transactionIndex: receipt.transactionIndex,
    logIndex: receipt.logIndex,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    eventName: receipt.eventName,
    eventPayload: receipt.eventPayload,
    provenance: receipt.provenance
      ? {
          verified: receipt.provenance.verified,
          lineage: receipt.provenance.lineage,
          factory: receipt.provenance.factory.toLowerCase(),
          implementation: receipt.provenance.implementation.toLowerCase(),
          implementationCodeHash: receipt.provenance.implementationCodeHash.toLowerCase(),
          capsuleRuntimeHash: receipt.provenance.capsuleRuntimeHash.toLowerCase(),
          creationTxHash: receipt.provenance.creationTxHash.toLowerCase(),
          creationBlock: receipt.provenance.creationBlock,
        }
      : null,
    authorityScope: receipt.authorityScope,
  };
}

function assertIdempotentReceiptReplay(
  stored: ExecutionReceiptRecord,
  candidate: ExecutionReceiptRecord,
): void {
  const storedFields = immutableReceiptFields(stored);
  const candidateFields = immutableReceiptFields(candidate);
  for (const [field, storedValue] of Object.entries(storedFields)) {
    if (canonicalJson(storedValue) !== canonicalJson(candidateFields[field])) {
      throw new ReceiptVerificationError(
        `Stored receipt conflicts on immutable field ${field}.`,
        "mismatch",
      );
    }
  }
}

async function storedReceiptForIdentity(
  chainId: number,
  txHash: Hex,
): Promise<ExecutionReceiptRecord | null> {
  const params = new URLSearchParams({
    select: "*",
    chain_id: `eq.${chainId}`,
    tx_hash: `eq.${txHash.toLowerCase()}`,
    provenance_verified: "eq.true",
    limit: "1",
  });
  const response = await fetch(relayUrl(`${EXECUTION_RECEIPTS_TABLE}?${params.toString()}`), {
    headers: relayHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ReceiptVerificationError(`Receipt replay lookup failed (${response.status}).`, "storage");
  }
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  return rows[0] ? rowToReceipt(rows[0]) : null;
}

/**
 * Repeated executor delivery is insert-only: a conflict leaves the durable row
 * untouched, then the API verifies that every stable chain-derived field
 * matches before returning it. Confirmations are intentionally not compared;
 * they are an observation of the current head and the stored value is never
 * rewritten by a later retry.
 */
export async function storeExecutionReceipt(receipt: ExecutionReceiptRecord): Promise<ExecutionReceiptRecord> {
  const response = await fetch(
    relayUrl(`${EXECUTION_RECEIPTS_TABLE}?on_conflict=chain_id,tx_hash`),
    {
      method: "POST",
      headers: relayHeaders({ prefer: "return=representation,resolution=ignore-duplicates" }),
      body: JSON.stringify(receiptToRow(receipt)),
    },
  );
  if (!response.ok) {
    throw new ReceiptVerificationError(`Receipt storage failed (${response.status}).`, "storage");
  }
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  if (rows[0]) return rowToReceipt(rows[0]);

  const stored = await storedReceiptForIdentity(receipt.chainId, receipt.txHash);
  if (!stored) {
    throw new ReceiptVerificationError("Receipt replay lookup returned no row.", "storage");
  }
  assertIdempotentReceiptReplay(stored, receipt);
  return stored;
}

export async function latestReceiptForIntent(
  intentId: string,
  atOrBeforeBlock?: bigint,
): Promise<ExecutionReceiptRecord | null> {
  if (!UUID.test(intentId)) return null;
  const params = new URLSearchParams({
    select: "*",
    relay_intent_id: `eq.${intentId}`,
    provenance_verified: "eq.true",
    order: "block_number.desc,tx_hash.desc",
    limit: "1",
  });
  if (atOrBeforeBlock !== undefined) {
    if (atOrBeforeBlock < 0n) throw new ReceiptVerificationError("Receipt block bound is invalid.", "malformed");
    params.set("block_number", `lte.${atOrBeforeBlock}`);
  }
  const response = await fetch(relayUrl(`${EXECUTION_RECEIPTS_TABLE}?${params.toString()}`), {
    headers: relayHeaders(),
    cache: "no-store",
  });
  if (!response.ok) throw new ReceiptVerificationError(`Receipt lookup failed (${response.status}).`, "storage");
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  return rows[0] ? rowToReceipt(rows[0]) : null;
}

export async function executionReceiptByHash(txHash: string): Promise<ExecutionReceiptRecord | null> {
  if (!TX_HASH.test(txHash)) throw new ReceiptVerificationError("txHash must be a 32-byte hex hash.", "malformed");
  const params = new URLSearchParams({
    select: "*",
    tx_hash: `eq.${txHash.toLowerCase()}`,
    provenance_verified: "eq.true",
    limit: "1",
  });
  const response = await fetch(relayUrl(`${EXECUTION_RECEIPTS_TABLE}?${params.toString()}`), {
    headers: relayHeaders(),
    cache: "no-store",
  });
  if (!response.ok) throw new ReceiptVerificationError(`Receipt lookup failed (${response.status}).`, "storage");
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  return rows[0] ? rowToReceipt(rows[0]) : null;
}
