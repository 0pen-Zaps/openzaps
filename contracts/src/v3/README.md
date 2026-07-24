# OpenZap v3 — recurring & triggered execution, and the executor economy

**Status: UNAUDITED CANDIDATE.** Nothing in `src/v3/` is deployed; the live v1.1 deployment is
untouched. Deploy with [`script/DeployV3Robinhood.s.sol`](../../script/DeployV3Robinhood.s.sol).

## What v3 adds

v1/v2 capsules hold ONE owner-signed step graph that executes ONCE. v3 keeps that path
byte-for-byte (including v2's balance-relative steps) and adds exactly two new **execution types**,
both standing authorizations whose firing condition the capsule verifies **on-chain**:

| Type | Signature covers | The chain enforces |
| --- | --- | --- |
| **Recurring** — `executeRecurring(RecurringIntent, sig)` | interval, max runs, window, per-run net floor | `IntervalNotElapsed`, run counting, exhaustion consumes the series id |
| **Triggered** — `executeTrigger(TriggerIntent, sig)` | allowlisted price source, baseline, threshold bps, direction | `TriggerNotMet` until the source reports the market past the bound; fires once |

This is ADR-0004's deferred trigger model made concrete: **permissionless, on-chain-conditioned
submission** — any executor can fire a run that is owed; no executor can fire one that is not.
The executor chooses *when* (within the owner's bounds) and nothing else: route, amounts,
recipient, out-asset, and floors stay frozen/signed exactly as in v1/v2.

A recurring series is cancelled with the existing `invalidateNonce(seriesId)`; a held trigger the
same way. `emergencyExit` is unchanged and unconditional.

## Executor economy (the fee loop)

Executors are paid from output, at settlement, by the capsule itself — no registration, no stake:

```
run output (measured delta)
├── 1% protocol fee
│   ├── 80% → msg.sender (the executor that submitted the run)
│   └── 20% → ZapLotteryPot  ──buyZaps()──▶ 0xZAPS ──▶ current round's prize
└── 99% → recipient   (minOut/minOutPerRun floors THIS number)
```

- The legacy one-shot path pays **no** protocol fee (v2 relayer-fee semantics preserved).
- `ZapLotteryPot.buyZaps` is permissionless and bounded to ONE pinned adapter; the pot's value can
  only leave as a round prize, in 0xZAPS, to an address holding tickets in that round. There is no
  owner drain.
- Every fee contribution credits lottery **tickets** to the zap owner (`ContributionRecorded`
  events carry the full detail). **Winner selection is deliberately deferred** — until a
  randomness/draw ADR lands, `awardRound` is governance-gated but hard-bounded as above. The
  on-chain ticket counter is a coarse participation gate; any fair weighting can be computed from
  the event log without a migration.

## Security argument (delta over v2)

1. **Recurring** removes the one-run bound and replaces it with owner-signed `maxRuns × interval ×
   window`. Progress is written before any external call; exhaustion consumes the series id; the
   per-run net floor re-arms every run. A submitter's only power remains timing inside windows the
   owner already authorized.
2. **Triggered** adds one read-only external dependency: the price source. It is allowlisted in a
   dedicated registry (compromise = de-allowlist = kill-switch, same governance shape as
   adapters), named in the signature (the submitter cannot substitute it), and read AFTER nonce
   consumption inside the reentrancy guard. A spot price is manipulable within a block — the
   threshold is an ARMING condition, not a fair-value oracle: the worst a manipulator achieves is
   running the owner's own pre-signed trade at a moment the owner authorized, while paying the
   pool to move it. The owner's `minOut` still floors the result.
3. **Fee split** is constants-only arithmetic on the measured output delta; `minOut` is checked
   net of fee (I-FLOW-2), conservation `net + executorCut + potCut == out` holds by construction.
   The pot's `notifyContribution` is record-only (it can never pull), restricted to
   factory-registered clones.
4. Everything else — isolation, atomic init, exact approvals, single-asset settlement, emergency
   exit, EIP-712/ERC-1271 verification (domain version "3") — is v2 verbatim.

Tests: `test/OpenZapV3.recurring.t.sol`, `test/OpenZapV3.trigger.t.sol`,
`test/ZapLotteryPot.t.sol`, plus the off-chain loop's live E2E in `executor/e2e-local.mjs`.

## The off-chain half

[`executor/`](../../../executor/README.md) hosts the reference **Zap Executor** daemon: watches
time and the price source, simulates due runs, submits them when a gas key is configured
(watch-only otherwise), and periodically converts pot fee assets to 0xZAPS. It holds no user funds
or keys; losing it loses fee income, not principal.
