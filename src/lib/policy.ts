export type AuthorityModel = "deposit" | "intent" | "safe" | "session";

export type PolicyTemplateId =
  | "recurring-dca"
  | "pool-deposit"
  | "claim-compound"
  | "guarded-exit";

export type PolicyStatus = "active" | "paused" | "revoked" | "draft" | "blocked";

export type PolicyTemplate = {
  id: PolicyTemplateId;
  name: string;
  short: string;
  description: string;
  recommendedModel: AuthorityModel;
  category: "automation" | "launch" | "yield" | "protection";
  production: "ready-preview" | "requires-review" | "deferred";
  defaults: {
    tokenIn: string;
    tokenOut: string;
    amount: string;
    frequency: string;
    maxSpend: string;
    slippageBps: number;
    adapter: string;
    postcondition: string;
  };
};

export type PolicyDraft = {
  templateId: PolicyTemplateId;
  templateName: string;
  authorityModel: AuthorityModel;
  chainId: number;
  owner: string;
  recipient: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  maxSpend: string;
  frequency: string;
  slippageBps: number;
  adapter: string;
  allowedSubmitters: string[];
  humanApproval: boolean;
  privateSubmission: boolean;
  alerts: string[];
  postconditions: string[];
  version: number;
};

export type SimulationCheck = {
  label: string;
  detail: string;
  status: "pass" | "warn" | "block";
};

export type SimulationResult = {
  status: "pass" | "warn" | "block";
  policyHash: string;
  estimatedOut: string;
  relayerFee: string;
  gasEstimate: string;
  checks: SimulationCheck[];
  diff: Array<{ field: string; before: string; after: string }>;
};

export const TOKENS = ["USDC", "WETH", "cbBTC", "DAI"] as const;

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "recurring-dca",
    name: "Recurring DCA",
    short: "Buy a fixed asset on a fixed cadence.",
    description:
      "Recurring ERC-20 buys, with spend, cadence, recipient, slippage, and relayer fee cap stated before signing. The live v1.1 capsule holds one signed step that executes once, so it cannot carry the cadence.",
    recommendedModel: "deposit",
    category: "automation",
    production: "ready-preview",
    defaults: {
      tokenIn: "USDC",
      tokenOut: "WETH",
      amount: "250",
      frequency: "weekly",
      maxSpend: "1000",
      slippageBps: 50,
      adapter: "Uniswap v4 exact-input adapter",
      postcondition: "recipient balance increases by minOut",
    },
  },
  {
    id: "pool-deposit",
    name: "Launch pool deposit",
    short: "Fund a specific launch or community pool.",
    description:
      "A deposit into one named launch pool, with the recipient vault fixed and no arbitrary calldata. The live contracts carry a single-step aeWETH ↔ 0xZAPS swap and nothing else, so this template simulates and does not deploy.",
    recommendedModel: "safe",
    category: "launch",
    production: "requires-review",
    defaults: {
      tokenIn: "USDC",
      tokenOut: "USDC",
      amount: "1000",
      frequency: "once",
      maxSpend: "1000",
      slippageBps: 0,
      adapter: "Pool deposit adapter",
      postcondition: "vault share balance increases",
    },
  },
  {
    id: "claim-compound",
    name: "Claim and compound",
    short: "Claim rewards and route them back into an approved asset.",
    description:
      "Claims a reward and routes it into an approved asset, with exact approvals and balance-delta postconditions. A claim is two steps, and the live capsule executes one, so this is a draft shape rather than a route.",
    recommendedModel: "intent",
    category: "yield",
    production: "requires-review",
    defaults: {
      tokenIn: "USDC",
      tokenOut: "WETH",
      amount: "100",
      frequency: "monthly",
      maxSpend: "100",
      slippageBps: 75,
      adapter: "Reward claim + swap adapter",
      postcondition: "claimed asset delta >= expected minimum",
    },
  },
  {
    id: "guarded-exit",
    name: "Guarded exit",
    short: "Exit only if risk limits break.",
    description:
      "An exit triggered by a liquidity or oracle condition. The v1.1 policy has no oracle precondition, so nothing onchain could evaluate the trigger. Blocked in v1 until protective-zap review is complete.",
    recommendedModel: "safe",
    category: "protection",
    production: "deferred",
    defaults: {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amount: "1",
      frequency: "condition-based",
      maxSpend: "1",
      slippageBps: 80,
      adapter: "Guarded exit adapter",
      postcondition: "exit only after oracle and liquidity checks pass",
    },
  },
];

