# Fee-share time wraps and automations on Robinhood Chain

Status: reviewed design, pre-implementation. Prepared 2026-08-02.

This design ports the useful parts of the PoolFans tokenized-fee product line
(pool.fans) onto the live 0xZAPS fee-share setup on Robinhood Chain (4663),
through OpenZaps' own invariants: bounded immutable terms, permissionless
upkeep, fail-closed reads, no yield claims.

## What already exists here

The 4663 stack already has the two hardest pieces, live and verified:

- **Tokenized fee claims.** The fee vault (`0x31D6…7338`) holds the reward
  slot for 100% of the 0xZAPS Clanker LP fees (locker `rewardBps = 10000`,
  single recipient) and minted a fixed 100 ERC-20 fee shares. A share is a
  perpetual pro-rata claim on harvested WETH — pool.fans' "programmable
  rights", already onchain.
- **A rev staking pool.** The fee campaign (`0x57d7…582F`) is exactly the
  pool.fans "Rev Staking Pool": community stakes the token for a defined
  period and splits a share of trading fees. Live since 2026-08-03 00:23 UTC.

## Adopt / adapt / reject

| pool.fans feature | Decision | Why |
|---|---|---|
| Rev Staking Pools | already live | The fee campaign is this product. |
| Time-Wrappers ("lock revenue tokens, mint time-wrapped shares") | **adapt** | The instrument is right: sell a *term* of fee flow while keeping the principal. The Base implementation details (1:1,000,000 mint ratio, optional `lockDuration()` getter that reverts) are accidents, not benefits — we mint 1:1 and make the maturity an immutable constructor term. |
| Automations ("auto-route claimed fees to swap into any token") | **adapt, narrowed** | "Any token, any path" is a generic router — rejected by product invariant. The 4663 version welds ONE route (vault WETH → pinned aeWETH↔0xZAPS adapter → depositor) with a signed floor. Reinvestment without an editable path. |
| Initial Revenue Offerings / wrapper auctions | **defer** | Selling future fee claims is a sale-of-revenue surface; PoolFans' own revenue-purchase safety checklist applies. Nothing ships until that review exists. The wrapper is *compatible* with a later sale surface because wrapped units are transferable ERC-20s. |
| "Fee receipt options" (WETH/token splits) | reject for v1 | The vault pays WETH only; a receipt-split adds a second asset path for no current user. |

## Contract 1 — `FeeShareTermWrap` (+ factory)

A term-bound coupon strip over fee shares, shaped on the proven campaign
accounting rather than ported Base code.

- **Deposit window → term → claim tail.** Immutable `depositUntil`,
  `maturity`, `claimDeadline`. Depositors move fee shares in before
  `depositUntil` and are minted transferable wrapped units 1:1 (18 dp).
- **During the term** anyone may `harvest()` (vault `claimFor(wrapper)`)
  and `sync()`; accounting is `cumulativeRewardPerShare` over wrapped
  supply, identical in shape to the live campaign. Wrapped holders
  `claim()` WETH at any time. Because wrapped units transfer, the term's
  fee flow is itself tradable — pool.fans' "presell future fees" benefit —
  without selling the principal.
- **Principal reversion.** The original depositor's share principal is
  recorded per account; after `maturity`, `redeemShares()` returns exactly
  the deposited fee shares to the depositor. Wrapped units stop accruing at
  maturity (final sync caps accounting), mirroring the campaign's fixed end.
- **Expiry.** WETH unclaimed after `claimDeadline` is sweepable to the
  depositor pool pro-rata — the same expiring-claims rule the campaign
  already discloses.
- Fail-closed: harvest before term start reverts; deposits after
  `depositUntil` revert; a wrapper never holds authority over anything but
  its own deposited shares and claimed WETH.

## Contract 2 — `FeeShareAutoCompounder`

The narrowed automation: deposit fee shares, keep them withdrawable at any
time, and let permissionless upkeep route your WETH into 0xZAPS.

- `harvestAndRoute()` — anyone pays gas: claims the vault WETH accrued to
  the compounder, swaps through the **constructor-pinned** aeWETH↔0xZAPS
  pool adapter (the same adapter lineage the app already allowlists), and
  pays 0xZAPS out per depositor pro-rata.
- Per-depositor `minOutBps` floor against the pinned oriented price source
  (v3.2's floor pattern); a run that cannot clear every affected floor
  reverts rather than degrading anyone's execution.
- No action arrays, no paths, no empty configs (the Base `NoActions()`
  lesson becomes: there is exactly one action and it is immutable). "Hold"
  is simply not depositing.

## The new use case — fee-funded agent budgets

Composition none of the referenced products have: **a fee stream that pays
for its own automation.** A `FeeShareTermWrap` whose `claim()` destination
is locked, at deposit time, to funding a specific bounded Zap capsule owned
by the same owner. The term's WETH coupons top up the capsule's per-run
funding; the capsule's signed policy (route, amount cap, cadence, floor,
recipient = owner) already bounds what the money can do; the executor's
trigger authority never grows.

Concretely: "my 0xZAPS pool fees fund my weekly DCA" — trading activity on
the token finances recurring, bounded execution for its holders, with every
leg (fee claim → funding → execution) permissionless to *advance* and
impossible to *widen*. This is the OpenZaps authority-map story applied to
the treasury side, and it reuses three live primitives (vault claims,
capsule funding preflight, v3.2 execution) with one new lock field on the
wrapper.

Sequencing: ship contracts 1–2 with full Foundry suites and a no-broadcast
rehearsal first (new-lineage release discipline, `docs/operations-runbook.md`);
the budget lock lands as a wrapper variant once the base wrapper has soaked.

## Release discipline

New lineage rules apply in full: unit/fuzz/invariant coverage, fork tests
against the live vault, deploy script with post-deploy readback, Sourcify
verification, canaries (create/harvest/claim/redeem/sweep), and the app
surface fails closed until a seven-address-style config set is complete.
Nothing in this design is a yield promise: every surface inherits the
"rewards are whatever trading produces" boundary the campaign already
states.
