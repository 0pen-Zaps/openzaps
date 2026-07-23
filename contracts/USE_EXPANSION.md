# The "Use" expansion — multi-swap stitching + liquidity provisioning

What was built to turn the console from one bounded swap into a set of real DeFi actions on
Robinhood Chain (4663), what is proven, what is NOT yet live, and the exact runbook. Everything here
is grounded in a fork test pinned at block 16,728,000, a no-broadcast simulation against live
mainnet state, or a raw RPC read.

> **UPDATE 2026-07-23: BROADCAST COMPLETE.** All six contracts are live at blocks
> 17,228,330–332, every governance call executed in the same run, and the vault is seeded with its
> shares burned. Live addresses and verification are recorded in `docs/deployments.md`; §5's
> runbook is now historical. The review gate in §6 still stands.

---

## 1. What became possible

| | Before | After this work |
| --- | --- | --- |
| Multi-swap | One pool per step; chaining steps strands funds (`Step.amountIn` frozen at signing) | **`RobinhoodV4RouteAdapter`**: a frozen 2–4 hop route executed as ONE step — hop k+1 spends the MEASURED output of hop k at runtime. USDG ↔ 0xZAPS now trade through aeWETH with nothing guessed and nothing stranded. Works with the LIVE v1.1 core; no core change. |
| Provide liquidity | Impossible — no ERC-20 LP token exists anywhere on 4663 | **`ZapRangeVault`**: a full-range v4 position on the deepest hookless aeWETH/USDG pool, wrapped as an ERC-20 share (ozRANGE). Fees compound to holders. **`ZapRangeDepositAdapter`**: one currency in, half swapped in-pool, both legs deposited, shares straight to the calling zap. |
| Withdraw liquidity | n/a | **`ZapRangeWithdrawAdapter`** ×2 (settles USDG or aeWETH): shares in, one currency out, via the same ERC-20-allowance coincidence that made `ZapVaultRedeemAdapter` expressible. |
| Builder / console | `/app`, single bounded route | `/use` (308 from `/app`), route-aware console with quote support for stitched routes and LP previews; builder blocks `add-liquidity` / `remove-liquidity` / `lp-position` wired to the adapter registry, env-gated fail-closed. |

Why an adapter and not the v2 balance-relative core: v2 remains an unaudited candidate that MUST NOT
ship without external review (`src/v2/README.md`). The route adapter delivers the headline capability
against the live, already-deployed v1.1 factory, preserving I-SURF-1 (allowlisting one address ==
allowlisting one frozen route). Each hop repeats the Universal Router single-pool encoding proven
live by the existing swap adapters; the unproven multi-hop `PathKey` encoding is deliberately not
used.

## 2. Test evidence

`forge test`: **279 passed, 0 failed** (3 pre-existing env-gated skips). New suites, both
unconditional forks against real chain state at block 16,728,000:

- `test/RobinhoodV4RouteAdapter.fork.t.sol` — 8 tests. Real stitched USDG → aeWETH → 0xZAPS and
  reverse swaps through the live hookless static-fee and hooked dynamic-fee pools; final min-out
  floor; donation immunity; constructor refusals; and an end-to-end run through a **real OpenZap
  clone** (factory → EIP-712 intent → execute → settlement, zero residual approvals).
- `test/ZapRangeVault.fork.t.sol` — 11 tests against the **real PoolManager**: pool liquidity grows
  by exactly the vault's position on deposit; principal round-trips on redeem; real swap volume
  produces a measured fee uplift for holders; donations are inert to pricing (reserves are
  storage-tracked, raw balances invisible); unlock-callback stranger refusal; and both LP directions
  end-to-end through real OpenZap clones (provide settling on shares, withdraw settling on USDG).

`npm test` (vitest): **239 passed**. `next build`: green, `/use` in the route table.

## 3. Live-chain facts measured during this work (2026-07-23)

- **Governance handoff is COMPLETE.** `AdapterRegistry.owner()` and `TokenAllowlist.owner()` are both
  `0x5a52D4B820Ae7F02880d270562950918ACb14aA2`; `pendingOwner()` is zero on both.
  `docs/deployments.md`'s "acceptance pending" note is stale. The owner is still an EOA — the
  Safe+timelock posture both contracts' NatSpec assumes remains open.
