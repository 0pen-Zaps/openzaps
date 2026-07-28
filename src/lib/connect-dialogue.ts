import { getAddress, type Address } from "viem";

import { resolveAgentConnection, type AgentAliases } from "@/lib/agent-connection";
import { narrateAgents, type NarrativeAuthorization } from "@/lib/agent-narrative";
import { DEFAULT_EXECUTION_POLICY, writeExecutionPolicyParams } from "@/lib/execution-policy";
import {
  transcriptId,
  type TranscriptChip,
  type TranscriptComposer,
  type TranscriptFactRow,
  type TranscriptMessage,
  type TranscriptPlan,
  type TranscriptStatus,
} from "@/lib/transcript";

/**
 * The scripted pairing dialogue behind `/zap?view=connect`.
 *
 * A pure function of state, deliberately: no model, no clock, no network. Connecting an agent is
 * one of the few flows where a wrong sentence has a cost — someone hands a key to something — so
 * every line here is a fact about the signed intent or the capsule, and none of it is generated.
 *
 * It also never signs, never publishes, and never posts. Its terminal act is a LINK into the
 * automate console carrying query params that console already validates on arrival
 * (`readAutomationHandoff`). That keeps "the connect surface cannot move funds" true by
 * construction rather than by review.
 */

export type ConnectMode = "recurring" | "trigger";
export type ConnectAccess = "anyone" | "owner-only" | "pinned";

export interface ConnectSelection {
  zap?: Address | null;
  mode?: ConnectMode | null;
  access?: ConnectAccess | null;
  /** The person asked to describe a design in their own words. */
  describing?: boolean;
}

/** A model proposal, already compiled and judged server-side. */
export interface ConnectProposal {
  plan: TranscriptPlan;
  rationale: string;
}

export interface ConnectCapsule {
  address: Address;
  lineage: string;
  automatedRunCount: number;
}

export interface ConnectDialogueInput {
  /** Null until a wallet is connected. */
  account: Address | null;
  providerAvailable: boolean;
  isRobinhoodChain: boolean;
  /** True while capsules and authorizations are still loading. */
  loading: boolean;
  capsules: readonly ConnectCapsule[];
  /** Signed authorizations this wallet already has, for the connected view. */
  authorizations: readonly NarrativeAuthorization[];
  /** The agent address a `?agent=` deep link proposed, if any. */
  proposedAgent: Address | null;
  aliases?: AgentAliases;
  selection: ConnectSelection;
  /** The MCP client config a user pastes into their AI client. */
  mcpSnippet: string;
  explorerTx: (hash: `0x${string}`) => string;
  /** False when this deployment has no model — the free-text path is hidden, not broken. */
  agentConfigured?: boolean;
  composing?: boolean;
  /** The compiled result of the last description, or its refusal. */
  proposal?: ConnectProposal | null;
  refusal?: { reason: string; issues: string[] } | null;
}

export interface ConnectDialogue {
  messages: TranscriptMessage[];
  composer: TranscriptComposer;
  status: TranscriptStatus;
  statusNote?: string;
  /** The stage, exposed so the view can render supporting panels alongside. */
  stage: ConnectStage;
  /**
   * True when the terminal handoff link carries everything the automate console
   * needs. False at `ready` when the person chose to pin an agent but no address
   * is known yet — the link would silently downgrade their choice to "anyone".
   */
  handoffReady?: boolean;
}

export type ConnectStage =
  | "no-wallet"
  | "wrong-chain"
  | "loading"
  | "no-capsules"
  | "choose-capsule"
  | "choose-mode"
  | "choose-access"
  | "describing"
  | "ready"
  | "connected";

/** Chip ids the view dispatches on. Kept as constants so the view cannot typo one. */
export const CONNECT_CHIPS = {
  connectWallet: "connect-wallet",
  switchChain: "switch-chain",
  zapIn: "zap-in",
  compose: "compose",
  describe: "describe",
  capsule: "capsule",
  mode: "mode",
  access: "access",
  restart: "restart",
} as const;

/**
 * What a compromised agent still cannot do. Enforced by the capsule, not by this app.
 * Rendered verbatim wherever the connection is explained.
 */
export const AGENT_CANNOT: readonly string[] = [
  "Change the recipient — it is welded at initialize and has no setter.",
  "Change the amount, cadence, price condition, or output floor — all are inside your signature.",
  "Run early, run twice, or run past the end — cadence and nonce are checked onchain.",
  "Create a Zap, fund one, or move anything out of one.",
  "Sign anything as you.",
];

