import { NextResponse, type NextRequest } from "next/server";

import { createOperationsPublicClient } from "@/lib/guardian-server";
import {
  ReceiptVerificationError,
  executionReceiptByHash,
  latestReceiptForIntent,
  parseReceiptRequest,
  readRelayReceiptBinding,
  storeExecutionReceipt,
  verifyExecutionReceipt,
} from "@/lib/receipt-server";
import { serverRateLimited } from "@/lib/relay-rate-limit";
import { relayConfigured } from "@/lib/relay-server";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import { ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = createOperationsPublicClient();
const MAX_BODY_BYTES = 2_048;

function requiredConfirmations(): number {
  const parsed = Number(process.env.OPENZAPS_CONFIRMATIONS ?? "12");
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 128 ? parsed : 12;
}

function errorResponse(error: unknown): NextResponse {
  if (!(error instanceof ReceiptVerificationError)) {
    return NextResponse.json({ error: "Receipt operation failed." }, { status: 502 });
  }
  const status =
    error.code === "malformed"
      ? 400
      : error.code === "not-found"
        ? 404
        : error.code === "not-final"
          ? 409
          : error.code === "storage"
            ? 502
            : 422;
  return NextResponse.json(
    { error: error.message, code: error.code },
    {
      status,
      headers: error.code === "not-final" ? { "retry-after": "15" } : undefined,
    },
  );
}

/**
 * Permissionless nomination, independently verified: knowing an intent UUID or transaction hash
 * grants no execution right and cannot write claimed reputation fields.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "Receipt storage is not configured." }, { status: 503 });
  }
  if (serverRateLimited(request, "receipt-write", 20, 10_000)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  try {
    const input = parseReceiptRequest(await readBoundedJsonBody(request, MAX_BODY_BYTES));
    const binding = await readRelayReceiptBinding(input.relayIntentId);
    if (!binding) {
      return NextResponse.json({ error: "Relay intent not found." }, { status: 404 });
    }
    const verified = await verifyExecutionReceipt(
      client,
      ROBINHOOD_CHAIN_ID,
      input.txHash,
      binding,
      requiredConfirmations(),
    );
    const receipt = await storeExecutionReceipt(verified);
    return NextResponse.json({ receipt, stored: true, authorityScope: "none" }, { status: 201 });
  } catch (error) {
    if (error instanceof BoundedJsonBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}

/** Read one durable receipt by hash, or the latest receipt for a relay intent. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "Receipt storage is not configured." }, { status: 503 });
  }
  if (serverRateLimited(request, "receipt-read", 60, 10_000)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const txHash = request.nextUrl.searchParams.get("txHash");
  const intentId = request.nextUrl.searchParams.get("intentId");
  if ((txHash ? 1 : 0) + (intentId ? 1 : 0) !== 1) {
    return NextResponse.json({ error: "Provide exactly one of txHash or intentId." }, { status: 400 });
  }
  try {
    const receipt = txHash ? await executionReceiptByHash(txHash) : await latestReceiptForIntent(intentId as string);
    if (!receipt) return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    return NextResponse.json({ receipt, authorityScope: "none" });
  } catch (error) {
    return errorResponse(error);
  }
}
