# ZapPad release ceremony

This runbook is a gate specification for a future, brand-new Robinhood Chain
deployment from OpenZaps. It is not authorization to broadcast.

## Current no-go

There are no approved ZapPad mainnet addresses. The embedded contract source
originated at standalone commit
`de269ef73c28aeb508b690e53535986802f29b16`, but a ZapPad deployment from
OpenZaps must bind to a new full OpenZaps Git SHA after integration review. The
standalone SHA, its Preview, predicted CREATE/CREATE2 addresses, and local fork
addresses are not mainnet deployment evidence.

The OpenZaps integration includes the Solidity scripts, encrypted-keystore
broadcast wrapper, onchain release validation, and independent receipt/evidence
verifiers. Their presence is not authorization to broadcast: a production
release remains prohibited until every external and evidence gate below is
satisfied for one exact OpenZaps commit. Raw `forge --broadcast`, unlocked
signing, raw private keys, `--skip-simulation`, and `--resume` are not release
paths.

Until every section below passes:

- `ZAPPAD_LAUNCH_WRITES_ENABLED` remains absent or `false`;
- no launcher address is published as canonical;
- `/launch` is labelled source-ready, not deployed;
- no promoted public launch or material-value use is permitted.

## Preconditions

1. An independent external audit covers the exact contracts and integration
   commit before material-value or promoted public use. A strictly low-value
   canary before audit requires written, explicit risk acceptance.
2. Specialist counsel approves the operator/entity, Terms, Privacy,
   jurisdictions, sanctions posture, financial promotions, token moderation,
   and treatment of transferable LP fee rights.
3. The exact OpenZaps SHA passes the complete matrix in
   [testing.md](testing.md), including a paid archive-backed canonical fork and
   fresh-stack browser lifecycle.
4. Dependency audit and secret scan have no release-blocking findings.
5. A paid Production Robinhood RPC and hard provider quota are approved.
6. A fresh Safe v1.4.1 is configured with exactly three unique reviewed owners,
   threshold two, canonical singleton/factory/handler, zero guard, no modules,
   and nonce zero.
7. Deployment and canary signers use encrypted named keystores or
   hardware-backed signing. Private keys never appear in tracked files, shell
   arguments, logs, chat, or evidence.
8. The checkout is the exact reviewed SHA with no tracked drift, ordinary
   untracked files, ignored root environment file, inherited `FOUNDRY_*`, or
   legacy `DAPP_*` override.

## Reproducible contract identity

The isolated root is `contracts/zappad`. The release compiler identity is:

| Setting | Required value |
| --- | --- |
| Solidity | `0.8.28` |
| Optimizer | enabled, `1_000_000` runs |
| IR | enabled |
| EVM | Cancun |
| Bytecode hash | none |
| CBOR metadata | disabled |
| OpenZeppelin | `5.4.0`, submodule `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0` |
| forge-std | `v1.11.0`, submodule `8e40513d678f392f398620b3ef2b418648b33e89` |
| TickMath provenance | Uniswap v4-core `d153b048868a60c2403a3ef5b2301bb247884d46` |

Before any release review:

```bash
forge fmt --root contracts/zappad --check
forge build --root contracts/zappad --force --sizes
forge test --root contracts/zappad --no-match-path 'test/fork/*' -vv
ROBINHOOD_RPC_URL="https://paid-archive-rpc.example" \
  forge test --root contracts/zappad \
  --match-path 'test/fork/**' \
  --no-storage-caching -vv
```

A public gateway result can reproduce engineering evidence, but it does not
replace the dedicated archive RPC required for production sign-off.

## Evidence rules

Every approval input and output is immutable, uniquely named, credential-free,
and copied without overwrite to an audit directory outside the checkout.
Record Keccak-256 over the exact raw bytes, including the trailing newline.
Before each later step, compare the bounded Foundry bridge copy byte-for-byte
with the independently held audit copy.

Foundry must not receive arbitrary filesystem access. A manifest marked
`simulation-only` is a plan, never evidence that a transaction mined. Mutable
`run-latest.json` files are diagnostic inputs only; authoritative evidence is
rebuilt from finalized RPC receipts.

The complete evidence chain is:

