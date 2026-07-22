# Robinhood Chain expansion

What just became possible on **Robinhood Chain (4663)**, what the two new contracts do, the honest
risk statement for the vault, and the exact runbook — which commands the deployer runs with their own
key, and which calls governance must send afterwards.

Everything here is grounded in a fork test in `test/`, a dry run recorded below, or a raw RPC read.
Where something is unproven or missing, it says so.

---

## 0. The corrected ecosystem numbers

Reproduced from `BASE_CAPABILITIES.md` §0, because they are the reason this work exists.

**An earlier version of this repo said Robinhood Chain had "no LP venue beyond one pool" and that
multi-protocol zaps were "Base or nothing". That was wrong.** The mistake was the test, not the
arithmetic: chain 4663 was probed for *Base's* contract addresses. Finding no code at Base's Aave Pool
proves Base's Aave is not there. It proves nothing about whether the chain has an ecosystem of its own.

Measured directly from the Uniswap v4 PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`:

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

Supporting infrastructure, all bytecode-verified: Universal Router
`0x8876789976DeCBfcBbBE364623c63652db8c0904`, v4 Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`,
Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, CreateX, Multicall3.

What the chain genuinely does **not** have: any lending market, any staking venue, any ERC-20 LP token.
No Aave, Morpho, Compound or Aerodrome-style AMM at any address we could find.

---

## 1. What is now possible, and what still is not

| | Before | After this work |
| --- | --- | --- |
| `swap` | One hardcoded pool (aeWETH/0xZAPS, dynamic fee, hooked) | **Any ERC-20/ERC-20 v4 pool on the chain**, one adapter deployment per pool, no source edit |
| Hookless static-fee pools | Untested; assumed to need different encoding | **Proven identical** — same command byte, same action sequence, live swap in both directions |
| `supply` / `stake` | Impossible — nothing on chain mints an ERC-20 receipt | **A venue now exists** (`ZapVault`), but it is **not yet reachable from a zap** — see §5 |
| Native-ETH pools (13,122 of them) | Unreachable | **Still unreachable**, and now refused at construction rather than at execution |

Two hard limits that did not change and cannot be fixed by an adapter:

1. **Native ETH can never be an `outAsset`.** `TokenAllowlist` rejects the zero address and
   `OpenZap.initialize` rejects `tokenIn == address(0)`. The 13,122 native-ETH pools are therefore
   outside the core's expressible set. `RobinhoodV4PoolAdapter` refuses to deploy against such a
   PoolKey (`NativeCurrencyUnsupported`) so the failure happens at deploy time, loudly, instead of at
   execution time inside a user's capsule.
2. **`Step.amountIn` is frozen at policy creation.** A step cannot consume what the previous step
   produced. "Swap then supply" only works if the author fixes the second amount in advance and
   accepts that any surplus strands in the capsule until the owner sweeps it via `emergencyExit`.
   See `BASE_CAPABILITIES.md` §0b and `test/DeployedBaseE2E.t.sol`.

---

## 2. `RobinhoodV4PoolAdapter`

`src/adapters/RobinhoodV4PoolAdapter.sol` — 4,686 B runtime.

`RobinhoodV4SwapAdapter` with the whole v4 PoolKey lifted into constructor immutables: `currency0`,
`currency1`, `fee`, `tickSpacing`, `hooks`. **One deployment still serves exactly one pool.** A second
pool means a second deployment. That is the point: allowlisting the address in `AdapterRegistry`
remains equivalent to allowlisting one specific action against one specific pool (invariant I-SURF-1).

Security shape, unchanged from the reference adapter:

- One fixed `IAdapter.execute` selector.
- **No arbitrary calldata.** The adapter builds its own Universal Router `commands`/`inputs` from
  immutables and the caller's `amountIn`. `data` never carries a target, a selector, a path or a route
  blob.
- Chain guard `block.chainid == 4663` in the constructor *and* on every call.
- Reentrancy guard.
- Pulls exactly `amountIn`; reverts unless its input balance is exactly restored.
- **Zero residual allowance on every path**, revert included — both the ERC-20 → Permit2 leg and the
  Permit2 → router leg, for both currencies.
- Returns the **measured** balance delta, never the router's reported number. Sweeps everything to
  `msg.sender`; holds nothing.

