import {
  getAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { assetSymbolFor, type AutomatedRunKind, type AutomatedRunLogInput } from "@/lib/activity";
import {
  MAX_ROUTER_AMOUNT,
  assetsForDirection,
  expectedCloneRuntime,
  hashRobinhoodPolicy,
  type ZapDirection,
} from "@/lib/openzap";
import {
  resolveRouteFromStep,
  type Route,
} from "@/lib/routes";
import {
  encodeLivePolicyPlan,
  resolveOnchainLivePolicy,
  type ResolvedLivePolicy,
} from "@/lib/live-policy";
import {
  OPENZAP_CONTRACTS,
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  ROBINHOOD_ASSETS,
  openZapAbi,
  openZapFactoryAbi,
} from "@/lib/robinhood";

/**
 * The clone exposes `step(i)` one index at a time, so a policy hash can only be
 * recomputed when every step was read — a short read forces `hashMatches` false
 * and brands a valid capsule as mismatched.
 *
 * This is therefore the contract's own ceiling, not a guess:
 * `contracts/src/OpenZap.sol` declares `uint256 private constant MAX_STEPS = 16`
 * and `initialize` reverts with `PolicyTooLarge` above it, so 16 reads cover
 * every capsule the permissionless factory can ever deploy. Live v1.1 zaps have
 * exactly one step; the cap still bounds the fan-out of a hostile `stepCount`,
 * which is an unvalidated `uint256` coming back over RPC.
 */
export const ZAP_STEP_READ_LIMIT = 16;

/**
 * How many `step(i)` calls a declared `stepCount` earns.
 *
 * `stepCount` is an unvalidated uint256 arriving over RPC, so it is clamped
 * before it can size an array or reach `Number()`: at the cap, `Number` is
 * exact and the fan-out is 16 reads no matter what the clone claims.
 */
export function stepsToRead(stepCount: bigint): number {
  if (stepCount <= 0n) return 0;
  return stepCount > BigInt(ZAP_STEP_READ_LIMIT) ? ZAP_STEP_READ_LIMIT : Number(stepCount);
}

/**
 * "This address was not created by the OpenZap factory" is the one failure that
 * may become a 404. Every other failure — an RPC timeout above all — must not,
 * because telling a visitor a real capsule does not exist is the worse mistake.
 * A typed error keeps the two apart without string-sniffing at each call site.
 */
export class ZapNotFoundError extends Error {
  readonly name = "ZapNotFoundError";

  constructor(address: string) {
    super(`${address} was not created by the OpenZap factory.`);
  }
}

/**
 * Route handlers and page segments are bundled separately, so `instanceof` can
 * fail across two copies of this module even for a genuine ZapNotFoundError.
 * The name check is the cross-bundle fallback; both are narrow enough that an
 * RPC failure can never satisfy either and be mistaken for a missing zap.
 */
export function isZapNotFound(error: unknown): boolean {
  if (error instanceof ZapNotFoundError) return true;
  return error instanceof Error && error.name === "ZapNotFoundError";
}

export type ZapProvenance = {
  address: Address;
  owner: Address;
  policyHash: Hex;
  implCodeHash: Hex;
  salt: Hex;
  createdBlock: string;
  createdTx: Hex;
  createdAt: number | null;
};

export type ZapStepView = {
  adapter: Address;
  tokenIn: Address;
  spender: Address;
  amountIn: string;
  data: Hex;
};

export type ZapPolicyView = {
  owner: Address;
  recipient: Address;
  maxRelayerFeeCap: string;
  optimization: boolean;
  trackedAssets: Address[];
  stepCount: string;
  /** Every step the clone exposes, in execution order. */
  steps?: ZapStepView[];
  /** Canonical route ids for a recognized ordered policy; empty off-manifest. */
  routeIds?: string[];
  step: ZapStepView | null;
  policyHash: Hex;
  /** null when the input asset is outside the live aeWETH/0xZAPS route. */
  direction: ZapDirection | null;
  /**
   * Which deployed route KIND this capsule implements — swap, stitched
   * multi-pool route, vault leg, or LP provide/withdraw — or null when the
   * step matches no deployed route. This is what lets the capsule page draw
   * "Provide liquidity" instead of mislabeling every action a swap.
   */
  routeKind: Route["kind"] | null;
  inputSymbol: string | null;
  outputSymbol: string | null;
  /** The final settlement token for a recognized policy. */
  outAsset?: Address | null;
  /** Hash of the policy the clone exposes === the policyHash it committed to. */
  hashMatches: boolean;
  /** EIP-1167 runtime matches the factory's current implementation. */
  canonicalClone: boolean;
  /** Every bounded-route invariant holds. */
  matchesLiveRoute: boolean;
  /** Human-readable list of every invariant that does NOT hold. */
  deviations: string[];
};

export type VerifiedLiveZap = {
  address: Address;
  policyHash: Hex;
  resolved: ResolvedLivePolicy;
  /** Deterministic route+amount token suitable for local persistence/export. */
  policyToken: string;
  policy: {
    owner: Address;
    recipient: Address;
    maxRelayerFeeCap: bigint;
    optimization: true;
    trackedAssets: readonly Address[];
    steps: readonly ZapStepRead[];
  };
  blockNumber: bigint;
};

/**
 * Which authorization produced one run. `one-shot` is the owner-signed
 * `Executed` path; the other three are the v3/v3.1 automated events, submitted
 * by an executor against a standing authorization the owner signed once.
 */
export type ZapExecutionKind = "one-shot" | AutomatedRunKind;

export type ZapExecution = {
  kind: ZapExecutionKind;
  /** seriesId for a recurring run, nonce for a one-shot or a trigger. */
  nonce: string;
  recipient: Address;
  /**
   * The executor that submitted an automated run; null on a one-shot. The whole
   * point of an automated run is that the owner did not submit it.
   */
  executor: Address | null;
  /** 1-based index within a recurring series; null elsewhere. */
  run: number | null;
  outAsset: Address;
  assetSymbol: string;
  /** Net of the fee. Gross output is amountOut + fee. */
  amountOut: string;
  /**
   * Withheld from gross output: the relayer fee on a one-shot, the protocol fee
   * (executor share + pot share) on an automated run. Two different fees with
   * the same arithmetic role, which is why `kind` travels beside this number —
   * printing an automated run's protocol fee as a relayer fee would contradict
   * the `maxRelayerFeeCap` the policy commits to.
   */
  fee: string;
  txHash: Hex;
  blockNumber: string;
  logIndex: number;
  timestamp: number | null;
};

export type ZapRecovery = {
  owner: Address;
  asset: Address;
  assetSymbol: string;
  amount: string;
  txHash: Hex;
  blockNumber: string;
  logIndex: number;
  timestamp: number | null;
};

/**
 * No `invalidatedNonces`: `nonceUsed[n]` is set by both `execute` and
 * `invalidateNonce`, so it cannot tell the two apart, and this reader does not
 * index the clone's NonceInvalidated event. Deriving a count from `nonceUsed`
 * would report cancellations as executions — a fabrication. Surfacing
 * invalidations honestly means reading that event, not inferring it.
 */
export type ZapStats = {
  /**
   * Every confirmed run, one-shot and automated together. Counting only the
   * one-shot `Executed` log is what made a capsule with twenty recurring runs
   * report zero; `automatedRunCount` is how a caller recovers the split.
   */
  executionCount: number;
  /** How many of `executionCount` were submitted by an executor. */
  automatedRunCount: number;
  recoveryCount: number;
  /** Symbol -> summed raw wei as a decimal string. */
  amountOutByAsset: Record<string, string>;
  feeByAsset: Record<string, string>;
  firstExecutionAt: number | null;
  lastExecutionAt: number | null;
};

export type ZapBalances = { weth: string; zaps: string; native: string };

export type ZapLifecycle = "created" | "funded" | "executed" | "recovered";

export type ZapDetailPayload = {
  provenance: ZapProvenance;
  policy: ZapPolicyView;
  stats: ZapStats;
  balances: ZapBalances;
  executions: ZapExecution[];
  recoveries: ZapRecovery[];
  lifecycle: ZapLifecycle;
  headBlock: string;
  readAt: string;
  factory: { version: string; implementation: Address };
};

export type ZapSummary = {
  address: Address;
  owner: Address;
  lineage: "v1.1" | "v3" | "v3.1";
  createdBlock: string;
  createdTx: Hex;
  createdAt: number | null;
  policyHash: Hex;
  executionCount: number;
  lastExecutionAt: number | null;
};

/**
 * A truncated list and its true size travel together, because the index prints
 * a count. `rows.length` is how many capsules are shown; `total` is how many
 * exist. Rendering the first as the second is a false statement about the
 * chain the moment the factory passes the limit.
 */
export type ZapSummaryPage = {
  /** Newest first, at most `limit` entries. */
  rows: ZapSummary[];
  /** Distinct capsules the factory's ZapCreated logs name, before truncation. */
  total: number;
  /** `total > rows.length` — the list on screen is not the whole set. */
  truncated: boolean;
};

export interface ZapCreatedLogInput {
  zap: Address;
  owner: Address;
  /** The factory that emitted this ZapCreated — v1.1, v3, or v3.1. A capsule must be
   *  verified against ITS OWN factory's implementation, not a hardcoded one. */
  factory: Address;
  policyHash: Hex;
  implCodeHash: Hex;
  salt: Hex;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface ZapExecutedLogInput {
  emitter: Address;
  nonce: bigint;
  recipient: Address;
  outAsset: Address;
  amountOut: bigint;
  fee: bigint;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface ZapExitLogInput {
  emitter: Address;
  owner: Address;
  asset: Address;
  amount: bigint;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface ZapStepRead {
  adapter: Address;
  tokenIn: Address;
  spender: Address;
  amountIn: bigint;
  data: Hex;
}

export interface ZapPolicyRead {
  owner: Address;
  recipient: Address;
  maxRelayerFeeCap: bigint;
  optimization: boolean;
  trackedAssets: readonly Address[];
  stepCount: bigint;
  /** Steps actually read, in index order; may be shorter than stepCount. */
  steps: readonly ZapStepRead[];
  policyHash: Hex;
}

export interface ZapDetailInput {
  address: Address;
  created: ZapCreatedLogInput;
  policy: ZapPolicyRead;
  factory: { version: string; implementation: Address };
  /** Clone runtime bytecode; null when the address holds no code. */
  runtime: Hex | null;
  balances: { weth: bigint; zaps: bigint; native: bigint };
  executed: readonly ZapExecutedLogInput[];
  /** ExecutedRecurring / ExecutedRecurringRelative / ExecutedTrigger logs. */
  automated: readonly AutomatedRunLogInput[];
  exits: readonly ZapExitLogInput[];
  timestamps: ReadonlyMap<bigint, number>;
  headBlock: bigint;
  readAt: string;
}

const factoryPolicySurfaceAbi = [
  {
    type: "function",
    name: "adapters",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokens",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const allowlistAbi = [
  {
    type: "function",
    name: "isAllowed",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

/**
 * Verify an owned one-shot capsule at one pinned block and recover its entire
 * ordered policy. This is the signing surface's authority gate: URL/local
 * storage metadata is never trusted, and every adapter/token is checked for
 * current code plus current allowlist membership before funding or execution.
 */
export async function inspectOwnedLiveZap(
  publicClient: PublicClient,
  zapAddress: Address,
  expectedOwner: Address,
  options: { requireExecutable?: boolean } = {},
): Promise<VerifiedLiveZap> {
  const address = getAddress(zapAddress);
  const ownerExpected = getAddress(expectedOwner);
  const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
  const [
    runtime,
    factoryCode,
    implementation,
    implementationCode,
    committedImplementationHash,
    adapterRegistry,
    tokenAllowlist,
    owner,
    recipient,
    maxRelayerFeeCap,
    optimization,
    trackedAssets,
    stepCount,
    policyHash,
  ] = await Promise.all([
    publicClient.getBytecode({ address, blockNumber }),
    publicClient.getBytecode({ address: OPENZAP_CONTRACTS.factory, blockNumber }),
    publicClient.readContract({
      address: OPENZAP_CONTRACTS.factory,
      abi: openZapFactoryAbi,
      functionName: "implementation",
      blockNumber,
    }),
    publicClient.getBytecode({ address: OPENZAP_CONTRACTS.implementation, blockNumber }),
    publicClient.readContract({
      address: OPENZAP_CONTRACTS.factory,
      abi: openZapFactoryAbi,
      functionName: "implCodeHash",
      blockNumber,
    }),
    publicClient.readContract({
      address: OPENZAP_CONTRACTS.factory,
      abi: factoryPolicySurfaceAbi,
      functionName: "adapters",
      blockNumber,
    }),
    publicClient.readContract({
      address: OPENZAP_CONTRACTS.factory,
      abi: factoryPolicySurfaceAbi,
      functionName: "tokens",
      blockNumber,
    }),
    publicClient.readContract({ address, abi: openZapAbi, functionName: "owner", blockNumber }),
    publicClient.readContract({ address, abi: openZapAbi, functionName: "recipient", blockNumber }),
    publicClient.readContract({ address, abi: openZapAbi, functionName: "maxRelayerFeeCap", blockNumber }),
    publicClient.readContract({ address, abi: openZapAbi, functionName: "optimization", blockNumber }),
    publicClient.readContract({ address, abi: openZapAbi, functionName: "trackedAssets", blockNumber }),
    publicClient.readContract({ address, abi: openZapAbi, functionName: "stepCount", blockNumber }),
    publicClient.readContract({ address, abi: openZapAbi, functionName: "policyHash", blockNumber }),
  ]);

  if (!factoryCode || !implementationCode) {
    throw new Error("The v1.1 factory or implementation has no code at the pinned block.");
  }
  if (
    !isAddressEqual(implementation, OPENZAP_CONTRACTS.implementation)
    || keccak256(implementationCode).toLowerCase() !== committedImplementationHash.toLowerCase()
  ) {
    throw new Error("The v1.1 implementation does not match the factory's code commitment.");
  }
  if (!runtime || runtime.toLowerCase() !== expectedCloneRuntime(implementation).toLowerCase()) {
    throw new Error("Address is not a canonical clone of the current v1.1 implementation.");
  }
  if (!isAddressEqual(owner, ownerExpected) || !isAddressEqual(recipient, ownerExpected)) {
    throw new Error("Zap owner and recipient must match the connected wallet.");
  }
  if (maxRelayerFeeCap !== 0n || !optimization) {
    throw new Error("Zap policy is outside the zero-fee v1.1 one-shot surface.");
  }
  const readCount = stepsToRead(stepCount);
  if (stepCount <= 0n || stepCount > BigInt(ZAP_STEP_READ_LIMIT) || readCount !== Number(stepCount)) {
    throw new Error(`Zap step count must be between 1 and ${ZAP_STEP_READ_LIMIT}.`);
  }

  const steps = await Promise.all(
    Array.from({ length: readCount }, (_, index) =>
      publicClient.readContract({
        address,
        abi: openZapAbi,
        functionName: "step",
        args: [BigInt(index)],
        blockNumber,
      }),
    ),
  );
  const policy = {
    owner: getAddress(owner),
    recipient: getAddress(recipient),
    maxRelayerFeeCap,
    optimization: true as const,
    trackedAssets: trackedAssets.map((asset) => getAddress(asset)),
    steps: steps.map((step): ZapStepRead => ({
      adapter: getAddress(step.adapter),
      tokenIn: getAddress(step.tokenIn),
      spender: getAddress(step.spender),
      amountIn: step.amountIn,
      data: step.data,
    })),
  };
  if (hashRobinhoodPolicy(policy).toLowerCase() !== policyHash.toLowerCase()) {
    throw new Error("Zap policy hash does not match the policy exposed by the clone.");
  }

  const resolved = resolveOnchainLivePolicy(policy);
  if (!resolved) {
    throw new Error("Zap policy is outside the supported ordered v1.1 route manifest.");
  }

  if (options.requireExecutable !== false) {
    const adapterAddresses = uniquePolicyAddresses(resolved.steps.map((entry) => entry.route.adapter));
    const tokenAddresses = uniquePolicyAddresses([
      ...resolved.trackedAssets,
      resolved.outputRoute.tokenOut.address,
    ]);
    const [adapterCodes, tokenCodes, adapterAllowed, tokensAllowed] = await Promise.all([
      Promise.all(adapterAddresses.map((adapter) => publicClient.getBytecode({ address: adapter, blockNumber }))),
      Promise.all(tokenAddresses.map((token) => publicClient.getBytecode({ address: token, blockNumber }))),
      Promise.all(
        adapterAddresses.map((adapter) =>
          publicClient.readContract({
            address: adapterRegistry,
            abi: allowlistAbi,
            functionName: "isAllowed",
            args: [adapter],
            blockNumber,
          }),
        ),
      ),
      Promise.all(
        tokenAddresses.map((token) =>
          publicClient.readContract({
            address: tokenAllowlist,
            abi: allowlistAbi,
            functionName: "isAllowed",
            args: [token],
            blockNumber,
          }),
        ),
      ),
    ]);
    if (adapterCodes.some((code) => !code) || adapterAllowed.some((allowed) => !allowed)) {
      throw new Error("One or more policy adapters lack code or are no longer allowlisted.");
    }
    if (tokenCodes.some((code) => !code) || tokensAllowed.some((allowed) => !allowed)) {
      throw new Error("One or more policy tokens lack code or are no longer allowlisted.");
    }
  }

  return {
    address,
    policyHash,
    resolved,
    policyToken: encodeLivePolicyPlan(resolved.plan.steps),
    policy,
    blockNumber,
  };
}

function uniquePolicyAddresses(addresses: readonly Address[]): Address[] {
  const seen = new Set<string>();
  return addresses.flatMap((raw) => {
    const address = getAddress(raw);
    const key = address.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [address];
  });
}

/** The zap holds ETH directly, so the zero address has to render as ETH. */
export function assetSymbolForDisplay(asset: Address): string {
  return isAddressEqual(asset, zeroAddress) ? "ETH" : assetSymbolFor(asset);
}

/**
 * Order the factory's creation logs newest-first and take at most `limit`,
 * reporting how many exist either way.
 *
 * Deduplicating by address is what makes `total` a count of capsules rather
 * than of log rows: CREATE2 means the factory cannot mint one address twice, so
 * a repeated address can only be an RPC returning the same log again, and
 * counting it would inflate the number the index prints.
 */
export function newestZapCreations(
  created: readonly ZapCreatedLogInput[],
  limit: number,
): { rows: ZapCreatedLogInput[]; total: number; truncated: boolean } {
  const seen = new Set<string>();
  const distinct: ZapCreatedLogInput[] = [];
  for (const log of [...created].sort(newestFirst)) {
    const key = getAddress(log.zap);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(log);
  }

  const rows = distinct.slice(0, Math.max(limit, 0));
  return { rows, total: distinct.length, truncated: distinct.length > rows.length };
}

/**
 * Every implementation this release recognises as canonical. Pinned here rather
 * than trusted from the factory: a rogue factory reporting its own address as
 * `implementation()` would otherwise verify against itself and pass. A capsule
 * from ANY of the three live lineages is canonical — checking only v1.1 marked
 * every automated (v3 / v3.1) capsule "unverified shape" despite it being a
 * byte-correct clone.
 */
const CANONICAL_IMPLEMENTATIONS: readonly Address[] = [
  OPENZAP_CONTRACTS.implementation,
  OPENZAP_V3_CONTRACTS.implementation,
  OPENZAP_V3_1_CONTRACTS.implementation,
];

/**
 * True when the runtime is the EIP-1167 clone of the factory's own
 * implementation AND that implementation is one this release ships.
 * Deliberately not `inspectOwnedZap`: that helper is owner-bound and throws.
 */
export function assertCanonicalClone(runtime: Hex | null, factoryImplementation: Address): boolean {
  if (!runtime) return false;
  if (!CANONICAL_IMPLEMENTATIONS.some((impl) => isAddressEqual(factoryImplementation, impl))) return false;
  return runtime.toLowerCase() === expectedCloneRuntime(factoryImplementation).toLowerCase();
}

/**
 * Newest terminal event wins: a zap that executed and was later drained reads
 * "recovered", one drained before a later execution reads "executed". With no
 * events, a non-zero balance is the only thing separating funded from created.
 */
export function deriveLifecycle(
  executions: readonly ZapExecution[],
  recoveries: readonly ZapRecovery[],
  balances: ZapBalances,
): ZapLifecycle {
  const newestExecution = executions[0] ?? null;
  const newestRecovery = recoveries[0] ?? null;

  if (newestExecution && newestRecovery) {
    return isNewer(newestRecovery, newestExecution) ? "recovered" : "executed";
  }
  if (newestRecovery) return "recovered";
  if (newestExecution) return "executed";
  if (balances.weth !== "0" || balances.zaps !== "0" || balances.native !== "0") return "funded";
  return "created";
}

/**
 * Fold one zap's proven creation log, its own execution and EmergencyExit logs
 * and its onchain reads into the detail payload. The created log is the identity
 * gate — it must name this address — and every event is re-filtered by emitter
 * so a lookalike event from another contract can never be attributed here.
 *
 * "Execution" here means every confirmed run: the owner-signed one-shot AND the
 * three automated events. They are one list because they are one history — a
 * recurring capsule emits nothing else, so a list built from `Executed` alone
 * reports it as never having run.
 */
export function aggregateZapDetail(input: ZapDetailInput): ZapDetailPayload {
  const address = getAddress(input.address);
  if (!isAddressEqual(input.created.zap, address)) {
    throw new Error("ZapCreated log does not belong to this zap.");
  }

  // Neither execution array is sorted here: they are interleaved into one list
  // below, and that merged sort is the only ordering that means anything.
  const executedLogs = input.executed.filter((log) => isAddressEqual(log.emitter, address));
  // The same emitter gate the one-shot logs pass: any contract can emit an
  // identically-shaped ExecutedRecurring, and a spoofed one must never become a
  // run in this capsule's count, totals, or lifecycle.
  const automatedLogs = input.automated.filter((log) => isAddressEqual(log.emitter, address));
  const exitLogs = input.exits.filter((log) => isAddressEqual(log.emitter, address)).sort(newestFirst);

  const executions: ZapExecution[] = [
    ...executedLogs.map((log): ZapExecution => ({
      kind: "one-shot",
      nonce: log.nonce.toString(),
      recipient: getAddress(log.recipient),
      executor: null,
      run: null,
      outAsset: getAddress(log.outAsset),
      assetSymbol: assetSymbolForDisplay(log.outAsset),
      amountOut: log.amountOut.toString(),
      fee: log.fee.toString(),
      txHash: log.txHash,
      blockNumber: log.blockNumber.toString(),
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
    })),
    ...automatedLogs.map((log): ZapExecution => ({
      kind: log.kind,
      nonce: log.seriesId.toString(),
      // The automated events carry no recipient, and this is not a guess to
      // cover that: `recipient` is set once in `initialize` with no setter, and
      // every automated path transfers the net output to exactly that address
      // (`_settleWithExecutorFee`). The policy read in this same snapshot is
      // therefore who this run paid.
      recipient: getAddress(input.policy.recipient),
      executor: getAddress(log.executor),
      run: log.run,
      outAsset: getAddress(log.outAsset),
      assetSymbol: assetSymbolForDisplay(log.outAsset),
      amountOut: log.amountOut.toString(),
      fee: (log.executorFee + log.potFee).toString(),
      txHash: log.txHash,
      blockNumber: log.blockNumber.toString(),
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
    })),
  ].sort(newestRowFirst);

  const recoveries: ZapRecovery[] = exitLogs.map((log) => ({
    owner: getAddress(log.owner),
    asset: getAddress(log.asset),
    assetSymbol: assetSymbolForDisplay(log.asset),
    amount: log.amount.toString(),
    txHash: log.txHash,
    blockNumber: log.blockNumber.toString(),
    logIndex: log.logIndex,
    timestamp: input.timestamps.get(log.blockNumber) ?? null,
  }));

  // Both kinds settle the same way — gross out of the adapter, minus a fee, net
  // to the recipient — so they sum into one pair of totals and `net + fee` stays
  // the gross for every asset regardless of which path produced it.
  const amountOutByAsset: Record<string, bigint> = {};
  const feeByAsset: Record<string, bigint> = {};
  const addTotals = (outAsset: Address, amountOut: bigint, fee: bigint): void => {
    const symbol = assetSymbolForDisplay(outAsset);
    amountOutByAsset[symbol] = (amountOutByAsset[symbol] ?? 0n) + amountOut;
    feeByAsset[symbol] = (feeByAsset[symbol] ?? 0n) + fee;
  };
  for (const log of executedLogs) addTotals(log.outAsset, log.amountOut, log.fee);
  for (const log of automatedLogs) addTotals(log.outAsset, log.amountOut, log.executorFee + log.potFee);

  const balances: ZapBalances = {
    weth: input.balances.weth.toString(),
    zaps: input.balances.zaps.toString(),
    native: input.balances.native.toString(),
  };

  const stats: ZapStats = {
    executionCount: executions.length,
    automatedRunCount: automatedLogs.length,
    recoveryCount: recoveries.length,
    amountOutByAsset: toDecimalStrings(amountOutByAsset),
    feeByAsset: toDecimalStrings(feeByAsset),
    firstExecutionAt: executions.at(-1)?.timestamp ?? null,
    lastExecutionAt: executions[0]?.timestamp ?? null,
  };

  const provenance: ZapProvenance = {
    address,
    owner: getAddress(input.created.owner),
    policyHash: input.created.policyHash,
    implCodeHash: input.created.implCodeHash,
    salt: input.created.salt,
    createdBlock: input.created.blockNumber.toString(),
    createdTx: input.created.txHash,
    createdAt: input.timestamps.get(input.created.blockNumber) ?? null,
  };

  return {
    provenance,
    policy: buildPolicyView(input.policy, input.runtime, input.factory.implementation),
    stats,
    balances,
    executions,
    recoveries,
    lifecycle: deriveLifecycle(executions, recoveries, balances),
    headBlock: input.headBlock.toString(),
    readAt: input.readAt,
    factory: {
      version: input.factory.version,
      implementation: getAddress(input.factory.implementation),
    },
  };
}

/**
 * Describe the policy exactly as the clone reports it, then list every way it
 * departs from the routes the live contracts support. Nothing here is
 * asserted away: a deviating zap is still shown, with its deviations named.
 */
function buildPolicyView(
  policy: ZapPolicyRead,
  runtime: Hex | null,
  factoryImplementation: Address,
): ZapPolicyView {
  const step = policy.steps[0] ?? null;
  const canonicalClone = assertCanonicalClone(runtime, factoryImplementation);
  const stepsComplete = BigInt(policy.steps.length) === policy.stepCount;
  const hashMatches =
    stepsComplete &&
    hashRobinhoodPolicy({
      owner: policy.owner,
      recipient: policy.recipient,
      maxRelayerFeeCap: policy.maxRelayerFeeCap,
      optimization: policy.optimization,
      trackedAssets: policy.trackedAssets,
      steps: policy.steps,
    }).toLowerCase() === policy.policyHash.toLowerCase();

  const orderedPolicy = stepsComplete
    ? resolveOnchainLivePolicy({
        trackedAssets: policy.trackedAssets,
        steps: policy.steps,
      })
    : null;
  if (orderedPolicy && policy.steps.length > 1) {
    return recognizedOrderedPolicyView(
      policy,
      orderedPolicy,
      canonicalClone,
      stepsComplete,
      hashMatches,
    );
  }

  // Resolve the deployed route the step implements (adapter + tokens + tracked
  // assets + data shape). When it is a recognized route — a swap, the stitched
  // multi-pool route, a vault leg, or an LP provide/withdraw — report
  // deviations against THAT route so a legitimate capsule is not branded
  // "does not match the live route". An unrecognized step falls through to the
  // bounded-route deviation list.
  const route = step
    ? resolveRouteFromStep(step.adapter, step.tokenIn, policy.trackedAssets, step.data)
    : null;
  if (route && step) {
    return recognizedRouteView(policy, step, route, canonicalClone, stepsComplete, hashMatches);
  }

  const direction = directionOrNull(step?.tokenIn ?? null);
  const deviations: string[] = [];
  if (!canonicalClone) {
    deviations.push("Runtime bytecode is not an EIP-1167 clone of the canonical implementation.");
  }
  if (!isAddressEqual(policy.recipient, policy.owner)) {
    deviations.push(`Recipient ${policy.recipient} is not the owner ${policy.owner}.`);
  }
  if (policy.maxRelayerFeeCap !== 0n) {
    deviations.push(`maxRelayerFeeCap is ${policy.maxRelayerFeeCap}; the live route requires 0.`);
  }
  if (!policy.optimization) {
    deviations.push("Optimization is disabled; the live route requires it enabled.");
  }
  if (
    policy.trackedAssets.length !== 2 ||
    !isAddressEqual(policy.trackedAssets[0], ROBINHOOD_ASSETS.weth) ||
    !isAddressEqual(policy.trackedAssets[1], ROBINHOOD_ASSETS.zaps)
  ) {
    deviations.push("Tracked assets are not exactly [aeWETH, 0xZAPS].");
  }
  if (policy.stepCount !== 1n) {
    deviations.push(`Step count is ${policy.stepCount}; the live route allows exactly one step.`);
  }
  if (!stepsComplete) {
    deviations.push(
      `Only ${policy.steps.length} of ${policy.stepCount} steps were read; the policy hash could not be recomputed.`,
    );
  }
  if (!step) {
    deviations.push("The zap exposes no step.");
  } else {
    if (!isAddressEqual(step.adapter, OPENZAP_CONTRACTS.adapter)) {
      deviations.push(`Step adapter ${step.adapter} is not the live adapter ${OPENZAP_CONTRACTS.adapter}.`);
    }
    if (!isAddressEqual(step.spender, OPENZAP_CONTRACTS.adapter)) {
      deviations.push(`Step spender ${step.spender} is not the live adapter ${OPENZAP_CONTRACTS.adapter}.`);
    }
    if (step.data !== "0x") {
      deviations.push("Step calldata is not empty; the live adapter takes none.");
    }
    if (step.amountIn <= 0n || step.amountIn > MAX_ROUTER_AMOUNT) {
      deviations.push(`Step amountIn ${step.amountIn} is outside the router's uint128 range.`);
    }
    if (!direction) {
      deviations.push(
        `Input asset ${assetSymbolForDisplay(step.tokenIn)} is outside the live aeWETH/0xZAPS route.`,
      );
    }
  }
  if (stepsComplete && !hashMatches) {
    deviations.push("Policy hash does not match the policy this zap exposes.");
  }

  return {
    owner: getAddress(policy.owner),
    recipient: getAddress(policy.recipient),
    maxRelayerFeeCap: policy.maxRelayerFeeCap.toString(),
    optimization: policy.optimization,
    trackedAssets: policy.trackedAssets.map((asset) => getAddress(asset)),
    stepCount: policy.stepCount.toString(),
    steps: policy.steps.map(stepView),
    routeIds: [],
    step: step
      ? stepView(step)
      : null,
    policyHash: policy.policyHash,
    direction,
    routeKind: null,
    inputSymbol: step ? assetSymbolForDisplay(step.tokenIn) : null,
    outputSymbol: direction ? assetsForDirection(direction).outputSymbol : null,
    outAsset: direction ? assetsForDirection(direction).tokenOut : null,
    hashMatches,
    canonicalClone,
    matchesLiveRoute: deviations.length === 0,
    deviations,
  };
}

/**
 * A ZapPolicyView for a capsule whose step implements a recognized DEPLOYED
 * route (bounded swap, USDG pool, or a vault leg). `resolveRouteFromStep` has
 * already pinned the adapter, tracked-asset pair, input token and Step.data
 * shape — those cannot deviate here — so only the route-independent invariants
 * are checked, and the route's own tokens name the symbols.
 */
function recognizedRouteView(
  policy: ZapPolicyRead,
  step: ZapStepRead,
  route: Route,
  canonicalClone: boolean,
  stepsComplete: boolean,
  hashMatches: boolean,
): ZapPolicyView {
  const deviations: string[] = [];
  if (!canonicalClone) {
    deviations.push("Runtime bytecode is not an EIP-1167 clone of the canonical implementation.");
  }
  if (!isAddressEqual(policy.recipient, policy.owner)) {
    deviations.push(`Recipient ${policy.recipient} is not the owner ${policy.owner}.`);
  }
  if (policy.maxRelayerFeeCap !== 0n) {
    deviations.push(`maxRelayerFeeCap is ${policy.maxRelayerFeeCap}; the live route requires 0.`);
  }
  if (!policy.optimization) {
    deviations.push("Optimization is disabled; the live route requires it enabled.");
  }
  if (policy.stepCount !== 1n) {
    deviations.push(`Step count is ${policy.stepCount}; the live route allows exactly one step.`);
  }
  if (!stepsComplete) {
    deviations.push(
      `Only ${policy.steps.length} of ${policy.stepCount} steps were read; the policy hash could not be recomputed.`,
    );
  }
  if (!isAddressEqual(step.spender, route.adapter)) {
    deviations.push(`Step spender ${step.spender} is not the route adapter ${route.adapter}.`);
  }
  if (step.amountIn <= 0n || step.amountIn > MAX_ROUTER_AMOUNT) {
    deviations.push(`Step amountIn ${step.amountIn} is outside the router's uint128 range.`);
  }
  if (stepsComplete && !hashMatches) {
    deviations.push("Policy hash does not match the policy this zap exposes.");
  }

  return {
    owner: getAddress(policy.owner),
    recipient: getAddress(policy.recipient),
    maxRelayerFeeCap: policy.maxRelayerFeeCap.toString(),
    optimization: policy.optimization,
    trackedAssets: policy.trackedAssets.map((asset) => getAddress(asset)),
    stepCount: policy.stepCount.toString(),
    steps: policy.steps.map(stepView),
    routeIds: [route.id],
    step: stepView(step),
    policyHash: policy.policyHash,
    direction: route.direction,
    routeKind: route.kind,
    inputSymbol: route.tokenIn.symbol,
    outputSymbol: route.tokenOut.symbol,
    outAsset: route.tokenOut.address,
    hashMatches,
    canonicalClone,
    matchesLiveRoute: deviations.length === 0,
    deviations,
  };
}

function recognizedOrderedPolicyView(
  policy: ZapPolicyRead,
  resolved: ResolvedLivePolicy,
  canonicalClone: boolean,
  stepsComplete: boolean,
  hashMatches: boolean,
): ZapPolicyView {
  const deviations: string[] = [];
  if (!canonicalClone) {
    deviations.push("Runtime bytecode is not an EIP-1167 clone of the canonical implementation.");
  }
  if (!isAddressEqual(policy.recipient, policy.owner)) {
    deviations.push(`Recipient ${policy.recipient} is not the owner ${policy.owner}.`);
  }
  if (policy.maxRelayerFeeCap !== 0n) {
    deviations.push(`maxRelayerFeeCap is ${policy.maxRelayerFeeCap}; the live route requires 0.`);
  }
  if (!policy.optimization) {
    deviations.push("Optimization is disabled; the live route requires it enabled.");
  }
  if (!stepsComplete) {
    deviations.push(
      `Only ${policy.steps.length} of ${policy.stepCount} steps were read; the policy hash could not be recomputed.`,
    );
  }
  if (stepsComplete && !hashMatches) {
    deviations.push("Policy hash does not match the policy this zap exposes.");
  }

  return {
    owner: getAddress(policy.owner),
    recipient: getAddress(policy.recipient),
    maxRelayerFeeCap: policy.maxRelayerFeeCap.toString(),
    optimization: policy.optimization,
    trackedAssets: policy.trackedAssets.map((asset) => getAddress(asset)),
    stepCount: policy.stepCount.toString(),
    steps: policy.steps.map(stepView),
    routeIds: resolved.steps.map((entry) => entry.route.id),
    step: policy.steps[0] ? stepView(policy.steps[0]) : null,
    policyHash: policy.policyHash,
    direction: null,
    routeKind: null,
    inputSymbol: resolved.inputRoute.tokenIn.symbol,
    outputSymbol: resolved.outputRoute.tokenOut.symbol,
    outAsset: resolved.outputRoute.tokenOut.address,
    hashMatches,
    canonicalClone,
    matchesLiveRoute: deviations.length === 0,
    deviations,
  };
}

function stepView(step: ZapStepRead): ZapStepView {
  return {
    adapter: getAddress(step.adapter),
    tokenIn: getAddress(step.tokenIn),
    spender: getAddress(step.spender),
    amountIn: step.amountIn.toString(),
    data: step.data,
  };
}

/** directionFromTokenIn throws off-route; the read layer reports null instead. */
function directionOrNull(tokenIn: Address | null): ZapDirection | null {
  if (!tokenIn) return null;
  if (isAddressEqual(tokenIn, ROBINHOOD_ASSETS.weth)) return "buy";
  if (isAddressEqual(tokenIn, ROBINHOOD_ASSETS.zaps)) return "sell";
  return null;
}

function isNewer(
  a: { blockNumber: string; logIndex: number },
  b: { blockNumber: string; logIndex: number },
): boolean {
  const blockA = BigInt(a.blockNumber);
  const blockB = BigInt(b.blockNumber);
  return blockA === blockB ? a.logIndex > b.logIndex : blockA > blockB;
}

function newestFirst(
  a: { blockNumber: bigint; logIndex: number },
  b: { blockNumber: bigint; logIndex: number },
): number {
  if (a.blockNumber === b.blockNumber) return b.logIndex - a.logIndex;
  return a.blockNumber < b.blockNumber ? 1 : -1;
}

/**
 * The same order for rows that have already been rendered, whose block number
 * is a decimal string. Interleaving one-shot and automated runs is what makes
 * `executions[0]` the newest run of EITHER kind — and therefore what makes
 * `lastExecutionAt` and the lifecycle read the real end of the history.
 */
function newestRowFirst(
  a: { blockNumber: string; logIndex: number },
  b: { blockNumber: string; logIndex: number },
): number {
  const blockA = BigInt(a.blockNumber);
  const blockB = BigInt(b.blockNumber);
  if (blockA === blockB) return b.logIndex - a.logIndex;
  return blockA < blockB ? 1 : -1;
}

function toDecimalStrings(totals: Record<string, bigint>): Record<string, string> {
  return Object.fromEntries(Object.entries(totals).map(([symbol, total]) => [symbol, total.toString()]));
}
