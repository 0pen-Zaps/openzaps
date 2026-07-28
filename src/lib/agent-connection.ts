import { getAddress, isAddressEqual, type Address } from "viem";

import { OPEN_EXECUTOR } from "@/lib/automate";

/**
 * Which agent — if any — a capsule's authorization is connected to.
 *
 * There is no registry, no session key, no credential. Onchain, an agent's
 * authority is exactly one field:
 *
 *     if (intent.executor != address(0) && msg.sender != intent.executor)
 *         revert ExecutorMismatch();
 *
 * (OpenZapV3.sol:307,349 — OpenZapV3_1.sol:348,397,482)
 *
 * That field is covered by the owner's EIP-712 signature. So a connection is
 * not a row we store and hope stays true; it is a fact the signature already
 * carries and the capsule already enforces. Everything in this module is a
 * READING of that field, never a claim about it.
 *
 * The practical consequence is worth stating where people will read it: a
 * fully compromised agent can submit a run the capsule already owes, or refuse
 * to submit one. It cannot change the recipient, amount, schedule, floor, or
 * out-asset, and it cannot run early, run twice, or drain anything.
 */
export type AgentConnection =
  /** No executor pinned. Anyone may submit; executors race for the fee. */
  | { state: "open" }
  /** Pinned to the owner. Nobody else may submit — including any agent. */
  | { state: "self"; agent: Address }
  /** Pinned to one named address that is not the owner. */
  | { state: "pinned"; agent: Address };

/**
 * Read the connection out of a signed intent's executor field.
 *
 * `self` is split out from `pinned` because they mean opposite things to a
 * user: "owner only" is a decision to submit by hand, and rendering it as
 * "connected to 0x7099…" would suggest an agent exists where none does.
 */
export function resolveAgentConnection(executor: Address, owner: Address): AgentConnection {
  if (isAddressEqual(executor, OPEN_EXECUTOR)) return { state: "open" };
  const agent = getAddress(executor);
  if (isAddressEqual(executor, owner)) return { state: "self", agent };
  return { state: "pinned", agent };
}

/** The address an agent connection names, or null when nothing is pinned. */
export function connectedAgent(connection: AgentConnection): Address | null {
  return connection.state === "open" ? null : connection.agent;
}

/**
 * Display-only labels for agent addresses ("Claude on my MacBook").
 *
 * Never load-bearing: a missing alias renders the address, and an alias can
 * never contradict the chain because nothing reads it back. Kept separate from
 * the connection itself so there is no path where a local string is mistaken
 * for authority.
 */
export const AGENT_ALIAS_STORAGE_KEY = "openzap:v1:agent-aliases";
export const MAX_AGENT_ALIASES = 32;
export const MAX_AGENT_ALIAS_LENGTH = 48;

export type AgentAliases = Readonly<Record<string, string>>;

export function agentAliasStorageKey(owner: Address): string {
  return `${AGENT_ALIAS_STORAGE_KEY}:${owner.toLowerCase()}`;
}

/** Parse a stored alias map, dropping malformed rows rather than repairing them. */
export function parseAgentAliases(raw: string | null): AgentAliases {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [address, label] of Object.entries(parsed as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_AGENT_ALIASES) break;
      if (typeof label !== "string") continue;
      const trimmed = label.trim();
      if (!trimmed || trimmed.length > MAX_AGENT_ALIAS_LENGTH) continue;
      try {
        // Normalizes AND validates: a non-address key throws and is dropped.
        out[getAddress(address).toLowerCase()] = trimmed;
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The label for an agent, or null when it has none. */
export function agentAlias(aliases: AgentAliases, agent: Address): string | null {
  return aliases[agent.toLowerCase()] ?? null;
}
