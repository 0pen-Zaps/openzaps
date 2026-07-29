# OpenZaps v1 Invariant Specification

**Status:** Draft · **Date:** 2026-06-06 · **Scope:** v1 = optimization-class, deposit-based,
fully-immutable per-zap instances deployed as hardened EIP-1167 clones over a curated ERC-20
allowlist (see [ADR-0001](adr/0001-authority-model-and-policy-binding.md),
[ADR-0002](adr/0002-deployment-and-instance-isolation.md),
[ADR-0003](adr/0003-submission-privacy-vs-censorship.md),
[ADR-0004](adr/0004-protective-vs-optimization-zaps.md), and the app-creation fee extension in
[ADR-0005](adr/0005-universal-creation-fee-gateway.md)).

This is the **machine-checkable contract** for "a zap cannot do anything outside its frozen policy."
Each invariant has an ID, a statement, its source, the verification method, and a rule sketch.
The production-readiness gate at the end requires every invariant to have a passing proof or fuzz
campaign **and** every adversarial question to answer "no" before mainnet.

> The verification target is **local safety** ("cannot act outside policy"), not **global economic
> optimality** ("best execution"). The latter is handled by simulation + private flow, not proof.

## Verification toolchain — what each tool is actually good for here

| Tool | Use it for | Do **not** rely on it for |
|---|---|---|
| **Foundry invariant tests** (stateful fuzz, mock adapters/tokens) | Asset-flow, approvals, recovery, random-calldata adapter probing | Exhaustive proof |
| **Certora Prover** (rules + ghosts) | Call-ordering, adapter-surface reachability, `allowance==0` post, balance ghosts, isolation | — |
| **Halmos** (symbolic) | Signed-field binding, arithmetic, nonce | Deep external-call graphs |
| **SMTChecker** | Nonce monotonicity + arithmetic assertions **only** | **Anything across the `_callAdapter` loop — it is blind to external-call effects** |
| **Fork tests** (Base mainnet fork) | Real adapter integration, domain/chainId, paused-protocol recovery, finality | Cheap iteration |

The report leans on SMTChecker; **re-weight toward Certora/Halmos + invariant fuzzing.** The
properties that actually carry risk live *across* the adapter call-loop, which SMTChecker cannot see.

---

## AUTH — Authorization

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-AUTH-1** | Authorization (nonce/digest) is consumed **before** any external call | report execute() skeleton; reentrancy row | Certora ordering rule + Foundry reentrancy test |
| **I-AUTH-2** | Nonce is monotonic / each digest is one-time-use per channel | replay row | SMTChecker assertion + Certora + fork |
| **I-AUTH-3** | `intent.policyHash == POLICY_HASH` (immutable); submitter supplies no policy | ADR-0001 | Unit + Certora |
| **I-AUTH-4** | Every optionality-granting field is bound: `recipient`, `maxRelayerFee`, `maxGas`/`maxFeePerGas`, `validAfter`, `deadline`, route hash | ADR-0003; EIP-7702 binding principle | Halmos + EIP-712 struct test matrix |
| **I-AUTH-5** | Domain separator binds `chainId` + verifying contract and is **recomputed when `chainId` changes** (no stale cached separator post-fork) | replay/fork open question | Chain-fork test |
| **I-AUTH-6** | Intents with `block.timestamp > deadline` or `< validAfter` revert | replay row | Unit |
| **I-AUTH-7** | Permit2 SignatureTransfer witnesses the exact OpenZap intent digest; the capsule is the implicit spender and fixed destination, owner is the source, token/amount equal the first frozen step, and the permit expires no later than both the intent and one hour from submission. The executor receives no pull authority | ADR-0001 signed-intent mode | Unit with canonical EIP-712 witness shape + fixed-block Permit2 fork |

**Rule sketch (I-AUTH-1, Certora):**
```
rule authConsumedBeforeExternalCall {
    // No CALL/STATICCALL/DELEGATECALL to a non-self address may occur
    // before nonceUsed[digest] has been written true within execute().
    assert forall extCall e .
        e.isExternal && e.callee != currentContract =>
        nonceWritten_at_step(e.stepBefore) == true;
}
```

**Rule sketch (I-AUTH-3, unit):**
```solidity
function test_rejectsForeignPolicyHash() public {
    OpenZapIntent memory i = _valid(); i.policyHash = bytes32(uint256(0xdead));
    vm.expectRevert(PolicyHashMismatch.selector);
    zap.execute(i, _sign(i));
}
```

## SURF — Adapter surface

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-SURF-1** | Only allowlisted `(adapter, selector)` pairs are reachable; **no arbitrary `target`/`calldata`** | report §System model; ADR-0001 | Certora reachability + Foundry fuzz with random calldata |
| **I-SURF-2** | The instance performs **no `delegatecall`** | ADR-0002 | Bytecode static check + Certora |

**Rule sketch (I-SURF-1, Foundry invariant):** fuzz arbitrary `bytes` into the step compiler /
execute path; assert any call whose `(adapter, selector)` is not in the frozen allowlist reverts and
moves no assets.

