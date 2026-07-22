# Capability matrix — Base 8453 and Robinhood Chain 4663

What the 25 blocks in `src/lib/blocks.ts` can and cannot do against the **v1.1 OpenZap core**, on both
chains this repo targets. Every verdict below is grounded in a line of `src/OpenZap.sol`, an adapter
that exists in `src/adapters/`, a fork test in `test/`, or a read-only `cast` call against live chain
state. Nothing here is aspirational.

*(The filename is historical — this document covered Base only until Robinhood Chain turned out to
have an ecosystem of its own. See §2.)*

Live state in this document was read at **Robinhood Chain block 16,768,172**.

---

## 1. The two rules that decide almost everything

Nineteen of the twenty-five rows below are a consequence of one of these two. Read them before the
matrix, not after.

### Rule 1 — settlement measures exactly ONE ERC-20

`OpenZap.execute()` (`src/OpenZap.sol`):

```solidity
uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));   // before the loop
...                                                                   // <=16 frozen steps
uint256 out = IERC20(intent.outAsset).balanceOf(address(this)) - preOut;  // underflows if no gain
...
intent.outAsset.safeTransfer(recipient, out);                         // unconditional
```

Four consequences:

1. **A chain must end in a measured increase of exactly ONE ERC-20.** The subtraction means a chain
   that does not increase `outAsset` reverts with an arithmetic panic. One asset, not two, not zero.
2. **The gain always leaves the capsule.** The transfer to the policy's frozen `recipient` is
   unconditional. There is no "keep it here" branch.
3. **Every step consumes a nonzero amount of an allowlisted ERC-20.** `initialize` rejects
   `amountIn == 0` (`InvalidStep`) and `tokenIn == address(0)` (`NativeTokenUnsupported`); `execute`
   approves exactly `amountIn` to the adapter before calling it. A step that consumes nothing is not
   expressible.
4. **Every step must return a nonzero, allowlisted, non-zero-address ERC-20.**
   `InvalidAdapterResult`, checked unconditionally on every step's return.

Plus: one `execute()` is a single linear pass over the frozen steps. There is no loop back to step 0,
and each run needs a fresh owner-signed intent with an unused nonce.

### Rule 2 — a step's input amount is frozen at signing time

`Step.amountIn` (`src/libraries/OpenZapTypes.sol`) is a constant written into the policy at creation
and covered by the policy hash. **A step cannot consume "whatever the previous step produced."** That
quantity is not knowable when the owner signs, and making it knowable would mean signing a blank
cheque.

Proven end to end against the deployed contracts in `test/DeployedBaseE2E.t.sol`: a capsule swapped
2,000 USDC through Uniswap v3 into ~1.05 WETH, then supplied the **0.2 WETH the policy named** to
Aave. The other ~0.85 WETH stayed in the capsule. It is recoverable — the owner's `emergencyExit`
sweeps it, and the test asserts that — but it does not flow onward.

So "multi-step" here means *a fixed sequence of fixed amounts*, not a pipeline:

- "Swap, then supply the proceeds" is only expressible if the author fixes the second amount in
  advance and accepts that any surplus strands until swept.
- Any step downstream of a swap at an unknown price will routinely strand value. The UI should say so
  at design time rather than let someone discover it after signing.

Proportional or balance-relative step inputs are a v2 core change, not an adapter.

### The corollary that bites the vault work specifically

A **deposit-then-redeem round trip inside one capsule cannot settle.** Deposit takes USDG out of the
capsule; redeem puts USDG back. Since `out = balanceOf(outAsset) - preOut`, the net delta is zero at
best (transfer of 0) and negative once rounding is applied — which underflow-reverts. A vault redeem
is only useful in a capsule that is **funded with shares** and settles on the underlying, never in one
that deposits and withdraws in the same run.

---

## 2. Robinhood Chain is not empty — the correction that made this work possible

**An earlier version of this document said Robinhood Chain had "no LP venue beyond one pool" and that
multi-protocol zaps were "Base or nothing". That was wrong, and the error is worth naming so nobody
repeats it.**

The mistake was the test, not the arithmetic: chain 4663 was probed for *Base's* contract addresses.
Finding no code at Base's Aave Pool proves Base's Aave is not there. It proves nothing about whether
the chain has a DeFi ecosystem of its own.

Measured directly from the Uniswap v4 PoolManager on Robinhood Chain
(`0x8366a39CC670B4001A1121B8F6A443A643e40951`):

| | Robinhood Chain 4663 |
| --- | --- |
| v4 pools ever initialized | **23,064** |
| Unique hooks in use | **532** |
| Most recent pool | block 16,727,172 — actively used |

Most-paired currencies:

