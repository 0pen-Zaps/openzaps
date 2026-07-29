# ADR-0006: An agent connection is an executor pin, not a credential

- **Status:** Accepted
- **Date:** 2026-07-27
- **Decision owners:** OpenZaps maintainers

## Context

The product needs a way for a person to hand a Zap to an AI agent — Claude Desktop, Claude Code, a
custom bot — so the agent can watch a capsule and submit its runs. Every obvious framing of that
request reaches for a credential: an API key, an OAuth grant, a session key, a scoped token.

The capsule does not work that way. Onchain, an agent's authority over a standing authorization is
exactly one field of the owner's EIP-712 signature:

```solidity
if (intent.executor != address(0) && msg.sender != intent.executor) revert ExecutorMismatch();
```

`OpenZapV3.sol:307` and `:349`; `OpenZapV3_1.sol:348`, `:397`, and `:482`. `address(0)` means any
submitter may fire a run the capsule owes; a named address means only that address may. There is no
registry contract, no session-key module, no delegation, and no permit — and adding one would mean a
new lineage with new domains, which ADR-0005 already established we do not do for a feature that can
be expressed inside the existing signature.

So a credential we invented could gate discovery and delivery. It could never gate execution. The
risk of shipping one anyway is not that it fails — it is that it *looks* like authority, and a user
who revokes it will believe they have stopped something they have not.

Three delivery paths already existed and all three predate this work: the hosted relay
(`POST /api/intents`, owner-signature verified, deliberately unauthenticated), the executor's
localhost intake listener (`executor/intake.mjs`, bearer token, 127.0.0.1-bound), and a file drop
into `~/.openzaps/executor/intents/`.

## Decision

**An agent is connected to a Zap when, and only when, the owner has signed a standing intent naming
that agent's address in `executor`.** There is no other connection artifact.

Four consequences follow, and each is implemented as stated:

1. **Connection state is derived, never stored.** `src/lib/agent-connection.ts` reads it out of the
   signed intents the app already holds. There is no `zap_agents` table. A stored claim would need
   its own write authentication to be worth anything, and would still be the least trustworthy
   assertion in the product — a row the chain can contradict.

2. **The MCP server holds no key and cannot broadcast.** `mcp/` exposes two safety classes:
   `read-only` (changes nothing anywhere) and `publish` (moves an artifact the owner already
   signed). There is deliberately no third class. Simulation calls
   `submitExecution(publicClient, null, item, cfg)` — the `null` signer makes the broadcast branch
   structurally unreachable rather than merely unvisited. An agent that submits runs does so by
   *being* `executor/index.mjs` with its own gas key: a separate process the user starts
   deliberately. The publishable `@openzaps/mcp` surface is stricter still: discovery and
   block-pinned simulation only. Discovery reads public chain data, and `OPENZAPS_AGENT_ADDRESS` is
   an optional public identifier; neither process reads an executor key to derive identity.

3. **The intake token never crosses an origin boundary.** The local MCP server reads it off its
   chmod-600 file in-process, so it is never returned in a tool result and never enters a model's
   context. This began as a path *alongside* the browser flow; it is now the only one.
   `AutomateConsole.tsx` used to have the user paste that local capability into a public HTTPS
   origin, where it lived in `sessionStorage` within reach of any XSS on the page — the code's own
   comment conceded this. That flow, its `POST` with an `Authorization: Bearer` header, and the
   `127.0.0.1:8477` health probe that revealed it are all gone; the console now points at
   `deliver_intent_local` instead. The browser's remaining delivery options carry no capability:
   publish to the relay, or download the signed JSON and drop it in
   `~/.openzaps/executor/intents/`.

4. **Revocation has three levels, and the UI names all three.** *Soft*: stop the agent or rotate its
   key; a pinned series stalls, which is the safe failure and costs no transaction. *Hard*:
   `invalidateNonce(seriesId)`, one owner-only transaction. *Re-pair*: sign a fresh intent under a
   new `seriesId`; reusing a spent id reverts `NonceReplay`.

**Where a model is involved, it proposes and deterministic code disposes.** `/api/agent/compose`
constrains the model to emitting catalog block ids, then round-trips that output through
`decodeChain(encodeChain(...))` — the same hardening an untrusted `?d=` share link gets — before
`compileChain` decides whether it is legal. `/api/agent/ask` shows the model a whitelisted fact
projection that excludes the capsule's frozen calldata, requires it to cite the fact keys its answer
rests on, and re-reads those values from the payload rather than trusting the prose.

## Consequences

**The blast radius of a fully compromised agent is stated exactly, and it is small.** It can submit a
run the capsule already owes and collect the 80% executor share, or withhold submission and stall a
pinned series. It cannot change the recipient (welded at `initialize`, no setter), the amount,
cadence, floor, or out-asset (all inside the signature); cannot run early, twice, or past the end
(cadence and nonce are checked onchain); cannot create, fund, or drain a capsule; and cannot sign as
the owner. This is the feature, not a caveat about it.

**Pinning is public and the UI says so.** The executor is in the signed intent and in the chain's
logs. `GET /api/intents?executor=` makes the agent ↔ owner link queryable, which is a disclosure
inherent to the design rather than one this change introduces.

**Pinning trades liveness for exclusivity.** A pinned agent going offline stalls that series until
the owner submits it themselves or signs new terms. The open executor (`address(0)`) remains the
liveness-maximizing default.

**Prompt injection is bounded by an invariant that must be preserved.** Every relay `intent` field is
regex-bounded by `parseRelaySubmission`, and asset symbols come from the fixed `ROBINHOOD_ASSETS`
tables rather than chain-read strings. **No unbounded chain-read string may reach an MCP tool
result.** A future `name()`/`symbol()` read must be length-capped and escaped before it enters one.

**One-shot Zaps cannot be connected.** `OpenZapV3.sol:258-289`'s `execute()` path takes an
`OpenZapIntent` whose `relayer` field is a fee recipient, not an executor gate. Only the three
standing kinds — `recurring`, `recurring-relative`, `trigger` — carry a pin, and the connect surface
must not imply otherwise.

**The relay's GET is now rate-limited.** It was the only unauthenticated path with no limiter, and it
is the endpoint an agent polls hardest. Fixed here because this change is what makes it hot.

## Alternatives rejected

**A scoped read-token for the relay.** It would gate discovery — the one thing the relay's design
deliberately leaves open, since executors must be able to find work. It would add an authentication
system to data that is redundant with the chain, and gate nothing that matters, because execution
authority is not the token's to give.

**A signed "agent manifest".** Nothing onchain reads a manifest. A signature over "I authorize agent
X" that no verifier consults is worse than nothing: it looks like authority. The useful half
survives as an unsigned deep link (`/zap?view=connect&agent=0x…`), which is a handoff, not a
credential.

**A hosted OpenZaps agent holding user keys.** Rejected on the same grounds as ADR-0003's
private-submission analysis: it would make us a trusted party in a system whose entire claim is that
no off-chain party needs to be trusted.

**Streaming the model's proposal to the client.** The output is a tool call that must be
re-validated before any pixel paints. Streaming a partial chain would paint a plan and then retract
it — the compiler's verdict is the whole product, and it does not exist until the model is done.
