# Robinhood testnet executor soak — 28 July 2026 template

> **STATUS: NOT STARTED. TESTNET ONLY.** This file is an operator template, not a result. No
> chain-46630 deployment, broadcast, 24-hour run, transaction, notification, restart, outage drill,
> or acceptance result is claimed here.

## Purpose and hard boundary

This soak exercises a disposable OpenZap v3 recurring/trigger lineage on Robinhood testnet,
chain ID `46630`. It must use
`contracts/script/DeployRobinhoodTestnetSoak.s.sol:DeployRobinhoodTestnetSoak`, which deploys only
fresh test fixtures:

- independent adapter, token, and price-source registries;
- fixed-supply tokens named `TEST ONLY`;
- one fixed-input, fixed-output, 1:1 adapter;
- one synthetic, owner-controlled price source;
- one v3 factory, implementation, lottery pot, and registered clone; and
- exactly `24` test input tokens in the clone, consumed at `1` token per successful run.

Every support-contract constructor and both deployment-script entrypoints refuse every chain except
`46630`. Nothing in this procedure may reuse a Robinhood mainnet (`4663`) token, adapter, registry,
pot, factory, capsule, signer balance, relay configuration, or deployment address. The generated
addresses are **testnet-only, non-production, unaudited, and disposable**.

The 24-token funding is the onchain value ceiling for this capsule. Failed transactions revert
without consuming a token. Refilling it, changing its policy, or deploying another capsule is a new
soak scope and must be recorded separately.

## Gate 0 — operator record

Complete this before any broadcast:

| Field | Required value |
|---|---|
| Operator | `________________` |
| Planned start, UTC | `________________` |
| Planned end, UTC (at least 24h later) | `________________` |
| Reviewed Git commit | `________________` |
| Testnet deployer address | `________________` |
| Executor address | `________________` |
| RPC A operator/origin | `________________` |
| RPC B operator/origin | `________________` |
| Submission relay A operator/origin | `________________` |
| Submission relay B operator/origin | `________________` |
| Notification sink and test recipient | `________________` |
| Evidence directory | `________________` |

Stop if either RPC URL is merely an alias for the same provider origin, if a submission endpoint is
not actually classified and reviewed for test use, or if the signer/keyfile has ever held real
assets. Never paste provider credentials, private keys, raw signed transactions, webhook secrets,
or intake tokens into this record.

## Gate 1 — local verification and chain identity

From `contracts/`:

```sh
forge fmt --check \
  src/testnet/RobinhoodTestnetSoakSupport.sol \
  script/DeployRobinhoodTestnetSoak.s.sol \
  test/DeployRobinhoodTestnetSoak.t.sol

forge test --match-contract DeployRobinhoodTestnetSoakTest -vv
forge build
```

Independently read both configured RPCs. Both must return decimal chain ID `46630`; stop on any
disagreement:

```sh
cast chain-id --rpc-url "$ROBINHOOD_TESTNET_RPC_A"
cast chain-id --rpc-url "$ROBINHOOD_TESTNET_RPC_B"
```

Verify the official testnet RPC/faucet information at execution time. Fund only the disposable
testnet deployer and executor with the minimum test gas required. A local fork, Anvil chain with its
ID changed, dry run, or unit test does not count as testnet soak time.

## Gate 2 — no-broadcast rehearsal

Run the exact script first without `--broadcast`:

```sh
forge script script/DeployRobinhoodTestnetSoak.s.sol:DeployRobinhoodTestnetSoak \
  --sig 'run(address)' "$ROBINHOOD_TESTNET_DEPLOYER" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_A" \
  --sender "$ROBINHOOD_TESTNET_DEPLOYER"
```

The script overloads `run()` and `run(address)`, so the explicit signature and deployer positional
argument are mandatory. The entrypoint reverts unless that argument equals Forge's script sender.
Keep the deployer argument before the RPC flags exactly as shown; do not rely on Forge to select the
default entrypoint.

The output must begin with `TESTNET ONLY / NON-PRODUCTION / DISPOSABLE`, report chain ID `46630`,
show `funded fixed runs 24`, and print nonzero addresses for all eleven artifacts. The script itself
checks every code presence, ownership/pending-owner state, registry bit, constructor pin, runtime
hash relation, token supply/balance, factory/implementation/clone relationship, policy field, and
lottery-pot registration. Any revert is a stop, not a reason to bypass an assertion.

Record the rehearsal command, exit code, and timestamp:

```text
Rehearsal UTC:
Command transcript path:
Exit code:
Reviewer:
```

## Gate 3 — operator-authorized broadcast

This template does not authorize a broadcast. After the rehearsal and operator review, use a named
test-only keystore, hardware account, or external signer. Do not put a private key in the command or
environment transcript.

Example shape for the eventual operator action:

```sh
forge script script/DeployRobinhoodTestnetSoak.s.sol:DeployRobinhoodTestnetSoak \
  --sig 'run(address)' "$ROBINHOOD_TESTNET_DEPLOYER" \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_A" \
  --sender "$ROBINHOOD_TESTNET_DEPLOYER" \
  --account "$ROBINHOOD_TESTNET_FORGE_ACCOUNT" \
  --broadcast --slow
```

