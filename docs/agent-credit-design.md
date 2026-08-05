# OpenZaps Agent Credit Lane

Status: research specification, not deployed  
Last reviewed: 29 July 2026  
Target network: Robinhood Chain mainnet (`4663`)  
Proposed loan asset: canonical USDG  
Proposed collateral: externally supplied `0xZAPS`

## 1. Executive decision

OpenZaps should not begin by issuing a new stablecoin. It should build and validate three separable systems:

1. **Agent Access Pools** — Uniswap v4 liquidity available only to registered, policy-constrained agent accounts.
2. **Agent Credit Vaults** — isolated, overcollateralized USDG working-capital lines backed by externally supplied `0xZAPS`.
3. **Agent Credit Markets** — later sponsor-backed lines where underwriters post first-loss capital against proven repayment history.

The first loan asset should be canonical USDG. Robinhood Chain already lists USDG, Uniswap, Morpho, and Chainlink in its official ecosystem, and Robinhood Earn already uses USDG as a Morpho lending asset. Issuing a second dollar token would add reserve, redemption, peg, legal, liquidation, and shutdown systems before the credit model has been proven.

The refined product claim is:

> OpenZaps gives registered, policy-constrained agent accounts bounded USDG working capital for pre-committed onchain strategies. Borrowed funds never become a general wallet balance, financed assets never create recursive borrowing power, and repayment and liquidation remain open without agent eligibility.

This document does not describe a live contract, lending product, stablecoin, promise of yield, or release commitment.

## 2. Current protocol truth

The following foundations exist today:

- Robinhood Chain mainnet is live at chain ID `4663`.
- Canonical USDG is deployed at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` and uses six decimals.
- Uniswap publishes v4 deployments for Robinhood Chain.
- OpenZaps has bounded routes across pinned `0xZAPS`, aeWETH, and USDG pools.
- OpenZaps has an owner-signed executor-address connection, but that is not an identity or credit registry.
- The current `ozUSDG` vault is a receipt wrapper. It is not a lending venue and does not generate yield.
- The current full-range LP vault refuses hooked pools.
- The current v4 adapters send empty `hookData`.
- The intentionally disabled Aave borrow adapter documents why debt needs a separate liability-aware subsystem.

The following do not exist as deployed OpenZaps systems:

- ERC-8004-compatible identity adapter.
- Canonical agent credit accounts.
- Agent router and action permits.
- Agent-gated Uniswap v4 hook or position manager.
- USDG lender vault.
- Credit controller, debt accounting, or interest-rate model.
- Independent `0xZAPS` collateral oracle.
- Permissionless liquidation engine or safety reserve.

Any interface must keep those states visually and semantically separate.

## 3. Product boundaries

### 3.1 Agent access is not credit analysis

An ERC-8004-compatible registry can establish that:

- an agent identity currently exists;
- a wallet is currently bound to that identity;
- the wallet can sign one exact action;
- reputation or validation records exist.

It cannot establish that:

- the software is autonomous;
- the same human does not control many identities;
- advertised capabilities are genuine;
- the account will repay;
- the controller is not also the counterparty to a trade.

Agent identity therefore controls **eligibility to request an action**. Collateral, debt caps, first-loss capital, and realized repayment history control **credit risk**.

### 3.2 Purpose-bound credit is not a stablecoin

USDG is an ordinary external stablecoin. The restriction is enforced by the borrowing account and execution adapters:

- borrowed USDG goes directly to `AgentCreditAccount`;
- it can enter only approved atomic methods;
- every output returns to the indebted account;
- the account cannot send borrowed proceeds to an arbitrary address.

A new token that can only buy `0xZAPS` or enter one pool would be closed-loop protocol credit. It would not, by itself, be a credible general-purpose stablecoin.

### 3.3 “Registered agent accounts” is the accurate claim

The system can verify a registry entry, wallet binding, bytecode, action signature, collateral, debt, and onchain behavior. It cannot prove that only software controlled the wallet. Public copy should say:

> Liquidity restricted to registered, policy-constrained agent accounts.

It should not say:

> Only AI can use this pool.

## 4. System architecture

```text
Principal / Safe
  │ owns collateral, recovery, debt, and delegation
  ▼
