import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

import {
  agentAlias,
  connectedAgent,
  resolveAgentConnection,
  type AgentAliases,
  type AgentConnection,
} from "@/lib/agent-connection";
import type { ParsedAutomationIntent } from "@/lib/automation-records";
import type { AutomationLifecycleView } from "@/lib/automation-status";
import type { WalletActivityEntry } from "@/lib/profile";
import { transcriptId, type TranscriptFactRow, type TranscriptMessage } from "@/lib/transcript";

/**
 * Turn signed authorizations and confirmed chain events into a transcript.
 *
 * Deterministic on purpose: no model runs here, nothing is inferred, and an
 * absent field produces no message rather than a hedge. The reason is that this
 * transcript sits next to model-authored text elsewhere in the app, and the
 * only thing keeping the two distinguishable is that these sentences can be
 * traced to a field.
 *
 * It is also agent-centric, not authorization-centric — the profile already has
 * a per-authorization table directly above it. The question this answers is the
 * one that table cannot: WHO can act for you, and what did they actually do.
 */

export interface NarrativeAuthorization {
  /** `automationIntentKey()` — stable per immutable authorization. */
  key: string;
  zap: Address;
  /** Null when a capsule exists locally but no signed artifact was found. */
  intent: ParsedAutomationIntent | null;
  state: AutomationLifecycleView;
}

export interface NarrativeInput {
  owner: Address;
  authorizations: readonly NarrativeAuthorization[];
  /** Confirmed chain events for this wallet. `automated` rows carry the real submitter. */
  activity: readonly WalletActivityEntry[];
  aliases?: AgentAliases;
  explorerTx: (hash: Hex) => string;
  /** Runs shown per agent before the tail is summarized. */
  runLimit?: number;
}

const DEFAULT_RUN_LIMIT = 4;