Immediately copy the confirmed addresses and block evidence below. A simulated address or broadcast
JSON entry is not deployment evidence; read each address back from both RPCs at one pinned block.

| Artifact | Address | Runtime code hash | RPC A/RPC B agree? |
|---|---|---|---|
| Adapter registry | `________________` | `________________` | `___` |
| Token allowlist | `________________` | `________________` | `___` |
| Price-source registry | `________________` | `________________` | `___` |
| TEST input token | `________________` | `________________` | `___` |
| TEST output token | `________________` | `________________` | `___` |
| Fixed-rate adapter | `________________` | `________________` | `___` |
| Synthetic price source | `________________` | `________________` | `___` |
| Lottery pot | `________________` | `________________` | `___` |
| v3 factory | `________________` | `________________` | `___` |
| v3 implementation | `________________` | `________________` | `___` |
| Bounded soak capsule | `________________` | `________________` | `___` |

```text
Deployment transaction(s):
Deployment block number:
Deployment block hash:
Deployment UTC:
Independent reviewer:
```

Re-read and attach evidence for:

- all three registry owners, the pot owner, and synthetic price-source owner equal the recorded
  testnet deployer;
- every `pendingOwner()` is zero;
- only the test adapter, two test tokens, and synthetic source are allowlisted in their fresh
  registries;
- adapter input/output/rate pins match the two test tokens and `1e18`;
- factory pins match the fresh registries and pot, and `implCodeHash()` matches implementation code;
- implementation and capsule immutables match the factory stack;
- pot pins the test output token/adapter/factory and recognizes the capsule;
- capsule owner/recipient/policy/step match the script;
- capsule holds exactly `24e18` test input, adapter holds exactly `48e18` test output, and the
  deployer holds neither token.

## Gate 4 — executor configuration

Create a separate testnet executor state/receipt directory and an independently reviewed adapter
manifest. Do not overwrite or point at the Robinhood mainnet executor state.

The manifest must use chain ID `46630` and pin the deployed test adapter address to a runtime hash
read independently from the reviewed deployment. Do not generate the “approved” hash from the same
runtime check used at admission without a second review.

```json
{
  "_evidence": {
    "network": "Robinhood testnet — TEST ONLY",
    "registry": "<fresh adapter registry>",
    "observedBlock": "<pinned testnet block>",
    "observedAt": "<UTC>",
    "approvalBasis": "<review record>"
  },
  "version": 1,
  "chainId": "46630",
  "adapters": [
    {
      "label": "RobinhoodTestnetFixedRateAdapter — TEST ONLY",
      "address": "<deployed test adapter>",
      "runtimeCodeHash": "<reviewed keccak256 runtime hash>"
    }
  ]
}
```

At minimum, isolate and review these overrides before signer mode:

```text
OPENZAPS_CHAIN_ID=46630
OPENZAPS_RPC_URL=<RPC A>
OPENZAPS_RPC_URLS=<RPC A>,<RPC B>
OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE=<absolute path to external 0600 provider file>
OPENZAPS_V3_FACTORY=<fresh testnet factory>
OPENZAPS_V3_IMPLEMENTATION=<fresh testnet implementation>
OPENZAPS_ADAPTER_REGISTRY=<fresh testnet adapter registry>
OPENZAPS_ADAPTER_MANIFEST_FILE=<immutable reviewed testnet manifest path>
OPENZAPS_LOTTERY_POT=<fresh testnet pot>
OPENZAPS_ZAPS_TOKEN=<TEST output token>
OPENZAPS_POOL_PRICE_SOURCE=<synthetic testnet source>
OPENZAPS_FEE_ASSET=<TEST input token>
OPENZAPS_INTENTS_DIR=<new testnet-only directory>
OPENZAPS_RECEIPTS_DIR=<new testnet-only directory>
```

The external provider file is the canonical hosted configuration and must use the exact
`rpcUrls`, `lateBlockRpcUrls`, plus `privateRelays` schema in `executor/README.md`. It must contain
only reviewed, testnet-qualified endpoints, live outside every checkout, be owned by the current
user, and have permissions exactly `0600`. Validate it with `node executor/secret-config.mjs` before
installing or starting a service. The legacy JSON environment variables are interactive
compatibility inputs, not the soak's hosted configuration.

Keep the executor watch-only first:

```sh
node executor/index.mjs status
node executor/index.mjs once
```

Attach the status and one-pass outputs after confirming they disclose no credentials. Enable the
test-only signer only after the two-node late-block/finality checks and submission-relay admission
pass. The executor key carries gas only; the recurring intent remains the capsule owner's bounded
authorization.

## Gate 5 — signed recurring series

Start from
`executor/intents.sample/robinhood-testnet-soak.recurring.template.json`. It matches the executor's
`kind: "recurring"` file schema and keeps every uint field as a decimal string, avoiding JavaScript
number truncation. It is deliberately unsigned and unusable as checked in: replace every zero
address/hash/time and the all-zero signature only after reading the deployed values from chain.

