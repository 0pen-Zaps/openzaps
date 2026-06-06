# OpenZaps v1 — Internal Adversarial Audit (2026-06-06)

**Method:** multi-agent adversarial review — 8 independent reviewers across distinct attack-surface
lenses (reentrancy/ordering, access/init/clone, signature/replay, approval/accounting, economic/MEV,
recovery/governance, factory-assembly, Solidity pitfalls). Each raw finding was then cross-examined by
3 skeptics (correctness / exploitability / design-intent lenses); a finding was kept only if ≥2 of 3
skeptics confirmed it was real and actionable. 36 raw findings → **9 confirmed** (27 refuted as false
positives, duplicates, or intended design).

> This is an **internal** pass, not a substitute for a professional third-party audit (still required —
> see `../README.md` security notice and the production-readiness gate in `../../docs/invariant-spec.md`).

## Confirmed findings & resolutions

| # | Sev | Finding | Resolution | Regression test |
|---|-----|---------|-----------|-----------------|
| 1 | **Critical** | `createZap` keyed the CREATE2 address on `salt` alone, so an attacker could front-run with their own policy and seize a victim's predicted, pre-funded address, then `emergencyExit` it. | Bind the salt to the full policy: `keccak256(abi.encode(p, salt))` in both `createZap` and `predict`. A different policy now maps to a different, un-funded address. | `test_saltBoundToPolicy_preventsHijack` |
| 2 | High | Settlement read the **absolute** `outAsset` balance, not the run delta — standing principal, dust, or a mid-loop deposit got counted as output and paid out (violates I-FLOW-4). | Snapshot `balanceOf(outAsset)` before the loop; settle `post − pre` (underflow-reverts if no real gain). | `test_settlementUsesRunDeltaNotStandingBalance`, `test_settlement_revertsIfNoRealOutput` |
| 3 | High | `initialize` never checked `p.owner != 0`; a zero-owner clone bricks `emergencyExit`/`invalidateNonce` (funds unrecoverable) and lets a junk signature pass (`ecrecover → 0 == owner`). | Revert `ZeroOwner` at init; additionally reject a recovered `address(0)` in `_verifySignature`. | `test_rejects_zeroOwnerPolicy` |
| 4 | Medium | `intent.outAsset` was never checked against the curated allowlist at execution — a fee-on-transfer/rebasing token could break accounting. | Require `TOKENS.isAllowed(intent.outAsset)` in `execute`. | `test_rejects_outAssetNotAllowlisted` |
| 5 | Medium | `maxGas` was signed (in the EIP-712 struct) but never enforced — the relayer had unbounded gas discretion (violates I-AUTH-4). | Enforce `gasleft() <= intent.maxGas` at the top of `execute`. | `test_rejects_gasLimitAboveSignedCap` |
| 6 | Low | Governance allowlists used single-step `transferOwnership`; a fat-fingered transfer permanently strips the only cross-clone adapter kill-switch. | Two-step ownership (`transferOwnership` → `acceptOwnership`) on `AdapterRegistry` and `TokenAllowlist`. | `test_registry_twoStepOwnership`, `test_registry_onlyPendingCanAccept` |
| 7 | Low | No cap on `steps`/`trackedAssets` length; an oversized immutable policy could deploy into a permanently gas-bricked `execute`. | Bound `MAX_STEPS`/`MAX_TRACKED` (16) at init. | `test_rejects_tooManySteps` |

## Notable refutations (not changed, with reason)

- *emergencyExit lacks a reentrancy guard* — refuted: it makes no callback before state finalization and
  moves only the owner's own funds.
- *Relayer always charges max fee / free option* — refuted: this is the intended bounded-fee design
  (ADR-0003); the fee is capped by the signed `maxRelayerFee` and the policy cap, and net-of-fee min-out
  protects the recipient.
- *`maxGas` should be removed* — superseded by enforcing it (finding 5) to honor ADR-0003.

## Post-fix status

`forge test`: **47 passed, 0 failed** (unit + fuzz + stateful invariants, 0 invariant reverts).