| Pools | Symbol | Address |
| --- | --- | --- |
| 13,122 | native ETH | `0x0000000000000000000000000000000000000000` |
| 4,681 | **USDG** | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| 3,894 | aeWETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| 218 | **NVDA** | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| 150 | SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` |
| 134 | **TSLA** | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` |
| 119 | flETH | `0x00000000043C1117DAFA3A3D0C7148Eb48B30130` |
| 109 | **AAPL** | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` |

So the chain has a stablecoin with deep coverage and a tokenised-equity market. What it does **not**
have, at any address we could find: **no lending market, no staking venue, no ERC-20 LP token.** No
Aave, Morpho, Compound or Aerodrome-style AMM.

That absence is why `ZapVault` exists, and it is also why several rows below are BLOCKED on Robinhood
for a reason that has nothing to do with the core.

---

## 3. Verdict key

Per-chain, because the same block can be live on one chain and impossible on the other.

| Verdict | Meaning |
| --- | --- |
| **LIVE** | Deployed **and** allowlisted on that chain right now. Verified by `cast` at the block named above. |
| **SHIPPED** | Adapter code and tests exist in this repo and a deploy script covers it. **Not yet broadcast** on that chain. |
| **POSSIBLE** | The chain has the venue and the settlement model admits it. The adapter is not written. |
| **BLOCKED (core)** | Cannot work under the v1.1 core. The reason is stated exactly and is not a matter of effort. |
| **BLOCKED (chain)** | The core would admit it; **that chain has no venue for it.** A different blocker, and an honest one to keep separate. |

The distinction between LIVE and SHIPPED matters more than it looks. Code in this repo that has never
been broadcast protects nobody and moves no money.

### What exists, per chain

**Base 8453** — `src/adapters/BaseV3SwapAdapter.sol` (Uniswap v3, one pool),
`src/adapters/AaveV3SupplyAdapter.sol` (Aave v3, one reserve). `script/DeployBase.s.sol` deploys both.
`src/adapters/AaveV3BorrowAdapter.sol` deliberately compiles to nothing — see row 8.

**Robinhood Chain 4663** — live core, read from chain:

| Contract | Address | Status |
| --- | --- | --- |
| `OpenZapFactory` | `0xFC775017b25d2458623E2f3E735A4B750dD8b4E4` | live, `VERSION()` == `1.1.0` |
| `OpenZap` implementation | `0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A` | live |
| `AdapterRegistry` | `0x9E56e444f490C00A6277326A47Cb462E12dF1f17` | live |
| `TokenAllowlist` | `0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B` | live |
| `RobinhoodV4SwapAdapter` (aeWETH/0xZAPS, hardcoded) | `0x04f62dA4b51a010eFa32aa81569169C47AEd602C` | **live and allowlisted** |
| `RobinhoodV4PoolAdapter` (any ERC-20 pool) | — | code + 15 fork tests, **not broadcast** |
| `ZapVault` (ERC-4626 primitive) | — | code + 40 tests, **not broadcast** |
| `ZapVaultDepositAdapter` (asset → shares) | — | code + tests, **not broadcast** |
| `ZapVaultRedeemAdapter` (shares → asset) | — | code + tests, **not broadcast** |

All four are deployed and allowlisted together by `script/DeployRobinhoodExpansion.s.sol`. Full repo
suite after the vault adapters landed: **176 passed, 0 failed, 3 skipped** (18 suites).

Allowlist state, read live: **aeWETH allowed, 0xZAPS allowed, USDG NOT allowed.** A USDG-legged zap
needs `setToken(USDG, true)` before it can settle, regardless of which adapter runs.

Governance, read live: both `AdapterRegistry.owner()` and `TokenAllowlist.owner()` are
`0xe17f5150A2954889988e63C49d41cc321c35B986`; both `pendingOwner()` are
`0x5a52D4B820Ae7F02880d270562950918ACb14aA2`, **and the handoff has not been accepted.** Both are
EOAs, not Safes. That is a governance gap independent of any row below.

---

## 4. The matrix

### Sources

| # | Block (`id`) | Base 8453 | Robinhood 4663 | Why |
| --- | --- | --- | --- | --- |
| 1 | Wallet balance (`wallet-balance`) | **LIVE** | **LIVE** | Core-level, so identical on both chains. The amount is frozen into the policy (`Step.amountIn`) and bound into `policyHash`, so no executor can draw more. One correction to the block copy: v1.1 never pulls from the owner's wallet. There is no `transferFrom(owner, …)` anywhere in `OpenZap.sol`. The owner funds the capsule by transferring tokens to it (predict-then-fund via `factory.predict`), and steps spend the capsule's own balance. |
| 2 | Recurring deposit (`recurring-stream`) | **LIVE** | **LIVE** | Core-level. A capsule executes many times: one owner-signed intent per run, each with a fresh nonce (`nonceUsed`). The money movement is real today. **The cadence is not.** The policy has no schedule field, so "weekly" lives entirely in the off-chain trigger, and the capsule must be re-funded before each run. Nothing on-chain stops a run from happening early, late, or a hundred times — only the per-run `amountIn` is bounded. |
| 3 | Pending rewards (`pending-rewards`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 3. A step that starts from "whatever has accrued" consumes no token, and `initialize` rejects `amountIn == 0`. It also emits the `yield` shape, whose only consumer (`harvest`) is blocked for the same reason. `ZapVault` does not change this on Robinhood and could not: it earns nothing, so there is no accrual to claim. |

### Actions

| # | Block (`id`) | Base 8453 | Robinhood 4663 | Why |
| --- | --- | --- | --- | --- |
| 4 | Swap (`swap`) | **LIVE** | **LIVE** | **Base:** `BaseV3SwapAdapter`, exact-input single-hop, welded to WETH/USDC 0.05% (`0xd0b53D9277642d899DF5C87A3966A349A798F224`), 13 fork tests at a pinned block. **Robinhood:** `RobinhoodV4SwapAdapter` at `0x04f62dA4…` is deployed and allowlisted for aeWETH/0xZAPS — that one pair is live today. `RobinhoodV4PoolAdapter` generalises this to **any ERC-20/ERC-20 v4 pool** with the PoolKey as constructor immutables (15 fork tests, pool selection read off-chain by comparing live `liquidity` across all 28 aeWETH/USDG pools); it is **SHIPPED, not broadcast**. Scope on both chains: **one instance == one pool.** Another pair or fee tier is another deployment of the same contract, no new code. Aerodrome and Uniswap v4 on Base remain POSSIBLE, not written. A multi-hop route is two steps and two adapters, and every hop must land as an ERC-20 the capsule actually holds. |
| 5 | Split (`split`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 1. Settlement measures exactly one `intent.outAsset`. A 2–4 leg fan-out can settle at most one leg; the others accumulate in the capsule, invisible to `minOut`, recoverable only through `emergencyExit`. The signed slippage floor would cover one leg and silently not the rest. This needs multi-asset settlement in a v2 core, not an adapter. |
| 6 | Bridge (`bridge`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 1, plus asynchrony. The output lands on another chain, so the capsule's `outAsset` balance does not rise, `out = balanceOf - preOut` underflows and the whole chain reverts. Even if it were tolerated, arrival is a later event on a different chain that a single `execute()` cannot observe or bound. |
| 7 | Supply (`supply`) | **LIVE** | **SHIPPED** *(see §4a)* | **Base:** `AaveV3SupplyAdapter`, welded to the Aave v3 Pool `0xA238Dd80…d1c5` and one reserve. `script/DeployBase.s.sol` deploys the WETH instance and allowlists its aToken `0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7`. `onBehalfOf` is always `msg.sender`, so the **capsule** is the Aave account and holds the aToken; the adapter returns the *measured* aToken delta. One adapter per reserve. Morpho Blue and Compound v3 USDC both have code on Base and are POSSIBLE. Caveat inherent to Aave: aTokens rebase, so the measured delta is principal plus interest accrued in the same transaction; never assume `amountOut == amountIn`. **Robinhood:** the chain has no lending market at all, which is why `ZapVault` was built — see §4a for the current, honest status. |
| 8 | Borrow (`borrow`) | **BLOCKED (core)** | **BLOCKED (core + chain)** | Three independent blockers on Base, all fork-proven in `test/AaveV3Adapters.fork.t.sol`. (a) Aave requires `borrowAllowance[capsule][adapter]`, settable only by `approveDelegation` called by the debtor. OpenZap's entire outbound surface is: `isAllowed`/`balanceOf` staticcalls, `approve(spender==adapter)`, `IAdapter.execute`, `transfer`, an ERC-1271 staticcall, and an empty-calldata native send to the owner. There is no delegatecall, no arbitrary target, no arbitrary calldata — a capsule can never emit `approveDelegation`, and the one smuggling route (pointing a step's `tokenIn` at the variable-debt token) dies inside Aave, whose debt tokens revert `OperationNotSupported()` on the whole approval surface. (b) The escape hatch — adapter borrows as itself — makes one registry-shared adapter the Aave account for every capsule, so one user's borrow is secured by another's collateral, and it puts the position beyond `emergencyExit` (breaking I-REC-1). (c) A debt leg has no accounting counterpart: balance-delta settlement can see the borrowed asset arriving but not the liability opened against it, and once a capsule carries debt, `emergencyExit` **reverts** on the collateral leg (health factor would fall below 1). A borrow needs liability-aware v2 settlement. On Robinhood every one of those still applies **and** there is no lending market to borrow from. `ZapVault` does not lend and has no debt surface. |
| 9 | Draw to wallet (`draw-debt`) | **BLOCKED (core)** | **BLOCKED (core + chain)** | It consumes the `debt` shape, which nothing on either chain can produce under this core (row 8). Independently, a "realise the loan" step consumes no token of its own — Rule 1, consequence 3. |
| 10 | Add liquidity (`add-liquidity`) | **BLOCKED (core)** | **BLOCKED (core)** | As drawn, this is a *ranged* position: Uniswap v3 mints an ERC-721 and Uniswap v4 records a position inside the PoolManager. Neither is an ERC-20, so `IERC20(outAsset).balanceOf` cannot measure it, `TokenAllowlist.setToken` cannot admit it (v1 admits vetted ERC-20s only), and the step-return check rejects it. Second, independent blocker: a step carries exactly one `(tokenIn, amountIn)`, so two-sided provisioning cannot be expressed at all without an adapter that swaps internally. On Robinhood the v4 position is PoolManager-internal, so the same two blockers apply with no ERC-721 even minted. What *would* be possible on Base is a different block: a single-sided deposit into an Aerodrome vAMM pool whose LP token is a real ERC-20 (`vAMM-WETH/USDC` at `0xcDAC0d6c6C59727a65F871236188350531885C43`, verified `symbol()`/`totalSupply()`). That block has no range parameter, so it is not this one. Robinhood has no such venue at all. |
| 11 | Remove liquidity (`remove-liquidity`) | **POSSIBLE** | **BLOCKED (chain)** | **Base:** possible only for an ERC-20 LP token (Aerodrome-style), which the capsule can hold and a step can consume. **Read this caveat before building it:** burning an LP returns *both* sides, and settlement measures one. The second asset lands in the capsule, is not covered by `minOut`, is not sent to the recipient, and comes back only through `emergencyExit`. For a Uniswap v3/v4 ERC-721 position this is BLOCKED for the same reason as row 10. **Robinhood:** blocked by the chain, not the core — there is no ERC-20 LP token anywhere on 4663 to burn. Note explicitly: **`ZapVault` redeem is not this block.** This block `accepts: "lp"`; a vault share is a `receipt`. See §4b. |
| 12 | Stake position (`stake`) | **BLOCKED (core)** | **BLOCKED (core + chain)** | This block `accepts: "lp"` and an Aerodrome gauge deposit is not a token. Probed live on Base: the WETH/USDC gauge `0x519BBD1Dd8C6A94C46080E24f316c14Ee758C025` answers `totalSupply()` but **reverts on `symbol()` and on `transfer()`** — it is an internal ledger, not a transferable ERC-20. As the last step it therefore produces no measurable, transferable gain and settlement reverts; mid-chain it leads only to `accrue`/`harvest`, which are blocked in their own right. Wrapping it in an allowlisted pseudo-token would be a fake gain, which is exactly what the step-return check and the settlement subtraction exist to refuse. **`ZapVault` does not unblock this row and it would be wrong to claim otherwise:** the vault takes a plain token, not an LP, so it cannot satisfy this block's input shape, and Robinhood has no gauge or farm to stake into regardless. |
| 13 | Accrue rewards (`accrue`) | **BLOCKED (core)** | **BLOCKED (core)** | The block's own detail text says it: "a no-op onchain". A no-op cannot be a step — `initialize` requires `amountIn != 0` and `execute` requires a nonzero allowlisted `tokenOut` from every step. Waiting is not a transaction. It can only ever be an annotation on the canvas. |
| 14 | Harvest (`harvest`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 3 again, and it is the sharpest case: a claim consumes nothing, so there is no legal `(tokenIn, amountIn)` for the step. Passing a dust amount of the reward token to satisfy the check would be manufacturing the shape of a step that is not one, and it is not done here. Compounding the problem, the positions that accrue rewards on Base are gauge stakes (row 12) and v3/v4 LPs (row 10), neither of which a capsule can hold; on Robinhood nothing accrues at all. The claim *mechanics* fit the model perfectly — claim to `msg.sender`, return the measured delta — so this becomes POSSIBLE the moment a v2 core admits a zero-input step. |
| 15 | Wrap / unwrap (`unwrap`) | **BLOCKED (core)** | **BLOCKED (core)** | Both directions, proven on a Base fork in `test/WethWrapAdapter.fork.t.sol` (10 tests). **Wrap:** `initialize` rejects `tokenIn == address(0)` (`NativeTokenUnsupported`) and `IAdapter.execute` is non-payable and called with no `{value:}` — the only `call{value:}` in the entire core is `emergencyExit` → owner, so no ETH can ever reach an adapter. **Unwrap:** the honest return is `(address(0), amount)`, which the step-return check rejects before settlement is reached; and settlement fails independently because unwrapping makes the capsule's WETH balance *fall*, so the subtraction underflows (`panic 0x11`, captured in the test's trace). Native ETH can also never be `intent.outAsset`: `TokenAllowlist.setToken(address(0), true)` reverts `ZeroAddress`. A capsule *can* receive ETH (`receive()`) and `emergencyExit` drains it — **ETH in a capsule is recoverable, never routable.** On Robinhood this is the reason the chain's **13,122 native-ETH pools are unreachable**; `RobinhoodV4PoolAdapter` refuses such a PoolKey at construction (`NativeCurrencyUnsupported`) so the failure is loud at deploy time instead of silent inside a user's capsule. The front end must keep wrapping in the user's own wallet before funding. |

### Guards

| # | Block (`id`) | Base 8453 | Robinhood 4663 | Why |
| --- | --- | --- | --- | --- |
| 16 | Slippage cap (`guard-slippage`) | **LIVE** | **LIVE** | Two enforcement points, both real. `intent.minOut` is checked **net of the relayer fee** at settlement (`MinOutNotMet`), and the swap adapters carry their own `amountOutMinimum` in the step's 32-byte `data`, re-checked against the *measured* delta rather than the router's return value. `BaseV3SwapAdapter` refuses a zero floor (`ZeroMinimumOut`). Note one honest asymmetry on Robinhood: `RobinhoodV4PoolAdapter`'s own `InsufficientOutput` check is currently **unreachable in practice**, because the same min-out is handed to the router and the router's `V4TooLittleReceived` fires first. It is defence-in-depth against a lying router, not a live-tested path. |
| 17 | Spend ceiling (`guard-spend`) | **BLOCKED (core)** | **BLOCKED (core)** | There is no cumulative counter anywhere in the capsule's storage. The only bound a deployed capsule carries is the single `amountIn` per step, per run, and a funded capsule can be executed again with a fresh nonce indefinitely. A lifetime cap needs new state and a new check in a v2 core. The UI already says this; it is true. |
| 18 | Price band (`guard-oracle`) | **BLOCKED (core)** | **BLOCKED (core)** | The core has no precondition surface — no oracle read, no non-adapter call, nothing between signature verification and the step loop. The only way to get a band today is to weld a price feed *inside* a specific adapter, which makes it a property of that one adapter rather than a guard you can drop onto a chain. |
| 19 | Time window (`guard-window`) | **BLOCKED (core)** as drawn | **BLOCKED (core)** as drawn | The policy has no expiry and no cadence field, so a deployed capsule stays executable until the owner drains or revokes it. What does exist, and is enforced, is a **per-intent** window: every signed intent carries `validAfter` and `deadline`, and `invalidateNonce` lets the owner kill a held intent. So a *run* can be time-boxed by the signature; the *capsule* cannot be time-boxed by the policy. |
| 20 | Human gate (`guard-approval`) | **LIVE** | **LIVE** | The block's copy is more pessimistic than the contract. Every single execution requires an owner EIP-712 signature over that exact intent — zap, chain id, nonce, deadline, recipient, relayer, fee cap, gas caps, `policyHash`, `outAsset`, `minOut` — verified before any external call, with ERC-1271 support so the owner can be a Safe. The relayer has zero discretion. The one honest limit: nothing forces the signature to be *recent*; an owner can pre-sign a batch of nonces, and only `invalidateNonce` takes them back. Note that `src/lib/deployable.ts` lists this guard as "designed but not enforced" — it means something narrower (there is no *separate* per-run approval step beyond the signature itself), and both statements are true. |
| 21 | Private submission (`guard-private`) | **BLOCKED (core)** | **BLOCKED (core)** | `execute` is permissionless by design: anyone holding a valid owner-signed intent can submit it. `intent.relayer` only names who receives the fee, not who may submit. Which mempool the transaction traverses is a property of the submitter, and the capsule cannot observe or bind it. |

### Sinks

| # | Block (`id`) | Base 8453 | Robinhood 4663 | Why |
| --- | --- | --- | --- | --- |
| 22 | Send to recipient (`send`) | **LIVE** | **LIVE** | This *is* v1.1 settlement. `recipient` is frozen in the policy, bound into `policyHash` and into the CREATE2 salt, and re-checked against the intent (`WrongRecipient`). Changing it is a new policy, a new address and a new signature — never a config edit. See §4b for the one thing this block cannot accept in the builder. |
| 23 | Hold in zap (`hold`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 2. Settlement transfers the measured gain to `recipient` unconditionally; there is no branch that leaves it in the capsule. Making the capsule its own recipient is not a workaround, it is a fixed point: the clone's address is `CREATE2(keccak256(abi.encode(policy, salt)))` and `recipient` is *inside* that policy, so the address you would need to name depends on naming it. What the capsule really offers is custody-by-owner: whatever the chain does not settle stays put and comes out through `emergencyExit`. That is a recovery path, not a sink. |
| 24 | Hold position (`hold-lp`) | **BLOCKED (core)** | **BLOCKED (core + chain)** | Row 23's blocker, plus row 10's: a v3/v4 position is an ERC-721 (Base) or a PoolManager-internal record (Robinhood) that the settlement path cannot measure, allowlist, or transfer. Both reasons are independently fatal, and on Robinhood there is no ERC-20 LP to hold either. |
| 25 | Loop back (`loop`) | **BLOCKED (core)** | **BLOCKED (core)** | One `execute()` is a single linear pass over ≤16 frozen steps (`MAX_STEPS`). There is no jump back to step 0 and no re-entry — the `nonReentrant` guard forbids it outright. Compounding across runs means N separate transactions, each with its own owner-signed intent and fresh nonce, which is an off-chain schedule and not a block the capsule can enforce. And there is no cumulative budget to bound it (row 17), which is precisely why "max loops = 4" cannot be honoured on-chain. |

---

## 4a. Row 7 on Robinhood — the vault, stated exactly

*(This section is the one the vault work changes. It is kept separate so the claim is precise rather
than a word swapped in a table cell.)*

**Status: SHIPPED in code, NOT broadcast. Nothing is live on chain 4663 yet.**

`src/primitives/ZapVault.sol` is a minimal, admin-less ERC-4626 vault. It exists because the OpenZap
settlement model needs a venue that takes **one ERC-20 in** and returns **one ERC-20 out**, and
Robinhood Chain has no such contract (§2).

Two adapters now make it reachable from a frozen policy, closing the gap that the previous version of
this document recorded as open:

- **`ZapVaultDepositAdapter`** — `tokenIn` = the vault's underlying asset, `tokenOut` = the vault
  share. `receiver` is hardcoded to `msg.sender`, so the shares land on the zap that paid for them and
  the adapter can never become the shareholder of record; both halves are asserted at runtime
  (`SharesMisdirected`). `amountOut` is the measured increase of the *caller's* share balance, with
  the vault's own return value used only as a cross-check that must agree exactly.
- **`ZapVaultRedeemAdapter`** — `tokenIn` = the vault share, `tokenOut` = the underlying asset. Worth
  understanding *why this direction is expressible at all*, because the same shape is what killed the
  Aave borrow leg (row 8): ERC-4626's `redeem(shares, receiver, owner)` spends a plain ERC-20
  allowance on the share token, and `approve(spender == adapter, amountIn)` is exactly the one
  approval primitive `OpenZap.execute` already emits. Aave's `approveDelegation` is a different
  function the core can never emit; `ZapVault.approve` is `approve(address,uint256)` itself. **No core
  change was needed** — the standards happen to line up. It uses `redeem`, not `withdraw`, because
  `withdraw` is denominated in assets and burns a rounded-*up* share count nobody can compute at
  signing time, which would exceed the frozen allowance whenever the price moved by a wei.

Three things must all be true before this row can read **LIVE** on Robinhood. None has happened:

1. The four contracts are broadcast. `script/DeployRobinhoodExpansion.s.sol` deploys them; it has been
   dry-run on both governance branches and **never broadcast**.
2. `AdapterRegistry.setAdapter(…, true)` has landed for **both** vault adapters.
3. `TokenAllowlist.setToken(vaultShare, true)` **and** `setToken(vaultAsset, true)` have landed. The
   share token is the deposit step's `tokenOut` *and* the redeem step's `tokenIn`, so without it a
   deposit step reverts `InvalidAdapterResult` at execution and a redeem step reverts
   `TokenNotAllowed` at `initialize`. **USDG is not allowlisted today** (read live), so this is real
   outstanding work, not a formality.

Three caveats that remain true even once all three land, and none of which should be softened: 

- **`ZapVault` earns nothing.** `totalAssets()` is literally `asset.balanceOf(this)`. There is no
  strategy, no lending, no staking. The `supply` block's own detail text says *"Interest accrues to
  the share, so the receipt is what the rest of the chain moves"* — **that sentence is false for
  `ZapVault`.** The receipt moves; no interest accrues to it. Presenting this as a yield product
  would be a lie, and the UI copy needs changing before this block is offered on 4663.
- **`ZapVault` is unaudited and would custody real user funds.** It has been unit-tested by the same
  agent that wrote it, which is not a review. See `ROBINHOOD_EXPANSION.md` §3 for the full risk
  statement, including the measured finding that every deep asset on the chain is an upgradeable
  proxy whose controller can freeze or seize the vault's balance.
- **Deposit and redeem cannot be combined in one capsule.** Settlement measures
  `balanceOf(outAsset)` after minus before. A run that deposits the asset and redeems it back nets to
  zero at best, and underflow-reverts as soon as rounding bites. Redeem is only useful in a capsule
  **funded with shares** that settles on the underlying. Rule 2 compounds this: a redeem step cannot
  consume whatever the deposit step minted, because the share count must be named at signing time.

---

## 4b. The gap the vault work does *not* close: the builder cannot draw a `supply` chain

This applies to **both chains** and it is the sharpest thing in this document, so it gets its own
section rather than a footnote.

`compileChain` in `src/lib/blocks.ts` matches shapes by strict equality:

```ts
const fits = block.accepts === shape;
```

Now read the shape graph:

- `supply` **emits** `receipt`.
- `send` — the only SHIPPED sink — **accepts** `token`. A `receipt` reaching it is a hard
  block-level `mismatch` error, not a warning.
- `hold` is the only block that **accepts** `receipt`, and `hold` is **BLOCKED (core)** (row 23).

So: **a chain ending in `supply` is expressible by the contracts and rejected by the builder.** At the
contract layer the vault share (or the aToken) is just an allowlisted ERC-20 and settles fine — that
is exactly what the Base runbook's `supply → send` chain does. At the product layer, the user cannot
draw it.

Two consequences worth stating plainly:

1. **Shipping the deposit adapter does not by itself make `supply` usable from the product surface.**
   Either `send` must accept `receipt`, or a `receipt → token` block must exist.
2. **There is no block in the catalogue for redeeming a receipt back to its underlying.**
   `ZapVaultRedeemAdapter` has now shipped, so this is no longer hypothetical: it is a real, tested
   on-chain capability with **no block in the 25 that can express it.** The nearest candidate,
   `remove-liquidity`, `accepts: "lp"`, not `receipt`. **This capability is therefore counted nowhere
   in the scoreboard below**, and that is the honest treatment — it should not be added to the
   product's capability count until a block exists that a user can actually draw.

So the vault work moves exactly **one** row (7, on Robinhood, and only to SHIPPED). It moves `stake`
nowhere, because that block takes an `lp`. It moves `remove-liquidity` nowhere, for the same reason.
Anyone reporting this work as unblocking a category of the catalogue would be overstating it.

Separately, `src/lib/deployable.ts` is the narrowest gate in the whole system — narrower than both the
contracts and this matrix. As committed, it reduces **only** the single-step aeWETH ⇄ 0xZAPS swap to a
deployable policy; every other design, including a `supply` chain and including a swap through
`RobinhoodV4PoolAdapter`, is rejected by name at the handoff. A front-end track is actively reworking
this into a two-layer reduction backed by a new `src/lib/chains.ts` adapter registry, keyed off which
adapters are *actually deployed and allowlisted*. That is the right shape, and it does not change any
verdict here: with no adapter addresses configured, the offered set is still the one bounded swap, and
the shape mismatch above lives in `src/lib/blocks.ts`, which that work does not touch.

---

## 5. Scoreboard

Counted per chain, at **current** status — code that has never been broadcast is counted as SHIPPED,
never as LIVE.

| Verdict | Base 8453 | Robinhood 4663 |
| --- | --- | --- |
| **LIVE** | 7 — `wallet-balance`, `recurring-stream`, `swap`, `supply`, `guard-slippage`, `guard-approval`, `send` | 6 — the same, **minus `supply`** |
| **SHIPPED** (written, tested, not broadcast) | 0 | 1 — `supply`, via `ZapVault` + its two adapters (§4a) |
| **POSSIBLE** | 1 — `remove-liquidity` (ERC-20 LP only, one asset stranded) | 0 |
| **BLOCKED** | 17 | 18 |
| **Total** | 25 | 25 |

Base moves **nothing** as a result of the vault work — it is a Robinhood-only capability. Robinhood
goes from 19 BLOCKED to 18, and gains its first SHIPPED-but-not-live row. **Robinhood's LIVE count is
unchanged at 6**, and stays there until someone broadcasts and governance allowlists.

One capability shipped that this table cannot count at all: **redeeming a vault share back to the
underlying**. It works, it is tested, and no block in the 25 can express it (§4b).

The chains that are fully deployable today, end to end:

```
Base 8453
  wallet balance (WETH) → swap (Uniswap v3, WETH→USDC, 0.05%) → slippage cap → human gate → send
  wallet balance (WETH) → supply (Aave v3 WETH) → slippage cap → human gate → send
      ^ settles the aToken at the contract layer; the builder rejects it (§4b)

