# OpenZaps Zap Executor

The off-chain half of the v3 execution types. A zap executor is a **courier with a clock and a
price feed**: it watches time (recurring series) and chain state (price triggers), and submits an
execution the moment the contract will accept one. It holds **no user funds and no user keys** —
only its own gas wallet — because every run it submits is re-verified on-chain against the owner's
EIP-712 signature, the frozen policy, the cadence, and the price condition.

## Economics

Each recurring/triggered run pays a protocol fee of **1% of the run's measured output**, carved at
settlement inside `OpenZapV3`:

| Share | Recipient | Why |
| --- | --- | --- |
| **80% of the fee** | the executor (`msg.sender`) | pays for gas + liveness; permissionless competition keeps runs timely |
| **20% of the fee** | `ZapLotteryPot` | converted to 0xZAPS (`pot.buyZaps`, permissionless) and accrued as the current lottery round's prize |

Every fee contribution also credits lottery **tickets** to the zap's owner — using a zap enters you
in the round. Winner selection is a deferred product decision (see `contracts/src/v3/README.md`);
payout bounds are not: the pot can only pay 0xZAPS, only to a ticket holder.

`minOutPerRun` / `minOut` are enforced **net of the fee**, so the floor the owner signs is what the
recipient actually receives.

## Running

```bash
node executor/index.mjs status   # connectivity + intent store summary
node executor/index.mjs once     # one evaluation pass
node executor/index.mjs start    # the loop (what launchd runs)
```

Host it on this machine (macOS LaunchAgent, restarts on crash and on boot):

```bash
./executor/install-launchd.sh          # install + start
./executor/install-launchd.sh remove   # stop + uninstall
tail -f ~/Library/Logs/openzaps-executor.log
```

## Modes

- **Watch-only (default).** No key configured ⇒ the daemon reads chain state, evaluates every
  stored intent, simulates due runs, and logs what it *would* submit. It cannot broadcast.
- **Executing.** Set `OPENZAPS_EXECUTOR_KEYFILE` to a `chmod 600` file holding a 0x-prefixed
  private key (or `OPENZAPS_EXECUTOR_PRIVATE_KEY` in the environment). This wallet only pays gas
  and receives fees. Never reuse a wallet that holds anything you care about.

## Intent store

Owners export signed standing intents from the app and drop them into
`~/.openzaps/executor/intents/` (one JSON file each — see [`intents.sample/`](./intents.sample)).
Files are treated as untrusted input: schema-checked on load, and every submission is re-verified
by the zap contract, so a malformed or hostile file can only waste a simulation. Consumed,
cancelled, or expired intents are archived to `~/.openzaps/executor/done/`, never deleted.

Configuration (all optional) lives in `~/.openzaps/executor/config.json` or env:
`OPENZAPS_RPC_URL`, `OPENZAPS_CHAIN_ID`, `OPENZAPS_POLL_MS`, `OPENZAPS_INTENTS_DIR`,
`OPENZAPS_LOTTERY_POT`, `OPENZAPS_MAX_FEE_PER_GAS`. Defaults target Robinhood Chain (4663) via
`https://rpc.mainnet.chain.robinhood.com`.

## Pot-conversion keeper

The 20% of each fee that funds the lottery pot arrives as 0xZAPS on buy runs, but as **aeWETH** on
sell runs — and aeWETH just sits in the pot until someone calls the permissionless `buyZaps` to
convert it. The daemon does this on a cadence (`OPENZAPS_CONVERT_EVERY_MS`, default 5 min): it reads
the pot's fee-asset balance and the live pool price, floors the conversion output by
`OPENZAPS_CONVERT_SLIPPAGE_BPS` (default 3%), and — with a signer — submits `buyZaps`, turning the
fee into the round's 0xZAPS prize. Below `OPENZAPS_CONVERT_MIN_WEI` (default 0.001 aeWETH) it idles
rather than pay gas to convert dust. Watch-only mode simulates and logs what it would convert.

Relevant config: `OPENZAPS_POOL_PRICE_SOURCE`, `OPENZAPS_FEE_ASSET`, `OPENZAPS_CONVERT_MIN_WEI`,
`OPENZAPS_CONVERT_SLIPPAGE_BPS`, `OPENZAPS_CONVERT_EVERY_MS` (all default to the live deployment).

## Gas self-monitoring

An executing daemon watches its own gas wallet each pass and logs a **LOW** warning when it can
afford fewer than `OPENZAPS_GAS_WARN_RUNS` (default 10) more runs, or an **EMPTY** error when it
cannot fund one — so it never silently stops broadcasting. `node executor/index.mjs status` prints
lifetime runs executed and pot conversions alongside the current gas health.

## What an executor can and cannot do

Can: submit a run the schedule already owes; submit a trigger the market already arms; earn the
fee; convert pot fee assets to 0xZAPS via the pinned bounded adapter (permissionless `buyZaps`).

Cannot: change route, amounts, recipient, or out-asset (frozen policy + signature); run early
(`IntervalNotElapsed`), re-run (`NonceReplay`), fire an unarmed trigger (`TriggerNotMet`), pass
itself a bigger fee (constants in the contract), or bypass the owner's net-of-fee floor
(`MinOutNotMet`). Losing the executor key loses gas money and fee income, nothing else.
