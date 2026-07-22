import { getAddress, type Address } from "viem";
import { NextResponse, type NextRequest } from "next/server";

import { fetchZapDetail } from "@/lib/zap-server";
import { isZapNotFound } from "@/lib/zap";

export const dynamic = "force-dynamic";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await params;
  const zap = normalizeAddress(address);
  if (!zap) {
    return NextResponse.json(
      { error: `${address} is not a 20-byte hex address.` },
      { status: 400, headers: { "cache-control": "public, s-maxage=300" } },
    );
  }

  try {
    const payload = await fetchZapDetail(zap);
    return NextResponse.json(payload, {
      headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" },
    });
  } catch (error) {
    if (isZapNotFound(error)) {
      // A 404 here is a claim about the tip of the chain, and it expires the
      // moment someone deploys to this address — /app polls this route for a
      // capsule seconds old. 5 minutes of CDN cache would outlive the claim, so
      // the negative answer gets a window short enough to be self-correcting.
      // It stays cacheable at all only to absorb repeat probes of one address;
      // the provenance gate itself already answers from an in-process memo, so
      // a cache miss costs a map lookup rather than a chain scan.
      return NextResponse.json(
        { error: `${zap} was not created by the OpenZap factory.` },
        { status: 404, headers: { "cache-control": "public, s-maxage=15" } },
      );
    }
    // Fail closed. A zeroed payload here would travel straight into the page as
    // "0 executions, 0 balance" — a factual claim about the chain that nobody
    // verified. The short error cache lets the CDN absorb client retry polls
    // while the RPC is down instead of amplifying them.
    return NextResponse.json(
      { error: "Robinhood RPC reads for this zap are unavailable right now." },
      { status: 503, headers: { "cache-control": "public, s-maxage=15" } },
    );
  }
}

/**
 * Case-insensitive, matching the page: every spelling of one address is the
 * same zap and gets the same response, so a CDN that folds case in its key
 * cannot serve one spelling's answer for another. The EIP-55 checksum is not
 * enforced because it adds no protection here — a mistyped digit resolves to
 * another address, and the provenance gate 404s anything the factory did not
 * create.
 */
function normalizeAddress(raw: string): Address | null {
  if (!HEX_ADDRESS.test(raw)) return null;
  return getAddress(raw.toLowerCase());
}