Robinhood 4663
  wallet balance (aeWETH) → swap (Uniswap v4, aeWETH→0xZAPS) → slippage cap → human gate → send
      ^ the only one of these that today's deployed adapter set and deployable.ts both accept

Robinhood 4663 — AFTER broadcasting DeployRobinhoodExpansion.s.sol, not before:
  wallet balance (USDG)  → supply (ZapVault)  → slippage cap → human gate → send   [settles ozUSDG]
  wallet balance (ozUSDG) → «redeem»          → slippage cap → human gate → send   [settles USDG]
      ^ the first is contract-expressible but undrawable in the builder (§4b)
      ^ the second has no block at all; it exists only as an adapter
      ^ the two CANNOT be combined in one capsule — the round trip nets to zero and reverts (§4a)
```

Everything else in the catalogue is either a second deployment of an adapter that already exists (a
different pool, a different reserve), a POSSIBLE adapter someone still has to write, or a BLOCKED row
above that needs a different core — not a cleverer adapter.

---

## 6. What a v2 core would have to add

Listed once, so the BLOCKED rows above do not have to repeat it.

1. **Multi-asset settlement** — measure and settle a set of `(asset, minOut)` pairs instead of one.
   Unblocks `split`, and de-fangs `remove-liquidity`.
2. **Native-ETH settlement** — a payable adapter interface (or value-forwarding steps), a sentinel
   that survives the `adapterOut != address(0)` check, and settlement on `address(this).balance`
   deltas. Unblocks `unwrap`, and reaches Robinhood's 13,122 native-ETH pools. `HonestUnwrapProbe` in
   `test/WethWrapAdapter.fork.t.sol` is the proven mechanism, and lives in the test tree marked
   not-an-adapter.
3. **Zero-input steps** — a step that consumes nothing but must still return a measured gain.
   Unblocks `harvest`, `accrue` and `pending-rewards`.
4. **Non-ERC-20 positions** — ERC-721 custody and a way to assert on a position instead of a balance.
   Unblocks `add-liquidity`, `hold-lp`, and the concentrated half of `remove-liquidity`.
5. **Liability-aware settlement plus a policy-frozen non-adapter call** (so a capsule can emit
   `approveDelegation` without gaining an arbitrary-call surface), and a recovery path that repays
   debt before withdrawing collateral. Unblocks `borrow` and `draw-debt`.
6. **Persistent per-capsule state** — a cumulative spend counter, a cadence, an expiry.
   Unblocks `guard-spend`, `guard-window` and the bound on `loop`.
7. **A settle-in-place option** — an outcome that leaves the gain in the capsule instead of
   transferring it. Unblocks `hold`.
8. **Balance-relative step inputs** — the only fix for Rule 2's stranding. Not a v2 *settlement*
   change but a v2 *policy* change, and the one that would make "swap then supply the proceeds" mean
   what a user reading the canvas assumes it means.

None of these is reachable by writing another adapter, which is the whole point of listing them
separately.

Three further items are **not** core changes and should not be filed as such — they are catalogue and
front-end work (§4b):

- `send` accepting a `receipt`, so a `supply` chain can be drawn at all.
- A block that expresses `receipt → token`, so `ZapVaultRedeemAdapter` becomes reachable from the
  builder instead of being a capability only a hand-written policy can use.
- Correcting the `supply` block's detail copy before it is offered on 4663. It currently reads
  *"Interest accrues to the share"*. For `ZapVault` that is false — it earns nothing.

---

## 7. Runbooks

Nothing in this repo broadcasts anything, and no key is read, written or requested anywhere in it.

- **Base 8453** — `script/DeployBase.s.sol`. See §8 below.
- **Robinhood Chain 4663** — `script/DeployRobinhoodExpansion.s.sol`, documented in full in
  `ROBINHOOD_EXPANSION.md` §6. It **adds to** the live deployment; do not re-run
  `DeployRobinhood.s.sol`, which stands up a new, disconnected core and would orphan every capsule the
  live factory has already produced.

---

## 8. Deployer runbook (Base mainnet)

The owner runs these, in this order, with their own signer.

```bash
cd contracts

