export type CreditStatusTone = "live" | "proposed" | "blocked";

export const CURRENT_STATE = [
  {
    tone: "live",
    label: "Live infrastructure",
    title: "Robinhood Chain mainnet + Uniswap v4",
    body:
      "Robinhood Chain is live at chain ID 4663, Uniswap publishes v4 deployments for it, and OpenZaps already executes bounded routes across pinned 0xZAPS, aeWETH, and USDG pools.",
  },
  {
    tone: "live",
    label: "Canonical loan asset",
    title: "USDG already exists",
    body:
      "USDG is the canonical dollar stablecoin listed by Robinhood Chain and the lending asset in Robinhood Earn. A second OpenZaps stablecoin would add peg and redemption risk without improving the first credit pilot.",
  },
  {
    tone: "proposed",
    label: "Research proposal",
    title: "Agent access + isolated credit",
    body:
      "The identity adapter, agent router, gate hook, lender vault, credit controller, policy accounts, and liquidation engine described here are not deployed OpenZaps contracts.",
  },
  {
    tone: "blocked",
    label: "Must be solved first",
    title: "Independent executable-value oracle",
    body:
      "A 0xZAPS-backed market cannot safely launch if the same pool financed agents trade in is also the only source used to value their collateral.",
  },
] as const satisfies readonly {
  tone: CreditStatusTone;
  label: string;
  title: string;
  body: string;
}[];

export const PRODUCT_LAYERS = [
  {
    number: "01",
    title: "Agent Access Pools",
    summary: "Uniswap v4 liquidity reserved for registered, policy-constrained agent accounts.",
    decision:
      "Build first without credit. Validate identity, router, hook, quoting, LP unwind, and liquidation bypass paths with no borrowed capital.",
  },
  {
    number: "02",
    title: "Agent Credit Vaults",
    summary: "Tiny, isolated USDG working-capital lines overcollateralized by deposited 0xZAPS.",
    decision:
      "Borrowed USDG goes directly into a policy account. It never becomes a transferable agent wallet balance.",
  },
  {
    number: "03",
    title: "Agent Credit Markets",
    summary: "Later sponsor-backed lines where underwriters post first-loss capital against proven repayment history.",
    decision:
      "Identity creates continuity; sponsor capital creates real underwriting. Reputation alone never creates unsecured credit.",
  },
] as const;

export const ARCHITECTURE = [
  {
    name: "AgentIdentityAdapter",
    role:
      "Pins an approved ERC-8004-compatible registry, checks the current agent-wallet binding, and optionally requires approved validation or attestation policy.",
    trust: "Identity grants eligibility, not creditworthiness.",
  },
  {
    name: "AgentCreditAccount",
    role:
      "A factory-deployed, principal-owned account with an agent session key. It holds collateral, debt proceeds, purchased 0xZAPS, and LP positions.",
    trust: "Debt never follows a transferable identity NFT.",
  },
  {
    name: "AgentRouter",
    role:
      "Verifies one EIP-712 or ERC-1271 action permit and passes its digest through hookData for same-transaction consumption.",
    trust: "Never trust tx.origin or an address merely supplied in hookData.",
  },
  {
    name: "AgentGateHook",
    role:
      "Allows swaps and leveraged liquidity additions only from the approved router with an unused action digest for the exact pool and account.",
    trust: "Repay, unwind, and liquidation routes remain available without active agent status.",
  },
  {
    name: "CreditController",
    role:
      "Accounts for eligible 0xZAPS collateral, USDG debt, interest, per-agent caps, the global ceiling, health, and liquidation state.",
    trust: "Financed assets can be seized but never create new borrowing power.",
  },
  {
    name: "USDGLenderVault",
    role:
      "Accepts lender USDG and issues ERC-4626-style shares, subject to a utilization cap, reserve factor, withdrawal-liquidity controls, and explicit market risk.",
    trust: "Lenders bear smart-contract, oracle, collateral, liquidity, and bad-debt risk.",
  },
  {
    name: "RiskOracle",
    role:
      "Values 0xZAPS using independent inputs, conservative time windows, staleness and deviation checks, an L2 sequencer guard, and executable-liquidity haircuts.",
    trust: "No borrow when observations are stale, divergent, or insufficient.",
  },
  {
    name: "LiquidationEngine",
    role:
      "Lets any liquidator repay USDG and unwind locked strategy assets through a dedicated adapter when the account breaches its threshold.",
    trust: "Risk reduction cannot be agent-gated or paused.",
  },
] as const;

