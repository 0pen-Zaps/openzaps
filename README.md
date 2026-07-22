# OpenZaps

Immutable intent lockers for Hermes-triggered DeFi.

Website: [www.0xzaps.com](https://www.0xzaps.com) · Token: [0xZAPS](https://www.0xzaps.com/token)

OpenZaps are narrow, ERC-20-first policy capsules for pre-authorized DeFi workflows. The core product stance is explicit: OpenZaps are not approval-free and not a universal router. They are pre-committed, tightly bounded authority for fixed action graphs that a Hermes agent can simulate, submit, monitor, and revoke without receiving discretionary wallet power.

## Product thesis

- Creation authority stays with the user wallet or Safe.
- Execution authority lives inside an immutable zap policy or signed typed intent.
- Submission authority belongs to Hermes or a relayer, constrained by policy.
- v1 scope should favor immutable clones, fixed adapters/selectors, EIP-712 intents, ERC-1271 compatibility, exact approval reset, private submission for price-sensitive routes, and balance-delta postconditions.

## Product surfaces

- `/` — production landing page for the OpenZaps thesis and launch status.
- `/app` — policy console with templates, deterministic simulation, review diffs, local audit history, dry-run receipts, pause/resume, revoke, and JSON export.
- `/docs` — developer docs for policy schema, simulation API, SDK surface, and lifecycle.
- `/security` — threat model, contract controls, audit status, and production-readiness gates.
- `/pricing` — protocol fee and relayer fee model.
- `/roadmap` — staged path from review console to audited relayer network.
- `/token` — live 0xZAPS contract, Clanker market, and Robinhood Chain verification links.
- `/legal` — risk disclosures.

## 0xZAPS identity and metadata

- Network: Robinhood Chain mainnet (`4663`)
- Contract: [`0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07`](https://robinhoodchain.blockscout.com/token/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)
- Official market: [Clanker V4](https://www.clanker.world/clanker/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07)
- Token list: [`/tokenlist.json`](https://www.0xzaps.com/tokenlist.json)
- Canonical metadata: [`/token-metadata.json`](https://www.0xzaps.com/token-metadata.json)
- Well-known identity: [`/.well-known/openzaps-token.json`](https://www.0xzaps.com/.well-known/openzaps-token.json)

Verify the network and full contract address before trading. Clanker is the launch and trading venue; Robinhood
Chain is the blockchain. The live token is separate from the pre-audit OpenZaps reference protocol contracts.

## API routes

- `GET /api/health` — returns deployment, chain, contract, token, and pre-audit status.
- `POST /api/policies/simulate` — normalizes a policy draft and returns deterministic checks, policy hash, estimated output, fee cap, gas envelope, and `broadcast:false`.

## Repository layout

- [`src/app/`](src/app) — the Next.js app, public pages, policy console, and API routes.
- [`src/lib/policy.ts`](src/lib/policy.ts) — shared policy template, hashing, diff, and simulation logic used by the UI and API.
- [`contracts/`](contracts/README.md) — the v1 Solidity protocol (immutable intent lockers), with a Foundry unit + invariant suite. **Pre-audit** — see the security notice in the contracts README.
- [`docs/adr/`](docs/adr/README.md) — accepted Architecture Decision Records (authority model, deployment isolation, submission privacy, protective-vs-optimization scope).
- [`docs/invariant-spec.md`](docs/invariant-spec.md) — the testable invariant catalog + production-readiness gate.
- [`docs/research-report.md`](docs/research-report.md) — product/security research the design derives from.

## Local development

```bash
npm run lint
npx tsc --noEmit --incremental false
npm run build
npm run dev
```

## Source research

The landing page was derived from the local research report at:

`/Users/nodes/Downloads/deep-research-report (1).md`

A copy is kept in `docs/research-report.md` for product context.
