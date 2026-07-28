# OpenZaps MCP server

Read access to Zap capsules, standing authorizations, and simulations for any MCP client — Claude
Desktop, Claude Code, or anything else that speaks the protocol.

It holds no private key. It cannot sign, broadcast, create, fund, revoke, or drain anything. That is
not a policy this code enforces with care; it is what the code is unable to do. See
[ADR-0006](../docs/adr/0006-agent-connection-and-mcp-surface.md) for why the design is shaped this
way.

## Install

No build step and no dependencies of its own — it runs from this repo and reuses the executor's
modules. Add it to your MCP client's config:

```json
{
  "mcpServers": {
    "openzaps": {
      "command": "node",
      "args": ["/absolute/path/to/openzaps/mcp/index.mjs"]
    }
  }
}
```

Two commands work without a client, for checking your setup:

```sh
node mcp/index.mjs identity   # this agent's executor address, or read-only
node mcp/index.mjs tools      # the tool table with safety classes
```

## Connecting an agent to a Zap

There is no pairing artifact and nothing to exchange. An agent is connected to a Zap when the
owner has signed a standing intent naming that agent's address in `executor` — the capsule itself
reverts `ExecutorMismatch` for anyone else.

1. Ask the agent for its address (`agent_identity`), or run `node mcp/index.mjs identity`.
2. Open `/zap?view=connect`, pick the capsule, and choose **Pin one agent**.
3. Paste the address and sign. The signature is the connection.

**Revoking** has three levels: stop the agent or rotate its key (the series stalls — safe, no
transaction); `invalidateNonce(seriesId)` (one owner-only transaction); or sign fresh terms under a
new series id.

**Pinning is public.** The executor address is inside the signed intent and in the chain's logs.

## Tools

Every tool declares a safety class, and the class is part of what the model reads.

### `read-only` — changes nothing, anywhere

| Tool | What it answers |
|---|---|
| `agent_identity` | What is this agent's executor address, if any? |
| `list_zaps` | What capsules did this wallet create? |
| `read_zap` | Everything about one capsule, including every invariant that does *not* hold. |
| `explain_policy` | In plain language: what can this capsule do, and what can it never do? |
| `list_intents` | Which standing authorizations exist, filtered by owner/capsule/executor? |
| `read_intent` | The full signed terms of one authorization. |
| `check_intent_status` | Is this run due, waiting, finished, or expired right now? |
| `simulate_run` | Would the capsule accept a run right now — and if not, which guard refuses? |
| `list_connections` | What is a given agent address allowed to submit? |
| `draft_intent` | An **unsigned** draft plus the link a human opens to review and sign it. |
| `explain_error` | What did that revert mean, and is it worth retrying? |

### `publish` — moves an artifact the owner already signed; cannot create authority

| Tool | What it does |
|---|---|
| `publish_intent` | Puts a signed authorization on the shared relay so executors can find it. |
| `deliver_intent_local` | Hands a signed authorization to the executor on this machine. |

Both reject anything unsigned at the same schema gate the daemon applies to a dropped file, and the
relay re-verifies the signature against the capsule's onchain owner regardless.

### There is no third class

No `submit_run`, no `create_zap`, no `fund_zap`, no `revoke`. An agent that submits runs does so by
*being* [`executor/index.mjs`](../executor/README.md) with its own gas key — a process you start
deliberately — not by this server holding one. Revocation is `onlyOwner`, so it stays a wallet
action.

`simulate_run` calls the executor's own `submitExecution` with a `null` wallet client. That `null`
is the guarantee: the broadcast branch is unreachable without a signer, so the tool is *unable* to
send a transaction rather than merely instructed not to.

## Configuration

All of it optional, and all shared with the executor daemon ([`executor/config.mjs`](../executor/config.mjs)):

| Variable | Default | Purpose |
|---|---|---|
| `OPENZAPS_APP_URL` | `https://www.0xzaps.com` | Where the read APIs live. Point at a dev server to work against a branch. |
| `OPENZAPS_RPC_URL` / `OPENZAPS_RPC_URLS` | Robinhood Chain mainnet | Chain reads. |
| `OPENZAPS_EXECUTOR_KEYFILE` | — | Only used to *derive an address* for `agent_identity`. Never used to sign. |

Without a key the server reports `mode: "read-only"` and has no address to pin — the honest state for
an agent that is not set up to submit anything.

## Safety notes

- **The intake token never enters your context.** `deliver_intent_local` reads it off a chmod-600
  file in-process. This is strictly better than the browser flow it replaces, where a user pasted a
  local capability into a public HTTPS origin.
- **Never give this server, or any agent, a private key or seed phrase.** It has no use for one and
  the `initialize` instructions tell the model to refuse if offered.
- **`simulate_run` returning `watch-only` means the simulation passed** — not that anything
  happened. Do not report a run as executed without a transaction hash.
- **No unbounded chain-read string may reach a tool result.** Relay fields are regex-bounded and
  symbols come from fixed tables; keep it that way, or a capsule could inject text into a model's
  context.
