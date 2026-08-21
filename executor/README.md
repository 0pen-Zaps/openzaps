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

Host it on this machine (macOS LaunchAgent, restarts on crash and at login). With no provider file
or signer key supplied, this installs a safe watch-only agent:

```bash
./executor/install-launchd.sh          # install + start
./executor/install-launchd.sh remove   # stop + uninstall
tail -f ~/Library/Logs/openzaps-executor.log
```

## Modes

- **Watch-only (default).** No key configured ⇒ the daemon reads chain state, evaluates every
  stored intent, simulates due runs, and logs what it *would* submit. It cannot broadcast.
- **Executing candidate.** Set `OPENZAPS_EXECUTOR_KEYFILE` to a `chmod 600` file holding a
  0x-prefixed private key (or inject `OPENZAPS_EXECUTOR_PRIVATE_KEY` through a secret manager).
  The key alone does **not** enable writes: an approved adapter manifest and the private-relay
  quorum described below must also pass. This wallet only pays gas and receives fees. Never reuse
  a wallet that holds anything you care about. The supplied LaunchAgent template deliberately sets
  neither signer variable, so installing it leaves broadcasting off.

## Intent store

Owners export signed standing intents from the app and drop them into
`~/.openzaps/executor/intents/` (one JSON file each — see [`intents.sample/`](./intents.sample)).
Files are treated as untrusted input: schema-checked on load, and every submission is re-verified
by the zap contract. Before simulation or broadcast, the daemon also proves that the target is the
exact clone emitted by the configured canonical factory: factory/implementation pins, runtime
codehash, immutable `FACTORY`/policy reads, and the indexed `ZapCreated` log must all agree.
Unknown lineages or uncertain RPC reads fail closed. Consumed, cancelled, or expired intents are
archived to `~/.openzaps/executor/done/`, never deleted.

Non-secret configuration lives in `~/.openzaps/executor/config.json` or env:
`OPENZAPS_RPC_URL`, `OPENZAPS_CHAIN_ID`, `OPENZAPS_POLL_MS`, `OPENZAPS_INTENTS_DIR`,
`OPENZAPS_LOTTERY_POT`, `OPENZAPS_MAX_FEE_PER_GAS`. Defaults target Robinhood Chain (4663) via
`https://rpc.mainnet.chain.robinhood.com`. Set `OPENZAPS_RPC_URLS` (comma-separated) to run on a
fallback transport — every request tries the endpoints in order, so one flaky RPC never idles the
bundler. These legacy/non-secret RPC settings accept only credential-free HTTPS origins with no
path, query, fragment, or embedded username/password; non-production local/test processes may use
an HTTP loopback root. Authenticated hosted primary/fallback endpoints belong only in the protected
`rpcUrls` array described below. That transport is availability only; it is not signer quorum.
`OPENZAPS_CONFIRMATIONS`
(default 12) and `OPENZAPS_RECEIPT_TIMEOUT_MS` control the initial receipt wait. Canonical v3/v3.1
pins default to the documented Robinhood deployments and may be
overridden with `OPENZAPS_V3_FACTORY` / `OPENZAPS_V3_IMPLEMENTATION` and
`OPENZAPS_V3_1_FACTORY` / `OPENZAPS_V3_1_IMPLEMENTATION`. The v3.2 lineage stays disabled for each
operator until its executor and fee-conversion unit is configured all at once:
`OPENZAPS_V3_2_FACTORY`, `OPENZAPS_V3_2_IMPLEMENTATION`, `OPENZAPS_V3_2_LOTTERY_POT`,
`OPENZAPS_V3_2_POOL_PRICE_SOURCE`, and `OPENZAPS_V3_2_FEE_ASSET`. A partial set, a zero/malformed
address, or an invalid v3.2 conversion bound fails config loading; it never enables an execution
lineage whose non-0xZAPS fees the keeper cannot service. The v3.2 execution pot must also differ from
v3.1's one-shot-bound pot. Authenticated primary/fallback RPC, late-block RPC, and private-relay
definitions are never accepted from this public config file; the canonical hosted path uses the
separate 0600 provider file below.