# 0. Gates. Both must be clean before anything else.
forge fmt --check
forge build --force
forge test                                        # 176 passed, 3 skipped
forge test --fork-url https://mainnet.base.org    # 176 passed, 3 skipped

# 1. Dry run. No --broadcast: this only simulates and prints the addresses and gas.
#    GOVERNANCE is the Safe that will own the registry and the allowlist. It is an ADDRESS.
export GOVERNANCE=0xYourSafe
forge script script/DeployBase.s.sol \
  --fork-url https://mainnet.base.org \
  --sender 0xYourDeployerAddress

# 2. Broadcast. The signer comes from the CLI — a hardware wallet or a keystore account.
#    Never a private key on the command line, in a file, or in an env var.
forge script script/DeployBase.s.sol \
  --rpc-url https://mainnet.base.org \
  --sender 0xYourDeployerAddress \
  --ledger \
  --broadcast --slow --verify --etherscan-api-key "$BASESCAN_API_KEY"
#    (--account <keystore-name> --interactive instead of --ledger if using an encrypted keystore)

# 3. Record the five addresses the script prints. They are the deployment.
#    The pre-existing v1.0.0 factory 0xc7C5897e4738a157731c2F93b1d73Db9926E926C is superseded and
#    must not be quoted anywhere as current.