Additional constructor validation the reference did not need, because the pool is now a parameter:
sorted non-duplicate currencies; `tickSpacing` in 1..32767; static `fee <= 1_000_000`; the dynamic-fee
flag `0x800000` requires a non-zero hook (v4 itself rejects otherwise); code checks on router, Permit2,
both currencies and the hook if present. `hooks == address(0)` is now permitted — the reference
wrongly required a hook.

### The one deliberate deviation, and it needs sign-off

The reference adapter reverts on **any** non-empty `data`. This one accepts `data` that is either
empty **or** exactly one word, `abi.encode(uint256 minAmountOut)`.

That is a bounded typed scalar, validated (`<= type(uint128).max`), handed to the router as
`amountOutMinimum`, **and** independently re-checked against the measured delta (`InsufficientOutput`).
It is never a target, a selector or a route. Anything else — 33 bytes, two words, a packed
address+selector — reverts `InvalidData()`.

**Call it what it is: a frozen `Step.data` now encodes an absolute slippage floor.** That is a
policy-surface change, not just an implementation detail, and it should be signed off explicitly
rather than inherited by accident.

Note also that `InsufficientOutput` is currently **unreachable in practice** — the same min-out goes to
the router, so the router's own `V4TooLittleReceived` fires first. It is defence-in-depth against a
lying router, not a live-tested code path.

### Measured on the fork

`test/RobinhoodV4PoolAdapter.fork.t.sol`, fork pinned at block **16,728,000**, 15/15 PASS.

Pool selection was read off the chain, not guessed: every `Initialize` log for the aeWETH/USDG pair was
pulled from the PoolManager (28 pools) and live `liquidity` read for each via `extsload` at v4
`POOLS_SLOT = 6`, offset 3. Most are dead — including the 1500/30, 2500/50, 1000/20 and 5000/100 tiers.

| Pool | poolId | Liquidity @ 16,728,000 |
| --- | --- | --- |
| aeWETH/USDG, fee 450, tick 9, **hookless** | `0x6ba18d46…5d2` | 458,944,179,188,459,813 |
| aeWETH/0xZAPS, dynamic fee, tick 200, hooked | `0xb040f18a…573` | 997,519,511,065,749,950,282,714 |
| aeWETH/USDG, fee 3000, tick 60, hookless (runner-up) | `0x77c25b93…` | 186,539,504,537,172,022 |

Real swaps from the traces:

- **Static-fee hookless**: `execute(aeWETH, 5e16, "")` → `(USDG, 96_312_981)` — 0.05 WETH → 96.312981
  USDG, ~1926 USDG/WETH, matching the pool's `sqrtPriceX96`. Reverse:
  `execute(USDG, 48_156_490, "")` → `(aeWETH, 24_977_564_134_727_560)`.
- **Dynamic-fee hooked**, same bytecode deployed a second time: `execute(aeWETH, 1e15, "")` →
  `(ZAPS, 3_045_292_832_380_888_397_488_135)`. The trace confirms the hook's `beforeSwap` fired.

`poolId` derivation was verified against the chain: `keccak256(abi.encode(currency0, currency1, fee,
tickSpacing, hooks))` reproduces both ids above.

**Not tested:** the tokenised-equity pools (NVDA/TSLA/AAPL), fee-on-transfer or rebasing currencies,
and a hook that takes its fee in the output currency. A hook that *skims* output is handled correctly
(the measured delta is what gets returned); a hook that returns a **third** token would break the
single-output contract and is untested. Test funding uses `deal` to write ERC-20 balances — the swaps
are entirely real against live pool state, but the initial balances are cheated in.

---

## 3. `ZapVault`

`src/primitives/ZapVault.sol` — 4,530 B runtime, 381 lines. Full ERC-4626 surface plus a hand-rolled
ERC-20 share token (the repo vendors only forge-std; no OpenZeppelin dependency).

It exists for one reason: the OpenZap settlement model needs a venue that takes **one ERC-20 in** and
gives **one ERC-20 out**, and Robinhood Chain has no such contract. It is a receipt-token wrapper, not
a yield product.

**What it deliberately does not have** — read this as the specification, not as a disclaimer:

