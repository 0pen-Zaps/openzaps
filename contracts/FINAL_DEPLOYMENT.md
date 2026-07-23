# OpenZap — final deployment manifest

The single source of truth for deploying OpenZap on **Robinhood Chain (4663)** and **Base (8453)**: the
full contract inventory, what a user can actually build on each chain, the two structural rules that
decide almost everything, the v2 candidate's status, the live governance finding, and one ordered
runbook per chain.

One script drives every deployment described here:
[`script/DeployEverything.s.sol`](script/DeployEverything.s.sol). It is chain-aware — it reads
`block.chainid` and deploys the correct set for that chain — and it is **keyless**: it never reads,
writes, or requests a private key. The signer comes from the forge CLI (`--ledger` / `--trezor` /
`--account` / `--interactive`); `--sender` names the deployer; `GOVERNANCE` is an address, never a key.

> ## ⚠️ Status: NOTHING IN THIS DOCUMENT HAS BEEN BROADCAST
> Every address printed below is from a **simulation** against live chain state (`forge script`
> without `--broadcast`). No transaction has been sent, no key has been touched. The Robinhood core is
> live *from earlier work*; the additions here and the entire Base v1.1 set are code + dry runs only.

This document consolidates and does not contradict the two deeper references — read them for the full
argument behind any single claim:

- [`ROBINHOOD_EXPANSION.md`](ROBINHOOD_EXPANSION.md) — the Robinhood additions, the vault risk
  statement, and the per-branch dry-run record, in full.
- [`BASE_CAPABILITIES.md`](BASE_CAPABILITIES.md) — the complete 25-block capability matrix on both
  chains, each verdict grounded in a line of `OpenZap.sol`, an adapter, a fork test, or a `cast` read.

Live state in this document was read at **Robinhood block ~16,813,000** and **Base block ~48,986,000**.

---

## 1. The two structural rules of the v1.1 core

Read these first. Nineteen of the twenty-five capability verdicts are a consequence of one of them, and
they are the reason the adapter set looks the way it does. Both are in
[`src/OpenZap.sol`](src/OpenZap.sol) — `execute()` and `initialize()`; read them yourself.

### Rule 1 — settlement measures exactly ONE ERC-20

```solidity
uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));   // before the step loop
...                                                                   // <= 16 frozen steps
uint256 out = IERC20(intent.outAsset).balanceOf(address(this)) - preOut;  // underflow-reverts if no gain
intent.outAsset.safeTransfer(recipient, out);                        // unconditional
```

Consequences: a chain must end in a measured increase of exactly **one** allowlisted ERC-20; the gain
always leaves the capsule to the frozen `recipient` (there is no "keep it here"); every step must
consume a nonzero allowlisted ERC-20 and return a nonzero, allowlisted, non-zero-address ERC-20. Native
ETH can never be an `outAsset` (`TokenAllowlist` rejects `address(0)`), which is why Robinhood's 13,122
native-ETH pools are outside the expressible set.

### Rule 2 — a step's input amount is frozen at signing

`Step.amountIn` ([`src/libraries/OpenZapTypes.sol`](src/libraries/OpenZapTypes.sol)) is a constant
written into the policy at creation and covered by `policyHash`. **A step cannot consume "whatever the
previous step produced."** "Multi-step" means *a fixed sequence of fixed amounts*, not a pipeline. Any
step downstream of a swap at an unknown price will strand the surplus, recoverable only via the owner's
`emergencyExit`. This is the single biggest limit on multi-step chains, and a v2 core is the only thing
that lifts it (see §6).

---

## 2. The corrected Robinhood Chain ecosystem finding

**An earlier version of this repo claimed Robinhood Chain had "no LP venue beyond one pool" and that
multi-protocol zaps were "Base or nothing." That was wrong** — the mistake was probing chain 4663 for
*Base's* contract addresses. Measured directly from the Uniswap v4 PoolManager
`0x8366a39CC670B4001A1121B8F6A443A643e40951`:

| | Robinhood Chain 4663 |
| --- | --- |
| v4 pools ever initialized | **23,064** |
| Unique hooks in use | **532** |
| Deepest currencies | native ETH (13,122 pools), **USDG** (4,681), aeWETH (3,894), NVDA/TSLA/AAPL |

