# OpenZaps

Immutable intent lockers for Hermes-triggered DeFi.

OpenZaps are narrow, ERC-20-first policy capsules for pre-authorized DeFi workflows. The core product stance is explicit: OpenZaps are not approval-free and not a universal router. They are pre-committed, tightly bounded authority for fixed action graphs that a Hermes agent can simulate, submit, monitor, and revoke without receiving discretionary wallet power.

## Product thesis

- Creation authority stays with the user wallet or Safe.
- Execution authority lives inside an immutable zap policy or signed typed intent.
- Submission authority belongs to Hermes or a relayer, constrained by policy.
- v1 scope should favor immutable clones, fixed adapters/selectors, EIP-712 intents, ERC-1271 compatibility, exact approval reset, private submission for price-sensitive routes, and balance-delta postconditions.

## Repository layout

- [`app/`](app) — the Next.js landing page.
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