- **No admin, at all.** No owner, governor, pauser, guardian, timelock, proxy, initializer,
  `selfdestruct` or `delegatecall`. `test_noAdminSurface` asserts 8 admin-shaped selectors all revert.
  The consequence is symmetric: there is also no rescue path.
- **No fee variable.** Not "settable to zero" — absent, with no code that could read one.
- **No native ETH.** No `receive()`, no `payable`. A plain ETH send reverts.
- **No fee-on-transfer or deflationary assets.** `_pullExact`/`_pushExact` measure the vault's own
  balance delta and revert `InexactAssetTransfer` unless it is exact.
- **No chain guard**, deliberately. Adapter rule 3 governs adapters; applying it to fund custody would
  mean a chain-id change could permanently trap principal in a contract with no admin rescue.
- **It earns nothing.** `totalAssets()` is literally `asset.balanceOf(this)`. A share appreciates only
  if someone donates. Do not present this as yield.

**Inflation attack:** OZ-style virtual offset, `VIRTUAL_SHARES = 1000`, `VIRTUAL_ASSETS = 1`, plus two
guards — a non-zero `deposit` rounding to zero shares reverts (`ZeroShares`), and a non-zero `redeem`
paying zero assets reverts (`ZeroAssets`). Zero-value calls remain legal no-ops.

Concrete result (`test_firstDepositorInflationAttackFails`): attacker deposits 1 wei, donates 10,000
ether, victim deposits 10,000 ether. **The attacker spends 10,000 ether and recovers ~5,001 — a ~4,999
ether loss. The victim loses 2.5 ether.** The attack transfers most of the attacker's own money *to*
the victim. `testFuzz_inflationAttackNeverPays` (50,000 runs) asserts the general properties: the
attacker never recovers more than they committed, and the victim's loss is bounded by
`donation / 1000 + 1 wei`.

**Test evidence:** 40/40 pass; the 6 fuzz properties pass at **50,000 runs each** (12.09s). Full repo
non-fork suite green after the additions. `forge fmt --check` clean.

There is no fork test for `ZapVault`, and that is not an omission being papered over: the vault has no
external protocol dependency to fork against — its only counterparty is its own asset token. What
*was* verified against mainnet, read-only, is that the constructor's asset probe succeeds on every deep
currency: USDG (6dp → 9dp shares), aeWETH/NVDA/TSLA/AAPL (18dp → 21dp shares).

### The honest risk statement

**This contract is unaudited and would custody other people's money. It has been unit-tested by the
same agent that wrote it, which is not the same as being reviewed.** Three specific reservations, in
order of how much they should change your behaviour:

1. **Every deep asset on this chain is upgradeable — measured, not assumed.** USDG is an ERC-1967
   proxy (implementation slot `0x360894a1…`). NVDA, TSLA and AAPL are **beacon** proxies reading
   `implementation()` from a *shared* beacon at `0xe10b6f6b275de231345c20d14ab812db62151b00`, so one
   beacon owner controls the code of all three tokenised equities simultaneously. Whoever controls
   those implementations can freeze, blacklist or seize the vault's balance. **No ERC-4626 design
   prevents this.** The "a vault cannot be safer than its underlying" line in the NatSpec is a live
   risk here, not boilerplate.

   A direct consequence: the fee-on-transfer refusal is only fully enforced **on the way in**.
   `_pushExact` proves the vault was debited exactly but cannot prove what the receiver was credited,
   so an asset that *becomes* fee-on-transfer via a later upgrade can still shortchange a withdrawer.

2. **An unseeded vault is grief-able.** Donating X into an *empty* vault sets a price floor of X/1000
   per share, which makes every deposit below that revert with `ZeroShares`
   (`test_emptyVaultDonationGriefsSmallDepositsAtOneThousandXCost` asserts the exact threshold).
   Nothing is stolen — the cost to the griefer is ~1000× the deposit size they block — but deposits can
   be blocked. **`DeployRobinhoodExpansion.s.sol` seeds the vault in the same run by default and burns
   the seed shares, which closes this.** Skipping the seed requires setting `VAULT_SEED_ASSETS=0`
   explicitly, and the script prints a loud warning when you do.

