# ZapPad in OpenZaps

ZapPad is the Robinhood Chain token-launch feature inside OpenZaps. It is not a
separate hosted product. The OpenZaps route is `/launch`; its supporting APIs
are `/api/launch/config`, `/api/launch/health`, and `/api/launch/rpc`.

## Current status

> **Source-ready; not deployed. Writes disabled.**

As of 29 July 2026, the OpenZaps repository contains the ZapPad interface,
fail-closed runtime gates, and an isolated Foundry project at
[`contracts/zappad/`](../../contracts/zappad/). There are no approved Robinhood
mainnet addresses for `ZapPadBootstrap`, `ZapPadLaunchpad`,
`ZapTokenFactory`, or `ZapFeeVaultFactory`. No address from the existing
OpenZaps deployment or the former standalone ZapPad repository may be
substituted.

`ZAPPAD_LAUNCH_WRITES_ENABLED` must remain absent or `false`. It may become
`true` only in a new deployment of the exact reviewed Git SHA after the fresh
Safe and ZapPad stack are deployed, all contracts are source-verified,
receipt-bound evidence is preserved, the low-value two-asset canary is final,
the production runtime and firewall gates pass, and specialist counsel has
approved activation. A simulation manifest, predicted address, preview, or
passing test is not a deployment.

Production reads are independently gated by
`ZAPPAD_RPC_RELAY_ENABLED=true` and
`ZAPPAD_RPC_DURABLE_QUOTA_ENABLED=true`. The latter records a separately
configured durable edge quota; it does not create one. Without both, the
runtime and bounded RPC API remain fail closed even if an RPC URL is present.

## What one launch creates

One bounded transaction creates a fixed-supply ERC-20, initializes a
single-sided canonical Uniswap v3 WETH or USDG market, permanently locks its LP
NFT in a per-launch vault, issues one transferable fee-share ERC-20 with 100
whole shares (80 to the creator and 20 to the reviewed protocol Safe), and optionally performs a
slippage-bounded creator first buy.

The fee-share ERC-20s encode rights to the collected LP fees of that one locked
position only. They are **not 0xZAPS**, **not equity or revenue rights in
OpenZaps**, **not a guaranteed yield product**, and **not a promise of returns**.
Holding 0xZAPS does not confer ZapPad fee shares, and holding ZapPad fee shares
does not confer any right in 0xZAPS or the wider OpenZaps protocol.

## Documentation map

- [Architecture](architecture.md) — launch transaction, authority, accounting,
  and data plane.
- [Runtime gates](runtime.md) — server configuration, health identity, bounded
  RPC, and fail-closed write posture.
- [Release ceremony](release.md) — exact-SHA deployment, verification, canary,
  hosting, and activation gates.
- [Verification matrix](testing.md) — contract, fork, API, browser, security,
  and release evidence.
- [Reference provenance](provenance.md) — patterns adapted from UniClaw,
  CashClaw/LevyClaw, and PoolFans, plus exclusions.
- [Security and legal](security-and-legal.md) — pre-audit risks, economic
  disclosures, and Robinhood non-affiliation.

The canonical list of live OpenZaps addresses remains
[`docs/deployments.md`](../deployments.md). ZapPad stays addressless there until
post-broadcast verification evidence proves otherwise.
