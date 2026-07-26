import { BOUNDED_SWAP_IDS } from "@/lib/chains";
import { getBlock, makeNode, type ChainNode } from "@/lib/blocks";
import { reduceChainToLiveRoute } from "@/lib/deployable";
import { parseRouterAmount } from "@/lib/openzap";
import { resolveRouteById } from "@/lib/routes";
import { writeExecutionPolicyParams, type ExecutionPolicy } from "@/lib/execution-policy";

export type AutomationDesign =
  | {
      deployable: true;
      mode: "recurring";
      routeId: string;
      amountIn: string;
      slippageBps: number;
      intervalId: "daily" | "weekly" | "monthly";
      maxRuns: number;
      validDays: 7 | 30 | 90 | null;
      executionPolicy: ExecutionPolicy;
    }
  | {
      deployable: true;
      mode: "trigger";
      routeId: string;
      amountIn: string;
      slippageBps: number;
      thresholdId: string;
      validDays: 7 | 30 | 90;
      executionPolicy: ExecutionPolicy;
    }
  | { deployable: false; reasons: string[] };

const LIVE_AUTOMATION_ROUTES = new Set<string>(BOUNDED_SWAP_IDS);
const CADENCES = new Map<string, bigint>([
  ["daily", 86_400n],
  ["weekly", 604_800n],
  ["monthly", 2_592_000n],
]);
const WINDOWS = new Map<string, 7 | 30 | 90>([
  ["7 days", 7],
  ["30 days", 30],
  ["90 days", 90],
]);
const THRESHOLD_IDS = new Set(["up5", "up10", "up25", "down5", "down10", "down25"]);

/**
 * Reduce the visual builder's automation vocabulary into the live v3/v3.1
 * execution modes. This is deliberately narrower than compilation: only the
 * pinned aeWETH <-> 0xZAPS routes have the onchain price sources and executor
 * path the Automate console can honestly sign today.
 */