3. **Two guards deserve a second pair of eyes.** `ZeroShares`/`ZeroAssets` are a deliberate ERC-4626
   deviation: `previewDeposit`/`previewRedeem` can return 0 for an amount the corresponding call then
   reverts on, and the spec prefers preview and call to agree. Reverting was chosen over silently
   burning a depositor's principal. It is a judgement call an integrator could be surprised by.

Smaller, stated for completeness: conversions use checked `a*b/c` rather than 512-bit mulDiv, so
absurdly large inputs revert instead of truncating; a holder whose entire position is worth less than
1 wei cannot redeem (the shares are genuinely worth zero, but `totalSupply` may not return to 0); and
a rebasing asset accrues pro rata without complaint, including negative rebases, which this contract
neither warns about nor resists.

**Verdict: do not put other people's funds in this until it has been independently reviewed.** Deploy
it, seed it, exercise it with your own money if you like — but the vault is the piece of this work that
carries real custody risk, and one agent's test suite is not a review.

---

## 4. `script/DeployRobinhoodExpansion.s.sol`

Keyless, in the `DeployBase.s.sol` style: bare `vm.startBroadcast()`, deployer from `--sender`,
governance from an address env var. **No private key is read, written or requested anywhere.**

It **adds to** the existing live deployment. It does not deploy a registry, an allowlist, a factory or
an implementation — those already exist on 4663, pinned from `src/lib/robinhood.ts`:

| Contract | Address | Status |
| --- | --- | --- |
| `OpenZapFactory` | `0xFC775017b25d2458623E2f3E735A4B750dD8b4E4` | live, `VERSION()` == `1.1.0` |
| `AdapterRegistry` | `0x9E56e444f490C00A6277326A47Cb462E12dF1f17` | live |
| `TokenAllowlist` | `0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B` | live |
| `OpenZap` implementation | `0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A` | live |
| `RobinhoodV4SwapAdapter` (hardcoded pool) | `0x04f62dA4b51a010eFa32aa81569169C47AEd602C` | live, already allowlisted |

Do **not** re-run `DeployRobinhood.s.sol`. It deploys a *new, disconnected* core and would orphan every
capsule the live factory has already produced. (It also reads `DEPLOYER_PRIVATE_KEY`, which the new
script does not.)

### Who can do what — the part to read twice

Read live from the chain at the time of writing:

```
AdapterRegistry.owner()        0xe17f5150A2954889988e63C49d41cc321c35B986   (EOA, no code)
AdapterRegistry.pendingOwner() 0x5a52D4B820Ae7F02880d270562950918ACb14aA2   (EOA, no code)
TokenAllowlist.owner()         0xe17f5150A2954889988e63C49d41cc321c35B986
TokenAllowlist.pendingOwner()  0x5a52D4B820Ae7F02880d270562950918ACb14aA2
```

Two things worth naming rather than glossing:

- **The ownership handoff is proposed but NOT accepted.** `0x5a52D4B8…` has never called
  `acceptOwnership()` on either contract, so `0xe17f5150…` is still the kill-switch holder today.
- **Both addresses are EOAs, not Safes.** The `AdapterRegistry` NatSpec says the owner "is intended to
  be a Safe multisig behind a TimelockController". It is not. That is a governance gap independent of
  this work, and it should be closed before the deployment is treated as production.

| Step | Who can do it |
| --- | --- |
| Deploy `RobinhoodV4PoolAdapter` | **anyone** — needs no permission |
| Deploy `ZapVault` | **anyone** |
| Seed the vault | **the deployer**, from their own balance |
| `AdapterRegistry.setAdapter(adapter, true)` | **only** the current registry `owner()` |
| `TokenAllowlist.setToken(USDG, true)` | **only** the current allowlist `owner()` |
| `TokenAllowlist.setToken(vaultShare, true)` | **only** the current allowlist `owner()` |

The script checks `owner()` live and takes the branch actually available. If the deployer happens to be
the owner, it makes the calls in the same run. If not, it **skips them, still succeeds, and prints the
exact calls including raw calldata**. It never claims a governance call happened when it did not.

Current allowlist state, read live: aeWETH and 0xZAPS are allowed; **USDG is not**. So a USDG-legged
zap needs `setToken(USDG, true)` before it can settle, regardless of the adapter.

### What it refuses to do