export const ACTION_PERMIT_FIELDS = [
  "agent ID and policy-account address",
  "action kind: BUY_ZAPS or ADD_AGENT_LP",
  "exact pool ID, input asset, and maximum input",
  "minimum output or minimum liquidity",
  "maximum price impact and approved LP range",
  "recipient fixed to the indebted policy account",
  "policy hash, nonce, deadline, chain ID, and verifying contract",
] as const;

export const STRATEGIES = [
  {
    id: "buy-zaps",
    title: "Buy and lock 0xZAPS",
    flow:
      "Deposit 0xZAPS → borrow bounded USDG → atomically buy 0xZAPS through an approved route → lock output in the same account → repay or liquidate.",
    posture:
      "Pilot only at tiny caps. The acquired tokens improve recoverable value but never increase the account's borrow limit, preventing recursive leverage.",
  },
  {
    id: "agent-lp",
    title: "Add locked agent liquidity",
    flow:
      "Deposit 0xZAPS → borrow bounded USDG → pair it with an equal-value slice of deposited 0xZAPS → lock the non-transferable position → route fees to debt first.",
    posture:
      "Ship after the buy-and-lock path. Concentrated ranges, fee variability, impermanent loss, and unwind liquidity create extra failure modes.",
  },
] as const;

export const PILOT_PARAMETERS = [
  ["Borrow LTV", "≤ 20%", "Applied only to unfinanced 0xZAPS deposited before the borrow."],
  ["Liquidation LTV", "≤ 35%", "A 15-point buffer before oracle and execution haircuts."],
  ["Per-agent debt cap", "≤ 2,500 USDG", "A hard ceiling; identity reputation cannot raise it during the pilot."],
  ["Global debt ceiling", "≤ 25,000 USDG", "Limits the maximum lender loss while price and liquidation evidence is sparse."],
  ["Utilization cap", "≤ 70%", "Preserves lender exit liquidity and steepens rates before the cap."],
  ["Oracle haircut", "≥ 15%", "Applied on top of staleness, divergence, and executable-depth checks."],
  ["New-borrow pause", "Automatic", "Triggers on stale oracle data, sequencer outage, peg deviation, or thin liquidation depth."],
  ["Financed collateral factor", "0%", "Purchased 0xZAPS and LP positions never create additional borrowing power."],
] as const;

export const INVARIANTS = [
  "Borrowed USDG can never be sent to an arbitrary receiver or approved to an untrusted spender.",
  "Purchased 0xZAPS and leveraged LP positions remain in the indebted account until debt is repaid or liquidated.",
  "Financed strategy assets never increase eligible collateral or the borrow limit.",
  "Every gated swap or liquidity addition consumes exactly one current, signed action authorization.",
  "Identity transfer or agent-key revocation stops new strategy actions without transferring ownership or debt.",
  "Repayment, collateral top-ups, liquidation, and emergency risk reduction do not require agent eligibility.",
  "The oracle used to open credit cannot be raised by the financed trade in the same transaction.",
  "Total debt never exceeds the per-agent cap, global debt ceiling, or utilization cap.",
  "Only risk-increasing actions can pause; users and liquidators retain a bounded exit path.",
  "Rewards are based on realized net value after financing, slippage, losses, and liquidation cost—not raw borrow or volume.",
] as const;

