import type { ExactPolicyRequest } from "@/lib/policy-exact";

/** One public request shared by endpoint discovery, docs, and compiler coverage. */
export const EXACT_POLICY_QUICKSTART_BODY = {
  routeId: "robinhood-v4-weth-zaps",
  owner: "0x0000000000000000000000000000000000000001",
  amount: "0.01",
  slippageBps: 150,
} as const satisfies ExactPolicyRequest;

export const EXACT_POLICY_QUICKSTART_JSON = JSON.stringify(
  EXACT_POLICY_QUICKSTART_BODY,
  null,
  2,
);
