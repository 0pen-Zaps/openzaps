import { NextResponse } from "next/server";

import { AGENT_MODEL } from "@/lib/agent-catalog";

/**
 * Whether this deployment has a model behind it.
 *
 * The client asks before rendering a free-text composer, so a deployment without a key shows
 * chips-only rather than a text box that 503s on submit. That degradation path is the one most
 * likely to ship broken, because it is the one nobody exercises locally — so it gets its own
 * endpoint rather than being inferred from a failed POST.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AgentConfigPayload {
  configured: boolean;
  model: string;
}

export async function GET(): Promise<NextResponse> {
  const payload: AgentConfigPayload = {
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
    // The model id is not a secret and the UI names it; the key never leaves the server.
    model: AGENT_MODEL,
  };
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