1. reviewed Safe simulation manifest and independent approval hash;
2. finalized Safe deployment receipt verification;
3. reviewed stack simulation manifest and independent approval hash;
4. finalized stack receipt, exact initcode, source-verification, runtime, and
   readback verification;
5. reviewed canary plan tied to the stack and Safe evidence hashes;
6. finalized creator broadcast receipts;
7. prepared Safe claim manifest and read-only pre-sign evidence;
8. finalized Safe execution receipts;
9. final canary state and custody evidence;
10. read-only hosting identity and firewall evidence;
11. write-enabled hosting evidence from a fresh deployment.

No artifact may silently substitute for an earlier artifact.

## 1. Fresh Safe treasury

The Safe ceremony pins the canonical chain-4663 Safe v1.4.1 dependencies:

- proxy factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`;
- singleton `0x41675C099F32341bf84BFc5382aF534df5C7461a`;
- compatibility handler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`.

Use `script/DeploySafeTreasury.s.sol` only for a no-broadcast rehearsal until
the reviewed wrapper and receipt verifier exist in OpenZaps:

```bash
forge script --root contracts/zappad \
  script/DeploySafeTreasury.s.sol:DeploySafeTreasury \
  --rpc-url robinhood \
  --sender "0xReviewedDeployer" \
  -vvvv
```

Review owner order, all three unique owners, threshold two, salt, initializer,
CREATE2 address, dependency addresses and code hashes, and simulation block.
The initializer allows no module, guard, delegatecall, or setup payment.

Before the stack ceremony, finalized receipt evidence must prove exact factory
target and calldata, deployer, successful `ProxyCreation`, absence of code at
the predicted address in the preceding block, required confirmation depth,
canonical dependency hashes, Safe version, owners, threshold, handler, zero
guard, no modules, and nonce zero. An EOA is never a protocol-treasury
substitute.

## 2. Fresh ZapPad stack

`script/DeployZapPad.s.sol` verifies chain `4663`, canonical dependency runtime
hashes, WETH/USDG proxy implementations, the exact fresh Safe, release commit,
deployer nonce, and fresh predicted addresses before constructing:

1. `ZapPadBootstrap`;
2. `ZapTokenFactory`;
3. `ZapFeeVaultFactory`;
4. `ZapPadLaunchpad`.

Run a no-broadcast rehearsal from the exact checkout and review the generated
`zappad-stack-deployment-simulation` manifest. It must bind the release SHA,
deployer and nonce, bootstrap initcode hash, Safe evidence hash, treasury,
chain, canonical dependencies, `ZapPadLaunchConfig:v1`, all four predicted
addresses, and all runtime hashes.

The actual broadcast remains prohibited until the OpenZaps release wrapper
proves the clean SHA, forces a fresh compile, fixes the script target and RPC
alias, binds the encrypted account to the expected sender, and rejects raw
secrets, unlocked signing, compiler/remapping/profile overrides,
`--skip-simulation`, and `--resume`.

A partial broadcast is never resumed. Reconcile every receipt, invalidate the
plan, and begin a new manifest review with new nonce-derived addresses.

## 3. Explicit source and receipt verification

The signer sends only the top-level bootstrap creation; the bootstrap performs
the three internal creations. Verify all four contracts separately on
Robinhood Blockscout. Do not assume bootstrap verification discovers its
children.

Constructor order:

| Contract | Arguments |
| --- | --- |
| `ZapPadBootstrap` | treasury, position manager, swap router, WETH, USDG |
| `ZapPadLaunchpad` | treasury, token factory, fee-vault factory, position manager, swap router, WETH, USDG |
| `ZapTokenFactory` | none |
| `ZapFeeVaultFactory` | none |

The receipt verifier must force a clean rebuild, compare the complete mined
bootstrap initcode and constructor arguments, prove the receipt-created
address, minimum finality, release SHA, approved raw simulation hash, approved
Safe evidence hash, and stable verification block. At that one block it must
require:

- full source verification for all four contracts;
- bootstrap and factory bindings;
- canonical dependency and proxy implementation hashes;
- exact launchpad treasury/dependency readbacks;
- bytecode identity at the evidence-derived deploy block and current block.

Only this finalized artifact supplies:
`ZAPPAD_LAUNCHER_ADDRESS`,
`ZAPPAD_LAUNCHER_DEPLOY_BLOCK`, and
`ZAPPAD_LAUNCHER_CODE_HASH`.

