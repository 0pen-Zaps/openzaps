# SOLDERWORKS — the OpenZaps crafting line

**Status:** Design, verified against the deployed v1.1 core. **Nothing in this document is deployed.**
**Date:** 2026-07-23 · **Inputs:** the live Robinhood Chain v1.1 deployment, `docs/invariant-spec.md`,
ADR-0001–0004, and a mechanics study of Fake World Assets (fwa.fun docs + launch coverage).
**Process note:** this design survived a three-lens adversarial review (security-invariants,
tokenomics-honesty, regulatory-surface). Every required change from that review is folded in below;
the review's launch gates are reproduced verbatim in §9.

---

## 0. The design line

One rule generates everything else in this document:

> **The custody layer is never gamified.** Zap deployment, funding, execution, and `emergencyExit`
> remain deterministic, token-ungated, and untouched. Every game mechanic lives in a peripheral
> incentive layer that can read the core but can never hold user principal, gate a withdrawal, or
> add a call surface to a deployed zap.

This is not a compliance posture bolted on afterward; it is what makes the mechanics *compatible
with the product's only real asset* — the claim that a zap cannot do anything it was not signed to
do. A game that put principal at randomized risk would refute the article we are writing about it.

## 1. What we took from Fake World Assets, and what we deleted

FWA (TokenWorks, 2026) is an onchain randomized NFT acquisition protocol. Its documented mechanics,
with the exact numbers from fwa.fun/docs:

| FWA mechanic | Rule | SOLDERWORKS verdict |
|---|---|---|
| Inverse selection weighting | `weight = 1e36 / backing`; light backing = picked often | **Adapted**: scarcity/effort weighting survives as *execution-proven progression* — weight comes from costly real actions, never from randomness |
| Irrevocable standing bids | depositor pre-commits an 85%-of-backing buyback | **Adapted** as the escrow discipline: seasons must be pre-funded onchain before they exist |
| Usage-gated token launch | first 15 days, 1%/day of $FWA to purchasers + 1%/day to depositors; only obtainable by using the product | **Adapted**: emissions only for performed executions, streamed from a fixed escrowed budget over 15 days |
| Crown / top-deposit award | largest deposit earns 5% of every purchase; 10% overtake margin; vacancy folds back | **Adapted** as the Pattern Author Award (§5), re-metric'd from capital to adoption |
| Chainlink VRF draws | random NFT selection, FIFO settlement | **Deleted.** On July 3, 2026 an attacker front-ran FWA's VRF callback and steered the draw to CryptoPunk #5450 (~$66k). We do not adapt randomness; we remove it. No mechanic below contains a draw, a raffle, or a random trait — and this is a standing design rule (§9), not a preference |
| sqrt(value) reward weighting | concave weighting to favor small depositors | **Retired with reasons stated**: with free identities, any concave weight is recoverable to near-linear by splitting. FWA weighted *costly capital*; we weight *costly executions*, linearly, and defend with an enforced budget cap instead (§4) |

FWA's real lesson is not "add a lottery." It is: **supply earned through verifiable product use,
two-sided participation incentives, and irrevocable pre-commitments** — all of which survive with
the chance element removed. Deleting randomness deletes the VRF exploit class; it does **not**
delete deterministic front-running, which is why First Print minting is commit-reveal (§2).

## 2. Blueprint etching (pattern-hash collectibles)

A design's collectible identity is its **normalized pattern hash**: `keccak256` over the ordered
list of `(adapter, tokenIn, keccak256(step.data))` tuples of the frozen policy — owner, recipient,
and amounts excluded. "aeWETH → 0xZAPS via the pinned v4 adapter, buy direction" is one blueprint
no matter who deploys it or for how much.

*Why exactly these fields:* all three are frozen, write-once policy storage readable via the
deployed core's public getters (`stepCount()` / `step(i)`). A step's *output* asset is an adapter
runtime result, not frozen storage, so it is deliberately **not** part of the hash — this keeps
permissionless onchain derivation sound for arbitrary future adapters.

