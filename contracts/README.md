# OpenZaps v1 — Contracts

Immutable, ERC-20-first **intent lockers** for Hermes-triggered DeFi. A zap is a per-user, single-policy
contract that holds the user's funds and a frozen action graph; a relayer (Hermes) can only submit
**owner-signed EIP-712 intents that match that policy exactly**, with zero discretion.

This implementation encodes the four accepted ADRs in [`../docs/adr/`](../docs/adr/README.md) and is
verified against the invariants in [`../docs/invariant-spec.md`](../docs/invariant-spec.md).

> ## ⚠️ Security status: PRE-AUDIT — NOT production-ready for mainnet funds
>
> This is a complete, compiling, internally-tested **reference implementation**. It passes a local
> Foundry unit + invariant suite (47 tests, 0 failures) and an internal multi-agent adversarial audit
> whose 9 confirmed findings — including a critical clone-hijack — have been fixed and regression-tested
> ([`audit/internal-audit-2026-06-06.md`](audit/internal-audit-2026-06-06.md)). It has **NOT** had a
> professional third-party audit, formal-verification runs against a prover, testnet soak, or economic
> review. Per the production-readiness gate in `../docs/invariant-spec.md`, **do not deploy to mainnet
> with real funds** until those external gates (ADR/checklist P2 items) are complete.

## Architecture

```
User EOA / Safe ──deploy policy──▶ OpenZapFactory ──CREATE2 clone──▶ OpenZap (immutable, holds funds)
        │                                                                  ▲
        └──deposit assets + sign EIP-712 intent───────────────────────────┤
                                                                           │ owner-signed intent
Hermes / relayer ──simulate / private submit / monitor────────────────────┘
                                                                           │ fixed adapter calls only
                                                                           ▼
                                              AdapterRegistry ◀──allowlist── Allowed DeFi protocols
```

| Contract | Role |
|---|---|
| [`OpenZap.sol`](src/OpenZap.sol) | The immutable per-zap instance (clone target). `initialize`, `execute(intent,sig)`, `emergencyExit`, `invalidateNonce`; EIP-712 + ERC-1271 verification. |
| [`OpenZapFactory.sol`](src/OpenZapFactory.sol) | Versioned factory; deploys the hardened implementation in its constructor, then atomically deploys + initializes EIP-1167 clones; publishes `implCodeHash` for Hermes manifest checks. |
| [`AdapterRegistry.sol`](src/AdapterRegistry.sol) | Global allowlist of adapter contracts (the `(adapter, selector)` surface). Governed by a Safe + timelock. |
| [`TokenAllowlist.sol`](src/TokenAllowlist.sol) | Curated ERC-20 allowlist (excludes fee-on-transfer / rebasing). |
| [`libraries/SafeApprove.sol`](src/libraries/SafeApprove.sol) | Exact-approval + transfer helpers tolerant of non-standard ERC-20s. |
| [`interfaces/IAdapter.sol`](src/interfaces/IAdapter.sol) | The single fixed interface every step routes through — **no arbitrary `target`/`calldata`**. |

## Design guarantees (and where they live)

- **No arbitrary calls.** A zap only ever calls `IAdapter(allowlisted).execute(...)` with a constant
  selector and frozen `data`. (ADR-0001; invariant I-SURF-1)
- **Submitter has zero discretion.** Every authority-bearing field — recipient, fee cap, gas, deadline,
  route output, min-out — is bound in the owner-signed EIP-712 intent; `policyHash` is checked against
  the frozen policy. (ADR-0001/0003; I-AUTH-3/4)
- **Authorization consumed before any external call;** `nonReentrant`. (I-AUTH-1)
- **Exact approvals, reset to zero** after every step on success and every revert path. (I-APPR-1/2)
- **Unconditional owner emergency exit**, routing through no adapter, independent of adapter/Hermes
  state. (eval Gap 2; I-REC-1/2)
- **Immutable clones** of a stateless, fundless implementation with no `selfdestruct`/`delegatecall`
  and atomic factory-only init. (ADR-0002; I-ISO-1/2/3)
- **v1 is optimization-only** — protective/liquidation zaps are rejected at init. (ADR-0004; I-SUB-2)

## Build & test

```bash
cd contracts
forge install foundry-rs/forge-std   # first time only (lib/ is gitignored)
forge build
forge test -vvv
```

Foundry config pins `solc 0.8.34`, `via_ir = true`, EVM `cancun`. The suite covers AUTH, APPR/FLOW,
SURF, REC, ISO/TOK dimensions plus stateful invariants (`test/OpenZap.invariants.t.sol`).

Formal-verification rule sketches (Certora) live in [`certora/`](certora/README.md) — these require a
Certora license/CI to run and are the next hardening step, not part of `forge test`.

## Deploy

```bash
GOVERNANCE=<safe-address> forge script script/Deploy.s.sol --rpc-url <url> --broadcast
```

After deploy: transfer registry + allowlist ownership to a Safe behind a `TimelockController`, then
allowlist the vetted adapters and tokens before creating any zaps.
