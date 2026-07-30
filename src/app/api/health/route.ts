import { NextResponse } from "next/server";
import { CHAIN, CONTRACTS, STATUS, TOKEN, contractsLive, tokenLive } from "@/lib/config";
import {
  OPENZAP_CREATION_FEE,
  OPENZAP_CREATION_FEE_CONTRACTS,
  OPENZAP_V1_2_CONTRACTS,
  OPENZAP_V3_2_CONTRACTS,
  openZapCreationFeeConfigured,
  openZapV1_2Configured,
  openZapV3_2Configured,
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
      oneShotOwnerPull: openZapV1_2Configured()
        ? "configured in this build — creation remains closed until the app's independent onchain provenance and launch canaries pass"
        : "closed — v1.2 remains undeployed or incompletely configured",
      recurringStack: openZapV3_2Configured()
        ? "open — canonical v3.2 stack, dedicated creation gateway, and both pots are configured; contracts remain pre-external-audit"
        : "closed — the v3.2 deployment set is incomplete or explicitly disabled",
    },
    contracts: CONTRACTS,
    creationFee: {
      amountWei: OPENZAP_CREATION_FEE.toString(),
      ...OPENZAP_CREATION_FEE_CONTRACTS,
      oneShotOwnerPull: {
        gateway: OPENZAP_V1_2_CONTRACTS.creationGateway,
        pot: OPENZAP_V1_2_CONTRACTS.creationFeePot,
      },
      recurringStack: {
        gateway: OPENZAP_V3_2_CONTRACTS.creationGateway,
        pot: OPENZAP_V3_2_CONTRACTS.creationFeePot,
      },
    },
  });
}