- Any chain other than 4663.
- A factory not wired to the pinned registry/allowlist, or whose `VERSION()` is not `1.1.0`.
- An adapter whose resulting `poolId()` is not the one you named (`EXPECTED_POOL_ID`).
- An adapter for a pool with **zero live liquidity** — the script reads the pool's `liquidity` straight
  out of the PoolManager via `extsload` before broadcasting anything.
- An **unseeded** vault, unless you explicitly ask for one with `VAULT_SEED_ASSETS=0`.
- A seed the deployer cannot fund — it aborts with `UnfundedSeed(asset, needed, held)` in preflight,
  before either contract is deployed.

### Environment (all optional; defaults are the measured values)

| Var | Default | Notes |
| --- | --- | --- |
| `GOVERNANCE` | live `AdapterRegistry.owner()` | **reporting only** — this script cannot transfer ownership of contracts it did not deploy |
| `POOL_CURRENCY0` / `POOL_CURRENCY1` | aeWETH / USDG | must be sorted, non-duplicate, both with code |
| `POOL_FEE` | `450` | `0x800000` == dynamic fee (then a hook is required) |
| `POOL_TICK_SPACING` | `9` | |
| `POOL_HOOKS` | `address(0)` | hookless |
| `EXPECTED_POOL_ID` | `0x6ba18d46…5d2` | **change any pool field and you must change this too, or the run aborts** |
| `REQUIRE_POOL_LIQUIDITY` | `true` | |
| `VAULT_ASSET` | USDG | |
| `VAULT_NAME` / `VAULT_SYMBOL` | `OpenZap USDG Vault` / `ozUSDG` | |
| `VAULT_SEED_ASSETS` | `1000000` (1.000000 USDG) | |
| `VAULT_SEED_RECIPIENT` | `0x…dEaD` | seed shares are intended to be unredeemable forever, which is what makes the price floor permanent |

---

## 5. Dry run — simulated, nothing broadcast

Both governance branches were exercised against a live Robinhood Chain fork with **no `--broadcast`**.

### Branch A — deployer IS the owner

```
VAULT_SEED_ASSETS=0 forge script script/DeployRobinhoodExpansion.s.sol:DeployRobinhoodExpansion \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender 0xe17f5150A2954889988e63C49d41cc321c35B986
```

Simulated at block 16,740,207:

```
RobinhoodV4PoolAdapter  0xE8F21cbF41b3912A35b2DD39550394dE86023E16
  poolId 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2
  live pool liquidity 458863800268059794
ZapVault                0x51dEae9a3D7b21fe9CE093167008c833206fB760
  asset USDG, symbol ozUSDG, share decimals 9

DONE. The deployer owned both governance contracts, so every call below was
executed in this run. Nothing further is required.
  [satisfied on chain] AdapterRegistry.setAdapter(adapter, true)
  [satisfied on chain] TokenAllowlist.setToken(currency0, true)
  [satisfied on chain] TokenAllowlist.setToken(currency1, true)
  [satisfied on chain] TokenAllowlist.setToken(vaultShare, true)

NOTE: an ownership handoff is still pending and NOT accepted.

Estimated total gas used for script: 3,057,811
Estimated gas price: 0.180092001 gwei
Estimated amount required: 0.000550687301669811 ETH
```

### Branch B — deployer is NOT the owner, seeded

Run with a sender that actually holds USDG, to exercise the seed path and the "not the owner" path at
once:

```
forge script script/DeployRobinhoodExpansion.s.sol:DeployRobinhoodExpansion \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender <an address holding >= 1 USDG>
```

```
RobinhoodV4PoolAdapter  0xeC34f375671dECA0492d42bF3a4541FBeF2caF1D
ZapVault                0x6BCC357fE41536D8a19D8F5ECac67ddd55354fc0
  seeded assets 1000000
  seed shares   1000000000
  seed shares sent to (unredeemable by design) 0x000000000000000000000000000000000000dEaD

ACTION REQUIRED. At least one entry below is still PENDING ...
  [PENDING - owner must send] AdapterRegistry.setAdapter(adapter, true)
    0x332f6465000000000000000000000000ec34f375671deca0492d42bf3a4541fbef2caf1d
      0000000000000000000000000000000000000000000000000000000000000001
  [satisfied on chain]        TokenAllowlist.setToken(currency0, true)     (aeWETH already allowed)
  [PENDING - owner must send] TokenAllowlist.setToken(currency1, true)     (USDG NOT allowed)
  [PENDING - owner must send] TokenAllowlist.setToken(vaultShare, true)

Estimated total gas used for script: 3,156,112
Estimated gas price: 0.179152001 gwei
Estimated amount required: 0.000565423780180112 ETH
```

