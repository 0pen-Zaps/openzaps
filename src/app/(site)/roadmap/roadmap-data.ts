export type RoadmapStatusTone = "live" | "experimental" | "planned" | "gated" | "deferred";

export type RoadmapStatus = {
  label: string;
  tone: RoadmapStatusTone;
};

export type RoadmapDetail = {
  title: string;
  intro?: string;
  items: readonly string[];
};

export type RoadmapSystem = {
  id: string;
  number: string;
  group: "Build" | "Coordinate" | "Improve";
  title: string;
  summary: string;
  statuses: readonly RoadmapStatus[];
  paragraphs?: readonly string[];
  bulletLabel?: string;
  bullets?: readonly string[];
  formula?: string;
  details?: readonly RoadmapDetail[];
  progression?: readonly string[];
  note?: string;
};

export const STATUS_LEGEND: readonly (RoadmapStatus & { description: string })[] = [
  { label: "Live", tone: "live", description: "Operating in the current product or protocol." },
  {
    label: "Experimental",
    tone: "experimental",
    description: "A usable foundation exists, but the full roadmap system does not.",
  },
  { label: "Planned", tone: "planned", description: "A design direction, not a shipped feature or date commitment." },
  {
    label: "Safety-gated",
    tone: "gated",
    description: "Requires explicit review, funding, controls, and production evidence before activation.",
  },
  {
    label: "Deferred",
    tone: "deferred",
    description: "Explicitly outside the current release path until its safety model is designed.",
  },
] as const;

export const FOUNDATION_STATES = [
  {
    status: { label: "Live · v1.1 / v3 / v3.1", tone: "live" },
    title: "Three bounded execution lineages",
    body:
      "v1.1 binds each one-shot route, recipient, assets, step amounts, output floor, and gas limits. v3 adds recurring cadence, run limits, optional executor restriction, and price triggers; v3.1 adds recurring per-run floors derived from allowlisted price sources. All three lineages are live and pre-audit on Robinhood Chain.",
  },
  {
    status: { label: "Shipped", tone: "live" },
    title: "Receipts, policies, Guardian, and public evidence",
    body:
      "Signed intents, execution receipts, relay state, executor scorecards, exact policy simulation, public templates, and read-only checks preserve one rule: an agent may discover and submit, but it cannot widen authority.",
  },
  {
    status: { label: "Release-ready · one-shot", tone: "experimental" },
    title: "v1.2 exact owner pull and permanent halt",
    body:
      "The reviewed source path includes isolated creation, exact Permit2 allowances, irreversible halt, recovery, and fail-closed provenance. It is not live until governance broadcasts it and the independent post-deployment canaries pass.",
  },
  {
    status: { label: "Deployed candidate · canaries pending", tone: "experimental" },
    title: "Recurring Robinhood v3.2 stack",
    body:
      "The isolated stack-only factory, creation gateway, execution pot, and creation pot are deployed on Robinhood Chain and independently wired back to the reviewed source. The contracts remain unaudited, and the production creation, execution, and permanent-halt canaries must pass before this lineage is advertised as live.",
  },
  {
    status: { label: "Gated", tone: "gated" },
    title: "Credentialed production services",
    body:
      "Cross-chain funding, hosted signing, notifications, durable operator quotas, package distribution, and private-relay fanout stay off until their documented credentials, migrations, failure modes, and operator checks exist.",
  },
  {
    status: { label: "Deferred", tone: "deferred" },
    title: "Protective auto-deleverage",
    body:
      "Automated deleveraging needs its own liability, oracle, liquidity, liquidation-ordering, and recovery model. It is not treated as another adapter and remains outside the current release path.",
  },
] as const satisfies readonly {
  status: RoadmapStatus;
  title: string;
  body: string;
}[];

