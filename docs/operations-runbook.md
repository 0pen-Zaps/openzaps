# OpenZaps production operations

This is the operator checklist for the current Robinhood Chain deployment. It
does not widen an agent's authority, move registry ownership, or turn a
simulation into authorization. Privileged registry, deployment, and
configuration writes require their current owner to sign the exact
transaction. User execution authority comes from a Zap owner's bounded intent;
the executor signs only the courier transaction that submits it. Permissionless
pot conversions and service-backed public metadata writes carry no user
execution authority.

## Authority boundary

- User Zaps are immutable, isolated contracts. Operations cannot edit their
  policies or redirect their balances.
- An executor is a courier for a pre-signed intent. It cannot change the route,
  recipient, amount, fee, gas caps, validity window, or nonce.
- The public relay, policy registry, Guardian, scorecards, and notifications
  carry no execution authority.
- The live adapter and token registries are currently owned by
  `0x5a52D4B820Ae7F02880d270562950918ACb14aA2`, with `pendingOwner()` equal to
  zero as last verified on 28 July 2026. Moving that ownership is intentionally
  outside this release.

Authoritative addresses and block evidence live in
[`deployments.md`](deployments.md). Re-read them from chain before any write;
do not copy an address from a broadcast log or an old terminal transcript.

## Release gate

1. Compare the release candidate with `origin/main` and the currently deployed
   Vercel commit. Stop if the checkout could roll production backward.
2. Run the web, executor/MCP, contract, PostgreSQL migration, package, and
   secret-scan gates. Keep hermetic and live-fork results separate.
3. Apply each new database migration exactly once and verify its schema or
   function definition with a read query.
4. Rehearse contract scripts without `--broadcast`. Predicted addresses are not
   deployments.
5. Install the reviewed executor manifest from
   `executor/manifests/robinhood-mainnet-v1.json` at the operator path named by
   `OPENZAPS_ADAPTER_MANIFEST_FILE`; re-read every runtime and registry bit at
   one block. Never generate approval pins from the same runtime check.
6. Broadcast only with the named local keystore or hardware signer. Never put a
   private key in a command, environment transcript, issue, or chat.
7. Independently read deployed code, constructor pins, ownership, pending
   ownership, registry state, and one user-facing route from chain.
8. Deploy the exact reviewed Git commit. Record the deployment ID, commit,
   aliases, and build result.
9. Exercise the canonical domain in a fresh browser session, inspect server
   error logs, and verify the deployment marker rather than trusting an alias
   timestamp.

## Change classes

| Change | Required evidence | Recovery posture |
|---|---|---|
| App copy or layout | lint, types, tests, build, responsive browser smoke | redeploy the previous verified commit |
| API or storage admission | body/concurrency/quota tests, migration replay, enforced edge quota | turn off the feature gate; preserve stored evidence |
| New adapter or token | source review, runtime hash manifest, fork coverage, registry simulation | de-allowlist the adapter/token; owners retain emergency exit |
| New capsule lineage | full contract suites, no-broadcast rehearsal, independent post-deploy reads | keep old lineages live; remove only the new app creation path |
| Executor signing | adapter manifest, private-relay set, clear nonce lane, durable outbox, funded gas | stop signer; never delete an unresolved outbox row |

## Incident decision tree

### Suspected adapter, token, or price-source fault

1. Stop the affected creation and execution surfaces first. Disable the narrow
   feature flag or redeploy a UI/API route that refuses the affected route.
2. Identify the exact runtime address and code hash from chain.
3. Stop the reference signer and preserve its state, receipts, and logs.
4. Simulate the registry removal transaction against current state. Registry
   removal makes affected executions revert; it does not move user funds.
5. Only the registry owner may sign the reviewed `setAdapter(adapter, false)` or
   equivalent token/source action.
6. Tell affected owners that nonce invalidation and `emergencyExit` remain the
   recovery paths. Never submit either on an owner's behalf.

### Executor or relay uncertainty

1. Stop the signer but keep read-only monitoring alive.
2. Preserve `state.json`, the receipt directory, pending raw transaction
   journal, and the exact configured RPC/relay set.
3. Compare the signer account's `latest` and `pending` nonces across every
   configured RPC. A single disagreement keeps the lane closed.
4. Do not force-clear a pending receipt. Reconcile or replace the exact nonce
   with operator wallet tooling, then wait for canonical settlement.
5. Relay loss does not grant or destroy authority: owners retain their signed
   artifact and the capsule still verifies it onchain.

### Provider credential or spend-abuse incident

1. Disable the affected API feature flag. The browser flag is not the API
   boundary.
2. Keep the durable edge rule active, inspect its matching traffic, and rotate
   the provider secret outside logs and source control.
3. Verify the replacement credential with one bounded request before restoring
   the feature gate.
4. For public read/write routes without secrets, tighten the reviewed edge quota
   rather than inventing a credential as authority.

### Canonical-domain or deployment incident

1. Resolve the currently serving deployment ID and Git commit.
2. Inspect build/runtime logs and `/api/health`.
3. Redeploy the last verified commit if the serving tree is wrong. Do not deploy
   from a stale checkout.
4. Re-run the canonical-domain flow after aliases settle.

## Drill record

The 28 July 2026 release exercise performed the non-destructive half of this
runbook:

- re-read registry owners and zero pending owners from Robinhood Chain;
- proved the v3.2 deployment preconditions and constructor assertions in a
  no-broadcast rehearsal;
- confirmed disabled exact-policy, Guardian, subscription, and Across APIs fail
  closed in production;
- inspected Vercel deployment identity, canonical navigation, runtime logs, and
  post-merge CI;
- exercised executor nonce-lane, finality, receipt-outbox, and notification
  failure paths in automated tests.

No kill switch, owner recovery, or registry mutation was executed. That is a
tabletop/read-only drill, not evidence that a destructive production action was
performed.

## Testnet soak

A real testnet soak starts only after a testnet lineage is deployed and funded.
Record at least:

- deployment addresses, runtime hashes, signer, and testnet block;
- 24 hours of cadence checks through at least two RPC providers;
- deliberate signer restart with a pending receipt;
- relay outage/recovery and duplicate-intent suppression;
- notification delivery and deduplication;
- finality/reorg observations and the exact acceptance threshold.

The current governance address had zero Robinhood testnet ETH when checked on
28 July 2026, so no testnet deployment or 24-hour soak is claimed by this
release. Obtain faucet funds through the official Robinhood testnet flow before
starting; never substitute a local fork and call it a testnet soak.
