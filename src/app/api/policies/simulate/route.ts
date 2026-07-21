import { NextResponse, type NextRequest } from "next/server";
import { buildPolicyDraft, simulatePolicy, type PolicyDraft } from "@/lib/policy";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Partial<PolicyDraft>;

  try {
    body = (await request.json()) as Partial<PolicyDraft>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const policy = buildPolicyDraft(body);
  const simulation = simulatePolicy(policy);

  return NextResponse.json({
    policy,
    simulation,
    broadcast: false,
    note: "Simulation-only endpoint. It never submits a transaction or asks for wallet authority.",
  });
}

export function GET(): NextResponse {
  return NextResponse.json({
    endpoint: "/api/policies/simulate",
    method: "POST",
    body: {
      templateId: "recurring-dca",
      authorityModel: "deposit",
      tokenIn: "USDC",
      tokenOut: "WETH",
      amount: "250",
      maxSpend: "1000",
      slippageBps: 50,
      privateSubmission: true,
      humanApproval: false,
    },
  });
}