export function connectDialogue(input: ConnectDialogueInput): ConnectDialogue {
  const messages: TranscriptMessage[] = [];
  const push = (message: Omit<TranscriptMessage, "id">): void => {
    messages.push({ ...message, id: transcriptId("connect", messages.length) });
  };

  // --- Stage 0: no wallet -------------------------------------------------
  if (!input.account) {
    push({
      role: "agent",
      body: {
        kind: "text",
        text: input.providerAvailable
          ? "Connect a wallet and I will read your capsules. I cannot sign anything — signing is always your wallet, in your hands."
          : "No wallet is available in this browser. Install one to read your capsules; nothing on this screen ever needs your keys.",
      },
    });
    return {
      messages,
      composer: input.providerAvailable
        ? { mode: "chips", chips: [chip(CONNECT_CHIPS.connectWallet, "Connect wallet")] }
        : { mode: "none" },
      status: "idle",
      stage: "no-wallet",
    };
  }

  // --- Stage 0b: wrong chain ---------------------------------------------
  if (!input.isRobinhoodChain) {
    push({
      role: "capsule",
      body: { kind: "facts", rows: [{ key: "wallet", label: "wallet", value: shortAddress(input.account) }] },
    });
    push({
      role: "agent",
      body: { kind: "text", text: "Your wallet is on another chain. Capsules live on Robinhood Chain 4663." },
    });
    return {
      messages,
      composer: { mode: "chips", chips: [chip(CONNECT_CHIPS.switchChain, "Switch to Robinhood Chain")] },
      status: "idle",
      stage: "wrong-chain",
    };
  }

  if (input.loading) {
    push({ role: "agent", body: { kind: "text", text: "Reading your capsules…" } });
    return { messages, composer: { mode: "none" }, status: "thinking", stage: "loading" };
  }

  // --- Describe-it-in-words -----------------------------------------------
  // Sits above the capsule ladder because it answers a different question:
  // "what should this Zap be", not "which existing one may the agent run".
  if (input.selection.describing) {
    push({
      role: "agent",
      body: {
        kind: "text",
        text: "Describe what you want the Zap to do. I propose a design; the compiler decides whether it is legal, and shows you what it refuses.",
      },
    });

    if (input.proposal) {
      push({ role: "agent", body: { kind: "text", text: input.proposal.rationale } });
      // The plan is `capsule`, not `agent`: every number in it was computed by
      // the compiler, and the two voices must not be confusable.
      push({ role: "capsule", body: { kind: "plan", plan: input.proposal.plan } });
    } else if (input.refusal) {
      push({
        role: "capsule",
        tone: "verbatim",
        body: { kind: "refusal", reason: input.refusal.reason, refuses: input.refusal.issues },
      });
    }

    return {
      messages,
      composer: {
        mode: "text",
        placeholder: "e.g. buy 0xZAPS every day for a month, stop if it drops 20%",
        maxLength: 400,
        busy: input.composing === true,
        chips: [chip(CONNECT_CHIPS.restart, "Back")],
      },
      status: input.composing ? "compiling" : "idle",
      stage: "describing",
    };
  }

  // --- Stage 1: wallet, no capsules --------------------------------------
  if (input.capsules.length === 0) {
    push({
      role: "capsule",
      body: {
        kind: "facts",
        rows: [
          { key: "wallet", label: "wallet", value: shortAddress(input.account) },
          { key: "chain", label: "chain", value: "Robinhood Chain 4663" },
          { key: "capsules", label: "capsules", value: "0" },
        ],
      },
    });
    push({
      role: "agent",
      body: {
        kind: "text",
        text: "An agent needs a capsule to hold the trigger of. Make one first — the capsule is what bounds everything the agent could ever do.",
      },
    });
    return {
      messages,
      composer: {
        mode: "chips",
        chips: [
          chip(CONNECT_CHIPS.zapIn, "Zap in to 0xZAPS"),
          chip(CONNECT_CHIPS.compose, "Compose one"),
          // Hidden rather than broken when no model is configured.
          ...(input.agentConfigured
            ? [chip(CONNECT_CHIPS.describe, "Describe what you want", "Say it in words; the compiler judges it.")]
            : []),
        ],
      },
      status: "idle",
      stage: "no-capsules",
    };
  }

  // --- Stage 4: already connected ----------------------------------------
  // "Connected" means an executor is pinned. `resolveAgentConnection` is the one
  // place that decides what that means, so this asks it rather than comparing
  // address strings itself.
  const pinned = input.authorizations.filter((authorization) => {
    if (!authorization.intent) return false;
    return resolveAgentConnection(authorization.intent.executor, input.account as Address).state === "pinned";
  });
  if (pinned.length > 0 && !input.selection.zap) {
    for (const message of narrateAgents({
      owner: input.account,
      authorizations: input.authorizations,
      activity: [],
      aliases: input.aliases,
      explorerTx: input.explorerTx,
    })) {
      push({ role: message.role, body: message.body, at: message.at, tone: message.tone, evidence: message.evidence });
    }
    push({
      role: "agent",
      body: { kind: "text", text: "Connect another capsule, or change who may submit an existing one." },
    });
    return {
      messages,
      composer: { mode: "chips", chips: capsuleChips(input.capsules) },
      status: "idle",
      stage: "connected",
    };
  }

  // --- Stage 2: pick a capsule -------------------------------------------
  push({
    role: "capsule",
    body: {
      kind: "facts",
      rows: [
        { key: "wallet", label: "wallet", value: shortAddress(input.account) },
        { key: "capsules", label: "capsules", value: String(input.capsules.length) },
        { key: "signed", label: "authorizations", value: String(input.authorizations.length) },
      ],
    },
  });

  if (!input.selection.zap) {
    push({
      role: "agent",
      body: { kind: "text", text: "Pick the capsule the agent may trigger. Its bounds are already frozen onchain." },
    });
    return {
      messages,
      composer: {
        mode: "chips",
        chips: [
          ...capsuleChips(input.capsules),
          ...(input.agentConfigured
            ? [chip(CONNECT_CHIPS.describe, "Or describe a new one", "Say it in words; the compiler judges it.")]
            : []),
        ],
      },
      status: "idle",
      stage: "choose-capsule",
    };
  }

  const zap = getAddress(input.selection.zap);
  push({ role: "you", body: { kind: "text", text: `Use ${shortAddress(zap)}.` } });
  push({
    role: "capsule",
    body: { kind: "facts", rows: capsuleFacts(zap, input.account, input.capsules) },
  });

  // --- Stage 2b: what may it decide? -------------------------------------
  if (!input.selection.mode) {
    push({
      role: "agent",
      body: { kind: "text", text: "What may the agent decide? Only the timing — never the terms." },
    });
    return {
      messages,
      composer: {
        mode: "chips",
        chips: [
          chip(`${CONNECT_CHIPS.mode}:recurring`, "Cadence", "A fixed amount on a schedule you sign."),
          chip(`${CONNECT_CHIPS.mode}:trigger`, "Price move", "Fires once after a one-sided move you sign."),
          chip(`${CONNECT_CHIPS.mode}:both`, "Both at once", "Ask me why this one is refused."),
        ],
      },
      status: "idle",
      stage: "choose-mode",
    };
  }

  push({
    role: "you",
    body: { kind: "text", text: input.selection.mode === "recurring" ? "Cadence." : "Price move." },
  });

  // --- Stage 2c: who may submit? -----------------------------------------
  if (!input.selection.access) {
    push({
      role: "agent",
      body: {
        kind: "text",
        text: "Who may submit the runs? This decides who races for the fee — not what a submitter is allowed to do.",
      },
    });
    return {
      messages,
      composer: {
        mode: "chips",
        chips: [
          chip(`${CONNECT_CHIPS.access}:anyone`, "Anyone", "Executors compete. Fastest wins the 80% fee share."),
          chip(`${CONNECT_CHIPS.access}:owner-only`, "Owner only", "You submit every run yourself. No agent may."),
          chip(
            `${CONNECT_CHIPS.access}:pinned`,
            input.proposedAgent ? `Pin ${shortAddress(input.proposedAgent)}` : "Pin one agent",
            "Only that address may submit. If it stops, the series stalls until you submit.",
          ),
        ],
      },
      status: "idle",
      stage: "choose-access",
    };
  }

  // --- Stage 3: terminal ---------------------------------------------------
  push({ role: "you", body: { kind: "text", text: accessLabel(input.selection.access, input.proposedAgent) } });
  push({
    role: "capsule",
    body: {
      kind: "facts",
      rows: terminalFacts(input.selection, input.proposedAgent, input.account, zap),
    },
  });
  push({
    role: "capsule",
    tone: "verbatim",
    body: {
      kind: "refusal",
      reason: "Whatever you pin, the capsule still refuses all of this:",
      refuses: [...AGENT_CANNOT],
    },
  });
  push({
    role: "agent",
    body: {
      kind: "text",
      text:
        input.selection.access === "pinned" && !input.proposedAgent
          ? "Point your AI client at the MCP server, ask it for its executor address, then sign with that address pinned. The signature is the connection — there is nothing else to exchange."
          : "Sign the authorization in your wallet. Its executor field is the connection; nothing is stored here.",
    },
  });

  return {
    messages,
    composer: {
      mode: "chips",
      chips: [chip(CONNECT_CHIPS.restart, "Start over")],
    },
    status: "idle",
    stage: "ready",
    // Pinning needs an address, and we do not have one yet. Offering "Sign the
    // authorization" here would land the person on a form pre-selected to
    // "Anyone may submit" — the exact opposite of what they just chose — and a
    // signature made without noticing produces an open authorization.
    handoffReady: !(input.selection.access === "pinned" && !input.proposedAgent),
  };
}

