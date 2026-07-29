import {
  formatUnits,
  getAddress,
  isAddressEqual,
  type Address,
  type PublicClient,
} from "viem";

import {
  MAX_ROUTER_AMOUNT,
  encodeStepData,
  parseRouterAmount,
  type RobinhoodPolicy,
  type RobinhoodStep,
} from "@/lib/openzap";
import { quoteRoute } from "@/lib/route-quote";
import {
  deployedRoutes,
  resolveRouteById,
  stepDataFitsRoute,
  type Route,
} from "@/lib/routes";

const HANDOFF_VERSION = "v1";
const MAX_HANDOFF_LENGTH = 4_096;
const MAX_POLICY_STEPS = 16;
const MAX_TRACKED_ASSETS = 16;
const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const DECIMAL_AMOUNT = /^\d+(?:\.\d*)?$/;

export type LivePolicyPlanStep = {
  routeId: string;
  /** Decimal token units, validated against this route's input decimals. */
  amountIn: string;
};

export type LivePolicyPlan = {
  version: 1;
  steps: readonly LivePolicyPlanStep[];
};

export type ResolvedLivePolicyStep = {
  route: Route;
  amountIn: bigint;
};

export type ResolvedLivePolicy = {
  plan: LivePolicyPlan;
  steps: readonly ResolvedLivePolicyStep[];
  trackedAssets: readonly Address[];
  inputRoute: Route;
  outputRoute: Route;
};

export type LivePolicyQuote = {
  amountOut: bigint;
  gasEstimate: bigint | null;
  /** One exact-input quote per policy step, in execution order. */
  steps: readonly {
    routeId: string;
    amountIn: bigint;
    amountOut: bigint;
    gasEstimate: bigint | null;
  }[];
};

/**
 * Deterministic, bounded builder -> signer handoff.
 *
 * This token carries route identities and decimal amounts only. It never
 * carries addresses or calldata supplied by the URL: the signer resolves those
 * from the shipped route manifest, then displays the resulting policy before a
 * wallet can create it.
 */
export function encodeLivePolicyPlan(steps: readonly LivePolicyPlanStep[]): string {
  if (steps.length === 0 || steps.length > MAX_POLICY_STEPS) {
    throw new Error(`A live policy must contain 1–${MAX_POLICY_STEPS} steps.`);
  }
  const encoded = steps.map((step) => {
    if (!ROUTE_ID.test(step.routeId)) throw new Error("A live policy contains an invalid route id.");
    const amountIn = canonicalDecimal(step.amountIn);
    return `${step.routeId}=${amountIn}`;
  });
  const token = [HANDOFF_VERSION, ...encoded].join("|");
  if (token.length > MAX_HANDOFF_LENGTH) throw new Error("The live policy handoff is too large.");
  return token;
}

export function decodeLivePolicyPlan(token: string): LivePolicyPlan | null {
  if (!token || token.length > MAX_HANDOFF_LENGTH) return null;
  const [version, ...encoded] = token.split("|");
  if (version !== HANDOFF_VERSION || encoded.length === 0 || encoded.length > MAX_POLICY_STEPS) return null;

  try {
    const steps = encoded.map((entry): LivePolicyPlanStep => {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator !== entry.lastIndexOf("=")) throw new Error("invalid entry");
      const routeId = entry.slice(0, separator);
      const amountIn = entry.slice(separator + 1);
      if (!ROUTE_ID.test(routeId)) throw new Error("invalid route");
      return { routeId, amountIn: canonicalDecimal(amountIn) };
    });
    if (encodeLivePolicyPlan(steps) !== token) return null;
    return { version: 1, steps };
  } catch {
    return null;
  }
}

/**
 * Resolve every untrusted handoff field through the deployment manifest and
 * prove the v1.1 lineage semantics:
 *
 * - step amounts are fixed at creation; no balance-relative sentinel exists;
 * - every intermediate output must be the next step's input;
 * - every non-final adapter must support a calldata minimum, which is set to
 *   the next step's exact amount so the run cannot borrow old capsule dust;
 * - the settlement asset cannot also be spent by an earlier step, because
 *   OpenZap measures its delta around the whole loop.
 */
