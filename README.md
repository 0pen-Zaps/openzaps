<div align="center">

<img src="./public/openzap-mark.svg" alt="OpenZaps" width="88" height="88" />

# OpenZaps

**A Zap cannot do anything it was not signed to do.**

Bounded Zaps for agent-triggered DeFi. A Zap — the immutable policy capsule the factory deploys — fixes the target, recipient, asset, calldata, and execution policy *before* it is signed. Sign once, and the chain keeps the terms: Zap now, on a cadence, or on a price move, without widening what the Zap may do.

[![CI](https://github.com/0pen-Zaps/openzaps/actions/workflows/ci.yml/badge.svg)](https://github.com/0pen-Zaps/openzaps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-fffc00.svg)](./LICENSE)
[![Site](https://img.shields.io/badge/live-0xzaps.com-050505.svg)](https://www.0xzaps.com)

[Website](https://www.0xzaps.com) · [App](https://www.0xzaps.com/zap) · [Virtual Trading](https://www.0xzaps.com/virtual-trading) · [Request a Zap](https://www.0xzaps.com/request-a-zap) · [Docs](https://www.0xzaps.com/docs) · [Token](https://www.0xzaps.com/token) · [X](https://x.com/0xzaps)

</div>

---

> [!WARNING]
> Live on Robinhood Chain mainnet with real funds, and not externally audited. Onchain actions are irreversible — deposit only what you can afford to lose. See [SECURITY.md](./SECURITY.md).

## What this is

An **OpenZap** is a contract that holds funds and executes exactly one policy its owner signed. The policy names the adapter, the spender, the recipient, the input token, and the exact amount, and freezes them behind a hash at creation. An agent — or a relayer, or the owner — can submit an execution, but it can only submit *the* execution: any substitution changes the hash and the Zap rejects it.

- **Creation authority** stays with the user wallet or Safe.
- **Execution authority** lives inside the immutable policy, or an EIP-712 typed intent.
- **Submission authority** is a courier — it picks the moment and nothing else.

The result is pre-committed, tightly bounded authority for a fixed action graph. Recovery is lineage-specific: owners can invalidate unused signed authority and recover tracked assets where the deployed lineage supports it; the v3.2 candidate additionally exposes a one-way permanent policy halt. No control can undo a confirmed execution. Not approval-free, and not a universal router — that is the point.

## What you can Zap today

| | |
| --- | --- |
| **Swaps and liquidity** | Deployable blueprints cover 0xZAPS in and out against aeWETH, the same both ways from USDG through two pools in one signed step, aeWETH ↔ USDG through the pinned stable pool, full-range aeWETH/USDG liquidity in and out from either side, and the ozUSDG ERC-4626 receipt. The rest of the catalog compiles and simulates but cannot be deployed today; the builder badges which is which. |
| **Recurring Zaps** | One signature authorizes a whole series. The Zap enforces the interval and the total run count onchain, so nothing can run early, twice, or past the end. |
| **Price triggers** | Fires once when an allowlisted price source crosses the threshold you signed. The Zap re-reads the market itself on every attempt. |
| **Per-run floors that cannot go stale** | A recurring series derives its minimum output from the price source's spot *for each run*, so a floor signed weeks ago still protects the run happening now. |
| **Execution policy composition** | Three live blocks bind execution gas, gas price, and executor access. Add the whole stack in one click, edit each bound, and undo the insertion as one canvas change. Gas controls reach one-shot and standing intents; owner-only executor access is live in v3/v3.1, while v3.2 remains a deployed candidate. |
| **Eligible submitters can run automation** | Each automated run pays a 1% protocol fee from output: 80% to whoever is eligible and submits it, 20% to the 0xZAPS lottery pot. An owner may leave submission open, restrict it to the owner, or pin one executor address. The shared intent pool is untrusted, so the Zap re-verifies every field onchain. |
| **One visible creation fee** | Every Zap created by the current app pays exactly 0.00001 ETH. A gateway calls the existing lineage factory and atomically converts the fee to 0xZAPS through the pinned route; a missed conversion floor reverts creation too. Legacy factories remain directly callable. |
| **Practice without a wallet** | Virtual Trading starts with 10,000 virtual USDG and uses canonical-head quotes for the same four pinned USDG routes. Fills, positions, and PnL stay in the browser; there is no wallet, deposit, signature, reward, or ranked league. |
| **Request a missing Zap** | The free request desk turns one proposed workflow into a human-reviewed authority map: targets, assets, recipient, trigger, limits, recovery, and forbidden authority. Submitting a request makes no wallet, funding, signature, or integration commitment. |

The builder at [`/zap`](https://www.0xzaps.com/zap) designs a Zap from typed route and policy blocks,
tells you which bounds the selected contract can enforce, and hands a deployable design to Zap now
or Automate with its resolved settings intact. `/zap` is one route with five surfaces — Start,
Compose, Zap now, Automate, and Connect — reached from the app sidebar and carried in
`?view=start|design|sign|automate|connect`; `?src=build`, `?route=`, and `?d=` share links still mean
what they always meant.

## Repository layout

This is a monorepo. The web app and the Solidity protocol live together.

| Path | What |
| --- | --- |
| [`src/app/`](src/app) | The Next.js 16 site, in two route groups. `(landing)` is `/` alone, with its own nav, footer, and token scope; `(site)` holds the public product and reference routes — including `/zap`, `/virtual-trading`, `/request-a-zap`, `/explore`, `/profile`, `/pot`, `/docs`, `/evals`, `/token`, `/roadmap`, and `/legal` — wrapped in the app shell. Operator and experimental routes live in the same group but are not implied to be public release surfaces by this inventory. `src/app/api/` holds the route handlers; `globals.css` holds the five-theme token layer. |
| [`src/components/`](src/components) | UI shared across routes: `AppShell` (sidebar, context bar, and the one `#zapscroll` container that owns the scroll), the theme provider and picker, the `Glyph` set, the wallet session provider, and the footer. |
| [`src/lib/`](src/lib) | Chain definitions, protocol addresses and ABIs, the block catalog behind the visual builder, the block-pinned exact-policy compiler, the theme registry (`theme.ts`), and the `?view=` contract the sidebar and the consoles both read (`zap-view.ts`). |
| [`contracts/`](contracts/README.md) | The Solidity protocol, bounded adapters, deploy/smoke scripts, and the Foundry unit / fuzz / invariant / fork suite. The base lineage in [`contracts/src`](contracts/src) is live as v1.1, with the source-only v1.2 owner-pull/halt candidate alongside it; [`v3`](contracts/src/v3/README.md) adds recurring + price-triggered execution and the executor fee/lottery economy; `v3_1` adds per-run floors priced from live spot; the deployed unaudited `v3_2` candidate adds an owner-signed recurring 0xZAPS stack. The v1.2 candidate and v3.2 deployment use isolated exact-fee gateways and creation pots so the active legacy prize round remains untouched. See [`docs/deployments.md`](docs/deployments.md). |
| [`executor/`](executor/README.md) | The reference **Zap Executor** daemon: watches time and chain, discovers work from the shared intent pool, and submits owed recurring/triggered runs for 80% of the 1% protocol fee (20% funds the 0xZAPS lottery pot). Watch-only unless a gas key, a release-approved adapter manifest, and a healthy private-relay set are configured. |
| [`packages/sdk`](packages/sdk) / [`packages/mcp`](packages/mcp) | Published read-only Agent Kit packages (`@openzaps/sdk@0.1.0` and `@openzaps/mcp@0.1.0`) with npm provenance attestations. The SDK compiles exact policy and unsigned EIP-712 artifacts; the npx MCP entrypoint discovers and simulates without signing or broadcasting. |
| [`docs/`](docs) | Architecture Decision Records, the testable invariant catalog, and product/security research the design derives from. |

Two structural rules the app depends on. Every interior page renders **content only**: the shell in `src/components/AppShell.tsx` owns the viewport, the scroll container, and the content measure, so pages add no nav, no footer, and no page-level scroll. And every colour, shadow, and radius resolves from one of the five theme blocks in `src/app/globals.css`, selected by `data-oz-theme` on `<html>` and resolved before first paint by the guard in `src/lib/theme.ts` — `voltage` is the identity the app shipped with, preserved exactly. `/` is deliberately outside both: it keeps its own nav and footer, and pins its own copies of the tokens in `src/app/(landing)/landing.module.css`.

## Quickstart

Requires **Node 20.9+**. CI and production run Node 24.

```bash
npm ci
npm run dev        # http://localhost:3000
```

Gates the CI runs on every push and pull request:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Contracts (from `contracts/`, requires [Foundry](https://book.getfoundry.sh/)):

```bash
forge install
forge build
forge test               # fork tests need a Robinhood Chain RPC in your env
```

## Configuration

Everything the **browser** needs is public `NEXT_PUBLIC_*` configuration — chain id, contract addresses, the public RPC URL, the site URL — and the live Robinhood Chain addresses ship as hardcoded defaults in [`src/lib/robinhood.ts`](src/lib/robinhood.ts) and [`src/lib/chains.ts`](src/lib/chains.ts). Set any of them in `.env.local` to point a preview somewhere else; a malformed override fails closed by dropping that route rather than widening what the app offers.

Server-only credentials, release flags, and signing material are separate on purpose. None is read
by the browser bundle, and none is ever committed — `.env*` and keystores are gitignored, and CI
fails any change that introduces one.

| Configuration | Used by | Fail-closed posture |
| --- | --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Foundry deploy scripts | Read from the shell, or use a named keystore or hardware wallet. Never expose it to the web app. |
| `OPENZAPS_SUPABASE_PROJECT_REF` + `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Intent relay, public policy registry, receipts, Guardian, and executor scorecards | Server-side only. Production requires the exact lowercase project ref and canonical `https://<ref>.supabase.co` origin; a missing or mismatched binding keeps every affected API unconfigured. Loopback HTTP is accepted only outside production. Apply the reviewed migrations in `supabase/migrations/` before enabling the new operations and registry surfaces; follow the shared-project history rules in [`supabase/README.md`](supabase/README.md). |
| `OPENZAPS_EXECUTOR_PRIVATE_KEY` *or* `OPENZAPS_EXECUTOR_KEYFILE` | Reference executor daemon | Optional. With neither set the daemon is watch-only and never broadcasts. A key alone is insufficient: signing also requires the reviewed adapter manifest and private-relay admission checks in [`executor/README.md`](executor/README.md). |
| `ANTHROPIC_API_KEY` | `/api/agent/*`, server-side only | Optional. Without it those routes return 503, the connect surface hides its free-text composer rather than offering one that fails, and `/explore/[address]` answers questions from the capsule's own facts. `OPENZAPS_AGENT_MODEL` overrides the model id. |
| `ACROSS_API_KEY` + `ACROSS_INTEGRATOR_ID` | Server-side Across `/swap/approval` quote proxy | Production requires the complete pair; `ACROSS_INTEGRATOR_ID` is a two-byte `0x` value. A missing or malformed pair is rejected even when the launch flags are set. |
| `BASE_RPC_URL` | Server-side Base mainnet evidence for `/api/bridge/quote` | Use a reliable HTTPS Base mainnet endpoint for production bridge reads. This is separate from the Robinhood Chain `OPENZAPS_EXACT_POLICY_RPC_URL`. When absent, the bridge reader falls back to `NEXT_PUBLIC_BASE_RPC_URL` and then the credential-free public Base RPC, which may throttle; never put an authenticated provider URL in `NEXT_PUBLIC_BASE_RPC_URL`. |
| `OPENZAPS_EXACT_POLICY_RPC_URL` | Server-side `/api/policies/simulate` chain reads | Required in production and must be an HTTPS URL. It may contain provider credentials because it is never browser-bundled or returned by the API. Local and test runs use the fixed unauthenticated Robinhood RPC only when this setting is absent; a malformed or non-HTTPS value always fails closed. Never put an authenticated RPC URL in `NEXT_PUBLIC_ROBINHOOD_RPC_URL`. |

The following flags are not credentials. They prevent source-ready work from being presented as
live before its external dependency or production control exists:

| Flag | Production requirement |
| --- | --- |
| `NEXT_PUBLIC_ACROSS_BRIDGE_ENABLED=true` + `OPENZAPS_ACROSS_DURABLE_QUOTA_ENABLED=true` | Enables Base → Robinhood USDG funding only after the authenticated Across pair and a durable edge quota are configured. The server checks both flags, so hiding the browser surface cannot leave a credential-consuming quote API exposed. |
| `OPENZAPS_EXACT_POLICY_API_ENABLED=true` + `OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED=true` | Enables `/api/policies/simulate` in production only when the durable WAF/request quota and a valid server-only `OPENZAPS_EXACT_POLICY_RPC_URL` are both configured. The second flag records that external control; the in-process limiter remains burst hygiene only. |
| `OPENZAPS_GUARDIAN_ENABLED=true` + `OPENZAPS_GUARDIAN_DURABLE_QUOTA_ENABLED=true` | Enables the read-only Guardian in production after durable quota and Supabase-backed operations storage are in place. The second flag records that the external quota exists; it does not create one. |
| `OPENZAPS_POLICY_TEMPLATE_PUBLISHING_ENABLED=true` + `OPENZAPS_POLICY_TEMPLATE_PUBLISHING_DURABLE_QUOTA_ENABLED=true` | Enables wallet-attributed public template publication in production after the template/security migrations and a durable request quota are applied. The second flag records the external control; the in-process limiter is burst hygiene only. Browsing remains read-only when publication is off. |
| `OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED=true` + `OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_DURABLE_QUOTA_ENABLED=true` | Enables wallet-signed, wallet-pseudonymous exact-version subscription writes after the migration and a durable request quota exist. The database additionally caps each subscriber, each template, and the global table; counts are convenience metadata, never execution authority or reputation. |
| `NEXT_PUBLIC_OPENZAPS_AGENT_KIT_PUBLISHED=true` | Advertises the npx install path on this deployment only after both scoped `0.1.0` packages and their npm provenance attestations have been verified. Registry publication does not enable an unconfigured deployment; absent or any value other than exact `true` keeps the surface hidden. |

**Never paste a private key into a tracked file.**

Release operators should use the bounded procedures in [`docs/operations-runbook.md`](docs/operations-runbook.md);
the scoped-package bootstrap and trusted-publishing path is documented separately in
[`docs/npm-publishing.md`](docs/npm-publishing.md). Marketing-agent channel setup, review gates,
and safe rollout/recovery are in [`docs/marketing-agent.md`](docs/marketing-agent.md); model output
and replies are review-only, while one versioned tier-1 X/Discord template lane
is available behind explicit live, ledger, provider, and schedule gates.

## The 0xZAPS token

`0xZAPS` is the ERC-20 paired with aeWETH in the live pool. It confers no yield, equity, revenue claim, governance, or protocol access — core workflows are never token-gated. The lottery pot's 20% share of the protocol fee converts to 0xZAPS and accrues to Zap owners as tickets; winner selection is governance-gated and the pot has no owner drain.

- **Network:** Robinhood Chain mainnet (`4663`)
- **Contract:** [`0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07`](https://robinhoodchain.blockscout.com/token/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)
- **Market:** [Clanker V4](https://www.clanker.world/clanker/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)

Always verify the network and the full contract address on the site before trading. The token is separate from the protocol contracts.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the setup and the gates, and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](./SECURITY.md) — please do not open a public issue for one.

## License

[MIT](./LICENSE) © OpenZaps.

*Not financial advice. No TVL, yield, or return is implied.*
