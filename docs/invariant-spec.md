# OpenZaps v1 Invariant Specification

**Status:** Draft · **Date:** 2026-06-06 · **Scope:** v1 = optimization-class, deposit-based,
fully-immutable per-zap instances deployed as hardened EIP-1167 clones over a curated ERC-20
allowlist (see [ADR-0001](adr/0001-authority-model-and-policy-binding.md),
[ADR-0002](adr/0002-deployment-and-instance-isolation.md),
[ADR-0003](adr/0003-submission-privacy-vs-censorship.md),
[ADR-0004](adr/0004-protective-vs-optimization-zaps.md)).

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

## SUB — Submission & L2 (v1)

| ID | Invariant | Source | Method |
|---|---|---|---|
| **I-SUB-1** | A `priceSensitive` step cannot be executed via a path flagged public/permissionless | ADR-0003 | Policy-compilation test |
| **I-SUB-2** | The factory admits **only optimization-class** policies in v1 | ADR-0004 | Unit |

*(Protective-zap triggering and L2 finality/sequencer-outage invariants are deferred to the v1.x
protective-zap ADR.)*

---

## Production-readiness gate

Sharpened from the report's adversarial checklist. **Every answer must be "no"**, and each maps to
the invariants that enforce it. Ship to mainnet only when all hold *and* each invariant has a passing
Certora proof or a fuzz campaign meeting its state/run budget.

| Adversarial question | Must be "no" via |
|---|---|
| Can any zap call an unapproved target or selector? | I-SURF-1, I-SURF-2 |
| Can any authorization replay across chains, versions, or factories? | I-AUTH-2, I-AUTH-5 |
| Can any approval remain after success or failure? | I-APPR-1 |
| Can Hermes improve its authority relative to the signed policy? | I-AUTH-3, I-AUTH-4, I-FLOW-2, I-FLOW-3 |
| Can a malicious triggerer worsen price/timing without violating a postcondition? | I-FLOW-2, I-SUB-1 (+ ADR-0004 scope) |
| Can the user always revoke, invalidate, or withdraw off the fast path? | I-REC-1, I-REC-2, I-REC-3 |
| Can a shared-implementation bug brick or drain all zaps at once? | I-ISO-1, I-ISO-2, I-ISO-3 |
| Can a fee-on-transfer / rebasing token corrupt accounting? | I-TOK-1, I-TOK-2, I-FLOW-1 |

**Coverage budgets (recommended minimums):** Foundry invariant runs ≥ 50k with ≥ 10 mock
adapters and the FoT/rebasing mocks in the token pool; Certora rules green on the full rule set with
no `sanity` failures; fork suite green against the actual v1 adapter set on a recent Base block.
