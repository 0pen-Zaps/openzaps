# OpenZap v2 — balance-relative input (Track A candidate)

> **This is an UNAUDITED candidate.** `OpenZapV2` / `OpenZapFactoryV2` are a *separate* implementation
> and factory in `src/v2/`. Nothing about the live v1.1 deployment changes. **This code MUST NOT
> replace the live factory, and Hermes MUST NOT submit to a v2 clone, without external security
> review.** It exists to prove out one capability and to be reviewed, not to be shipped as-is.

## What this is

A byte-for-byte copy of the hardened v1.1 core (`src/OpenZap.sol`, `src/OpenZapFactory.sol`) with
**exactly one** added capability and no other behavioural change. It reuses the same governance
contracts (`AdapterRegistry`, `TokenAllowlist`), the same `Step` / `Policy` / `OpenZapIntent` types, the
same EIP-1167 clone + CREATE2 deployment, and the same execution/settlement pipeline.

## The one change: balance-relative input

In v1, `Step.amountIn` is a **constant frozen into the policy at creation**. A step cannot consume what
the previous step produced — the amount is fixed at signing time, before anyone knows what a swap will
actually yield. This is the single biggest limit on multi-step chains: to chain step 2 onto step 1 you
must *guess* step 1's output and hardcode it, and any deviation either strands the remainder or
underflow-reverts.

v2 adds a **balance-relative input**. Set

```solidity
Step.amountIn = type(uint256).max;   // == OpenZapV2.BALANCE_RELATIVE
```

and, instead of a constant, that step spends the zap's **entire current balance of `tokenIn`, measured
at the moment the step runs** — after every prior step has settled its output into the contract. So
step *k* consumes exactly what step *k-1* produced, with zero stranding. That is the whole feature.

`type(uint256).max` is the sentinel because it can never be a real spendable balance (it exceeds any
ERC-20 `totalSupply`), so a fixed step can never be mistaken for a balance-relative one.

The entire functional diff lives in the `execute` step loop:

```solidity
uint256 amountIn = s.amountIn;
if (amountIn == BALANCE_RELATIVE) {
    amountIn = IERC20(s.tokenIn).balanceOf(address(this));   // resolve to the live balance, here
    if (amountIn == 0) revert ZeroBalanceRelativeStep(i);     // fail closed, never a silent no-op
}
// …exact-approve `amountIn`, fixed-selector adapter call with `amountIn`, reset approval to zero…
```

Everything else — every auth check, the approval reset, the single-asset settlement, the min-out
enforcement — is verbatim v1.

## What is preserved (the whole point)

Every invariant the v1 core holds still holds. Re-derived from `src/OpenZap.sol`:

| Invariant | v1 mechanism | Status in v2 |
| --- | --- | --- |
| I-AUTH-1..5 | recipient, outAsset, fee cap, deadline, nonce, gas caps, policyHash all bound by the owner's EIP-712 sig, verified & nonce consumed **before** any external call; domain separator recomputed from `block.chainid` | **Unchanged.** Same checks, same order. The choice of fixed vs balance-relative for each step is part of the frozen policy, hashed into `policyHash` and CREATE2-address-bound, so a submitter cannot flip a step's mode. |
| I-SURF-1 | adapter allowlist + single fixed `IAdapter.execute` selector; frozen `data`; re-checked at execute | **Unchanged.** Balance-relative changes only the *amount* passed; the adapter, the `spender`, the selector, and the frozen `data` are identical. |
| I-APPR-1/2 | exact approval set then reset to zero every path (success and revert) | **Unchanged.** The reset to zero is unconditional and same-call; a reverting balance-relative step rolls back the whole tx, leaving no residual approval. |
| I-FLOW-1/2/4 | settlement measures the outAsset **delta** (`balanceOf - preOut`), never the absolute balance; underflow-reverts if no gain; min-out enforced net of a bounded relayer fee | **Unchanged.** This is the load-bearing part of the safety argument (below). |
| I-REC-1/2/3 | unconditional owner-only `emergencyExit` routing through no adapter; `invalidateNonce` | **Unchanged.** |
| I-ISO-1/2/3 | implementation bricked at construction; no `selfdestruct`/`delegatecall`/upgrade; atomic factory-only init once; policy-bound CREATE2 address | **Unchanged.** |
| I-TOK-1/2 | curated token allowlist; balance-delta accounting assumes honest, non-fee-on-transfer, non-rebasing tokens | **Unchanged** (and see the note on leaning harder on honest `balanceOf`). |

