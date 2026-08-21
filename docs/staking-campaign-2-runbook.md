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

The operator console on `/rewards` (Campaign 2 panel) is the working
surface for all of this: its preflight strip re-verifies the checks below
against one pinned block, and once the release manifest is filled its
buttons run each action as simulate → wallet review → receipt →
runtime-hash re-check. Everything except the marked sponsor levers is
permissionless; destinations are fixed by the contracts:

- **During (both legs):** `campaign.harvest()` / `campaign.syncRewards()`
  stream fees to stakers; `hookBlocks.buyAndBurn(0)` converts the other half into
  burned HOOKR (≤0.05 ETH per crank, one crank per block, spot×0.97 floor).
  A sensible cadence is one crank of each per day or two; there is no
  penalty for missing days beyond reward smoothing.
  `buyAndBurn(0)` is deliberately permissionless and relies only on the
  same-block spot floor, which can be manipulated. Do not use that zero-floor
  form for predictable public automation; pause or use manual/private ordering
  if the campaign funds themselves need global protection from third-party
  cranks. A keeper policy can constrain only the transactions it sends.
- **Safeguard (sponsor):** `hookBlocks.setBuybackPaused(true|false)` halts
  or restores FUTURE buy-and-burn calls only — use it if the pool breaks or every
  buy is getting ground against the floor. It cannot move assets and never
  gates funding, finalize, or the sweep.
- **After `endAt`:** call `finalize()` on BOTH contracts. Each returns its
  50 shares to the sponsor. Then keep calling `hookBlocks.buyAndBurn(0)` until
  residual WETH is below `MIN_BUY_WEI`.
- **Safeguard (sponsor):** from `endAt` the SPONSOR may call
  `hookBlocks.sweepUnspent()` at once if conversion is impossible — no need
  to wait out `sweepAfter`, which remains the permissionless backstop.
- **After `claimDeadline` (leg A):** `sweepExpiredRewards()` returns
  unclaimed staker WETH to the sponsor.
- **After `sweepAfter` (leg B):** `sweepUnspent()` opens to everyone.
  Burned HOOKR is already at the dead address — nothing to operate, ever.

## 5b. Pipeline verification record (2026-08-14)

The claim → convert → burn pipeline and every safeguard were dress-rehearsed
against LIVE chain state on a fork before any broadcast — real vault, real
Clanker fees, real HOOKR pool, real PoolManager bytecode:

```bash
RUN_ROBINHOOD_FORK=true forge test \
  --match-contract "HookBlocksRehearsalForkTest|HookBlocksRobinhoodForkTest" -vv
```

All three rehearsals pass:

- `test_liveBondLegEndToEnd` — fund 50 real shares → harvest real locker
  fees → market-buy real HOOKR → burn → rate-limit check → finalize returns
  the shares.
- `test_rehearsal_fullCampaignLifecycle` — 14 simulated days with ongoing
  fee flow (WETH into the real vault + permissionless `sync()`), multiple
  cranks all under the per-call cap, finalize, residual drain, and the
  closing invariant: the ledger sums exactly to the totals and the totals
  exactly to the contract's HOOKR balance.
- `test_rehearsal_failureModesAndSafeguards` — a failed floor retains WETH
  and burns nothing; pause halts the crank and unpause restores it
  unchanged; the sweep is closed to everyone mid-window, opens to the
  sponsor at `endAt` and to everyone at `sweepAfter`; no step can retrieve a
  burned token.

Re-run the block above after ANY contract change and before broadcast; a
fix is new code and re-verifies from zero.

**Round 2 (2026-08-14, after the bond→burn conversion).** A four-lens
adversarial audit of the new burn path found and fixed, before deploy:
the ledger crediting donated HOOKR as purchased (published rate was
griefable — now the ledger records `hookrBought` and the event publishes
bought and burned separately); `balanceOf(DEAD)` being documented as the
proof (it is a shared sink — now verified by event/delta, and the unit
suite pre-seeds DEAD so a wrong assertion fails); stranded HOOKR having no
recovery once conversion dies (`sweepUnspent` now burns it to DEAD); a
stale unlock sentinel (now asserted zero after `unlock` returns); and
three tests that asserted nothing. All three fork rehearsals re-passed
against live state afterward.

**Verifying the campaign's burn total, correctly:** sum the `hookrBurned`
field of this contract's `BoughtAndBurned` and `UnspentSwept` events, or
take the `balanceOf(0x…dEaD)` delta across the campaign's own transactions.
Do NOT read the dead address's absolute balance — anyone may send HOOKR
there, and other senders' burns are not this campaign's.

## 5c. Bounded keeper automation

`executor/campaign2-daemon.mjs` automates the permissionless upkeep without
giving the general OpenZaps executor a signer. Its release manifest hardcodes
chain 4663, both released addresses and runtime hashes, the shared schedule,
and both `MIN_BUY_WEI` / `MAX_BUY_WEI`; none can be replaced through config.

The live-window policy is:

1. Once per 24-hour window, simulate and submit `campaign.harvest()` so the
   staker leg pulls new vault rewards and updates the claimable WETH index.
   This accrues rewards for stakers; it does not push a transaction to every
   staker wallet.