Infrastructure, all bytecode-verified: Universal Router `0x8876789976dEcBfCbBbe364623C63652db8C0904`,
Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, v4 PoolManager (above), v4 Quoter, CreateX,
Multicall3. What the chain genuinely does **not** have, at any address found: **no lending market, no
staking venue, no ERC-20 LP token** — no Aave/Morpho/Compound/Aerodrome-style AMM. That absence is why
`ZapVault` exists (a venue that takes one ERC-20 in and returns one ERC-20 out), and why several
capability rows are BLOCKED on Robinhood for a reason that has nothing to do with the core. See
`BASE_CAPABILITIES.md` §2 for the full most-paired-currency table.

---

## 3. Contract inventory

### 3a. Robinhood Chain (4663)

**Live already (from earlier work — read from chain, not deployed by this script):**

| Contract | Address | Status |
| --- | --- | --- |
| `OpenZapFactory` | `0xFC775017b25d2458623E2f3E735A4B750dD8b4E4` | live, `VERSION()` == `1.1.0` |
| `OpenZap` implementation | `0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A` | live |
| `AdapterRegistry` | `0x9E56e444f490C00A6277326A47Cb462E12dF1f17` | live |
| `TokenAllowlist` | `0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B` | live |
| `RobinhoodV4SwapAdapter` (aeWETH/0xZAPS, hardcoded pool) | `0x04f62dA4b51a010eFa32aa81569169C47AEd602C` | **live and allowlisted** |

**Added by `DeployEverything` on Robinhood (SHIPPED — code + tests, not broadcast):**

| Contract | Role | env var in `src/lib/chains.ts` |
| --- | --- | --- |
| `RobinhoodV4PoolAdapter` (aeWETH/USDG, fee 450, tick 9, hookless) | any-ERC-20-pool swap | `NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER` |
| `ZapVault` (`OpenZap USDG Vault` / `ozUSDG`) | one-in-one-out ERC-4626 wrapper | *(the share token, not an adapter)* |
| `ZapVaultDepositAdapter` | USDG → ozUSDG shares | `NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER` |
| `ZapVaultRedeemAdapter` | ozUSDG shares → USDG | `NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER` |

The pool default is the deepest **live** hookless aeWETH/USDG pool, id
`0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2` (liquidity read live before
broadcasting; the run aborts `DeadPool` on zero). Deep tokens: aeWETH
`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6dp).

> For any **other** Robinhood pool or vault asset than these proven defaults, use the fully
> parameterized [`script/DeployRobinhoodExpansion.s.sol`](script/DeployRobinhoodExpansion.s.sol).
> `DeployEverything` pins the canonical set on purpose so the two `chains.ts` rows (USDG / ozUSDG)
> cannot silently drift.

### 3b. Base (8453)

**No live v1.1 core exists on Base.** There is a superseded v1.0.0 factory at
`0xc7C5897e4738a157731c2F93b1d73Db9926E926C` — OpenZap has no upgrade path (I-ISO-2), so a new version
is always a new deployment. `DeployEverything` stands up a **fresh** v1.1 core:

| Contract | Role |
| --- | --- |
| `AdapterRegistry`, `TokenAllowlist`, `OpenZapFactory` (+ `OpenZap` impl via the factory ctor) | fresh v1.1 core |
| `BaseV3SwapAdapter` (WETH/USDC 0.05%, pool `0xd0b53D9277642d899DF5C87A3966A349A798F224`) | swap |
| `AaveV3SupplyAdapter` (WETH → aWETH `0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7`) | supply |
| `AaveV3WithdrawAdapter` (aWETH → WETH) | **withdraw — the supply leg's mirror** |

Protocol addresses (bytecode-verified in preflight): SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`
(its `factory()` asserted == `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`), Aave v3 Pool
`0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`, WETH `0x4200000000000000000000000000000000000006`, USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

**`AaveV3BorrowAdapter` is deliberately absent** — [`src/adapters/AaveV3BorrowAdapter.sol`](src/adapters/AaveV3BorrowAdapter.sol)
compiles to zero bytecode on purpose. A borrow leg cannot be expressed under `IAdapter` without handing
a shared adapter custody of collateral or bricking `emergencyExit`; the reasoning is fork-proven and
documented in that file and `BASE_CAPABILITIES.md` row 8.

