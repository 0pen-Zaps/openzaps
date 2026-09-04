# Integrating OpenZaps Hookr zaps into a third-party UI

This is the one-click integration surface for HOOKR and Hookr-launched pools on Robinhood
Chain (4663). It requires no contract integration and no wallet action from the integrator:
a link opens the OpenZaps signer with a route and an amount, the signer resolves every address
from its own shipped manifest, and the user signs one policy in their wallet.

## What exists

| Action | Route id | Input | Output |
|---|---|---|---|
| Buy HOOKR (native pool) | `robinhood-v4-weth-hookr` | aeWETH | HOOKR |
| Buy a Hookr modular-market token (V2/V3) | `hookr-market-buy-<pool>` | quote (aeWETH or HOOKR) | subject |
| Sell it back | `hookr-market-sell-<pool>` | subject | quote |
| Zap in to any Hookr pool | `hookr-lp-deposit-<pool>` | the pool's quote (HOOKR, or aeWETH for ETH-quoted markets) | `ozHR-<SYMBOL>` LP shares |
| Zap out of any Hookr pool | `hookr-lp-withdraw-<pool>` | `ozHR-<SYMBOL>` shares | the pool's quote |
| Migrate pool A → pool B, same quote | withdraw A + deposit B, two steps | shares of A | shares of B |
| Migrate a V5 HOOKR pool → an ETH-quoted market | withdraw A + sell HOOKR + deposit B, three steps | shares of A | shares of B |

`<pool>` keys, each pool's generation and quote, and the live set come from the manifest endpoint,
never from a hardcoded list. Hookr Modular V3 markets each carry their own hook instance; OpenZaps
admits them from the coordinator's own market record, so a new V3 market needs no OpenZaps deploy.

## Manifest endpoint

```
GET https://www.0xzaps.com/api/hookr/routes
```

Returns, per pool: key, symbol, token address, v4 pool id and key, the vault (share token)
address, `live` (both routes resolvable right now), the route ids, and ready-made links for
zap in from HOOKR, zap in from aeWETH, and zap out to HOOKR. `migrations` lists every live
pair with its two-step link. `configured: false` means the contracts are not deployed or
baked yet; nothing should be rendered from a non-live pool.

## Link format

```
/zap?view=sign&src=build&route=<routeId>&amount=<decimal>&bps=<10..500>&maxGas=<n>&maxFeeGwei=<n>
```

- `amount` is a decimal in the input token's units (all Hookr tokens and shares are 18 dp).
- `bps` is the slippage cap the signer starts from; the user can still change it.
- Two-step policies add `&policy=<token>`, the ordered `routeId=amount|…` token the manifest
  already emits. Step 2's amount is frozen at signing and becomes step 1's minimum output, so
  set it a little below what step 1 is expected to produce.
- Links carry ids and amounts only. A link cannot name an adapter, a vault, or calldata.

## Behaviour to disclose in your UI

- Deposits swap exactly half of the input inside the pool (the hook's dynamic fee applies) and
  refund whatever the pool ratio cannot absorb to the user's capsule, where it stays until the
  owner recovers it with `emergencyExit`.
- A deposit reverts while a pool's anti-snipe guard is active; the guard is finite.
- Withdrawals can never be blocked by the hook: the vault refuses hooks with removal
  permissions at construction.
- The vault and adapters custody real funds and are unaudited. Full-range LP carries
  impermanent loss versus holding.

## Adding a new launch

1. Anyone calls `HookedRangeVaultFactory.createVault(currency0, currency1, 0x800000, 60, hooks)`
   (currencies sorted, `currency0 = 0x0` for an ETH-quoted market; `hooks` is the V5 hook, the
   V2 kernel, or the V3 market's own instance as recorded by the coordinator). Trading through
   `hookr-market-*` needs no vault at all: the coordinator record is enough.
2. OpenZaps governance allowlists the vault's share token (`TokenAllowlist.setToken`) and, for a
   new subject token, the token itself.
3. The pool is added to `src/lib/hookr-pools.ts` (or, faster, to
   `NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS` / `NEXT_PUBLIC_OPENZAP_HOOKR_MARKETS`), and the manifest
   starts listing it.
