# Staking Campaign 2: a 14-day 50/50 split with Hook Blocks

Status: reviewed design, implementation in this change. Prepared 2026-08-14.

The second 0xZAPS fee campaign commits **100% of the tokenized fee stream**
for a fixed 14-day window, split two ways:

- **50% of the WETH trading fees stream to 0xZAPS stakers** — the same
  proven staking-campaign mechanics as campaign 1.
- **50% market-buys $HOOKR and burns it** — every purchase is sent to the
  dead address `0x…dEaD` in the same transaction that buys it, and recorded
  as one permanent entry in an append-only Hook Blocks ledger.

Every trade on the 0xZAPS pool therefore does two things during the window:
pays stakers in WETH, and permanently removes $HOOKR from circulation.

**Honest framing, fixed:** HOOKR's runtime exposes no `burn`/`burnFrom` (only
the standard ERC-20 set plus `permit`, verified from its bytecode on 4663), so
`totalSupply()` does NOT decrease. The tokens leave circulation to an address
with no recoverable key. Never call this deflationary or supply-reducing.

## Verified live state this design builds on (RPC, 2026-08-14)

- Campaign 1 (`0x57d7…582F`) is **finalized**; its 50 fee shares returned to
  the sponsor. The sponsor (`0x5a52…4aA2`) holds **all 100 vault shares**, so
  a 50 + 50 allocation is fundable today. `rewardsSwept` is still false —
  staker claims stay open until 2026-09-09; campaign 2 does not touch them.
- The fee vault (`0x31D6…7338`) is activated and still the sole reward
  recipient of the 0xZAPS Clanker LP fee position. Pending locker fees at
  read time: ~0.0124 aeWETH. The vault pays exactly one reward asset,
  aeWETH (`0x0Bd7…AD73`, `withdraw(uint256)` verified present).
- $HOOKR is `0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c` (18 dp, 1B supply,
  minted through the OpenZaps token launcher). Its one real market is the
  **hookless** v4 pool on hookr's own vanilla v4-core PoolManager
  (`0x8366…0951`): key `(native ETH, HOOKR, fee 2500, tickSpacing 25,
  hooks 0x0)`, poolId `0x590dcb6a…5fdf`, ~8 ETH in-range depth, lpFee 2500
  pips + protocol fee 400 pips per direction (slot0-verified). Three other
  HOOKR pools exist, charge 72–87%, and have never been swapped; they are
  rejected.
- The Robinhood Universal Router adapters cannot serve this buy: the pool
  lives on a different PoolManager and is native-ETH-quoted, which
  `RobinhoodV4PoolAdapter` refuses by design. The buy leg must swap the
  PoolManager directly (vanilla v4 `unlock` → `swap` → `take`/`settle`).

## Architecture: two legs over the existing 100 shares

The vault already tokenizes the fee stream into 100 fixed ERC-20 shares.
"Use 100% of fees" means: put all 100 shares to work for the window.

```
             Clanker LP fees (aeWETH, permissionless harvest)
                              │
                 fee vault 0x31D6…7338 (100 shares)
                    │                       │
        50 shares → leg A          50 shares → leg B
   OXZAPSFeeCampaignV1 (new     HookBlocks (new contract,
   instance, 14-day term)       this repo)
        │                            │
   stakers claim WETH        claim WETH → unwrap → swap
                             native ETH → HOOKR on the
                             pinned pool → burn to 0x…dEaD
```

### Leg A — staking campaign, proven artifact, new term

Campaign 1's `OXZAPSFeeCampaignV1` ran a full live cycle (fund → stake →
harvest → finalize → claims) with real users. Campaign 2 redeploys the SAME
source artifact from the same build tree with a new constructor term:

- `startAt` = funding cutoff chosen at deploy (pre-staking opens on fund),
- `endAt` = `startAt + 14 days`,
- `claimDeadline` = `endAt + 30 days` (campaign-1 spacing).

No Solidity changes. Same sponsor, same staking token (0xZAPS, enforced
onchain), same vault. A new address and term is a new reviewed release in
the app manifest, exactly as the campaign-1 manifest comment requires.

### Leg B — `HookBlocks` (new contract, `contracts/src/campaign/`)

An immutable, ownerless converter and ledger. One deployment, five jobs:

1. **Hold 50 fee shares for the term.** `fundFeeShares` mirrors campaign
   semantics: sponsor-only, one-time, exact-transfer, before `startAt`.
   `finalize()` after `endAt` returns exactly the deposited shares to the
   sponsor — fee flow to leg B mechanically stops when the shares leave.
2. **Claim its WETH.** Every `buyAndBurn()` first pulls the vault's accrued WETH
   for the contract (defensive try/catch, the auto-compounder pattern — an
   unavailable vault degrades to no-new-reward, never a brick).
3. **Market-buy HOOKR.** Unwraps up to `MAX_BUY_WEI` of WETH to native ETH
   and swaps it through the constructor-pinned pool key on the pinned
   PoolManager, inside this contract's own `unlock` callback. No router, no
   caller-supplied path, measured balance deltas only.
4. **Enforce a floor.** Output must clear
   `ethIn × spotPriceX96 / 2^96 × MIN_OUT_BPS / 10_000`, spot read from the
   pool's `slot0` via `extsload` in the same transaction, plus an optional
   stricter caller `minHookrOut`. A failed floor reverts and the WETH waits.
