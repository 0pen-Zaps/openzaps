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
- The current product posture is self-custodial software plus a reference
  courier: no pooled user balances, discretionary routing, or operator-held
  withdrawal authority. Hosted discovery/evidence services do not change that
  technical boundary. This is a product-design decision, not a legal
  classification; changing the operating model requires a fresh review.
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
3. Confirm `OPENZAPS_SUPABASE_PROJECT_REF` exactly matches the canonical
   `https://<ref>.supabase.co` `SUPABASE_URL`, then apply each new database
   migration exactly once and verify its schema or function definition with a
   read query. The verified-receipt hardening migration must report zero
   malformed `provenance_verified` rows; immutable evidence is reconciled from
   chain, never deleted or guessed.
4. Rehearse contract scripts without `--broadcast`. Predicted addresses are not
   deployments.
5. Install the reviewed executor manifest from
   `executor/manifests/robinhood-mainnet-v1.json` at the operator path named by
   `OPENZAPS_ADAPTER_MANIFEST_FILE`; re-read every runtime and registry bit at
   one block. Never generate approval pins from the same runtime check.
6. Configure at least two independently operated late-block RPC origins. Prove
   they agree on a recent canonical block, exact execution simulation, and the
   L2 `finalized` tag derived from L1 before enabling a signer. Ordered fallback
   URLs are availability, not quorum.
7. Before enabling any executor signer, configure at least two independently
   operated, reviewed private-relay origins and operators. Robinhood's public
   RPC, infrastructure-provider RPCs, sequencer feed, and direct sequencer
   endpoint do not qualify as that private-relay set. With no qualifying set,
   keep the executor watch-only.
8. Broadcast an authorized owner or deployment transaction only with the named
   local keystore or hardware signer. Never put a
   private key in a command, environment transcript, issue, or chat.
9. Independently read deployed code, constructor pins, ownership, pending
   ownership, registry state, and one user-facing route from chain.
10. Deploy the exact reviewed Git commit. Record the deployment ID, commit,
   aliases, and build result.
11. Exercise the canonical domain in a fresh browser session, inspect server
   error logs, and verify the deployment marker rather than trusting an alias
   timestamp.

## Change classes

| Change | Required evidence | Recovery posture |
|---|---|---|
| App copy or layout | lint, types, tests, build, responsive browser smoke | redeploy the previous verified commit |
| API or storage admission | body/concurrency/quota tests, migration replay, enforced edge quota | turn off the feature gate; preserve stored evidence |
| New adapter or token | source review, runtime hash manifest, fork coverage, registry simulation | de-allowlist the adapter/token; owners retain emergency exit |
| New capsule lineage | full contract suites, no-broadcast rehearsal, independent post-deploy reads | keep old lineages live; remove only the new app creation path |
| Executor signing | adapter manifest, private-relay set, late-block node quorum, L1-derived finality, clear nonce lane, durable outbox, funded gas | stop signer; never delete an unresolved outbox row |

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

## ozUSDG one-time seed

The guarded, atomic four-transaction ozUSDG seed procedure is documented in
[`2026-07-29-ozusdg-seed-runbook.md`](2026-07-29-ozusdg-seed-runbook.md). It pins the helper,
quoter, route, vault, exact token inputs, empty-vault state, approval recovery, and post-state
evidence. The source still fails closed, but the fixed 65,000 0xZAPS plan is currently blocked
because its fresh one-percent quote floor does not cover the USDG shortfall. No signature,
broadcast, inclusion, or finality is claimed; changing the fixed input requires a new review.

## Testnet soak

A chain-46630-only bootstrap, executor intent template, and dated evidence worksheet are now source
ready:

- `contracts/script/DeployRobinhoodTestnetSoak.s.sol`
- `executor/intents.sample/robinhood-testnet-soak.recurring.template.json`
- `docs/soaks/2026-07-28-robinhood-testnet-executor-soak-template.md`

They deploy fresh test-only registries, tokens, adapter, price source, v3 lineage, and a capsule
funded for exactly 24 fixed runs. Every support contract and script entrypoint rejects non-46630
chains. A real testnet soak still starts only after that isolated lineage is deployed and funded.
Record at least:

- deployment addresses, runtime hashes, signer, and testnet block;
- 24 hours of cadence checks through at least two RPC providers;
- deliberate signer restart with a pending receipt;
- relay outage/recovery and duplicate-intent suppression;
- notification delivery and deduplication;
- finality/reorg observations and the exact acceptance threshold.

The dedicated disposable soak deployer
`0x0a8E3eDA778Ea33CaF0e7AAc693A5C1a13D498E8` and executor
`0x68FDEb32EBbccE5E20104B10cf6c3097c67e4184` each returned zero testnet ETH from
the public Robinhood testnet RPC on 30 July 2026. Funding, two-provider RPC
agreement, and two qualifying private relays are separate outstanding gates, so
no testnet deployment or 24-hour soak is claimed. Obtain faucet funds through
the official Robinhood testnet flow before starting; never substitute a local
fork and call it a testnet soak.