Signer mode also requires `OPENZAPS_ADAPTER_MANIFEST_FILE` (default
`~/.openzaps/executor/adapter-manifest.json`) to cover every route adapter with an independently
reviewed runtime hash. For the documented Robinhood mainnet release, copy
[`manifests/robinhood-mainnet-v1.json`](./manifests/robinhood-mainnet-v1.json) to that default
operator path or point `OPENZAPS_ADAPTER_MANIFEST_FILE` at an immutable installed copy. The empty
[`adapter-manifest.example.json`](./adapter-manifest.example.json) is a schema template for other
networks, not an executable mainnet manifest.
The pot keeper additionally re-reads the pot's immutable `BUY_ADAPTER` and `ZAPS`, checks
`OPENZAPS_ADAPTER_REGISTRY` still allows the adapter, and matches the same manifest pin plus
`OPENZAPS_ZAPS_TOKEN`. Missing pins, changed bytecode, retired adapters, and unreadable dependencies
block before simulation or signing. Watch-only may report a missing pin, but never promotes the
observed onchain hash into approval.

## Late-block admission and L1-derived finality

The canonical hosted LaunchAgent signer path requires both `rpcUrls` and `lateBlockRpcUrls` in the
file referenced by `OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE`. Each must contain 2–8 HTTPS RPC URLs on
distinct origins. `rpcUrls` is the primary/fallback read and simulation transport;
`lateBlockRpcUrls` is queried independently for pre-write admission and finality. A legacy
interactive process may supply the equivalent late-block environment-only JSON when no file source
is selected, as described below; neither authenticated source is accepted from `config.json`.
Provider URLs often contain credentials, so exact URL/credential values plus generic endpoint
patterns are removed at every log and durable error-serialization boundary. Distinct origins are
only a mechanical floor: the operator must verify that the endpoints are run by independent node
operators.

Immediately before any wallet write, inside the single signer-lane mutex, the executor:

1. queries every declared node independently instead of using viem's ordered fallback;
2. rejects wrong-chain, malformed, stale, future-skewed, or excessively lagging heads;
3. requires at least `OPENZAPS_LATE_BLOCK_MIN_AGREEMENT` nodes (default 2) to agree on one recent
   canonical `(blockNumber, blockHash)`; and
4. for a capsule execution, repeats the exact `eth_call` through the agreeing nodes at that block.

The earlier simulation remains useful in watch-only mode but never authorizes a signer. A stale
head (default maximum age 60 seconds), hash disagreement, split simulation, or unavailable quorum
returns a typed fail-closed outcome and sends no transaction. Tune only the bounded
`OPENZAPS_LATE_BLOCK_MAX_HEAD_SKEW`, `OPENZAPS_SEQUENCER_MAX_BLOCK_AGE_SECONDS`, and
`OPENZAPS_MAX_CLOCK_SKEW_SECONDS` controls after recording evidence from the actual providers.

Receipt observation is also not settlement. The same independent-node set must agree on one recent
L2 `finalized` block at or beyond the receipt, in addition to the configured confirmation depth and
a canonical block-hash match. `OPENZAPS_FINALITY_MAX_HEAD_SKEW` and
`OPENZAPS_FINALITY_MAX_BLOCK_AGE_SECONDS` bound disagreement and stale evidence. Robinhood Chain's
documented Nitro node consumes Ethereum execution and beacon endpoints because chain data settles
through L1. Operators must verify their providers' `finalized` semantics and retain the outbox if
that quorum evidence is missing. L1 force-inclusion is not implemented here; it remains part of the
explicitly deferred protective-zap model.

## Private submission on Robinhood Chain

Every released executor route calls an adapter, and the pot conversion calls a bounded swap
adapter, so the daemon conservatively classifies **every current wallet write as price-sensitive**.
It never falls back to the normal read RPC for those writes. viem prepares and signs the
transaction locally; only the signed raw bytes enter the private submission provider.

The executor's preflight `eth_call` still contains route calldata. Operators seeking
confidentiality from infrastructure providers must point the read/simulation client at a trusted
or self-hosted RPC; the relay adapter prevents public **transaction submission**, not disclosure
to the RPC operator chosen for simulation.

Robinhood Chain is an Arbitrum L2 with first-come-first-served sequencing. Its documentation lists
a public RPC, infrastructure-provider RPCs, a sequencer feed, and a direct sequencer endpoint; it
does not document an independent private-builder/private-relay network. The public and direct
sequencer endpoints therefore do **not** satisfy this gate:

- [Robinhood Chain architecture and transaction ordering](https://docs.robinhood.com/chain/)
- [Robinhood Chain endpoints](https://docs.robinhood.com/chain/connecting/)

The provider file contains exactly three keys: `rpcUrls`, `lateBlockRpcUrls`, and `privateRelays`.
The primary/fallback and late-block arrays each require 2–8 distinct HTTPS origins. Each private
relay must declare a stable `id`, an HTTPS `url`, its `operator`, and the exact classification
`private-relay`. At least two distinct private-relay HTTPS origins **and** two distinct declared
operators are required:

```json
{
  "rpcUrls": [
    "https://hosted-primary.example/rpc/provider-key",
    "https://hosted-fallback.example/rpc/provider-key"
  ],
  "lateBlockRpcUrls": [
    "https://independent-rpc-a.example/rpc",
    "https://independent-rpc-b.example/rpc"
  ],
  "privateRelays": [
    {
      "id": "relay-a",
      "url": "https://private-a.example/rpc",
      "classification": "private-relay",
      "operator": "provider-a",
      "authorization": "Bearer replace-through-your-secret-editor"
    },
    {
      "id": "relay-b",
      "url": "https://private-b.example/rpc",
      "classification": "private-relay",
      "operator": "provider-b"
    }
  ]
}
```

Create it in the dedicated operator directory shown below, outside every source checkout, and make
it an exact `0600` regular file owned by the current user. The validator rejects any path beneath
an ancestor containing a normal repository `.git/` directory or linked-worktree `.git` file.
Symlinks, files larger than 64 KiB, unknown JSON fields, malformed values, duplicate RPC origins,
and duplicate relay ids/origins/operators abort configuration without echoing the JSON:

```bash
mkdir -p ~/.openzaps/executor
umask 077
${EDITOR:-vi} ~/.openzaps/executor/provider-secrets.json
chmod 600 ~/.openzaps/executor/provider-secrets.json

export OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE="$HOME/.openzaps/executor/provider-secrets.json"
node executor/secret-config.mjs
./executor/install-launchd.sh
```

When the file variable is explicitly supplied, the installer validates it before replacing the
plist and inserts only its path alongside `PATH`. A watch-only install with no file omits the
variable entirely. Neither generated form contains a provider URL, Authorization value, raw JSON,
or signer key; the installed service therefore remains watch-only.
`OPENZAPS_LATE_BLOCK_RPC_URLS` and `OPENZAPS_PRIVATE_RELAYS_JSON` remain available only as a legacy
interactive compatibility path when the file variable is absent. Setting either legacy variable
alongside `OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE` fails closed instead of choosing precedence.

An optional `authorization` value is sent as the HTTP `Authorization` header and is never included
in readiness or health output. `OPENZAPS_PRIVATE_RELAY_MIN_ORIGINS` defaults to 2 and cannot be
lowered below 2.
`OPENZAPS_PRIVATE_RELAY_TIMEOUT_MS` defaults to 8000. Different URLs or operator labels are
operator declarations, not cryptographic proof of independent control: operators must verify the
actual relay trust domains and privacy contract before enabling a signer.

The same raw transaction is fanned out to every eligible origin. Results record
accepted/already-known, rejected, or uncertain health per origin. A timeout is uncertain because
the relay may have accepted before the connection failed; the daemon retains the deterministic
hash and waits for onchain inclusion rather than risking nonce reuse. If every relay rejects, no
public retry occurs. With no qualifying set configured, an executor key starts in an explicit
`private-submission-unavailable` fail-closed state. This is source-ready plumbing, not a claim that
Robinhood currently offers builder diversity.

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

A locally signed private transaction — execution or pot conversion — enters the receipt outbox as
`prepared` **before** the first relay request, with its deterministic hash and raw bytes. The 0600
state file is fsynced first; failure means nothing is dispatched. A successful or uncertain relay
fanout advances it to `submitted`, while a crash or rejection leaves exact bytes available for
bounded private redispatch. Raw bytes and relay credentials are never logged or sent to hosted
receipt APIs. The immediate wait reports only that a receipt was observed; it does not declare
finality. Finalized and reverted transactions are promoted only by the later canonical-settlement
pass and written as versioned JSON to
`~/.openzaps/executor/receipts/` (override with `OPENZAPS_RECEIPTS_DIR`). Relayed executions are also
sent to `/api/executions/receipts`, which independently decodes the signed calldata, transaction
sender, receipt, confirmations, and execution event before an idempotent database upsert. Receipt
and scorecard data are evidence only and never grant execution rights. Hosted persistence requires
the exact `OPENZAPS_SUPABASE_PROJECT_REF` / `SUPABASE_URL` binding,
`SUPABASE_SERVICE_ROLE_KEY`, and the execution-operations plus
security-attribution migrations; without them local receipt files remain the durable record and
the hosted operations APIs fail closed.

New pot-conversion outbox rows and local receipts bind the lineage id, pot address, fee asset, price
source, input amount, and signed minimum 0xZAPS output. Successful canonical settlement advances both
the backwards-compatible lifetime conversion count and a per-pot/per-asset input total in
`state.json` only after the finalized transaction target and decoded `buyZaps` calldata match that
journaled pot, asset, and both amounts. Pre-upgrade anonymous conversion receipts remain settleable
and count toward the lifetime total, but are not guessed into a lineage bucket.

The daemon permits only one unresolved signer transaction at a time. Every execution and pot
conversion persists the same receipt-backed marker before releasing the FIFO signer lane; that
marker survives restart and blocks all later wallet writes even if a fallback RPC has not yet
propagated the pending nonce. Admission also requires the account's `latest` and `pending`
transaction counts to match, so a pending nonce or an uncertain RPC view fails closed. The marker
clears only after the receipt has enough confirmations, an independent quorum agrees that the
L1-derived `finalized` L2 boundary has crossed it, and its block hash matches the canonical block
at that height, closing both the check-to-send and stale-RPC races. The pending block must also
expose an EIP-1559 base fee no higher than the signed/configured fee cap; an
absent/unreadable fee or a cap below base fee defers without a write. The signer receipt outbox is
capped at 256 and settled in batches of 32. A mined receipt is only settled when its `blockHash`
still matches the canonical block at its height, so a reorg leaves the hash queued for a later
pass. Hosted delivery is decoupled into its own capped queue, retries with exponential backoff,
and moves permanent failures or the eighth failed attempt into
`dead-letter-*.json` evidence instead of growing state forever. If the prepared journal cannot be
written, no relay request occurs and the process opens a loud broadcast circuit. If the submitted
transition cannot be written, the already-durable prepared bytes still occupy the lane and no later
wallet write is admitted. State replacement fsyncs the temporary file and parent directory; an unreadable,
corrupt, or orphan-temporary `state.json` fails startup instead of being treated as empty.
Receipt/dead-letter filenames are published with an atomic no-replace link, and an existing file
must match the transaction's immutable identity before it is accepted as idempotent evidence.

### Stuck signer-lane runbook

An unresolved hash deliberately stops every later wallet write. Do not delete the outbox row or
`state.json` to make the daemon move again: a dropped-looking transaction can reappear, and a
second write can reuse the same nonce on a lagging RPC. Stop the daemon, preserve `state.json` and
the receipt directory, and compare the transaction plus the account's `latest` and `pending`
nonces through every configured RPC. If any endpoint reports the transaction or a pending nonce,
restore healthy RPC service and let canonical settlement clear the marker. A `prepared` entry is
automatically redispatched as the exact same signed bytes after nonce admission; it never uses the
public RPC. If every independent endpoint agrees a submitted transaction was dropped, preserve the
journal and reconcile that exact nonce before any manual replacement. There is intentionally no
force-clear command.

Operational notifications are off by default. To send in a production process, set
`NODE_ENV=production`, `OPENZAPS_NOTIFICATIONS_ENABLED=true`, and one or more of:
`OPENZAPS_NOTIFICATION_WEBHOOK_URL`, `OPENZAPS_DISCORD_WEBHOOK_URL`, or
`OPENZAPS_TELEGRAM_BOT_TOKEN` plus `OPENZAPS_TELEGRAM_CHAT_ID`. Tests and local/default runs never
send. Alerts are transition-deduplicated for blocked, underfunded, expired, reverted, and finalized
states. `OPENZAPS_NOTIFICATION_TIMEOUT_MS` bounds each delivery attempt; notification failure never
changes execution or receipt state.

## Intent intake (no more file shuffling)

The daemon runs a localhost-only HTTP listener (`OPENZAPS_INTAKE_PORT`, default 8477; `0`
disables). Auth is a bearer token minted once into `~/.openzaps/executor/intake.token` with mode
0600. The public Automate page deliberately never reads or stores that local capability. Use the
local MCP server's `deliver_intent_local` tool: its own process reads the token from disk and sends
the already-signed intent to `127.0.0.1`. `node executor/index.mjs status` prints only the token file
path, never the capability itself. Without MCP, download the signed JSON and place it in
`~/.openzaps/executor/intents/`.

The listener is bound to loopback, CORS-scoped to the OpenZaps origins, schema-validated on
arrival, and chain-checked — a hostile or malformed payload gets a 4xx and nothing is written.
Everything the file drop enforces still applies: the capsule re-verifies every intent onchain, so
intake spam can only waste a simulation.

## Multi-pot conversion keeper

The 20% of each execution fee that funds a lineage's lottery pot arrives as 0xZAPS on buy runs, but
as **aeWETH** on sell runs — and aeWETH just sits in that pot until someone calls the permissionless
`buyZaps` to convert it. The daemon services the live v3.1 pot and, when fully configured, the
separate v3.2 pot on one cadence (`OPENZAPS_CONVERT_EVERY_MS`, default 5 min). It rotates the first
pot inspected so a continuously accruing lineage cannot starve another, while every actual write
still uses the same configured signer, FIFO mutex, nonce admission, private relay, and durable
receipt lane as intent execution.

For each pot, the keeper reads that pot's own fee-asset balance and price source, floors output by
`OPENZAPS_CONVERT_SLIPPAGE_BPS` (default 3%), and — with a signer — submits `buyZaps`, turning the
fee into the round's 0xZAPS prize. Below `OPENZAPS_CONVERT_MIN_WEI` (default 0.001 aeWETH) it idles
rather than pay gas to convert dust. Watch-only mode simulates and logs what it would convert.

The legacy v3.1 knobs remain backwards compatible:
`OPENZAPS_LOTTERY_POT`, `OPENZAPS_POOL_PRICE_SOURCE`, `OPENZAPS_FEE_ASSET`,
`OPENZAPS_CONVERT_MIN_WEI`, and `OPENZAPS_CONVERT_SLIPPAGE_BPS`. v3.2 uses the required address
triplet named above and may independently override the inherited dust/slippage settings with
`OPENZAPS_V3_2_CONVERT_MIN_WEI` and `OPENZAPS_V3_2_CONVERT_SLIPPAGE_BPS`.

The same values can be placed in `config.json`: keep v3.2 factory/implementation under
`capsuleLineages["v3.2"]`, and put `lotteryPot`, `poolPriceSource`, `feeAsset`, and optional
conversion bounds under `conversionPots["v3.2"]`. Partial file-plus-environment combinations are
evaluated as one set and fail closed.

## Gas self-monitoring

An executing daemon watches its own gas wallet each pass and logs a **LOW** warning when it can
afford fewer than `OPENZAPS_GAS_WARN_RUNS` (default 10) more runs, or an **EMPTY** error when it
cannot fund one — so it never silently stops broadcasting. `node executor/index.mjs status` prints
lifetime runs and conversions, plus settled conversion counts and fee-asset input totals for each
configured (or historically tracked) pot, alongside the current gas health.

## What an executor can and cannot do

Can: submit a run the schedule already owes; submit a trigger the market already arms; earn the
fee; convert pot fee assets to 0xZAPS via the pinned bounded adapter (permissionless `buyZaps`).

Cannot: change route, amounts, recipient, or out-asset (frozen policy + signature); run early
(`IntervalNotElapsed`), re-run (`NonceReplay`), fire an unarmed trigger (`TriggerNotMet`), pass
itself a bigger fee (constants in the contract), or bypass the owner's net-of-fee floor
(`MinOutNotMet`). It also cannot send a price-sensitive write through the public RPC: local raw
signing is wired only to the qualifying private-relay set. Losing the executor key loses gas money
and fee income, nothing else.

## Campaign 2 harvest and Hook Blocks keeper

Campaign 2 uses a separate keeper process so enabling its gas wallet does not silently enable the
general intent executor. The keeper is release-specific and cannot accept target addresses,
selectors, calldata, or value from config. Its complete write allowlist is:

- `0x7F57…09F9.harvest()` once per 24-hour campaign window;
- `0xB5F7…e8Db.buyAndBurn(minHookrOut)` only for a full `MAX_BUY_WEI()` batch;
- each contract's permissionless `finalize()` once the immutable term has ended.

The automated caller floor is nonzero and sized for the full 0.05 ETH cap: 97% of a 30–60 minute
median from the pinned HOOKR pool. Before signing, a separately configured owner-only archive RPC
must reproduce the PoolManager `slot0` value at every canonical sample block; matching headers
alone are not price evidence. The contract independently enforces the greater of that floor and
its same-block spot × 97% floor. Watch-only collects at least seven unique five-minute samples and
never backfills through the shallow public RPC. Burn automation is disabled by default. The
service never calls either sweep, never claims for a
staker, never changes the sponsor pause, never sends native value, and admits at most four
transactions per UTC day. Before every decision it verifies chain 4663, both runtime hashes, the
shared schedule, funding, pause/finalization state, and all decision inputs at one pinned block.
Every write is simulated at the decision block and again against latest state immediately before
signing, gas-price capped, signed locally, decoded and recovered against the
pinned keeper before publication, persisted before broadcast, receipt-confirmed, and read back.
Burn publication retries expire after 10 minutes of canonical chain time. The public and archive
providers must also agree on their shared canonical chain, and both heads must be within two
minutes of the keeper's wall clock. An unresolved deadline-free burn then requires deliberate
nonce replacement, although bytes already accepted by a public mempool may still be mined. Settlement binds the receipt, transaction, canonical block,
and postcondition readback to one block hash before clearing the journal.
The service warns below `0.0003 ETH` of keeper gas and refuses a write unless the current balance
can cover that action's full fixed-gas × max-fee cap; it never tops itself up.

Safe inspection is the default:

```bash
npm run campaign2:status
export OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT=<reviewed-40-character-git-sha>
./executor/install-campaign2-launchd.sh watch-only
```

`watch-only` also creates an immutable, commit-addressed ncc bundle copy and starts gathering the
price journal. CI and the installer rebuild from source and require byte-for-byte equality with the
committed bundle. A small owner-only launcher verifies the copied Node, entry, chunk, and license
hashes before Node evaluates JavaScript. Watch-only prints the Node digest for independent review.

Live activation is an explicit signer boundary. Running `enable` is the broadcast authorization,
not a preparation command. It accepts only the dedicated encrypted Web3
keystore plus its separate 0600 password file through Foundry Cast's `--password-file`; raw and
inline private keys are refused. The installer requires an operator-approved Cast SHA-256 and
checks it before the first keystore command; the daemon checks it again before every signature:

```bash
export OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT=<reviewed-40-character-git-sha>
export OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256=<reviewed-lowercase-sha256>
export OPENZAPS_CAMPAIGN2_EXPECTED_CAST_SHA256=<reviewed-lowercase-sha256>
export OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS=false
./executor/install-campaign2-launchd.sh enable
```

To authorize burns as well, provide an owner-only file containing one archive RPC HTTPS URL and
set both `OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS=true` and
`OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE=/absolute/path/to/that/file` on the `enable` command. The URL
itself never enters the plist or process arguments.

The installer defaults to the Campaign 2 keystore handoff under `~/.openzaps/keeper`, verifies
both secret files are owner-only and non-symlinked, and decrypts only to confirm that the public
address is the pinned keeper `0xA2b7…9bEC`. Override those absolute paths only with
`OPENZAPS_CAMPAIGN2_KEYSTORE_FILE`, `OPENZAPS_CAMPAIGN2_PASSWORD_FILE`, and
`OPENZAPS_CAMPAIGN2_CAST_BIN`. `OPENZAPS_CAMPAIGN2_NODE_BIN` may select an alternate absolute Node
binary. The approved Node and Cast bytes are copied into owner-only hash-addressed runtime
directories; the original Cast path never receives the keystore password arguments.

Do not enable the general executor with the same key at the same time. The campaign service keeps
its state in `~/.openzaps/campaign2-keeper/state.json` and logs to
`~/Library/Logs/openzaps-campaign2-keeper.log`. `remove` verifies the job is unloaded before
removing its plist. Watch-only/status do not rebroadcast retained signed bytes, but neither
watch-only nor `remove` revokes or deletes them. If a signed burn is pending, pass its existing
owner-only `OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE` to the watch-only installer so it can authenticate
the receipt without signing or rebroadcasting; disabling burns independently prevents the live
daemon from republishing that burn. Preserve the state and archive-RPC file through canonical
reconciliation. The
first automatic harvest is due one full cadence after the fixed start because the release already
performed the launch-day harvest. At term end it finalizes both legs and converts only full
`MAX_BUY_WEI` batches; smaller residual WETH and all sponsor/unclaimed-reward sweeps remain manual.

The deployed HookBlocks entry point remains permissionless and accepts `buyAndBurn(0)`. A third
party can therefore rely only on the manipulable same-block floor. This keeper protects only its
own transactions; use the sponsor pause, manual/private ordering, or a future contract change if
global enforcement is required.
