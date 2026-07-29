# OpenZaps Zap Executor

The off-chain half of the v3 execution types. A zap executor is a **courier with a clock and a
price feed**: it watches time (recurring series) and chain state (price triggers), and submits an
execution the moment the contract will accept one. It holds **no user funds and no user keys** —
only its own gas wallet — because every run it submits is re-verified on-chain against the owner's
EIP-712 signature, the frozen policy, the cadence, and the price condition.

> **Connecting an AI agent?** The daemon is the half that *submits*. The half that *reads and
> reasons* is [`../mcp/`](../mcp/README.md) — an MCP server exposing this repo's capsule reads,
> simulations, and intent delivery to any MCP client, holding no key of its own. Pin this daemon's
> address as the `executor` in a signed intent and only it may submit that series; see
> [ADR-0006](../docs/adr/0006-agent-connection-and-mcp-surface.md).

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

Host it on this machine (macOS LaunchAgent, restarts on crash and at login):

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
by the zap contract. Before simulation or broadcast, the daemon also proves that the target is the
exact clone emitted by the configured canonical factory: factory/implementation pins, runtime
codehash, immutable `FACTORY`/policy reads, and the indexed `ZapCreated` log must all agree.
Unknown lineages or uncertain RPC reads fail closed. Consumed, cancelled, or expired intents are
archived to `~/.openzaps/executor/done/`, never deleted.

Configuration (all optional) lives in `~/.openzaps/executor/config.json` or env:
`OPENZAPS_RPC_URL`, `OPENZAPS_CHAIN_ID`, `OPENZAPS_POLL_MS`, `OPENZAPS_INTENTS_DIR`,
`OPENZAPS_LOTTERY_POT`, `OPENZAPS_MAX_FEE_PER_GAS`. Defaults target Robinhood Chain (4663) via
`https://rpc.mainnet.chain.robinhood.com`. Set `OPENZAPS_RPC_URLS` (comma-separated) to run on a
fallback transport — every request tries the endpoints in order, so one flaky RPC never idles the
bundler. `OPENZAPS_CONFIRMATIONS` (default 12) and `OPENZAPS_RECEIPT_TIMEOUT_MS` control the
finality wait. Canonical v3/v3.1 pins default to the documented Robinhood deployments and may be
overridden with `OPENZAPS_V3_FACTORY` / `OPENZAPS_V3_IMPLEMENTATION` and
`OPENZAPS_V3_1_FACTORY` / `OPENZAPS_V3_1_IMPLEMENTATION`. The undeployed v3.2 lineage stays disabled
until both `OPENZAPS_V3_2_FACTORY` and `OPENZAPS_V3_2_IMPLEMENTATION` are configured.

## The shared relay (how executors discover work)

The daemon polls a hosted **intent relay** (`OPENZAPS_RELAY_URL`, default `https://www.0xzaps.com`)
each pass and merges the open intents it finds with the local file store — so it executes
automations published by ANY owner from the Automate tab, not just files dropped on this machine.
That is the "connected" half: owners publish once (the app POSTs their signed intent to
`/api/intents`), and every executor sees the shared pool. The relay is untrusted — the capsule
re-verifies each intent on-chain — so the daemon re-validates every relayed intent through the same
`store.validateIntentObject` gate a file goes through and independently repeats the canonical
factory proof before execution. Each pass reads a bounded slice and saves the stable keyset cursor
in `state.json`; later passes resume the sweep, so a large pool rotates fairly without ever being
loaded into memory at once. `OPENZAPS_RELAY_PAGE_SIZE`,
`OPENZAPS_RELAY_MAX_PAGES_PER_PASS`, `OPENZAPS_RELAY_MAX_ROWS_PER_PASS`, and
`OPENZAPS_RELAY_MAX_BYTES_PER_PASS` tune those hard bounds. Chain evaluation uses a small worker pool
(`OPENZAPS_EVALUATION_CONCURRENCY`, default 4). When an intent's nonce is spent or its signed deadline
passes in chain time, the daemon marks it terminal on the relay. Set
`OPENZAPS_RELAY_URL=""` to disable relay polling and run purely off the local file store.

## Receipts and notifications