Prepare one owner signature whose fields exactly match:

| Field | Required value |
|---|---|
| `zap` | recorded bounded soak capsule |
| `chainId` | `46630` |
| `seriesId` | unique recorded integer |
| `validAfter` | recorded start |
| `deadline` | at least 24h plus a small recorded margin |
| `interval` | `3600` seconds |
| `maxRuns` | `24` |
| `recipient` | recorded testnet deployer/owner |
| `executor` | zero for permissionless test or recorded executor if pinning is in scope |
| `maxGas` | measured and explicitly bounded |
| `maxFeePerGas` | testnet-only cap |
| `policyHash` | read from the deployed capsule |
| `outAsset` | TEST output token |
| `minOutPerRun` | reviewed net floor, no more than `0.99e18` at the fixed 1:1 rate |

Record the intent digest and public fields. Do not record the private key or raw transaction. Submit
the signed intent through the chosen local/relay intake and verify the capsule independently
recomputes the same digest.

## 24-hour observation log

Start the clock only after the first recurring transaction is canonically observed. A complete run
requires at least 24 hours of wall-clock observation; 24 fast local executions do not qualify.

| Run | Due UTC | Submitted UTC | Tx hash | Included block/hash | Finalized evidence | RPC agreement | Recipient/executor/pot deltas | Result |
|---:|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| 6 | | | | | | | | |
| 7 | | | | | | | | |
| 8 | | | | | | | | |
| 9 | | | | | | | | |
| 10 | | | | | | | | |
| 11 | | | | | | | | |
| 12 | | | | | | | | |
| 13 | | | | | | | | |
| 14 | | | | | | | | |
| 15 | | | | | | | | |
| 16 | | | | | | | | |
| 17 | | | | | | | | |
| 18 | | | | | | | | |
| 19 | | | | | | | | |
| 20 | | | | | | | | |
| 21 | | | | | | | | |
| 22 | | | | | | | | |
| 23 | | | | | | | | |
| 24 | | | | | | | | |

For every successful fixed-rate run, reconcile exactly:

- capsule test input decreases by `1e18`;
- adapter test input increases by `1e18`;
- gross test output is `1e18`;
- recipient receives `0.99e18`;
- submitting executor receives `0.008e18`;
- lottery pot receives and credits `0.002e18`; and
- capsule step allowance returns to zero.

## Required fault drills

Perform these at planned run boundaries and preserve before/during/after evidence:

| Drill | Planned UTC/run | Expected fail-closed behavior | Evidence/result |
|---|---|---|---|
| Executor restart with prepared or pending receipt | | durable outbox recovers the same hash/nonce; no double send | |
| RPC A unavailable | | RPC B preserves reads; signer requires configured quorum and does not silently downgrade | |
| RPC disagreement/stale head | | signer admission closes; no transaction is signed | |
| Submission relay A unavailable | | reviewed alternate origin handles the same prepared transaction or lane remains safely pending | |
| All eligible relays unavailable | | no public-RPC fallback and no nonce reuse | |
| Duplicate recurring intent delivery | | one due execution; replay/duplicate is suppressed | |
| Notification delivery failure/recovery | | execution state is unchanged; alert retries/deduplicates | |
| Synthetic price source set to zero | | trigger read reverts `PriceUnavailable`; no trigger execution | |
| Synthetic price restored | | only owner can restore; a newly valid signed trigger may proceed | |
| Finality delay or observed reorg | | receipt remains unsettled until canonical hash and finalized evidence agree | |

Setting the synthetic price to zero requires an owner transaction to the disposable price source.
Record it as a test-only fault injection. Never perform an equivalent operation against a production
price source or registry.

## Acceptance criteria

Mark the soak `PASS` only if all are true:

- at least 24 hours elapsed between the first and final accepted observation;
- all 24 bounded runs were due, submitted at most once, canonically included, and reconciled;
- both independent RPC origins agreed at every signing/admission point;
- finalized/L1-derived evidence met the pre-recorded threshold for every settled receipt;
- restart recovery preserved the exact pending nonce/hash without duplicate execution;
- relay loss never fell back to an unapproved public submit path;
- duplicate intent, stale head, RPC disagreement, source outage, and notification failure all failed
  closed as specified;
- no credential, raw private transaction, or real asset entered the evidence set; and
- the final token/accounting totals match the sum of the per-run records.

Any unknown receipt, nonce disagreement, missing finality evidence, unexpected balance, signer
admission downgrade, or unrecorded configuration change is a `FAIL` or `INCONCLUSIVE`, never a pass.

## Final result — leave blank until the run exists

```text
Status: NOT STARTED
Actual start UTC:
Actual end UTC:
Elapsed wall time:
Accepted runs:
Failed/deferred runs:
Fault drills completed:
Final deployment block/hash:
Evidence bundle hash:
Operator:
Independent reviewer:
Summary:
```

Do not change `Status` to `PASS` merely because the deployment script or Foundry tests pass. Those
are prerequisites; they are not evidence that a 24-hour testnet soak occurred.
