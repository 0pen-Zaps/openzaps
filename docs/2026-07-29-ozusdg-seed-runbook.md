# ozUSDG atomic one-time seed — 29 July 2026 operator runbook

> **STATUS: LIVE PREFLIGHT BLOCKED, NOT BROADCAST.** The guarded source still fails closed, but the
> reviewed `65,000` 0xZAPS input no longer covers the fixed USDG shortfall at the current pool price.
> At Robinhood block `23,530,970`
> (`0x35262e2b94adede272347b6da626f4381a84618d0db08c11a31f0f91739b2bd3`) the final quote was
> `43,313` USDG base units and its one-percent floor was `42,879`, below the required `53,540`.
> A later no-broadcast run at block `23,535,848` independently failed with a `43,312` quote and
> `42,878` floor. Do not sign, broadcast, reuse the July 29 nonce packet, or increase the token input
> as an operational retry. Any new fixed amount is a new reviewed design decision.

## Scope and fixed amounts

`contracts/script/SeedOzUSDGRobinhood.s.sol:SeedOzUSDGRobinhood` records a one-time seed for the
already-deployed, empty ozUSDG vault on Robinhood Chain mainnet (`4663`). The source reads no private
key, mnemonic, provider credential, or signer secret.

The reviewed plan is fixed:

- pull exactly `946,460` USDG base units (`0.946460` USDG) from the pinned owner;
- swap exactly `65,000e18` 0xZAPS through the pinned `0xZAPS -> aeWETH -> USDG` route;
- require a fresh one-percent-below-quote floor of at least the fixed `53,540`-unit USDG shortfall;
- deposit exactly `1,000,000` USDG base units (`1.000000` USDG); and
- mint exactly `1,000,000,000` ozUSDG base units (`1.000000000` ozUSDG) to `0x...dEaD`.

The owner USDG input is a compiled constant, not the owner's arbitrary current balance. The owner
must hold at least `946,460` units. Any additional owner USDG remains untouched.

## Four-transaction shape

The script records exactly four owner transactions:

1. deploy the no-admin, one-use `OzUSDGAtomicSeeder`;
2. approve exactly `65,000e18` 0xZAPS to that helper;
3. approve exactly `946,460` USDG units to that helper; and
4. call `helper.seed(946_460, freshMinimumUsdG)`.

Transaction four is the atomic acceptance point. It rechecks the chain, caller, external runtime
hashes and behavior, registries, route, empty vault, owner balances of at least the fixed inputs,
exact owner allowances, and zero downstream allowances before pulling either token. It then
performs the pulls, swap, second empty-vault check, exact deposit, share assertion, refunds, and
cleanup in one transaction. Any failure unwinds all transaction-four state, including the pulls and
swap.

There is no live partial state in which the swap succeeded but the deposit failed. Transactions two
and three are separate approvals, however, so an absent or reverted transaction four leaves those
allowances in place.

## Public-vault grief risk

ozUSDG is public and adminless. Anyone can call its public deposit path or transfer USDG directly to
the vault. Any direct deposit or USDG donation before transaction four makes the exact empty-vault
seed revert. A route-side-effect donation during transaction four is caught by the second
empty-vault check and unwinds the whole transaction.

This fail-closed grief risk is unavoidable now that the vault exists. A donation may permanently
invalidate this exact seed plan. Do not blindly retry. Stop, preserve the observed state, revoke any
helper allowances after independently checking receipts, and reassess a newly reviewed deployment
or recovery plan.

Donations to the owner do not expand the pull: only `946,460` USDG units can be approved and pulled.
Pre-funding the helper or its predicted CREATE address with a pinned token also does not expand any
measured input: the helper snapshots preexisting balances, excludes them from swap/deposit deltas,
refunds them to the owner after a successful transaction four, and requires zero residual helper
balances.

That refund path is success-only. The helper has no admin and no recovery function. If a vault
donation permanently blocks transaction four, tokens manually transferred to the helper may remain
stranded. The operator must only grant the two exact ERC-20 approvals; never transfer tokens to the
helper or its predicted address.

## Mandatory preflight

### Checks enforced by the script or helper

The script or helper stops unless each code-enforceable check passes:

- chain ID is exactly `4663`, and the script caller/sender is exactly
  `0x5a52D4B820Ae7F02880d270562950918ACb14aA2`;
- every pinned registry, route component, token, hook, and vault has code;
- V4 quoter runtime code hash is exactly
  `0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6`;
