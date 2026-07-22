# OpenZaps

Immutable intent lockers for Hermes-triggered DeFi.

OpenZaps are narrow, ERC-20-first policy capsules for pre-authorized DeFi workflows. The core product stance is explicit: OpenZaps are not approval-free and not a universal router. They are pre-committed, tightly bounded authority for fixed action graphs that a Hermes agent can simulate, submit, monitor, and revoke without receiving discretionary wallet power.

## Product thesis

- Creation authority stays with the user wallet or Safe.
- Execution authority lives inside an immutable zap policy or signed typed intent.
- Submission authority belongs to Hermes or a relayer, constrained by policy.
- v1 scope should favor immutable clones, fixed adapters/selectors, EIP-712 intents, ERC-1271 compatibility, exact approval reset, private submission for price-sensitive routes, and balance-delta postconditions.

## Product surfaces

- `/` — production landing page for the OpenZaps thesis and launch status.
- `/app` — live Robinhood Chain console for wallet connection, chain switching, v4 quotes, deterministic zap creation, funding, EIP-712 execution, receipts, and owner recovery.
- `/docs` — developer docs for policy schema, simulation API, SDK surface, and lifecycle.
- `/security` — threat model, contract controls, audit status, and production-readiness gates.
- `/pricing` — protocol fee and relayer fee model.
- `/roadmap` — staged path from review console to audited relayer network.
- `/token` — live 0xZAPS contract, Clanker market, and Robinhood Chain verification links.
- `/legal` — risk disclosures.

## API routes

- `GET /api/health` — returns deployment, chain, contract, token, and pre-audit status.
- `POST /api/policies/simulate` — normalizes a policy draft and returns deterministic checks, policy hash, estimated output, fee cap, gas envelope, and `broadcast:false`.

## Repository layout

- [`src/app/`](src/app) — the Next.js app, public pages, policy console, and API routes.
- [`src/lib/robinhood.ts`](src/lib/robinhood.ts) — live Robinhood chain definition, protocol addresses, pool route, and production ABIs.
- [`src/lib/policy.ts`](src/lib/policy.ts) — legacy/general policy template and deterministic simulation helpers used by the API.
- [`contracts/`](contracts/README.md) — the live v1.1 Solidity protocol, bounded Robinhood v4 adapter, deployment/smoke scripts, and Foundry unit/fuzz/invariant/fork suite. **Pre-external-audit** — see its security notice.
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