export function getTemplate(id: PolicyTemplateId): PolicyTemplate {
  return POLICY_TEMPLATES.find((template) => template.id === id) ?? POLICY_TEMPLATES[0];
}

export function policyHash(input: unknown): string {
  const value = stableStringify(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `0x${hex}${hex.split("").reverse().join("")}${hex}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

export function buildPolicyDraft(input: Partial<PolicyDraft> = {}): PolicyDraft {
  const template = getTemplate(input.templateId ?? "recurring-dca");
  return {
    templateId: template.id,
    templateName: template.name,
    authorityModel: input.authorityModel ?? template.recommendedModel,
    chainId: input.chainId ?? 4663,
    owner: input.owner ?? "0x0000000000000000000000000000000000000000",
    recipient: input.recipient ?? input.owner ?? "0x0000000000000000000000000000000000000000",
    tokenIn: input.tokenIn ?? template.defaults.tokenIn,
    tokenOut: input.tokenOut ?? template.defaults.tokenOut,
    amount: input.amount ?? template.defaults.amount,
    maxSpend: input.maxSpend ?? template.defaults.maxSpend,
    frequency: input.frequency ?? template.defaults.frequency,
    slippageBps: input.slippageBps ?? template.defaults.slippageBps,
    adapter: input.adapter ?? template.defaults.adapter,
    allowedSubmitters: input.allowedSubmitters ?? ["Hermes relay", "Owner self-submit"],
    humanApproval: input.humanApproval ?? false,
    privateSubmission: input.privateSubmission ?? true,
    alerts: input.alerts ?? ["Farcaster", "Webhook"],
    postconditions: input.postconditions ?? [
      template.defaults.postcondition,
      "no residual ERC-20 allowance remains",
      "recipient and tracked asset match signed policy",
    ],
    version: input.version ?? 1,
  };
}

export function simulatePolicy(policy: PolicyDraft, previous?: PolicyDraft): SimulationResult {
  const template = getTemplate(policy.templateId);
  const checks: SimulationCheck[] = [];
  const amount = Number.parseFloat(policy.amount || "0");
  const maxSpend = Number.parseFloat(policy.maxSpend || "0");

  checks.push({
    label: "Policy scope",
    detail: "Adapter, selector, recipient, tracked token, nonce, and postconditions are bound before signing.",
    status: "pass",
  });

  checks.push({
    label: "Authority model",
    detail:
      policy.authorityModel === "session"
        ? "Session-key support is designed but not enabled in the v1 contract gate."
        : "Authority is explicit and does not grant arbitrary wallet control.",
    status: policy.authorityModel === "session" ? "block" : "pass",
  });

  checks.push({
    label: "Template production status",
    detail:
      template.production === "deferred"
        ? "Protective zaps are blocked in v1. The v1.1 policy has no oracle precondition, so nothing onchain could evaluate the trigger."
        : template.production === "requires-review"
          ? "Template needs governance adapter review before mainnet funds."
          : "Template is suitable for preview and testnet dry-runs.",
    status: template.production === "deferred" ? "block" : template.production === "requires-review" ? "warn" : "pass",
  });

  checks.push({
    label: "Token route",
    detail:
      policy.tokenIn === policy.tokenOut && policy.adapter.includes("swap")
        ? "Swap routes require different input and output assets."
        : "Route is compatible with the selected adapter class.",
    status: policy.tokenIn === policy.tokenOut && policy.adapter.includes("swap") ? "block" : "pass",
  });

  checks.push({
    label: "Spend limit",
    detail:
      amount <= 0
        ? "Amount must be greater than zero."
        : maxSpend > 0 && amount <= maxSpend
          ? "Single execution amount is inside the draft spend ceiling. The v1.1 policy tracks no cumulative budget, so the only onchain bound is the single step amount."
          : "Single execution amount exceeds the draft spend ceiling.",
    status: amount <= 0 ? "block" : maxSpend > 0 && amount <= maxSpend ? "pass" : "block",
  });

  checks.push({
    label: "Slippage",
    detail:
      policy.slippageBps <= 100
        ? "Slippage is bounded at or below 1.00%."
        : policy.slippageBps <= 250
          ? "Slippage is above the default safety band and should require human approval."
          : "Slippage is too wide for the default executor policy.",
    status: policy.slippageBps <= 100 ? "pass" : policy.slippageBps <= 250 ? "warn" : "block",
  });

  checks.push({
    label: "Submission path",
    detail: policy.privateSubmission
      ? "Private submission is set in this draft. The v1.1 policy has no submitter field, so a deployed capsule does not bind it."
      : "This draft leaves submission public. The v1.1 policy has no submitter field either way, so whoever executes the capsule chooses the mempool path.",
    status: policy.privateSubmission ? "pass" : "warn",
  });

  checks.push({
    label: "Human gate",
    detail: policy.humanApproval
      ? "A final wallet review is set in this draft. The v1.1 policy has no per-run approval step, so a deployed capsule does not bind it."
      : "No human gate beyond the signed policy. The signed amount and the owner's revoke path are the bounds.",
    status: policy.humanApproval ? "pass" : "warn",
  });

  const status = checks.some((check) => check.status === "block")
    ? "block"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return {
    status,
    policyHash: policyHash(policy),
    estimatedOut: estimateOut(policy),
    relayerFee: estimateRelayerFee(amount, policy.tokenIn),
    gasEstimate: policy.authorityModel === "safe" ? "185k - 235k gas" : "145k - 210k gas",
    checks,
    diff: previous ? diffPolicy(previous, policy) : [],
  };
}

export function diffPolicy(before: PolicyDraft, after: PolicyDraft): Array<{ field: string; before: string; after: string }> {
  const fields: Array<keyof PolicyDraft> = [
    "templateName",
    "authorityModel",
    "recipient",
    "tokenIn",
    "tokenOut",
    "amount",
    "maxSpend",
    "frequency",
    "slippageBps",
    "adapter",
    "humanApproval",
    "privateSubmission",
  ];

  return fields.flatMap((field) => {
    const left = stringifyField(before[field]);
    const right = stringifyField(after[field]);
    return left === right ? [] : [{ field, before: left, after: right }];
  });
}

function estimateOut(policy: PolicyDraft): string {
  const amount = Number.parseFloat(policy.amount || "0");
  if (!Number.isFinite(amount) || amount <= 0) return `0 ${policy.tokenOut}`;
  const usd = toUsd(amount, policy.tokenIn);
  const out = fromUsd(usd * (1 - policy.slippageBps / 10_000), policy.tokenOut);
  const decimals = policy.tokenOut === "USDC" || policy.tokenOut === "DAI" ? 2 : policy.tokenOut === "WETH" ? 5 : 6;
  return `${out.toLocaleString("en-US", { maximumFractionDigits: decimals })} ${policy.tokenOut}`;
}

function estimateRelayerFee(amount: number, token: string): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0 USDC";
  const usd = toUsd(amount, token);
  const fee = Math.max(0.08, Math.min(4.5, usd * 0.0008));
  return `${fee.toFixed(2)} USDC cap`;
}

function toUsd(amount: number, token: string): number {
  const rates: Record<string, number> = { USDC: 1, DAI: 1, WETH: 3500, cbBTC: 65000 };
  return amount * (rates[token] ?? 1);
}

function fromUsd(usd: number, token: string): number {
  const rates: Record<string, number> = { USDC: 1, DAI: 1, WETH: 3500, cbBTC: 65000 };
  return usd / (rates[token] ?? 1);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function stringifyField(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  return String(value);
}
