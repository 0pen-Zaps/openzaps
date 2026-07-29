# Give an Agent the Trigger, Never the Authority

**Publication:** DeFi Tutorials

**Status:** Human approval required before Substack publication

**Suggested subtitle:** How OpenZaps lets an autonomous process submit a pre-committed DeFi action without giving it a wallet or a general-purpose session key

**Suggested hero:** `docs/media/06-zap-connect.png`

**Canonical CTA:** https://www.0xzaps.com/zap?view=connect

> Disclosure: I work on OpenZaps. The contracts are live on Robinhood Chain and have not completed an external audit. Onchain actions are irreversible; use only funds you can afford to lose.

Most “agent wallets” start with the same question: how much authority should an autonomous process receive?

OpenZaps starts somewhere else. It asks whether the agent needs authority at all.

A Zap is a small contract that holds funds for one pre-committed action graph. Its target, recipient, assets, calldata and execution policy are fixed before the user signs. An agent can later submit an execution, but submission is only a trigger. The contract decides whether the submitted action is exactly the one the owner authorised.

That gives us a useful separation:

- **Creation authority** stays with the user’s wallet or Safe.
- **Execution authority** lives in the immutable Zap policy and the owner’s typed signature.
- **Submission authority** is a courier. It chooses when to present the signed action, not what the action does.

The distinction matters because a credential can leak. A session key, delegated signer or broad API token creates a second authority surface that has to be scoped, stored, monitored and revoked correctly. OpenZaps does not give an agent one.

## What “connecting” an agent actually means

For recurring and price-triggered Zaps, the owner signs an EIP-712 intent. One field can name an executor address.

If the field is the zero address, anyone may submit a run that is due. If it names an address, only that address may submit it. The contract checks the executor alongside the amount, cadence, floor, recipient and nonce.

There is no separate OpenZaps account connection, bearer credential or offchain delegation record. The signed intent is the connection.

That also means the interface cannot manufacture a stronger relationship than the chain knows about. “Connected” is derived from signed intents and confirmed events, not from a row in a profile database.

## The blast radius is deliberately small

Assume the agent is fully compromised.

For a pinned recurring series, the compromised process can:

- Submit a run the Zap already owes.
- Withhold submission and stall the series.
- Receive the executor share of the protocol fee when it submits a valid run.

It cannot:

- Change the recipient.
- Change the amount, cadence, run count or output floor.
- Substitute another adapter, asset or calldata payload.
- Run before the signed interval.
- Run the same nonce twice.
- Continue after the signed series ends.
- Create, fund or drain the Zap.
- Sign as the owner.

Those are not policy promises made by the agent service. They are conditions checked by the Zap onchain.

Pinning therefore trades liveness for exclusivity. If the named executor goes offline, the series stalls. The owner can recover by invalidating the series nonce or signing fresh terms under a new series identifier. If liveness matters more than exclusivity, the owner can use the open-executor mode instead.

## Why the MCP surface has no key

The OpenZaps MCP tools are split into two safety classes:

1. Read public chain and relay data.
2. Publish an artifact the owner already signed.

There is no tool that signs as the owner, creates a Zap or broadcasts with an owner wallet.

Simulation is structurally unable to reach the broadcast branch because it is called without a signer. Publishing an intent moves an already-signed artifact to an untrusted relay; it does not grant the relay authority. The Zap re-verifies every field when someone later submits that intent onchain.

This is an important pattern for agent-native finance: the model may propose, but deterministic code and contracts dispose.

## A practical connection flow

1. Open the [Connect view](https://www.0xzaps.com/zap?view=connect).
2. Enter the public address that will submit runs.
3. Choose a standing execution type: recurring, relative-floor recurring or a price trigger.
4. Review the recipient, asset, per-run amount, cadence or condition, run count, floor and executor address.
5. Sign the typed intent with the owner wallet.
6. Deliver the signed JSON to the shared relay, the local executor intake, or a file watched by the executor.
7. Verify the signed executor and policy details before relying on automation.

A one-shot Zap is different. Its `relayer` field identifies a fee recipient rather than an exclusive executor, so the product should not describe a one-shot action as “connected” to an agent.

## Revocation has three levels

**Soft stop:** stop the executor process or rotate its gas key. A pinned series stops being submitted, but the signed terms still exist.

**Hard revoke:** the owner sends an onchain nonce invalidation for the series. Future attempts under that series identifier fail.

**Re-pair:** the owner signs fresh terms for a new executor under a new series identifier.

Revoking an offchain login would not provide any of these guarantees, which is why OpenZaps does not pretend that a login is execution authority.

## What this design does not solve

Bounded authority does not remove smart-contract, adapter, oracle, chain, wallet or market risk. OpenZaps is live and pre-audit. A correctly bounded action can still execute into adverse market conditions within the limits the owner signed. A stalled executor can still cause a missed opportunity. A compromised owner wallet can still authorise harmful terms.

The claim is narrower and testable: an agent cannot widen a Zap beyond the policy the owner committed to.

That is the design target for agent-native DeFi. Give the machine enough agency to watch and trigger. Keep the authority in the signature and the chain.

## Verify it yourself

- [OpenZaps documentation](https://www.0xzaps.com/docs)
- [Live explorer](https://www.0xzaps.com/explore)
- [Agent connection decision record](https://github.com/0pen-Zaps/openzaps/blob/main/docs/adr/0006-agent-connection-and-mcp-surface.md)
- [Security policy and current audit status](https://github.com/0pen-Zaps/openzaps/blob/main/SECURITY.md)

*Not financial advice. No yield, return or safety guarantee is implied.*
