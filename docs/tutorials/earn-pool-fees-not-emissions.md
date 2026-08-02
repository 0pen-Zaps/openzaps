# Earn the Pool's Fees, Not an Emission

**Publication:** DeFi Tutorials

**Status:** Prepared draft · owner review and approval required before editor handoff

**Suggested subtitle:** How a Clanker v4 fee position becomes 100 tokenized shares, why 50 of them fund a seven-day 0xZAPS staking campaign, and the exact reads to run before you stake

**Verified hero:** `docs/media/13-fee-rewards-campaign.jpg` · SHA-256 `4d0e4710ceec2acd26f1d52f12941fe0d125428f1156d592a86720916ff841b0` · MIME `image/jpeg` · dimensions `1128x440` · bytes `109242` · Alt: The OpenZaps fee rewards page reading "Stake 0xZAPS. Claim WETH from the pool's trading fees." beside a campaign terms panel showing the seven-day window and claim deadline.

**Canonical CTA:** https://www.0xzaps.com/rewards

<!-- OPENZAPS_SUBSTACK_BODY -->

> Disclosure: I work on OpenZaps. The contracts described here have not completed an external audit. Staking puts funds at risk, confirmed transactions are irreversible, and no rate of return is promised or implied. Nothing here is financial advice. Verify every address and read below against the chain yourself before you commit anything.

Most "staking rewards" in DeFi are an emission. A contract mints new units of its own token and hands them to whoever deposited. The number on the dashboard goes up, the supply goes up with it, and the reward is a claim on future dilution rather than on any cash flow that exists.

A much smaller set of designs pays out revenue that someone already generated. The distinction is simple to state and easy to verify: **ask what asset the reward is denominated in, and ask who paid it.** If the answer is "the same token you staked, minted for the occasion," it is an emission. If the answer is "a different asset, paid by a counterparty who received something in return," it is revenue.

The first 0xZAPS fee campaign is the second kind, and it is small and finite enough to trace end to end in one sitting. That is exactly why it is worth walking through: not because the numbers are large, but because the whole path from a swap to a claimable balance is short enough to verify by hand.

This walkthrough traces that path, then gives you the reads to confirm each hop.

## The cash flow, traced backwards

Start at the end and work back.

