# OpenZaps Deployments

The original core and route set was independently read from live chain state on 2026-07-23
(`cast code` / `isAllowed` / `owner`), not copied from a broadcast log. Later live sections record
their own deployment and readback dates. Source-only candidates are labelled explicitly and their
simulation outputs are never listed as deployments.

> **Pre-external-audit.** The suites are live and internally/fork/mainnet tested, but have **not** had
> a professional third-party audit. `ZapVault` is additionally unaudited and non-yield-bearing (see
> below). Keep user deposits scoped and recoverable with `emergencyExit` until external review is
> complete.

> **Source/live boundary (2026-07-28).** The base-lineage source is now
> `1.2.0-candidate`; it adds one-way, owner-only `haltPolicy()` containment and a witnessed Permit2
> SignatureTransfer owner-pull path. The v2, v3, v3.1, and v3.2 sources also include the halt. The
> live Robinhood v1.1, v3, and v3.1 implementation addresses below predate these changes and **do
> not gain them retroactively**: v1.1 remains pre-funded, and existing recovery controls remain
> `invalidateNonce`/series cancellation and `emergencyExit`. Both candidate features require a newly
> deployed and independently verified implementation/factory.

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
- No registry or allowlist ownership change is part of this release. Re-read `owner()` and
  `pendingOwner()` from chain before any future governance action.

### Verification and live smoke

- Sourcify reports creation and runtime `match` for the core artifacts on chain `4663`.
- Robinhood Blockscout exposes source, ABI, compiler settings, and constructor args.
- Foundry: full unit/fuzz/invariant suite passes; Robinhood fork covers real adapter buy/sell and the
  complete Factory→clone→EIP-712→execute path.
