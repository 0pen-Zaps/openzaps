# Base capability matrix

What the 25 blocks in `src/lib/blocks.ts` can and cannot do against the **v1.1 OpenZap core** on **Base
mainnet (8453)**. Every verdict below is grounded in a line of `src/OpenZap.sol`, an adapter that
exists in `src/adapters/`, or a fork test in `test/`. Nothing here is aspirational.

---

## 0. Why Base, and only Base

These chains cannot run on Robinhood Chain. Not "not yet" — there is nothing there to call.

Probed directly against `https://rpc.mainnet.chain.robinhood.com` (chain id **4663**), by asking the
node for the runtime bytecode at each address:

| Contract (canonical address) | Robinhood Chain 4663 | Base 8453 |
| --- | --- | --- |
| Aave v3 Pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | **no code** | code (POOL_REVISION 11) |
| Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | **no code** | code (31 KB) |
| Compound v3 USDC `0xb125E6687d4313864e53df431d5425969c15Eb2F` | **no code** | code (3.7 KB) |
| Uniswap v3 Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | **no code** | code |
| Uniswap SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481` | **no code** | code |
| Uniswap v4 PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b` | not probed | code (48 KB) |
| Aerodrome Router `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | **no code** | code (47 KB) |
| Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` | code | code |
| Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` | code | code |

Robinhood Chain has Permit2, Multicall3, CreateX and one Uniswap-v4 pool (aeWETH/0xZAPS, which
`RobinhoodV4SwapAdapter` is welded to). It has **no lending market, no LP venue beyond that one pool,
and no bridge**. A "supply", "borrow", "add liquidity" or "stake" block has no counterparty there at
any price. Every multi-protocol chain in the builder is a Base chain or it is nothing.

---

## 1. The rule everything else follows from

`OpenZap.execute()` (`src/OpenZap.sol`):

```solidity
uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));   // line 190, before the loop
...                                                                   // ≤16 frozen steps
uint256 out = IERC20(intent.outAsset).balanceOf(address(this)) - preOut;  // line 208, underflows if no gain
...
intent.outAsset.safeTransfer(recipient, out);                         // line 219, unconditional
```

Four consequences, and almost every BLOCKED row below is one of them:

1. **A chain must end in a measured increase of exactly ONE ERC-20.** Line 208 subtracts, so a chain
   that does not increase `outAsset` reverts with an arithmetic panic. One asset, not two, not zero.
2. **The gain always leaves the capsule.** Line 219 transfers it to the policy's frozen `recipient`.
   There is no "keep it here" branch.
3. **Every step consumes a nonzero amount of an allowlisted ERC-20.** `initialize` rejects
   `amountIn == 0` (line 148, `InvalidStep`) and `tokenIn == address(0)` (line 147,
   `NativeTokenUnsupported`); `execute` approves exactly `amountIn` to the adapter before calling it
   (line 199). A step that consumes nothing is not expressible.
4. **Every step must return a nonzero, allowlisted, non-zero-address ERC-20.** Line 202,
   `InvalidAdapterResult`, checked unconditionally on every step's return.

Plus: one `execute()` is a single linear pass over the frozen steps. There is no loop back to step 0,
and each run needs a fresh owner-signed intent with an unused nonce.

---

## 2. Verdict key

| Verdict | Meaning |
| --- | --- |
| **SHIPPED** | Works on Base today with code in this repo. `script/DeployBase.s.sol` deploys it. |
| **POSSIBLE** | Base has the protocol and the settlement model admits it. The adapter is not written. |
| **BLOCKED** | Cannot work under the v1.1 core. The reason is stated exactly and is not a matter of effort. |

Adapters that exist right now: `BaseV3SwapAdapter` (Uniswap v3, one pool) and `AaveV3SupplyAdapter`
(Aave v3, one reserve). `AaveV3BorrowAdapter.sol` deliberately compiles to nothing.

---

## 3. The matrix

### Sources

| # | Block (`id`) | Verdict | Why |
| --- | --- | --- | --- |
| 1 | Wallet balance (`wallet-balance`) | **SHIPPED** | The amount is frozen into the policy (`Step.amountIn`) and bound into `policyHash`, so no executor can draw more. One correction to the block copy: v1.1 never pulls from the owner's wallet. There is no `transferFrom(owner, …)` anywhere in `OpenZap.sol`. The owner funds the capsule by transferring tokens to it (predict-then-fund via `factory.predict`), and steps spend the capsule's own balance. |
| 2 | Recurring deposit (`recurring-stream`) | **SHIPPED** | A capsule executes many times: one owner-signed intent per run, each with a fresh nonce (`nonceUsed`). The money movement is real today. **The cadence is not.** The policy has no schedule field, so "weekly" lives entirely in the off-chain trigger, and the capsule must be re-funded before each run. Nothing on-chain stops a run from happening early, late, or a hundred times — only the per-run `amountIn` is bounded. |
| 3 | Pending rewards (`pending-rewards`) | **BLOCKED** | Consequence 3. A step that starts from "whatever has accrued" consumes no token, and `initialize` rejects `amountIn == 0`. It also emits the `yield` shape, whose only consumer (`harvest`) is blocked for the same reason. |

### Actions

| # | Block (`id`) | Verdict | Why |
| --- | --- | --- | --- |
| 4 | Swap (`swap`) | **SHIPPED** | `BaseV3SwapAdapter`, exact-input single-hop, welded to WETH/USDC 0.05% (`0xd0b53D9277642d899DF5C87A3966A349A798F224`). 13 fork tests at a pinned Base block. Scope: **one instance == one pool**. Another pair or fee tier is another deployment of the same contract (no new code). The other two venues in the dropdown are POSSIBLE, not shipped: Uniswap v4 (PoolManager has code on Base — needs an unlock/settle adapter) and Aerodrome (Router has code on Base). A multi-hop route is two steps and two adapters, and every hop must land as an ERC-20 the capsule actually holds. |
| 5 | Split (`split`) | **BLOCKED** | Consequence 1. Settlement measures exactly one `intent.outAsset`. A 2–4 leg fan-out can settle at most one leg; the others accumulate in the capsule, invisible to `minOut`, recoverable only through `emergencyExit`. The signed slippage floor would cover one leg and silently not the rest. This needs multi-asset settlement in a v2 core, not an adapter. |
| 6 | Bridge (`bridge`) | **BLOCKED** | Consequence 1, plus asynchrony. The output lands on another chain, so the capsule's `outAsset` balance does not rise, `out = balanceOf - preOut` underflows and the whole chain reverts. Even if it were tolerated, arrival is a later event on a different chain that a single `execute()` cannot observe or bound. (Picking "Robinhood Chain" as the destination is doubly futile — see §0.) |
| 7 | Supply (`supply`) | **SHIPPED** | `AaveV3SupplyAdapter`, welded to the Aave v3 Pool `0xA238Dd80…d1c5` and one reserve. `script/DeployBase.s.sol` deploys the WETH instance and allowlists its aToken `0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7`. `onBehalfOf` is always `msg.sender`, so the **capsule** is the Aave account and holds the aToken; the adapter returns the *measured* aToken delta. Scope: one adapter per reserve. The two other markets in the dropdown are POSSIBLE (Morpho Blue and Compound v3 USDC both have code on Base). Caveat, inherent to Aave: aTokens rebase, so the measured delta is principal plus interest accrued in the same transaction; never assume `amountOut == amountIn`. |
| 8 | Borrow (`borrow`) | **BLOCKED** | Three independent blockers, all fork-proven in `test/AaveV3Adapters.fork.t.sol`. (a) Aave requires `borrowAllowance[capsule][adapter]`, settable only by `approveDelegation` called by the debtor. OpenZap's entire outbound surface is: `isAllowed`/`balanceOf` staticcalls, `approve(spender==adapter)`, `IAdapter.execute`, `transfer`, an ERC-1271 staticcall, and an empty-calldata native send to the owner. There is no delegatecall, no arbitrary target, no arbitrary calldata — a capsule can never emit `approveDelegation`, and the one smuggling route (pointing a step's `tokenIn` at the variable-debt token) dies inside Aave, whose debt tokens revert `OperationNotSupported()` on the whole approval surface. (b) The escape hatch — adapter borrows as itself — makes one registry-shared adapter the Aave account for every capsule, so one user's borrow is secured by another's collateral, and it puts the position beyond `emergencyExit` (breaking I-REC-1). (c) A debt leg has no accounting counterpart: balance-delta settlement can see the borrowed asset arriving but not the liability opened against it, and once a capsule carries debt, `emergencyExit` **reverts** on the collateral leg (health factor would fall below 1). A borrow needs liability-aware v2 settlement. |
| 9 | Draw to wallet (`draw-debt`) | **BLOCKED** | It consumes the `debt` shape, which nothing on Base can produce under this core (row 8). Independently, a "realise the loan" step consumes no token of its own — consequence 3. |
| 10 | Add liquidity (`add-liquidity`) | **BLOCKED** | As drawn, this is a *ranged* position: Uniswap v3 mints an ERC-721 and Uniswap v4 records a position inside the PoolManager. Neither is an ERC-20, so `IERC20(outAsset).balanceOf` cannot measure it, `TokenAllowlist.setToken` cannot admit it (v1 admits vetted ERC-20s only), and line 202 rejects the step's return. Second, independent blocker: a step carries exactly one `(tokenIn, amountIn)`, so two-sided provisioning cannot be expressed at all without an adapter that swaps internally. What *would* be possible is a different block: a single-sided deposit into an Aerodrome vAMM pool, whose LP token is a real ERC-20 (`vAMM-WETH/USDC` at `0xcDAC0d6c6C59727a65F871236188350531885C43`, verified `symbol()`/`totalSupply()`). That block has no range parameter, so it is not this one. |
| 11 | Remove liquidity (`remove-liquidity`) | **POSSIBLE** | Only for an ERC-20 LP token (Aerodrome-style), which the capsule can hold and a step can consume. **Read this caveat before building it:** burning an LP returns *both* sides, and settlement measures one. The second asset lands in the capsule, is not covered by `minOut`, is not sent to the recipient, and comes back only through `emergencyExit`. For a Uniswap v3/v4 ERC-721 position this row is BLOCKED for the same reason as row 10. |
| 12 | Stake position (`stake`) | **BLOCKED** | An Aerodrome gauge deposit is not a token. Probed live: the WETH/USDC gauge `0x519BBD1Dd8C6A94C46080E24f316c14Ee758C025` answers `totalSupply()` but **reverts on `symbol()` and on `transfer()`** — it is an internal ledger, not a transferable ERC-20. As the last step it therefore produces no measurable, transferable gain and settlement reverts; mid-chain it leads only to `accrue`/`harvest`, which are blocked in their own right. Wrapping it in an allowlisted pseudo-token would be a fake gain, which is exactly what line 202 and line 208 exist to refuse. |
| 13 | Accrue rewards (`accrue`) | **BLOCKED** | The block's own detail text says it: "a no-op onchain". A no-op cannot be a step — `initialize` requires `amountIn != 0` and `execute` requires a nonzero allowlisted `tokenOut` from every step. Waiting is not a transaction. It can only ever be an annotation on the canvas. |
| 14 | Harvest (`harvest`) | **BLOCKED** | Consequence 3 again, and it is the sharpest case: a claim consumes nothing, so there is no legal `(tokenIn, amountIn)` for the step. Passing a dust amount of the reward token to satisfy the check would be manufacturing the shape of a step that is not one, and it is not done here. Compounding the problem, the positions that accrue rewards on Base are gauge stakes (row 12) and v3/v4 LPs (row 10), neither of which a capsule can hold. The claim *mechanics* fit the model perfectly — claim to `msg.sender`, return the measured delta — so this becomes POSSIBLE the moment a v2 core admits a zero-input step. |
| 15 | Wrap / unwrap (`unwrap`) | **BLOCKED** | Both directions, proven on a Base fork in `test/WethWrapAdapter.fork.t.sol` (10 tests). **Wrap:** `initialize` rejects `tokenIn == address(0)` (`NativeTokenUnsupported`, line 147) and `IAdapter.execute` is non-payable and called with no `{value:}` — the only `call{value:}` in the entire core is `emergencyExit` → owner, so no ETH can ever reach an adapter. **Unwrap:** the honest return is `(address(0), amount)`, which line 202 rejects before settlement is reached; and settlement fails independently because unwrapping makes the capsule's WETH balance *fall*, so line 208 underflows (`panic 0x11`, captured in the test's trace). Native ETH can also never be `intent.outAsset`: `TokenAllowlist.setToken(address(0), true)` reverts `ZeroAddress`. A capsule *can* receive ETH (`receive()`, line 331) and `emergencyExit` drains it — **ETH in a capsule is recoverable, never routable.** The front end must keep wrapping in the user's own wallet before funding (`src/app/app/page.tsx:613`). |

### Guards

| # | Block (`id`) | Verdict | Why |
| --- | --- | --- | --- |
| 16 | Slippage cap (`guard-slippage`) | **SHIPPED** | Two enforcement points, both real. `intent.minOut` is checked **net of the relayer fee** at settlement (lines 210–218, `MinOutNotMet`), and `BaseV3SwapAdapter` carries its own `amountOutMinimum` in the step's 32-byte `data`, re-checked against the *measured* delta rather than the router's return value. A zero floor is refused by the adapter (`ZeroMinimumOut`). |
| 17 | Spend ceiling (`guard-spend`) | **BLOCKED** | There is no cumulative counter anywhere in the capsule's storage. The only bound a deployed capsule carries is the single `amountIn` per step, per run, and a funded capsule can be executed again with a fresh nonce indefinitely. A lifetime cap needs new state and a new check in a v2 core. The UI already says this; it is true. |
| 18 | Price band (`guard-oracle`) | **BLOCKED** | The core has no precondition surface — no oracle read, no non-adapter call, nothing between signature verification and the step loop. The only way to get a band today is to weld a price feed *inside* a specific adapter, which makes it a property of that one adapter rather than a guard you can drop onto a chain. |
| 19 | Time window (`guard-window`) | **BLOCKED** as drawn | The policy has no expiry and no cadence field, so a deployed capsule stays executable until the owner drains or revokes it. What does exist, and is enforced (lines 177–178), is a **per-intent** window: every signed intent carries `validAfter` and `deadline`, and `invalidateNonce` (line 249) lets the owner kill a held intent. So a *run* can be time-boxed by the signature; the *capsule* cannot be time-boxed by the policy. |
| 20 | Human gate (`guard-approval`) | **SHIPPED** | The block's copy is more pessimistic than the contract. Every single execution requires an owner EIP-712 signature over that exact intent — zap, chain id, nonce, deadline, recipient, relayer, fee cap, gas caps, `policyHash`, `outAsset`, `minOut` — verified at line 186 before any external call, with ERC-1271 support so the owner can be a Safe. The relayer has zero discretion. The one honest limit: nothing forces the signature to be *recent*; an owner can pre-sign a batch of nonces, and only `invalidateNonce` takes them back. |
| 21 | Private submission (`guard-private`) | **BLOCKED** | `execute` is permissionless by design: anyone holding a valid owner-signed intent can submit it. `intent.relayer` only names who receives the fee, not who may submit. Which mempool the transaction traverses is a property of the submitter, and the capsule cannot observe or bind it. |

### Sinks

| # | Block (`id`) | Verdict | Why |
| --- | --- | --- | --- |
| 22 | Send to recipient (`send`) | **SHIPPED** | This *is* v1.1 settlement. `recipient` is frozen in the policy, bound into `policyHash` and into the CREATE2 salt, and re-checked against the intent (`WrongRecipient`). Changing it is a new policy, a new address and a new signature — never a config edit. |
| 23 | Hold in zap (`hold`) | **BLOCKED** | Consequence 2. Line 219 transfers the measured gain to `recipient` unconditionally; there is no branch that leaves it in the capsule. Making the capsule its own recipient is not a workaround, it is a fixed point: the clone's address is `CREATE2(keccak256(abi.encode(policy, salt)))` and `recipient` is *inside* that policy, so the address you would need to name depends on naming it. What the capsule really offers is custody-by-owner: whatever the chain does not settle stays put and comes out through `emergencyExit`. That is a recovery path, not a sink. |
| 24 | Hold position (`hold-lp`) | **BLOCKED** | Row 23's blocker, plus row 10's: a v3/v4 position is an ERC-721 the settlement path cannot measure, allowlist, or transfer. Both reasons are independently fatal. |
| 25 | Loop back (`loop`) | **BLOCKED** | One `execute()` is a single linear pass over ≤16 frozen steps (`MAX_STEPS`). There is no jump back to step 0 and no re-entry — the `nonReentrant` guard forbids it outright. Compounding across runs means N separate transactions, each with its own owner-signed intent and fresh nonce, which is an off-chain schedule and not a block the capsule can enforce. And there is no cumulative budget to bound it (row 17), which is precisely why "max loops = 4" cannot be honoured on-chain. |

---

## 4. Scoreboard

| Verdict | Count | Blocks |
| --- | --- | --- |
| SHIPPED | 7 | `wallet-balance`, `recurring-stream`, `swap`, `supply`, `guard-slippage`, `guard-approval`, `send` |
| POSSIBLE | 1 | `remove-liquidity` (ERC-20 LP only, with one asset stranded) |
| BLOCKED | 17 | `pending-rewards`, `split`, `bridge`, `borrow`, `draw-debt`, `add-liquidity`, `stake`, `accrue`, `harvest`, `unwrap`, `guard-spend`, `guard-oracle`, `guard-window`, `guard-private`, `hold`, `hold-lp`, `loop` |

The one chain that is fully deployable today, end to end, on Base:

```
wallet balance (WETH) → swap (Uniswap v3, WETH→USDC, 0.05%) → slippage cap → human gate → send
wallet balance (WETH) → supply (Aave v3 WETH) → slippage cap → human gate → send   [settles the aToken]
```

Both are two-adapter-deep at most, and both end in a single ERC-20 gain that leaves for a frozen
recipient. Everything else in the catalogue is either a second deployment of an adapter that already
exists (a different pool, a different reserve), a POSSIBLE adapter someone still has to write, or a
BLOCKED row above that needs a different core — not a cleverer adapter.

## 5. What a v2 core would have to add

Listed once, so the BLOCKED rows above do not have to repeat it:

1. **Multi-asset settlement** — measure and settle a set of `(asset, minOut)` pairs instead of one.
   Unblocks `split`, and de-fangs `remove-liquidity`.
2. **Native-ETH settlement** — a payable adapter interface (or value-forwarding steps), a sentinel
   that survives the `adapterOut != address(0)` check, and settlement on `address(this).balance`
   deltas. Unblocks `unwrap`. `HonestUnwrapProbe` in `test/WethWrapAdapter.fork.t.sol` is the proven
   mechanism, and lives in the test tree marked not-an-adapter.
3. **Zero-input steps** — a step that consumes nothing but must still return a measured gain.
   Unblocks `harvest`, `accrue` and `pending-rewards`.
4. **Non-ERC-20 positions** — ERC-721 custody and a way to assert on a position instead of a balance.
   Unblocks `add-liquidity`, `hold-lp`, and the concentrated half of `remove-liquidity`.
5. **Liability-aware settlement plus a policy-frozen non-adapter call** (so a capsule can emit
   `approveDelegation` without gaining an arbitrary-call surface), and a recovery path that repays
   debt before withdrawing collateral. Unblocks `borrow` and `draw-debt`.
6. **Persistent per-capsule state** — a cumulative spend counter, a cadence, an expiry.
   Unblocks `guard-spend`, `guard-window` and the bound on `loop`.
7. **A settle-in-place option** — an outcome that leaves the gain in the capsule instead of
   transferring it. Unblocks `hold`.

None of these is reachable by writing another adapter, which is the whole point of listing them
separately.

---

## 6. Deployer runbook (Base mainnet)

Nothing in this repo broadcasts anything, and no key is read, written or requested anywhere in it.
The owner runs these, in this order, with their own signer.

```bash
cd contracts