export const ROADMAP_SYSTEMS: readonly RoadmapSystem[] = [
  {
    id: "zap-lab",
    number: "01",
    group: "Build",
    title: "Zap Lab",
    summary: "Continuously launch bounded Zap experiments, then graduate only the ones that create durable utility.",
    statuses: [
      { label: "Live foundation", tone: "live" },
      { label: "Planned system", tone: "planned" },
    ],
    bulletLabel: "Roadmap mechanics",
    bullets: [
      "Mark every Zap as Experimental, Verified, or Deprecated.",
      "Instrument successful executions, repeat usage, fees generated, failures, and safety incidents.",
      "Add Zap Requests where users and protocols escrow fixed rewards for specific outcomes.",
      "Run targeted quests for underserved chains, protocols, and DeFi actions.",
      "Graduate only Zaps demonstrating sustained, economically meaningful usage.",
    ],
    note: "Raw volume alone never qualifies a Zap.",
  },
  {
    id: "skill-registry",
    number: "02",
    group: "Build",
    title: "Agent Skill Registry",
    summary: "Convert proven Zaps into versioned skills agents can discover, simulate, execute, and safely roll back.",
    statuses: [
      { label: "Experimental foundation", tone: "experimental" },
      { label: "Planned registry", tone: "planned" },
    ],
    bulletLabel: "Every skill includes",
    bullets: [
      "Typed inputs and outputs.",
      "Spending, permission, slippage, and timing limits.",
      "Supported protocols and chains.",
      "Reproducible simulations and evaluations.",
      "Version history, maintainers, and rollback paths.",
      "Immutable creator and remix lineage.",
      "Live, shadow, experimental, or deprecated status.",
    ],
    note:
      "Anyone can fork and improve a skill while preserving attribution to meaningful upstream contributors.",
  },
  {
    id: "marketplace",
    number: "03",
    group: "Build",
    title: "Zap Marketplace",
    summary: "Connect funded outcomes, maintainers who build them, and agents that execute and improve them.",
    statuses: [
      { label: "Planned", tone: "planned" },
      { label: "Escrow & bonds gated", tone: "gated" },
    ],
    bulletLabel: "Participant roles",
    bullets: [
      "Requesters describe valuable outcomes and pre-fund bounties.",
      "Creators build, document, and maintain Zap skills.",
      "Agents execute, evaluate, and improve those skills.",
    ],
    formula: "Net verified fees × repeat usage × success rate × longevity × safety",
    details: [
      {
        title: "Champion Blueprints",
        intro: "Each category may have a reigning blueprint, challenged on measured utility rather than routed capital.",
        items: [
          "A challenger must improve the incumbent utility score by at least 10%.",
          "Awards come from a fixed, pre-funded seasonal budget.",
          "The maintainer must remain active during the season.",
          "Capital routed alone cannot win a category.",
          "Crown history and challenges remain publicly replayable.",
        ],
      },
      {
        title: "Marketplace bonds",
        intro: "Optional actions may require refundable 0xZAPS bonds.",
        items: [
          "Publishing an unverified skill.",
          "Challenging a Champion.",
          "Curating or evaluating a blueprint.",
          "Entering an advanced competition.",
          "Good-faith completion returns the bond; only objectively provable spam, non-completion, or invalid submissions can be penalised.",
        ],
      },
    ],
    note:
      "Core Zap creation and execution remain token-ungated. Rewards are capped by attributable economic value so wash activity is negative-EV.",
  },
  {
    id: "contribution-router",
    number: "04",
    group: "Coordinate",
    title: "0xZAPS Contribution Router",
    summary:
      "Preserve the automated executor share, then let explicitly migrated future protocol fees buy and route 0xZAPS within published limits.",
    statuses: [
      { label: "80% executor share live", tone: "live" },
      { label: "Future migration gated", tone: "gated" },
    ],
    paragraphs: [
      "The existing 80% automated-execution fee paid to executors remains intact. For future deployments, the remaining 20% protocol share may move through bounded, rate-limited 0xZAPS purchases.",
    ],
    bulletLabel: "Additional eligible inputs may include",
    bullets: [
      "Existing Zap-creation fee conversions.",
      "Sponsored Zap Requests and seasons.",
      "Marketplace publication fees.",
      "Verified, controllable Clanker creator fees, if available.",
      "Unreturned competition bonds.",
    ],
    details: [
      {
        title: "Adaptive routing within published bounds",
        items: [
          "Old, unanswered Zap Requests increase creator incentives.",
          "Useful skills with weak execution demand increase agent incentives.",
          "Healthy supply and demand return routing to the default allocation.",
          "User-facing fees remain fixed and predictable; only internal reward routing changes.",
        ],
      },
    ],
    note:
      "Existing pot balances and obligations remain untouched. The router applies only to explicitly migrated future fee flows.",
  },
  {
    id: "productive-uses",
    number: "05",
    group: "Coordinate",
    title: "Productive 0xZAPS Uses",
    summary: "Coordinate optional ecosystem work without granting control over user funds or recovery paths.",
    statuses: [
      { label: "Existing token surface live", tone: "live" },
      { label: "Roadmap uses planned", tone: "planned" },
    ],
    bulletLabel: "Optional uses include",
    bullets: [
      "Publish canonical blueprint versions.",
      "Boost pre-funded Zap Requests.",
      "Challenge category Champions.",
      "Post refundable tournament bonds.",
      "Fund fixed-budget seasons.",
      "Unlock cosmetic creator and agent levels.",
      "Trigger permissionless evaluation, settlement, and maintenance.",
      "Queue adapter proposals for review—payment buys review, never approval.",
    ],
    note:
      "No governance over user Zaps, passive revenue rights, token-gated recovery paths, or authority over user funds are introduced.",
  },
  {
    id: "agent-league",
    number: "06",
    group: "Improve",
    title: "OpenZaps Agent League",
    summary: "Run reproducible virtual trading competitions over fixed epochs before any strategy reaches live capital.",
    statuses: [
      { label: "Virtual-first", tone: "planned" },
      { label: "Rewards & bonds gated", tone: "gated" },
    ],
    bulletLabel: "Tournament tracks",
    bullets: [
      "Directional trading.",
      "Yield optimisation.",
      "Liquidity provision.",
      "Portfolio rebalancing.",
      "Risk management.",
      "Cross-protocol execution.",
    ],
    details: [
      {
        title: "Identical tournament conditions",
        items: [
          "Starting capital.",
          "Historical or live-delayed market data.",
          "Execution timing.",
          "Gas and slippage assumptions.",
          "Liquidity and position limits.",
          "Risk constraints.",
          "Strategy artifacts committed by hash before the epoch and executed in reproducible sandboxes.",
        ],
      },
      {
        title: "Agent scoring",
        items: [
          "Risk-adjusted return.",
          "Maximum drawdown.",
          "Performance consistency.",
          "Slippage, gas, and turnover.",
          "Liquidity capacity.",
          "Rule compliance.",
          "Performance across multiple market regimes.",
        ],
      },
      {
        title: "Budget and public evidence",
        items: [
          "Reward budgets are escrowed before each epoch.",
          "Valid completion returns entry bonds.",
          "Abandoned or invalid entries may be partially burned and partially carried into the following epoch.",
          "Public leaderboards show performance, lineage, replays, streaks, titles, and shareable result cards.",
        ],
      },
    ],
  },
  {
    id: "strategy-engine",
    number: "07",
    group: "Improve",
    title: "Living Strategy Engine",
    summary: "Treat winners as candidates, not automatic upgrades, and promote only evidence-backed components.",
    statuses: [
      { label: "Planned evaluation", tone: "planned" },
      { label: "Live capital safety-gated", tone: "gated" },
    ],
    details: [
      {
        title: "Champion–Challenger evaluation",
        items: [
          "Freeze the submitted strategy version.",
          "Run it across unseen market periods.",
          "Test liquidity shocks, oracle failures, fee changes, and adversarial conditions.",
          "Compare it against the incumbent and simple benchmarks.",
          "Promote only components that improve performance without weakening risk limits.",
          "Prefer diversified components whose returns are not highly correlated.",
          "Preserve attribution to every adopted contributor.",
        ],
      },
    ],
    paragraphs: [
      "A challenger must demonstrate meaningful improvement across multiple evaluations before replacing the incumbent.",
      "Contributor rewards activate only when a component is adopted and continues producing measurable improvement.",
    ],
    progression: [
      "Simulation",
      "Virtual competition",
      "Shadow execution",
      "Capped live capital",
      "Explicit user-signed deployment",
    ],
  },
  {
    id: "seasons",
    number: "08",
    group: "Coordinate",
    title: "Pre-Funded Seasons",
    summary: "Use short, fully budgeted seasons to bootstrap a specific shortage, then measure what survives.",
    statuses: [
      { label: "Planned", tone: "planned" },
      { label: "Escrow contracts gated", tone: "gated" },
    ],
    bulletLabel: "Season rules",
    bullets: [
      "Escrow the entire reward budget before announcing the season.",
      "Target defined shortages such as new integrations, evaluators, creators, or users.",
      "Dynamically direct incentives toward the scarce side.",
      "End distributions when the season ends.",
      "Publish organic versus incentivised usage separately.",
      "Report 30-day post-season retention.",
      "Fund long-term seasons from real fees, bounties, and sponsors rather than unlimited emissions.",
    ],
  },
] as const;

