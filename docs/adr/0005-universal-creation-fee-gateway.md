# ADR-0005: Universal app-creation fee gateway

- **Status:** Accepted
- **Date:** 2026-07-25
- **Decision owners:** OpenZaps maintainers

## Context

OpenZaps has three live, immutable capsule lineages on Robinhood Chain: v1.1 for one-shot execution,
v3 for price triggers, and v3.1 for relative-floor recurring runs. Their EIP-712 domains, runtime
bytecode, factories, executor behavior, and automation pots are already deployed and verified.

Automated v3/v3.1 runs charge a 1% output fee, split 80% to the executor and 20% to that lineage's
0xZAPS pot. One-shot execution does not. Reusing a one-run recurring intent would not solve this
universally: the old pots can convert aeWETH and already-received 0xZAPS, but cannot safely convert
all currently offered USDG and vault-share outputs. Replacing every lineage with another core
implementation would duplicate authority-bearing code and change signed domains merely to collect a
creation fee.

The product requires every capsule created through the current app to pay a visible fee that becomes
0xZAPS without token-gating the core workflow or silently reducing route output.

## Decision

Deploy one immutable `OpenZapCreationGateway` in front of the three existing factories.

1. The wallet sends exactly `0.00001 ETH` to `createZap(lineage, policy, salt, minZapsOut)`.
2. The gateway asks the selected existing factory for the deterministic address, then calls that
   factory's existing `createZap(policy, salt)` function.
3. The gateway wraps the exact native fee to aeWETH and executes the already-pinned
   aeWETH → 0xZAPS adapter.
4. It measures both input spent and 0xZAPS received by balance delta, requires the caller-reviewed
   `minZapsOut`, resets approval to zero, transfers the result to `ZapCreationFeePot`, and credits the
   policy owner.
5. Any failure reverts the whole transaction, including the underlying factory's CREATE2 clone and
   automation-pot registration.

The gateway does **not** deploy a replacement capsule implementation. The resulting clone still
belongs to its original factory, uses its original runtime and EIP-712 domain, and contributes any
automation execution fees to its original v3/v3.1 pot.

`ZapCreationFeePot` accepts only already-transferred 0xZAPS from the one-time-bound gateway. Credits
are balance-backed. It has no sweep or owner-withdraw path; governance can only award the current
accounted prize to an address that has tickets in that round.

## Invariants

- **I-FEE-1 — exact fee:** underpayment and overpayment both revert.
- **I-FEE-2 — bounded conversion:** a zero `minZapsOut` or output below the supplied floor reverts.
- **I-FEE-3 — atomicity:** no capsule, registration, fee transfer, or ticket survives any failed step.
- **I-FEE-4 — lineage preservation:** one-shot uses v1.1, trigger uses v3, recurring uses v3.1; the
  gateway cannot choose any other factory.
- **I-FEE-5 — measured flow:** wrapped input spent, output received, and pot transfer are verified by
  balance delta; the adapter approval returns to zero.
- **I-FEE-6 — balance-backed pot:** ticket and prize accounting cannot exceed received 0xZAPS.
- **I-FEE-7 — no drain:** value leaves the creation pot only as the accounted current-round prize to a
  ticket holder.
- **I-FEE-8 — disclosure:** the app shows the exact native fee, estimated 0xZAPS, and transaction floor
  before enabling creation.
- **I-FEE-9 — honest scope:** old immutable factories remain directly callable. Copy must say every
  *current app-created* capsule pays the fee, not that legacy factory calls are impossible.

## Alternatives rejected

- **Use v3.1 with `maxRuns=1` for one-shots.** Mechanically valid, but it changes the signing domain,
  adds meaningless schedule fields, pays most of the fee back to a self-executing owner, and leaves
  unsupported output-fee assets stranded.
- **Deploy a fourth universal capsule/factory.** Duplicates core bytecode, registries, runtime
  verification, relay routing, and EIP-712 lineage for a concern that belongs at creation time.
- **Skim every route's output.** Hidden unless every quote changes, incompatible with universal
  conversion across current output assets, and risks weakening signed recipient floors.
- **Batch conversion under a treasury or keeper.** Introduces custody and conversion-delay risk; the
  requirement is satisfied more strongly by same-transaction conversion.
- **Require the fee in 0xZAPS.** Token-gates capsule creation and adds approval friction. Core workflows
  remain usable without pre-holding the token.

## Consequences

- The app must fail closed when the gateway, pot, exact fee, factory mapping, or code is unavailable.
- Creation needs native ETH in addition to the capsule's later ERC-20 funding.
- Fee conversion moves the aeWETH/0xZAPS pool in the same transaction as creation; the supplied floor
  bounds that execution and a stale floor causes a safe full revert.
- Existing factory explorers and capsule verification continue to work because the underlying
  factory still emits `ZapCreated` and owns initialization.
- The creation pot is a separate accounting surface from the v3 and v3.1 automation pots.
- Like the existing protocol, this gateway is live-candidate code until external review; UI copy must
  retain the pre-audit warning.