export function resolveLivePolicyPlan(plan: LivePolicyPlan): ResolvedLivePolicy {
  if (plan.version !== 1 || plan.steps.length === 0 || plan.steps.length > MAX_POLICY_STEPS) {
    throw new Error(`A live policy must contain 1–${MAX_POLICY_STEPS} steps.`);
  }

  const steps = plan.steps.map((step, index): ResolvedLivePolicyStep => {
    const route = resolveRouteById(step.routeId);
    if (!route) throw new Error(`Step ${index + 1} does not resolve to a deployed route.`);
    const amountIn = parseRouterAmount(step.amountIn, route.tokenIn.decimals);
    if (amountIn <= 0n || amountIn > MAX_ROUTER_AMOUNT) {
      throw new Error(`Step ${index + 1} amount is outside the v1.1 uint128 range.`);
    }
    return { route, amountIn };
  });

  for (let index = 0; index < steps.length - 1; index += 1) {
    const current = steps[index];
    const next = steps[index + 1];
    if (!isAddressEqual(current.route.tokenOut.address, next.route.tokenIn.address)) {
      throw new Error(
        `Step ${index + 1} outputs ${current.route.tokenOut.symbol}, but step ${index + 2} spends ${next.route.tokenIn.symbol}.`,
      );
    }
    if (current.route.data !== "min-amount-out") {
      throw new Error(
        `Step ${index + 1} cannot safely feed another v1.1 step: its adapter cannot bind the next step's exact required amount.`,
      );
    }
  }

  const outputRoute = steps[steps.length - 1].route;
  const earlierSpender = steps
    .slice(0, -1)
    .find((step) => isAddressEqual(step.route.tokenIn.address, outputRoute.tokenOut.address));
  if (earlierSpender) {
    throw new Error(
      `${outputRoute.tokenOut.symbol} is both spent by an earlier step and used as final settlement; v1.1 cannot safely measure that round-trip delta.`,
    );
  }

  const trackedAssets = uniqueAddresses(steps.flatMap((step) => [...step.route.trackedAssets]));
  if (trackedAssets.length > MAX_TRACKED_ASSETS) {
    throw new Error(`The policy needs ${trackedAssets.length} recovery assets; v1.1 tracks at most ${MAX_TRACKED_ASSETS}.`);
  }

  return {
    plan: {
      version: 1,
      steps: steps.map((step) => ({
        routeId: step.route.id,
        amountIn: formatUnits(step.amountIn, step.route.tokenIn.decimals),
      })),
    },
    steps,
    trackedAssets,
    inputRoute: steps[0].route,
    outputRoute,
  };
}

export function buildLivePolicy(owner: Address, resolved: ResolvedLivePolicy): RobinhoodPolicy {
  const steps: RobinhoodStep[] = resolved.steps.map((step, index) => {
    const nextAmount = resolved.steps[index + 1]?.amountIn ?? 0n;
    return {
      adapter: step.route.adapter,
      spender: step.route.spender,
      tokenIn: step.route.tokenIn.address,
      amountIn: step.amountIn,
      // Intermediate minimums are structural: each one binds the exact amount
      // the next frozen step will pull. The final floor remains fresh in the
      // owner-signed intent and is deliberately not frozen here.
      data: encodeStepData(step.route, nextAmount),
    };
  });
  return {
    owner,
    recipient: owner,
    maxRelayerFeeCap: 0n,
    optimization: true,
    trackedAssets: resolved.trackedAssets,
    steps,
  };
}