# 0. Gates. Both must be clean before anything else.
forge fmt --check
forge build --force
forge test                                        # 96 passed, 2 skipped (opt-in Robinhood suites)
forge test --fork-url https://mainnet.base.org    # 96 passed, 2 skipped

# 1. Dry run. No --broadcast: this only simulates and prints the addresses and gas.
#    GOVERNANCE is the Safe that will own the registry and the allowlist. It is an ADDRESS.
export GOVERNANCE=0xYourSafe
forge script script/DeployBase.s.sol \
  --fork-url https://mainnet.base.org \
  --sender 0xYourDeployerAddress

# 2. Broadcast. The signer comes from the CLI — a hardware wallet or a keystore account.
#    Never a private key on the command line, in a file, or in an env var.
forge script script/DeployBase.s.sol \
  --rpc-url https://mainnet.base.org \
  --sender 0xYourDeployerAddress \
  --ledger \
  --broadcast --slow --verify --etherscan-api-key "$BASESCAN_API_KEY"
#    (--account <keystore-name> --interactive instead of --ledger if using an encrypted keystore)

# 3. Record the five addresses the script prints. They are the deployment.
#    The pre-existing v1.0.0 factory 0xc7C5897e4738a157731c2F93b1d73Db9926E926C is superseded and
#    must not be quoted anywhere as current.

