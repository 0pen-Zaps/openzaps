// The tool table.
//
// Every tool declares a SAFETY CLASS, and the classes are the whole design:
//
//   read-only  changes nothing, anywhere
//   publish    moves an artifact the owner ALREADY signed; cannot create authority
//
// There is deliberately no third class. Nothing in this server broadcasts a transaction, holds a
// key, or signs. That is not a policy we enforce with care — it is enforced by not importing a
// wallet client, and by calling submitExecution with a null signer, which makes broadcasting
// structurally unreachable rather than merely unintended.
//
// The reason this is safe to hand an agent at all: onchain, an agent's authority is exactly one
// field of an owner-signed intent —
//
//     if (intent.executor != address(0) && msg.sender != intent.executor) revert ExecutorMismatch();
//
// so the worst a fully compromised agent achieves is submitting a run the capsule already owes, or
// refusing to submit one.
import { readFileSync } from "node:fs";
import { getAddress, isAddressEqual, zeroAddress } from "viem";

import { evaluateRecurring, evaluateTrigger, submitExecution } from "../executor/engine.mjs";
import { fetchRelayIntents } from "../executor/relay-source.mjs";
import { loadIntents, validateIntentObject } from "../executor/store.mjs";
import { appGet } from "./config.mjs";

export const READ_ONLY = "read-only";
export const PUBLISH = "publish";

const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const UINT = { type: "string", pattern: "^[0-9]{1,78}$" };

// ---------------------------------------------------------------------------
// Shared helpers

/** Recurring series are keyed by seriesId; triggers by nonce. One name for both. */
function authorizationIdOf(item) {
  return item.kind === "trigger" ? item.intent.nonce : item.intent.seriesId;
}

/**
 * Find one signed authorization, from the local store first and the relay second.
 *
 * Local wins on a tie because a file on this machine is what the owner put there deliberately,
 * while the relay is a shared pool anyone can publish into. Both are re-validated by the same
 * schema gate and both are re-verified onchain, so the ordering is about provenance, not trust.
 */
async function findIntent(ctx, zapRaw, authorizationId) {
  const zap = getAddress(zapRaw);
  const wanted = BigInt(authorizationId);
  const matches = (item) => isAddressEqual(getAddress(item.intent.zap), zap) && authorizationIdOf(item) === wanted;

  const local = loadIntents(ctx.cfg.intentsDir);
  const localHit = local.ok.find(matches);
  if (localHit) return { ...localHit, source: "local" };

  if (ctx.cfg.relayUrl) {
    const relay = await fetchRelayIntents(ctx.cfg.relayUrl);
    const relayHit = relay.ok.find(matches);
    if (relayHit) return relayHit;
  }
  throw new Error(
    `No signed authorization ${authorizationId} found for ${zap} in the local store or the relay.`,
  );
}

function describeIntent(item) {
  const { intent, kind } = item;
  const executor = getAddress(intent.executor);
  return {
    kind,
    source: item.source ?? "local",
    zap: getAddress(intent.zap),
    authorizationId: authorizationIdOf(item).toString(),
    validAfter: intent.validAfter.toString(),
    deadline: intent.deadline.toString(),
    recipient: getAddress(intent.recipient),
    outAsset: getAddress(intent.outAsset),
    executor: isAddressEqual(executor, zeroAddress) ? null : executor,
    executorAccess: isAddressEqual(executor, zeroAddress) ? "anyone" : "pinned",
    interval: intent.interval?.toString() ?? null,
    maxRuns: intent.maxRuns?.toString() ?? null,
    maxGas: intent.maxGas.toString(),
    maxFeePerGas: intent.maxFeePerGas.toString(),
    policyHash: intent.policyHash,
  };
}

/**
 * Every custom error the capsule can revert with, in plain language.
 *
 * Static on purpose: these are the contract's own error selectors, and an agent that guesses at
 * what a revert meant will confidently tell a human the wrong thing. Sourced from
 * contracts/src/v3/OpenZapV3.sol:138-173.
 */
