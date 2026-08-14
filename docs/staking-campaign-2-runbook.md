# Staking Campaign 2 — deployment and operations runbook

Companion to `docs/staking-campaign-2-hook-blocks.md`. Every step is
read-verify-act; nothing here mutates a live contract except the explicitly
marked broadcast steps, and no broadcast happens without the operator's
explicit go. All commands assume `RPC=https://rpc.mainnet.chain.robinhood.com`.

Fixed identities (verify, never assume):

| Thing | Address |
|---|---|
| Fee-share vault (100 shares) | `0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338` |
| aeWETH (vault reward asset) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| 0xZAPS (staking token) | `0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07` |
| $HOOKR | `0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c` |
| v4 PoolManager (canonical) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| ETH/HOOKR poolId | `0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf` |
| Sponsor / governance EOA | `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` |
| Campaign 1 (finalized) | `0x57d7A79185B64EBA1345D880f97d85A46d4e582F` |

## 0. Preconditions (read-only)

```bash
# Campaign 1 must be finalized and the sponsor must hold all 100 shares.
cast call 0x57d7A79185B64EBA1345D880f97d85A46d4e582F 'finalized()(bool)' --rpc-url $RPC
cast call 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338 'balanceOf(address)(uint256)' \
  0x5a52D4B820Ae7F02880d270562950918ACb14aA2 --rpc-url $RPC   # expect 100e18

# Vault still activated and paying aeWETH only.
cast call 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338 'activated()(bool)' --rpc-url $RPC
cast call 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338 'rewardAssets(uint256)(address)' 0 --rpc-url $RPC

# HOOKR pool alive (slot0 nonzero).
cast call 0x8366a39CC670B4001A1121B8F6A443A643e40951 'extsload(bytes32)(bytes32)' \
  $(cast keccak $(cast abi-encode 'f(bytes32,uint256)' \
  0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf 6)) --rpc-url $RPC
```

Verified 2026-08-14: finalized=true, sponsor=100e18, activated=true,
rewardAssets(0)=aeWETH, slot0 nonzero (~3.58M HOOKR/ETH). Do not proceed if
any of these drift.

## 1. Choose the shared schedule

One `CAMPAIGN2_START_AT` anchors both legs (pick ≥24h out so funding and
verification never race the window):

- `startAt`  = `CAMPAIGN2_START_AT`
- `endAt`    = `startAt + 14 days` (1,209,600s)
- leg A `claimDeadline` = `endAt + 30 days` (2,592,000s)
- leg B `sweepAfter`    = `endAt + 30 days`

## 2. Leg A — redeploy the proven campaign artifact (14-day term)

Run from the campaign-1 build tree
(`/Users/nodes/repos/.worktrees/openzaps-fee-tokenizer-robinhood`, Hardhat,
solc 0.8.28 — the exact tree that produced the live campaign bytecode). Its
`scripts/deploy-openzaps-fee-tokenizer-robinhood.ts` already supports
reusing the activated vault:

1. Copy `deployments/openzaps-robinhood-fee-tokenizer.production.json` to a
   new `…-campaign2.json`; keep `source`, `deployed.feeSourceAdapter*` and
   `deployed.feeShareVault*` exactly as they are; replace the `campaign`
   block with the new `sponsor` (unchanged), `startAt`, `endAt`,
   `claimDeadline`, `feeShareAllocation: "50000000000000000000"`; delete
   `deployed.feeCampaign*` (a new campaign gets a new record).
2. `PHASE=preflight` run — must pass with zero drift.
3. `PHASE=deploy-campaign` run with the deployer signer. Record the printed
   address and runtime code hash into the config's `deployed.feeCampaign` /
   `feeCampaignRuntimeCodeHash`.
4. Default (fund) phase with the **sponsor** signer: performs the exact
   50e18 approval, `fundFeeShares(50e18)`, and read-backs. Must complete
   before `startAt`.

