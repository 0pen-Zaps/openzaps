# ADR-0007: Irreversible owner-scoped policy halt

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** Product (Nodar) · Smart-contract lead · Security lead

## Context

Nonce and series invalidation revoke authorizations only when the owner knows the exact identifier.
`emergencyExit` recovers current balances but does not permanently prevent a still-valid signature
from executing if the capsule is funded again. The research checklist therefore requires a halt per
policy as a containment path independent of the normal executor.

Each OpenZap clone holds one frozen policy. A halt can consequently be scoped to one owner and one
policy without adding registry, executor, or protocol-wide authority. A reversible pause would be
materially weaker: an unpause could unexpectedly reactivate signatures that owners reasonably
treated as dead.

## Decision

Every newly deployed OpenZap implementation includes an irreversible, owner-only
`haltPolicy()`:

- the halt applies only to the caller's clone and its one frozen policy;
- every execution entry point checks it before consuming a nonce, advancing a series, reading an
  untrusted price source, approving a token, or calling an adapter;
- there is no unhalt or alternate admin path;
- nonce/series invalidation and `emergencyExit` remain callable after the halt; and
- executors, registries, factories, relays, and hosted services receive no halt authority.

The change is not retroactive. Existing Robinhood v1.1, v3, and v3.1 implementation bytecode keeps
its deployed recovery surface. Product and deployment documentation must distinguish those live
contracts from later source candidates.

## Options considered

### Reversible owner pause

Rejected. It creates a signature-reactivation edge and adds another state transition that must be
understood by every relayer and monitoring surface.

### Registry or operator kill switch

Rejected. It would widen shared administrative authority across otherwise isolated user policies
and conflict with OpenZaps' bounded-authority model.

### Nonce invalidation and withdrawal only

Rejected as incomplete containment. It requires complete nonce discovery and does not make the
policy permanently inert.

## Consequences

**Safer containment:** one transaction permanently narrows one owner's policy without trusting the
fast path or a shared administrator.

**No recovery from mistakes:** an accidental halt cannot be reversed. The UI and SDK must present
it as destructive and verify the target capsule and owner.

**New deployments only:** live immutable implementations cannot gain this feature. A release must
record the new implementation/factory bytecode and domain/version boundary before advertising it.

## Action items

1. [x] Gate every v1/v2/v3/v3.1/v3.2 source execution entry point before state consumption or
   external interaction.
2. [x] Prove owner-only scope, clone isolation, one-way behavior, and continued recovery/revocation
   in focused tests.
3. [x] Record the source/live boundary in deployment and lineage documentation.
4. [ ] Add wallet UI and SDK confirmation only when a halt-capable lineage is actually deployed.