## FLOW — Asset flow

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-FLOW-1** | No asset leaves the zap except via (a) an allowlisted adapter call, (b) the bounded fee sink, (c) the signed recipient | report postcondition engine | Foundry invariant + Certora balance ghost |
| **I-FLOW-2** | On success, `recipientDelta ≥ minOut` measured **net of relayer fee** | ADR-0003 | Unit + fuzz |
| **I-FLOW-3** | `relayerFeePaid ≤ maxRelayerFee` | report fee model | Unit + Certora |
| **I-FLOW-4** | Unsolicited/dust assets are never counted in core accounting; the rescue path cannot divert intended outputs | report "unexpected receipts" row | Foundry fuzz (inject dust mid-flow) |
| **I-FLOW-5** | A Permit2 owner pull produces the exact measured capsule balance delta and the frozen graph fully consumes it; partial, fee-on-transfer, redirected, same-input/output, or failed downstream paths revert atomically with both nonces and the transfer rolled back | ADR-0001 signed-intent mode | Unit + revert/retry + token-adversary fuzz |

**Rule sketch (I-FLOW-1, Certora ghost):**
```
ghost mathint assetsOut;
hook Sstore balanceOf[KEY a] uint v (uint old) { if (v < old) assetsOut += (old - v); }
invariant onlyApprovedExits()
    assetsOut <= adapterPulls + feePaid + recipientPaid;
```

## APPR — Approvals

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-APPR-1** | **No residual approval** to any spender after success **or any revert path** | report verification table | Foundry invariant fuzzing reverts at *every* step + Certora `allowance==0` post |
| **I-APPR-2** | Approvals are exact (`== amount`) and reset to `0` in the same transaction | report execute() skeleton | Unit |
| **I-APPR-3** | Non-standard-return tokens (USDT-like) handled via safe-approve semantics | report ERC-20 hazards | Unit with mock token |

**Rule sketch (I-APPR-1, Foundry):** parametrize a mock adapter to revert at step `k` for
`k ∈ [0, STEPS)`; after the (reverted) call, assert `token.allowance(zap, spender) == 0` for every
`(token, spender)` the policy can touch.

## ISO — Deployment & isolation

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-ISO-1** | The shared implementation holds **no funds and no mutable state** | ADR-0002 | Foundry invariant + review |
| **I-ISO-2** | Implementation has **no `selfdestruct`, no `delegatecall`, no upgrade path** | ADR-0002 | Bytecode static analysis + Certora |
| **I-ISO-3** | `initialize` is callable **once**, **only by the factory**, atomically with deploy (no init front-run) | ADR-0002 | Unit + fork |
| **I-ISO-4** | Per-zap **isolated** balances; **no shared/pooled vault** anywhere | ADR-0001; legal posture | Architectural review + accounting fuzz |

## REC — Recovery (the load-bearing one)

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-REC-1** | An **owner-only, unconditional** emergency exit always succeeds and drains all tracked assets to the owner — **regardless of** adapter state, Hermes liveness, postcondition state, or a paused/compromised integrated protocol | eval Gap 2 | Foundry invariant from arbitrary reachable state + fork test vs paused adapter |
| **I-REC-2** | The emergency exit does **not** route through any adapter | eval Gap 2 | Static + unit |
| **I-REC-3** | The user can always revoke/invalidate a pending intent (nonce) without the normal fast path | report revocation | Unit |
| **I-REC-4** | The owner can permanently halt **only its own clone's frozen policy**. Every execution entry point then reverts before consuming a nonce, advancing a series, reading a price source, or calling an adapter; `emergencyExit` and nonce/series invalidation remain available. There is no unhalt that can reactivate held signatures | report revocation | Unit across v1/v2/v3/v3.1/v3.2 execution surfaces + static review |

**Rule sketch (I-REC-1, Foundry invariant):** after an unbounded sequence of arbitrary public calls
(reaching any state), assert `zap.emergencyExit()` called by `owner` succeeds and
`trackedAssetsAfter(owner) == trackedAssetsBefore(zap)`. Repeat on a Base fork with the integrated
lending pool **paused**.

> Why this is load-bearing: immutable zaps call **mutable** protocols, and there is **no admin** on
> instances. The owner exit is the *only* recovery path. If any I-REC invariant fails, the
> immutability claim is unsafe, not just incomplete.

## TOK — Token compatibility

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-TOK-1** | Only curated-allowlist tokens may enter the tracked set | eval Gap 6 | Config/unit |
| **I-TOK-2** | Fee-on-transfer / rebasing tokens are excluded; accounting uses **measured deltas**, never assumed amounts (defense-in-depth even within the allowlist) | eval Gap 6 | Fuzz with FoT/rebasing mocks expecting rejection or delta-correctness |