- Mainnet smoke zap: [`0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4`](https://robinhoodchain.blockscout.com/address/0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4);
  execute [`0x30637132e29de0a29181f1ae3392acf947351702966eb22a5ea03d6faa845aa6`](https://robinhoodchain.blockscout.com/tx/0x30637132e29de0a29181f1ae3392acf947351702966eb22a5ea03d6faa845aa6)
  — `0.00005` aeWETH in, `170800.958093014101263641` 0xZAPS out; nonce consumed; balances and transient
  allowances zero.

### v1.2 halt + Permit2 lineage — built, NOT deployed

UNAUDITED CANDIDATE. [`OpenZapFactory`](../contracts/src/OpenZapFactory.sol) reports
`1.2.0-candidate` and deploys the current [`OpenZap`](../contracts/src/OpenZap.sol) implementation,
which adds one-way owner `haltPolicy()` and witnessed Permit2 SignatureTransfer owner-pull. The live
v1.1 factory and its existing clones remain immutable and do not gain either surface.

The guarded Robinhood deployment path is
[`DeployV1_2Robinhood.s.sol`](../contracts/script/DeployV1_2Robinhood.s.sol). It deploys only:

1. one new v1.2 factory, which creates and bricks its own implementation; and
2. one [`OpenZapV1_2CreationGateway`](../contracts/src/fee/OpenZapV1_2CreationGateway.sol), which
   creates and one-shot binds its own dedicated `ZapCreationFeePot` in the same constructor.

The new factory reuses the live `AdapterRegistry` and `TokenAllowlist` read-only. Before and after
deployment, the script requires the exact live v1.1 factory pins/version, governance owners, zero
pending owners, all nine documented adapter bits, all five documented token bits, the canonical
fee-adapter pool/router/Permit2 pins, and the existing universal creation gateway/pot binding. It
contains no registry/allowlist mutation, private-key environment read, Safe call, timelock call, or
legacy creation-pot call. The dedicated pot means a v1.2 launch cannot reset, replace, or strand the
active legacy creation prize round.

A no-broadcast rehearsal against current chain-4663 state passed on 2026-07-29. It simulated two
top-level transactions (factory and gateway; implementation and pot are constructor-created), with
zero receipts and no onchain writes. Predicted addresses are nonce-dependent simulation output, not
deployments; regenerate them from the reviewed release commit after any nonce-consuming transaction.

```sh
cd contracts
forge script script/DeployV1_2Robinhood.s.sol:DeployV1_2Robinhood \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2
```

Release gates:

- [ ] Review the exact source commit and rerun the full Foundry suite, including
  `OpenZap.permit2.t.sol`, `OpenZap.recovery.t.sol`, `OpenZapV1_2CreationGateway.t.sol`, and
  `DeployV1_2Robinhood.t.sol`; opt into `DeployV1_2RobinhoodFork.t.sol` with
  `ROBINHOOD_FORK_BLOCK=<reviewed-block>` so the fork cannot silently move underneath the review.
- [ ] Rerun the command above without `--broadcast`, record its transaction count/gas estimate, and
  confirm the governance signer still owns both live governance contracts with no pending handoff.
- [ ] Broadcast only through a locally configured Forge account, hardware wallet, or external
  signer for `0x5a52…4aA2`; never add a private-key environment read to the script.
- [ ] From an independent RPC at one finalized block, verify both receipts, runtime code,
  `VERSION()`, factory/implementation/registry pins, `implCodeHash`, Permit2 pin, gateway exact fee,
  constructor-bound empty pot, and unchanged live registry/allowlist and legacy creation-path state.
- [ ] Verify all four new artifacts on Robinhood Blockscout and Sourcify from the exact release
  compiler settings before configuring any app creation path.
- [ ] Keep the app on live v1.1 until the source-ready v1.2 create, Permit2 signing, irreversible
  halt, recovery, public-status, and fail-closed provenance paths pass post-deployment canaries.
  Only then set `NEXT_PUBLIC_OPENZAP_V1_2_IMPLEMENTATION`, `NEXT_PUBLIC_OPENZAP_V1_2_FACTORY`,
  `NEXT_PUBLIC_OPENZAP_V1_2_CREATION_GATEWAY`, and `NEXT_PUBLIC_OPENZAP_V1_2_CREATION_FEE_POT`
  together from independently verified receipt addresses. Deployment alone does not activate or
  advertise v1.2, and predicted rehearsal addresses must never be copied into app configuration.

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

Addresses are wired into `src/lib/robinhood.ts` (`OPENZAP_V3_1_CONTRACTS`).

**The end-to-end path is no longer a follow-up.** Verified from live chain logs on 2026-07-28 via
`/explore` (head block 21,408,572): relative-floor recurring series are executing in production —
`run 19` and `run 20`, both rendered `recurring · spot floor`, which `describeAutomatedRun` emits only
for the `recurring-relative` kind. Aggregate at that block: 28 creations, 37 executions of which 25
are automated, 1 recovery, `319,932,354.4393` 0xZAPS of executed volume.

### The v3.2 stacking stack — deployed and active, pre-audit

**Activation verified 2026-08-02.** The production surfaces are open end to end:
`/api/health` reports `recurringStack: "open"` with the canonical seven-address set;
the relay admits the `recurring-stack` intent kind
(migration `20260726000000_allow_recurring_stack_kind.sql`); the reference executor
runs the `v3.2` capsule lineage with its dedicated conversion pot; and the deployed
implementation's runtime code hash re-read from chain matches the pinned release hash
below. Mainnet usage exists beyond the canaries' receipts: the factory has clone
creations at blocks 22,822,645
(`0xfe362f94c076401e3984808043ce404557646761d1e5483d72313c871162d314`) and 23,046,697
(`0xef38f71bb5f8121d429e4db2abf523dc5f2db1e74096ff736dec13ec80cd6a68`), with six
execution-pot events. The onchain version strings intentionally remain
`3.2.0-candidate`/`1.0.0-candidate` — they are immutable deployment identifiers, not
status claims. The contracts remain unaudited.

UNAUDITED CANDIDATE. Deployed on Robinhood Chain on 2026-07-29 from the contract tree at
`91b386ad4f31cdd00afd318f6a56b13bc3d06039`. Source is in
[`contracts/src/v3_2`](../contracts/src/v3_2), and the guarded Robinhood deployment script is
[`contracts/script/DeployV3_2Robinhood.s.sol`](../contracts/script/DeployV3_2Robinhood.s.sol).
The user-facing create/sign/manage path is implemented in Automate, backed by the stack-only
[`OpenZapStackCreationGateway`](../contracts/src/fee/OpenZapStackCreationGateway.sol). That gateway
can call only the v3.2 factory and creates/binds its own dedicated `ZapCreationFeePot` inside its
constructor transaction. The live v1 creation gateway and its active prize round are not mutated.

| Contract | Address | Source match |
|---|---|---|
| Price-source registry (AdapterRegistry) | [`0xe0b5240B079896111cB9c4a36CcAfAd85a444a12`](https://robinhoodchain.blockscout.com/address/0xe0b5240B079896111cB9c4a36CcAfAd85a444a12) | [Sourcify](https://repo.sourcify.dev/4663/0xe0b5240B079896111cB9c4a36CcAfAd85a444a12) |
| V4PoolPriceSourceOriented | [`0xc11D92bF92EeeE280a68eabe35E48c7a2e94e42e`](https://robinhoodchain.blockscout.com/address/0xc11D92bF92EeeE280a68eabe35E48c7a2e94e42e) | [Sourcify](https://repo.sourcify.dev/4663/0xc11D92bF92EeeE280a68eabe35E48c7a2e94e42e) |
| ZapLotteryPot (v3.2 execution) | [`0x7B8791e36f2e42FB80D209e340aE04aE94Fd411F`](https://robinhoodchain.blockscout.com/address/0x7B8791e36f2e42FB80D209e340aE04aE94Fd411F) | [Sourcify](https://repo.sourcify.dev/4663/0x7B8791e36f2e42FB80D209e340aE04aE94Fd411F) |
| OpenZapFactoryV3_2 (`3.2.0-candidate`) | [`0xd9134F778E523E9CF2fD75FFCb98499E9046457B`](https://robinhoodchain.blockscout.com/address/0xd9134F778E523E9CF2fD75FFCb98499E9046457B) | [Sourcify](https://repo.sourcify.dev/4663/0xd9134F778E523E9CF2fD75FFCb98499E9046457B) |
| OpenZapV3_2 implementation | [`0x5882e3dC1Ca0A7162d8F80ab59BC98E2fB8da987`](https://robinhoodchain.blockscout.com/address/0x5882e3dC1Ca0A7162d8F80ab59BC98E2fB8da987) | [Sourcify](https://repo.sourcify.dev/4663/0x5882e3dC1Ca0A7162d8F80ab59BC98E2fB8da987) |
| OpenZapStackCreationGateway (`1.0.0-candidate`) | [`0xa4D3bE6b97b320F1C81975038EcD5e1C5d7b3291`](https://robinhoodchain.blockscout.com/address/0xa4D3bE6b97b320F1C81975038EcD5e1C5d7b3291) | [Sourcify](https://repo.sourcify.dev/4663/0xa4D3bE6b97b320F1C81975038EcD5e1C5d7b3291) |
| ZapCreationFeePot (v3.2 creation) | [`0x6a1eb88408ce53C7C9e1eb460Cc68a8BD485dC12`](https://robinhoodchain.blockscout.com/address/0x6a1eb88408ce53C7C9e1eb460Cc68a8BD485dC12) | [Sourcify](https://repo.sourcify.dev/4663/0x6a1eb88408ce53C7C9e1eb460Cc68a8BD485dC12) |

The seven contiguous governance transactions (nonces 298–304) all succeeded:

| Step | Transaction |
|---|---|
| Deploy price-source registry | [`0xf009a233…b01e`](https://robinhoodchain.blockscout.com/tx/0xf009a2333785a098a3bf6d37a121c4dbb488c2d0dfa4daee5101a1c92c27b01e) |
| Deploy oriented source | [`0x1c30b0f3…96e0`](https://robinhoodchain.blockscout.com/tx/0x1c30b0f3cb328ab3018ccc1795d36bc24d1f90c1579e6960121a93789ac896e0) |
| Allowlist oriented source | [`0xe4aa0bcf…014d`](https://robinhoodchain.blockscout.com/tx/0xe4aa0bcf82753ebb7c9ab1c811d0ec9656f3ae4425994176fda51cde7c7d014d) |
| Deploy execution pot | [`0x3700caf1…dc41`](https://robinhoodchain.blockscout.com/tx/0x3700caf11e519a22fe4baae31d33a9d8e4b6dd72941f027ba4090e923f04dc41) |
| Deploy factory and implementation | [`0xb733dd28…b754`](https://robinhoodchain.blockscout.com/tx/0xb733dd281a5f0872345e989b970db45a003186e514d4993046a708475e4db754) |
| Bind execution pot to factory | [`0xb0b86c30…860d`](https://robinhoodchain.blockscout.com/tx/0xb0b86c3057e5388b7aff29ede9413df0a1324d91f3344ea798fae5f49f1f860d) |
| Deploy stack gateway and creation pot | [`0x61a12053…25b4`](https://robinhoodchain.blockscout.com/tx/0x61a120530e9271c8eec62b9eb6928136e4e53099197b89820c1404c465d125b4) |

The pinned release/readback block is `22,633,091`
(`0x19cbcee76d7cee977d052c2c45f4a458149a534807010f5d8662c3ca9c66d439`). The implementation
runtime code hash is
`0xe271b762131d9e198769ed44124fa52eef4051e00da517716136dae5bfcef321`.

v3.2 adds `executeRecurringStack`: everything `executeRecurringRelative` does, plus an
owner-signed `stackBps` slice of every run's **post-fee** output converted into 0xZAPS and staked to
the lottery pot as the **owner's** tickets. Every run acquires and stakes 0xZAPS as the user's own
authorized policy action rather than as the protocol's fee slice. When the primary output is another
asset, the stack slice is a real market buy; when the primary output is already 0xZAPS, it skips the
conversion leg and stakes directly. Superset of v3.1; domain version `"3.2"`.

Verified strict-superset property: `diff` of the v3.1 and v3.2 implementations removes **no logic**
from v3.1 — only two import paths, the `DOMAIN_VERSION` literal, and the widened constructor.

What it adds over v3.1, all enforced on-chain:

- **Owner-scoped containment.** `haltPolicy()` permanently stops every execution type on one clone
  before nonce or series state changes, while leaving `invalidateNonce` and `emergencyExit`
  available. It cannot pause other users or be reversed to reactivate held signatures.
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
- **Adapter de-allowlisting remains the kill switch.** Every stacking run rechecks the pot-pinned
  `ZAPS_ADAPTER`, including runs whose output is already 0xZAPS, so retiring that adapter halts the
  entire stack leg rather than leaving a partial route live.
- **No pot changes required.** `ZapLotteryPot.notifyContribution` already credits both tickets and
  `roundPrize` when the contributed asset is 0xZAPS, which is exactly what a stack contribution is.

Deployment prerequisites, in order:

1. A **new execution** `ZapLotteryPot` — `setFactory` is one-shot, so v3.2 cannot share the v3 or
   v3.1 execution pot.
2. `OpenZapFactoryV3_2(adapters, tokens, priceSources, executionPot)`, then
   `executionPot.setFactory(factory)`.
3. A stack-only `OpenZapStackCreationGateway` pinned to that factory. Its separate no-drain
   **creation-fee** pot is deployed and bound inside the gateway constructor transaction. It does not
   replace the live v1/v3/v3.1 creation gateway or merge their prize rounds.
4. Allowlist an oriented price source for the main leg, and one pricing `outAsset → 0xZAPS` for the
   conversion leg (only needed for zaps whose output is not already 0xZAPS).
5. Broadcast only from the current owner of both reused live registries, with both `pendingOwner`
   values zero. The deployment script enforces this before and after its seven top-level transactions.
6. Pin the independently read-back addresses as the verified `OPENZAP_V3_2_CONTRACTS` defaults in
   `src/lib/robinhood.ts`. If a deployment supplies any of the seven `NEXT_PUBLIC_OPENZAP_V3_2_*`
   overrides, it must supply the complete verified set; an explicit zero, malformed, or partial
   override keeps `openZapV3_2Configured()` false.
7. Apply `supabase/migrations/20260726000000_allow_recurring_stack_kind.sql` before activation, or
   every publish of a stacking intent returns an opaque `Relay storage failed (400)` from the `kind`
   CHECK constraint. Production records this migration as applied.

#### Independent post-broadcast acceptance checklist

Do **not** change this section to “live” from Forge console output or `run-latest.json` alone. The
deployment script checks its own work, but release acceptance must independently reproduce those
claims from canonical chain state. Record the finalized block number/hash, all seven top-level transaction
hashes, and every deployed address in this file as the checklist is completed.

**Readback from a second RPC**

- [x] Confirm chain ID `4663`, wait for the release confirmation depth, and pin every read below to
  the same finalized block. Confirm all seven broadcast receipts succeeded and the block hashes still
  match canonical chain state.
- [x] Confirm non-empty runtime code for the price-source registry, oriented price source, execution
  lottery pot, factory, factory-reported implementation, stack creation gateway, and its
  constructor-created creation-fee pot. Compare `cast codehash <implementation>` with
  `factory.implCodeHash()`.
- [x] Re-read the price-source registry's `owner()`, zero `pendingOwner()`, and
  `isAllowed(orientedPriceSource) == true`.
- [x] Re-read the oriented source's `poolManager()`, `poolId()`, `currency0()`, `currency1()`, and a
  non-zero `priceX96()`. They must equal the pinned PoolManager, aeWETH/0xZAPS pool, aeWETH, and
  0xZAPS values in `DeployV3_2Robinhood.s.sol`.
- [x] Re-read the pot's `owner()`, zero `pendingOwner()`, `ZAPS()`, `BUY_ADAPTER()`, `factory()`, and
  `currentRound() == 1`. The factory must be the new v3.2 factory; token and adapter must be the
  existing pinned 0xZAPS and Robinhood swap adapter.
- [x] Re-read the factory's `VERSION() == "3.2.0-candidate"`, `adapters()`, `tokens()`,
  `priceSources()`, `lotteryPot()`, `implementation()`, and `implCodeHash()`. Re-read the
  implementation's `FACTORY()`, `ADAPTERS()`, `TOKENS()`, `PRICE_SOURCES()`, `LOTTERY_POT()`,
  `ZAPS()`, and `ZAPS_ADAPTER()` and require exact agreement.
- [x] Re-read the stack creation gateway's `VERSION() == "1.0.0-candidate"`, `STACK_FACTORY()`,
  `AEWETH()`, `ZAPS()`, `CREATION_ADAPTER()`, `CREATION_FEE()`, and `CREATION_POT()`. Re-read that
  creation pot's owner, zero pending owner, `ZAPS()`, gateway, zero gateway installer, round 1, and
  zero initial accounted balance/tickets/prize. Confirm the live legacy creation pot/gateway and its
  active round are unchanged.
- [x] Confirm the reused live AdapterRegistry and TokenAllowlist still have the expected owner, zero
  `pendingOwner()`, and unchanged allowlist state. A v3.2 deployment must not write either registry.

Official Robinhood, PublicNode, and Tenderly independently agreed on finalized head `22,635,680`
(`0x27e5175d34bfb2da9f8b54884dffc20a36954a042efbf718735e81da567d9415`), which covers the pinned
release block. The seven receipt identities were byte-identical across all three RPCs. Runtime sizes
for registry/source/execution pot/factory/implementation/gateway/creation pot were respectively
724/860/3,330/2,411/20,461/4,168/2,725 bytes. The pinned source returned non-zero
`priceX96 = 197999494098391985161062720735267947840`. Pre/post snapshots of both reused registries and
the legacy creation gateway/pot were byte-identical; the legacy creation pot remained on round 1 with
`accountedZaps = 76428190824996617078884`.

**Source verification**

- [x] Verify the registry, source, both pots, factory, implementation, and stack creation gateway on
  Sourcify from the exact contract tree. Use the pinned Foundry settings: Solidity `0.8.34`,
  optimizer enabled with 200 runs, `via_ir = true`, EVM `cancun`, and `bytecode_hash = "none"`.
- [ ] Import the same exact-source metadata into Robinhood Blockscout and require each address to
  publish its own verification rather than relying on a bytecode-twin label.
- [ ] Require creation and runtime matches, published ABI/compiler settings, and independently
  decoded constructor arguments for each deployment. Save direct explorer links beside the address
  table; an uploaded source bundle without a bytecode match is not verification.

**App configuration and release**

- [x] Confirm the seven v3.2 addresses are pinned as verified defaults in `src/lib/robinhood.ts` and
  that production supplies either no overrides or the complete matching set:
  `NEXT_PUBLIC_OPENZAP_V3_2_IMPLEMENTATION`, `NEXT_PUBLIC_OPENZAP_V3_2_FACTORY`,
  `NEXT_PUBLIC_OPENZAP_V3_2_LOTTERY_POT`, `NEXT_PUBLIC_OPENZAP_V3_2_PRICE_SOURCE_REGISTRY`,
  `NEXT_PUBLIC_OPENZAP_V3_2_ORIENTED_PRICE_SOURCE`, `NEXT_PUBLIC_OPENZAP_V3_2_CREATION_GATEWAY`, and
  `NEXT_PUBLIC_OPENZAP_V3_2_CREATION_FEE_POT`. Predicted dry-run addresses were not used.
- [x] Confirm the recurring-stack Supabase migration is applied.
- [x] Build and test the app with the verified defaults, then deploy a fresh production build. The
  2026-08-01 production build at `dc0d2bfdc3ae8c673e4269fd3e83b3c2fc5d5a12` is deployment
  `dpl_9t7VnBaYx2rRnyWAGX1BBcXMDtk1`; aliasing an older build was not used for this acceptance step.
- [x] Read production back through `/api/health` and confirm `recurringStack` is open. Source tests
  separately prove that one valid override cannot be mixed with the verified defaults. This
  configuration check does not replace the browser or transaction canaries below.
- [ ] Verify in a production browser that Automate exposes stacking, and that a separately built,
  intentionally incomplete preview configuration hides it. Preserve both immutable deployment URLs
  and screenshots; a local build or `/api/health` response alone does not complete this UI gate.

**Mainnet smoke**

- [ ] Create one deliberately small v3.2 capsule from Automate and independently verify its
  factory-emitted creation log, policy hash, owner, runtime code hash, and v3.2 EIP-712 domain.
- [ ] Sign and execute one bounded `RecurringStackIntent`. Verify the `ExecutedRecurringStack` log,
  consumed run/series state, recipient output, executor and pot fee split, owner's ticket increase,
  and exact `stackIn`/`zapsOut` accounting from chain state rather than UI copy.
- [ ] On a separate disposable capsule, sign but do not submit an intent, call owner-only
  `haltPolicy()`, and verify every relevant execution surface reverts without consuming its nonce or
  advancing series state. Then verify `invalidateNonce` and `emergencyExit` still succeed.
- [ ] Confirm the capsule finishes with no stranded input and no transient adapter allowance. Confirm
  `/explore`, the durable execution receipt, Guardian, and executor scorecard all classify the run as
  `recurring-stack` before advertising the lineage.

The deployed-candidate application path implements fail-closed configuration, gateway provenance
readback, v3.2 creation, typed-data signing, exact persistence/export, and
relay/activity/status/cancellation plumbing. Its pure logic and contract surfaces are covered by
`contracts/test/OpenZapV3_2.stack.t.sol` (16 tests),
`contracts/test/OpenZapStackCreationGateway.t.sol` (7 tests), and the `executions`/`automate`/
`automation-records` vitest suites. The independent post-broadcast and production UI checks above
remain release gates.

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

### Staking campaign 2 — LIVE (window Aug 20 21:00 → Sep 3 21:00 UTC 2026)

UNAUDITED CANDIDATES. The second 0xZAPS fee campaign: the tokenized fee-share vault's 100 shares
split 50/50 between a rerun of the proven staking-campaign artifact (leg A) and
[`HookBlocks`](../contracts/src/campaign/HookBlocks.sol) buy-and-burn (leg B), which converts its
share of the fee stream into HOOKR through the native-ETH/HOOKR pool and burns every bought token
to `0x…dEaD` in the same transaction. Design and audit history: `docs/staking-campaign-2-hook-blocks.md`.
The production manifest (addresses + runtime hashes + blocks) is `FEE_REWARDS_2_MANIFEST` in
[`src/lib/rewards2.ts`](../src/lib/rewards2.ts), released via PR #159 after PRs #155–#157.

| Contract | Address |
|---|---|
| Staking campaign (leg A, campaign-1 artifact) | [`0x7F57F7B760614e67D3B3887433fA124B4c9A09F9`](https://robinhoodchain.blockscout.com/address/0x7F57F7B760614e67D3B3887433fA124B4c9A09F9) |
| HookBlocks buy-and-burn (leg B) | [`0xB5F7D9D4269c897Df70Df26F7bA48c0d933Be8Db`](https://robinhoodchain.blockscout.com/address/0xB5F7D9D4269c897Df70Df26F7bA48c0d933Be8Db) |

- Deployed 2026-08-20 (leg A block 41,581,207; leg B block 41,579,883) after a same-day mainnet
  canary proved the full pipeline. Runtime hashes
  `0xfa2c508f…9b76df` (leg A — byte-exact to the unchanged campaign-1 artifact) and
  `0x8b9fc3ae…6f3526` (leg B) re-verified against live code 2026-08-20 and pinned in the manifest.
- Schedule (immutable, identical across legs): start `1787259600`, end `1788469200`, claim/sweep
  tail `1791061200`. Both legs funded 50e18 vault shares — the sponsor holds zero for the window.
  Verified by direct reads: `HookBlocks.feeSharePrincipal() == 50e18`,
  `vault.balanceOf(legA) == 50e18`, `HookBlocks.POOL_ID == 0x590dcb6a…5fdf`.
- During the window `harvest()`/`syncRewards()` and `buyAndBurn(0)` are permissionless;
  `finalize()` BOTH legs after Sep 3 21:00 UTC. Verify burns by the contract's own events or the
  `balanceOf(0x…dEaD)` DELTA — never the raw DEAD balance (a shared sink). `HOOKR.totalSupply()`
  is unchanged by burns; never describe the campaign as deflationary or supply-reducing.

### The HOOKR expansion — built, NOT deployed

UNAUDITED CANDIDATE. Makes HOOKR (`Hookr.fun`,
[`0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c`](https://robinhoodchain.blockscout.com/address/0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c),
18 decimals) buy, DCA, and price-triggered zaps executable through the token's ONLY real market: the
hookless native-ETH/HOOKR v4 pool
`0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf` (fee 2500, tickSpacing 25) on
the canonical PoolManager. The pool's `currency0` is native ETH, which every existing swap adapter
refuses and the capsule cannot settle, so the expansion ships three contracts:

1. [`RobinhoodV4NativePoolAdapter`](../contracts/src/adapters/RobinhoodV4NativePoolAdapter.sol) —
   welds the wrap boundary into the step (aeWETH in → unwrap → direct PoolManager unlock swap →
   HOOKR out, and the reverse), refuses partial fills, hooked pools, and any calldata beyond a
   bounded minimum-out. One deployment serves both directions of exactly this pool; `poolId` is
   recomputed and proven at construction.
2. `V4PoolPriceSource(PoolManager, hookrPoolId)` — the v3 trigger oracle for the pool.
3. `V4PoolPriceSourceOriented(PoolManager, hookrPoolId, aeWETH, HOOKR)` — the v3.1 relative-floor
   source. `currency0` is DECLARED as aeWETH on purpose: `executeRecurringRelative` derives the
   run's input asset from the source's currencies and measures that ERC-20's balance, and aeWETH
   wraps native 1:1, so HOOKR-per-ETH is exactly HOOKR-per-aeWETH. A literal `address(0)` would
   brick every run on a `balanceOf` call against the zero address.

The guarded deployment path is
[`DeployRobinhoodHookr.s.sol`](../contracts/script/DeployRobinhoodHookr.s.sol): preflights chain,
factory→registry wiring for v1.1/v3/v3.1, the pinned pool id, and live pool liquidity; deploys the
three contracts; performs the four governance writes only when the broadcaster IS the live owner
(`AdapterRegistry.setAdapter(adapter)`, `TokenAllowlist.setToken(HOOKR)` — without which every HOOKR
policy is refused at `createZap` — and `setAdapter(source)` on the v3 and v3.1 price-source
registries), and prints exact calldata for whatever remains. The v3.2 stack lineage is deliberately
NOT wired: its stack leg converts output through the welded aeWETH→0xZAPS adapter, which cannot
take HOOKR, so HOOKR recurring signs the v3.1 relative-floor path.

Evidence so far (no broadcast of the EXPANSION's three contracts has happened — Campaign 2's
HookBlocks above trades the same pool but is a separate, already-live deployment):

- 31 unit/fuzz tests (`RobinhoodV4NativePoolAdapter.t.sol`) green.
- The fork dress rehearsal
  ([`RobinhoodV4NativePoolAdapter.fork.t.sol`](../contracts/test/RobinhoodV4NativePoolAdapter.fork.t.sol))
  passed against live 4663 state on 2026-08-20: adapter round trip byte-equal to the live quoter in
  both directions, and full end-to-end runs through the LIVE v1.1 (one-shot), v3 (trigger), and
  v3.1 (relative recurring) factories with the governance writes pranked exactly as the script
  broadcasts them. Rerun with `RUN_ROBINHOOD_FORK=true` before any broadcast after ANY change;
  optionally pin the state under review with `ROBINHOOD_FORK_BLOCK=<n>` (the same opt-in the v1.2
  gate uses) — worth doing while Campaign 2's cranks are actively trading this pool.
- A no-broadcast script simulation against live state passed the same day (preflight, deploys,
  post-assertions; ~0.000085 ETH estimated).

After a verified broadcast, in this order: record addresses + transactions here with independent
explorer/RPC readback; set `NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_HOOKR_ADAPTER`,
`NEXT_PUBLIC_OPENZAP_HOOKR_POOL_PRICE_SOURCE`, and
`NEXT_PUBLIC_OPENZAP_HOOKR_ORIENTED_PRICE_SOURCE` (all-or-nothing — the app fails closed on a
partial set); bake the addresses into `src/lib/robinhood.ts` / `src/lib/chains.ts` in a reviewed PR
that also moves the `hookr-buy` blueprint into the deployable prefix; and add the adapter's address
+ runtime hash to the executor operators' adapter manifest so standing HOOKR intents are
executable. Until then every HOOKR **zap** surface (the blueprints, routes, and Automate paths)
reports the honest not-deployed state; the `/rewards` Campaign 2 panel is a separate HOOKR
surface with its own live manifest.

### ZapDraw (`ZapOverdraw`) — **CONTRACT LIVE ON 4663; WEB SURFACE RETIRED**

| | |
|---|---|
| Contract | `contracts/src/game/ZapOverdraw.sol` |
| Deploy script | `contracts/script/DeployOverdraw.s.sol` |
| Tests | `contracts/test/ZapOverdraw.t.sol` (unit, fuzz, and invariant coverage) |
| Address on 4663 | [`0xb1C9e106a85Ad26603BA3AC89fFa4bE29E6C5336`](https://robinhoodchain.blockscout.com/address/0xb1C9e106a85Ad26603BA3AC89fFa4bE29E6C5336) |
| Deployer | `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` (governance) |
| Former app surface | Retired; all legacy URLs redirect to `/virtual-trading` |

> **The deployed contract is still `ZapOverdraw`; its former web product was ZapDraw.** The name was
> settled after the contract was already immutable onchain, so its Solidity source, scripts, and
> address retain `ZapOverdraw`. The former `NEXT_PUBLIC_OVERDRAW_ADDRESS` setting is historical
> configuration and must not be restored. The public game surface was retired on 2026-07-30.
> `/zapdraw`, `/zapdraw/how`, `/overdraw`, and `/overdraw/how` now
> 308-redirect directly to `/virtual-trading`. This web retirement does not pause or alter the
> immutable contract.

**Live state, read from chain 2026-07-27:**

| Immutable | Value |
|---|---|
| `stake` | `0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07` (0xZAPS, 18 dp) |
| `rakeRecipient` | `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` |
| `entryFee` | `1_000_000e18` — 1,000,000 0xZAPS (≈ 0.00073 aeWETH when quoted at deploy) |
| `commitWindow` / `revealWindow` | 21,600 s / 21,600 s (6 h each) |
| `rakeBps` / `keeperBps` | 200 / 50 |

`SmokeOverdraw.s.sol` passed against the deployed address: stake is the canonical 0xZAPS, fee bounds
hold, rake is non-zero so the carry pool can drain, windows are survivable, `BPS`/`MAX_SEATS`/
`MIN_REVEALS` are 10000/64/2, the carry pool is backed by the balance, and round 1 opened unsettled
with its commit window running.

A standalone sealed-bid game staked in 0xZAPS. Players pay a fixed entry, commit a hashed "draw"
(a bps claim on the round's capacity), reveal it, and settlement pays the ascending draws in order
until the capacity is exhausted — everyone after that is cut. Undelivered capacity returns to a
carry pool that later rounds draw on.

Two economic properties are load-bearing and are enforced by tests, not by comments:

* **A table sweep is never profitable.** An attacker holding every seat controls every draw, so
  they can always be served in full and take the whole capacity — and if they call `settle` the
  keeper reward returns to them too. Their profit is exactly `released − rake`. `releasableCarry()`
  caps `released` at the round's own rake, so the profit is never positive at any seat count.
  Without that cap, a carry above ~2% of two entries would have made a two-address sweep pay.
  Consequence, stated plainly: the pool drains no faster than the rake, so it is a slow rebate
  rather than a jackpot, and `rakeBps == 0` is refused because it would freeze the pool forever.
* **Ties are not a race.** Equal draws are separated by `keccak256(round, player)`, fixed before the
  round opens — not by reveal order. A reveal-order tiebreak would have made every tie a latency
  auction that a bot wins against a human, and on a single-sequencer chain would have let the
  block producer choose the winner by reordering reveals already in the mempool.

It is **not part of the protocol**. It is not an adapter, is not allowlisted in the
`AdapterRegistry`, holds no policy capsule, and no zap route can reach it. A bug in it cannot touch
capsule funds, and deploying it changes nothing about the live v1.1/v3 sets above.

### Retired operator status

There is no supported ZapDraw deployment or relaunch runbook. The former live-chain convenience
launcher has been removed. The Solidity deployment and smoke scripts remain solely as source and
historical verification evidence for the immutable contract already listed above; they explicitly
warn operators not to restore the web product.

Production release gates for the retirement are:

1. `NEXT_PUBLIC_OVERDRAW_ADDRESS` is absent from the Vercel Production environment.
2. `/zapdraw`, `/zapdraw/how`, `/overdraw`, and `/overdraw/how` each return one direct permanent
   redirect to `/virtual-trading`.
3. The active navigation, sitemap, metadata, and public LLM inventory contain no game surface.

The contract stays live onchain because it has no pause or admin withdrawal path. Site retirement
does not settle a round, open a round, move its balance, or otherwise mutate that contract.

Read-only retirement check at block `23,278,666` on 2026-07-30: `currentRound()` was `3`;
round 3 had `0` seats, `0` reveals, and `settled == false`, with its reveal window already closed.
The contract's 0xZAPS balance exactly matched `carryPool()` at `2,925,000 0xZAPS`. No settlement or
other contract write was sent.

Verified locally end to end on an anvil node at chain 4663 (2026-07-26): four seats at 1,000 stake,
draws 10/25/30/50%, revealed out of order. Capacity settled at 3,900 (4,000 fees − 80 rake − 20
keeper); paid 390 / 975 / 1,170; the 50% draw was cut; 1,365 returned to the pool; contract balance
matched credits + pool + open-round fees exactly. A second run grew the pool to 3,744 and confirmed
a following two-seat round could release only 40 — the rake it pays. **Pre-external-audit, like
everything else here.**

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
