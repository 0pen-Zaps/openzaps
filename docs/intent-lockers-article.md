# Intent Lockers: An Introduction to OpenZaps and 0xZAPS

*I work on this protocol. Discount accordingly.*

*Style note: this piece borrows the register of a Paradigm research note as a framing device. It is
not authored by, reviewed by, endorsed by, or affiliated with Dan Robinson, Paradigm, or any of
their personnel.*

**tl;dr.** DeFi automation keeps failing at the same joint: the standing approval, not the strategy.
OpenZaps deploys a per-user contract with no generic call primitive — there is no discretion to
constrain because there is nothing to point at. That property is real, structural, and worth
studying whether or not this deployment survives; it is also paid for in expressiveness, and the
open question is whether the expressiveness can be recovered without giving the property back.
The 0xZAPS token is treated separately (§6–7), as it should be.

**Status as of 23 July 2026.** Every figure below was read from the live Robinhood Chain deployment
(chain id 4663) or the running application; where a number moves, it is labeled. One disclosure the
register requires up front: **the deployed v1.1 contracts have no published external audit.** The
invariant specification quoted below is the machine-checkable verification *target*, not a
completed proof record. Deposits should be scoped accordingly; the unconditional owner exit exists
for exactly this reason.

**Thesis in one paragraph.** Almost every attempt to make DeFi automation safe has been an attempt
to *constrain an executor that could otherwise do anything*. OpenZaps inverts that: it deploys a
contract with no generic call primitive, so there is no discretion to constrain in the first place.
That inversion is enforced structurally rather than by a policy engine, and it is worth studying
whether or not this particular deployment survives. The 0xZAPS token attached to the project is a
separate question with a separate and much less flattering answer — §6 treats it as what it is: a
paired asset with no protocol claim — and I will keep the two apart.

---

## 1. The problem is not automation. It is the shape of the approval.

Every automated DeFi workflow — rebalancing, DCA, harvest-and-compound — shares a structural
defect, and it is not the strategy. It is that the user must grant a standing capability today to
an executor that acts on it later.

There are three prevailing ways to do that, and they fail in the same direction:

1. **Unlimited ERC-20 approvals to a router.** The router can pull the balance forever, for any
   reason. The user's exposure is the router's entire future codebase plus its upgrade key.
2. **A session key or delegated executor.** The bound is a policy enforced by off-chain code or a
   mutable wallet module. The set of reachable actions is whatever that code says *today*.
3. **Custody.** Send the assets to the agent. At least this one is honest about what it is.

Each is a grant of *discretion*. The user authorizes a **capability** — "you may spend" — and then
relies on the executor's good behavior, or on a policy engine, to narrow that capability to the
intended action. The delta between capability granted and action intended is the attack surface
this design targets. Approval-drainer losses are that delta, monetized: Scam Sniffer's 2024
wallet-drainer report counted roughly $494M taken through exactly this gap in one year.
<!-- TODO(nodar): verify the Scam Sniffer 2024 figure + link before publishing; swap in a fresher
2025/2026 number if one exists. One number only — the register forbids more. -->

There is a strong case that session keys plus a well-specified validator dominate this design; I
take it up in §4, after the mechanism is on the table.

![The OpenZaps landing page: "A zap cannot do anything it was not signed to do."](media/01-home-hero.png)

The front page makes a falsifiable claim — *a zap cannot do anything it was not signed to do*. The
rest of this note is an attempt to break that claim: to find a reachable state the owner did not
fix at deployment.

---

## 2. What an OpenZap actually is

A zap is an **intent locker**: a per-user, single-policy contract that holds the user's funds and a
frozen action graph — "graph" because a policy may chain up to sixteen adapter calls, each edge
fixed the same way. It is deployed as an EIP-1167 minimal-proxy clone of a stateless, fundless
implementation, via a `CREATE2` factory that deploys and initializes atomically.

The construction bears stating precisely, because the security argument rests on it:

