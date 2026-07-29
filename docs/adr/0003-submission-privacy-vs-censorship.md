# ADR-0003: Submission — Privacy vs Censorship Resistance

**Status:** Accepted
**Date:** 2026-06-06
**Deciders:** Product (Nodar) · Smart-contract lead · Security/audit lead

## Context

The research report prescribes two mitigations that **contradict each other on a price-sensitive
route**:

- To defeat sandwiching/MEV: **private submission by default**
  ([research-report.md §Threat models](../research-report.md) — Frontrunning row, and the Flashbots
  Protect default).
- To defeat relayer censorship: a **public "anyone can submit after timestamp T" fallback**
  (Relayer censorship row).

These cannot both hold for the same AMM-facing action. The moment a public "anyone after T" path is
exposed, it re-reveals the exact route and timing the private path was hiding — handing the
sandwicher the trade on a delay. The architecture has to *choose per route*, not apply both globally.

A second, related problem: the relayer is currently handed a **free option**. Unless the signed
intent binds the fee cap, gas, recipient, and a tight deadline, a relayer can submit only when it
benefits — and an absolute `minOut` signed in advance goes stale as the market moves.

## Decision

1. **Price-sensitivity is a typed, deploy-time property of each step** in the compiled policy
   (default **true** for any step whose adapter is an AMM/DEX).

2. **Price-sensitive steps: private submission ONLY.** Censorship resistance comes from a
   **multi-builder / multi-relayer private set** (several Flashbots-compatible builders), **not** a
   public fallback. **No public "anyone after T" path is ever opened for a price-sensitive step.**

3. **Non-price-sensitive steps** (deposits, sweeps, transfers to a fixed recipient): public mempool
   is allowed, **including** a permissionless "anyone after T" liveness fallback. Whether that
   fallback is enabled is itself a signed per-step policy bit (default off).

4. **Close the relayer's free option.** The EIP-712 intent binds, *together*:
   `recipient`, `maxRelayerFee`, **gas caps** (`maxGas` / `maxFeePerGas`), `validAfter`, a **short**
   `deadline`, and the route. The success postcondition asserts
   `recipientDelta ≥ minOut` measured **net of fee**. Prefer **oracle-relative or short-expiry**
   `minOut` so a stale signature cannot execute into a moved market.

(For *protective* zaps, which genuinely need permissionless on-chain triggering and therefore accept
MEV, see ADR-0004 — they are out of v1 scope precisely so this private-only rule can hold cleanly.)

## Robinhood Chain implementation status (2026-07-29)

The current executor implements the decision conservatively without changing deployed contracts:

- Every released capsule route references one or more approved adapters, and the maintenance
  conversion calls a bounded swap adapter. The executor therefore classifies **all current writes
  as price-sensitive**. This is stricter than a per-step bit: there is no public submission path to
  accidentally open.
- The signer creates the EIP-1559 transaction and signature locally. A generic raw-transaction
  provider fans the same bytes out to an operator-configured set of endpoints explicitly classified
  `private-relay`; `public-rpc` and `direct-sequencer` classifications are ineligible.
- Before the first relay request, the executor fsyncs a 0600 outbox entry containing the
  deterministic hash and exact signed bytes. Restart recovery may redispatch only those same bytes;
  finalized receipt evidence retains sanitized relay health and inclusion, never the raw transaction
  or relay credentials.
- The minimum acceptable set is **two distinct HTTPS origins controlled by two declared
  operators**. Per-origin acceptance, rejection, timeout/unknown health, and later onchain inclusion
  are reported. If no qualifying set exists, signer mode fails closed. There is no public fallback.

Robinhood's official documentation describes an Arbitrum L2 with first-come-first-served sequencing
and lists public/provider RPCs plus sequencer endpoints:
[architecture](https://docs.robinhood.com/chain/) and
[connection endpoints](https://docs.robinhood.com/chain/connecting/). It does not currently
document an independent Flashbots-style builder/private-relay network. Consequently, this
implementation is source-ready infrastructure and **does not claim builder diversity on
Robinhood**. Endpoint classification and operator independence remain explicit operator trust
inputs until such a network or private-orderflow service is documented and verified.

## Options Considered

### Option A: Private-only multi-builder (sensitive) + public-after-T (non-sensitive) *(recommended)*
| Dimension | Assessment |
|-----------|------------|
| MEV resistance | **High** on sensitive steps |
| Censorship resistance | High via builder diversity (no route leak) |
| Liveness | High for non-sensitive; bounded for sensitive |
| Complexity | Medium — integrate/monitor several builders |
| Trust | No single relayer; watch for solver-cartel centralization |

**Pros:** Coherent; honest about the trade; no contradictory paths.
**Cons:** If *all* private builders censor a sensitive step simultaneously, it waits (acceptable for optimization zaps — ADR-0004).

### Option B: Public mempool everywhere + tight `minOut`
**Pros:** Simplest; maximal censorship resistance.
**Cons:** Loses to sandwichers on real size; `minOut` alone caps loss but does not prevent value extraction.

### Option C: Single private relayer + public fallback (status quo in the report)
**Pros:** Looks like it has both properties.
**Cons:** **Internally contradictory** — the public fallback re-exposes the route. Rejected.

## Trade-off Analysis

Builder diversity is what lets Option A get censorship resistance **without** leaking the route: many
independent builders can include the bundle, but none of them is the public mempool. The price is
operational (several endpoints to integrate, monitor, and reason about) and one honest residual risk
— if every private builder censors a sensitive step at once, that step stalls. For **optimization**
zaps (the only class in v1 per ADR-0004) a stalled step costs efficiency, not principal, so this is
acceptable. Option B is the simplest but concedes extractable value on exactly the trades where size
makes it matter. Option C is the contradiction this ADR exists to remove.

## Consequences

**Easier:** a coherent, defensible MEV story; per-step classification makes the privacy guarantee
auditable rather than aspirational.

**Harder:** must integrate and health-monitor multiple builders; per-step classification adds policy
surface and a compilation-time check; "no public fallback for sensitive steps" must be enforced, not
merely documented.

**Revisit:** OFA / MEV-rebate integration (the report's later-stage optimization) once the accounting
exists; monitor for private-orderflow centralization into a trusted solver cartel (the report's open
question).

## Action Items

1. [x] Enforce **I-SUB-1** for the current release by conservatively treating every
   adapter-backed route as price-sensitive. An explicit per-step field remains a future policy
   schema optimization; it is not needed to weaken the current all-sensitive rule.
2. [x] Build a generic multi-relay raw-transaction adapter with per-origin health and inclusion
   monitoring, local signing, and no public fallback. Robinhood activation remains fail-closed
   until real private endpoints exist and are configured.
3. [x] Bind recipient, route/policy hash, gas caps, validity window, deadline, and net recipient
   floor in the standing EIP-712 intents. v1 one-shot authorization separately binds its relayer
   fee cap; automated v3 fees are fixed in the capsule rather than selected by the executor.
4. [x] Document the current release as all-sensitive: no current zap step may use public-after-T.
   Any future non-sensitive route must make that exception explicit in its policy schema.
5. [x] Require at least two distinct private-relay origins and two declared operators. This is an
   admission floor, not proof Robinhood currently has independent private builders.
