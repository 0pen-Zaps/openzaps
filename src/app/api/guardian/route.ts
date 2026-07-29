import { NextResponse, type NextRequest } from "next/server";

import {
  createOperationsPublicClient,
  deriveGuardianSnapshot,
  guardianEnabled,
  mapGuardianPage,
  type GuardianBlockContext,
} from "@/lib/guardian-server";
import { latestReceiptForIntent } from "@/lib/receipt-server";
import { serverRateLimit } from "@/lib/relay-rate-limit";
import {
  RelayQueryError,
  listRelayIntentsPage,
  relayConfigured,
  type RelayListQuery,
} from "@/lib/relay-server";
import { ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = createOperationsPublicClient();
const MAX_GUARDIAN_URL_CHARS = 2_048;
const GUARDIAN_CONCURRENCY = 3;
const RATE_WINDOW_MS = 10_000;

function pageLimit(raw: string | null): number {
  if (raw === null) return 5;
  if (!/^[0-9]$/.test(raw)) throw new RelayQueryError("limit", "limit must be an integer from 1 to 8.");
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 8) throw new RelayQueryError("limit", "limit must be an integer from 1 to 8.");
  return parsed;
}

/** Read-only lifecycle derivation. It cannot mutate intents, sign, submit, or connect an executor. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!guardianEnabled()) {
    return NextResponse.json(
      { error: "Guardian is disabled until durable request quota is configured.", snapshots: [] },
      { status: 503, headers: { "retry-after": "3600" } },
    );
  }
  if (!relayConfigured()) {
    return NextResponse.json({ error: "Guardian storage is not configured.", snapshots: [] }, { status: 503 });
  }
  const declaredBodyBytes = Number(request.headers.get("content-length") ?? "0");
  if (
    request.url.length > MAX_GUARDIAN_URL_CHARS
    || (Number.isFinite(declaredBodyBytes) && declaredBodyBytes > 0)
  ) {
    return NextResponse.json({ error: "Request is too large.", snapshots: [] }, { status: 413 });
  }
  const quota = serverRateLimit(request, "guardian", 10, RATE_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many requests.", snapshots: [] },
      { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } },
    );
  }

  const params = request.nextUrl.searchParams;
  try {
    const query: RelayListQuery = {
      status: (params.get("status") ?? "open") as RelayListQuery["status"],
      owner: params.get("owner"),
      zap: params.get("zap"),
      executor: params.get("executor"),
      limit: pageLimit(params.get("limit")),
      cursor: params.get("cursor"),
    };
    const [page, latestBlock, pendingBlock] = await Promise.all([
      listRelayIntentsPage(query),
      client.getBlock({ blockTag: "latest" }),
      client.getBlock({ blockTag: "pending" }),
    ]);
    if (latestBlock.number === null) throw new Error("Latest block has no number.");
    const context: GuardianBlockContext = {
      blockNumber: latestBlock.number,
      timestamp: latestBlock.timestamp,
      latestBaseFeePerGas: latestBlock.baseFeePerGas ?? null,
      pendingBaseFeePerGas: pendingBlock.baseFeePerGas ?? null,
    };
    const snapshots = await mapGuardianPage(
      page.intents,
      GUARDIAN_CONCURRENCY,
      async (intent) => {
        const receipt = await latestReceiptForIntent(intent.id, context.blockNumber);
        return deriveGuardianSnapshot(client, intent, context, receipt);
      },
    );
    return NextResponse.json({
      chainId: ROBINHOOD_CHAIN_ID,
      snapshots,
      nextCursor: page.nextCursor,
      authorityScope: "none",
    });
  } catch (error) {
    if (error instanceof RelayQueryError) {
      return NextResponse.json({ error: error.message, snapshots: [] }, { status: 400 });
    }
    return NextResponse.json({ error: "Guardian derivation failed.", snapshots: [] }, { status: 502 });
  }
}