The reward asset is **WETH on Robinhood Chain (chain 4663)**, at `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. That contract's `l1Address()` points at `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` — canonical Ethereum-mainnet WETH9 — so it is a bridged representation of ether, not a token the campaign invented. It is not minted by the campaign, the vault, or OpenZaps, and none of them can print more of it.

Where does that WETH come from? From people trading.

0xZAPS trades in a single Uniswap **v4** pool on chain 4663, paired against aeWETH, with a Clanker hook attached at `0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc`. The pool is a **dynamic-fee** pool: its `PoolKey` carries the dynamic-fee sentinel rather than a fixed number, and the hook sets the fee at runtime. Reading the hook today returns `10000`, and because Uniswap v4 denominates fees in hundredths of a basis point (`1_000_000` = 100%), that is **1.00%**.

Every swap in that pool pays that fee. That is the entire source of this campaign's rewards. There is no treasury top-up, no emission schedule, and no yield generated somewhere else and routed in. **If nobody trades, nothing accrues** — a property worth internalising before you decide how much to stake.

## Tokenizing a claim on a fee position

A Clanker fee position accrues to a reward slot. OpenZaps' claim on that slot is held by a vault contract at `0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338`, which the block explorer labels "Tokenized 0xZAPS Clanker fees."

That vault minted a **fixed supply of 100 fee shares** and then stopped. `TOTAL_SHARES()` returns `100e18`, `totalSupply()` matches it, and the vault is `activated()`. A share is a `1/100` pro-rata claim on WETH that the vault has harvested and accounted.

Read that last sentence carefully, because it is the most misunderstood part of any design like this: **a share is a claim on a flow, not on a balance.** Fees sit in the Clanker position until something pulls them across. Until that happens, the vault's accounted WETH balance is zero — and a claim on zero is zero.

The pull is `harvest()`, and it is permissionless. So is `sync()`. Neither requires an operator, a multisig, or OpenZaps' cooperation; anyone willing to pay gas can move the fees into the accounting layer where shares can claim them.

## Why 50 shares, and what the campaign is

Of those 100 shares, **50 were transferred into a separate campaign contract** at `0x57d7A79185B64EBA1345D880f97d85A46d4e582F` before launch. The sponsor kept the other 50.

The campaign is a fixed-term staking contract with one job: hold those 50 fee shares for one window, harvest whatever WETH they entitle it to, and split that WETH among people who staked 0xZAPS — proportional to **how much they staked and how long they held it**.

Its terms are immutable and its window is fixed:

| Term | Value |
|---|---|
| Stake asset | 0xZAPS (`0xDd90…CB07`) |
| Reward asset | WETH only (`0x0Bd7…AD73`) |
| Campaign allocation | 50 of 100 fee shares |
| Window opens | 3 August 2026, 00:23 UTC |
| Window closes | 10 August 2026, 00:23 UTC |
| Claim deadline | 9 September 2026, 00:23 UTC |

One boundary matters more than any other, and the product states it on its own front page: **holding 0xZAPS grants no fee rights.** The token by itself entitles you to nothing from this position. A claim accrues only while tokens are staked inside that campaign contract. If you hold and never stake, your reward is exactly zero, by design.

## What "time-weighted" actually means for you

The campaign does not snapshot balances. It accrues.

Your reward tracks the integral of your stake over time within the window — stake multiplied by duration held, as a share of everyone else's stake multiplied by their duration. Two consequences follow, and neither is obvious from a dashboard:

1. **Staking early in the window is worth more than staking late**, for the same principal, because it accrues over more of the window.
2. **Withdrawing during the window stops that principal earning** from the moment it leaves.

There is a useful asymmetry after the window closes: once the campaign has ended, withdrawing your principal preserves the reward weight you already earned until settlement. During the window, it does not.

Pre-staking is open before the window begins. Depositing early does not start the clock — reward accounting begins at the fixed start timestamp, not when your tokens arrive — but it does mean you are already earning the moment the window opens, without needing to be awake for it.

## Staking, step by step

You will need 0xZAPS on chain 4663, a wallet on that chain, and a little gas. That is all — **the interface never asks you to supply WETH**. Stakers provide 0xZAPS principal and gas; the WETH flows the other way.

1. Open the campaign page and connect a wallet on chain 4663. Connecting is read-only: it grants no operator role and no withdrawal authority over anything.
2. Enter the amount of 0xZAPS you intend to stake. The page shows what that amount would represent as a share of staked principal at the current verified block. Treat that as an arithmetic fact about principal today, not a forecast — it moves as other people stake.
3. Choose **Sign permit, then stake**. This is two wallet prompts and one onchain transaction: an EIP-2612 permit signature scoped to an exact amount with a 20-minute deadline, then the stake itself. There is no standing unlimited approval, and the signature alone moves nothing. A conventional approve-then-stake path exists for wallets that do not implement permit.
4. Verify the receipt. A transaction hash is evidence that something was broadcast, not that it succeeded — check that the receipt confirmed and that your staked balance actually moved.

## Rewards do not appear on their own

This is the step most guides would skip, and it is the one that determines whether there is anything to claim.

WETH becomes claimable only after someone calls `harvest()` (pull fees through the vault into the campaign) or `syncRewards()` (account for WETH the campaign already holds). Both are permissionless and both are exposed on the campaign page's **Operate** tab.

That design has a real trade-off, and it is worth being plain about it. On the upside, no operator can withhold your rewards; if you can pay gas, you can force the accounting forward yourself. On the downside, **nobody is obligated to do it**. If no one harvests, the fees sit in the Clanker position and the campaign's accounted balance stays at zero. At the time of writing, the campaign has harvested exactly `0` WETH and has zero staked principal, because the window has not opened yet.

Claiming is separate again. `claimFor(account)` pays WETH to the account that earned it — anyone can pay the gas to trigger a claim, but the funds can only land with the earner. Unclaimed rewards do not roll over forever: after the claim deadline, the sponsor can sweep whatever is left.

## Verify all of it yourself

Every claim above is a chain read. Here is the whole set, using Foundry's `cast`:

```bash
# Any chain 4663 RPC endpoint; the public one is rpc.mainnet.chain.robinhood.com
export RPC=<your-chain-4663-rpc-endpoint>
export CAMPAIGN=0x57d7A79185B64EBA1345D880f97d85A46d4e582F
export VAULT=0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338
export WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73

