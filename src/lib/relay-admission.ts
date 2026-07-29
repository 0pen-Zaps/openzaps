import {
  isAddressEqual,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  RECURRING_INTENT_TYPES,
  RECURRING_RELATIVE_INTENT_TYPES,
  RECURRING_STACK_INTENT_TYPES,
  TRIGGER_INTENT_TYPES,
  openZapV3Domain,
  openZapV3_1Domain,
  openZapV3_2Domain,
} from "@/lib/executions";
import {
  ReceiptVerificationError,
  verifyCapsuleProvenance,
  type ExecutionReceiptProvenance,
} from "@/lib/receipt-server";
import type { RelayIntentKind, RelaySubmission } from "@/lib/relay";
import { ROBINHOOD_CHAIN_ID, openZapV3Abi } from "@/lib/robinhood";

const TYPES: Record<RelayIntentKind, { types: object; primaryType: string }> = {
  recurring: { types: RECURRING_INTENT_TYPES, primaryType: "RecurringIntent" },
  "recurring-relative": { types: RECURRING_RELATIVE_INTENT_TYPES, primaryType: "RecurringRelativeIntent" },
  "recurring-stack": { types: RECURRING_STACK_INTENT_TYPES, primaryType: "RecurringStackIntent" },
  trigger: { types: TRIGGER_INTENT_TYPES, primaryType: "TriggerIntent" },
};

export class RelayAdmissionError extends Error {
  constructor(
    message: string,
    readonly status: 422 | 503,
  ) {
    super(message);
    this.name = "RelayAdmissionError";
  }
}

function domainFor(kind: RelayIntentKind, chainId: number, zap: Address) {
  if (kind === "recurring-stack") return openZapV3_2Domain(chainId, zap);
  if (kind === "recurring-relative") return openZapV3_1Domain(chainId, zap);
  if (kind === "recurring" || kind === "trigger") return openZapV3Domain(chainId, zap);
  throw new RelayAdmissionError("Intent kind has no configured capsule lineage.", 422);
}

/** Convert the bounded wire representation into the exact EIP-712 message. */
function toTypedMessage(
  kind: RelayIntentKind,
  intent: Record<string, string | boolean>,
): Record<string, unknown> {
  const spec = TYPES[kind];
  if (!spec) throw new RelayAdmissionError("Intent kind has no configured capsule lineage.", 422);
  const fields = (spec.types as Record<string, { name: string; type: string }[]>)[spec.primaryType];
  const message: Record<string, unknown> = {};
  for (const { name, type } of fields) {
    const value = intent[name];
    if (type === "bool") message[name] = value === true;
    else if (type.startsWith("uint") || type.startsWith("int")) message[name] = BigInt(value as string);
    else message[name] = value;
  }
  return message;
}

export interface RelayAdmission {
  owner: Address;
  blockNumber: bigint;
  provenance: ExecutionReceiptProvenance;
}

/**
 * Admit one signed relay artifact against a single captured chain block.
 *
 * `owner()` plus a valid signature is not provenance: an attacker can deploy an
 * ABI-compatible contract and sign for it. The final factory-log/runtime proof
 * is therefore mandatory before the service-role insert can run.
 */
export async function verifyRelaySubmissionAdmission(
  client: PublicClient,
  submission: RelaySubmission,
  expectedChainId = ROBINHOOD_CHAIN_ID,
): Promise<RelayAdmission> {
  const chainId = Number(submission.intent.chainId);
  if (chainId !== expectedChainId) {
    throw new RelayAdmissionError(`Intent chainId ${chainId} != ${expectedChainId}.`, 422);
  }
  const zap = submission.intent.zap as Address;

  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch {
    throw new RelayAdmissionError("The chain head could not be read; relay admission failed closed.", 503);
  }

  let owner: Address;
  try {
    owner = await client.readContract({
      address: zap,
      abi: openZapV3Abi,
      functionName: "owner",
      blockNumber,
    });
  } catch {
    throw new RelayAdmissionError("Capsule owner could not be read at the admission block.", 422);
  }

  const spec = TYPES[submission.kind];
  if (!spec) throw new RelayAdmissionError("Intent kind has no configured capsule lineage.", 422);
  const typedData = {
    domain: domainFor(submission.kind, chainId, zap),
    types: spec.types,
    primaryType: spec.primaryType,
    message: toTypedMessage(submission.kind, submission.intent),
  };

  let signerOk = false;
  try {
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature: submission.signature,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    signerOk = isAddressEqual(recovered, owner);
  } catch {
    // Non-EOA signatures fall through to the block-pinned ERC-1271 path.
  }
  if (!signerOk) {
    try {
      signerOk = await client.verifyTypedData({
        address: owner,
        ...typedData,
        signature: submission.signature,
        blockNumber,
      } as Parameters<typeof client.verifyTypedData>[0]);
    } catch {
      signerOk = false;
    }
  }
  if (!signerOk) {
    throw new RelayAdmissionError("Signature does not recover to the capsule owner.", 422);
  }

  let policyHash: Hex;
  try {
    policyHash = await client.readContract({
      address: zap,
      abi: openZapV3Abi,
      functionName: "policyHash",
      blockNumber,
    });
  } catch {
    throw new RelayAdmissionError("Capsule policy could not be read at the admission block.", 422);
  }
  if ((submission.intent.policyHash as string).toLowerCase() !== policyHash.toLowerCase()) {
    throw new RelayAdmissionError("Intent policyHash does not match the on-chain capsule.", 422);
  }

  try {
    const provenance = await verifyCapsuleProvenance(
      client,
      {
        zap,
        owner,
        kind: submission.kind,
        policyHash,
      },
      blockNumber,
    );
    return { owner, blockNumber, provenance };
  } catch (error) {
    if (error instanceof ReceiptVerificationError) {
      const unavailable = error.code === "not-found" || error.code === "storage";
      throw new RelayAdmissionError(
        unavailable
          ? "Canonical capsule provenance could not be established; relay admission failed closed."
          : error.message,
        unavailable ? 503 : 422,
      );
    }
    throw new RelayAdmissionError("Canonical capsule provenance could not be established.", 503);
  }
}