A transaction hash — execution or pot conversion — enters the receipt outbox immediately after
broadcast, before confirmation waiting. The immediate wait reports only that a receipt was
observed; it does not declare finality. Finalized and reverted transactions are promoted only by
the later canonical-settlement pass and written as versioned JSON to
`~/.openzaps/executor/receipts/` (override with `OPENZAPS_RECEIPTS_DIR`). Relayed executions are also
sent to `/api/executions/receipts`, which independently decodes the signed calldata, transaction
sender, receipt, confirmations, and execution event before an idempotent database upsert. Receipt
and scorecard data are evidence only and never grant execution rights. Hosted persistence requires
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the execution-operations plus
security-attribution migrations; without them local receipt files remain the durable record and the
hosted operations APIs fail closed.

The daemon permits only one unresolved signer transaction at a time. Every execution and pot
conversion persists the same receipt-backed marker before releasing the FIFO signer lane; that
marker survives restart and blocks all later wallet writes even if a fallback RPC has not yet
propagated the pending nonce. Admission also requires the account's `latest` and `pending`
transaction counts to match, so a pending nonce or an uncertain RPC view fails closed. The marker
clears only after the receipt has enough confirmations and its block hash matches the canonical
block at that height, closing both the check-to-send and stale-RPC races. The pending block must
also expose an EIP-1559 base fee no higher than the signed/configured fee cap; an
absent/unreadable fee or a cap below base fee defers without a write. The signer receipt outbox is
capped at 256 and settled in batches of 32. A mined receipt is only settled when its `blockHash`
still matches the canonical block at its height, so a reorg leaves the hash queued for a later
pass. Hosted delivery is decoupled into its own capped queue, retries with exponential backoff,
and moves permanent failures or the eighth failed attempt into
`dead-letter-*.json` evidence instead of growing state forever. If the hash cannot be durably
written after broadcast, the transaction keeps its real pending/final outcome and the process
opens a loud broadcast circuit: no later wallet write is allowed until storage is repaired and the
daemon restarts. State replacement fsyncs the temporary file and parent directory; an unreadable,
corrupt, or orphan-temporary `state.json` fails startup instead of being treated as empty.
Receipt/dead-letter filenames are published with an atomic no-replace link, and an existing file
must match the transaction's immutable identity before it is accepted as idempotent evidence.

### Stuck signer-lane runbook

An unresolved hash deliberately stops every later wallet write. Do not delete the outbox row or
`state.json` to make the daemon move again: a dropped-looking transaction can reappear, and a
second write can reuse the same nonce on a lagging RPC. Stop the daemon, preserve `state.json` and
the receipt directory, and compare the transaction plus the account's `latest` and `pending`
nonces through every configured RPC. If any endpoint reports the transaction or a pending nonce,
restore healthy RPC service and let canonical settlement clear the marker. If every independent
endpoint agrees the transaction was dropped, replace or rebroadcast that exact nonce with operator
wallet tooling, then restart the daemon and wait for the replacement's canonically matched receipt.
There is intentionally no force-clear command.

The signer uses the provider's `sendTransaction` path, so there is a narrow crash window after an
RPC accepts a transaction but before the hash reaches durable state. After any crash during a
broadcast, treat the wallet as occupied until its nonce and transaction history have been
reconciled across the configured RPC set. A future raw-transaction journal can close that final
window; the current fail-closed recovery posture does not claim crash-atomic broadcasting.

Operational notifications are off by default. To send in a production process, set
`NODE_ENV=production`, `OPENZAPS_NOTIFICATIONS_ENABLED=true`, and one or more of:
`OPENZAPS_NOTIFICATION_WEBHOOK_URL`, `OPENZAPS_DISCORD_WEBHOOK_URL`, or
`OPENZAPS_TELEGRAM_BOT_TOKEN` plus `OPENZAPS_TELEGRAM_CHAT_ID`. Tests and local/default runs never
send. Alerts are transition-deduplicated for blocked, underfunded, expired, reverted, and finalized
states. `OPENZAPS_NOTIFICATION_TIMEOUT_MS` bounds each delivery attempt; notification failure never
changes execution or receipt state.

## Intent intake (no more file shuffling)

The daemon runs a localhost-only HTTP listener (`OPENZAPS_INTAKE_PORT`, default 8477; `0`
disables): the Automate tab detects it after you sign and offers **Send to executor**, delivering
the signed intent straight into the store. Auth is a bearer token minted once into
`~/.openzaps/executor/intake.token` (chmod 600) — `node executor/index.mjs status` prints it;
paste it into the UI field one time. Bound to `127.0.0.1`, CORS-scoped to the OpenZaps origins,
schema-validated on arrival, and chain-checked — a hostile or malformed payload gets a 4xx and
nothing is written. Everything the file drop enforces still applies: the capsule re-verifies every
intent on-chain, so intake spam can only waste a simulation.

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
