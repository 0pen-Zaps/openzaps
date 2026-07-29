# Capability matrix — Base 8453 and Robinhood Chain 4663

This began as a constraint audit of the **original 25 blocks** against the v1.1 OpenZap core. The
catalogue, deployed adapter set, and automation lineages have since grown. The original-row matrix is
kept because its core reasoning remains useful, but it is no longer a complete product inventory.
Current addresses and deployment gates live in [`../docs/deployments.md`](../docs/deployments.md);
the app's actual route registry lives in [`../src/lib/chains.ts`](../src/lib/chains.ts).

*(The filename is historical — this document covered Base only until Robinhood Chain turned out to
have an ecosystem of its own. See §2.)*

Robinhood core ownership, allowlists, pins, and code were re-read at finalized block
**22,115,084 on 2026-07-28**. Fixed historical pool counts below retain their original observation
block and should not be treated as current market metrics.

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
| **LIVE** | Deployed **and** allowlisted on that chain at the verified block. Product availability may still have an additional fail-closed liquidity or configuration gate. |
| **SHIPPED** | Adapter code and tests exist in this repo and a deploy script covers it. **Not yet broadcast** on that chain. |
| **SOURCE-ONLY** | Implemented and tested, but absent from every live immutable implementation. |
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
| `RobinhoodV4PoolAdapter` (aeWETH/USDG, pinned pool) | `0x714E48930d1d9a53149AA7B92cD88C9E172d1942` | **live and allowlisted** |
| `ZapVault` / ozUSDG (ERC-4626 receipt wrapper) | `0xeAD10C998c59745a030FfAc9209b294C14C7D325` | live, **unseeded** |
| `ZapVaultDepositAdapter` (USDG → ozUSDG) | `0x1b289fD37Ff4497531a953aa922ab258F5e81164` | live and allowlisted; app-gated while vault is unseeded |
| `ZapVaultRedeemAdapter` (ozUSDG → USDG) | `0x16eD4f04657c7a965aef333F5Cf0c9d745e0c8cE` | live and allowlisted; app-gated while vault is unseeded |

The later route adapters and seeded ozRANGE full-range vault are also live; their complete addresses,
seed transaction, and allowlist evidence are recorded in `docs/deployments.md`. The allowlisted token
set now includes **aeWETH, 0xZAPS, USDG, ozUSDG, and ozRANGE**.

Both live core registries are owned by
`0x5a52D4B820Ae7F02880d270562950918ACb14aA2`; both `pendingOwner()` values are zero. No ownership
change is part of this release.

---

## 4. The matrix

### Sources

