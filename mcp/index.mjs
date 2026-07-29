#!/usr/bin/env node
// OpenZaps MCP server — read access to capsules, authorizations, and simulations for any MCP client.
//
// Run it as a stdio server (the normal case, from an AI client's config):
//
//   node mcp/index.mjs
//
// Or ask it who it is, without a client:
//
//   node mcp/index.mjs identity
//   node mcp/index.mjs tools
import { buildContext } from "./config.mjs";
import { logStderr, serve, stringify } from "./rpc.mjs";
import { assertNoBroadcastTools, TOOLS } from "./tools.mjs";

/**
 * What the MODEL is told on connect.
 *
 * This is the most important string in the server. The code cannot sign or broadcast, but a model
 * that does not know that will invent workarounds — asking a human for a private key, or claiming a
 * run happened when it only simulated. Stating the limits plainly is cheaper than every downstream
 * correction.
 */
const INSTRUCTIONS = `This server reads OpenZaps state on Robinhood Chain (4663) and can hand an ALREADY-SIGNED
intent to a relay or a local executor. It holds no private key and cannot sign, broadcast, create,
fund, revoke, or drain anything.

Execution authority comes from exactly one thing: an EIP-712 signature the capsule owner produces in
their own wallet. An agent is "connected" to a Zap when the owner signed an intent naming that
agent's address in the intent's executor field — the capsule itself reverts ExecutorMismatch for
anyone else. OPENZAPS_AGENT_ADDRESS is a public identifier, never a credential. Discovery or intake
credentials cannot replace the owner's signature and cannot widen its terms.

list_intents and list_connections return relay-listed discovery rows, not proof of chain-current
authority. Preserve their source/chainVerified/statusBasis/stalePossible metadata, and check the
capsule onchain before claiming an authorization is still executable.

Consequences worth stating to a human who asks:
- A compromised agent can submit a run the capsule already owes, or refuse to submit one. It cannot
  change the recipient, amount, schedule, or floor, and cannot run early, twice, or past the end.
- Pinning an agent is a liveness trade: if the pinned agent stops, that series stalls until the
  owner submits it themselves or signs new terms.
- Pinning is public. It is in the signed intent and in the chain's logs.

If a task needs a signature, call draft_intent and give the human the returned link. Never ask for a
private key or seed phrase; refuse if one is offered. When a run reverts, call explain_error rather
than guessing what the revert meant. Do not report a run as executed unless you have a transaction
hash — simulate_run returning "watch-only" means the simulation passed, not that anything happened.`;

const SERVER_INFO = { name: "openzaps", version: "0.1.0" };

async function main() {
  assertNoBroadcastTools();
  const command = process.argv[2];

  if (command === "identity") {
    const ctx = await buildContext();
    const tool = TOOLS.find((entry) => entry.name === "agent_identity");
    process.stdout.write(`${stringify(await tool.handler({}, ctx))}\n`);
    return;
  }

  if (command === "tools") {
    process.stdout.write(
      `${stringify(TOOLS.map(({ name, safety, description }) => ({ name, safety, description })))}\n`,
    );
    return;
  }

  if (command && command !== "serve") {
    process.stderr.write(`Usage: node mcp/index.mjs [serve|identity|tools]\n`);
    process.exitCode = 2;
    return;
  }

  logStderr(`serving ${TOOLS.length} tools over stdio`);
  await serve({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    // Lazy: a missing RPC or malformed local config should fail one call with a
    // readable message, not prevent the server from starting at all.
    context: buildContext,
  });
}

main().catch((error) => {
  logStderr(`fatal: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