# 4. Complete governance. From the Safe, on BOTH contracts — the transfer is two-step and until this
#    lands the deployer is still the kill-switch holder:
cast send <AdapterRegistry> "acceptOwnership()" --rpc-url ... # from the Safe
cast send <TokenAllowlist>  "acceptOwnership()" --rpc-url ... # from the Safe

# 5. Verify the live wiring before pointing any money at it.
cast call <OpenZapFactory> "VERSION()(string)"        --rpc-url https://mainnet.base.org  # "1.1.0"
cast call <AdapterRegistry> "isAllowed(address)(bool)" <swapAdapter>   --rpc-url ...      # true
cast call <AdapterRegistry> "isAllowed(address)(bool)" <supplyAdapter> --rpc-url ...      # true
cast call <AdapterRegistry> "owner()(address)"        --rpc-url ...                       # the Safe
cast call <TokenAllowlist>  "owner()(address)"        --rpc-url ...                       # the Safe

# 6. Point the front end at the new factory, and only then fund a capsule.
```

To add an adapter later (another pool, another Aave reserve): deploy that adapter alone and have
governance call `AdapterRegistry.setAdapter(adapter, true)` plus `TokenAllowlist.setToken(...)` for
anything new it returns. Do **not** re-run `DeployBase.s.sol` — it is not idempotent and would stand
up a second, disconnected deployment.
