# OpenZaps v1 — Contracts

Immutable, ERC-20-first **intent lockers** for Hermes-triggered DeFi. A zap is a per-user, single-policy
contract that holds the user's funds and a frozen action graph; a relayer (Hermes) can only submit
**owner-signed EIP-712 intents that match that policy exactly**, with zero discretion.

This implementation encodes the four accepted ADRs in [`../docs/adr/`](../docs/adr/README.md) and is
verified against the invariants in [`../docs/invariant-spec.md`](../docs/invariant-spec.md).

> ## ⚠️ Security status: LIVE, INTERNALLY TESTED, PRE-EXTERNAL-AUDIT
>
> Three generations are deployed on Robinhood Chain: **v1.1** (single-shot routes), **v3**
> (recurring + price-triggered execution and the executor fee/lottery economy), and **v3.1**
> (per-run floors priced from live spot). They ship with passing unit/fuzz/invariant tests, Slither
> review, live-pool fork tests in both directions, a full Factory/clone/EIP-712 fork test, exact
> Sourcify matches, and successful bounded mainnet smoke zaps. They have **not** had a professional
> third-party audit or formal prover run. Keep deposits scoped, use narrow allowlisted adapters, and
> preserve the owner-only `emergencyExit` path until those external gates are complete.
>
> Addresses and broadcast records: [`../docs/deployments.md`](../docs/deployments.md).
>
> **Source/live boundary:** the base-lineage source now identifies as `1.2.0-candidate` and includes
> one-way owner halt plus a Permit2 SignatureTransfer owner-pull entry point. The live v1.1
> implementations listed in `docs/deployments.md` predate both additions and do not gain them
> retroactively. This candidate requires a new deployment, independent bytecode verification, and
> a separate release decision.

## Architecture

```
User EOA / Safe ──deploy policy──▶ OpenZapFactory ──CREATE2 clone──▶ OpenZap (immutable, holds funds)
        │                                                                  ▲
        ├──deposit assets + sign EIP-712 intent──────────────────────────┤
        └──or approve Permit2 + sign witnessed one-shot pull─────────────┤
                                                                           │ owner-signed intent
Hermes / relayer ──simulate / private submit / monitor────────────────────┘
                                                                           │ fixed adapter calls only
                                                                           ▼
                                              AdapterRegistry ◀──allowlist── Allowed DeFi protocols
```

| Contract | Role |
|---|---|
| [`OpenZap.sol`](src/OpenZap.sol) | The immutable per-zap instance (clone target). `initialize`, pre-funded `execute`, witnessed `executeWithPermit2`, one-way `haltPolicy`, `emergencyExit`, and `invalidateNonce`; EIP-712 + ERC-1271 verification. |
| [`OpenZapFactory.sol`](src/OpenZapFactory.sol) | Versioned factory; deploys the hardened implementation in its constructor, then atomically deploys + initializes EIP-1167 clones; publishes `implCodeHash` for Hermes manifest checks. |
| [`OpenZapCreationGateway.sol`](src/fee/OpenZapCreationGateway.sol) | Fee-enforcing app gateway in front of the existing v1.1/v3/v3.1 factories. Charges exactly 0.00001 native ETH, wraps and atomically converts it through the pinned aeWETH → 0xZAPS adapter, and reverts the underlying factory creation if conversion misses the caller-reviewed floor. |
| [`OpenZapStackCreationGateway.sol`](src/fee/OpenZapStackCreationGateway.sol) | Source-only v3.2 gateway pinned to one recurring-stack factory. It creates and binds a separate no-drain creation pot inside its constructor transaction, preserving the live legacy creation round while retaining the same exact-fee, reviewed-floor, residue-free rollback guarantees. |
| [`ZapCreationFeePot.sol`](src/fee/ZapCreationFeePot.sol) | No-drain, balance-backed 0xZAPS pot for converted creation fees. Credits tickets to the policy owner; governance can only award the accounted round prize to an address with tickets. |
| [`AdapterRegistry.sol`](src/AdapterRegistry.sol) | Two-step-owned allowlist of adapter contracts; production is narrowed to the pinned Robinhood adapter. |
| [`TokenAllowlist.sol`](src/TokenAllowlist.sol) | Curated ERC-20 allowlist (excludes fee-on-transfer / rebasing). |
| [`RobinhoodV4SwapAdapter.sol`](src/adapters/RobinhoodV4SwapAdapter.sol) | Chain-4663-only, one-pool adapter for pool WETH ↔ 0xZAPS through the pinned Bags Universal Router and Permit2 path. |
| [`libraries/SafeApprove.sol`](src/libraries/SafeApprove.sol) | Exact-approval + transfer helpers tolerant of non-standard ERC-20s. |
| [`interfaces/IAdapter.sol`](src/interfaces/IAdapter.sol) | The single fixed interface every step routes through — **no arbitrary `target`/`calldata`**. |

## Design guarantees (and where they live)

- **No arbitrary calls.** A zap only ever calls `IAdapter(allowlisted).execute(...)` with a constant
  selector and frozen `data`. (ADR-0001; invariant I-SURF-1)
- **Submitter has zero discretion.** Every authority-bearing field — recipient, fee cap, gas, deadline,
  route output, min-out — is bound in the owner-signed EIP-712 intent; `policyHash` is checked against
  the frozen policy. (ADR-0001/0003; I-AUTH-3/4)
- **Authorization consumed before any external call;** `nonReentrant`. (I-AUTH-1)
- **Permit2 owner pull is one-shot and capsule-bound.** SignatureTransfer witnesses the exact
  OpenZap intent digest; the first frozen step supplies the only token/amount; the capsule is both
  implicit spender and fixed destination; the deadline is capped at one hour and at the intent
  deadline. The executor receives no allowance. Exact received and consumed deltas are enforced.
  The owner still needs an ERC-20 allowance to canonical Permit2. (ADR-0001; I-AUTH-7/I-FLOW-5)
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

Opt-in live Robinhood fork gates:

```bash
RUN_ROBINHOOD_FORK=true ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
  forge test --match-contract RobinhoodV4ForkTest -vv
RUN_ROBINHOOD_FORK=true ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
  forge test --match-contract RobinhoodOpenZapForkTest -vv
```

Formal-verification rule sketches (Certora) live in [`certora/`](certora/README.md) — these require a
Certora license/CI to run and are the next hardening step, not part of `forge test`.

## Deploy

Robinhood deployment and bounded smoke scripts:

```bash
DEPLOYER_PRIVATE_KEY=<key> GOVERNANCE=<owner> forge script \
  script/DeployRobinhood.s.sol:DeployRobinhood \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --slow

DEPLOYER_PRIVATE_KEY=<key> forge script script/SmokeRobinhood.s.sol:SmokeRobinhood \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --slow
```

Addresses, transaction hashes, ownership state, verification, and smoke evidence are recorded in
[`../docs/deployments.md`](../docs/deployments.md).

Production ownership and pending-owner state are recorded in `../docs/deployments.md`. A Safe behind a
timelock remains the recommended destination before adding any new adapter or token.
