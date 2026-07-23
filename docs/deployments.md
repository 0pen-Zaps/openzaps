# OpenZaps Deployments

## Robinhood Chain mainnet (chainId 4663) — live

The OpenZap v1.1 protocol and a bounded 0xZAPS/pool-WETH v4 adapter are live on Robinhood Chain.
The canonical record is this file plus `contracts/broadcast/DeployRobinhood.s.sol/4663/run-latest.json`.

| Contract | Address |
|---|---|
| OpenZapFactory v1.1.0 | [`0xFC775017b25d2458623E2f3E735A4B750dD8b4E4`](https://robinhoodchain.blockscout.com/address/0xFC775017b25d2458623E2f3E735A4B750dD8b4E4) |
| OpenZap implementation | [`0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A`](https://robinhoodchain.blockscout.com/address/0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A) |
| RobinhoodV4SwapAdapter | [`0x04f62dA4b51a010eFa32aa81569169C47AEd602C`](https://robinhoodchain.blockscout.com/address/0x04f62dA4b51a010eFa32aa81569169C47AEd602C) |
| AdapterRegistry | [`0x9E56e444f490C00A6277326A47Cb462E12dF1f17`](https://robinhoodchain.blockscout.com/address/0x9E56e444f490C00A6277326A47Cb462E12dF1f17) |
| TokenAllowlist | [`0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B`](https://robinhoodchain.blockscout.com/address/0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B) |

### Pinned production route

- Pool WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- 0xZAPS: `0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07`
- Pool ID: `0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573`
- Universal Router: `0x8876789976DeCBfcBbBE364623c63652db8c0904`
- Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- Hook: `0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc`
- Dynamic fee flag: `0x800000`; tick spacing: `200`

### Governance and activation

- Current Registry/Allowlist owner: `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` (verified 0xZAPS
  token admin). The two-step handoff from the deployment signer `0xe17f5150…` has been **accepted**
  on both contracts (`pendingOwner()` is zero on each, read live 2026-07-23).
- The owner is an EOA; the Safe + timelock posture both contracts' NatSpec assumes is still open.
- The production adapter is allowlisted.
- Pool WETH, 0xZAPS and USDG are allowlisted. The ozUSDG share token (`0xeAD10C99…D325`) is **not**
  yet allowlisted, so the deployed ZapVault adapters cannot execute until governance sends
  `setToken(ozUSDG, true)` — see `contracts/USE_EXPANSION.md` §3.

### Verification and live smoke

- Sourcify reports creation and runtime `match` for all five artifacts on chain `4663`.
- Robinhood Blockscout exposes the source, ABI, compiler settings, and constructor args.
- Foundry: 63 unit/fuzz/invariant tests pass.
- Robinhood fork: real adapter buy/sell and complete Factory→clone→EIP-712→execute tests pass.
- Slither: 95 detectors run; remaining reports are triaged guarded-event, clone-bytecode, naming, and complexity findings.
- Mainnet smoke zap: [`0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4`](https://robinhoodchain.blockscout.com/address/0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4).
- Mainnet execute: [`0x30637132e29de0a29181f1ae3392acf947351702966eb22a5ea03d6faa845aa6`](https://robinhoodchain.blockscout.com/tx/0x30637132e29de0a29181f1ae3392acf947351702966eb22a5ea03d6faa845aa6).
- Smoke result: `0.00005` pool WETH in; `170800.958093014101263641` 0xZAPS out; nonce consumed; zap balances and all transient allowances zero.

### Deployment transactions

| Action | Transaction |
|---|---|
| Deploy AdapterRegistry | [`0x85fdde2fc7bd667881948629801400762edca99e4a39ecf706f5ec32e057dcf0`](https://robinhoodchain.blockscout.com/tx/0x85fdde2fc7bd667881948629801400762edca99e4a39ecf706f5ec32e057dcf0) |
| Deploy TokenAllowlist | [`0x7b0343427d3787463234f3273c0126d033dd321d5b7a7eca46ffb2d766b5ae69`](https://robinhoodchain.blockscout.com/tx/0x7b0343427d3787463234f3273c0126d033dd321d5b7a7eca46ffb2d766b5ae69) |
| Deploy RobinhoodV4SwapAdapter | [`0x89b1d7d11c92330e32b5775060777a860ae96c2ef07967ab3fb4d9b9e94ac024`](https://robinhoodchain.blockscout.com/tx/0x89b1d7d11c92330e32b5775060777a860ae96c2ef07967ab3fb4d9b9e94ac024) |
| Deploy Factory + implementation | [`0x77bad62c3ee2b455a661ed4315291723044025f732033c0a2e1058f6753dc52a`](https://robinhoodchain.blockscout.com/tx/0x77bad62c3ee2b455a661ed4315291723044025f732033c0a2e1058f6753dc52a) |
| Allowlist adapter | [`0xc35feefc3f7bec356ba6fc4d96892e08c429622647dc807adfc67a8e2b31281b`](https://robinhoodchain.blockscout.com/tx/0xc35feefc3f7bec356ba6fc4d96892e08c429622647dc807adfc67a8e2b31281b) |
| Allowlist pool WETH | [`0x138c45bf853ef8eef7890ed7f2b2d4c9da81bd2412a9bd4f4f2f96b3863c0af9`](https://robinhoodchain.blockscout.com/tx/0x138c45bf853ef8eef7890ed7f2b2d4c9da81bd2412a9bd4f4f2f96b3863c0af9) |
| Allowlist 0xZAPS | [`0x5613f8bfbb151e844832668a6b54e6b438ed0e8f5a7190dbd51a1363b9abc2f4`](https://robinhoodchain.blockscout.com/tx/0x5613f8bfbb151e844832668a6b54e6b438ed0e8f5a7190dbd51a1363b9abc2f4) |
| Start Registry ownership transfer | [`0xff53db309df3881ae116d329040c7eaa96cc60dcd204fc4d5206cf334a6cdc07`](https://robinhoodchain.blockscout.com/tx/0xff53db309df3881ae116d329040c7eaa96cc60dcd204fc4d5206cf334a6cdc07) |
| Start Allowlist ownership transfer | [`0x5e1470eafe0799cc89292ada4f3fa23e3f5cac419c189104833813d497899525`](https://robinhoodchain.blockscout.com/tx/0x5e1470eafe0799cc89292ada4f3fa23e3f5cac419c189104833813d497899525) |

> **Pre-external-audit.** The suite is live and internally/fork/mainnet tested, but has not had a professional third-party audit. Keep user deposits scoped and recoverable with `emergencyExit` until that review is complete.

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

## Base mainnet (chainId 8453)

The OpenZap v1 protocol contracts are **live on Base mainnet**. Deployed from
[`contracts/script/Deploy.s.sol`](../contracts/script/Deploy.s.sol).

| Contract | Address |
|---|---|
| OpenZapFactory | [`0xc7C5897e4738a157731c2F93b1d73Db9926E926C`](https://basescan.org/address/0xc7C5897e4738a157731c2F93b1d73Db9926E926C) |
| OpenZap implementation | [`0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e`](https://basescan.org/address/0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e) |
| AdapterRegistry | [`0x8d62b619daD575704Ba2560CF828aCab7642347F`](https://basescan.org/address/0x8d62b619daD575704Ba2560CF828aCab7642347F) |
| TokenAllowlist | [`0x0E6608d6b9e485550289755176173c4B6008CF12`](https://basescan.org/address/0x0E6608d6b9e485550289755176173c4B6008CF12) |

- **Factory version:** `1.0.0`
- **Implementation codehash:** `0x41728a4acbe58200ef3ec1e046997b5aaa9f2351b066604d0c6aab2b6a03cc93`
- **Governance owner** (registry + allowlist): `0x5F7fE39a7C2a62397b8e9033D462B1973E41E3F4` (deployer EOA)
- **Allowlists:** empty at deploy — no adapters and no tokens are allowlisted, so no zaps can be
  created against the factory until governance adds them.

> ⚠️ **Pre-external-audit.** These contracts shipped from a complete internal v1 review (47 passing
> tests, 9 internal-audit findings fixed) but have **not** had a professional third-party audit or a
> formal-verification run. See [`invariant-spec.md`](invariant-spec.md).

### Historical Base activation checklist

1. **Allowlist adapters** — `AdapterRegistry.setAdapter(adapter, true)` for each vetted adapter.
2. **Allowlist tokens** — `TokenAllowlist.setToken(token, true)` for each curated ERC-20.
3. **Move governance to a Safe** (recommended) — two-step transfer on registry + allowlist.
4. **0xZAPS is live** through Clanker on Robinhood Chain at
   `0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07`; the canonical market and explorer links are
   centralized in `src/lib/config.ts`.
5. The live `/app` targets the Robinhood v1.1 deployment above; Base remains a historical deployment
   record and is not exposed as an active production route.