export function reduceChainToAutomation(chain: readonly ChainNode[]): AutomationDesign {
  const recurring = chain.filter((node) => node.blockId === "recurring-stream");
  const triggers = chain.filter((node) => node.blockId === "price-trigger");

  if (recurring.length > 1 || triggers.length > 1) {
    return { deployable: false, reasons: ["An automation can bind exactly one cadence or one price condition."] };
  }
  if (recurring.length === 1 && triggers.length === 1) {
    return {
      deployable: false,
      reasons: [
        "The live automation surface cannot combine a recurring cadence with a price trigger in one standing intent.",
      ],
    };
  }
  if (recurring.length === 0 && triggers.length === 0) {
    return { deployable: false, reasons: ["Add Recurring deposit or Price trigger to turn this route into an automation."] };
  }

  // A recurring source is the same fixed ERC-20 amount per run as Wallet
  // balance. Replacing only the source lets the existing live-route reducer
  // remain the authority for adapter, token, amount, sink, and guard handling.
  const routeChain = chain.map((node) =>
    node.blockId === "recurring-stream"
      ? makeNode("wallet-balance", node.uid, {
          asset: node.params.asset,
          amount: node.params.amount,
        })
      : node,
  );
  const route = reduceChainToLiveRoute(routeChain);
  if (!route.deployable) return { deployable: false, reasons: route.reasons };
  const resolvedRoute = resolveRouteById(route.routeId);
  if (!resolvedRoute) return { deployable: false, reasons: ["The reduced route is not available in this build."] };
  if (!LIVE_AUTOMATION_ROUTES.has(route.routeId)) {
    return {
      deployable: false,
      reasons: [
        "Automation is live only for the pinned aeWETH <-> 0xZAPS pool; this route can still Zap now.",
      ],
    };
  }

  const mode = recurring.length === 1 ? "recurring" : "trigger";
  const supportedGuards =
    mode === "recurring"
      ? new Set([
          "guard-slippage",
          "guard-spend",
          "guard-window",
          "guard-gas-limit",
          "guard-gas-price",
          "guard-executor",
        ])
      : new Set([
          "guard-slippage",
          "guard-spend",
          "guard-window",
          "price-trigger",
          "guard-gas-limit",
          "guard-gas-price",
          "guard-executor",
        ]);
  const unsupported = chain.filter(
    (node) => getBlock(node.blockId)?.kind === "guard" && !supportedGuards.has(node.blockId),
  );
  if (unsupported.length > 0) {
    const names = unsupported.map((node) => getBlock(node.blockId)?.name ?? node.blockId);
    return {
      deployable: false,
      reasons: [
        `The live ${mode} intent cannot enforce ${Array.from(new Set(names)).join(", ")}; remove that guard before handoff.`,
      ],
    };
  }
  const windows = chain.filter((node) => node.blockId === "guard-window");
  if (windows.length > 1) {
    return { deployable: false, reasons: ["A price trigger can bind exactly one expiry window."] };
  }

  if (recurring.length === 1) {
    const cadence = String(recurring[0].params.cadence ?? "");
    const runs = Math.trunc(Number(recurring[0].params.runs));
    const cadenceSeconds = CADENCES.get(cadence);
    if (!cadenceSeconds) {
      return { deployable: false, reasons: ["Choose a daily, weekly, or monthly cadence."] };
    }
    if (!Number.isFinite(runs) || runs < 1 || runs > 100) {
      return { deployable: false, reasons: ["Recurring automations support between 1 and 100 runs."] };
    }
    const validDays = windows.length === 1 ? WINDOWS.get(String(windows[0].params.expiry ?? "")) : null;
    if (windows.length === 1 && !validDays) {
      return { deployable: false, reasons: ["A recurring zap window must be 7, 30, or 90 days."] };
    }
    if (validDays && cadenceSeconds * BigInt(Math.max(runs - 1, 0)) > BigInt(validDays) * 86_400n) {
      return {
        deployable: false,
        reasons: [`The ${validDays}-day window ends before all ${runs} scheduled runs can become due.`],
      };
    }
    const spendError = validateSpendCaps(chain, route.amountIn, resolvedRoute.tokenIn.decimals, runs);
    if (spendError) return { deployable: false, reasons: [spendError] };
    return {
      deployable: true,
      mode: "recurring",
      routeId: route.routeId,
      amountIn: route.amountIn,
      slippageBps: route.slippageBps,
      intervalId: cadence as "daily" | "weekly" | "monthly",
      maxRuns: runs,
      validDays: validDays ?? null,
      executionPolicy: route.executionPolicy,
    };
  }

  const thresholdId = String(triggers[0]?.params.condition ?? "");
  if (!THRESHOLD_IDS.has(thresholdId)) {
    return { deployable: false, reasons: ["Choose one signed 5%, 10%, or 25% price-trigger condition."] };
  }

  const window = chain.find((node) => node.blockId === "guard-window");
  const validDays = WINDOWS.get(String(window?.params.expiry ?? "30 days"));
  if (!validDays) {
    return { deployable: false, reasons: ["A price-triggered zap must expire after 7, 30, or 90 days."] };
  }
  const spendError = validateSpendCaps(chain, route.amountIn, resolvedRoute.tokenIn.decimals, 1);
  if (spendError) return { deployable: false, reasons: [spendError] };

  return {
    deployable: true,
    mode: "trigger",
    routeId: route.routeId,
    amountIn: route.amountIn,
    slippageBps: route.slippageBps,
    thresholdId,
    validDays,
    executionPolicy: route.executionPolicy,
  };
}

function validateSpendCaps(
  chain: readonly ChainNode[],
  amountIn: string,
  decimals: number,
  runs: number,
): string | null {
  const caps = chain.filter((node) => node.blockId === "guard-spend");
  if (caps.length === 0) return null;
  let required: bigint;
  try {
    required = parseRouterAmount(amountIn, decimals) * BigInt(runs);
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The spend cap cannot be compared to this amount.";
  }
  for (const cap of caps) {
    try {
      const limit = parseRouterAmount(String(cap.params.cap ?? ""), decimals);
      if (required > limit) {
        return `The designed spend cap is below the ${runs}-run funding total. Raise the cap or reduce amount/runs.`;
      }
    } catch {
      return "Enter a valid spend cap before handing this design to Automate.";
    }
  }
  return null;
}

/** URL that transfers the exact builder settings into the live Automate tab. */
export function automationHandoff(design: Extract<AutomationDesign, { deployable: true }>): string {
  const params = new URLSearchParams({
    view: "automate",
    src: "build",
    mode: design.mode,
    route: design.routeId,
    amount: design.amountIn,
    bps: String(design.slippageBps),
  });
  if (design.mode === "recurring") {
    params.set("interval", design.intervalId);
    params.set("runs", String(design.maxRuns));
    if (design.validDays) params.set("days", String(design.validDays));
  } else {
    params.set("threshold", design.thresholdId);
    params.set("days", String(design.validDays));
  }
  writeExecutionPolicyParams(params, design.executionPolicy);
  return `/zap?${params.toString()}`;
}
