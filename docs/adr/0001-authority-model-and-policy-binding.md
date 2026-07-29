# ADR-0001: Authority Model & Policy Binding

**Status:** Accepted
**Date:** 2026-06-06
**Deciders:** Product (Nodar) · Smart-contract lead · Security/audit lead

## Context

The foundational question for OpenZaps is *where execution authority sits after the user walks
away*. The research report establishes four credible models — pre-funded immutable zap,
signed-intent + one-shot pull, smart-account (Safe/4337) policy, and EIP-7702 delegation — and
shows that none eliminate authorization; they only relocate and scope it
([research-report.md §System model](../research-report.md)).

Two coupled sub-decisions remain open and block everything downstream:

1. **Which consent model is canonical for v1** (deposit-based vs signed-intent vs smart-account).
2. **Is a zap a single-policy immutable instance, or a generic verifier** that checks a
   submitter-supplied `policyHash`? The report's `OpenZapIntent` struct carries `policyHash`, which
   only makes architectural sense for a *generic verifier* — directly in tension with the
   "fully immutable per-zap" framing where the policy **is** the bytecode. The schema currently
   straddles both, leaving Hermes/relayer with latent policy discretion.

**Constraints in force:** Base L2 deployment; Hermes is submitter/simulator/monitor only (never a
holder of approvals or a strategy engine); ERC-20-first; "immutable" is a marketed product claim;
the legal posture rewards self-custody, no operator discretion, and **no pooled balances**.

## Decision

1. **Canonical v1 = deposit-based, fully-immutable, per-zap, single-policy instances.** Each zap is
   deployed for exactly one frozen policy — adapters, selectors, tracked assets, recipient set, fee
   caps, nonce channel — fixed at construction as immutables/constants.

2. **Signed-intent (EIP-712 + Permit2 one-shot pull) is a supported *mode on that same per-zap
   instance*, not a separate generic-verifier architecture.** Because the intent binds to one zap's
   frozen policy, `policyHash` becomes a **deploy-time immutable the contract already knows**
   (`POLICY_HASH`), not a per-intent variable. The intent still carries it for signature legibility
   and domain binding, but the contract asserts `intent.policyHash == POLICY_HASH` and reverts
   otherwise. This gives the submitter **zero policy discretion** and resolves the straddle.

3. **Smart-account-native (Safe/4337) and EIP-7702 are explicitly out of v1 core**, but supported
   *at the edges* via ERC-1271 signature acceptance (P1) so Safe/contract-wallet users can create
   and sign without the zap depending on mutable wallet-policy code.

4. **Authority split is fixed:** create = user wallet/Safe; execute = immutable zap; submit =
   Hermes/relayer, bounded by policy.

### Permit2 one-shot owner pull

The source-only base-lineage `1.2.0-candidate` implements Decision 2 through
`executeWithPermit2`. Existing immutable v1.1 deployments are unchanged and remain pre-funded only.

- The capsule calls Permit2 **SignatureTransfer with a typed witness**, never Permit2's standing
  allowance-transfer path. The witness is `OpenZapIntentWitness(bytes32 intentDigest)`, binding the
  Permit2 authorization to the exact EIP-712 intent the capsule verifies.
- The OpenZap EIP-712 domain intentionally remains version `"1"`: the base intent schema is
  unchanged, while `chainId`, `verifyingContract`, and `intent.zap` already bind a signature to one
  clone. The `1.2.0-candidate` factory version identifies new runtime bytecode and deployment
  lineage; changing the signing-domain version would add migration surface without adding replay
  separation. The Permit2 witness adds a second protocol-specific domain around the same digest.
- The frozen first step defines the only permitted funding leg. The submitted Permit2 token and
  amount must equal that step's `tokenIn` and `amountIn` exactly.
- Permit2 binds `msg.sender` as spender, so the capsule is the spender. The capsule constructs the
  destination as itself and the requested amount as the exact frozen amount. Hermes/executors can
  relay the two signatures but never gain pull rights or redirect funds.
- The Permit2 deadline may not exceed the OpenZap intent deadline or one hour from submission. The
  Permit2 unordered nonce remains owner-selected because it is global to that owner, unlike an
  OpenZap nonce, which is local to one capsule.
- The capsule consumes and verifies its owner intent before the Permit2 call, measures the exact
  owner-to-capsule balance delta, and requires the pulled input to be fully consumed by the frozen
  graph. Any permit, adapter, postcondition, or settlement failure atomically rolls back the
  OpenZap nonce, Permit2 nonce, and token transfer.