- **The policy is frozen into write-once storage by a factory-only `initialize()` executed in the
  same transaction as the `CREATE2` deploy** (EIP-1167 clones cannot carry per-clone Solidity
  immutables; the enforced guarantee — write-once, factory-only, atomic with deployment — is
  equivalent, and it is invariant I-ISO-3 in the spec). The policy fields are: owner, recipient,
  relayer-fee cap, tracked assets, and the step array — each step freezing an adapter address, an
  input token, a spender, a constant input amount, and its calldata bytes.
- The contract stores `policyHash = keccak256(abi.encode(policy))` at initialization. Execution
  happens through `execute(intent, sig)`, where `intent` is an owner-signed EIP-712 typed message;
  the contract asserts `intent.policyHash == policyHash` and reverts with `PolicyMismatch`
  otherwise. The policy is never supplied at execution time — only referenced. Replay protection is
  a per-zap one-time-use nonce set carried in each signed intent, not a policy field.
- There is no `target` + `calldata` field anywhere in the interface. The only policy-directed
  external action is a fixed-selector adapter call with frozen data — the selector is a single
  global constant for every zap in existence, so the per-policy question is only *which* allowlisted
  adapter, never *what shape* of call. Value can otherwise leave the contract only three ways: to
  the frozen recipient (floored by the owner-signed `minOut`, measured as a balance delta), as a
  double-capped relayer fee, or to the owner via `emergencyExit`. That enumeration is invariant
  I-FLOW-1, and it is the honest version of "the contract can only do the one thing."

Generic execution — `call(target, value, data)` — is the primitive that makes account abstraction
expressive, and it is the primitive that turns every policy engine built on it into the filter of
§1. OpenZaps removes the set being filtered: there is nothing to point at.

Note the two authority moments the architecture separates. The target, recipient, input amounts,
and calldata are fixed **when the zap is deployed**, before any signature exists. The owner's later
per-run signature adds only the run-scoped fields — settlement asset, `minOut`, deadline, fee — and
the submitter can alter none of either set. An intent locker splits "what can ever happen" from
"when it happens," and gives the second key to the owner alone.

### The authority split

![Authority model: pre-funded immutable zap, EIP-712 typed intent, Safe/ERC-1271 signer](media/15-home-protocol.png)

<!-- TODO(nodar): add the one shareable diagram here — left: a validator filtering an unbounded
arrow-set with one arrow slipping through; right: a contract with exactly one arrow leaving it.
Caption: "A validator filters an unbounded action set. OpenZaps deletes the set." -->

---

## 3. The lever the bytecode consults

A note that promises "claims narrowed to what the deployed bytecode enforces" cannot skip the part
of the bytecode that consults something mutable.

`execute()` re-checks two owned governance contracts at run time: the **AdapterRegistry** for every
step, and the **TokenAllowlist** for the intent's settlement asset. This is deliberate — it is the
kill-switch for a compromised adapter — and it is bounded in the right direction: governance can
**halt** the fast path of any zap by de-allowlisting, but it cannot redirect funds, alter a policy,
or take anything. If the fast path halts, `emergencyExit` remains: owner-only, unconditional,
routing through no adapter, draining all tracked assets plus native to the owner (I-REC-1/2). The
user can also invalidate any pending intent off the fast path (I-REC-3).

The current state of that lever, read from the deployment docs: both governance contracts on
Robinhood Chain are owned by a single deployer EOA (`0xe17f…B986`), with a two-step transfer to a
second EOA proposed and **not yet accepted**. The project's own documentation calls this "not a
production posture." It is the correct thing to say, and until a Safe-plus-timelock holds that key,
the honest summary is: *your funds cannot be redirected by governance, but your automation can be
paused by one key.*

---

## 4. The strongest counterargument, stated properly

A session key with a well-specified policy engine gives you everything OpenZaps gives you and
composes with arbitrary protocols. ERC-4337 and EIP-7702 exist precisely so that a generic
`call(target, value, data)` can be wrapped in an arbitrarily expressive validator. If your validator
is correct, the reachable state space is exactly as narrow as you want it, *and* you keep the
expressiveness. On that view, OpenZaps is not solving a problem; it is declining to solve one, and
charging you a deployment per policy for the privilege.