## Why balance-relative is safe under the preserved `minOut`

The concern the task flags: with the per-step *amount* no longer fixed, the owner-signed `minOut` on the
final output is doing more of the work. Here is the exact argument that it is sufficient.

**Enumerate every way value can leave a zap.** In both v1 and v2, funds exit only through:

1. `intent.outAsset.safeTransfer(intent.relayer, fee)` — `fee ≤ intent.maxRelayerFee ≤ maxRelayerFeeCap`
   (owner-signed and policy-capped) and `fee ≤ out`.
2. `intent.outAsset.safeTransfer(recipient, out)` — `recipient` is the frozen policy recipient, and
   `out ≥ intent.minOut` (owner-signed), where `out` is the **measured delta** of the outAsset.
3. Adapter pulls of `tokenIn` via an exact approval — but only to an **allowlisted** adapter (`spender ==
   adapter`), reached through the **single fixed selector** with **frozen `data`**, and the approval is
   **reset to zero in the same call**.
4. `emergencyExit` — owner-only, always to the owner.

**Balance-relative touches only the amount in (3).** It does not change *who* is approved (the same
allowlisted adapter), *what* is called (same selector, same frozen `data`), that the approval is reset
to zero, or add any new outbound transfer. It relaxes no bound in (1), (2), or (4).

Therefore the only value that can reach a third party is still `out` to the recipient — floored by the
owner-signed `minOut` — plus `fee` to the relayer, capped by the owner-signed, policy-bounded fee. The
per-step `amountIn` in v1 was never the bound on what leaves the contract; it was a *functional*
requirement (you had to know the amount to sign). `minOut` is, and always was, the value bound on the
final output, and it is enforced in v2 exactly as in v1. **Removing the per-step amount bound removes no
bound on what leaves the zap.**

Two sharper points:

- **A balance-relative approval is *tighter* than what v1 already allows.** v1 places no ceiling on
  `Step.amountIn` beyond "nonzero"; an owner can freeze `amountIn = 2**200` and the zap will approve
  that to the adapter. Balance-relative caps the approval at exactly the live balance, which is always
  ≤ the zap's holdings. v2 does not widen the maximum approval a step can grant to a trusted adapter.
- **The adapter trust model is unchanged.** A malicious/compromised adapter is already outside v1's
  threat model (v1 approves it a fixed amount and trusts its frozen action); it is handled identically
  in v2 by the registry kill-switch (de-allowlist halts `execute`) and the unconditional
  `emergencyExit`. Balance-relative does not alter that model.

**Empty-balance is fail-closed.** A balance-relative step over a zero balance reverts with
`ZeroBalanceRelativeStep(index)` rather than approving zero, calling the adapter with zero, and
degrading into an opaque `InvalidAdapterResult`. Malformed runs stop cleanly.

**One honest functional caveat (not an invariant break).** A balance-relative step consumes the
*entire* balance of `tokenIn` at that point — which includes any standing/principal balance of that
token, not only the immediately-prior step's output. This is a deliberate semantics the owner opts into
by signing a policy that marks the step balance-relative (the mode is frozen into `policyHash` and
address-bound; no submitter can flip it). It is not a security regression: those funds can still exit
only as outAsset to the recipient (bounded by `minOut`) or via `emergencyExit`; nothing lets a third
party extract them, and `minOut` still floors the run. A builder who wants to preserve a standing
balance of an intermediate token simply does not make a step over that token balance-relative.