/**
 * The automate handoff URL.
 *
 * Every param here is one `readAutomationHandoff` already validates on arrival, so a malformed
 * link fails closed into the console's own defaults rather than seeding a bad form.
 */
export function connectHandoff(selection: ConnectSelection, agent: Address | null): string {
  const params = new URLSearchParams();
  params.set("view", "automate");
  params.set("src", "build");
  params.set("mode", selection.mode ?? "recurring");
  params.set("route", "robinhood-v4-weth-zaps");
  params.set("amount", "0.01");
  params.set("bps", "100");
  if (selection.mode === "trigger") {
    params.set("threshold", "up10");
    params.set("days", "30");
  } else {
    params.set("interval", "daily");
    params.set("runs", "10");
  }
  writeExecutionPolicyParams(params, {
    ...DEFAULT_EXECUTION_POLICY,
    executorAccess: selection.access === "owner-only" ? "owner-only" : "anyone",
  });
  // `agent` is the connect surface's own param, read only to prefill the
  // console's existing "Pinned" field. It carries no authority on its own.
  if (selection.access === "pinned" && agent) params.set("agent", getAddress(agent));
  return `/zap?${params.toString()}`;
}

// ---------------------------------------------------------------------------

function chip(id: string, label: string, hint?: string): TranscriptChip {
  return { id, label, hint, value: id };
}