| # | Block (`id`) | Base 8453 | Robinhood 4663 | Why |
| --- | --- | --- | --- | --- |
| 1 | Wallet balance (`wallet-balance`) | **LIVE** | **LIVE** | Core-level, so identical on both chains. The amount is frozen into the policy (`Step.amountIn`) and bound into `policyHash`, so no executor can draw more. One correction to the block copy: the **live v1.1 bytecode** never pulls from the owner's wallet; the owner funds that capsule by transferring tokens to it (predict-then-fund via `factory.predict`). The source-only `1.2.0-candidate` adds a separate witnessed Permit2 SignatureTransfer mode for the exact first-step amount, but it is not deployed and must not be described as a live v1.1 capability. |
| 2 | Recurring deposit (`recurring-stream`) | **LIVE** | **LIVE** | In the v1.1 one-shot lineage, repetition still means separately signed nonces and an offchain cadence. Robinhood's live v3/v3.1 automation lineages add an owner-signed interval, maximum run count, deadline, executor scope, and replay state onchain; production execution evidence is recorded in `docs/deployments.md`. |
| 3 | Pending rewards (`pending-rewards`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 3. A step that starts from "whatever has accrued" consumes no token, and `initialize` rejects `amountIn == 0`. It also emits the `yield` shape, whose only consumer (`harvest`) is blocked for the same reason. `ZapVault` does not change this on Robinhood and could not: it earns nothing, so there is no accrual to claim. |

### Actions

| # | Block (`id`) | Base 8453 | Robinhood 4663 | Why |
| --- | --- | --- | --- | --- |
| 4 | Swap (`swap`) | **LIVE** | **LIVE** | **Base:** `BaseV3SwapAdapter`, exact-input single-hop, welded to WETH/USDC 0.05% (`0xd0b53D9277642d899DF5C87A3966A349A798F224`), with pinned-block fork coverage. **Robinhood:** the aeWETH/0xZAPS and aeWETH/USDG pool adapters are live and allowlisted; two additional live route adapters compose the pinned pools for USDG↔0xZAPS. Scope remains constructor-welded: one adapter instance names one pool or one fixed route. |
| 5 | Split (`split`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 1. Settlement measures exactly one `intent.outAsset`. A 2–4 leg fan-out can settle at most one leg; the others accumulate in the capsule, invisible to `minOut`, recoverable only through `emergencyExit`. The signed slippage floor would cover one leg and silently not the rest. This needs multi-asset settlement in a v2 core, not an adapter. |
| 6 | Bridge (`bridge`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 1, plus asynchrony. The output lands on another chain, so the capsule's `outAsset` balance does not rise, `out = balanceOf - preOut` underflows and the whole chain reverts. Even if it were tolerated, arrival is a later event on a different chain that a single `execute()` cannot observe or bound. |
| 7 | Supply (`supply`) | **LIVE** | **LIVE contracts; APP-GATED** *(see §4a)* | **Base:** `AaveV3SupplyAdapter` is welded to one Aave v3 reserve and settles the measured aToken delta. **Robinhood:** `ZapVault`, its deposit/redeem adapters, USDG, and ozUSDG are deployed and allowlisted. The wrapper earns no yield, and the app deliberately refuses both routes while `totalSupply == 0`; the vault was still unseeded at the verified block. |
| 8 | Borrow (`borrow`) | **BLOCKED (core)** | **BLOCKED (core + chain)** | Three independent blockers on Base, all fork-proven in `test/AaveV3Adapters.fork.t.sol`. (a) Aave requires `borrowAllowance[capsule][adapter]`, settable only by `approveDelegation` called by the debtor. OpenZap's entire outbound surface is: `isAllowed`/`balanceOf` staticcalls, `approve(spender==adapter)`, `IAdapter.execute`, `transfer`, an ERC-1271 staticcall, and an empty-calldata native send to the owner. There is no delegatecall, no arbitrary target, no arbitrary calldata — a capsule can never emit `approveDelegation`, and the one smuggling route (pointing a step's `tokenIn` at the variable-debt token) dies inside Aave, whose debt tokens revert `OperationNotSupported()` on the whole approval surface. (b) The escape hatch — adapter borrows as itself — makes one registry-shared adapter the Aave account for every capsule, so one user's borrow is secured by another's collateral, and it puts the position beyond `emergencyExit` (breaking I-REC-1). (c) A debt leg has no accounting counterpart: balance-delta settlement can see the borrowed asset arriving but not the liability opened against it, and once a capsule carries debt, `emergencyExit` **reverts** on the collateral leg (health factor would fall below 1). A borrow needs liability-aware v2 settlement. On Robinhood every one of those still applies **and** there is no lending market to borrow from. `ZapVault` does not lend and has no debt surface. |
| 9 | Draw to wallet (`draw-debt`) | **BLOCKED (core)** | **BLOCKED (core + chain)** | It consumes the `debt` shape, which nothing on either chain can produce under this core (row 8). Independently, a "realise the loan" step consumes no token of its own — Rule 1, consequence 3. |
| 10 | Add liquidity (`add-liquidity`) | **BLOCKED for direct concentrated positions** | **LIVE through ozRANGE wrapper** | A direct v3/v4 position still cannot settle as the single ERC-20 output required by v1.1. Robinhood's live `ZapRangeVault` deliberately changes the shape: its welded deposit adapter accepts one side, performs the bounded internal balancing, deposits a full-range position, and returns measurable ERC-20 ozRANGE shares. This does not make arbitrary ranges or arbitrary pools executable. |
| 11 | Remove liquidity (`remove-liquidity`) | **POSSIBLE** | **LIVE through ozRANGE wrapper** | A direct two-asset LP withdrawal still conflicts with single-asset settlement. Robinhood's live withdrawal adapters burn a fixed ozRANGE share amount inside the welded vault and settle one owner-selected, constructor-pinned asset (USDG or aeWETH); the other-side conversion is handled inside that bounded adapter. |
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
| 21 | Private submission (`guard-private`) | **BLOCKED (core); offchain lane source-ready** | **BLOCKED (core); offchain lane source-ready** | `execute` remains permissionless by design: a capsule cannot observe or bind which mempool carries a valid owner-signed intent. The reference executor therefore treats every current adapter-backed route as price-sensitive and implements the property offchain: local signing, at least two declared operators on distinct private-relay origins, per-origin health and inclusion monitoring, and no public fallback. Signing fails closed when those checks are unavailable. That lane is not active on Robinhood today because the chain documents standard RPC/direct-sequencer submission, not enough independent private endpoints to satisfy the admission floor. |

### Sinks

| # | Block (`id`) | Base 8453 | Robinhood 4663 | Why |
| --- | --- | --- | --- | --- |
| 22 | Send to recipient (`send`) | **LIVE** | **LIVE** | This *is* v1.1 settlement. `recipient` is frozen in the policy, bound into `policyHash` and into the CREATE2 salt, and re-checked against the intent (`WrongRecipient`). Changing it is a new policy, a new address and a new signature — never a config edit. See §4b for the one thing this block cannot accept in the builder. |
| 23 | Hold in zap (`hold`) | **BLOCKED (core)** | **BLOCKED (core)** | Rule 1, consequence 2. Settlement transfers the measured gain to `recipient` unconditionally; there is no branch that leaves it in the capsule. Making the capsule its own recipient is not a workaround, it is a fixed point: the clone's address is `CREATE2(keccak256(abi.encode(policy, salt)))` and `recipient` is *inside* that policy, so the address you would need to name depends on naming it. What the capsule really offers is custody-by-owner: whatever the chain does not settle stays put and comes out through `emergencyExit`. That is a recovery path, not a sink. |
| 24 | Hold position (`hold-lp`) | **BLOCKED (core)** | **BLOCKED (core + chain)** | Row 23's blocker, plus row 10's: a v3/v4 position is an ERC-721 (Base) or a PoolManager-internal record (Robinhood) that the settlement path cannot measure, allowlist, or transfer. Both reasons are independently fatal, and on Robinhood there is no ERC-20 LP to hold either. |
| 25 | Loop back (`loop`) | **BLOCKED (core)** | **BLOCKED (core)** | One `execute()` is a single linear pass over ≤16 frozen steps (`MAX_STEPS`). There is no jump back to step 0 and no re-entry — the `nonReentrant` guard forbids it outright. Compounding across runs means N separate transactions, each with its own owner-signed intent and fresh nonce, which is an off-chain schedule and not a block the capsule can enforce. And there is no cumulative budget to bound it (row 17), which is precisely why "max loops = 4" cannot be honoured on-chain. |

---

## 4a. Row 7 on Robinhood — the vault, stated exactly

**Status: contracts deployed and allowlisted; app route intentionally closed while unseeded.**

`src/primitives/ZapVault.sol` is a minimal, admin-less ERC-4626 vault. It exists because the OpenZap
settlement model needs a venue that takes **one ERC-20 in** and returns **one ERC-20 out**, and
Robinhood Chain has no such contract (§2).

The canonical deployment is:

| Artifact | Address | Verified state |
| --- | --- | --- |
| ZapVault / ozUSDG | `0xeAD10C998c59745a030FfAc9209b294C14C7D325` | deployed; `totalSupply == 0` |
| Deposit adapter | `0x1b289fD37Ff4497531a953aa922ab258F5e81164` | deployed and allowlisted |
| Redeem adapter | `0x16eD4f04657c7a965aef333F5Cf0c9d745e0c8cE` | deployed and allowlisted |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | allowlisted |
| ozUSDG | vault address above | allowlisted |

The two adapters make the wrapper reachable from a frozen policy:

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

Three caveats remain and must not be softened:

- **`ZapVault` earns nothing.** `totalAssets()` is literally `asset.balanceOf(this)`. There is no
  strategy, lending, or staking. The current `supply` block explicitly distinguishes an
  interest-bearing lending receipt from this plain wrapper.
- **The empty vault is not safe to advertise.** An unseeded ERC-4626 can be donation-manipulated.
  `deployedRoutes()` and the signing surface therefore require `totalSupply > 0`; an unavailable RPC
  or zero supply keeps deposit and redeem closed. Seeding is an explicit owner-wallet operation, not
  an app or executor action.
- **Deposit and redeem cannot be combined in one capsule.** Settlement measures
  `balanceOf(outAsset)` after minus before. A run that deposits the asset and redeems it back nets to
  zero at best, and underflow-reverts as soon as rounding bites. Redeem is only useful in a capsule
  **funded with shares** that settles on the underlying. Rule 2 compounds this: a redeem step cannot
  consume whatever the deposit step minted, because the share count must be named at signing time.

---

## 4b. The builder gap is closed, but live-state gates remain

`compileChain` in `src/lib/blocks.ts` matches shapes by strict equality:

```ts
const fits = block.accepts === shape;
```

The catalogue now carries the missing shapes explicitly:

- `supply` emits `receipt`;
- `send` accepts both `token` and `receipt`;
- `vault-position` opens a chain from an exact ozUSDG share amount; and
- `redeem` consumes `receipt` and emits the welded USDG asset.

`src/lib/deployable.ts` now reduces the visual chain through the deployed-adapter registry in
`src/lib/chains.ts`, rather than recognizing only the original aeWETH/0xZAPS route. That closes the
old product/compiler gap.

It does **not** make static source configuration sufficient. The app still performs RPC-backed
checks for code, registry membership, immutable route pins, quotes, and vault seeding. Missing or
unprovable live state fails closed. In particular, the ozUSDG deposit/redeem routes remain hidden
while the canonical vault is unseeded.

---

## 5. Scoreboard

The old 25-row count is retired: the catalogue now includes additional sources, actions, guards,
and automation templates, so preserving the old total would manufacture a misleading denominator.
Current status is reported by exact route and lineage:

```
Base 8453
  wallet balance (WETH) → swap (Uniswap v3, WETH→USDC, 0.05%) → slippage cap → human gate → send
  wallet balance (WETH) → supply (Aave v3 WETH) → slippage cap → human gate → send

Robinhood 4663
  wallet balance (aeWETH) → swap (Uniswap v4, aeWETH→0xZAPS) → slippage cap → human gate → send
  wallet balance (aeWETH) → swap (Uniswap v4, aeWETH→USDG) → slippage cap → send
  wallet balance (USDG) → fixed route (USDG→aeWETH→0xZAPS) → slippage cap → send
  wallet balance (0xZAPS) → fixed route (0xZAPS→aeWETH→USDG) → slippage cap → send
  wallet balance (aeWETH or USDG) → full-range ozRANGE vault → send
  ozRANGE balance → welded withdraw (settle aeWETH or USDG) → send
  recurring / relative-floor recurring / price-triggered automation through live v3/v3.1

Robinhood 4663 — deployed but app-gated while ozUSDG totalSupply == 0:
  wallet balance (USDG) → ZapVault receipt → send
  ozUSDG balance → redeem → USDG → send

Source-only, absent from live immutable implementations:
  base v1.2.0-candidate → irreversible owner halt + witnessed Permit2 first-step owner pull
  all future lineage sources → irreversible per-policy owner halt
  v3.2 → recurring output stacking into owner tickets
```

`docs/deployments.md` is the authority for live addresses and gates. A configured address alone is
never a live claim; the app rechecks route pins and registry state before signing.

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

The former catalogue/front-end gaps for receipt settlement, vault redemption, and no-yield copy are
closed. They remain useful regression cases: a future block-shape or copy change must not
reintroduce them.

---

## 7. Runbooks

Scripts do not broadcast unless an operator explicitly supplies Forge's `--broadcast` and a local
signer. No private key belongs in source, arguments, environment transcripts, or documentation.

- **Base 8453** — `script/DeployBase.s.sol`. See §8 below.
- **Robinhood Chain 4663 live suites** — do not re-run historical expansion scripts. Follow
  `docs/deployments.md` and the independent post-broadcast acceptance checklist for a new lineage.
- **Robinhood testnet 46630 soak** — use
  `script/DeployRobinhoodTestnetSoak.s.sol` and
  `docs/soaks/2026-07-28-robinhood-testnet-executor-soak-template.md`. The template is explicitly
  `NOT STARTED`; local tests are not a 24-hour soak.

---

## 8. Deployer runbook (Base mainnet)

The owner runs these, in this order, with their own signer.

```bash
cd contracts

# 0. Gates. All must be clean before anything else.
forge fmt --check
forge build --force
forge test
forge test --fork-url https://mainnet.base.org

# 1. Dry run. No --broadcast: this only simulates and prints the addresses and gas.
#    GOVERNANCE is the reviewed address that will own the new registry and allowlist.
export GOVERNANCE=0xYourGovernanceAddress
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

# 4. Complete the script's two-step ownership handoff from the reviewed governance address.
cast send <AdapterRegistry> "acceptOwnership()" --rpc-url ...
cast send <TokenAllowlist>  "acceptOwnership()" --rpc-url ...

# 5. Verify the live wiring before pointing any money at it.
cast call <OpenZapFactory> "VERSION()(string)"        --rpc-url https://mainnet.base.org  # "1.2.0-candidate"
cast call <AdapterRegistry> "isAllowed(address)(bool)" <swapAdapter>   --rpc-url ...      # true
cast call <AdapterRegistry> "isAllowed(address)(bool)" <supplyAdapter> --rpc-url ...      # true
cast call <AdapterRegistry> "owner()(address)"        --rpc-url ...                       # reviewed governance
cast call <TokenAllowlist>  "owner()(address)"        --rpc-url ...                       # reviewed governance

# 6. Point the front end at the new factory, and only then fund a capsule.
```

To add an adapter later (another pool, another Aave reserve): deploy that adapter alone and have
governance call `AdapterRegistry.setAdapter(adapter, true)` plus `TokenAllowlist.setToken(...)` for
anything new it returns. Do **not** re-run `DeployBase.s.sol` — it is not idempotent and would stand
up a second, disconnected deployment.
