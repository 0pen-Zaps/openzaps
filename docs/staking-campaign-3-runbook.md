# Staking Campaign 3 — October 2026 deployment preparation

**Status: frontend release authorized; onchain deployment remains blocked.** The Campaign 3 page may be published only as a read-only “prepared — not live” announcement. No contract deployment, funding transaction, signer signature, or broadcast has occurred. Do not enable stake, withdraw, claim, or operator controls until both contract legs are deployed, funded, read back, and the schedule is valid.

## Schedule interpretation and release hold

Dates are UTC. The requested October 1–31 schedule is encoded as a 31-day window:

| Boundary | UTC | Unix seconds |
|---|---|---:|
| Start | 2026-10-01 00:00:00 | `1790812800` |
| End (exclusive; includes all of Oct 31) | 2026-11-01 00:00:00 | `1793491200` |
| Staker claim deadline | 2026-12-01 00:00:00 | `1796083200` |
| HookBlocks permissionless sweep opens | 2026-12-01 00:00:00 | `1796083200` |

Campaign 2's window was **14 days**. This draft interprets “same terms” as the same per-leg economics and operating controls, while the explicit Oct 1–31 dates set Campaign 3's window to 31 days. If the 14-day duration itself was intended to carry over, the schedule must be changed before deployment; neither the script nor this runbook silently shortens October.

The existing Campaign 2 procedure requires at least 24 hours between preflight/deployment and funding/start. At workstation time `2026-09-30 21:57:25Z`, the requested start was `2h 02m 35s` away. The latest no-broadcast Forge rehearsal read Robinhood chain time `2026-09-30 21:56:46Z`; start was then `2h 03m 14s` away, a `21h 56m 46s` shortfall against the 24-hour lead. **The 24-hour runway is not met.** The Campaign 3 HookBlocks script enforces that lead time and fails closed. The deployment request is acknowledged, but no broadcast may proceed on this schedule; revise the start/window and confirm the changed terms before deployment.

## Fixed identities and terms

| Item | Address / value |
|---|---|
| Chain | Robinhood Chain, `4663` |
| 0xZAPS | `0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07` |
| Fee-share vault | `0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338` |
| Vault reward asset (aeWETH) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Sponsor | `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` |
| HOOKR | `0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c` |
| v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| ETH/HOOKR poolId | `0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf` |
| Fee-share allocation | `50e18` to staker campaign + `50e18` to HookBlocks |
| HookBlocks floor and bounds | 97% of same-block spot; `0.0005–0.05 ETH` per buy; one buy per block |
| Recovery tail | 30 days after `endAt` |

No additional vault, adapter, slot handoff, activation, or changes to Campaigns 1/2 are part of this plan. The staker leg is a new `OXZAPSFeeCampaignV1`; the buy-and-burn leg is a new `HookBlocks` instance. Both contracts are immutable and must receive separate reviewed deployment records.

## Read-only preflight recorded 2026-09-30

Queried Robinhood RPC `https://rpc.mainnet.chain.robinhood.com`; all calls below were read-only:

- `eth_chainId`: `4663`.
- Campaign 2 `finalized()`: `true`.
- Campaign 2 HookBlocks `finalized()`: `true`.
- Sponsor fee-share `balanceOf`: `100000000000000000000` (`100e18`).
- Vault `activated()`: `true`.
- Vault `rewardAssetCount()`: `1`.
- Vault `rewardAssets(0)`: aeWETH address above.
- Pinned PoolManager pool slot 0: nonzero.

These reads establish current prerequisites only; repeat them immediately before any future deployment/funding. Do not rely on this snapshot if the chain state has changed.

## Leg A — staker campaign config

Prepared config (phase is deliberately read-only):

`/Users/nodes/repos/.worktrees/openzaps-fee-tokenizer-robinhood/deployments/openzaps-robinhood-fee-tokenizer.campaign3-oct-2026.json`

It reuses the already-activated fee adapter/vault identities, sets `phase` to `preflight`, and pins `startAt`, `endAt`, `claimDeadline`, and a `50e18` staker allocation. Keep the existing untracked Campaign 2 and Campaign 3 configs in that worktree unchanged; the October config uses a new filename.

Read-only preflight, from `/Users/nodes/repos/.worktrees/openzaps-fee-tokenizer-robinhood`:

```bash
OPENZAPS_FEE_CONFIG=deployments/openzaps-robinhood-fee-tokenizer.campaign3-oct-2026.json \
  yarn hardhat run scripts/deploy-openzaps-fee-tokenizer-robinhood.ts --network robinhood
```

The October config was run once with `phase: "preflight"`; it passed and printed **“Preflight passed. No transaction was sent.”** It also printed the environment's default signer address. That address was not signed with or verified as safe for Robinhood Chain, and must not be reused as a deployer without an independent chain-4663 wallet/code-safety check.

Only after the schedule has the required runway and a chain-4663-qualified deployer is selected should an operator make a separately reviewed deployment config with `phase: "deploy-campaign"`, deploy the campaign, and record its address, runtime code hash, and deployment block. Funding requires the sponsor signer and is a separate step. The user has explicitly requested deployment, but these live prerequisites are not met; do not bypass them.

## Leg B — HookBlocks deployment artifact

Artifacts in this repository:

- `contracts/script/Campaign3Terms.sol` — exact UTC schedule and shared campaign economics.
- `contracts/script/DeployHookBlocksRobinhoodCampaign3.s.sol` — 4663 guard, 24-hour runway guard, activated-vault/aeWETH/sponsor-share checks, pool-id derivation, initialized-pool check, constructor deployment, and immutable read-back.
- `contracts/test/Campaign3Terms.t.sol` — schedule, 30-day tails, allocation, buy bounds, and runway assertions.

The intended safe simulation command uses the live RPC but omits `--broadcast`:

```bash
cd /Users/nodes/repos/.worktrees/openzaps-staking-campaign-3-oct-2026/contracts
forge script script/DeployHookBlocksRobinhoodCampaign3.s.sol:DeployHookBlocksRobinhoodCampaign3 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --sender <deployer-address>
```

This command was rehearsed without `--broadcast` at Robinhood head timestamp `1790805406` (`2026-09-30 21:56:46Z`). It reverted as designed with `StartTooSoon(1790812800, 1790805406)`; no live transaction was sent. Do not bypass or weaken this guard to force the schedule. No `--broadcast` invocation is included or performed.

## Funding and live release boundary

After both deployment records are verified and the schedule is authorized, the sponsor would allocate exactly `50e18` vault shares to each new contract, then verify both funding read-backs before `startAt`. Never treat `msg.value`, a transaction hash, or a deploy log alone as proof of deployment/funding; verify receipt, runtime code hash, immutable getters, funded state, and exact vault balances.

The application manifest in `src/lib/rewards3.ts` deliberately has `deployment: null`. Campaign 3 therefore renders a read-only announcement: no chain reads, wallet connection, stake, withdraw, claim, or operator controls. Fill the manifest only in a reviewed release after both addresses, runtime hashes, blocks, and immutable schedule getters are verified; live Campaign 3 API/operator/staker wiring remains a separate release requirement. Campaigns 1 and 2 keep their existing verified transaction flows unchanged.

**Current release boundary:** the frontend release is authorized only with Campaign 3 clearly read-only and marked prepared/not live. Onchain deployment and funding remain blocked by the 24-hour schedule guard and unqualified signer. No contract transaction, funding, production environment update, or onchain broadcast has occurred.