- route-adapter runtime code hash is exactly
  `0xa072ee627b548f6da96b55e2d3730273fe040cf7fa136019223b21a8c87faff4`;
- ozUSDG runtime code hash is exactly
  `0x2b0866418c3563cffc10778552b98eef1d4eb3c3a9a654c32949fb4ce7b13618`;
- adapter and token registries are owned by the pinned owner, with no pending ownership transfer;
- the route adapter and all route/vault tokens remain allowlisted;
- router, Permit2, token path, both pool IDs, fees, tick spacings, directions, and hook pins match;
- ozUSDG has zero total assets, zero total supply, and zero dead-address shares;
- legacy owner-to-adapter, owner-to-vault, adapter-to-Permit2, and Permit2-to-router allowances are
  zero;
- the owner holds at least `65,000e18` 0xZAPS and `946,460` USDG units; and
- transactions two and three create exact, not larger, owner-to-helper allowances.

The script checks the quoter runtime before recording transaction one. The helper constructor checks
the registry, route, token, hook, adapter, and vault behavior and the route-adapter and vault runtime
hashes before transaction one can succeed. Transaction four repeats those helper-enforceable checks
before either pull, closing the interval between helper deployment and use.

### Offchain operator-only hard gate

USDG and aeWETH are upgradeable proxies. A proxy runtime hash does not reveal an implementation
upgrade, and an onchain helper cannot read another contract's EIP-1967 storage. The two
implementation checks are therefore not enforced by the script or helper. Immediately before an
authorized broadcast, the operator must use two independently operated RPCs at one pinned block and
require both to return the same EIP-1967 implementation slot and implementation runtime hash:

- USDG implementation `0x68184C449E1a8f34fA18d289737129FD27B66f8F`, runtime hash
  `0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf`; and
- aeWETH implementation `0xC6B81b429797E0f555440b70cD99e032D7AE947e`, runtime hash
  `0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650`.

Any disagreement, missing proof, or implementation/hash drift is an operator hard stop. Repeat the
same two-RPC read immediately after the four transactions settle; do not treat a successful script
exit as proof that this manual gate passed.

Immediately before recording the four transactions, the script obtains fresh quotes for both hops:

```text
minimum USDG = floor(fresh final USDG quote * 9,900 / 10,000)
fixed shortfall = 1,000,000 - 946,460 = 53,540
```

It stops unless the minimum covers `53,540`. Never copy a previous quote or minimum into a
transaction.

## Verification

From `contracts/`:

```sh
forge fmt --check \
  src/operations/OzUSDGAtomicSeeder.sol \
  script/SeedOzUSDGRobinhood.s.sol \
  test/SeedOzUSDGRobinhood.t.sol \
  test/SeedOzUSDGRobinhood.fork.t.sol

forge test --match-path test/SeedOzUSDGRobinhood.t.sol -vv
forge build
```

The opt-in fork test uses local owner impersonation only. Use an archive-capable Robinhood RPC; the
public RPC may reject historical account-proof requests:

```sh
RUN_ROBINHOOD_OZUSDG_SEED_FORK=true \
ROBINHOOD_OZUSDG_SEED_FORK_BLOCK=22303042 \
ROBINHOOD_RPC_URL="$ROBINHOOD_ARCHIVE_RPC_URL" \
forge test --match-path test/SeedOzUSDGRobinhood.fork.t.sol -vv
```

## Required no-broadcast rehearsal

Pass the owner as Forge's sender so `run()` cannot be simulated from a default development address:

```sh
forge script script/SeedOzUSDGRobinhood.s.sol:SeedOzUSDGRobinhood \
  --rpc-url "$ROBINHOOD_RPC_URL" \
  --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
  -vvvv
```

Confirm the generated sequence contains exactly:

1. helper CREATE;
2. 0xZAPS approval to that helper for `65,000e18`;
3. USDG approval to that helper for `946,460`; and
4. `helper.seed(946_460, freshMinimumUsdG)`.

Record the reviewed commit, RPC origin, latest block number/hash, rehearsal timestamp, exit code,
fresh two-hop quote, computed floor, fixed shortfall, predicted helper address and runtime hash,
transaction count, and gas estimate. A dry-run transaction hash is not live-chain evidence.

Stop on any revert or unexpected state. Do not weaken a guard, use a generic router call, change a
fixed amount, or reuse an earlier floor to make a rehearsal pass.

## Separately authorized broadcast

