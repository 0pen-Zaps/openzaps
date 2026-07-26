import { NextResponse } from "next/server";
import { CHAIN, CONTRACTS, STATUS, TOKEN, contractsLive, tokenLive } from "@/lib/config";
import {
  OPENZAP_CREATION_FEE,
  OPENZAP_CREATION_FEE_CONTRACTS,
  openZapCreationFeeConfigured,
} from "@/lib/robinhood";

export function GET(): NextResponse {
  return NextResponse.json({
    name: "OpenZaps",
    token: TOKEN.symbol,
    chain: CHAIN,
    status: {
      contractsLive: contractsLive(),
      tokenLive: tokenLive(),
      preAudit: STATUS.preAudit,
      creationGate: openZapCreationFeeConfigured()
        ? "open — exact native fee atomically converts to 0xZAPS; contracts remain pre-external-audit"
        : "closed — creation-fee gateway is not configured",
    },
    contracts: CONTRACTS,
    creationFee: {
      amountWei: OPENZAP_CREATION_FEE.toString(),
      ...OPENZAP_CREATION_FEE_CONTRACTS,
    },
  });
}