export const CONTRIBUTION_ALLOCATION = [
  {
    percentage: 40,
    label: "Skill creators",
    detail: "Creators, maintainers, and meaningful lineage.",
  },
  {
    percentage: 40,
    label: "Active agents",
    detail: "Strategists, evaluators, and keepers.",
  },
  {
    percentage: 20,
    label: "Protocol sink",
    detail: "Permanent protocol fee sink.",
  },
] as const;

export const FLYWHEELS = [
  {
    label: "Product flywheel",
    nodes: [
      "Zap Requests",
      "New blueprints",
      "Verified usage",
      "Reusable skills",
      "Protocol fees",
      "0xZAPS purchases",
      "Contributor rewards",
      "More builders",
    ],
  },
  {
    label: "Intelligence flywheel",
    nodes: [
      "Agent competitions",
      "Winning components",
      "Adversarial evaluation",
      "Improved reference strategy",
      "Better execution",
      "More usage and fees",
      "Larger future competitions",
    ],
  },
] as const;

export const NON_NEGOTIABLES = [
  "Core Zap custody and recovery are never gamified.",
  "Rewards compensate performed work—not token balances.",
  "Rewards never exceed their fixed budget or attributable economic activity.",
  "Incentivised and organic volume are always reported separately.",
  "Financial strategy rewards are deterministic, not random.",
  "No winner is blindly merged into the rolling strategy.",
  "Every live-capital progression remains capped, reversible, and explicitly authorised by the user.",
  "New incentive contracts require independent review before handling meaningful value.",
] as const;

export const NORTH_STAR_METRICS = [
  "Experimental Zaps graduating into reusable skills.",
  "Successful executions and 30-day repeat usage.",
  "Creator compensation per retained user.",
  "Percentage of rewards funded by real activity.",
  "Organic versus incentivised execution volume.",
  "Meaningful blueprint remix reuse.",
  "Strategy performance after out-of-sample promotion.",
  "Maximum drawdown and strategy failure rate.",
  "Improvement of the reference strategy by epoch.",
] as const;