**EIP-712 domain version bumped to `"2"`.** A v2 clone lives at a different address than any v1 clone,
so `verifyingContract` already separates the two signing surfaces; the version bump makes that explicit
and lets tooling scope a signature to the balance-relative semantics. This strengthens I-AUTH; it
weakens nothing.

## What this does **not** solve

Balance-relative is one lever. It does **not** lift any of these v1 limits:

- **Single-asset settlement, unchanged.** Each step still returns exactly one `(tokenOut, amountOut)`,
  and a run still settles the delta of exactly one `outAsset`. **Splits** (one input into two kept
  outputs) and **merges** into multiple final assets remain inexpressible.
- **No bridging.** `chainId` is bound; a zap is single-chain.
- **No looping / dynamic step count.** Steps are a fixed-length (≤16) frozen array with no conditional
  or repeated execution.
- **No borrow/leverage.** `AaveV3BorrowAdapter` is proven impossible under this architecture; balance-
  relative does not change what an adapter can do.
- **All-or-nothing at a token.** Balance-relative spends the *whole* balance of `tokenIn`; it cannot
  express "spend 50%" or "balance minus a reserve". A fractional sentinel scheme is out of scope here.
- **Still trusts honest `balanceOf`.** Balance-relative leans harder on the token reporting its balance
  honestly. The curated `TokenAllowlist` already excludes fee-on-transfer and rebasing tokens (I-TOK-2);
  v2 does not relax that gate, and must not be paired with a laxer allowlist.

## Tests

`test/OpenZapV2.t.sol` ports the full v1 invariant/auth/approval/recovery/isolation/surface/audit suite
onto v2 (so every preserved invariant is re-proven against this implementation), **plus** the
balance-relative proofs:

- **`test_twoStepChain_balanceRelativeConsumesFullOutput_zeroStranding`** — the thing v1 could not do:
  step 2 is balance-relative and consumes 100% of step 1's output; asserts the intermediate token
  balance is exactly `0` afterward (zero stranding) against a mock adapter pair.
- **`test_balanceRelative_sizesToRuntimeBalance_notAConstant`** — proves the resolved amount is the
  runtime balance (50, produced at a 0.5 rate), a value written nowhere in the signed policy.
- **`test_mixedFixedAndBalanceRelative_threeStep`** — one fixed step feeding two chained balance-relative
  steps; no stranding at any hop.
- **`test_balanceRelative_emptyBalance_revertsCleanly`** /
  **`…_midChainEmptyBalance_revertsCleanly`** — a balance-relative step over an empty balance reverts
  with `ZeroBalanceRelativeStep(index)`, not silently, and leaves no residual approval.
- **`test_everyStepBalanceRelative_minOutFloor_passes` / `…_bounds`** — with *every* step
  balance-relative and no per-step amount bound left, the final `minOut` still floors the chain (passes
  at the achievable output, reverts one wei above it).
- **`test_balanceRelativeMode_isPolicyBound`** — fixed vs balance-relative are distinct policies →
  distinct hashes → distinct CREATE2 addresses; a submitter cannot flip the mode.
- **`test_balanceRelative_approvalBoundedByBalance`** — the approval equals the live balance and resets
  to zero.
- **`V2Invariants`** — stateful fuzzing driven against a balance-relative zap: `invariant_noResidualApproval`,
  `invariant_noStrandedInput` (the balance-relative zap never accumulates input across runs), and
  `invariant_implementationNeverOwned`.

Run:

```bash
forge test --match-path 'test/OpenZapV2.t.sol'   # 66 passed (8 suites)
forge test                                        # full repo suite
```

Result at authoring time: `test/OpenZapV2.t.sol` → **66 passed, 0 failed**. The full non-fork repo
suite is green except for one unrelated, untracked work-in-progress probe from a different track
(`test/AaveWithdrawProbe.t.sol`), which does not touch any v2 code.

## Verdict

The change is safe **under the preserved `minOut` and the unchanged adapter-allowlist / single-asset
settlement surface**, and only under those conditions — which is why it is delivered as a reviewable
candidate rather than a v1.1 replacement. Ship it to external review; do not point the live factory or
Hermes at it until that review clears.
