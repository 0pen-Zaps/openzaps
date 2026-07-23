# Security Policy

OpenZaps holds real funds on Robinhood Chain, and the contracts **have not been externally audited.** We take security reports seriously and appreciate responsible disclosure.

## Current posture

- The v1.1 contracts are **live and pre-audit.** One bounded aeWETH ↔ 0xZAPS route is deployable.
- No external audit, formal verification, adapter governance, testnet soak, or live wallet review has completed. The production gates are tracked at [0xzaps.com/docs#gates](https://www.0xzaps.com/docs#gates).
- The owner of a capsule always keeps an unconditional withdraw and revoke path.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or social post for a security vulnerability.**

Report it privately, one of:

1. **GitHub private vulnerability reporting** (preferred) — the **Report a vulnerability** button under this repository's **Security** tab. This opens a private advisory only maintainers can see.
2. **Direct message** [@0xzaps on X](https://x.com/0xzaps) to arrange a private channel.

When you report, please include: the affected component (contract, web app, or API), a description of the impact, and the steps or a proof-of-concept to reproduce it. We aim to acknowledge within **72 hours** and to keep you updated as we work a fix.

## Scope

**In scope**

- The Solidity protocol in [`contracts/`](./contracts) — factory, capsule/clone, adapters, allowlist, and postconditions.
- The web app and API in [`src/`](./src) — the policy console, the simulation endpoint, and anything that could mislead a user about what an execution will do.

**Out of scope**

- The deployed `0xZAPS` ERC-20 token itself (a standard Clanker market) and the `DEPLOYER_PRIVATE_KEY` handling of *your own* keys.
- Third-party infrastructure we do not control: Robinhood Chain, Clanker, Uniswap, wallet software, and RPC providers.
- Reports that require a compromised owner wallet, a malicious owner acting against their own capsule, or social engineering.

## Safe harbor

We will not pursue or support legal action against anyone who, in good faith, finds and reports a vulnerability within this scope, avoids privacy violations and service disruption, and does not exploit the issue beyond what is needed to demonstrate it. Give us reasonable time to remediate before any public disclosure.

*Never send us a private key or seed phrase. We will never ask for one.*