export async function quoteLivePolicy(
  client: PublicClient,
  resolved: ResolvedLivePolicy,
  account: Address,
): Promise<LivePolicyQuote> {
  // Amounts are policy constants, not a runtime carry, so every quote is
  // independent and can be read in parallel. Continuity is checked below.
  const quoted = await Promise.all(
    resolved.steps.map(async (step) => {
      const result = await quoteRoute(client, step.route, step.amountIn, account);
      return {
        routeId: step.route.id,
        amountIn: step.amountIn,
        amountOut: result.amountOut,
        gasEstimate: result.gasEstimate,
      };
    }),
  );
  for (const [index, result] of quoted.entries()) {
    const step = resolved.steps[index];
    const next = resolved.steps[index + 1];
    if (next && result.amountOut < next.amountIn) {
      throw new Error(
        `Step ${index + 1} currently quotes ${formatUnits(result.amountOut, step.route.tokenOut.decimals)} ${step.route.tokenOut.symbol}, below step ${index + 2}'s fixed ${formatUnits(next.amountIn, next.route.tokenIn.decimals)} ${next.route.tokenIn.symbol}.`,
      );
    }
  }
  const withGas = quoted.flatMap((step) => (step.gasEstimate === null ? [] : [step.gasEstimate]));
  return {
    amountOut: quoted[quoted.length - 1].amountOut,
    gasEstimate: withGas.length > 0 ? withGas.reduce((total, gas) => total + gas, 0n) : null,
    steps: quoted,
  };
}

/**
 * Resolve an onchain v1.1 policy against the same canonical manifest the
 * builder uses. This is intentionally stricter than "the bytes decode": it
 * accepts only the exact intermediate calldata emitted by buildLivePolicy.
 */
export function resolveOnchainLivePolicy(policy: {
  trackedAssets: readonly Address[];
  steps: readonly RobinhoodStep[];
}): ResolvedLivePolicy | null {
  if (policy.steps.length === 0 || policy.steps.length > MAX_POLICY_STEPS) return null;
  const routes = deployedRoutes();
  const resolvedSteps: ResolvedLivePolicyStep[] = [];
  for (const [index, step] of policy.steps.entries()) {
    const route = routes.find(
      (candidate) =>
        isAddressEqual(candidate.adapter, step.adapter)
        && isAddressEqual(candidate.tokenIn.address, step.tokenIn)
        && isAddressEqual(candidate.spender, step.spender)
        && stepDataFitsRoute(candidate, step.data),
    );
    if (!route || step.amountIn <= 0n || step.amountIn > MAX_ROUTER_AMOUNT) return null;
    const next = policy.steps[index + 1];
    const expectedData = encodeStepData(route, next?.amountIn ?? 0n);
    if (step.data.toLowerCase() !== expectedData.toLowerCase()) return null;
    resolvedSteps.push({ route, amountIn: step.amountIn });
  }

  try {
    const resolved = resolveLivePolicyPlan({
      version: 1,
      steps: resolvedSteps.map((step) => ({
        routeId: step.route.id,
        amountIn: formatUnits(step.amountIn, step.route.tokenIn.decimals),
      })),
    });
    if (!sameAddressList(policy.trackedAssets, resolved.trackedAssets)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** The adapter's ABI is one uint256 word; exported for focused golden tests. */
export function decodeIntermediateMinimum(data: `0x${string}`): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  return BigInt(data);
}

function canonicalDecimal(value: string): string {
  const trimmed = value.trim();
  if (!DECIMAL_AMOUNT.test(trimmed)) throw new Error("A live policy amount is not a decimal token amount.");
  const [wholeRaw, fractionRaw = ""] = trimmed.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const fraction = fractionRaw.replace(/0+$/, "");
  const normalized = fraction ? `${whole}.${fraction}` : whole;
  if (normalized === "0") throw new Error("A live policy amount must be greater than zero.");
  return normalized;
}

function uniqueAddresses(addresses: readonly Address[]): Address[] {
  const seen = new Set<string>();
  const unique: Address[] = [];
  for (const raw of addresses) {
    const address = getAddress(raw);
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return unique;
}

function sameAddressList(left: readonly Address[], right: readonly Address[]): boolean {
  return left.length === right.length && left.every((address, index) => isAddressEqual(address, right[index]));
}