## FEE — App-creation fee gateway

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-FEE-1** | Creation accepts exactly the immutable native fee; underpayment and overpayment revert | ADR-0005 | Unit + fork |
| **I-FEE-2** | Conversion requires nonzero caller minimum and measured 0xZAPS output at or above it | ADR-0005 | Unit + live-pool fork |
| **I-FEE-3** | Any factory, wrapping, adapter, floor, transfer, or accounting failure rolls back the underlying CREATE2 clone too | ADR-0005 | Unit rollback/retry test |
| **I-FEE-4** | Lineage selects only the pinned v1.1, v3, or v3.1 factory; resulting runtime/domain remain that factory's | ADR-0005 | Unit + all-lineage fork |
| **I-FEE-5** | Gateway spends exactly the wrapped fee, measures 0xZAPS by balance delta, transfers the exact delta, and leaves zero adapter approval | ADR-0005 | Unit + fork |
| **I-FEE-6** | Pot accounting never exceeds received 0xZAPS; direct donations cannot mint tickets or become an award | ADR-0005 | Unit |
| **I-FEE-7** | The creation pot has no drain; only its current accounted prize can leave, and only to a current-round ticket holder | ADR-0005 | Unit + static review |
| **I-FEE-8** | UI fails closed unless gateway code, pot code, exact fee, factory mapping, and live conversion quote verify | ADR-0005 | Type/unit + production smoke |

## SUB — Submission & L2 (v1)

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-SUB-1** | A `priceSensitive` step cannot be executed via a path flagged public/permissionless | ADR-0003 | Executor admission + private-relay tests |
| **I-SUB-2** | The factory admits **only optimization-class** policies in v1 | ADR-0004 | Unit |
| **I-SUB-3** | After acquiring the signer lane and immediately before a write, at least two independently configured RPC origins agree on one recent canonical `(blockNumber, blockHash)` and return the same successful execution simulation at that exact block | report late-block simulation + ADR-0004 | Executor quorum, conflicting-head, conflicting-result, and signer-lane tests |
| **I-SUB-4** | Wrong-chain, stale/future-skewed, excessively lagging, unavailable, or disagreeing node views fail closed; ordered RPC fallback alone never authorizes a signer | report late-block simulation + ADR-0004 | Executor admission and stale-sequencer tests |
| **I-SUB-5** | Receipt observation and L2 confirmations do not release the signer outbox until the same independent-node quorum agrees on an L1-derived `finalized` L2 block at or beyond the receipt and attests the exact transaction hash, block number/hash, and status | ADR-0004 | Receipt-outbox finality quorum, conflicting-primary fork, missing-transaction, missing-evidence, and reorg tests |

*(Permissionless protective-zap triggering and an L1 force-inclusion escape hatch remain deferred
to the v1.x protective-zap ADR. Optimization-zap late-block and finality admission are implemented
in the executor source but remain operationally off until an independent RPC set is configured.)*

---

## Production-readiness gate

Sharpened from the report's adversarial checklist. **Every answer must be "no"**, and each maps to
the invariants that enforce it. Ship to mainnet only when all hold and the repository's applicable
unit, fuzz, invariant, fork, integration, and operational tests pass. External audit and formal
verification are explicitly outside this release's scope and must not be represented as completed.

| Adversarial question | Must be "no" via |
|---|---|
| Can any zap call an unapproved target or selector? | I-SURF-1, I-SURF-2 |
| Can any authorization replay across chains, versions, or factories? | I-AUTH-2, I-AUTH-5 |
| Can any approval remain after success or failure? | I-APPR-1 |
| Can a relayer redirect, resize, replay, or directly spend a Permit2 owner-pull authorization? | I-AUTH-2, I-AUTH-7, I-FLOW-5 |
| Can Hermes improve its authority relative to the signed policy? | I-AUTH-3, I-AUTH-4, I-FLOW-2, I-FLOW-3 |
| Can a malicious triggerer worsen price/timing without violating a postcondition? | I-FLOW-2, I-SUB-1 (+ ADR-0004 scope) |
| Can the user always revoke, halt its frozen policy, or withdraw off the fast path? | I-REC-1, I-REC-2, I-REC-3, I-REC-4 |
| Can a shared-implementation bug brick or drain all zaps at once? | I-ISO-1, I-ISO-2, I-ISO-3 |
| Can one stale, disagreeing, or non-final node view authorize or settle a signer write? | I-SUB-3, I-SUB-4, I-SUB-5 |
| Can a fee-on-transfer / rebasing token corrupt accounting? | I-TOK-1, I-TOK-2, I-FLOW-1 |
| Can app creation succeed without the exact visible fee becoming floor-bounded 0xZAPS? | I-FEE-1, I-FEE-2, I-FEE-3, I-FEE-5, I-FEE-8 |
| Can the fee gateway change capsule runtime, domain, or factory lineage? | I-FEE-4 |
| Can governance or an unsolicited transfer drain or inflate the creation pot? | I-FEE-6, I-FEE-7 |

**Coverage budgets (recommended minimums):** Foundry invariant runs ≥ 50k with ≥ 10 mock
adapters and the FoT/rebasing mocks in the token pool; Certora rules green on the full rule set with
no `sanity` failures; fork suite green against the actual v1 adapter set on a recent Base block.