This argument is correct in the limit and wrong in practice, for a reason that generalizes beyond
this protocol: **a validator over an unbounded action set is a filter, and filters fail open.**
Every incremental protocol integration, every new calldata shape, every upgrade to a downstream
target is a chance for the filter to admit something it should not. The failure mode is not "the
validator rejects a good transaction" — it is "the validator accepts a bad one it did not
anticipate." A validator filters an unbounded action set; OpenZaps deletes the set. Deleting the
set trades expressiveness for a property that does not decay as the ecosystem changes around it.

So the honest framing is a trade, not a free lunch: OpenZaps buys a non-decaying security property
and pays for it in expressiveness and in one clone deployment per policy. Whether that is a good
trade depends on whether the expressiveness can be recovered later without giving the property
back — the open question this note ends on (§8), and my short answer there is: partially, and the
partial matters.

---

## 5. What is actually live

The header promised figures. Here is the deployment the claims anchor to, as of 23 July 2026:

- **Chain:** Robinhood Chain mainnet, chain id 4663.
- **Core:** OpenZapFactory v1.1.0 at `0xFC775017b25d2458623E2f3E735A4B750dD8b4E4`; shared
  implementation at `0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A`; AdapterRegistry
  `0x9E56…1f17`; TokenAllowlist `0x87fB…141B`.
- **Exactly one adapter is allowlisted:** `RobinhoodV4SwapAdapter` at `0x04f6…602C`, pinned to a
  single Uniswap-v4-style pool (aeWETH ↔ 0xZAPS, dynamic-fee flag, id `0xb040…1573`). Every zap
  the app deploys is built around that one pool, in one of two directions. Two policies exist in
  the world, parameterized by owner, amount, and recipient.
- **A mainnet smoke test, since the register demands at least one live number:** zap
  `0x0006…b5b4` executed `0x3063…5aa6`, swapping 0.00005 pool WETH into ~170,800.96 0xZAPS.
  (A moving figure; labeled as such.)
- **v1 expressiveness limits, stated by the code's own docs:** optimization-class policies only
  (the factory reverts otherwise — protective/liquidation zaps are deferred by ADR-0004); at most
  16 steps; every step's input amount is a constant frozen at creation — a step cannot consume
  "whatever the previous step produced"; settlement measures exactly one ERC-20; no conditionals,
  no loops, no bridging. A balance-relative v2 exists in-repo as an explicitly unaudited candidate
  that the docs forbid pointing real funds at.
- **No external audit** (§0's disclosure, repeated here because this is the section a skimmer
  reads).

This is a small deployment making a narrow claim. That is the point, but it is also the fact.

---

## 6. The token is not the mechanism

0xZAPS is an ERC-20 on Robinhood Chain (`0xDd90…CB07`, launched via Clanker). The project's own
token page leads with what it is not, and the code backs the copy: **no governance, no staking, no
revenue claim, no fee rights, no protocol access.** Creating, funding, executing, and recovering a
zap never require holding it. Its utility today is exactly three things: it is the asset paired
with aeWETH in the one route the live contracts can execute; holding 100k/1M+ unlocks app-side
conveniences (saved-zap and receipt limits, quote auto-refresh, JSON export) that the app checks
and the contracts never read; and it is a wallet-readable ERC-20 with a verifiable address.

That is a less flattering answer than most token pages give, which is why it is credible. The
mechanism would work identically with any allowlisted pair; the token's honest description is
*paired asset, plus conveniences* — not *claim on anything*.

---

## 7. The game layer, if it ships

This section describes **a design, not a deployment**. None of the contracts below exist onchain;
if that changes, this section changes tense. The design rule that governs all of it: *the custody
layer is never gamified.* (Full specification: `docs/solderworks-design.md`.)

The study object is Fake World Assets — TokenWorks' randomized NFT acquisition protocol, the most
interesting token-mechanics launch of this summer. FWA's loop: depositors pair NFTs with ETH
backing; backing sets an inverse selection weight (`1e36 / backing` — lighter backing is drawn
more often) and funds an irrevocable standing bid; purchasers pay a harmonic-mean-derived price for
a VRF-random position and then keep it or sell it back. For its first 15 days, the *only* way to
get $FWA was to use the product — 1% of supply per day to each side of the market. Then on July 3,
2026, an attacker front-ran the Chainlink VRF callback and steered a draw to CryptoPunk #5450
(~$66k); the protocol went withdraw-only and is rebuilding.

