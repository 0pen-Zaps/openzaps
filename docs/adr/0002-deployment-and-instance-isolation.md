# ADR-0002: Deployment & Instance Isolation

**Status:** Accepted
**Date:** 2026-06-06
**Deciders:** Product (Nodar) · Smart-contract lead · Security/audit lead

## Context

ADR-0001 commits v1 to per-zap, single-policy instances. That raises a deployment question the
research report ranks but under-analyzes: the report calls **fully-immutable-per-zap** the best
final model and **immutable EIP-1167 clones** the best *v1* pattern
([research-report.md §Verification, immutability, and governance](../research-report.md)).

The under-stated trade-off: an **EIP-1167 minimal proxy delegatecalls a single shared
implementation**. The *clone* is non-upgradeable, but its logic is not self-contained. A bug in the
shared implementation — reachable `selfdestruct`, a stray `delegatecall`, or an init front-run — is
**systemic across every user's zap simultaneously**. Clones buy ~90% deploy-gas savings at the cost
of the per-instance blast-radius isolation that ADR-0001 depends on. This is the same concentration
4337 makes with `EntryPoint`; the report praises 4337 for being *honest* about it, then doesn't apply
that honesty to its own clone recommendation.

## Decision

**v1 uses EIP-1167 minimal-proxy clones of a single hardened implementation, deployed via a
versioned factory** — for gas — **with mandatory hardening that restores the isolation guarantees
that matter:**

1. **Stateless, fundless implementation.** The implementation holds no state and no funds; every
   balance lives in the clone. Asset isolation is therefore preserved even though logic is shared.
2. **No catastrophic opcodes.** The implementation contains **no `selfdestruct`, no `delegatecall`,
   and no upgrade hooks.** This removes the clone failure modes that would be *catastrophic* rather
   than merely *systemic*.
3. **Atomic, factory-only initialization.** A clone is initialized in the **same transaction** as
   its creation, by the factory. `initialize` reverts if called by anyone but the factory, or if
   already initialized. This closes clone-init front-running.
4. **Critical-criticality treatment.** The shared implementation is `EntryPoint`-class: it gets the
   same audit and formal-verification bar as the factory, and its bytecode hash is pinned in the
   release manifest that Hermes checks before every submission.
5. **Premium full-deploy path.** Zaps above a configurable deposit threshold **MAY** be deployed as
   **full per-zap bytecode** (no shared implementation) for maximal isolation.

**Governance lives around, not inside, zaps:** a versioned factory; new implementation versions and
adapter approvals gated by **Safe multisig + `TimelockController`**; **no admin on already-deployed
instances** (preserving the "immutable" claim).

## Options Considered

### Option A: Full per-zap bytecode (no shared logic)
| Dimension | Assessment |
|-----------|------------|
| Blast radius | **Best** — fully isolated |
| Deploy gas | **High** |
| Init-frontrun risk | None (self-contained) |
| Runtime cost | Simple |

**Pros:** Maximal isolation; the report's "best final model."
**Cons:** Expensive onboarding; slow iteration.

### Option B: Hardened EIP-1167 clone + versioned factory *(recommended)*
| Dimension | Assessment |
|-----------|------------|
| Blast radius | Systemic logic risk, but no catastrophic opcodes; assets isolated |
| Deploy gas | **Low** (~90% cheaper) |
| Init-frontrun risk | Closed via atomic factory-only init |
| Runtime cost | Simple |

**Pros:** Cheap onboarding; fast iteration via new factory versions; asset isolation preserved.
**Cons:** Shared implementation is a single high-value target — a logic bug there affects all clones.

### Option C: UUPS proxy
**Pros:** Upgradeable recovery path; cheaper than Transparent.
**Cons:** Upgrade logic is security-critical and contradicts the immutability claim — acceptable only for non-user-balance infrastructure.

### Option D: Transparent proxy
**Pros:** Familiar.
**Cons:** Highest admin/selector risk, most expensive; poor fit for the OpenZaps promise.

## Trade-off Analysis

Clones save roughly an order of magnitude on deploy gas but concentrate logic risk in one contract.
The hardening in the Decision removes the *catastrophic* clone failure modes (selfdestruct,
delegatecall, init front-run) and preserves *asset* isolation (stateless/fundless implementation),
leaving only the irreducible "a logic bug in shared code is systemic" — which is unavoidable for
**any** shared-logic pattern and is the exact trade 4337 makes with `EntryPoint`, accepted here with
eyes open and matching audit rigor. The premium full-deploy path (Decision 5) gives high-value users
the Option-A guarantee without imposing its gas cost on everyone. Proxy patterns (C/D) reintroduce
an upgrade admin that breaks the product's central claim and are rejected for user-balance contracts.

## Consequences

**Easier:** cheap user onboarding; fast iteration by shipping new factory versions; deterministic
CREATE2 addresses for discovery.

**Harder:** the shared implementation must be flawless — audit and formal-verification cost is
concentrated there; the release-manifest/bytecode-hash discipline becomes load-bearing for Hermes.

**Revisit:** make full per-zap deploys the default if a verifiably cheaper deploy path emerges, or
for institutional/high-value zaps by policy.

## Action Items

1. [ ] Implementation: remove `selfdestruct`/`delegatecall`/upgrade hooks; assert stateless & fundless (invariants **I-ISO-1**, **I-ISO-2**).
2. [ ] Factory: deterministic CREATE2; emit `version` + implementation bytecode hash; **atomic init** guarded to factory-only (invariant **I-ISO-3**).
3. [ ] Release manifest pinning implementation + adapter bytecode hashes; wire into Hermes pre-submission safety check.
4. [ ] Define the deposit threshold + opt-in path for full per-zap deployment.
5. [ ] Stand up Safe multisig + `TimelockController` for factory-version and adapter-approval governance; confirm no instance admin exists.