export const ROLLOUT = [
  {
    phase: "Phase 0",
    name: "Virtual credit league",
    gate: "No capital",
    detail:
      "Run the exact strategy and stress models against delayed or historical data. Build agent repayment and drawdown histories without issuing debt.",
  },
  {
    phase: "Phase 1",
    name: "Agent access pool",
    gate: "No borrowing",
    detail:
      "Deploy the identity adapter, canonical policy accounts, router, hook, and unwind path. Prove direct-call, replay, identity-transfer, and router-bypass resistance.",
  },
  {
    phase: "Phase 2",
    name: "Shadow credit",
    gate: "Virtual USDG",
    detail:
      "Mirror live quotes and liquidations with virtual balances. Publish missed-liquidation and expected-shortfall evidence.",
  },
  {
    phase: "Phase 3",
    name: "Tiny LP-only pilot",
    gate: "Independent review",
    detail:
      "Open full-range locked-liquidity working capital with a funded reserve. Financed LP assets keep a zero origination factor and fees repay debt first.",
  },
  {
    phase: "Phase 4",
    name: "Smaller buy-and-lock pilot",
    gate: "No oracle-feedback path",
    detail:
      "Add leveraged token exposure at a lower cap. Purchased tokens stay locked, never expand the borrow base, and earn no volume-based rewards.",
  },
  {
    phase: "Phase 5",
    name: "Sponsor-backed agent credit",
    gate: "Proven repayment history",
    detail:
      "Underwriters stake first-loss USDG and grant revocable lines. Global limits still apply across Sybil-linked identities.",
  },
  {
    phase: "Phase 6",
    name: "Stablecoin decision",
    gate: "Independent demand",
    detail:
      "Only evaluate a native unit after external use, reserve/redemption design, legal review, robust oracle coverage, and multiple deep exit venues exist.",
  },
] as const;

export const RESEARCH_SOURCES = [
  {
    title: "Robinhood Chain overview and ecosystem",
    publisher: "Robinhood",
    url: "https://docs.robinhood.com/chain/",
    finding: "Chain 4663 is live; the official ecosystem lists Uniswap, Morpho, Chainlink, and Paxos USDG.",
  },
  {
    title: "Robinhood Chain token contracts",
    publisher: "Robinhood",
    url: "https://docs.robinhood.com/chain/contracts/",
    finding: "The official contract registry identifies canonical WETH and USDG on Robinhood Chain.",
  },
  {
    title: "Robinhood Earn",
    publisher: "Robinhood",
    url: "https://robinhood.com/us/en/support/articles/robinhood-earn/",
    finding: "USDG lending already runs through a self-custody Morpho vault with explicit liquidity and smart-contract risk.",
  },
  {
    title: "ERC-8004: Trustless Agents",
    publisher: "Ethereum Improvement Proposals",
    url: "https://eips.ethereum.org/EIPS/eip-8004",
    finding: "Draft identity, wallet-binding, reputation, and validation registries; registration and feedback are not proof of solvency or capability.",
  },
  {
    title: "Uniswap v4 hooks",
    publisher: "Uniswap",
    url: "https://developers.uniswap.org/docs/protocols/v4/concepts/hooks",
    finding: "A pool can attach one hook that runs around swaps and liquidity operations.",
  },
  {
    title: "Uniswap v4 swap hooks",
    publisher: "Uniswap",
    url: "https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks",
    finding: "The hook callback sender is normally the router calling PoolManager—not the ultimate agent.",
  },
  {
    title: "Permissioned Pools architecture",
    publisher: "Uniswap",
    url: "https://developers.uniswap.org/docs/protocols/v4/permissioned-pools/architecture",
    finding: "Approved wrappers, per-action checks, non-transferable LP positions, and explicit unwind paths are the closest current v4 precedent.",
  },
  {
    title: "Aave Isolation Mode",
    publisher: "Aave",
    url: "https://aave.com/help/supplying/isolation-mode",
    finding: "Volatile collateral is restricted to approved stablecoin debt and contained by a debt ceiling.",
  },
  {
    title: "Morpho isolated markets",
    publisher: "Morpho",
    url: "https://legacy.docs.morpho.org/morpho/concepts/overview/",
    finding: "A minimal isolated market binds one collateral, one loan asset, one oracle, one LLTV, and one interest-rate model.",
  },
  {
    title: "Euler Vault Kit",
    publisher: "Euler",
    url: "https://docs.euler.finance/developers/evk/",
    finding: "ERC-4626-style credit vaults can isolate accounts and add custom restrictions, caps, oracles, and hooks.",
  },
  {
    title: "ERC-4626: Tokenized Vaults",
    publisher: "Ethereum Improvement Proposals",
    url: "https://eips.ethereum.org/EIPS/eip-4626",
    finding: "A standard single-asset share interface is appropriate for the lender vault, with careful rounding and preview semantics.",
  },
  {
    title: "Chainlink L2 data-feed guidance",
    publisher: "Chainlink",
    url: "https://docs.chain.link/data-feeds/using-data-feeds",
    finding: "L2 price consumers must account for sequencer outages; a latest answer alone is not a complete safety policy.",
  },
] as const;
