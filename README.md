<div align="center">

<img src="./public/openzap-mark.svg" alt="OpenZaps" width="88" height="88" />

# OpenZaps

**A zap cannot do anything it was not signed to do.**

Bounded policy capsules for agent-triggered DeFi. A capsule fixes the target, the recipient, the asset, and the calldata *before* it is signed — and nothing that executes it can change them.

[![CI](https://github.com/0pen-Zaps/openzaps/actions/workflows/ci.yml/badge.svg)](https://github.com/0pen-Zaps/openzaps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-fffc00.svg)](./LICENSE)
[![Site](https://img.shields.io/badge/live-0xzaps.com-050505.svg)](https://www.0xzaps.com)

[Website](https://www.0xzaps.com) · [App](https://www.0xzaps.com/app) · [Docs](https://www.0xzaps.com/docs) · [Token](https://www.0xzaps.com/token) · [X](https://x.com/0xzaps)

</div>

---

> [!WARNING]
> **The contracts have not been externally audited.** One bounded aeWETH ↔ 0xZAPS route is live on Robinhood Chain, and the funds a capsule holds are real. Onchain actions are irreversible. Deposit only what you can afford to lose. See [SECURITY.md](./SECURITY.md).

## What this is

An **OpenZap** is a contract that holds funds and executes exactly one policy its owner signed. The policy names the adapter, the spender, the recipient, the input token, and the exact amount, and freezes them behind a hash at creation. An agent — or a relayer, or the owner — can submit an execution, but it can only submit *the* execution: any substitution changes the hash and the capsule rejects it.

- **Creation authority** stays with the user wallet or Safe.
- **Execution authority** lives inside the immutable policy, or a one-shot EIP-712 typed intent.
- **Submission authority** is a courier — it picks the moment and nothing else. On the live route the owner submits from their own wallet.

The result is pre-committed, tightly bounded authority for a fixed action graph, with an unconditional owner withdraw and revoke path. Not approval-free, and not a universal router — that is the point.

## Repository layout

This is a monorepo. The web app and the Solidity protocol live together.

| Path | What |
| --- | --- |
| [`src/app/`](src/app) | The Next.js 16 site: landing page, live policy console (`/app`), Zaps Feed (`/zaps`), docs, token, and API routes. |
| [`src/lib/`](src/lib) | Chain definitions, protocol addresses and ABIs, the block catalog behind the visual builder, and the deterministic policy simulator. |
| [`contracts/`](contracts/README.md) | The live v1.1 Solidity protocol, bounded adapters, deploy/smoke scripts, and the Foundry unit / fuzz / invariant / fork suite. **Pre-external-audit.** |
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

All runtime configuration is **public** `NEXT_PUBLIC_*` values (chain id, contract addresses, the public RPC URL, the site URL) with safe hardcoded defaults — see [`.env.example`](./.env.example). Copy it to `.env.local` to override for a preview.

The **only** secret this project uses is `DEPLOYER_PRIVATE_KEY`, read by Foundry deploy scripts from your shell (or a `--ledger` hardware wallet). It is never read by the web app, and it is never committed — `.env*` and keystores are gitignored, and CI fails any change that introduces a secret. **Never paste a private key into a tracked file.**

## The 0xZAPS token

`0xZAPS` is the ERC-20 paired with aeWETH in the one live route. It confers no yield, equity, revenue claim, governance, or protocol access — core workflows are never token-gated.

- **Network:** Robinhood Chain mainnet (`4663`)
- **Contract:** [`0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07`](https://robinhoodchain.blockscout.com/token/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)
- **Market:** [Clanker V4](https://www.clanker.world/clanker/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)

Always verify the network and the full contract address on the site before trading. The live token is separate from the pre-audit reference protocol contracts.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the setup and the gates, and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](./SECURITY.md) — please do not open a public issue for one.

## License

[MIT](./LICENSE) © OpenZaps.

*Not financial advice. No TVL, yield, or return is implied.*