Per-transaction gas from the dry-run record:

| Tx | Gas |
| --- | --- |
| CREATE `RobinhoodV4PoolAdapter` | 1,410,532 |
| CREATE `ZapVault` | 1,439,084 |
| `USDG.approve(vault, seed)` | 80,078 |
| `ZapVault.deposit(seed, 0x…dEaD)` | 173,876 |
| `USDG.approve(vault, 0)` | 52,542 |

Note the addresses differ between branches only because they are CREATE addresses derived from the
sender's nonce. The real deployment address depends on the real deployer.

### The fail-closed default, proven

Running with the real deployer and the default seed aborts in preflight, **before deploying anything**,
because that address holds no USDG:

```
Error: script failed: UnfundedSeed(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, 1000000 [1e6], 0)
```

That is the intended behaviour: you fund the seed, or you explicitly opt out of it.

---

## 6. Runbook

### Prerequisites the deployer must arrange first

1. **Gas.** `0xe17f5150…` currently holds `0.001074602467948` ETH. The dry run estimates ~0.00057 ETH
   for the full seeded run at 0.18 gwei. That is enough today, but it is not comfortable margin —
   top it up.
2. **Seed capital.** The deployer must hold at least `VAULT_SEED_ASSETS` of `VAULT_ASSET`. Today
   `0xe17f5150…` holds **0 USDG**, so the default run will abort until it is funded with 1 USDG.
3. **Decide the pool.** The default is the deepest live hookless aeWETH/USDG pool. If you want a
   different one, set the pool vars **and** `EXPECTED_POOL_ID` together.

### Step 1 — deployer, with their own key, dry run first

Always simulate before broadcasting. This costs nothing and catches every preflight failure.

```bash
cd contracts
forge script script/DeployRobinhoodExpansion.s.sol:DeployRobinhoodExpansion \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender <DEPLOYER>
```

Check the printed `poolId`, the live pool liquidity, the vault asset/symbol/decimals, and the seed
figures. If any of it surprises you, stop.

### Step 2 — deployer broadcasts

Add `--broadcast` and **your own** wallet configuration. Use a hardware wallet or a keystore account.
The script has no key handling of its own and never will.

```bash
forge script script/DeployRobinhoodExpansion.s.sol:DeployRobinhoodExpansion \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender <DEPLOYER> \
  --broadcast \
  --ledger                # or --account <keystore-name>, --trezor, --interactive
```

Record the two printed addresses. Optionally add `--verify` if a verifier is configured for
Blockscout (`https://robinhoodchain.blockscout.com`).

### Step 3 — governance sends what the deployer could not

If the deployer was **not** the registry/allowlist owner, the script printed a `[PENDING]` list with
raw calldata. Those must be sent **from the current `owner()`** — which is `0xe17f5150…` until
`0x5a52D4B8…` calls `acceptOwnership()`.

```bash
# 1. allow the new swap adapter (AdapterRegistry owner)
cast send 0x9E56e444f490C00A6277326A47Cb462E12dF1f17 \
  "setAdapter(address,bool)" <NEW_ADAPTER> true \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --ledger --from <OWNER>

# 2. allow USDG as a routable/trackable token (TokenAllowlist owner)
cast send 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B \
  "setToken(address,bool)" 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 true \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --ledger --from <OWNER>

# 3. allow the vault share token (TokenAllowlist owner)
cast send 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B \
  "setToken(address,bool)" <NEW_VAULT> true \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --ledger --from <OWNER>
```

aeWETH is already allowed; do not re-send it.

Verify:

```bash
cast call 0x9E56e444f490C00A6277326A47Cb462E12dF1f17 "isAllowed(address)(bool)" <NEW_ADAPTER> --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B "isAllowed(address)(bool)" 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B "isAllowed(address)(bool)" <NEW_VAULT> --rpc-url https://rpc.mainnet.chain.robinhood.com
```