function capsuleChips(capsules: readonly ConnectCapsule[]): TranscriptChip[] {
  return capsules.slice(0, 8).map((capsule) =>
    chip(
      `${CONNECT_CHIPS.capsule}:${capsule.address}`,
      shortAddress(capsule.address),
      `${capsule.lineage} · ${capsule.automatedRunCount} automated ${capsule.automatedRunCount === 1 ? "run" : "runs"}`,
    ),
  );
}

function capsuleFacts(zap: Address, owner: Address, capsules: readonly ConnectCapsule[]): TranscriptFactRow[] {
  const capsule = capsules.find((entry) => entry.address.toLowerCase() === zap.toLowerCase());
  return [
    { key: "capsule", label: "capsule", value: zap },
    { key: "lineage", label: "lineage", value: capsule?.lineage ?? "unknown" },
    // The bound that makes any of this safe. Read off the capsule, not assumed.
    { key: "recipient", label: "pays out to", value: `${shortAddress(owner)} — welded at initialize` },
    { key: "runs", label: "automated runs", value: String(capsule?.automatedRunCount ?? 0) },
  ];
}

function terminalFacts(
  selection: ConnectSelection,
  agent: Address | null,
  owner: Address,
  zap: Address,
): TranscriptFactRow[] {
  return [
    { key: "capsule", label: "capsule", value: shortAddress(zap) },
    { key: "decides", label: "agent decides", value: selection.mode === "trigger" ? "when the price condition is met" : "when the cadence has elapsed" },
    {
      key: "submitter",
      label: "may submit",
      value:
        selection.access === "owner-only"
          ? `${shortAddress(owner)} only — no agent`
          : selection.access === "pinned"
            ? agent
              ? `${agent} only`
              : "one agent address you name at signing"
            : "anyone — executors compete for the 80% fee share",
    },
    { key: "stored", label: "stored here", value: "Nothing. The executor field of your signature is the connection." },
  ];
}

function accessLabel(access: ConnectAccess, agent: Address | null): string {
  if (access === "owner-only") return "Owner only.";
  if (access === "anyone") return "Anyone may submit.";
  return agent ? `Pin ${shortAddress(agent)}.` : "Pin one agent.";
}

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

