<div align="center">

<img src="./public/openzap-mark.svg" alt="OpenZaps" width="88" height="88" />

# OpenZaps

**A zap cannot do anything it was not signed to do.**

Bounded policy capsules for agent-triggered DeFi. A capsule fixes the target, the recipient, the asset, and the calldata *before* it is signed — and nothing that executes it can change them. Sign once, and the chain keeps the terms: a zap can run on a cadence or on a price move, submitted by anyone, without ever widening what it may do.

[![CI](https://github.com/0pen-Zaps/openzaps/actions/workflows/ci.yml/badge.svg)](https://github.com/0pen-Zaps/openzaps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-fffc00.svg)](./LICENSE)
[![Site](https://img.shields.io/badge/live-0xzaps.com-050505.svg)](https://www.0xzaps.com)

[Website](https://www.0xzaps.com) · [App](https://www.0xzaps.com/app) · [Docs](https://www.0xzaps.com/docs) · [Token](https://www.0xzaps.com/token) · [X](https://x.com/0xzaps)

</div>

---

> [!WARNING]
> Live on Robinhood Chain mainnet with real funds, and not externally audited. Onchain actions are irreversible — deposit only what you can afford to lose. See [SECURITY.md](./SECURITY.md).

## What this is

An **OpenZap** is a contract that holds funds and executes exactly one policy its owner signed. The policy names the adapter, the spender, the recipient, the input token, and the exact amount, and freezes them behind a hash at creation. An agent — or a relayer, or the owner — can submit an execution, but it can only submit *the* execution: any substitution changes the hash and the capsule rejects it.

- **Creation authority** stays with the user wallet or Safe.
- **Execution authority** lives inside the immutable policy, or an EIP-712 typed intent.
- **Submission authority** is a courier — it picks the moment and nothing else.

The result is pre-committed, tightly bounded authority for a fixed action graph, with an unconditional owner withdraw and revoke path. Not approval-free, and not a universal router — that is the point.

## What runs today

| | |
| --- | --- |
| **Swaps and liquidity** | Five deployable blueprints: buy and sell 0xZAPS, a stitched USDG → 0xZAPS route through two pools in one signed step, and aeWETH/USDG liquidity in and out. |
| **Recurring zaps** | One signature authorizes a whole series. The capsule enforces the interval and the run count onchain — nothing can run early, twice, or past the end. |
| **Price triggers** | Fires once when an allowlisted price source crosses the threshold you signed. The capsule re-reads the market itself on every attempt. |
| **Per-run floors that cannot go stale** | A recurring series derives its minimum output from the price source's spot *at each run*, so a floor signed weeks ago still protects the run happening now. |
| **Anyone can submit** | Each run pays a 1% protocol fee from output: 80% to whoever submits it, 20% to the 0xZAPS lottery pot. Owners publish signed intents to a shared pool; executors poll it for work. The pool is untrusted — the capsule re-verifies every field onchain. |
| **One visible creation fee** | Every capsule created by the current app pays exactly 0.00001 ETH. A gateway calls the existing lineage factory and atomically converts the fee to 0xZAPS through the pinned route; a missed conversion floor reverts creation too. Legacy factories remain directly callable. |

The builder at [`/zap`](https://www.0xzaps.com/zap) designs a zap from typed blocks, tells you plainly whether it reduces to a route the live contracts can carry, and hands a deployable one straight to the console that creates, funds, signs, and runs it.

## Repository layout

This is a monorepo. The web app and the Solidity protocol live together.

| Path | What |
| --- | --- |
| [`src/app/`](src/app) | The Next.js 16 site: landing page, live policy console (`/zap`), Explore feed (`/explore`), docs, token, and API routes. |
| [`src/lib/`](src/lib) | Chain definitions, protocol addresses and ABIs, the block catalog behind the visual builder, and the deterministic policy simulator. |
| [`contracts/`](contracts/README.md) | The Solidity protocol, bounded adapters, deploy/smoke scripts, and the Foundry unit / fuzz / invariant / fork suite. [`v1.1`](contracts/src) carries the single-shot routes; [`v3`](contracts/src/v3/README.md) adds recurring + price-triggered execution and the executor fee/lottery economy; `v3_1` adds per-run floors priced from live spot. The creation gateway preserves all three lineages while enforcing the current app's separate 0xZAPS-converted creation fee. See [`docs/deployments.md`](docs/deployments.md). |
| [`executor/`](executor/README.md) | The reference **Zap Executor** daemon: watches time and chain, discovers work from the shared intent pool, and submits owed recurring/triggered runs for 80% of the 1% protocol fee (20% funds the 0xZAPS lottery pot). Watch-only unless a gas key is configured. |
| [`docs/`](docs) | Architecture Decision Records, the testable invariant catalog, and product/security research the design derives from. |

## Quickstart

Requires **Node 20+**.

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

Three secrets exist. None is read by the browser bundle, and none is ever committed — `.env*` and keystores are gitignored, and CI fails any change that introduces one.

| Secret | Used by | Notes |
| --- | --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Foundry deploy scripts | Read from your shell, or use a `--ledger` hardware wallet. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | The intent relay route, server-side only | Without them `/api/intents` degrades to 503 rather than storing anything. |
| `OPENZAPS_EXECUTOR_PRIVATE_KEY` *or* `OPENZAPS_EXECUTOR_KEYFILE` | The reference executor daemon | Optional. With neither set the daemon is watch-only and never broadcasts. |

**Never paste a private key into a tracked file.**

## The 0xZAPS token

`0xZAPS` is the ERC-20 paired with aeWETH in the live pool. It confers no yield, equity, revenue claim, governance, or protocol access — core workflows are never token-gated. The lottery pot's 20% share of the protocol fee converts to 0xZAPS and accrues to zap owners as tickets; winner selection is governance-gated and the pot has no owner drain.

- **Network:** Robinhood Chain mainnet (`4663`)
- **Contract:** [`0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07`](https://robinhoodchain.blockscout.com/token/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)
- **Market:** [Clanker V4](https://www.clanker.world/clanker/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)

Always verify the network and the full contract address on the site before trading. The token is separate from the protocol contracts.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the setup and the gates, and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](./SECURITY.md) — please do not open a public issue for one.

## License

[MIT](./LICENSE) © OpenZaps.

*Not financial advice. No TVL, yield, or return is implied.*