# It stakes 0xZAPS and pays WETH — nothing else.
cast call $CAMPAIGN "STAKING_TOKEN()(address)"        --rpc-url $RPC
cast call $CAMPAIGN "rewardAssetCount()(uint256)"     --rpc-url $RPC
cast call $CAMPAIGN "rewardAssets(uint256)(address)" 0 --rpc-url $RPC

# It really holds 50 of a fixed 100 shares.
cast call $VAULT "TOTAL_SHARES()(uint256)"            --rpc-url $RPC
cast call $VAULT "balanceOf(address)(uint256)" $CAMPAIGN --rpc-url $RPC
cast call $CAMPAIGN "feeSharesFunded()(bool)"         --rpc-url $RPC

# The window is fixed and cannot be extended.
cast call $CAMPAIGN "startAt()(uint64)"               --rpc-url $RPC
cast call $CAMPAIGN "endAt()(uint64)"                 --rpc-url $RPC
cast call $CAMPAIGN "claimDeadline()(uint64)"         --rpc-url $RPC

# How much WETH has actually been accounted so far.
cast call $CAMPAIGN "rewardState(address)(uint256,uint256,uint256,uint256)" $WETH --rpc-url $RPC

# What a specific address has earned.
cast call $CAMPAIGN "earned(address,address)(uint256)" <YOUR_ADDRESS> $WETH --rpc-url $RPC
```

And the fee itself, which is the one number that can change under you:

```bash
export HOOK=0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc
export POOL=0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573

cast call $HOOK "clankerFee(bytes32)(uint24)" $POOL --rpc-url $RPC
# 10000 → 1.00%, because v4 fees are hundredths of a bip.
```

If a number in this article and a number from these commands ever disagree, **the chain is right and the article is stale.**

## What this campaign is not

I would rather you stake nothing than stake on a misreading, so here is the honest boundary in full.

- **It is not a yield product, and there is no APR.** Rewards are only whatever WETH the pool's traders generate and someone harvests. That figure could be small. It could be zero.
- **Trading volume is nobody's promise.** No participant controls it, including OpenZaps.
- **The fee rate is not fixed.** It is a dynamic-fee pool and the hook owner can change the fee. Re-read it rather than trusting `1%` indefinitely.
- **The contracts have not completed an external audit.** The campaign and vault are also not source-verified on the public explorer today — you can hash their deployed runtime bytecode and compare it against what the app pins, but you cannot read their Solidity there. Weigh that accordingly.
- **Staking is irreversible once confirmed**, and withdrawals are governed by contract state rather than by anyone's discretion.
- **Unclaimed rewards expire** at the claim deadline and can then be swept by the sponsor.
- **This is a seven-day experiment**, not a standing product. It settles and ends.

None of that is a reason to avoid the mechanism. It is the information you need to size a position honestly — which, for a first campaign on pre-audit contracts, should probably mean an amount you would shrug at losing entirely.

## The dates that matter

- **3 August 2026, 00:23 UTC** — the window opens and reward accounting begins. Pre-staking before this is allowed and earns nothing extra.
- **10 August 2026, 00:23 UTC** — the window closes. Principal stops earning; `finalize()` becomes callable by anyone and returns the 50 fee shares to the sponsor.
- **9 September 2026, 00:23 UTC** — the claim deadline. Claim before this or the WETH can be swept.

Set a reminder for the third date. It is the one that costs you money to forget.

## Try it

- [Inspect the campaign](https://www.0xzaps.com/rewards?utm_source=substack&utm_medium=email&utm_campaign=defitutorials-earn-pool-fees-not-emissions&utm_content=tutorial) — live contract state, the harvest and settlement controls, and the full release manifest with every address and runtime hash.
- Run the `cast` reads above before you stake anything. If the reads and the interface disagree, do not stake.

The reason to care about this design is not the size of the first campaign. It is that "where does the reward come from" has a checkable answer — a specific pool, a specific fee, a specific tokenized position, split a specific way. That question is worth asking of every staking page you visit, and most of them answer it much less precisely than a few `cast` calls can.