- **Etching** mints an ERC-721 in a `BlueprintRegistry`. The first capsule ever deployed with a
  novel pattern mints the **First Print** (serial #1); later capsules of the same pattern mint
  numbered reprints referencing it.
- **Commit-reveal, because determinism is front-runnable too:** a novel pattern hash in the mempool
  is a copyable prize. `commitEtch(keccak256(patternHash, salt, minter))` locks priority;
  `revealEtch(patternHash, salt)` mints after a minimum delay. A copier of your reveal cannot
  produce an earlier valid commit binding their own address. Two independent designers racing is a
  fair first-commit race and the UI says so.
- **Late-etch parity:** capsules deployed directly against the factory (bypassing our router) etch
  under identical rules — the registry derives the pattern permissionlessly from the capsule's
  public step data. No UX asymmetry, ever.
- **Etch fee:** a flat 0xZAPS transfer to the dead address — the system's primary sink. First
  Prints price above reprints. The etch burn is also the anti-squatting price for speculative
  mass-committing.
- **Scrap-and-recast:** burning a Blueprint you own halves the 0xZAPS fee on your next etch. Old
  designs are raw material. Scrapping a First Print retires its serial forever — a real, visible
  sacrifice, disclosed before the click.
- **Remix lineage:** an optional `parentHash` field records derivation, turning the gallery into a
  fork graph at the cost of one `bytes32`.

Today exactly **two patterns exist** (buy/sell of the one live route). That is the honest cold
start: every adapter governance later allowlists opens a new First Print race, which welds the
game's content pipeline to the real protocol roadmap.

## 3. Provable traits (honest metadata)

A trait exists **only if a frozen, publicly readable policy field backs it.** Computed by the
registry at etch time; nothing self-reported, nothing from a database, nothing from per-run intent
fields.

| Trait | Backed by |
|---|---|
| **Bounded Fee** | `maxRelayerFeeCap == 0` in frozen policy storage (checked by `execute()` before any external call) |
| **Composition** (route length, adapter set, tracked assets) | the frozen step list via `stepCount()` / `step(i)` / `trackedAssets()` |
| **Season One Etch** | etch block timestamp |

Two traits were proposed and **deleted during review**, and both deletions are disclosure copy now:

- *"Tight Tolerance" (slippage)* — `minOut` lives in each per-run signed intent, not in frozen
  policy. A slippage trait would be frontend-self-reported. Deleted.
- *"Pinned Operator" (relayer binding)* — verified against the deployed core: `intent.relayer` is a
  per-run fee **payee**, and `execute()` never restricts the submitter. No relayer pin exists in
  frozen policy storage. Deleted, and no copy anywhere may claim intents "bind who can submit."

The builder's guard-coverage meter labels each guard with its trait consequence ("hardens into
Bounded Fee" vs "design-time only — no trait"). The trait system is the honest boundary between
design-time intent and contract enforcement, made collectible.

## 4. Forge Relay and Print Run seasons (execution-proven progression)

### The counting problem, stated honestly

The deployed core has no execution counter. Nonces are arbitrary owner-chosen `uint256` values in a
one-time-use set (`nonceUsed`), and owner-only `invalidateNonce` writes storage identical to an
execution's for pure gas cost. **Nothing derivable from nonce state can distinguish a real execution
from a free flip.** So no mechanic below reads nonce storage as evidence of anything.

### ForgeRelay: counting by doing

`ForgeRelay.submit(zap, intent, sig)` is a permissionless, custody-less, discretion-less
pass-through: it forwards a fully-bound, owner-signed EIP-712 intent to `zap.execute()` and credits
the registered owner **one counted run iff the call succeeds**. The zap itself verifies signature,
nonce, deadline, and fee caps exactly as for any submitter. The relay cannot alter, reorder, delay,
or originate anything. Direct execution (Hermes, any relayer) always works identically — it just
earns no game credit.

**Registration is the integrity perimeter** (this closes the one inflation hole adversarial review
found): `register(zap)` —

1. requires `EXTCODEHASH(zap)` to equal the EIP-1167 minimal-proxy bytecode hash computed from the
   canonical factory's implementation address — a fake "capsule" with an always-succeeding
   `execute()` can never register;
2. derives the pattern hash **internally** from the capsule's frozen step data — never accepted as
   a caller parameter;
3. requires every step's frozen `amountIn` to meet a published minimum notional — dust capsules
   (`amountIn = 1 wei` is accepted by the core) would otherwise produce counted runs with ~zero
   pool-fee cost and undercut the season budget cap math;
4. binds capsule → owner → pattern permanently (a zap's owner is set once at `initialize` and has
   no transfer path — verified).

Pinned by Foundry invariant tests: *credit increments iff a relay-submitted `execute()` succeeded
in the same transaction*; *no address whose codehash is not the canonical clone hash ever holds
credit*; `invalidateNonce` and direct executions provably never accrue credit.

Two implementation caveats from review, folded into the spec: `submit()` must forward a bounded gas
stipend (the core reverts if `gasleft() > intent.maxGas`), and `submit()` reverts if
`intent.relayer` is the relay itself (otherwise fee tokens would strand in a contract with no sweep
path, and "zero custody" gains an asterisk).

**Disclosed griefing edge:** anyone watching pending `submit()` calldata can call `execute()`
directly first, consuming the nonce — the owner's execution still succeeds, only the credit is
denied. Funds-safe, fail-closed, marginal under private submission; `submit()` pre-flights
`nonceUsed` for a clean error.

### Streaks and levels

Counted runs in rolling 7-day windows maintain a **solder streak**; cumulative runs plus streak
define forge level (Apprentice → Journeyman → Toolmaker → Master Solderer). Advancing requires
`levelUp()`, which burns a small 0xZAPS **flux fee** — a level needs the runs *and* the burn.

**Levels gate cosmetics only.** Per regulatory review, levels are deliberately **decoupled from
award eligibility** (§5): burning tokens never buys a path to a payout. Levels are non-transferable
per-address state; Blueprints trade, status does not. Letting a streak lapse costs nothing you
already own, and the UI says exactly that.

### Print Run seasons (escrowed, capped, fail-closed)

A season exists **only after** someone publicly escrows a fixed 0xZAPS budget in `SeasonEmitter`.
No escrow, no season, and the UI shows "no active print run" — never a projection, never an APY.
The funding transaction *is* the disclosure.

- **Streaming:** linear over 15 days (FWA's window), claim weight = your counted runs, **linear**
  (see §1 on the retired sqrt), pull-based, withdrawal-only, firewalled from all custody.
- **Enforced farm bound:** `start()` **reverts** unless
  `budget <= maxRuns * perRunCostFloor`, where `perRunCostFloor` is a pre-committed, published
  constant: minimum gas at a reference basefee **plus** the minimum pool fee implied by the §4
  minimum-notional registration gate. Draining the budget costs at least the budget — farming is
  capped at breakeven by revert condition, not by a sizing memo. The floor must be re-committed per
  season from current observed costs; a season whose realized per-run cost fell below the floor is
  disclosed as having paid for volume.
- **Participation gate:** `start()` also reverts unless M distinct registered owners each hold ≥ K
  counted runs — satisfying it costs a sybil M×K real executions.
- **Remainder burns:** unclaimed budget after a grace period is burned, never recycled to the
  operator.
- **Labeling (mandatory):** every season announcement states funding source, fixed escrowed amount,
  and that this is time-boxed promotional spend for performed executions, with no commitment to
  future seasons. Until an escrow exists onchain, all copy stays verbatim: **"designed, not
  scheduled."** A pre-committed post-season retention report (counted-run activity 30 days after vs
  during) publishes the mean-reversion instead of hiding it.

## 5. The Pattern Author Award (the crown, restructured)

FWA's crown mechanic, ported with its numbers and re-metric'd:

- During a season, one blueprint pattern holds the crown. The metric is **adoption**: total counted
  runs executed under the pattern this season, counting only each capsule's runs above a per-capsule
  minimum (idle clone deployments contribute zero).
- Taking an occupied crown requires exceeding the incumbent by **10%** (FWA's anti-penny-flipping
  margin, verbatim). `claimCrown(patternHash)` checks it onchain; no oracle, no admin, no judge.
- The First Print holder of the crowned pattern accrues the **Pattern Author Award**: 5% of the
  season budget. Three conditions from adversarial review:
  1. **Eligibility never derives from forge level or any paid action** — adoption counts only.
  2. **Active-participation condition:** the award pays only if the holder personally logged at
     least one counted run that season — it is a contest award for the season's work, not passive
     income on a transferable asset.
  3. **Snapshot rule:** the recipient is snapshotted at each successful `claimCrown()` and at each
     accrual epoch — buying the NFT mid-season buys future accrual only, never someone else's
     earned award.
- Vacancy folds the award back into the general budget (FWA's rule; no value lost).
- **Disclosed plainly:** the crown is contestable with capital. Whoever pays for the most real
  executions of a pattern can take it; that is the intended meaning of "most-adopted" in a
  permissionless system. The threshold and margin raise the price; they do not restore a merit
  metric, and the copy never pretends otherwise.

## 6. Token utility, stated in the only register allowed

0xZAPS acquires **three sinks and two incentive programs for performed actions** — all peripheral,
none custodial, none touching the token's existing posture (no governance, no revenue share, no
protocol access; create/fund/execute/recover never require it):

| Flow | Mechanic | Bound |
|---|---|---|
| Sink (burn) | Etch fees (First Print premium) | per-mint, verifiable onchain |
| Sink (burn) | Flux fees on `levelUp()` | per-level, cosmetic-gating only |
| Sink (burn) | Unclaimed season remainders | automatic after grace period |
| Incentive for performed executions | Season streaming, linear per counted run | pre-escrowed fixed budget, `start()` cap |
| Season contest award | Pattern Author Award, 5% of budget | active-participation + snapshot rules |

The existing app-level holder tiers (100k / 1M thresholds; app reads the balance, contracts never
do) continue unchanged as a passive fourth surface.

**Copy constraints with teeth** (from regulatory review; these bind every SOLDERWORKS surface,
article, and announcement):

- Payments compensate **performed actions, never balances held**. The words *yield, interest,
  return, earn path* do not appear on user surfaces.
- Burns are fee sinks. No surface may frame them as deflationary, supply-shock, or
  holder-benefiting.
- No *pot / prize / jackpot / lottery / raffle / draw* vocabulary anywhere: it's the *escrowed
  season budget*, the *Pattern Author Award*, and a contest "won by adoption, measured onchain."
- First Prints are promoted as **authorship records and design provenance** — never on expected
  resale value or award income. Etch-time worst-case copy: *"etching does not entitle you to any
  payment; the author award exists only during a funded season and only if your pattern leads
  adoption."*
- Standing disclosure on every season/crown surface, mirroring the site's existing
  not-financial-advice block: *"Every outcome in SOLDERWORKS is deterministic. Nothing is random,
  nothing is drawn, and no result depends on chance. Season payments compensate executed onchain
  actions; they are not yield, interest, or a return on holding any token."*

## 7. Grafts adopted from the losing designs

The judge panel scored four independent designs (SOLDERWORKS 112; The Fuse Box 108 after correcting
a split-title tally; Switchboard 93; Sodium Draw 89). The winner absorbs the runners-up's best
mechanics:

1. **FeeMeter** (Fuse Box; Phase 3+): an optional owner-signable relayer whose fee flow splits
   burn/rebate — the only identified **treasury-free** funding path for later seasons, with the
   wash-EV bound (your rebate ≤ a share of your own fees) as the published anti-farm argument. This
   also fixes SOLDERWORKS' weakest spot: without it, no burn scales with actual protocol usage.
2. **Burn-to-queue candidacy** (Fuse Box; strictly post-Safe+timelock): burn 0xZAPS to queue an
   adapter/token for governance review — "burn buys review, never approval." The community funds
   its own content pipeline, which is literally what opens new First Print races.
3. **Quantified worst-case pre-action cards** (Sodium Draw): before any burn or irreversible click,
   the exact cost and what it does **not** buy, in the same register as the existing gas tooltip.
4. **Realized-figures-only dashboards** (Fuse Box): cumulative burns, budget drawdown, counted
   runs — explorer-verifiable realized numbers with explicit near-zero empty states ("at current
   volume this burns almost nothing"). Incentivized-vs-organic volume separation is a **hard
   publish gate**: label it or don't publish it.
5. **One-click blueprint load** (Sodium Draw): etched Blueprints load into `/build` via the
   existing `decodeDesign` import path — owned Blueprints are functional starting points, not
   trophies.
6. **Phase-0 honest scaffolding** (Switchboard): ship the Foundry readout and gallery reading from
   static config, with a verbatim banner — "Two patterns exist today; new First Prints open when
   governance allowlists new adapters" — before any contract deploys.

## 8. Implementation

### New contracts (all peripheral; the core is untouched)

| Contract | Responsibility |
|---|---|
| `BlueprintRegistry.sol` | ERC-721; commit-reveal etch; pattern hash + traits computed from frozen fields only; 0xZAPS etch burn; scrap discount; permissionless late-etch; `parentHash` lineage |
| `ForgeRelay.sol` | codehash-verified `register` (EXTCODEHASH + internal pattern derivation + min-notional); `submit` pass-through crediting on success only; streaks; `levelUp` flux burn; per-pattern thresholded counts |
| `SeasonEmitter.sol` | `start()` with escrow, budget cap, and participation gate as revert conditions; linear streaming claims; `claimCrown` with 10% margin; award accrual with participation + snapshot rules; `burnRemainder()` |
| `FoundryRouter.sol` | stateless one-tx glue: `OpenZapFactory.createZap` (canonical, unchanged) + etch reveal + relay registration; optional scrap param; bypassable by design |

(Names verified against the deployed core: the factory function is `createZap`, the getter is
`policyHash`.)

### Builder & app surface (maps to existing code)

- **Foundry readout** in `src/app/build/ZapBuilder.tsx` under the existing design fingerprint: live
  pattern hash (labeled as the onchain identity, vs the FNV-1a fingerprint's existing "will not
  match anything on a block explorer" note), First Print availability + commit-reveal status, etch
  cost, and per-guard trait consequences via the existing guard-coverage components.
- **Deploy handoff**: extend the existing `/app?src=build&…` query contract (~line 826) with
  `&etch=1&scrap=<tokenId>`; signing console offers "Deploy + Etch via Foundry Router" beside plain
  deploy, plus a default-on, bypassable "route executions via Forge Relay (earns credit)" toggle.
  New analytics events `builder_blueprint_committed` / `builder_blueprint_etched` beside the
  existing eight.
- **Blueprint gallery** beneath "Start from a blueprint": cards show serial, print count, provable
  traits, crown badge; loads into the canvas via `decodeDesign`; the deployable badge keeps
  deriving from `reduceChainToLiveRoute` so it can never drift.
- **Forge HUD chip** in `/app` next to the existing holder chips: level, streak, season status
  ("no active print run" when unfunded).
- **Season page**: escrowed budget, funding tx link, the cap math shown as a receipt
  (`budget / maxRuns / perRunCostFloor`), stream progress, your counted runs, crown standings,
  realized burns. Only values read from contracts. No APY, no fiat, no projections.

### Phases

- **Phase 0 — posture prep, no code ship.** Accept the pending AdapterRegistry/TokenAllowlist
  ownership handoff and move to Safe+timelock (docs already call the current EOA setup "not a
  production posture"). Publish the full 0xZAPS supply distribution and the identity/holdings of
  the intended season funder — **no burn mechanic ships against an undisclosed cap table.** Obtain
  counsel review of the season emitter and author-award mechanics as a paid-skill-contest and
  token-distribution question — **a launch gate, not documentation.** Pre-commit and publish the
  `perRunCostFloor` formula. Ship the honest-scaffolding UI (zero contracts). Publish a SOLDERWORKS
  honesty note on `/token` mirroring "only the utility that exists today."
- **Phase 1 — periphery ships, zero emissions.** `ForgeRelay` + `BlueprintRegistry` +
  `FoundryRouter`, with the full Foundry fuzz/invariant suite (including the credit-iff-relay-success
  and canonical-codehash invariants), Slither triage, Sourcify verification, addresses in
  `docs/deployments.md`. Etching and levels go live as pure provable status + sinks. Until a season
  escrow exists, etch UI states plainly: *"the escrowed budget does not exist yet; this burn buys a
  serial number and nothing else."*
- **Phase 2 — first Print Run.** Deploy `SeasonEmitter`; escrow a deliberately small pilot budget;
  publish the funding tx before `start()`; run one 15-day season; burn the remainder publicly;
  publish the pre-committed retention report.
- **Phase 3 — content expansion.** Broadcast + allowlist the already-shipped
  `RobinhoodV4PoolAdapter` (aeWETH/USDG) and ZapVault adapters (fixing the vault's "earns nothing"
  copy first, per BASE_CAPABILITIES), widening patterns from 2 to ~6 and opening new First Print
  races; evaluate FeeMeter as the treasury-free season funding path; burn-to-queue after
  Safe+timelock.
- **Phase 4 — game-board polish.** Gallery, crown leaderboard, cosmetic unlocks, season HUD;
  evaluate trait-weighted season variants only if a future core enforces more guards (explicitly
  not promised).

## 9. Launch gates and standing rules (verbatim from adversarial review)

1. No burn sink launches against an undisclosed cap table.
2. Counsel review of seasons + author award before Season 1 — a gate, not a doc.
3. Every public volume/burn metric labels season-incentivized activity distinctly, or is not
   published at all.
4. **No randomness, ever:** any future mechanic containing VRF, draws, raffles, loot boxes, mystery
   packs, or randomized traits is rejected at design review. Public lineage copy states that FWA's
   chance element was *deleted, not adapted*.
5. Award eligibility never chains from any paid action.
6. "Designed, not scheduled" until an escrow exists onchain.

## 10. Risks (kept, not buried)

- **Breakeven farming is capped, not irrational:** a stale `perRunCostFloor` after gas/fee drops
  re-opens positive-EV farming; the floor is re-committed per season and misses are disclosed.
- **Wash-volume optics:** counted runs are swaps in the token's own pool; the hard labeling gate
  (§9.3) exists precisely because season activity inflates pool volume.
- **ForgeRelay is a new hop for credited executions:** a `submit()` bug pauses credit accrual
  (never execution, which always works directly) — fail-closed, but the relay needs core-grade
  fuzz/invariant rigor, and it is additional unaudited surface on a protocol that is itself
  pre-external-audit.
- **Routing asymmetry:** Hermes-submitted executions are real usage earning no credit; the app must
  make relay routing default-obvious or seasons undercount organic users.
- **Funding source is undefined today:** the repo documents no treasury or team allocation; until a
  funder is disclosed and escrowed, seasons are designed, not scheduled. FeeMeter is the only
  identified treasury-free path and is Phase 3+.
- **The crown is capital-contestable** (disclosed as intended, §5).
- **Commit-squatting:** speculative mass-commits are priced only by the etch burn; the fee must be
  set high enough to make squatting expensive.
- **Thin launch content:** two patterns at genesis; the content pipeline depends on governance
  allowlisting the shipped-but-unbroadcast adapters, which is gated on the unaccepted ownership
  handoff (Phase 0).
- **Credit-denial griefing** (§4): disclosed, funds-safe, marginal under private submission.
