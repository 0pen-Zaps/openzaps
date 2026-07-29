# ZapPad architecture

ZapPad is an OpenZaps feature with its own immutable contract boundary. It does
not grant Zap executors, the OpenZaps app, a backend session, or an API
credential any authority over a launch.

## Repository boundary

The Solidity package is an isolated Foundry root at
[`contracts/zappad/`](../../contracts/zappad/):

| Component | Purpose |
| --- | --- |
| `ZapPadBootstrap` | Creates both factories and the launchpad, then completes their one-time binding. |
| `ZapPadLaunchpad` | Chain-bound, immutable launch coordinator for canonical Robinhood Chain WETH and USDG markets. |
| `ZapTokenFactory` / `ZapToken` | Deterministic fixed-supply ERC-20 creation with no privileged mint, pause, tax, or owner path. |
| `ZapFeeVaultFactory` / `ZapFeeVault` | Deterministic per-launch vault, permanent LP NFT custody, transferable fee shares, and two-asset accounting. |
| `script/` | Safe, stack, canary, observation, cleanup, and finalization ceremony logic. |
| `test/` | Unit, fuzz, invariant, release-validation, mock, and canonical Robinhood fork coverage. |

The root fixes Solidity `0.8.28`, one million optimizer runs, IR compilation,
Cancun EVM, `bytecode_hash = "none"`, and `cbor_metadata = false`. It reuses
OpenZaps' parent `forge-std` and OpenZeppelin Contracts `5.4.0`. TickMath and
its two required helpers are local MIT-licensed copies pinned to Uniswap
v4-core commit `d153b048868a60c2403a3ef5b2301bb247884d46`; the dependency is
math only, not a ZapPad v4 integration.

## Launch transaction

1. The client validates metadata, pair, fee tier, opening valuation, slippage,
   funding, and wallet chain.
2. It mines a user salt whose predicted token address sorts below the paired
   asset, which is required for the single-sided token0 position.
3. It checks that the predicted token and token/pair/tier pool are unused and
   simulates the exact call against Robinhood Chain.
4. `ZapPadLaunchpad.launch` creates a fixed-supply `ZapToken` through its
   irreversibly bound factory.
5. The fee-vault factory creates a `ZapFeeVault`; its constructor atomically
   mints 80 fee shares to the creator and 20 to the protocol Safe.
6. The launchpad creates or uses an uninitialized canonical Uniswap v3 pool at
   the committed floor tick and mints a one-sided position directly to the
   vault.
7. No more than one launch token of rounding dust may be burned. If selected,
   the creator's slippage-bounded first buy executes in the same transaction.
8. `TokenLaunched`, `PositionSeeded`, `CreatorFirstBuy`, and
   `LaunchProvenanceRecorded` bind the resulting token, creator, pool, vault,
   position, pair, tier, tick, signed configuration, and exact first-buy
   amounts.

The downloadable receipt is valid only after those events are decoded and
matched to exact-block contract readbacks. A predicted address is never launch
evidence.

## Authority model

The bootstrap has one setup duty: bind the token and fee-vault factories to the
new launchpad. Binding is irreversible and deletes each binder. The launchpad,
factories, launch tokens, and fee vaults have no upgrade proxy, owner,
launch-pause administrator, asset allowlist administrator, LP recovery role, or
post-deployment mint authority.

The reviewed protocol Safe initially owns 20% of each vault's fee-share supply.
It can hold or transfer those shares like any other holder. It cannot redirect
another holder's fees, move the LP NFT, change the market, or administer a
launch.

## Fee-share accounting

Each vault accounts for the launch token and its WETH or USDG pair.
Permissionless `harvest` collects the locked position's fees and checkpoints
the received balances. `sync` checkpoints supported tokens already present in
the vault. A high-precision cumulative revenue-per-share index settles each
holder before transfers and claims.

A checkpointed batch belongs to fee-share holders at that checkpoint, not
necessarily to the holders at the block of every underlying swap. Share
transfers never call Uniswap, so a temporary collection failure cannot freeze
the ERC-20 transfer hook. Claims are bounded by checkpointed entitlement and
the vault's actual balances.

Economically and legally, the shares encode rights to collected LP fees from
that vault's one locked position only. They do not encode rights to 0xZAPS,
OpenZaps equity, OpenZaps-wide revenue, governance, redemption, guaranteed
yield, or future returns.

## OpenZaps data plane

The [`/launch`](<../../src/app/(site)/launch>) feature reads launch state from
contract calls and `TokenLaunched` logs. Directory and portfolio scans pin one
block across each page. A failed token, launch, or vault detail read rejects
the page without advancing its cursor; incomplete data is never relabelled as
an empty result.

The server routes are deliberately narrower than a general RPC proxy:

- `/api/launch/config` returns public, verified runtime configuration without
  exposing the provider URL.
- `/api/launch/health` pins a recent block and proves the launcher and
  dependency identity.
- `/api/launch/rpc` allows bounded read and simulation methods only. It rejects
  transaction broadcast, batches, cross-origin requests, oversized bodies,
  oversized log ranges, and invalid parameters.

The browser refreshes runtime state while visible and on focus. It rechecks the
launcher identity before simulation, approvals, and submission. USDG launches
require an allowance equal to—not merely greater than—the signed first-buy
amount, with explicit reset and revoke paths.

No database, privileged backend session, API credential, agent key, or existing
OpenZap grants onchain launch authority.

## Deterministic-pool griefing

Uniswap pool creation is permissionless even before the predicted launch token
has code. A public-mempool observer can pre-initialize the predicted
token/pair/tier pool and force that salt's launch to revert. The observer
cannot receive the token, move supply, take fee shares, or move the LP NFT. The
client must discard the salt, remine, re-simulate, and re-present the exact
transaction. High-profile launches should use reputable private submission
when one is independently reviewed and available.