const ERRORS = {
  ExecutorMismatch:
    "This authorization pins a specific executor and you are not it. Only the pinned address may submit; the owner must sign new terms to change that.",
  IntervalNotElapsed: "The cadence has not elapsed. The capsule refuses early runs — wait for the next interval.",
  NonceReplay: "This authorization id is already spent. Each run consumes one id; it can never be reused.",
  TriggerNotMet: "The signed price condition is not met right now. The capsule re-reads the price itself at execution.",
  MinOutNotMet:
    "Output would be below the signed floor, net of the 1% execution fee. Not an error to retry blindly — the route is currently worse than the owner agreed to accept.",
  Expired: "The signed deadline has passed. Nothing can revive this authorization; the owner must sign new terms.",
  NotYetValid: "The signed validAfter time has not arrived yet.",
  GasLimitTooHigh:
    "The transaction gas limit exceeds the signed maxGas. Simulate with gas capped at intent.maxGas, not at the block limit.",
  GasPriceTooHigh: "The transaction gas price exceeds the signed maxFeePerGas. Wait for the base fee to fall.",
  BadSignature: "The signature does not recover to the capsule owner (EOA or ERC-1271).",
  PolicyMismatch: "The submitted policy does not hash to the capsule's frozen policy. The capsule is immutable; the caller is wrong.",
  WrongRecipient: "The recipient does not match the capsule's welded recipient. It was set at initialize and has no setter.",
  WrongChain: "The intent was signed for a different chain id.",
  WrongZap: "The intent was signed for a different capsule.",
  FeeAboveCap: "The relayer fee exceeds the policy's maxRelayerFeeCap.",
  NotOwner: "Only the capsule owner may call this. Revocation and emergency exit are owner-only, by design.",
  AdapterNotAllowed: "The step's adapter is not on the allowlist.",
  TokenNotAllowed: "The step's token is not on the allowlist.",
  InvalidSchedule: "The recurring interval or run count is outside what the capsule accepts.",
  InvalidThreshold: "The trigger threshold is outside the accepted range (1..10000 bps).",
  PriceSourceNotAllowed: "The trigger's price source is not on the allowlist.",
  Reentrancy: "Reentrancy guard tripped.",
};

// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "agent_identity",
    safety: READ_ONLY,
    description:
      "Report this agent's executor address — the address a human pins in a signed intent so that only this agent may submit its runs. Returns read-only when no executor key is configured.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      if (!ctx.executorAddress) {
        return {
          mode: "read-only",
          executorAddress: null,
          detail:
            "No executor key is configured, so this agent has no address to pin and cannot submit runs. It can still read capsules, explain policies, and simulate.",
        };
      }
      return {
        mode: "executor",
        executorAddress: ctx.executorAddress,
        chainId: ctx.cfg.chainId,
        detail:
          "Pin this address as the executor when signing a standing intent and only this agent may submit its runs. Pinning is a liveness trade: if this agent stops, the series stalls until the owner submits it themselves.",
        howToPin: `${ctx.appUrl}/zap?view=connect&agent=${ctx.executorAddress}`,
      };
    },
  },

  {
    name: "list_zaps",
    safety: READ_ONLY,
    description: "List the capsules a wallet created, with confirmed run counts and lifecycle state.",
    inputSchema: {
      type: "object",
      properties: { owner: ADDRESS },
      required: ["owner"],
      additionalProperties: false,
    },
    async handler({ owner }, ctx) {
      const profile = await appGet(ctx, `/api/profile/${getAddress(owner)}`);
      return {
        owner: profile.owner,
        sourceStatus: profile.sourceStatus,
        stats: profile.stats,
        zaps: profile.zaps.map((zap) => ({
          address: zap.address,
          lineage: zap.lineage,
          executionCount: zap.executionCount,
          automatedRunCount: zap.automatedRunCount,
          lastActivityAt: zap.lastActivityAt,
        })),
      };
    },
  },

  {
    name: "read_zap",
    safety: READ_ONLY,
    description:
      "Read one capsule: its frozen policy, balances, confirmed executions, and every invariant that does NOT hold.",
    inputSchema: {
      type: "object",
      properties: { address: ADDRESS },
      required: ["address"],
      additionalProperties: false,
    },
    async handler({ address }, ctx) {
      return appGet(ctx, `/api/zaps/${getAddress(address)}`);
    },
  },

  {
    name: "explain_policy",
    safety: READ_ONLY,
    description:
      "Explain in plain language what one capsule can and cannot do, including whether its committed policy hash still verifies.",
    inputSchema: {
      type: "object",
      properties: { address: ADDRESS },
      required: ["address"],
      additionalProperties: false,
    },
    async handler({ address }, ctx) {
      const detail = await appGet(ctx, `/api/zaps/${getAddress(address)}`);
      const policy = detail.policy;
      return {
        address: getAddress(address),
        lifecycle: detail.lifecycle,
        canDo: [
          policy.routeKind ? `Run a ${policy.routeKind} route${policy.inputSymbol ? ` from ${policy.inputSymbol}` : ""}${policy.outputSymbol ? ` to ${policy.outputSymbol}` : ""}.` : "Run its frozen step sequence.",
          `Pay out only to ${policy.recipient}.`,
        ],
        cannotDo: [
          "Change its recipient — set once at initialize, no setter exists.",
          "Change its steps, adapters, or calldata — the policy is hashed at initialize and re-checked on every run.",
          "Pay a relayer more than its maxRelayerFeeCap.",
        ],
        integrity: {
          policyHash: policy.policyHash,
          hashMatches: policy.hashMatches,
          canonicalClone: policy.canonicalClone,
          matchesLiveRoute: policy.matchesLiveRoute,
          // The one field worth reading before anything else. A non-empty list
          // means an invariant this capsule claims does not actually hold.
          deviations: policy.deviations,
        },
        verdict:
          policy.deviations.length === 0
            ? "Every checked invariant holds."
            : `${policy.deviations.length} invariant(s) do NOT hold — read the deviations list before acting on this capsule.`,
      };
    },
  },

  {
    name: "list_intents",
    safety: READ_ONLY,
    description:
      "List signed standing authorizations from the shared relay. Filter by owner, capsule, executor, or status.",
    inputSchema: {
      type: "object",
      properties: {
        owner: ADDRESS,
        zap: ADDRESS,
        executor: ADDRESS,
        status: { type: "string", enum: ["open", "consumed"] },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const params = new URLSearchParams();
      for (const key of ["owner", "zap", "executor"]) {
        if (args[key]) params.set(key, getAddress(args[key]));
      }
      params.set("status", args.status ?? "open");
      const body = await appGet(ctx, `/api/intents?${params.toString()}`);
      return {
        count: body.intents.length,
        intents: body.intents.map((record) => ({
          id: record.id,
          zap: record.zap,
          owner: record.owner,
          kind: record.kind,
          status: record.status,
          createdAt: record.createdAt,
          executor: record.intent.executor,
          recipient: record.intent.recipient,
        })),
      };
    },
  },

  {
    name: "read_intent",
    safety: READ_ONLY,
    description:
      "Read the full signed terms of one standing authorization, from the local store or the relay.",
    inputSchema: {
      type: "object",
      properties: { zap: ADDRESS, authorizationId: UINT },
      required: ["zap", "authorizationId"],
      additionalProperties: false,
    },
    async handler({ zap, authorizationId }, ctx) {
      const item = await findIntent(ctx, zap, authorizationId);
      return describeIntent(item);
    },
  },

  {
    name: "check_intent_status",
    safety: READ_ONLY,
    description:
      "Ask the chain whether one authorization is due, waiting, finished, or expired right now. Reads the same state the capsule enforces.",
    inputSchema: {
      type: "object",
      properties: { zap: ADDRESS, authorizationId: UINT },
      required: ["zap", "authorizationId"],
      additionalProperties: false,
    },
    async handler({ zap, authorizationId }, ctx) {
      const item = await findIntent(ctx, zap, authorizationId);
      const block = await ctx.publicClient.getBlock({ blockTag: "latest" });
      const evaluate = item.kind === "trigger" ? evaluateTrigger : evaluateRecurring;
      const verdict = await evaluate(ctx.publicClient, item, block.timestamp);
      return {
        zap: getAddress(zap),
        authorizationId: String(authorizationId),
        kind: item.kind,
        status: verdict.status,
        detail: verdict.detail,
        readAtBlock: block.number.toString(),
        readAtTimestamp: block.timestamp.toString(),
      };
    },
  },

  {
    name: "simulate_run",
    safety: READ_ONLY,
    description:
      "Ask the capsule whether it would accept a run of this authorization right now, and if not, which guard refuses. Never sends a transaction.",
    inputSchema: {
      type: "object",
      properties: { zap: ADDRESS, authorizationId: UINT },
      required: ["zap", "authorizationId"],
      additionalProperties: false,
    },
    async handler({ zap, authorizationId }, ctx) {
      const item = await findIntent(ctx, zap, authorizationId);
      // The null walletClient IS the guarantee. submitExecution returns
      // { outcome: "watch-only" } on a passing simulation and cannot reach its
      // broadcast branch without a signer — so this is unable to send a
      // transaction, not merely instructed not to.
      const result = await submitExecution(ctx.publicClient, null, item, ctx.cfg);
      return {
        zap: getAddress(zap),
        authorizationId: String(authorizationId),
        outcome: result.outcome,
        detail: result.detail,
        wouldExecute: result.outcome === "watch-only",
        refusedBy: result.outcome === "simulation-reverted" ? namedError(result.detail) : null,
      };
    },
  },

  {
    name: "list_connections",
    safety: READ_ONLY,
    description:
      "List the capsules whose open authorizations pin a given agent address — what that agent is allowed to submit.",
    inputSchema: {
      type: "object",
      properties: { agent: ADDRESS },
      required: ["agent"],
      additionalProperties: false,
    },
    async handler({ agent }, ctx) {
      return appGet(ctx, `/api/agents/${getAddress(agent)}`);
    },
  },

  {
    name: "draft_intent",
    safety: READ_ONLY,
    description:
      "Draft an UNSIGNED standing authorization and return the link a human opens to review and sign it. This cannot sign — only the capsule owner's wallet can.",
    inputSchema: {
      type: "object",
      required: ["zap", "mode"],
      additionalProperties: false,
      properties: {
        zap: ADDRESS,
        mode: { type: "string", enum: ["recurring", "trigger"] },
        executor: ADDRESS,
        interval: { type: "string", enum: ["hourly", "6h", "daily", "weekly", "monthly"] },
        runs: { type: "string", pattern: "^[0-9]{1,3}$" },
        threshold: { type: "string", enum: ["up5", "up10", "up25", "down5", "down10", "down25"] },
      },
    },
    async handler(args, ctx) {
      const zap = getAddress(args.zap);
      const executor = args.executor ? getAddress(args.executor) : ctx.executorAddress;
      const params = new URLSearchParams({
        view: "automate",
        src: "build",
        mode: args.mode,
        route: "robinhood-v4-weth-zaps",
        amount: "0.01",
        bps: "100",
      });
      if (args.mode === "trigger") {
        params.set("threshold", args.threshold ?? "up10");
        params.set("days", "30");
      } else {
        params.set("interval", args.interval ?? "daily");
        params.set("runs", args.runs ?? "10");
      }
      if (executor) params.set("agent", executor);

      return {
        signed: false,
        zap,
        proposedExecutor: executor,
        // The ONLY way this becomes real. There is no code path in this server
        // that produces a signature.
        signHere: `${ctx.appUrl}/zap?${params.toString()}`,
        detail:
          "Give this link to the capsule owner. They review the terms and sign in their own wallet; nothing is authorized until they do.",
      };
    },
  },

  {
    name: "publish_intent",
    safety: PUBLISH,
    description:
      "Publish an ALREADY-SIGNED standing authorization to the shared relay so executors can discover it. Rejects anything unsigned; the relay re-verifies the signature against the capsule's onchain owner regardless.",
    inputSchema: {
      type: "object",
      required: ["signedIntent"],
      additionalProperties: false,
      properties: {
        signedIntent: {
          type: "object",
          required: ["kind", "intent", "signature"],
          properties: {
            kind: { type: "string", enum: ["recurring", "recurring-relative", "trigger"] },
            intent: { type: "object" },
            signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130,}$" },
          },
        },
      },
    },
    async handler({ signedIntent }, ctx) {
      // Same schema gate the daemon applies to a dropped file. It also enforces
      // the signature's presence and shape, so an unsigned draft cannot pass.
      const validated = validateIntentObject(signedIntent);
      if (BigInt(validated.intent.chainId) !== BigInt(ctx.cfg.chainId)) {
        throw new Error(`intent is for chain ${validated.intent.chainId}, this agent is on ${ctx.cfg.chainId}`);
      }

      const response = await fetch(`${ctx.appUrl}/api/intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signedIntent),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`relay refused the intent (HTTP ${response.status})${body?.error ? ` — ${body.error}` : ""}`);
      }
      return { published: "relay", id: body?.id ?? null, detail: "Executors can now discover this authorization." };
    },
  },

  {
    name: "deliver_intent_local",
    safety: PUBLISH,
    description:
      "Hand an ALREADY-SIGNED authorization to the executor running on this machine. Reads the local intake token off disk; the token is never returned and never enters your context.",
    inputSchema: {
      type: "object",
      required: ["signedIntent"],
      additionalProperties: false,
      properties: {
        signedIntent: {
          type: "object",
          required: ["kind", "intent", "signature"],
          properties: {
            kind: { type: "string", enum: ["recurring", "recurring-relative", "trigger"] },
            intent: { type: "object" },
            signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130,}$" },
          },
        },
      },
    },
    async handler({ signedIntent }, ctx) {
      const validated = validateIntentObject(signedIntent);
      if (BigInt(validated.intent.chainId) !== BigInt(ctx.cfg.chainId)) {
        throw new Error(`intent is for chain ${validated.intent.chainId}, this executor is on ${ctx.cfg.chainId}`);
      }

      // Read in this process, off a chmod-600 file. This is strictly better than
      // the browser flow it replaces, where the user pastes a local capability
      // into a public https origin and it lives in sessionStorage.
      let token;
      try {
        token = readFileSync(ctx.cfg.intakeTokenFile, "utf8").trim();
      } catch {
        throw new Error(
          `no intake token at ${ctx.cfg.intakeTokenFile} — start the executor once to mint one (node executor/index.mjs status)`,
        );
      }

      const response = await fetch(`http://127.0.0.1:${ctx.cfg.intakePort}/intents`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(signedIntent),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`the local executor refused the intent (HTTP ${response.status})`);
      }
      const body = await response.json().catch(() => ({}));
      return { delivered: "local-executor", stored: body?.stored ?? null };
    },
  },

  {
    name: "explain_error",
    safety: READ_ONLY,
    description:
      "Explain a capsule revert in plain language, including whether it is worth retrying. Use this instead of guessing what a revert meant.",
    inputSchema: {
      type: "object",
      properties: { error: { type: "string", maxLength: 2048 } },
      required: ["error"],
      additionalProperties: false,
    },
    async handler({ error }) {
      const name = namedError(error);
      if (!name) {
        return {
          recognized: false,
          detail:
            "No OpenZap custom error found in that message. It may be an RPC or client error rather than a capsule refusal.",
        };
      }
      return { recognized: true, error: name, meaning: ERRORS[name] };
    },
  },
];

/** Pull a known capsule error name out of a revert message. */
function namedError(message) {
  if (typeof message !== "string") return null;
  for (const name of Object.keys(ERRORS)) {
    if (message.includes(name)) return name;
  }
  return null;
}

/** Sanity net: a broadcast-capable tool must never be added without a class for it. */
export function assertNoBroadcastTools(tools = TOOLS) {
  const bad = tools.filter((tool) => tool.safety !== READ_ONLY && tool.safety !== PUBLISH);
  if (bad.length > 0) {
    throw new Error(`Tools with an unknown safety class: ${bad.map((tool) => tool.name).join(", ")}`);
  }
}

export { ERRORS, authorizationIdOf, findIntent, namedError };