The constructor itself re-verifies: 0xZAPS is the only accepted staking
token on 4663, timestamps are ordered, and the vault's reward assets are
introspected. Pre-staking opens the moment funding lands; reward accrual
starts at `startAt` (onchain time, no ops switch — campaign-1 semantics).

## 3. Leg B — deploy and fund HookBlocks

From this repo's `contracts/`:

```bash
# Rehearse (no broadcast; validates preflight + constructor on a fork of live state)
CAMPAIGN2_START_AT=<unix> \
forge script script/DeployHookBlocksRobinhood.s.sol:DeployHookBlocksRobinhood \
  --rpc-url $RPC --sender <deployer-address>
```

Rehearsed clean 2026-08-14 (simulation: preflight pass, ~0.0002 ETH gas).
Broadcast only on explicit authorization, with a Forge signer:

```bash
CAMPAIGN2_START_AT=<unix> \
forge script script/DeployHookBlocksRobinhood.s.sol:DeployHookBlocksRobinhood \
  --rpc-url $RPC --account <keystore-name> --sender <deployer-address> --broadcast --slow
```

Record the printed address and runtime code hash. Then fund from the
**sponsor** (before `startAt`):

```bash
cast send 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338 \
  'approve(address,uint256)' <hookBlocks> 50000000000000000000 \
  --rpc-url $RPC --account <sponsor-keystore>
cast send <hookBlocks> 'fundFeeShares(uint256)' 50000000000000000000 \
  --rpc-url $RPC --account <sponsor-keystore>

# Read-backs: both must hold before startAt.
cast call <hookBlocks> 'feeSharesFunded()(bool)' --rpc-url $RPC
cast call 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338 'balanceOf(address)(uint256)' <hookBlocks> --rpc-url $RPC
```

After both fundings the sponsor's vault balance is 0: all 100 shares are
working — 50 in the campaign, 50 in HookBlocks.

## 4. Release the app surface

Fill `src/lib/rewards2.ts`'s `FEE_REWARDS_2_MANIFEST` deployment block
(campaign + hookBlocks addresses, runtime code hashes, deployment blocks,
term timestamps) in a reviewed PR. The page stays fail-closed ("not live
yet") until the manifest carries verified addresses — a different address
or term is a different reviewed release, exactly as with campaign 1.

## 5. Operations during and after the window

Everything below is permissionless; anyone may pay gas, destinations are
fixed by the contracts:

- **During (both legs):** `campaign.harvest()` / `campaign.syncRewards()`
  stream fees to stakers; `hookBlocks.bond(0)` converts the other half into
  bonded HOOKR (≤0.05 ETH per crank, one crank per block, spot×0.97 floor).
  A sensible cadence is one crank of each per day or two; there is no
  penalty for missing days beyond reward smoothing.
- **After `endAt`:** call `finalize()` on BOTH contracts. Each returns its
  50 shares to the sponsor. Then keep calling `hookBlocks.bond(0)` until
  residual WETH is below `MIN_BOND_WEI`.
- **After `claimDeadline` (leg A):** `sweepExpiredRewards()` returns
  unclaimed staker WETH to the sponsor.
- **After `sweepAfter` (leg B):** `sweepUnbonded()` recovers any residual
  WETH/ETH to the sponsor. Bonded HOOKR has no exit path — nothing to
  operate, ever.

## 6. Hard rails

- Never touch the Clanker locker wiring: the vault must remain the sole
  recipient and reward admin of the pinned slot. Campaign 2 needs zero
  locker transactions.
- Campaign 1 stays in claim-only until 2026-09-09; its `sweepExpiredRewards`
  is a separate, later step and is not part of this release.
- Do not fund either leg past its `startAt` (the contracts refuse; do not
  attempt to work around it with a new term without a new review).
- No public copy may claim yield, APY, price support, or "deflationary"
  effects. The claims register in the design doc is binding.