- **The ozUSDG share token (`0xeAD1…D325`) is NOT allowlisted** — the exact "entry people forget"
  from `ROBINHOOD_EXPANSION.md`. Until `setToken(0xeAD1…D325, true)` lands, both ZapVault adapters
  revert at execution/initialize despite being deployed and baked into the frontend.
- aeWETH, USDG and 0xZAPS are all allowlisted.
- The owner holds ~0.0407 ETH and ~0.0877 aeWETH but **0 USDG** — the default seeded run needs
  1 USDG in the deployer wallet or it aborts `UnfundedSeed` in preflight (by design).

## 4. Dry run — simulated, nothing broadcast

`script/DeployRobinhoodUse.s.sol` (keyless, `DeployRobinhoodExpansion` style) deploys six contracts,
seeds the vault, executes-or-prints governance calls. Both branches simulated against live state:

- **Owner branch** (`--sender 0x5a52…`, seed disabled): all deploys + all governance calls execute
  in-run; ~11.6M gas, **~0.0024 ETH** at 0.21 gwei.
- **Funded-sender branch** (seed path): 0.0005 aeWETH + 1 USDG seed mints 21,921,105,423,000 shares
  = exactly 1000× the position liquidity of 21,921,105,423 — the virtual-offset share math verified
  against the live pool. Governance calls printed as `[PENDING]` with raw calldata.

## 5. Runbook (deployer's own key; the script reads none)

```bash
cd contracts
# 1. Dry run — costs nothing, catches every preflight failure. Fund 1 USDG first (or set both
#    VAULT_SEED_AMOUNT vars to 0 and own the unseeded consequence).
forge script script/DeployRobinhoodUse.s.sol:DeployRobinhoodUse \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2

# 2. Broadcast, with your own wallet config (--ledger / --account <keystore> / --trezor).
forge script script/DeployRobinhoodUse.s.sol:DeployRobinhoodUse \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
  --broadcast --ledger
```

Since the sender IS the governance owner, every `setAdapter`/`setToken` executes in the same run.
Then, and only then, configure the frontend (Vercel env, set LAST):

```
NEXT_PUBLIC_OPENZAP_ROUTE_USDG_ZAPS_ADAPTER=<printed>
NEXT_PUBLIC_OPENZAP_ROUTE_ZAPS_USDG_ADAPTER=<printed>
NEXT_PUBLIC_OPENZAP_RANGE_VAULT=<printed>            # also makes ozRANGE exist for the app
NEXT_PUBLIC_OPENZAP_RANGE_DEPOSIT_ADAPTER=<printed>
NEXT_PUBLIC_OPENZAP_RANGE_WITHDRAW_USDG_ADAPTER=<printed>
NEXT_PUBLIC_OPENZAP_RANGE_WITHDRAW_WETH_ADAPTER=<printed>
```

Unset vars fail CLOSED: today the new registry entries exist, resolve to nothing, and the product
offers nothing new until the addresses land.

While at it, close the stale gap from the previous expansion:
`cast send 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B "setToken(address,bool)" 0xeAD10C998c59745a030FfAc9209b294C14C7D325 true …`

## 6. The honest limits

1. **`ZapRangeVault` is UNAUDITED and custodies real funds**, with strictly more moving parts than
   `ZapVault` (real v4 liquidity, unlock callbacks, fee compounding). The fork suite is thorough and
   one agent's tests are still not a review. Allowlisting `ZapRangeDepositAdapter` is the moment the
   custody risk becomes other people's problem. Seed it, exercise it with your own funds — do not
   advertise it for third-party deposits before an independent review.
2. **Full-range LP carries impermanent loss** versus holding. The vault does not warn, hedge or
   rebalance; the block copy says so and must keep saying so.
3. **The provide-liquidity step refunds the unabsorbed remainder to the capsule**, where it strands
   until `emergencyExit`. Small by construction, not zero.
4. **Provide-then-withdraw cannot share a capsule** (delta settlement nets to ~zero); withdraw
   belongs in a capsule funded with shares — which is what the `lp-position` builder source is for.
5. **One route per route-adapter deployment**, deliberately (I-SURF-1). A new route is a new
   deployment plus a governance call, not a parameter.
6. **Governance is still a single EOA.** Move it behind a Safe + timelock before treating any of
   this as production posture.
