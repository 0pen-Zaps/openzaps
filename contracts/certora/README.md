# Certora formal-verification layer

These specs are the **formal layer** referenced by [`../../docs/invariant-spec.md`](../../docs/invariant-spec.md).
They complement — they do not replace — the Foundry invariant suite. Per the invariant spec's toolchain
table, Certora/Halmos carry the call-ordering and reachability properties that SMTChecker is blind to
across the adapter call-loop.

> Status: **illustrative rule sketches.** Running them requires a Certora Prover license and a CI
> harness (`certoraRun`). They are written to be the starting point for the external formal-verification
> engagement (checklist P2), not a passing local gate.

## Mapping

| Rule (in `OpenZap.spec`) | Invariant | Statement |
|---|---|---|
| `noResidualApproval` | I-APPR-1 | After `execute`, allowance to any spender is 0 (success and revert). |
| `policyHashIsImmutableGate` | I-AUTH-3 | `execute` reverts unless `intent.policyHash == policyHash`. |
| `nonceConsumedOnce` | I-AUTH-2 | A consumed nonce can never execute again. |
| `initializeOnce` | I-ISO-3 | `initialize` succeeds at most once and only from the factory. |
| `emergencyExitAlwaysAvailable` | I-REC-1 | The owner can always drain tracked balances regardless of state. |

## Run (when licensed)

```bash
certoraRun contracts/src/OpenZap.sol \
  --verify OpenZap:contracts/certora/OpenZap.spec \
  --solc solc8.34 --optimistic_loop
```