# 4. Complete governance. From the Safe, on BOTH contracts — the transfer is two-step and until this
#    lands the deployer is still the kill-switch holder:
cast send <AdapterRegistry> "acceptOwnership()" --rpc-url ... # from the Safe
cast send <TokenAllowlist>  "acceptOwnership()" --rpc-url ... # from the Safe

# 5. Verify the live wiring before pointing any money at it.
cast call <OpenZapFactory> "VERSION()(string)"        --rpc-url https://mainnet.base.org  # "1.1.0"
cast call <AdapterRegistry> "isAllowed(address)(bool)" <swapAdapter>   --rpc-url ...      # true
cast call <AdapterRegistry> "isAllowed(address)(bool)" <supplyAdapter> --rpc-url ...      # true
cast call <AdapterRegistry> "owner()(address)"        --rpc-url ...                       # the Safe
cast call <TokenAllowlist>  "owner()(address)"        --rpc-url ...                       # the Safe

# 6. Point the front end at the new factory, and only then fund a capsule.
```

To add an adapter later (another pool, another Aave reserve): deploy that adapter alone and have
governance call `AdapterRegistry.setAdapter(adapter, true)` plus `TokenAllowlist.setToken(...)` for
anything new it returns. Do **not** re-run `DeployBase.s.sol` — it is not idempotent and would stand
up a second, disconnected deployment.
