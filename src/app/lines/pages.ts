import type { PageContent } from "./LinesSections";

/**
 * Copy for every interior LINES page.
 *
 * Extracted from the real pages it mirrors and then fact-checked back against
 * them, so the preview cannot make a claim the product does not. Regenerated
 * after the site copy was rewritten upstream — the previous version described
 * pages that no longer exist in that form, and several of its claims had gone
 * stale in the direction that flatters the product, which is the direction that
 * matters.
 *
 * Where a number comes from a catalog the value says so, because the catalog is
 * what moves; the figure here is a snapshot of it, not a second source of truth.
 *
 * Anything genuinely live — balances, executions, capsule state — is absent by
 * design. Those surfaces stay on the real site rather than being restyled with
 * invented numbers.
 */
export const PAGES: Record<string, PageContent> = {
  "build": {
    "kicker": "Zap builder",
    "title": "A block only seats where the shapes match.",
    "lede": "Every DeFi activity here is a block that declares its connectors: a source emits a shape, a settlement block takes one, and everything between does both. A joint seats only when the shape leaving the block above is the shape the block below takes, so dragging cannot assemble a mismatched chain. A shared link can still carry one, and the readout names the joint that does not fit. Nothing here signs, funds, or broadcasts anything.",
    "sections": [
      {
        "kind": "bounds",
        "kicker": "Refusals",
        "heading": "What the canvas will not do",
        "intro": "The canvas designs zaps. It does not deploy them. A chain that seats here compiles and simulates; the panel on the right names which kind of thing you have.",
        "bounds": [
          "Dragging cannot assemble a mismatched chain. A joint seats only when the shape leaving the block above is the shape the block below takes.",
          "A shared link can still carry a chain that does not seat. The readout names the joint that does not fit, and the deploy path forwards the compiler's structural faults — orphan and mismatch — and rejects the design by name.",
          "The only route the live contracts can carry is a single-step aeWETH ↔ 0xZAPS swap, with the recipient forced to the owner and the relayer fee cap at zero. Anything else saves as a design.",
          "Multi-step chains cannot be deployed. The v1.1 capsule executes exactly one step, and a design with more than one action is rejected with the count and the block names.",
          "A cadence is not expressible. Recurring deposit sets a schedule; the v1.1 capsule holds one signed step that executes once, and nothing onchain would repeat it.",
          "Pending rewards emits a claimable, not tokens. The live route can only spend an ERC-20 amount pulled from the owner wallet, so there is nothing for it to swap.",
          "Hold in zap, Hold position and Loop back each fail for their own reason: the policy forces recipient = owner wallet so the output always leaves the capsule; the live route ends on an ERC-20 balance sent to that wallet, never on an open liquidity position; and a single signed step has no compounding — it executes once and settles.",
          "Send to a custom address is not deployable. The live policy hardcodes recipient = owner wallet.",
          "Venues other than Uniswap v4 have no adapter on the live route, and no pair other than aeWETH ↔ 0xZAPS is supported.",
          "The gas figure is an estimate — the sum of this build's per-block gas constants, seeded at 21,000 by the compiler. Nothing here was simulated against a node.",
          "The design fingerprint is a local FNV-1a checksum that tells two designs apart. It is not the onchain policy hash — a deployed capsule commits to a keccak256 hash of its ABI-encoded policy — so it will not match anything on a block explorer.",
          "Every reason for a rejection is collected rather than short-circuited on the first, because someone fixing a design needs the whole list.",
          "The protocol posture is pre-audit (STATUS.preAudit is true in config.ts). The Base v1 addresses that still sit in config are labelled historical and are not used by the production app; the live deployable route set remains exactly one."
        ]
      },
      {
        "kind": "facts",
        "kicker": "Catalog",
        "heading": "What is actually in the build",
        "intro": "Literal current values, read out of the catalog and the deployability mapper.",
        "facts": [
          {
            "label": "Blocks in the palette",
            "value": "25 (from BLOCKS)"
          },
          {
            "label": "Connector shapes",
            "value": "5 — ERC-20, LP position, Vault share, Claimable, Debt line"
          },
          {
            "label": "Palette categories",
            "value": "8 — Sources, Swap & route, Lend & borrow, Liquidity, Yield, Bridge, Guards, Settlement"
          },
          {
            "label": "Blueprints",
            "value": "7 (from RECIPES). Exactly one carries the deployable badge — Live route — and that badge is derived from the same reducer the deploy panel uses, not declared on the recipe."
          },
          {
            "label": "The one deployable route",
            "value": "aeWETH ↔ 0xZAPS, one step, through Uniswap v4, settled to the owner wallet, relayer fee cap 0"
          },
          {
            "label": "Chain",
            "value": "Robinhood Chain, chain id 4663 (CHAIN in config.ts)"
          },
          {
            "label": "Guard blocks",
            "value": "6 (from BLOCKS). Five of them are not enforced onchain."
          },
          {
            "label": "Builder's slippage guard",
            "value": "5–500 bps, stepping in fives"
          },
          {
            "label": "What the live app can sign",
            "value": "10–500 bps, stepping in tens (MIN/MAX/STEP in deployable.ts)"
          },
          {
            "label": "Cap signed when a design states none",
            "value": "100 bps (DEFAULT_SLIPPAGE_BPS)"
          },
          {
            "label": "When several caps are placed",
            "value": "The tightest governs. Chain order never decides it."
          },
          {
            "label": "What the v1.1 policy binds",
            "value": "Owner, recipient, adapter, spender, input token, exact amount — and nothing else."
          }
        ]
      },
      {
        "kind": "cards",
        "kicker": "Guards",
        "heading": "Guards you can draw, and what survives deployment",
        "intro": "Each of these reads, in the builder, like a safety property. Only one of them is carried into the live handoff, and even that one is not in the v1.1 policy's binding list. Every drop is listed in full beside the deploy button — counted in the heading, then named one by one, never summarised away.",
        "cards": [
          {
            "title": "Price band",
            "tag": "Not enforced",
            "kicker": "guard-oracle",
            "body": "Designed to read an allowlisted oracle before execution and refuse to run outside the band. The v1.1 policy has no oracle precondition, so nothing checks the band before execution."
          },
          {
            "title": "Time window",
            "tag": "Not enforced",
            "kicker": "guard-window",
            "body": "Designed to bound execution to a cadence and a deadline. The v1.1 policy has no expiry or cadence field. A deployed capsule stays executable until you withdraw or recover it."
          },
          {
            "title": "Spend ceiling",
            "tag": "Not enforced",
            "kicker": "guard-spend",
            "body": "Designed to cap total outflow across every run. The v1.1 policy tracks no cumulative budget. The only onchain bound a deployed capsule carries is the single step amount you sign."
          },
          {
            "title": "Human gate",
            "tag": "Not enforced",
            "kicker": "guard-approval",
            "body": "Designed to make every execution wait for a fresh signature. The v1.1 policy has no per-run approval step, so the signed policy is the only authority, bounded by its amount."
          },
          {
            "title": "Private submission",
            "tag": "Not enforced",
            "kicker": "guard-private",
            "body": "Designed to send through a private relay so a searcher cannot see the pending transaction before it lands. The v1.1 policy cannot bind a submitter, so whoever executes the capsule chooses the mempool path."
          },
          {
            "title": "Slippage cap",
            "tag": "Carried over, rounded",
            "kicker": "guard-slippage",
            "body": "Converts to a minimum-out on every priced step downstream, and anything worse reverts the chain. It is the one guard the handoff carries — it fills in the app page's signed slippage cap — but the builder steps in fives and the app signs in tens, so a cap the slider cannot hold is rounded, clamped to 10–500 bps, and the change is stated with both numbers."
          }
        ]
      },
      {
        "kind": "steps",
        "kicker": "Handoff",
        "heading": "From a design to a signature",
        "intro": "The order matters: the compiler decides whether the chain seats before anything decides whether it deploys.",
        "steps": [
          {
            "n": "01",
            "title": "Load a blueprint, or start from a source",
            "tag": "Canvas",
            "body": "One kind of zap per blueprint; the one marked deployable is the only shape the live contracts can carry. Then rebuild piece by piece — drag a block into the chain, or tap it, which seats it at the deepest slot that fits, so a tap appends rather than splices."
          },
          {
            "n": "02",
            "title": "The chain compiles as you edit",
            "tag": "Verdict",
            "body": "Every joint is checked against the shape above it. The verdict reads Ready to simulate, Needs a review, or Will not compile, and every issue the compiler raised is listed — not just the first. Each one that names a block is a button that goes there."
          },
          {
            "n": "03",
            "title": "Guard coverage names what is missing",
            "tag": "Gaps",
            "body": "The risks the placed blocks introduce each demand a specific guard: a priced trade demands a slippage cap, a repeated draw demands a spend ceiling, leverage demands a price band, a standing authority demands a time window. Each gap names the risk that opened it and offers the piece that closes it."
          },
          {
            "n": "04",
            "title": "The design either reduces to the live route, or it does not",
            "tag": "Reduction",
            "body": "One place decides, and it is deliberately strict: everything it cannot map is rejected by name rather than quietly approximated. If the design does not reduce, you get the full list and a Save as design button instead of a deploy link."
          },
          {
            "n": "05",
            "title": "You create, fund, and sign on the app page",
            "tag": "Off this page",
            "body": "A deployable design opens the app page with the direction, the amount and the signed slippage cap filled in, and every unenforced guard printed in the button's own line of sight. Nothing is submitted from here."
          }
        ]
      }
    ]
  },
  "security": {
    "kicker": "Security architecture",
    "title": "What an executor cannot choose.",
    "lede": "A capsule holds funds and accepts owner-signed intents that rehash to the policy frozen at creation. The adapter, the spender, the recipient, the input token, and the exact amount are fixed at that moment. An executor picks the moment and nothing else. The contracts have not been externally audited.",
    "sections": [
      {
        "kind": "steps",
        "kicker": "Architecture",
        "heading": "The path a capsule takes",
        "intro": "A user or Safe creates a per-policy capsule through the factory. The capsule holds the funds. It accepts owner-signed intents, and only those that rehash to the policy hash frozen at creation. Whoever submits cannot choose the target, the recipient, the asset, or the calldata, because the policy already named them and any substitution changes the hash. Today that submitter is the owner, from their own wallet.",
        "steps": [
          {
            "n": "01",
            "title": "User / Safe",
            "body": "The owner, or a Safe, starts the creation. Today the submitter is the owner, from their own wallet.",
            "tag": "Owner"
          },
          {
            "n": "02",
            "title": "OpenZapFactory",
            "body": "A user or Safe creates a per-policy capsule through the factory.",
            "tag": "Factory"
          },
          {
            "n": "03",
            "title": "OpenZap clone with frozen policy",
            "body": "The clone holds the funds. The policy hash is frozen at creation, and only intents that rehash to it are accepted.",
            "tag": "Clone"
          },
          {
            "n": "04",
            "title": "Allowlisted adapter",
            "body": "The capsule calls an allowlisted adapter with the selector the policy names. There is no field for an arbitrary target plus calldata.",
            "tag": "Adapter"
          },
          {
            "n": "05",
            "title": "Recipient-bound postcondition",
            "body": "After the adapter returns, the capsule asserts the tracked output asset, the recipient, the minimum output, and that no allowance remains. Beside this path the page names the Hermes sequence: simulate, submit, monitor, alert, revoke escalation, with no discretionary custody and no arbitrary calldata.",
            "tag": "Postcondition"
          }
        ]
      },
      {
        "kind": "bounds",
        "kicker": "Controls",
        "heading": "Controls the page states",
        "intro": "Six control rows. Five are properties the contract enforces; the fifth, submitter binding, is the page naming something the v1.1 policy does not enforce.",
        "bounds": [
          "No arbitrary calls. The capsule calls an allowlisted adapter with the selector the policy names. There is no field for an arbitrary target plus calldata, so there is nothing to point at one.",
          "Nonce consumed first. The authorization is consumed before any external call. A reentrant call back into the capsule finds the nonce already spent.",
          "Exact approvals. The approval is the exact step amount, and it is reset to zero on the success path and the revert path. No standing allowance is left for anyone to draw on later.",
          "Balance-delta checks. After the adapter returns, the capsule asserts the tracked output asset, the recipient, the minimum output, and that no allowance remains. A failed assertion reverts the whole execution.",
          "Submitter is not bound. The v1.1 policy has no submitter field, so whoever executes the capsule chooses the mempool path. The live bounded route is submitted from the owner's own wallet.",
          "Owner revoke. The owner can pause, invalidate nonce space, or emergency-exit without an agent. The withdraw and revoke path is unconditional and needs no one else's cooperation."
        ]
      },
      {
        "kind": "cards",
        "kicker": "Threat model",
        "heading": "What an executor could still try",
        "intro": "Each of these remains possible inside the signed limits. The bound is stated, not the reassurance.",
        "cards": [
          {
            "title": "MEV / sandwiching",
            "body": "A searcher who sees the pending execution can move the pool price against it. The signed minimum output and the ten-minute intent deadline bound what that is worth; the capsule cannot hide the transaction, because the policy cannot bind a submitter.",
            "tag": "Bounded, not prevented"
          },
          {
            "title": "Approval leakage",
            "body": "An adapter that kept an allowance could spend from the capsule again later. The approval is the exact step amount and is reset to zero on both paths, and a residual allowance fails the postcondition.",
            "tag": "Reset on both paths"
          },
          {
            "title": "Scope drift",
            "body": "A submitter who edits a policy field before broadcasting produces a different policy hash, and the capsule rejects the intent. A chain-aware nonce and the typed-data domain make an intent signed elsewhere useless here.",
            "tag": "Rejected by hash"
          },
          {
            "title": "Relayer optionality",
            "body": "A relayer can delay, censor, or pick a bad moment inside the signed limits. It cannot take a fee on the live route: the policy commits a relayer fee cap of zero. The owner can always submit the transaction themselves.",
            "tag": "Fee cap zero"
          },
          {
            "title": "Oracle manipulation",
            "body": "The v1.1 policy has no oracle precondition, so a design that depends on a price band is not enforced by it. Protective exits stay blocked in v1 for that reason.",
            "tag": "Not enforced in v1"
          }
        ]
      },
      {
        "kind": "cards",
        "kicker": "Production gates",
        "heading": "None of the following has completed",
        "intro": "None of the following has completed. Each one is a precondition for calling the contracts production-cleared. Until they have, the only thing standing behind a failure in the contract, the interface, the relayer path, or the adapter registry is the owner's exit.",
        "cards": [
          {
            "title": "External audit",
            "body": "Independent review of factory, clone init, EIP-712/1271 verification, approval reset, and adapter boundaries.",
            "kicker": "P0",
            "tag": "Not complete"
          },
          {
            "title": "Formal checks",
            "body": "A prover run over the authorization, approval-reset, call-surface, recipient, isolation, and token-allowlist invariants.",
            "kicker": "P1",
            "tag": "Not complete"
          },
          {
            "title": "Adapter governance",
            "body": "Safe plus timelock ownership, adapter bytecode manifests, and a rollback process.",
            "kicker": "P2",
            "tag": "Not complete"
          },
          {
            "title": "Testnet soak",
            "body": "Public testnet with real wallet review, alerts, receipts, and revoke drills.",
            "kicker": "P3",
            "tag": "Not complete"
          },
          {
            "title": "Incident runbook",
            "body": "Emergency pause, disclosure process, chain-monitor alerts, and postmortem template.",
            "kicker": "P4",
            "tag": "Not complete"
          }
        ]
      },
      {
        "kind": "facts",
        "kicker": "Contracts",
        "heading": "Current posture and addresses",
        "intro": "The contracts have not been externally audited. Bounded aeWETH / 0xZAPS creation is open on Robinhood Chain, and the funds a capsule holds are real. Production use still needs external audit, formal verification, adapter governance, and a monitored launch path. Onchain actions are irreversible: once an execution lands, nothing here can undo it. The owner keeps an unconditional withdraw and revoke path. Deposit only what you can afford to lose.",
        "facts": [
          {
            "label": "Audit status",
            "value": "Live, not externally audited (STATUS.preAudit is true in config.ts)"
          },
          {
            "label": "Network",
            "value": "Robinhood Chain, chain id 4663 (CHAIN in config.ts; both env-overridable)"
          },
          {
            "label": "Live route",
            "value": "Exactly one bounded route: a single-step aeWETH / 0xZAPS swap through one adapter, recipient forced to the owner (deployable.ts)"
          },
          {
            "label": "Submitter today",
            "value": "The owner, from their own wallet"
          },
          {
            "label": "Relayer fee cap",
            "value": "Zero, committed in the policy (maxRelayerFeeCap 0 on the live route)"
          },
          {
            "label": "Intent deadline",
            "value": "Ten minutes (the app signs now + 10 * 60)"
          },
          {
            "label": "Factory",
            "value": "0xFC775017b25d2458623E2f3E735A4B750dD8b4E4, shown on the page truncated to 0xFC7750..."
          },
          {
            "label": "Adapter registry",
            "value": "0x9E56e444f490C00A6277326A47Cb462E12dF1f17, shown truncated to 0x9E56e4..."
          },
          {
            "label": "Token allowlist",
            "value": "0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B, shown truncated to 0x87fBb7..."
          },
          {
            "label": "Explorer links",
            "value": "The truncated addresses are static text; separate View factory and Contract source buttons link to the Blockscout explorer"
          }
        ]
      }
    ]
  },
  "docs": {
    "kicker": "Developer docs",
    "title": "Everything an execution can do is fixed before you sign it.",
    "lede": "An OpenZap is a contract that holds funds and executes one policy its owner signed. This page documents the policy fields, the simulation API, and the execution lifecycle. The contracts have not been externally audited. Onchain actions are irreversible, so deposit only what you can afford to lose.",
    "sections": [
      {
        "kind": "bounds",
        "heading": "Audit status and standing limits",
        "kicker": "What is bound, and what is not",
        "intro": "The v1.1 contracts are live on Robinhood Chain (chain id 4663). The factory is 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4. Each line below is a limit the page or the route-reduction code states, some enforced by the contract and some only by the app.",
        "bounds": [
          "The contracts have not been externally audited. No formal verification, adapter governance, testnet soak, or live wallet review has completed either. Deposited funds are at risk.",
          "The live contracts carry one bounded route: a single-step aeWETH ↔ 0xZAPS swap through one adapter, which routes through Uniswap v4. Recipient is forced to the owner, and the relayer fee cap is set to zero.",
          "The owner keeps an unconditional withdraw and revoke path.",
          "The typed intent binds chain, owner, recipient, nonce, deadline, policy hash, min-out, relayer fee cap, and gas price. None of them can change after signing.",
          "A field that is not in the policy is not enforced by the contract.",
          "There is no field for an arbitrary target plus calldata, so there is nothing to point at one.",
          "Session keys are not enabled; the simulator blocks them.",
          "The v1.1 policy cannot bind a submitter, so whoever executes the capsule chooses the mempool path.",
          "The v1.1 capsule binds the single step amount and tracks no cumulative budget or schedule.",
          "A design that does not reduce to the live route saves as a design and cannot be deployed today.",
          "Simulation never broadcasts a transaction and never asks for wallet authority.",
          "A blocked policy does not proceed. A warned policy proceeds only after review.",
          "A capsule page at /zaps/<address> reports what the contract stores and what its own logs say, and nothing else."
        ]
      },
      {
        "kind": "facts",
        "heading": "Policy schema",
        "kicker": "The signed object, field by field",
        "intro": "The signed object is small on purpose. Any field that could widen what an execution may do is in the policy the owner reads before signing.",
        "facts": [
          {
            "label": "authorityModel",
            "value": "deposit, intent, or Safe/ERC-1271. Session keys are not enabled; the simulator blocks them."
          },
          {
            "label": "recipient",
            "value": "The only address allowed to receive tracked output assets. On the live route it is forced to the owner."
          },
          {
            "label": "amount / maxSpend / frequency",
            "value": "Draft spend and cadence fields. The v1.1 capsule binds the single step amount and tracks no cumulative budget or schedule."
          },
          {
            "label": "adapter",
            "value": "An allowlisted adapter. There is no field for an arbitrary target plus calldata, so there is nothing to point at one."
          },
          {
            "label": "allowedSubmitters",
            "value": "A draft field. The v1.1 policy cannot bind a submitter, so whoever executes the capsule chooses the path."
          },
          {
            "label": "postconditions",
            "value": "Balance-delta, allowance-reset, recipient, and tracked-asset assertions, checked after the adapter returns. A failed assertion reverts the execution."
          }
        ]
      },
      {
        "kind": "steps",
        "heading": "Execution lifecycle",
        "kicker": "Draft to revoke, in order",
        "intro": "Five phases. Order carries meaning: nothing reaches a wallet prompt before the deterministic checks run, and nothing is bound until the typed intent is signed.",
        "steps": [
          {
            "n": "1",
            "title": "Draft policy",
            "body": "Pick a template and fill the draft fields: authority model, spend ceiling, cadence, adapter, recipient, submitter, and postconditions.",
            "tag": "Draft"
          },
          {
            "n": "2",
            "title": "Simulate",
            "body": "Deterministic checks run before any wallet prompt. A blocked policy does not proceed. A warned policy proceeds only after review.",
            "tag": "No broadcast"
          },
          {
            "n": "3",
            "title": "Review signature",
            "body": "The typed intent binds chain, owner, recipient, nonce, deadline, policy hash, min-out, relayer fee cap, and gas price. None of them can change after signing.",
            "tag": "EIP-712"
          },
          {
            "n": "4",
            "title": "Submit",
            "body": "The owner submits from their own wallet. The v1.1 policy cannot bind a submitter, so whoever executes chooses the mempool path.",
            "tag": "Owner-submitted"
          },
          {
            "n": "5",
            "title": "Monitor and revoke",
            "body": "Receipts, allowance checks, balance deltas, alerts, and the owner's revoke and exit paths stay attached to the capsule. Its page at /zaps/<address> reports what the contract stores and what its own logs say, and nothing else.",
            "tag": "Ongoing"
          }
        ]
      },
      {
        "kind": "cards",
        "heading": "Policy templates",
        "kicker": "4 (from POLICY_TEMPLATES)",
        "intro": "The docs page renders the template catalog directly. The count is 4 (from POLICY_TEMPLATES), and each card's status is the literal production value on the template, with the hyphen replaced by a space. Only one is marked ready preview.",
        "cards": [
          {
            "title": "Recurring DCA",
            "kicker": "automation",
            "tag": "ready preview",
            "body": "Recurring ERC-20 buys, with spend, cadence, recipient, slippage, and relayer fee cap stated before signing. The live v1.1 capsule holds one signed step that executes once, so it cannot carry the cadence."
          },
          {
            "title": "Launch pool deposit",
            "kicker": "launch",
            "tag": "requires review",
            "body": "A deposit into one named launch pool, with the recipient vault fixed and no arbitrary calldata. The live contracts carry a single-step aeWETH ↔ 0xZAPS swap and nothing else, so this template simulates and does not deploy."
          },
          {
            "title": "Claim and compound",
            "kicker": "yield",
            "tag": "requires review",
            "body": "Claims a reward and routes it into an approved asset, with exact approvals and balance-delta postconditions. A claim is two steps, and the live capsule executes one, so this is a draft shape rather than a route."
          },
          {
            "title": "Guarded exit",
            "kicker": "protection",
            "tag": "deferred",
            "body": "An exit triggered by a liquidity or oracle condition. The v1.1 policy has no oracle precondition, so nothing onchain could evaluate the trigger. Blocked in v1 until protective-zap review is complete."
          }
        ]
      },
      {
        "kind": "cards",
        "heading": "Interfaces",
        "kicker": "Builder, API, SDK",
        "intro": "Three ways in, each with its own limit stated up front.",
        "cards": [
          {
            "title": "Quickstart and the visual builder",
            "kicker": "/build → /app",
            "tag": "One deployable route",
            "body": "The visual builder is at /build. It compiles a design and names every guard the live policy does not bind. A design that reduces to the live route hands /app a prefilled direction, amount, and slippage cap. Anything else saves as a design and cannot be deployed today. An agent, a backend, or a Mini App can call the simulation API instead. Simulation never broadcasts a transaction and never asks for wallet authority."
          },
          {
            "title": "Simulation API",
            "kicker": "POST /api/policies/simulate",
            "tag": "broadcast: false",
            "body": "Returns the normalized policy, a hash, the check results, an estimated output, a relayer fee cap, a gas envelope, and broadcast: false. It never submits anything, so it is safe to run in CI or as an agent preflight. The hash is a local checksum that tells two drafts apart; it is not the onchain policy hash. The estimate is computed from fixed rates held in this app, not read from a pool, so it is not a price."
          },
          {
            "title": "SDK surface",
            "kicker": "@openzaps/sdk",
            "tag": "Does not resolve",
            "body": "There is no published package. The import shown in the docs does not resolve today; it shows the surface the local functions expose: normalize policy input, simulate, prepare EIP-712 typed data, submit through an approved channel, and monitor receipts. What actually executes is the deployed contract, not this surface. Read the verified source before signing anything. 0xZAPS is not required to simulate or inspect a policy."
          }
        ]
      }
    ]
  },
  "pricing": {
    "kicker": "Pricing",
    "title": "What you pay today is gas.",
    "lede": "There is no protocol fee in v1. The live route sets the relayer fee cap to zero, so no execution of it can pay a submitter. You see the expected gas, the fee cap, the recipient, and the revocation path before the wallet is asked to sign anything.",
    "sections": [
      {
        "kind": "bounds",
        "kicker": "Commercial model",
        "heading": "There is no spread.",
        "intro": "The user signs the maximum relayer fee, the app shows the expected gas, and any future protocol fee has to be visible in the same typed policy payload before that payload can be signed.",
        "bounds": [
          "There is no protocol fee in v1. No protocol fee is charged on any execution — there is no protocol-fee field anywhere in the app's policy code to charge one with.",
          "The live route sets the relayer fee cap to zero, so no execution of it can pay a submitter. The policy the app builds commits maxRelayerFeeCap = 0, and the app refuses to read any capsule whose cap is not 0.",
          "There is exactly one deployable route: a single-step aeWETH ↔ 0xZAPS swap through one adapter, recipient forced to the owner wallet. Every other design the builder can express is rejected by name rather than approximated.",
          "A policy binds a maximum relayer fee before it is signed, so a submitter cannot charge outside the cap.",
          "A future protocol fee would have to appear in the same typed policy payload the user signs.",
          "Simulation never broadcasts a transaction and never asks for wallet authority.",
          "The expected gas, the fee cap, the recipient, and the revocation path are shown before the wallet is asked to sign anything.",
          "The contracts have not been externally audited."
        ]
      },
      {
        "kind": "cards",
        "kicker": "Fee table",
        "heading": "What each line actually costs",
        "cards": [
          {
            "title": "Simulation",
            "tag": "Free",
            "body": "Simulation runs locally and through the API. It never broadcasts a transaction and never asks for wallet authority."
          },
          {
            "title": "Policy creation",
            "tag": "Gas only",
            "body": "You pay chain gas to create and fund a capsule. No protocol fee is taken. The contracts have not been externally audited."
          },
          {
            "title": "Relayer execution",
            "tag": "Cap of zero",
            "body": "A policy binds a maximum relayer fee before it is signed, so a submitter cannot charge outside the cap. The live route sets that cap to zero, which means no execution of it can pay a relayer at all."
          },
          {
            "title": "Protocol fee",
            "tag": "Disabled in v1",
            "body": "No protocol fee is charged on any execution. A future fee would have to appear in the same typed policy payload the user signs."
          },
          {
            "title": "Enterprise operators",
            "tag": "Not built",
            "body": "Dedicated submission lanes, compliance logs, policy review, and revoke drills are on the roadmap. None of them exist yet, and none has a date."
          }
        ]
      },
      {
        "kind": "cards",
        "kicker": "Access tiers",
        "heading": "One tier exists. Two do not.",
        "cards": [
          {
            "title": "Builder",
            "tag": "Free",
            "body": "Design a chain, simulate a policy, read the compiled checks, and export JSON. No wallet is asked for anything, and nothing is broadcast."
          },
          {
            "title": "Operator",
            "tag": "Not live",
            "body": "Assisted submission within owner-signed caps is planned. It does not exist. Today every transaction is submitted and confirmed from your own wallet."
          },
          {
            "title": "Protocol",
            "tag": "Not live",
            "body": "Adapter governance, custom postconditions, and dedicated monitoring are planned. None of them is available today."
          }
        ]
      },
      {
        "kind": "bounds",
        "kicker": "Token disclosure",
        "heading": "0xZAPS is not a fee claim, yield promise, equity claim, or guarantee of access.",
        "intro": "0xZAPS is an ERC-20 with no claim on revenue, yield, or assets. It is the asset paired with aeWETH in the one live route.",
        "bounds": [
          "No claim on revenue, yield, or assets.",
          "No governance, staking, revenue share, or protocol rights.",
          "Holding 100,000+ 0xZAPS turns on app conveniences: auto-refreshing quotes, more saved zaps and receipts, and receipt JSON export.",
          "Those conveniences are enforced by the web app, not by the protocol. No core workflow — create, fund, execute, recover — is token-gated.",
          "Every core workflow works without it."
        ]
      }
    ]
  },
  "token": {
    "kicker": "0xZAPS — token page",
    "title": "An ERC-20 with no claim on revenue, yield, or assets",
    "lede": "0xZAPS is live on Robinhood Chain through Clanker. It is the asset paired with aeWETH in the one route the live contracts can execute. Verify the exact contract on Robinhood Chain before you trade it or add it to a wallet. Not financial advice. The contracts have not been externally audited.",
    "sections": [
      {
        "kind": "facts",
        "kicker": "On record",
        "heading": "The token, literally",
        "intro": "Values as configured in the site's canonical token config (src/lib/config.ts). Wallet support varies.",
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
            "label": "Chain ID",
            "value": "4663"
          },
          {
            "label": "Venue",
            "value": "Clanker"
          },
          {
            "label": "Clanker version",
            "value": "V4"
          },
          {
            "label": "Decimals",
            "value": "18"
          },
          {
            "label": "Pair",
            "value": "0xZAPS/aeWETH"
          },
          {
            "label": "Contract",
            "value": "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"
          }
        ]
      },
      {
        "kind": "steps",
        "kicker": "How to buy",
        "heading": "Three steps to 0xZAPS",
        "intro": "Order matters here: the contract check sits between opening the market and signing anything.",
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
            "body": "Match the token contract exactly: 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07. A ticker and a logo cost nothing to copy, and anyone can deploy a lookalike. The address is the only thing that tells them apart.",
            "tag": "Robinhood Chain"
          },
          {
            "n": "03",
            "title": "Trade 0xZAPS",
            "body": "Connect through Clanker's supported wallet flow, review the Robinhood Chain transaction, and confirm it in your wallet.",
            "tag": "Irreversible"
          }
        ]
      },
      {
        "kind": "cards",
        "kicker": "What it's for",
        "heading": "Only the utility that exists today",
        "intro": "Everything below is implemented and live in the app right now. Nothing below is a protocol right. No governance, staking, fee share, revenue claim, equity, yield, or return is represented.",
        "cards": [
          {
            "title": "The asset in the one live route",
            "body": "The live v1.1 adapter is bound to a single pinned Robinhood v4 pool: aeWETH ↔ 0xZAPS. It cannot route to another token, spender, hook, or DEX. Every capsule the app deploys is built around that one pool.",
            "kicker": "One route",
            "tag": "aeWETH ↔ 0xZAPS"
          },
          {
            "title": "App conveniences at a balance threshold",
            "body": "Hold 100,000+ 0xZAPS in the connected wallet and the app auto-refreshes live quotes, keeps 50 saved zaps instead of 20, retains 100 receipts instead of 20, and enables receipt JSON export. At 1,000,000+ the saved-zap limit is 100. The app reads the balance; the contracts never do.",
            "kicker": "Frontend only",
            "tag": "100,000+"
          },
          {
            "title": "Wallet-readable ERC-20",
            "body": "Use the exact Robinhood Chain address, 18 decimals, and the add-to-wallet utility on this page. Wallet support varies.",
            "kicker": "Standard",
            "tag": "18 decimals"
          },
          {
            "title": "What it does not grant",
            "body": "The token grants no protocol governance, staking, revenue, yield, equity, or fee rights. It is not equity and no return is implied. Every core workflow — create, fund, execute, recover — works without holding it.",
            "kicker": "No rights",
            "tag": "Not equity"
          }
        ]
      },
      {
        "kind": "bounds",
        "kicker": "What it refuses",
        "heading": "The limits, stated plainly",
        "intro": "Each line is a constraint the page states about the token or the contracts behind it.",
        "bounds": [
          "No protocol governance, staking, revenue, yield, equity, or fee rights.",
          "Not equity. No return is implied. Not financial advice.",
          "The live v1.1 adapter cannot route to another token, spender, hook, or DEX.",
          "Exactly one route reduces to a deployable capsule: a single-step aeWETH ↔ 0xZAPS swap, recipient forced to the owner wallet. Every other design the builder can express is rejected by name.",
          "Creating, funding, executing, and recovering a capsule all work without holding 0xZAPS.",
          "Balance thresholds are read by the app only. The contracts do not read the balance.",
          "No external audit is published for the OpenZap v1.1 protocol contracts. Deposited funds are at risk.",
          "Onchain actions are irreversible.",
          "The production app targets Robinhood Chain (chain id 4663). The Base v1 deployment in the config is historical and is not used by the production app.",
          "Wallet support for adding the token varies.",
          "Live market data can change at any time."
        ]
      },
      {
        "kind": "facts",
        "kicker": "Verify before trading",
        "heading": "One contract. One official market.",
        "intro": "A ticker, a logo, and a screenshot cost nothing to copy, and anyone can deploy a token that looks like this one. These are the canonical references. Live market data can change at any time.",
        "facts": [
          {
            "label": "Contract",
            "value": "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"
          },
          {
            "label": "Official market",
            "value": "Clanker V4"
          },
          {
            "label": "Live chart",
            "value": "Dexscreener"
          },
          {
            "label": "Network",
            "value": "Robinhood Chain (robinhoodchain.blockscout.com)"
          }
        ]
      }
    ]
  },
  "roadmap": {
    "kicker": "Roadmap",
    "title": "What is built, what is next, and what is not decided.",
    "lede": "This page carries no dates. The order below is not a commitment: anything past the current release can be reordered or dropped. The constraint that does not move is that each release has to keep execution authority explicit, inspectable, and revocable.",
    "sections": [
      {
        "kind": "facts",
        "kicker": "Current release",
        "heading": "Where the system actually is",
        "intro": "Literal values as stated on the roadmap page, with the chain id, audit posture and block count taken from the code that page describes (src/lib/config.ts, src/lib/blocks.ts, src/lib/deployable.ts). Nothing here is projected.",
        "facts": [
          {
            "label": "Current release",
            "value": "Live v1.1 console"
          },
          {
            "label": "Chain",
            "value": "Robinhood Chain (chain id 4663, from src/lib/config.ts)"
          },
          {
            "label": "Deployable routes",
            "value": "One — a single-step aeWETH ↔ 0xZAPS swap, recipient forced to the owner (src/lib/deployable.ts still pins exactly this one route)"
          },
          {
            "label": "Builder catalog",
            "value": "25 blocks (literal count from BLOCKS in src/lib/blocks.ts). Only the arrangements that reduce to the one live route can be deployed."
          },
          {
            "label": "Everything else in the builder",
            "value": "Saves as a design"
          },
          {
            "label": "Dates on this page",
            "value": "None"
          },
          {
            "label": "Who submits transactions today",
            "value": "The owner, from their own wallet"
          },
          {
            "label": "External audit",
            "value": "Not completed — the app ships pre-audit (STATUS.preAudit is true in src/lib/config.ts)"
          },
          {
            "label": "Assisted submission",
            "value": "Not built"
          }
        ]
      },
      {
        "kind": "cards",
        "kicker": "Release path",
        "heading": "Release path",
        "intro": "Five stages, as listed on the page. Their order is not a commitment — anything past the current release can be reordered or dropped.",
        "cards": [
          {
            "tag": "Now",
            "kicker": "Now",
            "title": "Live v1.1 on Robinhood Chain",
            "body": "Wallet connection, live v4 quotes, deterministic clones, EIP-712 execution, receipts, owner recovery, the activity dashboard, the visual builder, per-capsule onchain pages, and 0xZAPS holder utilities in the app. One route is deployable: a single-step aeWETH ↔ 0xZAPS swap. Everything else in the builder saves as a design."
          },
          {
            "tag": "Next",
            "kicker": "Next",
            "title": "More bounded routes",
            "body": "More policy templates and additional governed adapters. Each adapter and token needs its own review and fork coverage before it can carry funds, so none of them is committed."
          },
          {
            "tag": "Hardening",
            "kicker": "Hardening",
            "title": "External audit",
            "body": "No external audit, formal verification, testnet soak, adapter manifest, governance runbook, or incident drill has been completed. There is no date for any of them."
          },
          {
            "tag": "Beta",
            "kicker": "Beta",
            "title": "Assisted submission",
            "body": "Allowlisted submitters, private submission, receipt monitoring, and alert delivery, with an owner self-submit fallback. None of it is built. Today the owner submits every transaction from their own wallet."
          },
          {
            "tag": "Network",
            "kicker": "Network",
            "title": "Reusable policies",
            "body": "A policy template registry, agent reputation, published eval results, and an SDK. This is the least decided part of the list, and we do not know how much of it is worth building."
          }
        ]
      },
      {
        "kind": "bounds",
        "kicker": "Non-negotiables",
        "heading": "Non-negotiables",
        "intro": "These hold across every release on the list.",
        "bounds": [
          "ERC-20 first. Callback tokens and multi-asset accounting stay out until their failure modes are reviewed.",
          "Protective zaps stay blocked until oracle, liquidity, and liquidation risk controls are externally reviewed.",
          "Every fee is visible in the typed policy before it is signed.",
          "Every automation keeps pause, revoke, audit, and self-submit fallback paths."
        ]
      }
    ]
  }
};
