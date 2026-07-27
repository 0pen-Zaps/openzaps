# OpenZaps Deployments

**Verified against live chain state on 2026-07-23.** Every address below was read directly from the
chain (`cast code` / `isAllowed` / `owner`), not from a broadcast log. Where a contract is deployed
but its route is deliberately not yet advertised in the app, that is stated.

> **Pre-external-audit.** The suites are live and internally/fork/mainnet tested, but have **not** had
> a professional third-party audit. `ZapVault` is additionally unaudited and non-yield-bearing (see
> below). Keep user deposits scoped and recoverable with `emergencyExit` until external review is
> complete.

---

## Robinhood Chain mainnet (chainId 4663) — live

### Core (v1.1.0)

| Contract | Address |
|---|---|
| OpenZapFactory v1.1.0 | [`0xFC775017b25d2458623E2f3E735A4B750dD8b4E4`](https://robinhoodchain.blockscout.com/address/0xFC775017b25d2458623E2f3E735A4B750dD8b4E4) |
| OpenZap implementation | [`0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A`](https://robinhoodchain.blockscout.com/address/0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A) |
| AdapterRegistry | [`0x9E56e444f490C00A6277326A47Cb462E12dF1f17`](https://robinhoodchain.blockscout.com/address/0x9E56e444f490C00A6277326A47Cb462E12dF1f17) |
| TokenAllowlist | [`0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B`](https://robinhoodchain.blockscout.com/address/0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B) |

### Allowlisted adapters

| Adapter | Address | Route | Status |
|---|---|---|---|
| RobinhoodV4SwapAdapter | [`0x04f62dA4b51a010eFa32aa81569169C47AEd602C`](https://robinhoodchain.blockscout.com/address/0x04f62dA4b51a010eFa32aa81569169C47AEd602C) | aeWETH ⇄ 0xZAPS (pinned pool) | **live, in app** |
| RobinhoodV4PoolAdapter | [`0x714E48930d1d9a53149AA7B92cD88C9E172d1942`](https://robinhoodchain.blockscout.com/address/0x714E48930d1d9a53149AA7B92cD88C9E172d1942) | aeWETH ⇄ USDG (pinned pool) | **live, in app** |
| ZapVaultDepositAdapter | [`0x1b289fD37Ff4497531a953aa922ab258F5e81164`](https://robinhoodchain.blockscout.com/address/0x1b289fD37Ff4497531a953aa922ab258F5e81164) | USDG → ozUSDG | live, **fails closed in app until vault seeded** |
| ZapVaultRedeemAdapter | [`0x16eD4f04657c7a965aef333F5Cf0c9d745e0c8cE`](https://robinhoodchain.blockscout.com/address/0x16eD4f04657c7a965aef333F5Cf0c9d745e0c8cE) | ozUSDG → USDG | live, **fails closed in app until vault seeded** |

### ZapVault (ERC-4626 receipt wrapper)

| | |
|---|---|
| ZapVault (`ozUSDG`) | [`0xeAD10C998c59745a030FfAc9209b294C14C7D325`](https://robinhoodchain.blockscout.com/address/0xeAD10C998c59745a030FfAc9209b294C14C7D325) |
| Underlying asset | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dp) |
| Share decimals | 9 |
| State | **UNSEEDED** (`totalSupply == 0`) as of 2026-07-23 |

> `ZapVault` is **unaudited** and **earns nothing** — `totalAssets()` is `asset.balanceOf(vault)`, a
> pure receipt wrapper, not a yield product. It must never be presented as yield. While unseeded, an
> empty ERC-4626 is donation-attackable, so the app deliberately fails the vault routes closed
> (`deployedRoutes()` gates on `totalSupply > 0`). Seed with ≥ 1 USDG before advertising it.

### Allowlisted tokens

| Token | Address |
|---|---|
| aeWETH (pool WETH) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| 0xZAPS | `0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dp) |
| ozUSDG (vault share) | `0xeAD10C998c59745a030FfAc9209b294C14C7D325` |

### Pinned routes

**aeWETH ⇄ 0xZAPS** (RobinhoodV4SwapAdapter)
- Pool ID: `0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573`
- Hook: `0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc`; dynamic fee flag `0x800000`; tick spacing `200`

**aeWETH ⇄ USDG** (RobinhoodV4PoolAdapter)
- Pool ID: `0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2`
- Fee `450`; tick spacing `9`; hookless (deepest hookless pool on the pair)

**Shared infrastructure**
- Universal Router: `0x8876789976DeCBfcBbBE364623c63652db8c0904`
- Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- v4 PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`

### Governance

- Registry + Allowlist owner: **`0x5a52D4B820Ae7F02880d270562950918ACb14aA2`** (nodar.eth) — ownership
  handoff **accepted** on both contracts; `pendingOwner` is zero on both. (This supersedes the earlier
  record showing `0xe17f5150…` as owner with a pending transfer.)
- **Recommended next step:** move ownership to a Safe multisig behind a TimelockController. A single
  EOA holding the kill switch for a live deployment is not a production posture.

### Verification and live smoke

- Sourcify reports creation and runtime `match` for the core artifacts on chain `4663`.
- Robinhood Blockscout exposes source, ABI, compiler settings, and constructor args.
- Foundry: full unit/fuzz/invariant suite passes; Robinhood fork covers real adapter buy/sell and the
  complete Factory→clone→EIP-712→execute path.
- Mainnet smoke zap: [`0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4`](https://robinhoodchain.blockscout.com/address/0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4);
  execute [`0x30637132e29de0a29181f1ae3392acf947351702966eb22a5ea03d6faa845aa6`](https://robinhoodchain.blockscout.com/tx/0x30637132e29de0a29181f1ae3392acf947351702966eb22a5ea03d6faa845aa6)
  — `0.00005` aeWETH in, `170800.958093014101263641` 0xZAPS out; nonce consumed; balances and transient
  allowances zero.

### Superseded / cleanup note

A duplicate expansion set was deployed by mistake on 2026-07-23 and has since been **de-allowlisted**
(all read `isAllowed() == false`; nothing in the app references them): pool adapter
`0x8cA51A27c4C7Ee935e9900DcD62982E5bA19c0FE`, vault `0xDB5B18ceecFC5F463Db4F20CBD95d991FED9acBE`,
deposit `0x63775ae22B7728B6652AC2B5fe3ddf594CdF9Dd8`, redeem `0x9A6dc711b7Eba084c2BbFdf3448F7C32Ac1301CD`.
Do not reference these as current.

---

### The "Use" expansion — live (broadcast at blocks 17,228,330–332, 2026-07-23)

Deployed from [`contracts/script/DeployRobinhoodUse.s.sol`](../contracts/script/DeployRobinhoodUse.s.sol)
by the governance owner, so every allowlisting call executed in the same run. Canonical record:
this table plus `contracts/broadcast/DeployRobinhoodUse.s.sol/4663/run-latest.json`. All 17
transactions succeeded; every address below was verified onchain post-broadcast (route paths, pool
ids, vault welds, allowlist state).

| Contract | Address |
|---|---|
| RobinhoodV4RouteAdapter USDG→aeWETH→0xZAPS | [`0x132e65D4A28ec1687D3B2b2a6e2DfD75afCf4900`](https://robinhoodchain.blockscout.com/address/0x132e65D4A28ec1687D3B2b2a6e2DfD75afCf4900) |
| RobinhoodV4RouteAdapter 0xZAPS→aeWETH→USDG | [`0x9C3F7F057aC3d2828C7271ba73538B33E32E7a59`](https://robinhoodchain.blockscout.com/address/0x9C3F7F057aC3d2828C7271ba73538B33E32E7a59) |
| ZapRangeVault (ozRANGE) | [`0x9FE852CE89c5920a87F8465C91B9e691f37BeD5B`](https://robinhoodchain.blockscout.com/address/0x9FE852CE89c5920a87F8465C91B9e691f37BeD5B) |
| ZapRangeDepositAdapter | [`0xaB2e75fdb8f108c0589048c8cc0F3ce5Fb8b7896`](https://robinhoodchain.blockscout.com/address/0xaB2e75fdb8f108c0589048c8cc0F3ce5Fb8b7896) |
| ZapRangeWithdrawAdapter (settles USDG) | [`0xDeaC50A0fD41e66900E8a4ab721ce8A43129aE1C`](https://robinhoodchain.blockscout.com/address/0xDeaC50A0fD41e66900E8a4ab721ce8A43129aE1C) |
| ZapRangeWithdrawAdapter (settles aeWETH) | [`0x5a7F5e5D5Ef503300E04Ab91145CDA2F1c7289B8`](https://robinhoodchain.blockscout.com/address/0x5a7F5e5D5Ef503300E04Ab91145CDA2F1c7289B8) |

- Both route adapters resolve to the pinned pools (hookless `0x6ba18d46…5d2`, hooked
  `0xb040f18a…573`) and refuse everything else.
- The vault is seeded with 0.0005 aeWETH + 1 USDG → position liquidity `21,951,737,506`, total
  supply `21,951,737,506,000` shares (exactly 1000×), **all held by `0x…dEaD`** — the first-depositor
  price floor is permanent. Seed deposit: [`0x13f18286…4f2e`](https://robinhoodchain.blockscout.com/tx/0x13f18286b774b4194120553781c805f90be51669e116feb20f7a3357ef4e4f2e).
- All five adapters are allowlisted in the AdapterRegistry; the ozRANGE share token (the vault
  address) is allowlisted in the TokenAllowlist. The previously-missing ozUSDG allowlist entry is
  also now in place, unblocking the older ZapVault adapters.
- **Pre-external-audit**, like everything on this chain — and `ZapRangeVault` custodies real funds
  with more moving parts than anything before it. See `contracts/USE_EXPANSION.md` §6 before
  advertising LP deposits to third parties.

### The v3 execution stack — live (broadcast at block 17,601,632, 2026-07-23)

Deployed from [`contracts/script/DeployV3Robinhood.s.sol`](../contracts/script/DeployV3Robinhood.s.sol)
by `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` (governance for the pot and the price-source
registry; two-step transferable). All 6 transactions succeeded; every wire below was verified
onchain post-broadcast (factory↔pot binding, price-source allowlisting, live pool read,
`implCodeHash` match against the local build). Canonical record: this table plus
`contracts/broadcast/DeployV3Robinhood.s.sol/4663/run-latest.json`.

| Contract | Address |
|---|---|
| OpenZapFactoryV3 (`3.0.0-candidate`) | [`0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9`](https://robinhoodchain.blockscout.com/address/0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9) |
| OpenZapV3 implementation | [`0x0309E72Ffd1c6855FF519d9E923AEFc0C52bFdb5`](https://robinhoodchain.blockscout.com/address/0x0309E72Ffd1c6855FF519d9E923AEFc0C52bFdb5) |
| ZapLotteryPot | [`0xeB7a15CE1c969efBA43ecfc1A63960Ad0042CFe3`](https://robinhoodchain.blockscout.com/address/0xeB7a15CE1c969efBA43ecfc1A63960Ad0042CFe3) |
| Price-source registry (AdapterRegistry) | [`0xd83a2dedb6185395A1Ac1d0abb9F98472feAd574`](https://robinhoodchain.blockscout.com/address/0xd83a2dedb6185395A1Ac1d0abb9F98472feAd574) |
| V4PoolPriceSource (aeWETH/0xZAPS pool) | [`0x60C310586541763D7f4dcc777F495f0627Bb098f`](https://robinhoodchain.blockscout.com/address/0x60C310586541763D7f4dcc777F495f0627Bb098f) |

- `implCodeHash` `0x99c49515bd0a7038c216a0d710676c4c63bb7dd09108de5fddca885542057149`.
- The factory REUSES the live v1.1 `AdapterRegistry` and `TokenAllowlist` — one governance surface
  for adapters/tokens; the new registry instance governs trigger price sources only.
- v3 capsules add the recurring + price-triggered execution types and the executor economy (1%
  output fee: 80% submitter / 20% pot → 0xZAPS lottery). See
  [`contracts/src/v3/README.md`](../contracts/src/v3/README.md). Domain version `"3"`.
- The reference executor daemon ([`executor/`](../executor/README.md)) runs as LaunchAgent
  `com.openzaps.executor`, watch-only until a gas key is configured.
- **Pre-external-audit**, like everything on this chain. The app's Zap now tab deploys v1.1
  capsules; the Automate tab deploys v3 capsules against this factory.

### The v3.1 relative-floor stack — live (2026-07-24)

UNAUDITED CANDIDATE. Deployed from [`contracts/script/DeployV3_1Robinhood.s.sol`](../contracts/script/DeployV3_1Robinhood.s.sol)
by `0x5a52…4aA2` (nonce 206→212, all 6 txs succeeded). Adds `executeRecurringRelative`: a recurring
per-run floor computed from the oriented price source's spot **at execution**, so a series can't go
stale (the v3 absolute floor could — a live zap hit exactly that). Superset of v3; domain version
`"3.1"`; its own price-source registry and lottery pot (`setFactory` is one-shot). Wired on-chain
post-broadcast (factory↔pot, source allowlisted, currency0=aeWETH/currency1=0xZAPS, live spot read).

| Contract | Address |
|---|---|
| OpenZapFactoryV3_1 (`3.1.0-candidate`) | [`0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1`](https://robinhoodchain.blockscout.com/address/0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1) |
| OpenZapV3_1 implementation | [`0x0fE5bC78b2bAc5f09E940C2aCcC0c3B785d91063`](https://robinhoodchain.blockscout.com/address/0x0fE5bC78b2bAc5f09E940C2aCcC0c3B785d91063) |
| ZapLotteryPot (v3.1) | [`0x6ec3D07886Ea641e9d10D45A97a72E5f8ec836F1`](https://robinhoodchain.blockscout.com/address/0x6ec3D07886Ea641e9d10D45A97a72E5f8ec836F1) |
| Price-source registry (v3.1) | [`0x76CB210F25D016078E10DbfCb19AFfBbB4892e33`](https://robinhoodchain.blockscout.com/address/0x76CB210F25D016078E10DbfCb19AFfBbB4892e33) |
| V4PoolPriceSourceOriented | [`0xB4f66bFa00D2496513a5fD43ff47912A3fe0Bb5F`](https://robinhoodchain.blockscout.com/address/0xB4f66bFa00D2496513a5fD43ff47912A3fe0Bb5F) |

Addresses are wired into `src/lib/robinhood.ts` (`OPENZAP_V3_1_CONTRACTS`). The end-to-end
create/sign/execute path for relative-floor recurring zaps (app + executor + relay support) is the
follow-up; the contract set itself is live and verified.

### The v3.2 stacking stack — built, NOT deployed

UNAUDITED CANDIDATE. Source is in [`contracts/src/v3_2`](../contracts/src/v3_2); no addresses exist
yet, on any chain. Adds `executeRecurringStack`: everything `executeRecurringRelative` does, plus an
owner-signed `stackBps` slice of every run's **post-fee** output converted into 0xZAPS and staked to
the lottery pot as the **owner's** tickets. Every run of a stacking series is a real market buy of
the protocol token — the first execution type where buying 0xZAPS is the user's own authorized
choice rather than the protocol's fee slice. Superset of v3.1; domain version `"3.2"`.

Verified strict-superset property: `diff` of the v3.1 and v3.2 implementations removes **no logic**
from v3.1 — only two import paths, the `DOMAIN_VERSION` literal, and the widened constructor.

What it adds over v3.1, all enforced on-chain:

- **Two spot-derived floors.** `priceSource`/`maxSlippageBps` floor the recipient's leg as in v3.1;
  `stackPriceSource` floors the 0xZAPS conversion leg. Without the second, a manipulated pool turns a
  real slice of the owner's output into dust tickets.
- **The recipient floor is scaled by `stackBps`,** so a run can never clear its floor while handing
  the recipient less than that floor.
- **`SlippageBelowFee`.** The floor is gross-derived but net-enforced, so any band ≤ `EXEC_FEE_BPS`
  bricks every run forever. v3.1 accepted such a band (a live series signed at exactly 100 bps could
  never execute); v3.2 refuses to mint that authorization at all.
- **`ZAPS` and `ZAPS_ADAPTER` are read from the pot** by the factory, not passed in, so a clone can
  never stake a different token than the pot pays out or convert through a different adapter than
  the pot's own `buyZaps`.
- **No pot changes required.** `ZapLotteryPot.notifyContribution` already credits both tickets and
  `roundPrize` when the contributed asset is 0xZAPS, which is exactly what a stack contribution is.

Deployment prerequisites, in order:

1. A **new** `ZapLotteryPot` — `setFactory` is one-shot, so v3.2 cannot share the v3 or v3.1 pot.
2. `OpenZapFactoryV3_2(adapters, tokens, priceSources, pot)`, then `pot.setFactory(factory)`.
3. Allowlist an oriented price source for the main leg, and one pricing `outAsset → 0xZAPS` for the
   conversion leg (only needed for zaps whose output is not already 0xZAPS).
4. Fill `OPENZAP_V3_2_CONTRACTS` in `src/lib/robinhood.ts` (or the `NEXT_PUBLIC_OPENZAP_V3_2_*` env
   vars). Until then `openZapV3_2Configured()` is `false` and the Automate surface must keep the
   stacking option hidden — offering a creation path into an undeployed lineage would fail open.
5. Apply `supabase/migrations/20260726000000_allow_recurring_stack_kind.sql`, or every publish of a
   stacking intent returns an opaque `Relay storage failed (400)` from the `kind` CHECK constraint.

The app-side mirror (EIP-712 types, settlement math, drafting guards, relay/activity plumbing) and
both test suites are already in place: `contracts/test/OpenZapV3_2.stack.t.sol` (14 tests) and the
`executions`/`automate` vitest suites.

### Universal app-creation fee gateway — live (2026-07-25)

UNAUDITED CANDIDATE. Deployed from
[`contracts/script/DeployCreationGatewayRobinhood.s.sol`](../contracts/script/DeployCreationGatewayRobinhood.s.sol)
at blocks 19,539,599–19,539,642. The gateway preserves the existing v1.1, v3, and v3.1 factories:
the current app sends exactly `0.00001 ETH`, atomically converts it through the pinned
aeWETH→0xZAPS adapter with a caller-reviewed minimum output, and credits a separate creation pot.

| Contract | Address |
|---|---|
| OpenZapCreationGateway (`1.0.0-candidate`) | [`0x02A17a94A0e2B470e931E98079Bf563c94281B2b`](https://robinhoodchain.blockscout.com/address/0x02A17a94A0e2B470e931E98079Bf563c94281B2b) |
| ZapCreationFeePot | [`0x8E0399A8fF81a5f73Bc76CAEE8a355cF9bb0d863`](https://robinhoodchain.blockscout.com/address/0x8E0399A8fF81a5f73Bc76CAEE8a355cF9bb0d863) |

- Deployment transactions: [`0xbded2843…b2937`](https://robinhoodchain.blockscout.com/tx/0xbded28430d14eed79df4cf73c1e65af70630c0ca3bcdf7c4008e238cca6b2937),
  [`0x09e7e483…a1299`](https://robinhoodchain.blockscout.com/tx/0x09e7e483f0ffcf564ecae5ec1a45b4bba81894f00a941c9f17d60bc39a8a1299),
  and [`0x1d882787…152c`](https://robinhoodchain.blockscout.com/tx/0x1d882787572dd395625b0781a617782e8a4b997dd081bf751f5a72477613152c)
  all succeeded. Actual total network cost was `0.000119145102024 ETH`.
- `ZapCreationFeePot.owner()` is governance `0x5a52…4aA2`; `pendingOwner()` and the one-shot
  `gatewayInstaller()` are both zero. The pot is bound to the gateway and has no owner sweep path.
- The gateway's factory pins, aeWETH, 0xZAPS, adapter, pot, and `10,000,000,000,000 wei` fee were
  independently read back. It held zero ETH, aeWETH, 0xZAPS, and zero adapter allowance after deployment.
- The existing automated execution fee remains separate: 1% per run, split 80% executor / 20% to
  the original v3 or v3.1 automation pot.

## Base mainnet (chainId 8453)

### Live v1.1 core (2026-07-23)

A fresh v1.1 core is deployed on Base. It is **not** exposed as an active app route yet — `/app`
targets the Robinhood v1.1 deployment, and multi-chain UI is a separate milestone.

| Contract | Address |
|---|---|
| OpenZapFactory v1.1.0 | [`0x3263e547faf1d90211a92e8556bda5afce07805f`](https://basescan.org/address/0x3263e547faf1d90211a92e8556bda5afce07805f) |
| BaseV3SwapAdapter | [`0xe5757cefac7fe3e70c68840b0a1c0862e9187f22`](https://basescan.org/address/0xe5757cefac7fe3e70c68840b0a1c0862e9187f22) |
| AaveV3SupplyAdapter | [`0xe67ed83ba4229d0dab0ec8d8055f8de06887b212`](https://basescan.org/address/0xe67ed83ba4229d0dab0ec8d8055f8de06887b212) |
| AaveV3WithdrawAdapter | [`0x9c52b2c6701e5ca9d260c20022a0454ca50a1096`](https://basescan.org/address/0x9c52b2c6701e5ca9d260c20022a0454ca50a1096) |

- Routes: `WETH → USDC` (Uniswap v3, 0.05%), `WETH → aWETH` (Aave v3 supply),
  `aWETH → WETH` (Aave v3 withdraw). A borrow leg is deliberately absent — it cannot be expressed
  under `IAdapter` without breaking `emergencyExit` or granting a shared adapter custody of collateral.
- The `AaveV3WithdrawAdapter` execution path is verified by its fork suite; confirm that suite is green
  before treating the withdraw route as execution-proven.

### Superseded v1.0.0 core (historical)

OpenZap has no upgrade path (I-ISO-2), so a new version is always a new deployment. The v1.0.0 core
below is **historical** — do not quote it as current.

| Contract | Address |
|---|---|
| OpenZapFactory v1.0.0 | [`0xc7C5897e4738a157731c2F93b1d73Db9926E926C`](https://basescan.org/address/0xc7C5897e4738a157731c2F93b1d73Db9926E926C) |
| OpenZap implementation | [`0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e`](https://basescan.org/address/0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e) |
| AdapterRegistry | [`0x8d62b619daD575704Ba2560CF828aCab7642347F`](https://basescan.org/address/0x8d62b619daD575704Ba2560CF828aCab7642347F) |
| TokenAllowlist | [`0x0E6608d6b9e485550289755176173c4B6008CF12`](https://basescan.org/address/0x0E6608d6b9e485550289755176173c4B6008CF12) |

---

## 0xZAPS token

Live on Robinhood Chain via Clanker V4: [`0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07`](https://robinhoodchain.blockscout.com/address/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)
(ERC-20, name OpenZaps). It confers no yield, equity, revenue claim, governance, or protocol access —
core workflows are never token-gated. Canonical market and explorer links are centralized in
`src/lib/config.ts`. The FWA-inspired **SOLDERWORKS** mechanics (`docs/solderworks-design.md`) are a
design, not a deployment — no token program is live.