`src/lib/chains.ts` is **Robinhood-only by design** (the builder's deploy handoff targets 4663), so
there are no Base frontend env vars to set from a Base run.

### 3c. v2 candidate (both chains, off by default) — see §5

| Contract | Status |
| --- | --- |
| `src/v2/OpenZapFactoryV2.sol` (`VERSION` `2.0.0-candidate`) | shipped, **UNAUDITED**, deployed only behind `DEPLOY_V2_CANDIDATE=true` |
| `src/v2/OpenZapV2.sol` | its implementation, deployed by the factory ctor |

---

## 4. Capability matrix — what a user can actually build now

Grounded in adapters that exist. For the exhaustive 25-block verdict table (every LIVE / SHIPPED /
POSSIBLE / BLOCKED with the exact reason) see `BASE_CAPABILITIES.md` §4; this is the deployment-level
summary of the routes each chain's **adapter set** admits.

### Robinhood Chain 4663

| Route | Status |
| --- | --- |
| `aeWETH ⇄ 0xZAPS` swap (Uniswap v4, hardcoded pool) | **LIVE** today — the one route the app signs |
| `aeWETH ⇄ USDG` swap (Uniswap v4, any-pool adapter) | SHIPPED — live after broadcast + allowlist |
| `USDG → ozUSDG` deposit (ZapVault) | SHIPPED — settles on the share token |
| `ozUSDG → USDG` redeem (ZapVault) | SHIPPED — only in a capsule **funded with shares** |

Two limits no adapter can fix, both from §1: a **deposit-then-redeem round trip in one capsule cannot
settle** (it nets to zero and underflow-reverts), and a redeem cannot be **sized to whatever a deposit
produced** (`Step.amountIn` is frozen). `stake` stays impossible — it needs an LP, and the vault takes
a plain token. `ZapVault` **earns nothing** (`totalAssets()` is `asset.balanceOf(vault)`); it is a
receipt wrapper, not a yield product, and the `supply` block's "interest accrues to the share" copy is
false for it and must be corrected before it is offered.

### Base 8453

| Route | Status |
| --- | --- |
| `WETH → USDC` swap (Uniswap v3, 0.05%) | SHIPPED (live after this run's broadcast) |
| `WETH → aWETH` supply (Aave v3) | SHIPPED — the capsule becomes the Aave account |
| `aWETH → WETH` withdraw (Aave v3) | SHIPPED — unwinds a supplied position, funded with the aToken |

The withdraw adapter is the mirror of supply: `tokenIn` = aWETH, `tokenOut` = WETH, both already
allowlisted by the supply leg, so it needs only a registry entry. Its deploy-time wiring (aToken
resolves to `0xD4a0…8bb7`, all getters) is asserted by this script against a live Base fork; its
execution-path fork tests are Track B's deliverable — consult that suite before treating the withdraw
route as execution-proven, exactly as `AaveV3SupplyAdapter` is proven by `test/AaveV3Adapters.fork.t.sol`.

One correction that applies to **both** chains and both `supply`/`deposit` routes: **the builder cannot
draw a supply chain yet.** `compileChain` in `src/lib/blocks.ts` matches shapes by strict equality;
`supply` emits `receipt`, the only shipped sink `send` accepts `token`, and the only block that accepts
`receipt` (`hold`) is BLOCKED. The contracts execute a `supply → send` chain fine; the product surface
rejects it. That is front-end / catalogue work, not a contract gap (`BASE_CAPABILITIES.md` §4b).

---

## 5. v2 candidate status

Track A shipped `src/v2/OpenZapFactoryV2.sol` (byte-for-byte the v1.1 deployment machinery pointed at
`OpenZapV2`, `VERSION` `2.0.0-candidate`). `DeployEverything` wires it behind an **off-by-default** flag:

- **Default (`DEPLOY_V2_CANDIDATE` unset/false):** nothing v2 is deployed. This is the production
  posture on both chains.
- **`DEPLOY_V2_CANDIDATE=true`:** the v2 factory is deployed to a fresh, isolated address, pointed at
  the run's registry/allowlist for **read-only** allowlist checks, and post-deploy-asserted (`VERSION`,
  wiring, implementation has code). The script prints a loud warning and does **none** of the
  following: hand it governance, create or fund a v2 zap, or point the frontend at it.

**It is UNAUDITED and MUST NOT custody funds without independent review.** Deploying the factory
custodies nothing — the risk is entirely in creating and funding v2 zaps, which this script never does.
It must not replace the live v1.1 factory.

---

## 6. Live governance finding (independent of this work, gates production)

Read live from Robinhood Chain:

```
AdapterRegistry.owner()        0xe17f5150A2954889988e63C49d41cc321c35B986   (EOA, no code)
AdapterRegistry.pendingOwner() 0x5a52D4B820Ae7F02880d270562950918ACb14aA2   (EOA, no code)
TokenAllowlist.owner()         0xe17f5150A2954889988e63C49d41cc321c35B986
TokenAllowlist.pendingOwner()  0x5a52D4B820Ae7F02880d270562950918ACb14aA2
```

- **The ownership handoff is proposed but NOT accepted.** `0x5a52D4B8…` has never called
  `acceptOwnership()` on either contract, so `0xe17f5150…` is still the kill-switch holder today, and
  is the address that must send every governance call in the Robinhood runbook.
- **Both addresses are EOAs, not Safes.** Both contracts' NatSpec assumes "a Safe multisig behind a
  TimelockController." A single EOA holding the kill switch for a live deployment is not a production
  posture. Close this independently of the adapter work.
- **USDG is NOT allowlisted** (`TokenAllowlist.isAllowed(USDG) == false`, read live). aeWETH and 0xZAPS
  are allowed. So any USDG-legged zap (the pool adapter, both vault adapters) needs `setToken(USDG,
  true)` before it can settle — real outstanding work, not a formality.

---

## 7. The script, and its dry-run evidence

`DeployEverything.s.sol` was simulated on both live chains, **no `--broadcast`**, across every branch.
Every claim below is from a run, not asserted.

| Branch (exactly as run) | Result | Est. gas |
| --- | --- | --- |
| Robinhood, deployer **not** owner, seeded (v2 off) | succeeds; prints 6 `[PENDING]` entries with raw calldata | **4,449,069** |
| Robinhood, deployer **is** owner, unseeded (`VAULT_SEED_ASSETS=0`, v2 off) | `DONE` — all 6 governance entries executed in-run | 4,489,576 |
| Robinhood, seeded, `DEPLOY_V2_CANDIDATE=true` | as above **plus** the v2 factory + impl, loud warning | 7,486,032 |
| Robinhood, deployer is owner, **default** seed | **aborts in preflight** `UnfundedSeed(USDG, 1e6, 0)` — 0xe17f5150 holds 0 USDG | — |
| Base, `GOVERNANCE` set, v2 off | fresh core + swap/supply/withdraw; proposes ownership | **6,484,479** |
| Base, `GOVERNANCE` unset, v2 off | warns `governance == deployer`; `pendingOwner == 0` asserted | 6,276,232 |
| Base, `GOVERNANCE` set, `DEPLOY_V2_CANDIDATE=true` | as above **plus** the v2 factory + impl, loud warning | 9,521,442 |
| Any other chain (e.g. Ethereum id 1) | **reverts** `UnsupportedChain(1)` | — |

The owner and not-owner Robinhood branches are exercised by different senders because the live owner
`0xe17f5150…` holds no USDG (so it cannot run the seeded path) and the USDG-holding sender used for the
seeded path is not the owner (so it prints `[PENDING]` rather than executing governance). Between them
both governance branches, the seed path, and its fail-closed default are covered; the CREATE addresses
differ per run only because they derive from the sender's nonce.

What the script refuses to do, proven above and by the preflights: run on an unsupported chain; run
against a Robinhood factory whose `VERSION()` ≠ `1.1.0` or that is not wired to the pinned
registry/allowlist; deploy the pool adapter for a mistyped (`UnexpectedPoolId`) or dead (`DeadPool`)
pool; deploy an unseeded vault unless `VAULT_SEED_ASSETS=0` is set explicitly; seed a vault the deployer
cannot fund (`UnfundedSeed`); or leave a half-wired deployment (every branch ends in assertions that
revert). Every external address is `_requireCode`-checked before use.

Environment (all optional): `GOVERNANCE`, `DEPLOY_V2_CANDIDATE` (default false), and — Robinhood only —
`VAULT_SEED_ASSETS` (default 1_000_000 = 1.000000 USDG) and `VAULT_SEED_RECIPIENT` (default `0x…dEaD`).

---

## 8. Runbook — Robinhood Chain (4663)

Adds to the live core. **Do not** run `DeployRobinhood.s.sol` (it stands up a new, disconnected core
and would orphan every capsule the live factory has produced).

```bash
cd contracts

# 0. Gates.
forge fmt --check
forge build --force

# 1. Prerequisites for the deployer <DEPLOYER>:
#    - gas (the full seeded run estimates ~0.00083 ETH at ~0.19 gwei),
#    - >= 1 USDG in <DEPLOYER> for the default seed (or set VAULT_SEED_ASSETS=0 to skip, and own the
#      grief risk the script warns about).

# 2. Dry run FIRST. No --broadcast: simulates and prints addresses, poolId, live liquidity, seed.
forge script script/DeployEverything.s.sol:DeployEverything \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender <DEPLOYER>
#    If the printed poolId, liquidity, or seed surprises you, STOP.

# 3. Broadcast. Signer from the CLI — a hardware wallet or keystore. Never a key on the command line.
forge script script/DeployEverything.s.sol:DeployEverything \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --sender <DEPLOYER> \
  --broadcast --ledger            # or --account <keystore>, --trezor, --interactive
#    Record the four printed addresses (pool adapter, vault, deposit adapter, redeem adapter).
```

### Governance — sent from the current `owner()` `0xe17f5150…`

If the deployer was not the owner, the script printed six `[PENDING]` calls with raw calldata. **All
six are required.** Skipping the share-token line leaves a deployment that looks complete and cannot
execute a single vault step (a deposit step reverts `InvalidAdapterResult`, a redeem step reverts
`TokenNotAllowed`).

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
REGISTRY=0x9E56e444f490C00A6277326A47Cb462E12dF1f17
ALLOWLIST=0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168

# AdapterRegistry owner:
cast send $REGISTRY  "setAdapter(address,bool)" <POOL_ADAPTER>    true --rpc-url $RPC --ledger --from <OWNER>
cast send $REGISTRY  "setAdapter(address,bool)" <DEPOSIT_ADAPTER> true --rpc-url $RPC --ledger --from <OWNER>
cast send $REGISTRY  "setAdapter(address,bool)" <REDEEM_ADAPTER>  true --rpc-url $RPC --ledger --from <OWNER>
# TokenAllowlist owner (aeWETH already allowed — do not re-send it):
cast send $ALLOWLIST "setToken(address,bool)"   $USDG            true --rpc-url $RPC --ledger --from <OWNER>  # pool currency1 / deposit tokenIn / redeem tokenOut
cast send $ALLOWLIST "setToken(address,bool)"   <VAULT>          true --rpc-url $RPC --ledger --from <OWNER>  # the SHARE TOKEN — required

# Verify (all must be true):
cast call $REGISTRY  "isAllowed(address)(bool)" <POOL_ADAPTER>    --rpc-url $RPC
cast call $REGISTRY  "isAllowed(address)(bool)" <DEPOSIT_ADAPTER> --rpc-url $RPC
cast call $REGISTRY  "isAllowed(address)(bool)" <REDEEM_ADAPTER>  --rpc-url $RPC
cast call $ALLOWLIST "isAllowed(address)(bool)" $USDG            --rpc-url $RPC
cast call $ALLOWLIST "isAllowed(address)(bool)" <VAULT>          --rpc-url $RPC
```

### Close the governance gap (independent, still required)

1. `0x5a52D4B820Ae7F02880d270562950918ACb14aA2` calls `acceptOwnership()` on **both** `0x9E56e444…`
   and `0x87fBb77a…`. Until then the handoff has not happened.
2. Move ownership to a Safe multisig behind a TimelockController.

### Frontend (`src/lib/chains.ts`) — set LAST, only after allowlisting

An unset or malformed value fails **closed** (the step reads as undeployed). As of PR #23 the catalogue
names USDG and the ZapVault venue and `chains.ts` carries the aeWETH/USDG pool and the deposit rows, so
setting these vars **is** the moment a swap-then-deposit chain becomes something the builder offers to
sign — set them only after the adapters are allowlisted and you accept the vault is unaudited (§4).
(The `DeployEverything.s.sol` console still prints an older "changes nothing" note; that line is stale,
kept byte-exact only because its function sits on `via_ir`'s stack-depth limit. This manifest is
authoritative.)

```
NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER=<POOL_ADAPTER>
NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER=<DEPOSIT_ADAPTER>
NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER=<REDEEM_ADAPTER>
```

---

## 9. Runbook — Base (8453)

Stands up a **fresh** v1.1 core. **Not idempotent** — run it exactly once; a second broadcast produces
a second, disconnected deployment. To add an adapter later, deploy it alone and have governance call
`setAdapter` — do not re-run this script.

```bash
cd contracts
forge fmt --check
forge build --force
forge test --fork-url https://mainnet.base.org     # confirm the Base fork suite is green

# 1. Dry run. GOVERNANCE is the Safe that will own registry+allowlist. It is an ADDRESS.
export GOVERNANCE=0xYourSafe
forge script script/DeployEverything.s.sol:DeployEverything \
  --fork-url https://mainnet.base.org \
  --sender 0xYourDeployer

# 2. Broadcast. Signer from the CLI — never a key in an env var or on the command line.
forge script script/DeployEverything.s.sol:DeployEverything \
  --rpc-url https://mainnet.base.org \
  --sender 0xYourDeployer \
  --ledger --broadcast --slow --verify --etherscan-api-key "$BASESCAN_API_KEY"
#    Record the printed addresses: registry, allowlist, factory, implementation, and the three adapters.
#    The superseded v1.0.0 factory 0xc7C5897e… must not be quoted anywhere as current.

# 3. Complete governance from the Safe, on BOTH contracts (two-step; until this lands the deployer is
#    still the kill-switch holder):
cast send <AdapterRegistry> "acceptOwnership()" --rpc-url https://mainnet.base.org   # from the Safe
cast send <TokenAllowlist>  "acceptOwnership()" --rpc-url https://mainnet.base.org   # from the Safe

# 4. Verify before pointing any money at it:
cast call <OpenZapFactory>  "VERSION()(string)"                        --rpc-url https://mainnet.base.org  # "1.1.0"
cast call <AdapterRegistry> "isAllowed(address)(bool)" <swapAdapter>     --rpc-url ...                     # true
cast call <AdapterRegistry> "isAllowed(address)(bool)" <supplyAdapter>   --rpc-url ...                     # true
cast call <AdapterRegistry> "isAllowed(address)(bool)" <withdrawAdapter> --rpc-url ...                     # true
cast call <AdapterRegistry> "owner()(address)"                          --rpc-url ...                      # the Safe
cast call <TokenAllowlist>  "owner()(address)"                          --rpc-url ...                      # the Safe
```

The Base adapters have no `src/lib/chains.ts` entry (that file targets 4663 only), so there is no
frontend env-var step for Base.

### v2 candidate (either chain, opt-in only)

Never in a production run. To stand up the unaudited v2 factory for isolated testing, add
`DEPLOY_V2_CANDIDATE=true` to the dry-run/broadcast command. Do not hand it governance, fund a v2 zap
through it, or point the frontend at it until it has been independently reviewed (§5).

---

## 10. What is NOT done

- **Nothing has been broadcast.** Every address and gas figure here is a simulation. No key was read,
  written, or requested at any point.
- **`ZapVault` is unaudited** and would custody real funds; it earns nothing. Allowlisting the deposit
  adapter is the moment that risk becomes other people's problem. See `ROBINHOOD_EXPANSION.md` §3 for
  the full risk statement, including the measured finding that every deep Robinhood asset is an
  upgradeable proxy whose controller can freeze or seize the vault's balance.
- **Robinhood governance is an EOA with an unaccepted handoff, and USDG is not allowlisted** (§6).
- **A swap-then-deposit chain is drawable now** (PR #23 added USDG + the ZapVault venue to the catalogue
  and the pool/deposit rows to `chains.ts`), but it maps to a 2-step policy and `/app` signs single-step
  capsules only — so the mapper refuses it with the honest reason rather than offering a Deploy button.
  The remaining gap is the signing console, not the contracts or the catalogue (§4).
- **The v2 core is unaudited** and is off by default; it must not custody funds without review (§5).
- **The `AaveV3WithdrawAdapter` execution path is verified by Track B's fork suite, not by this
  script** — this script proves only its deploy-time wiring. Confirm that suite is green before treating
  the Base withdraw route as execution-proven.
- **Tokenised-equity pools (NVDA/TSLA/AAPL) are untested** — the Robinhood pool adapter is
  pool-agnostic and should serve them, but "should" is not "measured" (`ROBINHOOD_EXPANSION.md` §2).