export function narrateAgents(input: NarrativeInput): TranscriptMessage[] {
  const { owner, authorizations, activity, aliases = {}, explorerTx } = input;
  const runLimit = input.runLimit ?? DEFAULT_RUN_LIMIT;
  const groups = groupByAgent(authorizations, owner);
  const messages: TranscriptMessage[] = [];
  const push = (message: Omit<TranscriptMessage, "id">): void => {
    messages.push({ ...message, id: transcriptId("agents", messages.length) });
  };

  if (groups.length === 0) {
    push({
      role: "agent",
      body: {
        kind: "text",
        text: "No signed authorization names a submitter yet. Connect an agent and it can hold the trigger — never the authority.",
      },
    });
    return messages;
  }

  push({ role: "agent", body: { kind: "text", text: lead(groups) } });

  for (const group of groups) {
    push({ role: "capsule", body: { kind: "facts", rows: groupFacts(group, aliases) } });

    const runs = runsFor(group, activity);
    for (const run of runs.slice(0, runLimit)) {
      push({
        role: "chain",
        at: isoFromSeconds(run.timestamp),
        body: { kind: "text", text: describeRun(run) },
        evidence: { label: "receipt", href: explorerTx(run.txHash) },
      });
    }
    if (runs.length > runLimit) {
      push({
        role: "chain",
        body: { kind: "text", text: `${runs.length - runLimit} earlier ${plural(runs.length - runLimit, "run")} not shown.` },
      });
    }

    // Exactly one forward-looking sentence per agent, always last in its block.
    push({ role: "capsule", body: { kind: "text", text: forwardLook(group) } });

    // Runs an OPEN authorization drew from addresses the owner never named.
    // Not a warning — this is what "anyone may submit" means, made visible.
    if (group.connection.state === "open") {
      const submitters = distinctSubmitters(runs, owner);
      if (submitters.length > 0) {
        push({
          role: "chain",
          body: {
            kind: "text",
            text: `${submitters.length} ${plural(submitters.length, "address", "addresses")} submitted these runs: ${submitters
              .map(shortAddress)
              .join(", ")}. An open authorization lets any of them race for the fee.`,
          },
        });
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------

interface AgentGroup {
  connection: AgentConnection;
  agent: Address | null;
  authorizations: NarrativeAuthorization[];
  zaps: Address[];
}

/**
 * Group by who may submit. Pinned agents lead because they are the only case
 * where something other than the owner holds a trigger; `self` and `open` are
 * states of the world, not connections, and burying them under a pinned agent
 * would misrepresent the order of interest.
 */
function groupByAgent(authorizations: readonly NarrativeAuthorization[], owner: Address): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();

  for (const authorization of authorizations) {
    if (!authorization.intent) continue; // No signed artifact: nothing to say about a submitter.
    const connection = resolveAgentConnection(authorization.intent.executor, owner);
    const agent = connectedAgent(connection);
    const key = agent ? `${connection.state}:${agent.toLowerCase()}` : connection.state;
    const current = groups.get(key);

    if (!current) {
      groups.set(key, { connection, agent, authorizations: [authorization], zaps: [authorization.zap] });
      continue;
    }
    current.authorizations.push(authorization);
    if (!current.zaps.some((zap) => isAddressEqual(zap, authorization.zap))) current.zaps.push(authorization.zap);
  }

  return [...groups.values()].sort((a, b) => rank(a.connection) - rank(b.connection));
}

function rank(connection: AgentConnection): number {
  return connection.state === "pinned" ? 0 : connection.state === "self" ? 1 : 2;
}

function lead(groups: readonly AgentGroup[]): string {
  const pinned = groups.filter((group) => group.connection.state === "pinned");
  if (pinned.length === 0) {
    return "No agent is pinned. Every authorization here is submitted by you, or open to any executor.";
  }
  const capsules = new Set(pinned.flatMap((group) => group.zaps.map((zap) => zap.toLowerCase())));
  return `${pinned.length} ${plural(pinned.length, "agent")} can submit runs for you, across ${capsules.size} ${plural(
    capsules.size,
    "capsule",
  )}. Each one holds a trigger the capsule already bounded.`;
}

function groupFacts(group: AgentGroup, aliases: AgentAliases): TranscriptFactRow[] {
  const rows: TranscriptFactRow[] = [];
  const { connection, agent } = group;

  if (connection.state === "open") {
    rows.push({ key: "who", label: "submitter", value: "Anyone — no executor pinned" });
  } else if (connection.state === "self") {
    rows.push({ key: "who", label: "submitter", value: "You only — no agent may submit" });
  } else if (agent) {
    const alias = agentAlias(aliases, agent);
    rows.push({ key: "who", label: "agent", value: alias ? `${alias} · ${shortAddress(agent)}` : agent });
  }

  rows.push({
    key: "scope",
    label: "may run",
    value: `${group.authorizations.length} ${plural(group.authorizations.length, "authorization")} on ${
      group.zaps.length
    } ${plural(group.zaps.length, "capsule")}`,
  });

  // The bound that makes the connection safe to make at all. Stated as a fact
  // row, not prose, because it is read off the signed intent.
  const recipients = distinct(group.authorizations.map((a) => a.intent?.recipient).filter(isAddress));
  if (recipients.length === 1) {
    rows.push({ key: "recipient", label: "pays out to", value: `${shortAddress(recipients[0])} — welded before signing` });
  } else if (recipients.length > 1) {
    rows.push({ key: "recipient", label: "pays out to", value: `${recipients.length} recipients, each welded before signing` });
  }

  rows.push({ key: "cannot", label: "cannot", value: CANNOT });
  return rows;
}

/**
 * What a compromised agent still cannot do. Every clause is enforced by the
 * capsule, not by this app — see OpenZapV3.sol's cadence, nonce, recipient and
 * minOut checks.
 */
const CANNOT = "Change the recipient, amount, schedule, or floor · run early, twice, or past the end · create, fund, or drain";

function runsFor(group: AgentGroup, activity: readonly WalletActivityEntry[]): WalletActivityEntry[] {
  const ids = new Set(
    group.authorizations
      .map((authorization) => authorization.intent?.authorizationId.toString())
      .filter((id): id is string => id !== undefined),
  );
  return activity.filter(
    (entry) => entry.kind === "automated" && entry.authorizationId !== null && ids.has(entry.authorizationId),
  );
}

function describeRun(entry: WalletActivityEntry): string {
  const run = entry.run !== null ? `Run ${entry.run}` : "A run";
  const amount = entry.amount !== null && entry.assetSymbol !== null ? ` — ${entry.amount} ${entry.assetSymbol}` : "";
  const by = entry.actor ? ` submitted by ${shortAddress(entry.actor)}` : "";
  return `${run} executed${amount}${by}.`;
}

/**
 * One sentence about what happens next, in one of four forms. There is no
 * fifth: anything this cannot derive becomes the "cannot be computed" form
 * rather than a guess.
 */
function forwardLook(group: AgentGroup): string {
  const states = group.authorizations.map((authorization) => authorization.state.lifecycle);
  const ready = states.filter((state) => state === "due" || state === "armed").length;
  if (ready > 0) {
    return `${ready} ${plural(ready, "authorization")} may be submitted now.`;
  }

  const pending = states.filter((state) => state === "waiting" || state === "scheduled").length;
  if (pending > 0) {
    return `Nothing is due. ${pending} ${plural(pending, "authorization")} still waiting on cadence or price.`;
  }

  if (states.every((state) => TERMINAL.has(state))) {
    return `Nothing more will happen here: every authorization is ${listTerminal(states)}.`;
  }

  return "The next run cannot be computed from what is onchain right now.";
}

const TERMINAL = new Set(["completed", "revoked", "consumed", "expired"]);

function listTerminal(states: readonly string[]): string {
  const unique = distinct(states);
  if (unique.length === 1) return unique[0];
  return `${unique.slice(0, -1).join(", ")} or ${unique[unique.length - 1]}`;
}

function distinctSubmitters(runs: readonly WalletActivityEntry[], owner: Address): Address[] {
  const seen = new Map<string, Address>();
  for (const run of runs) {
    if (!run.actor || isAddressEqual(run.actor, owner)) continue;
    seen.set(run.actor.toLowerCase(), getAddress(run.actor));
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------

function isAddress(value: Address | undefined): value is Address {
  return value !== undefined;
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

function isoFromSeconds(timestamp: number | null): string | undefined {
  if (timestamp === null || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp * 1000).toISOString();
}
