# ZapPad reference provenance

ZapPad is a new OpenZaps feature and requires a brand-new Robinhood Chain
deployment. It does not import deployed addresses, privileged roles, API
credentials, mutable state, or user balances from UniClaw, CashClaw/LevyClaw,
PoolFans, or the former standalone ZapPad app.

## Reviewed source snapshots

The design references reviewed on 28 July 2026 were:

| Reference | Commit | Pattern examined |
| --- | --- | --- |
| `nodar/uniclaw` | `673201c2019fa8c52aeae4c09abcb028ece6f520` | Atomic deterministic launch, optional first buy, receipt construction, and Robinhood chain configuration. |
| `nodar/levyclaw` (active CashClaw implementation) | `68c3542f2f439b21e4020237c99ac4c42687e184` | Fixed 100-share fee rights and lazy cumulative reward-per-share settlement. |
| `pool-fans/clanker-revenue-shares-tokenizer` | `929838a4130023a93585346a82776d83125513a5` | Multi-asset balance-delta accounting, transfer checkpoints, and lifecycle testing. |
| Standalone ZapPad | `de269ef73c28aeb508b690e53535986802f29b16` | Hardened Robinhood v3 launch contracts, runtime identity, exact allowance flow, release evidence, fork tests, and browser lifecycle. |

The reference working trees were read-only design inputs, not deployment
evidence. UniClaw and LevyClaw had unrelated local changes at review time; the
commits above, not those mutable checkouts, identify the source snapshots.

## Adapted into OpenZaps

- One user transaction creates the token, initializes liquidity, locks the LP
  position, issues fee rights, and optionally performs a slippage-bounded first
  buy.
- Every vault issues one standard ERC-20 with 100 whole fee shares and a fixed initial split:
  80 creator and 20 reviewed protocol Safe.
- Two-asset checkpoint accounting covers the launch token and WETH or USDG at
  `1e36` precision, with permissionless canonical-position harvesting and
  conservation checks.
- Predicted-address prefunding is assigned to the initial shareholders rather
  than stranded below an accounting baseline.
- Versioned, chain-bound launch provenance stores a configuration hash,
  inclusion timestamp, and exact first-buy input/output.
- The app reconstructs a receipt from decoded events plus exact-block
  readbacks, not from an optimistic predicted address.
- The standalone feature shell was removed. ZapPad now uses the OpenZaps app
  shell, navigation, themes, legal surface, deployment ledger, and `/launch`
  route family.

## Deliberately excluded

- No existing address or privileged role is reused.
- UniClaw's permanent bonding curve is not used; ZapPad targets the canonical
  Robinhood Chain Uniswap v3 deployment.
- V4 hooks, dynamic fees, arbitrary reward recipients, multiple LP positions,
  collaboration registries, vesting, and time-wrapped fee rights are excluded
  from V1.
- Fee-share transfers never call the external Uniswap collection path or pay
  rewards inside the ERC-20 transfer hook.
- Base-specific contracts and addresses are not portable to chain `4663`.
- RPC endpoints and provider credentials remain environment-only.
- ZapPad fee shares are not merged with 0xZAPS and do not represent OpenZaps
  equity, protocol-wide revenue, governance, or a promise of returns.

Future collaborator splits, vesting, or markets over fee shares should consume
the existing fee-share token as a separate protocol. They should not expand
the launchpad's immutable authority.

## Third-party library provenance

The isolated contract root uses:

- OpenZeppelin Contracts `5.4.0` pinned as the direct submodule commit
  `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0`;
- `forge-std` `v1.11.0` pinned as the direct submodule commit
  `8e40513d678f392f398620b3ef2b418648b33e89`;
- MIT TickMath, BitMath, and CustomRevert from Uniswap v4-core commit
  `d153b048868a60c2403a3ef5b2301bb247884d46`.

The direct submodule gitlinks are part of the reviewed OpenZaps commit, so a
release build cannot substitute mutable or ignored `node_modules` content.
The local Uniswap library files carry their upstream commit comments.