- The pull token cannot also be the declared output asset in this deliberately narrow candidate;
  that would make the pre-output snapshot ambiguous. Such a policy remains available through the
  existing pre-funded `execute` path.

SignatureTransfer still requires an ERC-20 allowance from the owner to the canonical Permit2
contract. This path makes the authorization one-shot and capsule-bound; it does **not** eliminate
Permit2 concentration risk and does not justify an allowance to an executor, relayer, adapter, or
OpenZap capsule.

## Options Considered

### Option A: Deposit-based immutable per-zap *(recommended)*
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Higher deploy (mitigated by clones, ADR-0002), simple runtime |
| Scalability | Per-instance; isolation scales with users |
| Verifiability | **High** — finite, known call graph per instance |
| Legal perimeter | **Best** — self-custody, per-zap isolation, no discretion |
| Team familiarity | High (standard immutable contracts) |

**Pros:** Strongest trust-minimization and isolation; exact postconditions; cleanest legal story; the policy *is* the bytecode.
**Cons:** Pre-funding friction; one deploy per policy; no native cross-zap batching.

### Option B: Signed-intent generic verifier (one contract, many policies)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Cheap (no per-policy deploy) |
| Verifiability | Lower — submitter-supplied `policyHash` is live attack surface |
| Legal perimeter | Weaker if it trends toward pooled/shared accounting |

**Pros:** Fewer deploys; flexible.
**Cons:** Reintroduces submitter policy discretion; weakens the "immutable = one known policy" claim; harder to prove "cannot act outside policy."

### Option C: Smart-account-native (Safe module/guard or ERC-4337)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High |
| Verifiability | Medium — wallet-policy code becomes security-critical |
| UX | High (funds stay in the account) |

**Pros:** The better *long-term* substrate (the report's own conclusion for "general agentic wallet"); great UX.
**Cons:** Broadens v1 scope; module/guard/validation bugs become catastrophic; not "immutable capsule."

### Option D: EIP-7702 delegated code
| Dimension | Assessment |
|-----------|------------|
| Complexity | High |
| Maturity | Wallet support and cross-chain migration still immature |

**Pros:** Forward-looking, wallet-native.
**Cons:** Too immature to anchor a v1 security claim across chains.

## Trade-off Analysis

Option A maximizes the two properties that make the whole OpenZaps thesis defensible — **per-instance
verifiability** (a finite, known external call graph) and **blast-radius isolation** (a bug or
compromise is scoped to one user's funded instance) — at the cost of pre-funding friction and deploy
gas. The gas cost is addressed separately in ADR-0002 (hardened clones). Option B trades that
verifiability for deploy savings by reintroducing a submitter-supplied policy surface, which is
exactly the discretion the architecture is trying to deny Hermes. Options C and D are stronger
*substrates* for a future "agentic wallet" product but are the wrong altitude for a v1 whose entire
pitch is a **narrow, immutable policy capsule**. Folding signed-intent in as a *mode on the same
immutable instance* (Decision 2) captures the UX of one-off intents without giving up the single-policy
guarantee.

## Consequences

**Easier:** formal verification (finite call graph); per-zap isolation; the legal
self-custody/no-discretion/no-pooling story; exact balance-delta postconditions.

**Harder:** pre-funding UX; one deploy per policy (mitigated by ADR-0002 clones); no native
cross-zap batching in v1.

**Revisit:** a smart-account-native (Safe/4337) version as the v2 substrate for power users and
long-lived agents; EIP-7702 once wallet support matures.

## Action Items

1. [ ] Make `POLICY_HASH` a constructor immutable; assert `intent.policyHash == POLICY_HASH` on the signed-intent path (invariant **I-AUTH-3**).
2. [ ] Specify the deposit lifecycle: fund → per-zap isolated balance → unconditional owner withdraw (links to ADR-0002 and invariant **I-REC-1**).
3. [x] Define the Permit2 one-shot pull path for the signed-intent mode; bind exact amount, exact spender, short expiry. Implemented in the source-only base-lineage `1.2.0-candidate`; live v1.1 remains unchanged.
4. [ ] Assert no shared/pooled balance exists anywhere in the system (security + legal — invariant **I-ISO-4**).
5. [ ] Get sign-off to defer smart-account-native and EIP-7702 from v1 core.