2. On a later pass, submit `hookBlocks.buyAndBurn(minHookrOut)` only when the
   pinned `pendingWeth()` read contains a full immutable `MAX_BUY_WEI` batch
   (`0.05 ETH`). The caller floor covers that full cap and is 97% of a 30–60
   minute pool-price median. Seven unique five-minute samples spanning at
   least 30 minutes are required. Before signing, a separate owner-only
   archive RPC re-reads the exact PoolManager `slot0` at every canonical
   sample block and must reproduce the journal; header checks alone are not
   accepted. The contract independently takes the greater of the caller floor
   and same-block spot × 97%.
3. Allow only one unresolved transaction and no more than four broadcasts per
   UTC day. Every call carries zero value, a fixed gas limit, and a fee cap.
   Warn below `0.0003 ETH` of keeper gas, refuse any action whose full gas cap
   is not funded, and never automate a top-up.
4. Re-simulate against the latest mined state immediately before signing,
   then sign through the dedicated encrypted keystore with Cast `--password-file`,
   recover and decode the signed payload, and durably persist that exact raw
   transaction before broadcasting it.
5. After 12 confirmations, decode the target/selector/arguments, verify the
   canonical block and required event, then bind the receipt, transaction,
   block, and readback to the same block hash before advancing local state.

A signed burn may be published only for 10 minutes of canonical chain time
after its signing block. Both public and archive providers must report timely
heads, agree on their shared canonical block, and remain within two minutes of
the keeper's wall clock. Once that retry lifetime expires the daemon retains
the journal but refuses to republish the deadline-free raw transaction; the
operator must inspect the nonce and deliberately replace it. Bytes already
submitted to a public mempool remain independently mineable because the
deployed entry point has no deadline.

After `endAt`, the keeper calls each permissionless `finalize()` in order and
continues burning only full `MAX_BUY_WEI` batches. Smaller residual WETH is
left for manual/private handling or the documented sweep path.
It never calls `setBuybackPaused`, either sweep, or a staker claim.

Install read-only first:

```bash
npm run campaign2:status
export OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT=<reviewed-40-character-git-sha>
./executor/install-campaign2-launchd.sh watch-only
```

This uses the committed keeper-plus-dependencies ncc artifact, copies it into
an owner-only directory named by the exact Git commit, and pins
the bundle chunk and Node hashes. CI and the installer independently rebuild
the ncc artifact and require byte-for-byte equality with the committed bundle.
An owner-only pre-execution launcher verifies the copied Node, entry, chunk,
and license hashes before JavaScript evaluation. The running service no longer
follows a mutable checkout. Preserve the Node SHA printed by watch-only for
independent review before live activation.

Enabling broadcasts is a separate approval over the exact gas wallet and
policy: invoking `enable` is the broadcast authorization itself. The daemon
refuses raw or inline keys. It uses Claude's dedicated
encrypted Web3 keystore and adjacent password file, both owner-only, and pins
the recovered signer to `0xA2b7…9bEC`. The operator must approve the Cast
SHA-256 before the installer invokes Cast at all; the daemon hashes it again
immediately before each `mktx`:

```bash
export OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT=<reviewed-40-character-git-sha>
export OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256=<reviewed-lowercase-sha256>
export OPENZAPS_CAMPAIGN2_EXPECTED_CAST_SHA256=<reviewed-lowercase-sha256>
# Harvest + finalization only (the default):
export OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS=false
./executor/install-campaign2-launchd.sh enable
```

Burn signing is a second explicit policy switch and requires a credentialed
archive endpoint kept out of the plist and repository. Put exactly one HTTPS
URL in an owner-only regular file, then authorize the switch at enable time:

```bash
umask 077
${EDITOR:-vi} "$HOME/.openzaps/keeper/robinhood-archive-rpc.url"
chmod 600 "$HOME/.openzaps/keeper/robinhood-archive-rpc.url"
export OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT=<reviewed-40-character-git-sha>
export OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256=<reviewed-lowercase-sha256>
export OPENZAPS_CAMPAIGN2_EXPECTED_CAST_SHA256=<reviewed-lowercase-sha256>
export OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS=true
export OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE="$HOME/.openzaps/keeper/robinhood-archive-rpc.url"
./executor/install-campaign2-launchd.sh enable
```

The installer defaults to the handoff under `~/.openzaps/keeper`; alternate
absolute paths may be supplied with `OPENZAPS_CAMPAIGN2_KEYSTORE_FILE`,
`OPENZAPS_CAMPAIGN2_PASSWORD_FILE`, `OPENZAPS_CAMPAIGN2_CAST_BIN`, and
`OPENZAPS_CAMPAIGN2_NODE_BIN`. Approved Node and Cast bytes are copied into
owner-only hash-addressed runtime directories before launch or keystore access.

Do not configure that key in the general executor at the same time. Keeper
state and receipts live in `~/.openzaps/campaign2-keeper/state.json`; logs are
in `~/Library/Logs/openzaps-campaign2-keeper.log`. Disable the local policy by
reinstalling `watch-only`, or remove the service with
`./executor/install-campaign2-launchd.sh remove`. Watch-only/status never
rebroadcast retained bytes. If a signed burn is pending, pass its existing
owner-only `OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE` when reinstalling watch-only
so the receipt can still be authenticated; this does not enable burn signing
or rebroadcast. The burn-off switch also holds an unresolved signed burn.
Neither disabling nor removal revokes or deletes previously signed bytes;
preserve their state and archive-RPC file until canonical reconciliation. The sponsor's onchain
`setBuybackPaused(true)` remains the independent burn-side circuit breaker.

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
