# OpenZaps

Immutable intent lockers for Hermes-triggered DeFi.

OpenZaps are narrow, ERC-20-first policy capsules for pre-authorized DeFi workflows. The core product stance is explicit: OpenZaps are not approval-free and not a universal router. They are pre-committed, tightly bounded authority for fixed action graphs that a Hermes agent can simulate, submit, monitor, and revoke without receiving discretionary wallet power.

## Product thesis

- Creation authority stays with the user wallet or Safe.
- Execution authority lives inside an immutable zap policy or signed typed intent.
- Submission authority belongs to Hermes or a relayer, constrained by policy.
- v1 scope should favor immutable clones, fixed adapters/selectors, EIP-712 intents, ERC-1271 compatibility, exact approval reset, private submission for price-sensitive routes, and balance-delta postconditions.

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