The first canary-created `ZapToken` and `ZapFeeVault` instances must also be
source-verified from their exact event-derived constructor inputs.

## 4. Read-only Preview

Configure a new Preview from the exact Git SHA with the paid RPC and the three
evidence-derived launcher identity values. Keep
`ZAPPAD_LAUNCH_WRITES_ENABLED=false`.

For Production-equivalent read testing, first publish and review a separately
configured durable edge quota covering all three ZapPad API routes, then set
`ZAPPAD_RPC_RELAY_ENABLED=true` and
`ZAPPAD_RPC_DURABLE_QUOTA_ENABLED=true`. The second flag records the external
control; it does not create one. Without both, runtime reads and the relay must
remain fail closed even with a valid RPC URL.

Require:

- `/api/launch/health` is `200` with every identity probe true and writes false;
- `/api/launch/config` reports `readEnabled=true` and
  `launchEnabled=false`;
- the bounded relay serves canonical reads and rejects transaction broadcast,
  batches, cross-origin traffic, invalid methods, and excessive ranges;
- desktop and mobile launch, directory, token, portfolio, allowance-revoke,
  and degraded-state checks pass;
- no Production promotion occurs.

## 5. Low-value mainnet canary

The canonical canary uses WETH and six-decimal USDG and stays within `0.001
WETH` and `10 USDG` per protected leg. Every minimum output is independently
reviewed, no greater than the matching dry-run output, and no less than 95% of
it.

The exact sequential creator plan contains 30 calls and proves for both pairs:

- launch and atomic first buy;
- reverse swap and permissionless harvest;
- initial 80/20 fee-share distribution;
- transfer of ten shares from creator to the fresh Safe;
- second buy, reverse swap, and harvest;
- resulting 70/30 distribution;
- creator claims;
- exact allowance cleanup, balance conservation, and permanent LP custody.

Broadcast receipts must prove the reviewed order, sender, chain, nonce
continuity, calldata, native value, ratios, minimums, policy hash, two exact
`TokenLaunched` events, and required confirmation depth. If any call fails,
stop. A recovery path may submit only zero approvals to reviewed canonical
targets; it cannot transfer value or increase an allowance. A retry uses new
salts and an entirely new reviewed plan.

The read-only observer derives both tokens from the verified receipts, proves
70/30 shares and Safe claimables, and emits exact sequential Safe claim
transactions. Before either owner signs, an independent verifier rechecks the
stack, vaults, positions, claimables, Safe state and nonce at one block and
recomputes both EIP-712 Safe transaction hashes. Two owners compare and sign in
the Safe UI; no release script receives owner keys or bypasses the threshold.

After both Safe claims, receipt verification must match each outer Safe
transaction, decoded `execTransaction`, target, calldata, zero-value gas/refund
fields, prepared hash, and `ExecutionSuccess`. Final state must prove zero
claimables, expected Safe balance increases, 70/30 shares, conserved
accounting, locked NFTs, and zero approvals.

## 6. Production hosting and activation

Before creating a Production deployment, require:

- source verification for the Safe, stack, and first token/vault instances;
- finalized stack, creator, Safe-receipt, observer, and finalizer evidence;
- security and legal approvals for the exact OpenZaps SHA;
- a paid RPC hard quota;
- published, reviewed Vercel Firewall per-IP limits covering
  `/api/launch/rpc`, `/api/launch/config`, and `/api/launch/health`;
- no unpublished firewall draft.

Create Production through the connected Git integration at the exact reviewed
SHA, initially with writes false. The hosting verifier is read-only: it checks
the expected Vercel team/project, deployment SHA, aliases, launcher identity,
public endpoints, bounded RPC rejection, and active firewall. It must never
deploy, promote, publish, stage, discard, or mutate firewall state.

Only after a recorded final go/no-go may the server-only write switch become
`true`. That change requires a fresh Production deployment and a second hosting
artifact proving:

- health reports `launchWrites.requested=true` and
  `launchWrites.enabled=true`;
- config reports `readEnabled=true` and `launchEnabled=true`;
- every prior identity, firewall, domain, and exact-SHA condition still holds.

If any identity probe later fails, the app automatically fails closed. That
runtime response does not pause direct onchain calls; operators must disclose
the incident and review dependency drift before restoring the interface.