AgentCreditAccountFactory
  │ deploys canonical policy account
  ▼
AgentCreditAccount
  ├─ external 0xZAPS collateral
  ├─ USDG debt
  ├─ locked purchased 0xZAPS
  ├─ locked LP position
  └─ bounded agent session key
  │
  ├──────── signed typed action ────────┐
  ▼                                     ▼
AgentRouter                       CreditController
  │ verifies identity, nonce,       ├─ origination limits
  │ deadline, policy, receiver      ├─ debt + interest
  ▼                                 ├─ health + caps
AgentGateHook                      └─ liquidation state
  │                                      ▲
  ▼                                      │
Uniswap v4 agent lane              USDGLenderVault
                                         │
                                  lender USDG shares

RiskOracle ─────────────► CreditController ◄──────────── LiquidationEngine
```

### 4.1 `IAgentIdentityAdapter`

The identity adapter decouples the credit system from a changing identity standard or deployment.

```solidity
interface IAgentIdentityAdapter {
    function isEligible(
        uint256 agentId,
        address account,
        bytes32 qualificationPolicy
    ) external view returns (bool);

    function currentAgentWallet(uint256 agentId)
        external
        view
        returns (address);
}
```

Required behavior:

- pin one approved registry deployment per adapter version;
- check the current wallet binding on every risk-increasing action;
- fail closed on a missing, transferred, cleared, expired, or revoked identity;
- optionally require approved validation or attestation policy;
- never treat raw reputation as collateral or a guarantee;
- never cache eligibility across transactions.

### 4.2 `AgentCreditAccount`

One canonical account is deployed per principal and agent relationship.

Authorities remain separate:

- **Principal:** immutable owner or Safe controlling collateral withdrawal, recovery, delegation, and repayment.
- **Agent executor:** revocable session key able to request only typed strategy actions.

An identity transfer or wallet revocation freezes new borrowing and strategy execution. It does not transfer:

- account ownership;
- collateral;
- debt;
- lender claims.

Repayment, collateral top-ups, liquidation, and bounded unwind remain callable.

### 4.3 `AgentRouter`

The router validates a one-use action before it reaches PoolManager.

Every EIP-712 action binds at least:

```text
agentId
agentCreditAccount
creditPositionId
actionKind
poolId
inputAsset
maxInput
minOutput or minLiquidity
maxPriceImpact
approvedTickLower and tickUpper
recipient = agentCreditAccount
policyHash
nonce
deadline
chainId
verifyingRouter
```

Smart accounts use ERC-1271. Approved EOAs may use ECDSA. Validation and execution occur in the same transaction because contract signatures and delegations can change with account state.

The router rejects:

- expired or replayed nonces;
- wrong chain, router, pool, account, or recipient;
- unsupported action kinds;
- an identity no longer bound to the account;
- a policy account not deployed by the approved factory;
- calldata containing an arbitrary target, spender, recipient, callback, or route.

### 4.4 `AgentGateHook`

A v4 hook must not assume its callback `sender` is the ultimate agent.

The actual path is normally:

```text
agent → AgentRouter → PoolManager → AgentGateHook
```

Inside the hook:

- `msg.sender` is PoolManager;
- the callback `sender` is normally AgentRouter;
- agent identity comes from an authorization already verified by AgentRouter, not from `sender`.

The hook should:

- accept only the approved AgentRouter or position manager;
- require the exact pool and action digest;
- consume a single-use authorization in the same transaction;
- reject direct PoolManager calls, stale authorizations, and mismatches;
- gate swaps and risk-increasing liquidity additions;
- allow a dedicated liquidation and unwind adapter;
- avoid removal callbacks in the first version so a hook failure cannot strand LPs;
- use a fixed fee in the first version.

Uniswap Permissioned Pools are the closest implementation precedent: approved wrappers, router and hook checks, non-transferable position NFTs, and explicit unwind behavior.

### 4.5 `CreditController`

The controller is a separate liability system. Lending, identity, oracle, rewards, and AMM accounting do not belong in one hook.

It accounts for:

- externally supplied eligible collateral;
- locked strategy recovery assets;
- USDG debt and accrued interest;
- per-agent debt cap;
- global debt ceiling;
- market utilization;
- borrow and liquidation LTV;
- account health;
- new-borrow pause state;
- liquidations and bad debt.

### 4.6 `USDGLenderVault`

The lender vault should use ERC-4626-style single-asset shares with:

- USDG as the only underlying asset;
- virtual shares/assets or equivalent first-deposit protection;
- explicit supply and utilization caps;
- an idle liquidity reserve;
- a utilization-based interest-rate model;
- a reserve factor and funded first-loss reserve;
- withdrawal-liquidity monitoring;
- preview and rounding behavior consistent with ERC-4626;
- transparent bad-debt and reserve accounting.

Lenders bear smart-contract, oracle, collateral, liquidity, stablecoin, and bad-debt risk. A vault share is not a guaranteed dollar claim or insured deposit.

### 4.7 `RiskOracle`

The same pool receiving financed buys must not be the only authoritative collateral oracle.

The oracle guard requires:

- at least one independent `0xZAPS` price input;
- conservative time windows;
- staleness checks;
- source-divergence limits;
- USDG/USD peg checks;
- L2 sequencer status and recovery grace period;
- minimum executable liquidation depth;
- price-impact simulation for the amount that may need liquidation;
- fail-closed behavior.

If those inputs do not exist, mainnet collateral borrowing remains disabled. A tiny debt ceiling does not make an internally manipulable oracle safe; it only limits the loss.

### 4.8 `LiquidationEngine`

Liquidation is permissionless and does not require agent identity.

A liquidator:

1. repays a bounded amount of USDG debt;
2. receives or atomically unwinds locked recovery assets;
3. observes minimum-output and price-impact limits;
4. cannot call arbitrary targets or redirect unrelated account assets.

Risk-reducing operations remain open in every pause state:

- repay;
- top up collateral;
- close debt;
- unwind through an approved route;
- liquidate an unhealthy account.

Only new borrowing, agent swaps, and other risk-increasing operations may pause.

## 5. Lending accounting

Let:

- `C_ext` = externally supplied `0xZAPS` units;
- `P_safe` = conservative oracle price in USDG;
- `h` = collateral haircut;
- `L_borrow` = borrow LTV;
- `D_agent` = per-agent debt cap;
- `D_global` = global debt ceiling;
- `D_outstanding` = current total market debt.

The origination borrow base is:

```text
BorrowBase = C_ext × P_safe × (1 − h)
```

The maximum additional debt is:

```text
MaxDebt = min(
  BorrowBase × L_borrow,
  D_agent,
  D_global − D_outstanding
)
```

Financed assets have a collateral factor of zero for origination:

```text
OriginationValue(purchased0xZAPS) = 0
OriginationValue(debtFundedLP)     = 0
```

They remain seizable recovery assets and may reduce lender loss. They never expand `MaxDebt`.

### 5.1 Recursive leverage prohibition

If debt-funded collateral were accepted again at LTV `λ`, theoretical exposure before fees and price impact would be:

```text
Gross exposure = Original collateral ÷ (1 − λ)
Debt           = λ × Original collateral ÷ (1 − λ)
```

| Recursive LTV | Gross exposure |
| ---: | ---: |
| 20% | 1.25× |
| 40% | 1.67× |
| 50% | 2.00× |
| 70% | 3.33× |

This loop is prohibited even if the acquired tokens remain locked.

### 5.2 Health and liquidation

Let:

- `V_recovery` = conservatively marked value of all seizable account assets;
- `L_liq` = liquidation LTV;
- `D_mark` = USDG debt marked at the current USDG/USD price.

```text
Health factor = (V_recovery × L_liq) ÷ D_mark
```

The account is liquidatable when:

```text
Health factor < 1
```

The page simulator uses a simplified recovery estimate:

```text
Liquidation recovery = Marked collateral × (1 − execution loss)
Bad debt             = max(0, Debt − Liquidation recovery)
```

Production risk limits must use stressed executable exit value, not mark value or market capitalization.

## 6. Allowed strategy flows

### 6.1 Locked agent liquidity — preferred credit path

```text
principal deposits external 0xZAPS
→ controller verifies borrow capacity
→ controller sends USDG directly to restricted adapter
→ adapter pairs USDG with a bounded slice of external 0xZAPS
→ approved position manager mints a non-transferable position
→ position recipient is AgentCreditAccount
→ controller verifies custody and health
→ fees repay interest and principal before rewards
```

Launch full-range liquidity before concentrated ranges. A concentrated position can become entirely `0xZAPS` during a fall and requires path-dependent range, fee, and unwind valuation.

### 6.2 Buy and lock `0xZAPS` — lower-cap experimental path

```text
principal deposits external 0xZAPS
→ controller verifies smaller borrow cap
→ controller sends USDG directly to restricted adapter
→ adapter executes one approved USDG → 0xZAPS route
→ minimum output and maximum impact are enforced
→ all purchased 0xZAPS return to AgentCreditAccount
→ financed tokens receive 0% origination collateral factor
```

This route creates leveraged token exposure. It does not create productive cash flow by itself. Credit-funded buys receive no marketplace, tournament, Crown, or liquidity-mining reward.

### 6.3 Always-allowed actions

- Repay principal or interest.
- Add external collateral.
- Revoke the agent session key.
- Close a debt-free account.
- Permissionlessly liquidate an unhealthy account.
- Use a reviewed emergency unwind adapter.

### 6.4 Prohibited actions

- Arbitrary `call` or `delegatecall`.
- Arbitrary recipient.
- Persistent approval to an untrusted spender.
- Arbitrary Permit2 access.
- User-selected router, callback, pool, or position manager.
- Borrowed USDG withdrawal.
- Borrowed USDG bridging.
- Financed asset re-pledging.
- LP transfer while debt is open.
- Reward credit for financed volume.
- Borrow and collateral-price update from the same financed action.

## 7. Public market and agent lane

The agent-only pool should not be the only market.

A public liquidation and price-discovery path remains necessary for:

- arbitrage;
- independent buyers and sellers;
- oracle observations;
- permissionless liquidation;
- emergency exits.

The agent lane can provide:

- registered-account access;
- dedicated liquidity;
- execution quotas;
- agent-specific fee experiments;
- strategy-competition settlement.

Restricting all arbitrage to agents can leave the agent pool stale or manipulable. The agent lane is an execution surface, not the sole source of truth.

## 8. Interest, fees, reserve, and incentives

### 8.1 Interest-rate policy

The first model should use a transparent utilization curve:

- base rate;
- gentle slope below target utilization;
- steep slope above target;
- hard utilization cap;
- no discretionary per-agent rate changes inside an open loan.

The exact curve is not selected by this research. It must be simulated against lender withdrawal coverage and agent strategy carry.

### 8.2 Cash-flow priority

Realized strategy proceeds route in this order:

1. gas and explicitly bounded execution cost;
2. accrued USDG interest;
3. USDG principal;
4. reserve contribution;
5. agent or ecosystem reward.

An LP fee is not yield until it is realized, collected, valued, and netted against financing and loss.

### 8.3 0xZAPS flywheel

Preferred loop:

```text
agents acquire and lock 0xZAPS externally
→ bounded USDG enters productive locked liquidity
→ real users and agents execute swaps
→ LP fees repay debt and pay lenders
→ observed repayment supports cautiously larger capacity
→ demand to hold and lock 0xZAPS grows
```

Rejected loop:

```text
borrow USDG
→ buy 0xZAPS
→ mark purchased tokens as fresh collateral
→ borrow again
→ earn rewards on financed volume
→ liquidations unwind the manufactured demand
```

### 8.4 Reward eligibility

Do not reward:

- gross borrowing;
- gross trading volume;
- credit-funded buys;
- LP notional;
- self-trades;
- one principal splitting activity across identities.

Reward only realized net value after:

- funding cost;
- execution cost;
- slippage;
- drawdown;
- liquidation expense;
- reserve contribution.

## 9. Illustrative pilot parameters

These are simulation starting points, not production recommendations.

| Control | Starting point | Reason |
| --- | ---: | --- |
| Borrow LTV | ≤ 20% | External collateral only |
| Liquidation LTV | ≤ 35% | 15-point trigger buffer |
| Per-agent cap | ≤ 2,500 USDG | Contains one-account loss |
| Global ceiling | ≤ 25,000 USDG | Contains correlated loss |
| Utilization cap | ≤ 70% | Preserves lender liquidity |
| Oracle haircut | ≥ 15% | Additional to staleness and depth guards |
| Financed collateral factor | 0% | Prevents recursion |
| Dynamic fee | Off | Fixed-fee v1 |
| Concentrated LP | Off | Full-range first |
| New borrowing during oracle or sequencer fault | Off | Fail closed |
| Repayment, top-up, liquidation during pause | On | Risk reduction stays open |

No parameter set makes an internally manipulable price feed safe.

## 10. Deterministic page simulation

The `/credit` page implements a tested, deterministic model with:

- externally supplied collateral value;
- borrowed USDG;
- time outstanding;
- borrow APR;
- assumed LP fee APR;
- execution cost;
- borrow and liquidation LTV;
- oracle haircut;
- liquidation execution loss;
- terminal USDG price;
- terminal `0xZAPS` shock.

### 10.1 Buy-and-lock approximation

Let:

- `C` = external `0xZAPS` value at entry;
- `D` = USDG borrowed;
- `e` = execution cost;
- `r` = terminal `0xZAPS` price / entry price.

```text
Marked collateral = (C + D × (1 − e)) × r
```

### 10.2 Full-range LP approximation

Borrowed USDG is paired with an equal-value slice of external `0xZAPS`. Let:

- `s` = terminal USDG/USD price;
- `f` = assumed net fee APR;
- `t` = days / 365.

```text
Unpaired 0xZAPS = (C − D × (1 − e)) × r
LP principal    = 2 × D × (1 − e) × √(r × s)
Fee income      = 2 × D × (1 − e) × f × t
Marked collateral = Unpaired 0xZAPS + LP principal + Fee income
```

The constant-product impermanent-loss ratio is:

```text
IL = LP principal ÷ value of holding the same pair − 1
```

### 10.3 Debt

The page uses simple interest for readability:

```text
Debt units = D × (1 + borrow APR × days / 365)
Debt USD   = Debt units × terminal USDG price
```

A contract implementation should use an explicit per-second accrual model with specified rounding.

### 10.4 Model limits

The page model is not a forecast or live quote. It does not model:

- intraperiod liquidations;
- price path;
- concentrated ranges;
- path-dependent fees;
- actual volume;
- actual `0xZAPS` depth;
- liquidation auctions;
- MEV or gas;
- oracle lag;
- correlated agent actions;
- utilization-driven rate changes;
- sequencer outages.

Those belong in the predeployment suite.

## 11. Required simulation program

### 11.1 Historical replay

When sufficient `0xZAPS` history exists, replay:

- every swap;
- tick liquidity;
- quoted and executed price impact;
- depth withdrawn around drawdowns;
- oracle observations;
- USDG deviations;
- gas and liquidation latency.

### 11.2 Monte Carlo sweeps

Sweep:

```text
Borrow LTV:             5% to 20%
Liquidation LTV:        15% to 35%
0xZAPS shocks:          −20%, −40%, −60%, −80%
Liquidity withdrawal:  25%, 50%, 75%, 90%
Oracle delay:           one block to six hours
Liquidation delay:      15 seconds to 30 minutes
USDG price:             $1.00, $0.98, $0.95, $0.90
Utilization:            0% to hard cap
LP fee income:          expected case through zero-fee case
Agent concentration:    independent through fully correlated
```

Report:

- liquidation frequency;
- time below threshold;
- probability and size of bad debt;
- lender expected shortfall;
- reserve depletion at 95%, 99%, and worst-case stress;
- liquidation price impact;
- utilization and withdrawal coverage;
- agent concentration;
- net agent P&L after financing;
- organic fees versus reward cost;
- credit-funded versus external `0xZAPS` demand.

### 11.3 Adversarial simulations

- Borrow, pump the collateral pool, and borrow again.
- Flash-loan the oracle venue.
- Supply a fake agent ID in `hookData`.
- Call PoolManager through an unapproved router.
- Replay a signature across a pool, chain, account, or nonce.
- Transfer the identity while debt is open.
- Revoke an ERC-1271 policy between quote and execution.
- Escape through an arbitrary approval, Permit2 spender, callback, or recipient.
- Add and remove an extreme-tick LP position.
- Create 100 Sybil identities controlled by one principal.
- Remove all agent-pool arbitrage.
- Hold a stale-high oracle through a market collapse.
- Depeg or freeze USDG.
- Lose sequencer availability during liquidation.
- Pause the router or hook while an account is unhealthy.
- Donation-attack the first ERC-4626 lender deposit.

## 12. Smart-contract invariants

The implementation and stateful fuzz suite must prove:

1. `totalDebt <= globalDebtCeiling`.
2. `agentDebt[id] <= perAgentDebtCap[id]`.
3. Financed assets never increase eligible collateral or borrow capacity.
4. Borrowed USDG has no arbitrary receiver.
5. Strategy outputs remain in the indebted canonical account.
6. Every gated pool action consumes one valid authorization.
7. The same authorization cannot execute twice or on another domain.
8. Identity transfer or key revocation stops new actions without moving debt.
9. Repayment and top-up remain callable without agent eligibility.
10. Liquidation remains callable without agent eligibility.
11. No pause can block risk reduction.
12. No successful strategy path can call or approve an untrusted target.
13. Pool manipulation cannot increase borrowing power in the same transaction.
14. Debt and strategy assets are not double-counted.
15. LP principal and fees are not double-counted.
16. Lender share rounding does not create or steal assets.
17. USDG six-decimal accounting remains exact at every contract boundary.

## 13. Administration and recovery

### 13.1 Narrow authorities

Suggested roles:

- **Factory governance:** approves immutable implementation versions.
- **Risk council:** lowers caps, pauses new risk, or raises haircuts.
- **Timelocked governance:** increases caps, changes oracles, routers, or implementations.
- **Guardian:** pauses only new borrowing and strategy actions under enumerated faults.

No role can:

- withdraw lender or borrower assets;
- erase debt;
- transfer an LP position to itself;
- block repayment or liquidation;
- retroactively broaden a signed action.

### 13.2 Monitoring

Alert on:

- oracle staleness or source divergence;
- USDG peg deviation;
- sequencer outage and recovery;
- utilization thresholds;
- account health bands;
- liquidation failure;
- debt ceiling proximity;
- aggregate exposure by linked principal;
- unusual identity creation and borrowing clusters;
- router or hook authorization failures;
- reserve drawdown;
- lender withdrawal coverage;
- implementation or role changes.

### 13.3 Incident response

The runbook must define:

- conditions for pausing new borrowing;
- conditions for pausing agent strategy actions;
- how repayment, top-up, and liquidation remain operational;
- oracle fallback or full shutdown behavior;
- sequencer recovery grace period;
- communication and disclosure process;
- reserve deployment;
- migration to a reviewed implementation;
- post-incident accounting and lender-loss disclosure.

## 14. Launch sequence

### Phase 0 — virtual credit league

Run strategy, repayment, drawdown, and liquidation models with no capital.

Exit gate:

- reproducible position accounting;
- published assumptions;
- agent history immune to raw-volume farming.

### Phase 1 — agent access pool without credit

Deploy identity adapter, canonical policy account, router, minimal hook, and unwind path.

Exit gate:

- direct-call, forged-ID, replay, transfer, revocation, and router-bypass tests pass;
- LP exit cannot be trapped by the hook;
- independent review of the access layer.

### Phase 2 — shadow credit

Mirror live quotes and liquidations with virtual USDG balances.

Exit gate:

- published expected shortfall;
- zero unresolved accounting drift;
- acceptable liquidation success under stressed depth and latency.

### Phase 3 — tiny LP-only USDG pilot

Open full-range, locked LP working capital with a funded reserve.

Exit gate:

- independent `0xZAPS` price input;
- demonstrated liquidation depth larger than the debt ceiling;
- combined contract, oracle, and economic reviews;
- stateful invariant tests, monitoring, incident runbook, and bug bounty.

### Phase 4 — smaller buy-and-lock pilot

Enable leveraged token exposure at a lower cap. Financed assets remain at 0% origination factor and earn no volume-based rewards.

Exit gate:

- no recursive or oracle-feedback path;
- clear maturity or repayment route;
- acceptable liquidation loss under correlated exits.

### Phase 5 — sponsor-backed credit

An underwriter stakes first-loss USDG and grants a revocable line to a specific account. Sponsor loss precedes passive lender loss.

Exit gate:

- long repayment history;
- public underwriter exposure and performance;
- global limits across Sybil-linked identities.

### Phase 6 — stablecoin decision

Evaluate a native unit only if there is independent demand beyond `0xZAPS`, robust collateral pricing, multiple exit venues, reserves, redemption, legal analysis, a bad-debt waterfall, and shutdown procedures.

If issued, use a capacity-bounded facilitator model backed initially by exogenous collateral. Do not rely primarily on `0xZAPS`.

## 15. Mainnet launch blockers

Mainnet credit remains disabled unless all are true:

- an independent `0xZAPS` price source exists;
- the exact L2 sequencer guard is verified for Robinhood Chain;
- liquidation depth demonstrably exceeds the debt ceiling;
- financed assets cannot expand the borrowing base;
- borrowed USDG cannot reach an arbitrary address;
- liquidation works without agent identity;
- repayment and top-up remain enabled during every pause;
- identity transfer or revocation cannot move or erase debt;
- stablecoin and oracle faults stop new risk;
- all stateful invariants pass;
- the full system receives at least two reviews covering hook, lending, oracle, and economics;
- a funded first-loss reserve exists;
- monitoring, incident response, and a bug bounty are operational.

## 16. Primary research

- [Robinhood Chain overview](https://docs.robinhood.com/chain/)
- [Robinhood Chain token contracts](https://docs.robinhood.com/chain/contracts/)
- [Robinhood Earn](https://robinhood.com/us/en/support/articles/robinhood-earn/)
- [Uniswap v4 hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks)
- [Uniswap v4 swap hooks](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks)
- [Uniswap Permissioned Pools architecture](https://developers.uniswap.org/docs/protocols/v4/permissioned-pools/architecture)
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-1271: Standard Signature Validation Method for Contracts](https://eips.ethereum.org/EIPS/eip-1271)
- [Aave Isolation Mode](https://aave.com/help/supplying/isolation-mode)
- [Morpho isolated-market overview](https://legacy.docs.morpho.org/morpho/concepts/overview/)
- [Euler Vault Kit](https://docs.euler.finance/developers/evk/)
- [ERC-4626: Tokenized Vaults](https://eips.ethereum.org/EIPS/eip-4626)
- [Chainlink data-feed guidance](https://docs.chain.link/data-feeds/using-data-feeds)
- [Chainlink L2 sequencer feeds](https://docs.chain.link/data-feeds/l2-sequencer-feeds)

All deployment addresses, standards statuses, integrations, and risk assumptions are drift-prone. Re-verify them before implementation or deployment.