### Step 4 — close the governance gap (independent of this work, still required)

1. `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` calls `acceptOwnership()` on **both**
   `0x9E56e444…` and `0x87fBb77a…`. Until then the handoff has not happened.
2. That address is an **EOA**. Move ownership to a Safe multisig behind a TimelockController, which is
   what both contracts' NatSpec assumes. A single EOA holding the kill switch for a live deployment is
   not a production posture.

### Step 5 — what is still missing before the vault is usable in a zap

**The vault is deployed and allowlisted but still not reachable from a zap step.** `OpenZap.execute`
calls `IAdapter(adapter).execute(tokenIn, amountIn, data)`; nothing in this work implements an adapter
that calls `vault.deposit(amountIn, msg.sender)`.

To close it:

1. Write a `ZapVaultDepositAdapter` following the same rules as `RobinhoodV4PoolAdapter` — one fixed
   selector, no arbitrary calldata, measured delta returned, zero residual allowance on every path,
   reentrancy guard. `test_oneTokenInOneReceiptOutForAnArbitraryReceiver` in `test/ZapVault.t.sol`
   already pins the exact interface shape it depends on: exact asset debit, receipt delta equal to the
   return value, nothing stranded on the caller.
2. Fork-test it.
3. Have governance `setAdapter` it.

Until then, `ZapVault` is a standalone vault that people can deposit into directly, and `supply`/`stake`
blocks remain unavailable on Robinhood Chain inside a capsule.

---

## 7. Test status

Both suites green, no assertions weakened. Nothing was fixed because nothing was broken.

```
$ forge test
Ran 17 test suites in 445.25ms (2.10s CPU time): 151 tests passed, 0 failed, 3 skipped (154 total tests)

$ forge test --fork-url https://rpc.mainnet.chain.robinhood.com
Ran 17 test suites in 7.15s (66.90s CPU time): 151 tests passed, 0 failed, 3 skipped (154 total tests)
```

**About the 3 skips.** They are all pre-existing, and none of them is new work hiding:

| Skipped | Why |
| --- | --- |
| `DeployedBaseE2E.t.sol` `setUp()` | needs `DEPLOYED_*` env addresses for a live Base deployment |
| `RobinhoodV4Fork.t.sol` | gated behind `RUN_ROBINHOOD_FORK` |
| `RobinhoodOpenZapFork.t.sol` | gated behind `RUN_ROBINHOOD_FORK` |

The **new** Robinhood suite is deliberately not gated. `RobinhoodV4PoolAdapter.fork.t.sol` calls
`vm.createSelectFork(RPC_URL, 16_728_000)` unconditionally in `setUp`, exactly like the Base fork
suites, so it **cannot silently skip** — it either runs against real chain state or it fails loudly.
That is why it reports 15 passed rather than 15 skipped in the plain `forge test` run above.

The two legacy gated suites were left as they are (out of scope), but they were run explicitly to prove
they are not hiding failures:

```
$ RUN_ROBINHOOD_FORK=true forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-path "test/Robinhood*"
Ran 4 test suites in 9.21s (19.68s CPU time): 21 tests passed, 0 failed, 0 skipped (21 total tests)
```

Contract sizes:

| Contract | Runtime (B) | Initcode (B) | Runtime margin (B) |
| --- | --- | --- | --- |
| `RobinhoodV4PoolAdapter` | 4,686 | 5,570 | 19,890 |
| `ZapVault` | 4,530 | 5,794 | 20,046 |
| `RobinhoodV4SwapAdapter` (existing) | 4,254 | 5,015 | 20,322 |

---

## 8. Summary of what is not done

- **No deposit adapter for `ZapVault`.** The vault cannot be a zap step until one exists (§6 step 5).
- **`ZapVault` is unaudited** and should not hold third-party funds until reviewed (§3).
- **Nothing was broadcast.** Every number in §5 is a simulation. No private key was written, requested
  or read at any point.
- **Governance is an EOA with an unaccepted handoff pending.** Independent of this work, but it gates
  calling any of this production.
- **Tokenised-equity pools (NVDA/TSLA/AAPL) are untested.** The adapter is pool-agnostic and should
  serve them, but "should" is not "measured".
