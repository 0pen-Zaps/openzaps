# OpenZaps Deployments

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

> ⚠️ **Pre-external-audit.** These contracts shipped from a complete internal review (47 passing
> tests, 9 internal-audit findings fixed) but have **not** had a professional third-party audit or a
> formal-verification run. See [`invariant-spec.md`](invariant-spec.md).

### Activation checklist (to make zaps creatable / the token live)

1. **Allowlist adapters** — `AdapterRegistry.setAdapter(adapter, true)` for each vetted adapter.
2. **Allowlist tokens** — `TokenAllowlist.setToken(token, true)` for each curated ERC-20.
3. **Move governance to a Safe** (recommended) — two-step transfer on registry + allowlist.
4. **Launch 0xZAPS** on `tokenizer.pool.fans`; set `NEXT_PUBLIC_POOLFANS_TOKEN_ID` +
   `NEXT_PUBLIC_TOKEN_ADDRESS` so the buy CTAs and token card go live.
5. **(Frontend)** real wallet-driven zap creation (wagmi/viem write path) — not yet wired; the `/app`
   builder currently previews the signed policy.