This runbook does not authorize a broadcast. If the owner separately authorizes execution after a
fresh successful rehearsal, use a named Forge keystore, hardware signer, or external signer. Never
put a private key in the command or environment transcript.

No other process, wallet session, automation, or operator may submit transactions from the owner
during the four-transaction sequence. Confirm the owner's latest and pending nonce immediately
before starting and keep that nonce lane exclusive until transaction four settles. Use `--slow` so
each transaction confirms before the next is submitted.

`--slow` deliberately trades a longer public vault-grief window for receipt-gated sequencing and
clear partial-state evidence. Same-sender nonces enforce order, but sending all four transactions at
once could still let later approvals land after an earlier transaction reverts. No private ordered
bundle is configured for Robinhood Chain, so the owner must explicitly accept this availability
tradeoff and stop on any vault-state change.

```sh
forge script script/SeedOzUSDGRobinhood.s.sol:SeedOzUSDGRobinhood \
  --rpc-url "$ROBINHOOD_RPC_URL" \
  --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
  --account "$ROBINHOOD_OWNER_FORGE_ACCOUNT" \
  --broadcast --slow -vvvv
```

Confirm that the named account resolves to the pinned owner before approving any prompt. Review the
fresh quote, floor, helper address, and exact four-transaction shape from that run.

## Required post-state evidence

Do not mark the seed complete from Forge output alone. Record all four confirmed transaction hashes,
receipts, block numbers/hashes, and finality evidence. Independently read both RPCs at one pinned
post-state block.

Required final state:

- the helper is marked seeded and its runtime hash matches the reviewed build;
- owner-to-helper 0xZAPS and USDG allowances are zero;
- helper balances of 0xZAPS, aeWETH, USDG, and ozUSDG are zero;
- helper-to-route, helper-to-vault, route-to-Permit2, and Permit2-to-router allowance amounts are
  zero;
- route-adapter balances of 0xZAPS, aeWETH, and USDG equal their pre-run balances;
- both RPCs still report the preflight USDG and aeWETH implementation addresses and runtime hashes;
- owner 0xZAPS equals its balance immediately before transaction four minus `65,000e18`, plus any
  preexisting helper 0xZAPS refunded by transaction four;
- owner USDG equals its balance immediately before transaction four minus `946,460`, plus all
  residual helper USDG refunded by transaction four; owner USDG received before transaction four
  does not expand the fixed pull;
- ozUSDG `totalAssets()` is exactly `1,000,000`;
- ozUSDG `totalSupply()` is exactly `1,000,000,000`; and
- dead-address ozUSDG shares are exactly `1,000,000,000`.

The script asserts these conditions in simulation. Confirmed receipts and independent readbacks are
the live authority.

## Interrupted or reverted sequence

If transaction one is absent or reverts, there is no helper to approve. Stop.

If transaction one succeeds but transaction four is absent or reverts, inspect every receipt and
read both exact owner-to-helper allowances from two RPCs. Because transaction four is atomic, a
revert leaves owner balances, swap state, deposit state, and the two approvals exactly as they were
before transaction four. There is never a persisted “swap succeeded, deposit failed” state.

Depending on where the sequence stopped:

- after transaction two, the helper may retain exactly `65,000e18` 0xZAPS allowance; or
- after transaction three, it may retain both that 0xZAPS allowance and exactly `946,460` USDG
  allowance.

Any other amount is unexpected and is a hard stop. Do not rerun the script or submit transaction
four blindly. After independently verifying receipts and live allowances, revoke only the exact
allowances that remain. Each revoke is a separate owner-authorized transaction requiring its own
receipt and two-RPC zero readback:

```sh
cast send 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07 \
  'approve(address,uint256)' \
  "$DEPLOYED_ATOMIC_SEEDER" 0 \
  --rpc-url "$ROBINHOOD_RPC_URL" \
  --from 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
  --account "$ROBINHOOD_OWNER_FORGE_ACCOUNT"

cast send 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
  'approve(address,uint256)' \
  "$DEPLOYED_ATOMIC_SEEDER" 0 \
  --rpc-url "$ROBINHOOD_RPC_URL" \
  --from 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
  --account "$ROBINHOOD_OWNER_FORGE_ACCOUNT"
```

Submit only a revoke that matches an independently observed residual allowance. A vault donation,
code/registry drift, quote failure, nonce conflict, dropped transaction, ambiguous receipt, or any
other interruption requires a fresh assessment before a newly reviewed plan is attempted.