5. **Burn immediately.** The entire HOOKR balance is transferred to
   `0x…dEaD` in the same transaction that bought it, and the amount is
   measured at the DESTINATION, so the published figure is what verifiably
   landed. Each conversion is recorded as one immutable **Hook Block** —
   `(ethIn, hookrBurned, timestamp)` — appended to a public ledger with
   cumulative totals.

   The contract therefore holds **no HOOKR at rest**. This is deliberately
   stronger than holding it with no exit path: a burn is not a promise the
   contract keeps, it is a transfer that already happened. Nobody has to
   audit this bytecode to believe the tokens are gone.

   **Two accounting rules that matter, both hardened after an adversarial
   review round:**

   - The ledger records **`hookrBought`** — the measured swap output, the
     only quantity the floor was checked against — NOT the donation-inclusive
     burn. Anyone can send HOOKR to the contract; those tokens are burned too
     (nothing is stranded) and counted in `totalHookrBurned`, but crediting
     them as purchases would let a griefer inflate the campaign's published
     execution rate permanently, in an immutable record, for the price of
     tokens they chose to destroy. `totalHookrBought / totalEthSpent` is
     therefore the only honest rate, and it cannot be moved by a third party.
   - **`balanceOf(0x…dEaD)` is NOT this campaign's number.** The dead address
     is a shared sink anyone may send to. Verify by summing this contract's
     own `BoughtAndBurned`/`UnspentSwept` events, or the `balanceOf(DEAD)`
     delta across the campaign's own transactions.

### Sandwich posture (decided, documented)

A pooled permissionless swap floored on same-block spot is sandwichable —
the auto-compounder documents why. HookBlocks accepts the residual risk
with the same bounds the deployed pattern uses, because the WETH at risk is
protocol flow (never user principal) and the per-event exposure is capped:

- at most `MAX_BUY_WEI` converted per call,
- at most one `buyAndBurn()` per block (global),
- spot floor × `MIN_OUT_BPS`, plus the caller's optional stricter floor,
- fee shares themselves are never at swap risk, and staker WETH lives in a
  different contract entirely.

A TWAP floor remains the follow-up it already was for the compounder.

### Value-can-never-be-trapped, and two admin safeguards

If the HOOKR pool ever empties (its LP is NOT locked — project-token rule),
`buyAndBurn()` fails closed and WETH accumulates. Two sponsor-scoped safeguards
bound the blast radius of a broken or manipulated pipeline, and both are
structurally unable to touch burned HOOKR or divert the leg's WETH:

- **`setBuybackPaused` (sponsor only)** halts FUTURE `buyAndBurn()` calls while a
  pool is broken or being ground against the floor. It gates nothing else:
  funding, `finalize`, and the sweep run pause-or-not, so principal and
  recovery paths are never behind the switch, and pausing moves no asset.
- **`sweepUnspent` opens early for the sponsor, and burns stranded HOOKR.**
  WETH and native go to the sponsor; any HOOKR it finds (only possible if
  someone donated after conversion became impossible) is burned to `0x…dEaD`
  rather than paid out, so nothing is ever trapped and no path moves HOOKR
  anywhere but the dead address. The sponsor may recover
  residual WETH/native from `END_AT` (a stuck leg is recoverable the moment
  the term ends); everyone may from `SWEEP_AFTER` (the sponsor-less
  backstop). Payout is fixed to the sponsor on both paths, and during the
  14-day window nobody — the sponsor included — can move the leg's WETH,
  which is what keeps "100% of fees committed" verifiable.

Neither lever can reach the burned HOOKR, for the strongest reason available:
by the time either can run, the HOOKR has already left for an address nobody
controls.

## Parameters (seeded at deploy, all constructor-immutable)

| Parameter | Value | Why |
|---|---|---|
| Term | 14 days | The product ask. |
| Split | 50 shares / 50 shares | 100% of the tokenized stream, half each. |
| `MIN_OUT_BPS` | 9_700 | Pool cost is ~0.29% (2500 + 400 pips); 3% headroom tolerates impact without inviting sandwiches. |
| `MAX_BUY_WEI` | 0.05 ETH | ~2 days of the leg's expected flow (~0.023 ETH/day); bounds one sandwich. |
| `MIN_BUY_WEI` | 0.0005 ETH | Dust swaps waste more gas than they convert. |
| `SWEEP_AFTER` | `endAt + 30 days` | A month of permissionless conversion before the escape hatch opens. |

## What ships where

- **This repo:** `HookBlocks.sol` + unit/fuzz/fork tests, the Foundry deploy
  script for leg B, the campaign-2 app manifest and surfaces (fail-closed,
  null until deployed), this design doc, and the operations runbook.
- **The fee-tokenizer build tree** (campaign 1's Hardhat project): the leg-A
  redeploy of the unchanged `OXZAPSFeeCampaignV1` artifact. The runbook
  carries the exact script so the deploy is mechanical.
- **Nothing changes on live contracts.** The vault, locker wiring, campaign
  1, and every OpenZaps lineage stay untouched.

## Claims register for public copy

- Never "deflationary", never "supply reduced", never "price support", never
  "buyback" as a benefit claim, never a rate or APY. The mechanism is stated
  as flows: fees are split, one half streams to stakers, the other half is
  converted to HOOKR and sent to a dead address.
- "Burned" must always be paired with the mechanism — sent to `0x…dEaD`,
  `totalSupply()` unchanged — and should link the destination on the
  explorer so a reader can check the balance themselves.
- Reward amounts are whatever the pool's real fee flow produces, which may
  be zero; the campaign pays by time-weighted stake.
- Pre-external-audit disclosure stays on every surface, as with campaign 1.
