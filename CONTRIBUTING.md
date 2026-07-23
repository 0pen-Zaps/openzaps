# Contributing to OpenZaps

Thanks for your interest. This is a monorepo — a Next.js 16 web app and a Foundry Solidity protocol — and contributions to either are welcome.

## Ground rules

- **Never commit a secret.** No private keys, seed phrases, API keys, or `.env` files. The only secret the project uses is `DEPLOYER_PRIVATE_KEY`, and it is read from your shell or a hardware wallet — never from a tracked file. `.env*`, `*.pem`, and keystores are gitignored, and CI runs a secret scan over every change. A leaked key on a public repo means drained funds within seconds.
- **Fail closed, never fake.** This is a DeFi product. Do not invent balances, TVL, yields, or activity rows to fill a UI. If a read fails, show nothing or an honest error — an empty list is a claim, and a false one is worse than a blank.
- **Match the surrounding code.** Comment density, naming, and idiom. The codebase explains *why* at the point a decision is non-obvious; keep that up.

## Web app

Requires **Node 20+**.

```bash
npm ci
npm run dev
```

Before you open a PR, the same gates CI enforces:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Contracts

From `contracts/`, with [Foundry](https://book.getfoundry.sh/) installed:

```bash
forge install
forge build
forge test        # fork tests need a Robinhood Chain RPC exported in your env
```

Deploy scripts read `DEPLOYER_PRIVATE_KEY` from the environment or use `--ledger`. They contain **no key material** and must stay that way.

## Pull requests

- Branch from `main`. Keep a PR to one logical change.
- Write commit subjects in the imperative ("Add…", "Fix…", not "Added"/"Fixes"). Explain the *why* in the body when it isn't obvious from the diff.
- Make sure all gates above are green. CI will re-run them.
- If you change behavior a user sees, say so in the PR description.
- Security-sensitive changes: see [SECURITY.md](./SECURITY.md). Do not disclose a vulnerability in a public PR.

By contributing, you agree your contributions are licensed under the repository's [MIT License](./LICENSE).
