import { NextResponse } from "next/server";
import { CHAIN, CONTRACTS, STATUS, TOKEN, contractsLive, tokenLive } from "@/lib/config";

export function GET(): NextResponse {
  return NextResponse.json({
    name: "OpenZaps",
    token: TOKEN.symbol,
    chain: CHAIN,
    status: {
      contractsLive: contractsLive(),
      tokenLive: tokenLive(),
      preAudit: STATUS.preAudit,
      creationGate: STATUS.preAudit ? "open — bounded v1.1 route; external audit is a planned hardening milestone" : "open",
    },
    contracts: CONTRACTS,
  });
}
