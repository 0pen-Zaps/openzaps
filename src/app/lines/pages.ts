import type { PageContent } from "./LinesSections";

/**
 * Copy for every interior LINES page.
 *
 * Extracted from the real pages it mirrors and then fact-checked back against
 * those sources, so the preview cannot make a claim the product does not. Where
 * a number comes from a catalog the value says so, because the catalog is what
 * moves — the figure here is a snapshot of it, not a second source of truth.
 *
 * Anything genuinely live — balances, executions, capsule state — is absent by
 * design. Those surfaces stay on the real site rather than being restyled with
 * invented numbers.
 */
export const PAGES: Record<string, PageContent> = {
  "build": {
    "kicker": "ZAP BUILDER",
    "title": "Typed blocks, one chain, nothing broadcast",
    "lede": "Every DeFi activity is a block with a typed connector. Drag pieces into the chain and they only seat where the shape flowing out of the block above matches the shape the block below expects — the same rule the policy compiler enforces before anything gets signed.",
    "sections": [
      {
        "kind": "cards",
        "heading": "Four kinds of block",
        "kicker": "CATALOG SHAPE",
        "intro": "A zap is a linear chain. Each block declares the shape of value it consumes and the shape it produces, which is what makes the pieces behave like physical lego: a stud only seats in a matching socket.",
        "cards": [
          {
            "kicker": "kind: source",
            "title": "Source",
            "body": "Opens a chain — emits, accepts nothing. Wallet balance pulls a fixed amount with an exact approval bound into the policy hash. Recurring deposit draws one instalment per execution. Pending rewards reads the claimable balance of an allowlisted reward source and emits a claimable position rather than tokens.",
            "tag": "3 in catalog"
          },
          {
            "kicker": "kind: action",
            "title": "Action",
            "body": "Transforms one shape into another. Swap routes through a registered adapter with a bounded selector. Supply returns the market's share token. Borrow opens a debt line against that share. Add liquidity mints a position with signed range bounds. Accrue is a no-op onchain — it exists so the chain can name the waiting period.",
            "tag": "12 in catalog"
          },
          {
            "kicker": "kind: guard",
            "title": "Guard",
            "body": "A passthrough constraint that binds the policy without changing what flows. Guards are transparent to the connector maths, which is why a guard can be dropped anywhere downstream of a source without breaking the fit. Slippage cap, spend ceiling, price band, time window, human gate, private submission.",
            "tag": "6 in catalog"
          },
          {
            "kicker": "kind: sink",
            "title": "Sink",
            "body": "Closes the chain. Send binds the recipient into the policy hash — changing it is a new policy and a new signature, never a config edit. Hold leaves custody with the capsule until the owner withdraws or triggers the emergency exit. Loop back compounds into the first action instead of settling.",
            "tag": "4 in catalog"
          }
        ]
      },
      {
        "kind": "steps",
        "heading": "The live route",
        "kicker": "ONE DEPLOYABLE CHAIN",
        "intro": "The builder opens on this chain because it is the only recipe today's deployed contracts can actually carry — the v1.1 contracts implement exactly one bounded route, a single-step aeWETH ↔ 0xZAPS swap. Every other blueprint in the catalog is a design. The gas figures below are the catalog's hand-written per-block constants, not a simulation against a node.",
        "steps": [
          {
            "n": "01",
            "title": "Wallet balance",
            "body": "WETH, 0.05. A one-shot pull with an exact approval; the amount is bound into the policy hash, so the executor can never draw more than the figure signed here. On Robinhood Chain the live route's WETH is aeWETH.",
            "tag": "source · ~46,000 gas"
          },
          {
            "n": "02",
            "title": "Slippage cap",
            "body": "50 bps. Converts to a minimum-out on every priced step downstream. Anything worse reverts the whole chain.",
            "tag": "guard · 0 gas"
          },
          {
            "n": "03",
            "title": "Swap",
            "body": "Into 0xZAPS, Uniswap v4. Routes through a registered adapter with a bounded selector; the minimum-out is derived from the slippage guard and enforced as a postcondition. 0xZAPS is the only asset the live route pairs against.",
            "tag": "action · ~132,000 gas"
          },
          {
            "n": "04",
            "title": "Send to recipient",
            "body": "Owner wallet — the live policy forces it. The recipient is bound into the policy hash. A test holds this recipe and the deployability rules together, so a catalog edit that quietly drops it off the live route cannot leave the front door pointing nowhere.",
            "tag": "sink · ~34,000 gas"
          }
        ]
      },
      {
        "kind": "facts",
        "heading": "Catalog reference",
        "kicker": "COUNTS AND LIMITS",
        "facts": [
          {
            "label": "Blocks in the palette",
            "value": "25 (from BLOCKS)"
          },
          {
            "label": "Ready-made chains",
            "value": "7 (from RECIPES)"
          },
          {
            "label": "Connector shapes",
            "value": "5 (from FlowShape): token, lp, receipt, yield, debt"
          },
          {
            "label": "Shape labels shown in the legend",
            "value": "ERC-20, LP position, Vault share, Claimable, Debt line"
          },
          {
            "label": "Palette categories",
            "value": "8 (from CATEGORY_LABEL)"
          },
          {
            "label": "Block maturity tiers",
            "value": "live, preview, review, blocked"
          },
          {
            "label": "Gas figures",
            "value": "Hand-written per-block constants summed by compileChain — nothing is simulated against a node"
          },
          {
            "label": "Base gas before any block",
            "value": "21,000 gas units (compileChain)"
          },
          {
            "label": "Slippage cap range",
            "value": "5–500 bps, step 5, default 50"
          },
          {
            "label": "Loop runs param",
            "value": "1–12, default 4 — the check passes only at 1–8"
          },
          {
            "label": "Shared chain node cap",
            "value": "64 (MAX_SHARED_NODES)"
          },
          {
            "label": "Share token length cap",
            "value": "8,000 chars (MAX_TOKEN_LENGTH)"
          },
          {
            "label": "Heaviest catalog block",
            "value": "Add liquidity, ~214,000 gas constant (from BLOCKS)"
          }
        ]
      },
      {
        "kind": "bounds",
        "heading": "What the builder refuses",
        "kicker": "RULES, NOT ADVICE",
        "intro": "The seating rule, the compiler, and the palette's dimming all consult one function, so anything the canvas accepts compiles without a blocking issue.",
        "bounds": [
          "A block only seats where the block above it emits the shape this block accepts. A mid-chain block also has to seat the piece that follows it.",
          "A chain draws from exactly one source. A second source is a blocking issue, not a warning.",
          "Guards seat anywhere value is actually flowing, and nowhere else — above the source or below the settlement there is nothing for them to bind.",
          "When a design states more than one slippage cap, the tightest governs. Chain order never decides it; \"the last one wins\" would silently hand a looser bound to whoever dropped their caps in an unlucky order.",
          "A wide slippage cap warns, never blocks. The live app signs caps up to 500 bps from its own slider, so a wide cap is a risk the user can legitimately take.",
          "An unguarded chain still assembles and still simulates. Guard coverage never blocks — \"block\" is reserved for structural faults, so the top-line verdict keeps meaning one precise thing.",
          "Shared links and pasted design JSON are untrusted. Unknown block ids are dropped rather than rendered as holes, every param key is looked up in the catalog, and every value is checked against the param's own declared domain.",
          "Preview blocks are safe for simulation and testnet, not for size. A review block needs adapter review before it can hold mainnet funds, and a blocked block is deliberately disabled until its review clears.",
          "The builder compiles and simulates only. Nothing here signs, funds, or submits a transaction."
        ]
      },
      {
        "kind": "cards",
        "heading": "What the readout checks",
        "kicker": "COMPILED VERDICT",
        "intro": "Compiling a chain returns the same shape of verdict the rest of the product speaks: a status, a policy hash, a gas estimate, and a list of named checks.",
        "cards": [
          {
            "kicker": "check",
            "title": "Connector fit",
            "body": "Passes when every block accepts the shape the block above it emits. Otherwise it blocks and names the first joint that does not seat.",
            "tag": "pass / block"
          },
          {
            "kicker": "check",
            "title": "Block maturity",
            "body": "Takes the least mature block in the chain. Live passes. Preview passes with the note that preview blocks are for simulation and testnet, not for size. Review warns. Blocked blocks the chain.",
            "tag": "pass / warn / block"
          },
          {
            "kicker": "check",
            "title": "Slippage",
            "body": "Reads the governing cap, never the first one placed. At or below 100 bps it passes. Above that it warns — above 250 bps the copy states a fill can come back dramatically worse than quoted. When several caps are placed, all of them are listed alongside the one that governs.",
            "tag": "pass / warn"
          },
          {
            "kicker": "check",
            "title": "Guard coverage",
            "body": "Each risk the placed blocks introduce demands a specific guard: pricing a trade demands a slippage cap, drawing more than once demands a spend ceiling, taking on leverage demands a price band, and signing a standing authority demands a time window. Missing guards are named, not just counted.",
            "tag": "editorial, 0–100"
          },
          {
            "kicker": "check",
            "title": "Loop bound",
            "body": "Appears only when a loop-back block is placed. One to eight runs passes and states where compounding stops. Anything unbounded or deeper blocks, because it compounds exposure faster than a human can review it.",
            "tag": "pass / block"
          },
          {
            "kicker": "check",
            "title": "Authority",
            "body": "With a human gate placed, every run waits for a fresh wallet signature. Without one, the signed policy is the only authority — bounded by its guards and revocable at any time.",
            "tag": "pass"
          }
        ]
      }
    ]
  },
  "security": {
    "kicker": "SECURITY ARCHITECTURE",
    "title": "The product is the boundary.",
    "lede": "OpenZaps does not sell invisible autonomy. It sells explicit execution limits: fixed adapters, spend caps, postconditions, wallet-reviewed policies, and owner revoke paths, with private submission on the roadmap. Contracts are deployed on Robinhood Chain, but real-fund creation is not production-cleared. The repo contains a reference implementation and tests; production use still needs audit, formal verification, and adapter governance.",
    "sections": [
      {
        "kind": "steps",
        "heading": "Architecture",
        "kicker": "EXECUTION PATH",
        "intro": "A user or Safe creates a per-policy capsule through the factory. The capsule holds funds and accepts only owner-signed intents that match the frozen policy hash. Hermes can simulate, submit, monitor, and alert, but cannot choose arbitrary targets, recipients, assets, or calldata — no discretionary custody, no arbitrary calldata.",
        "steps": [
          {
            "n": "1",
            "title": "User / Safe",
            "body": "The owner, or a Safe acting as owner, initiates. Intents are owner-signed.",
            "tag": "origin"
          },
          {
            "n": "2",
            "title": "OpenZapFactory",
            "body": "The factory creates a per-policy capsule.",
            "tag": "factory"
          },
          {
            "n": "3",
            "title": "OpenZap clone with frozen policy",
            "body": "The clone holds funds and accepts only intents that match the frozen policy hash.",
            "tag": "capsule"
          },
          {
            "n": "4",
            "title": "Allowlisted adapter",
            "body": "Execution reaches an adapter drawn from the allowlist, not an arbitrary target.",
            "tag": "adapter"
          },
          {
            "n": "5",
            "title": "Recipient-bound postcondition",
            "body": "The step ends on a postcondition bound to the recipient.",
            "tag": "postcondition"
          },
          {
            "n": "H",
            "title": "Hermes lane",
            "body": "simulate -> submit -> monitor -> alert -> revoke escalation. No discretionary custody. No arbitrary calldata.",
            "tag": "operator"
          }
        ]
      },
      {
        "kind": "bounds",
        "heading": "Controls",
        "kicker": "WHAT THE CONTRACTS ENFORCE",
        "bounds": [
          "No arbitrary calls — execution is restricted to governed adapters and known selectors; not a universal router.",
          "Nonce consumed first — authorization is consumed before external calls to narrow replay and reentrancy surfaces.",
          "Exact approvals — approvals are scoped to the exact step amount and reset to zero on success and revert paths.",
          "Balance-delta checks — postconditions assert tracked output assets, recipient, min-out, and residual allowance.",
          "Private submission — designed so price-sensitive routes can route through private orderflow; the live bounded route submits from the owner's wallet today.",
          "Owner revoke — the owner can pause, invalidate nonce space, or emergency-exit without Hermes."
        ]
      },
      {
        "kind": "cards",
        "heading": "Threat model",
        "kicker": "WHAT WE ASSUME GOES WRONG",
        "cards": [
          {
            "title": "MEV / sandwiching",
            "body": "Strict min-out, short deadlines, and public receipt review today; private submission is planned.",
            "kicker": "orderflow"
          },
          {
            "title": "Approval leakage",
            "body": "Exact approvals, zero reset, post-exec allowance checks, and emergency exit.",
            "kicker": "allowance"
          },
          {
            "title": "Scope drift",
            "body": "Policy hash, adapter allowlist, chain-aware nonce, and typed intent domain.",
            "kicker": "scope"
          },
          {
            "title": "Relayer optionality",
            "body": "Fee caps, allowed submitters, self-submit fallback, and human approval gates.",
            "kicker": "submission"
          },
          {
            "title": "Oracle manipulation",
            "body": "Liquidity floors, TWAP sanity checks, and blocked protective zaps until review.",
            "kicker": "pricing"
          }
        ]
      },
      {
        "kind": "steps",
        "heading": "Production gates",
        "kicker": "NOT YET CLEARED",
        "intro": "Production-ready means the system fails closed across contract, interface, relayer, governance, monitoring, and incident-response layers. These gates are intentionally visible in the product.",
        "steps": [
          {
            "n": "P0",
            "title": "External audit",
            "body": "Independent review of factory, clone init, EIP-712/1271 verification, approval reset, and adapter boundaries.",
            "tag": "open"
          },
          {
            "n": "P1",
            "title": "Formal checks",
            "body": "Certora or equivalent prover run for AUTH, APPR, SURF, REC, ISO, and TOK invariants.",
            "tag": "open"
          },
          {
            "n": "P2",
            "title": "Adapter governance",
            "body": "Safe plus timelock ownership, adapter bytecode manifests, and rollback process.",
            "tag": "open"
          },
          {
            "n": "P3",
            "title": "Testnet soak",
            "body": "Public testnet with real wallet review, alerts, receipts, and revoke drills.",
            "tag": "open"
          },
          {
            "n": "P4",
            "title": "Incident runbook",
            "body": "Emergency pause, disclosure process, chain-monitor alerts, and postmortem template.",
            "tag": "open"
          }
        ]
      },
      {
        "kind": "facts",
        "heading": "Contracts",
        "kicker": "DEPLOYED ADDRESSES",
        "intro": "The page renders these addresses truncated to their first eight characters; full values come from the app config. The GitHub repo is private, so the block explorer is the only publicly readable source of truth for the contracts.",
        "facts": [
          {
            "label": "Security status",
            "value": "Live, pre-audit"
          },
          {
            "label": "Chain",
            "value": "Robinhood Chain"
          },
          {
            "label": "Chain id",
            "value": "4663"
          },
          {
            "label": "Factory",
            "value": "0xFC775017b25d2458623E2f3E735A4B750dD8b4E4 (shown as 0xFC7750...)"
          },
          {
            "label": "Adapter registry",
            "value": "0x9E56e444f490C00A6277326A47Cb462E12dF1f17 (shown as 0x9E56e4...)"
          },
          {
            "label": "Token allowlist",
            "value": "0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B (shown as 0x87fBb7...)"
          },
          {
            "label": "Contract source",
            "value": "Verified factory source, block explorer contract tab"
          },
          {
            "label": "Controls listed",
            "value": "6 (from controls)"
          },
          {
            "label": "Threats modeled",
            "value": "5 (from threats)"
          },
          {
            "label": "Production gates",
            "value": "5, P0–P4 (from gates)"
          }
        ]
      }
    ]
  },
  "docs": {
    "kicker": "DEVELOPER DOCS",
    "title": "Bounded execution, not broad wallet authority",
    "lede": "OpenZaps are policy capsules for agent-triggered DeFi. The current interface exposes a deterministic simulation API, review artifacts, and open bounded creation on Robinhood Chain. Scope deposits remain pre-external-audit, so explicit funds-at-risk warnings apply. Simulation never broadcasts a transaction and never asks for wallet authority.",
    "sections": [
      {
        "kind": "bounds",
        "kicker": "PRODUCTION STATUS",
        "heading": "What is live, and what is not",
        "intro": "Bounded creation is live pre-audit; deposits carry explicit funds-at-risk warnings. The v1.1 contracts are live on Robinhood Chain with one bounded route (aeWETH ↔ 0xZAPS).",
        "bounds": [
          "63 Foundry tests pass and 9 internal findings were fixed.",
          "No external audit, formal checks, adapter governance, testnet soak, or live wallet review has completed.",
          "Deposit only what you can afford to lose.",
          "Simulation never broadcasts a transaction and never asks for wallet authority.",
          "The policy binds a governed, allowlisted adapter — no arbitrary target plus calldata — but adapter governance itself has not completed.",
          "Spend and cadence ceilings are fixed in the policy. No unlimited looping.",
          "The recipient is the only address allowed to receive tracked output assets.",
          "The owner submits from their own wallet within signed limits today; Hermes-assisted and private submission are planned.",
          "Blocked policies cannot proceed; warned policies require review."
        ]
      },
      {
        "kind": "steps",
        "kicker": "EXECUTION LIFECYCLE",
        "heading": "Five phases, in order",
        "intro": "Every capsule moves through the same sequence. Nothing later in the list can widen what was bound earlier.",
        "steps": [
          {
            "n": "1",
            "title": "Draft policy",
            "body": "Select a template, authority model, spend ceiling, cadence, adapter, recipient, submitter, and postconditions.",
            "tag": "draft"
          },
          {
            "n": "2",
            "title": "Simulate",
            "body": "Run deterministic checks before any wallet prompt. Blocked policies cannot proceed; warned policies require review.",
            "tag": "no broadcast"
          },
          {
            "n": "3",
            "title": "Review signature",
            "body": "Bind chain, owner, recipient, nonce, deadline, policy hash, min-out, relayer fee cap, and postconditions.",
            "tag": "EIP-712"
          },
          {
            "n": "4",
            "title": "Submit",
            "body": "The owner submits from their own wallet within signed limits today; Hermes-assisted and private submission are planned.",
            "tag": "owner self-submit"
          },
          {
            "n": "5",
            "title": "Monitor and revoke",
            "body": "Receipts, allowance checks, balance deltas, alerts, and owner revoke paths stay attached to the capsule.",
            "tag": "revocable"
          }
        ]
      },
      {
        "kind": "facts",
        "kicker": "POLICY SCHEMA",
        "heading": "The signed object is deliberately boring",
        "intro": "Every field that could expand execution authority is present in the user-visible policy before a relayer can act.",
        "facts": [
          {
            "label": "authorityModel",
            "value": "deposit, intent, Safe/ERC-1271, or future session-key mode."
          },
          {
            "label": "recipient",
            "value": "The only address allowed to receive tracked output assets."
          },
          {
            "label": "amount / maxSpend / frequency",
            "value": "Spend and cadence ceilings. No unlimited looping."
          },
          {
            "label": "adapter",
            "value": "A governed, allowlisted adapter. No arbitrary target plus calldata."
          },
          {
            "label": "allowedSubmitters",
            "value": "Hermes, owner self-submit, or explicitly named relayers."
          },
          {
            "label": "postconditions",
            "value": "Balance deltas, allowance reset, recipient, and tracked-asset assertions."
          }
        ]
      },
      {
        "kind": "cards",
        "kicker": "POLICY TEMPLATES",
        "heading": "Four templates, three readiness levels",
        "intro": "4 templates (from POLICY_TEMPLATES). Status strings are the template's own production field.",
        "cards": [
          {
            "title": "Recurring DCA",
            "body": "A user pre-commits spend, frequency, recipient, slippage, relayer fee cap, and private submission for recurring ERC-20 buys.",
            "tag": "ready preview",
            "kicker": "AUTOMATION"
          },
          {
            "title": "Launch pool deposit",
            "body": "A bounded deposit policy for CliqueClaw or pool.fans launch pools, with a fixed recipient vault and no arbitrary calldata.",
            "tag": "requires review",
            "kicker": "LAUNCH"
          },
          {
            "title": "Claim and compound",
            "body": "A repeatable fee-claim policy for audited reward sources, exact approvals, and balance-delta postconditions.",
            "tag": "requires review",
            "kicker": "YIELD"
          },
          {
            "title": "Guarded exit",
            "body": "A protective policy for liquidity or oracle-risk exits. This is deliberately blocked in v1 until protective-zap review is complete.",
            "tag": "deferred",
            "kicker": "PROTECTION"
          }
        ]
      },
      {
        "kind": "facts",
        "kicker": "REFERENCE",
        "heading": "Addresses, endpoints, and surfaces",
        "intro": "The simulation route returns the normalized policy, policy hash, check status, deterministic quote estimate, relayer fee cap, gas envelope, and broadcast flag. It is suitable for CI, docs, and agent preflight checks. The eventual SDK should stay small: normalize policy input, simulate, prepare EIP-712 typed data, submit through an approved channel, and monitor receipts.",
        "facts": [
          {
            "label": "Chain",
            "value": "Robinhood Chain, id 4663 (config default; env-overridable)"
          },
          {
            "label": "Factory",
            "value": "0xFC775017b25d2458623E2f3E735A4B750dD8b4E4"
          },
          {
            "label": "Contract version",
            "value": "v1.1, live pre-audit"
          },
          {
            "label": "Bounded route",
            "value": "aeWETH ↔ 0xZAPS (one route)"
          },
          {
            "label": "Simulation endpoint",
            "value": "POST https://www.0xzaps.com/api/policies/simulate (from SITE_URL)"
          },
          {
            "label": "Simulation status values",
            "value": "pass | warn | block"
          },
          {
            "label": "Broadcast flag",
            "value": "broadcast: false"
          },
          {
            "label": "Templates",
            "value": "4 (from POLICY_TEMPLATES)"
          },
          {
            "label": "Foundry tests",
            "value": "63 pass"
          },
          {
            "label": "Internal findings fixed",
            "value": "9"
          },
          {
            "label": "Public source of truth",
            "value": "The verified contract source on the block explorer; the GitHub repo is private."
          },
          {
            "label": "SDK package",
            "value": "Not yet published. Local functions are split so they can graduate into a package."
          },
          {
            "label": "Token requirement",
            "value": "0xZAPS is not required to simulate or inspect policies."
          }
        ]
      }
    ]
  },
  "pricing": {
    "kicker": "PRICING AND PROTOCOL FEES",
    "title": "Fees must be as bounded as the policies",
    "lede": "OpenZaps should never hide execution economics. Users see gas, relayer fee caps, protocol-fee status, revocation paths, and token disclosures before they sign. The v1 protocol fee is disabled in v1. The clean v1 is not a hidden spread business — any future fee must be visible in the same typed policy payload.",
    "sections": [
      {
        "kind": "cards",
        "heading": "Commercial model",
        "kicker": "WHAT COSTS WHAT",
        "intro": "The user signs the max relayer fee, the app shows expected gas, and any future protocol fee must be visible in the same typed policy payload.",
        "cards": [
          {
            "title": "Simulation",
            "kicker": "Free",
            "body": "Local and API simulation should stay free so users can inspect policies before wallet review."
          },
          {
            "title": "Policy creation",
            "kicker": "Gas only (pre-audit)",
            "body": "Users pay chain gas. No protocol fee until external audit and governance activation."
          },
          {
            "title": "Hermes execution",
            "kicker": "Relayer fee cap",
            "body": "Planned: policies bind a max relayer fee before signing, so an automated submitter can never charge outside the cap. The live route sets the cap to zero and is self-submitted.",
            "tag": "Planned"
          },
          {
            "title": "Protocol fee",
            "kicker": "Governance-disabled v1",
            "body": "A future fee may apply to successful executions, but only after disclosure and wallet-level review."
          },
          {
            "title": "Enterprise operators",
            "kicker": "Custom",
            "body": "Roadmap: dedicated relayer lanes, compliance logs, policy review, and monitored revoke drills.",
            "tag": "Roadmap"
          }
        ]
      },
      {
        "kind": "cards",
        "heading": "Access tiers",
        "kicker": "THREE TIERS",
        "cards": [
          {
            "title": "Builder",
            "kicker": "Free",
            "body": "Design templates, simulate policies, inspect hashes, export JSON, and test the review flow."
          },
          {
            "title": "Operator",
            "kicker": "Relayer fee cap",
            "body": "Planned tier: Hermes-assisted submission within owner-signed caps. Today every transaction is submitted and confirmed from your own wallet.",
            "tag": "Planned"
          },
          {
            "title": "Protocol",
            "kicker": "Governance-set",
            "body": "Adapter governance, custom postconditions, dedicated monitoring, risk review, and launch-pool integrations."
          }
        ]
      },
      {
        "kind": "facts",
        "heading": "Fee and token reference",
        "kicker": "REFERENCE DATA",
        "intro": "Values as stated on the pricing page; token symbol is rendered from the shared TOKEN config.",
        "facts": [
          {
            "label": "v1 protocol fee",
            "value": "Disabled in v1"
          },
          {
            "label": "Simulation",
            "value": "Free"
          },
          {
            "label": "Policy creation",
            "value": "Gas only (pre-audit)"
          },
          {
            "label": "Live route relayer fee cap",
            "value": "Zero; self-submitted today (Hermes relaying is planned)"
          },
          {
            "label": "Token symbol",
            "value": "0xZAPS (from TOKEN config)"
          },
          {
            "label": "Paired with",
            "value": "aeWETH, in the first bounded live route"
          },
          {
            "label": "Convenience threshold",
            "value": "Holding 100,000+ 0xZAPS"
          }
        ]
      },
      {
        "kind": "bounds",
        "heading": "Token disclosure",
        "kicker": "WHAT 0xZAPS IS NOT",
        "intro": "0xZAPS is not a fee claim, yield promise, equity claim, or guarantee of access. It is the ERC-20 paired with aeWETH in the first bounded live route.",
        "bounds": [
          "Holding 100,000+ unlocks app-level conveniences: auto-refreshing quotes, extended history, receipt export.",
          "It grants no governance rights.",
          "It grants no staking.",
          "It grants no revenue share.",
          "It grants no protocol rights.",
          "Every core workflow stays fully usable without it.",
          "No protocol fee applies until external audit and governance activation.",
          "Any future protocol fee may apply only after disclosure and wallet-level review."
        ]
      }
    ]
  },
  "token": {
    "kicker": "0xZAPS TOKEN",
    "title": "0xZAPS: one contract, one route, no rights",
    "lede": "0xZAPS is an ERC-20 live on Robinhood Chain through Clanker. It is the token paired with aeWETH in OpenZaps' first bounded live route. Verify the exact contract before trading or adding it to a wallet. It grants no governance, staking, revenue, yield, equity, or fee rights.",
    "sections": [
      {
        "kind": "facts",
        "kicker": "REFERENCE",
        "heading": "The numbers that matter",
        "intro": "Token and network identity. Ticker, network, venue and decimals are rendered on the token page; the rest come from the site's canonical config (src/lib/config.ts).",
        "facts": [
          {
            "label": "Ticker",
            "value": "0xZAPS"
          },
          {
            "label": "Token name",
            "value": "OpenZaps"
          },
          {
            "label": "Token network",
            "value": "Robinhood Chain"
          },
          {
            "label": "Chain ID (config)",
            "value": "4663"
          },
          {
            "label": "Native currency (config)",
            "value": "ETH"
          },
          {
            "label": "Venue",
            "value": "Clanker V4"
          },
          {
            "label": "Decimals",
            "value": "18"
          },
          {
            "label": "Pair (config)",
            "value": "0xZAPS/aeWETH"
          },
          {
            "label": "Status (config)",
            "value": "Live"
          },
          {
            "label": "Total supply (config)",
            "value": "100000000000 — TOKEN.totalSupply; not displayed on the token page"
          },
          {
            "label": "Contract",
            "value": "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"
          }
        ]
      },
      {
        "kind": "steps",
        "kicker": "HOW TO BUY",
        "heading": "Three steps to 0xZAPS",
        "intro": "The page's own buy sequence. Order matters: verify the contract before you sign anything.",
        "steps": [
          {
            "n": "01",
            "title": "Open the official Clanker market",
            "body": "Use the market linked from this site and confirm it shows OpenZaps (0xZAPS).",
            "tag": "Clanker"
          },
          {
            "n": "02",
            "title": "Verify the contract",
            "body": "Match the token contract exactly: 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07. Do not trade a lookalike ticker.",
            "tag": "Required"
          },
          {
            "n": "03",
            "title": "Trade 0xZAPS",
            "body": "Connect through Clanker's supported wallet flow, review the Robinhood Chain transaction, and confirm it in your wallet.",
            "tag": "Sign"
          }
        ]
      },
      {
        "kind": "cards",
        "kicker": "WHAT IT'S FOR",
        "heading": "Only the utility that exists today",
        "intro": "Every utility below is implemented and live right now. No governance, staking, fee share, revenue claim, equity, yield, or returns are represented.",
        "cards": [
          {
            "title": "A bounded route asset",
            "body": "The live OpenZaps v1.1 adapter supports one pinned Robinhood v4 pool: aeWETH ↔ 0xZAPS. The app builds immutable one-route policy capsules around it.",
            "kicker": "Route",
            "tag": "v1.1 adapter"
          },
          {
            "title": "Holder utilities, live in the app",
            "body": "Hold 100,000+ 0xZAPS in your connected wallet and the app console unlocks auto-refreshing live quotes, extended zap history (50 slots; 100 at 1,000,000+), longer receipt retention, and one-click receipt JSON export. App-level conveniences, checked against your live balance — not protocol rights.",
            "kicker": "App console",
            "tag": "100,000+"
          },
          {
            "title": "Wallet-readable ERC-20",
            "body": "Use the exact Robinhood Chain address, 18 decimals, and the add-to-wallet utility on the token page. Wallet support varies.",
            "kicker": "Wallet",
            "tag": "18 decimals"
          },
          {
            "title": "No invented rights",
            "body": "The token does not grant protocol governance, staking, revenue, yield, equity, or fee rights. Every core OpenZaps workflow — create, fund, execute, recover — works without holding it.",
            "kicker": "Scope",
            "tag": "Optional"
          }
        ]
      },
      {
        "kind": "bounds",
        "kicker": "WHAT IT ISN'T",
        "heading": "Stated limits",
        "intro": "Hedges and refusals carried over from the page verbatim in substance.",
        "bounds": [
          "The token does not grant protocol governance, staking, revenue, yield, equity, or fee rights.",
          "You do not need the token to use OpenZaps. Create, fund, execute, and recover all work without it.",
          "No external audit is published for the OpenZap v1.1 protocol contracts. The app labels the live workflow pre-external-audit; deposited funds are at risk.",
          "Onchain actions are irreversible; the protocol is pre-external-audit.",
          "Not financial advice. 0xZAPS is an ERC-20 with no claim on revenue, yield, or assets.",
          "Tickers and screenshots can be copied. The Clanker market and the Robinhood Chain contract are the canonical references.",
          "Live market data can change at any time.",
          "Wallet support for add-to-wallet varies."
        ]
      },
      {
        "kind": "facts",
        "kicker": "VERIFY BEFORE TRADING",
        "heading": "One contract. One official market.",
        "intro": "The canonical references. The first four are the links the token page's verify list points at; the RPC endpoint is from config and is not linked on the page. The address is the highest-stakes string on the site.",
        "facts": [
          {
            "label": "Contract",
            "value": "https://robinhoodchain.blockscout.com/token/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"
          },
          {
            "label": "Official market",
            "value": "Clanker V4 — https://www.clanker.world/clanker/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"
          },
          {
            "label": "Live chart",
            "value": "Dexscreener — https://dexscreener.com/robinhood/0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573"
          },
          {
            "label": "Network explorer",
            "value": "https://robinhoodchain.blockscout.com"
          },
          {
            "label": "Network RPC (config only)",
            "value": "https://rpc.mainnet.chain.robinhood.com"
          }
        ]
      }
    ]
  },
  "roadmap": {
    "kicker": "ROADMAP",
    "title": "Ship the primitive without widening the trust boundary",
    "lede": "OpenZaps can become the wallet primitive for agent-native DeFi, but only if each release keeps execution authority explicit, inspectable, and revocable. The release path runs from the live v1.1 console through broader bounded routes, an external audit milestone, private Hermes execution, and a reusable policy market.",
    "sections": [
      {
        "kind": "steps",
        "heading": "Release path",
        "kicker": "FIVE PHASES",
        "intro": "Five phases as listed on the page, in order, from what is live today to a reusable policy market.",
        "steps": [
          {
            "n": "01",
            "title": "Live Robinhood v1.1",
            "tag": "Now",
            "body": "Wallet connection, live v4 quotes, deterministic clones, EIP-712 execution, receipts, owner recovery, the live activity dashboard, and 0xZAPS holder utilities in the app."
          },
          {
            "n": "02",
            "title": "Broader bounded routes",
            "tag": "Next",
            "body": "More policy templates, additional governed adapters, and Hermes-assisted submission within owner-signed caps."
          },
          {
            "n": "03",
            "title": "External audit milestone",
            "tag": "Hardening",
            "body": "Third-party audit, formal verification, testnet soak, adapter manifests, governance runbook, and incident drills — planned hardening, not a product gate."
          },
          {
            "n": "04",
            "title": "Hermes private execution",
            "tag": "Beta",
            "body": "Allowlisted submitters, private submission, monitoring receipts, alert delivery, and owner self-submit fallback."
          },
          {
            "n": "05",
            "title": "Reusable policy market",
            "tag": "Network",
            "body": "Policy template registry, agent reputation, eval results, SDK publishing, and pool.fans / CliqueClaw integrations."
          }
        ]
      },
      {
        "kind": "bounds",
        "heading": "Non-negotiables",
        "kicker": "WHAT STAYS FIXED",
        "intro": "Constraints the page states alongside the release path.",
        "bounds": [
          "ERC-20 first until callback and multi-asset accounting risks are reviewed.",
          "Protective zaps stay blocked until oracle, liquidity, and liquidation risk controls are externally reviewed.",
          "Every fee must be visible in the typed policy before signing.",
          "Every automation needs pause, revoke, audit, and self-submit fallback paths."
        ]
      },
      {
        "kind": "facts",
        "heading": "Where things stand",
        "kicker": "PAGE REFERENCE",
        "intro": "Values as stated on the roadmap page today.",
        "facts": [
          {
            "label": "Current release",
            "value": "Live v1.1 console"
          },
          {
            "label": "Phases on the release path",
            "value": "5"
          },
          {
            "label": "Non-negotiables listed",
            "value": "4"
          },
          {
            "label": "Audit status",
            "value": "Pre-audit — third-party audit is a planned hardening milestone, not a product gate"
          },
          {
            "label": "Page path",
            "value": "/roadmap"
          },
          {
            "label": "Linked next reads",
            "value": "/docs, /security"
          }
        ]
      }
    ]
  }
};
