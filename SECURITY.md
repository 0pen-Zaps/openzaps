# Security Policy

OpenZaps holds real funds on Robinhood Chain, and the contracts **have not been externally audited.** We take security reports seriously and appreciate responsible disclosure.

## Current posture

- Three capsule lineages are **live and pre-audit** on Robinhood Chain: **v1.1** (one-shot execution behind bounded adapters — swaps, a stitched two-hop route, an ERC-4626 receipt vault, and full-range liquidity), **v3** (recurring series and price triggers, submitted permissionlessly for a 1% fee), and **v3.1** (recurring series whose per-run floor is derived from an allowlisted price source at execution).
- ZapPad is **source-ready and not deployed**. Its interface, bounded runtime APIs, and isolated
  `contracts/zappad` root are present, but there is no approved launcher address and
  `ZAPPAD_LAUNCH_WRITES_ENABLED` must remain false until the exact-SHA audit/risk, fresh deployment,
  source verification, canary, counsel, and hosting gates complete.
- Off-chain surfaces in scope: the intent relay at `/api/intents` (signature and policy-hash verified, service-role key server-side only) and the reference executor daemon in `executor/`. The relay is untrusted by design — a capsule re-verifies every field on-chain — so a relay compromise must not be able to move funds.
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

- The Solidity protocol in [`contracts/`](./contracts) — factory, capsule/clone, adapters, allowlist, and postconditions — plus the isolated, not-deployed ZapPad root in [`contracts/zappad/`](./contracts/zappad).
- The web app and API in [`src/`](./src) — the policy console, the simulation endpoint, and anything that could mislead a user about what an execution will do.

**Out of scope**

- The deployed `0xZAPS` ERC-20 token itself (a standard Clanker market) and the `DEPLOYER_PRIVATE_KEY` handling of *your own* keys.
- Third-party infrastructure we do not control: Robinhood Chain, Clanker, Uniswap, wallet software, and RPC providers.
- Reports that require a compromised owner wallet, a malicious owner acting against their own capsule, or social engineering.

## ZapPad pre-deployment posture

ZapPad launch tokens are fixed supply. Its factories bind once; its launchpad, tokens, and fee
vaults have no upgrade, owner, launch-pause, LP-recovery, or post-deployment mint role. The LP NFT is
minted to a per-launch vault that exposes no transfer or decrease-liquidity method. Each vault
creates one fee-share ERC-20 with 100 whole shares as 80 creator / 20 protocol Safe.

Those fee-share tokens encode rights to LP fees collected and checkpointed by that one vault only.
They are **not 0xZAPS**, **not OpenZaps equity or protocol-wide revenue rights**, **not guaranteed
yield**, and **not a promise of returns**.

Residual risks include no independent audit, checkpoint timing, deterministic-pool griefing,
upgradeable WETH/USDG dependencies, MEV and market loss, bounded accounting dust, Safe/key
compromise, provider failure, and legal/regulatory treatment of transferable LP fee rights.
OpenZaps and ZapPad are independent from and are not affiliated with, endorsed by, or sponsored by
Robinhood Markets, Inc. See [`docs/zappad/security-and-legal.md`](./docs/zappad/security-and-legal.md).

## Safe harbor

We will not pursue or support legal action against anyone who, in good faith, finds and reports a vulnerability within this scope, avoids privacy violations and service disruption, and does not exploit the issue beyond what is needed to demonstrate it. Give us reasonable time to remediate before any public disclosure.

*Never send us a private key or seed phrase. We will never ask for one.*