What OpenZaps takes from FWA is not the lottery. It is three structural ideas that survive with
the chance element **deleted — not adapted, deleted**: supply earned only through verifiable
product use; incentives paid to both sides of a market for showing up early; and irrevocable
pre-commitments as the trust primitive. The FWA exploit is the design's negative-space argument:
every SOLDERWORKS outcome is deterministic, nothing is drawn, and a mechanic containing randomness
is rejected at design review by standing rule.

The shape of it, in one paragraph each:

- **Blueprints.** A deployed policy's normalized pattern — adapters, input tokens, step data;
  never owner or amounts — is a keccak hash, and the first deployment of a novel pattern mints an
  onchain First Print (numbered reprints thereafter), under commit-reveal because deterministic
  races are front-runnable too. Etching burns 0xZAPS; scrapping an old blueprint discounts the
  next etch. Two patterns exist today; each newly allowlisted adapter opens a new race, which
  welds the collectible roadmap to the protocol roadmap.
- **Counted runs.** The deployed core has no execution counter, and nonce storage can be flipped
  for free by design — so the game counts only executions a stateless pass-through relay itself
  submitted and watched succeed. The relay holds nothing, decides nothing, and can be bypassed at
  will; it is a scorekeeper, not an operator. Streak and level state derive only from counted
  runs, and levels gate cosmetics — never payouts.
- **Print Run seasons.** Incentives exist only after someone publicly escrows a fixed 0xZAPS
  budget; the season contract *refuses to start* unless the budget is at or below what the
  cheapest possible farming of it would cost in real gas and pool fees, and unless enough distinct
  owners have real counted runs. No escrow, no season, and the UI says "no active print run" —
  never a projection. Unclaimed remainders burn.
- **The Pattern Author Award.** FWA's crown, re-metric'd from capital to adoption: the most-executed
  pattern each season pays 5% of the escrowed budget to its First Print author — with the margin
  rule (10% to overtake) kept verbatim, eligibility never derived from any paid action, and the
  award conditional on the author's own participation that season. It is a contest award for work,
  not passive income on a transferable asset, and the copy is required to say so.

Why this section belongs in an honest note at all: the existing builder already gamifies exactly
one thing — its guard-coverage score, which measures *policy narrowness*. The game layer extends
that: every trait a blueprint can carry must be backed by a frozen, publicly readable policy field,
and two proposed traits were deleted during review because the chain could not prove them. The
score the player is incentivized to maximize is the security property. That is the only kind of
gamification this architecture can wear without refuting itself — and if the shipped version ever
drifts from that rule, this section is the standard to hold it to.

---

## 8. The open problem

Can the expressiveness be recovered without giving the property back?

Some of it, visibly: more adapters widen the action set one audited, fixed-shape edge at a time —
expressiveness by *enumeration*, which preserves the no-generic-call property by construction but
scales linearly with review effort. Balance-relative amounts (v2's candidate sentinel) recover
composition within a policy without opening the call surface. Conditionals, protective triggers,
and cross-protocol routing are harder: each pushes toward run-time choice, and run-time choice is
where filters creep back in. The research question this project actually poses is whether there is
a stable point between "sixteen frozen edges" and "a validator over everything" — a policy language
rich enough to matter whose reachable set still does not decay. I do not know the answer. Neither
does anyone shipping validators.

---

## 9. Where this leaves us

The claim on the front page is falsifiable, and the invitation is standing: the factory, the
implementation, the one adapter, and a funded zap are all onchain at the addresses in §5. If you
can make a zap do anything it was not signed to do — reach an unapproved target, leak an approval,
dodge the recipient, survive `emergencyExit` — the thesis of this note is false, and I would
genuinely rather know.

A zap cannot do anything it was not signed to do. Unlike a roadmap, you can check.
