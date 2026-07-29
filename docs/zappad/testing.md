# ZapPad verification matrix

Passing tests prove specified behavior for the tested source and environment.
They do not constitute an external audit, deployment, legal approval, or
guarantee.

## Required matrix

| Boundary | Required evidence |
| --- | --- |
| Token factory | One-time binding, only-launchpad deployment, exact CREATE2 prediction, repeated-salt rejection. |
| Token | Fixed supply; no privileged mint, pause, tax, owner, or arbitrary burn path; rounding-dust burn bounded to the launchpad. |
| Launch validation | Chain, metadata bounds, WETH/USDG pair, enabled fee tier, factory spacing, funding mode, exact first-buy value, slippage, salt, and token ordering. |
| Pool creation | Absent and uninitialized pools; initialized-pool rejection; tick alignment; single-sided token0 orientation; bounded dust. |
| LP custody | Canonical position-manager ownership proof; one-shot position binding; vault ownership; no transfer, decrease-liquidity, or recovery method. |
| Fee shares | Exactly 100 ERC-20 shares; atomic 80 creator / 20 Safe split; permit and transfer checkpoint behavior. |
| Revenue | Launch token plus WETH/USDG; harvest, sync, direct-balance checkpoint, pro-rata claims, dust bounds, and conservation. |
| Adversarial | Reentrancy, malicious callback, zero addresses, external collection failure, prefunding, repeated claims, and unsupported assets. |
| Release validation | Raw-byte approval hashes, full SHA, Safe policy, fresh nonces, predicted addresses, dependency hashes, evidence ancestry, and non-future blocks. |
| Canonical fork | Position manager/factory/router/WETH/USDG code, WETH and USDG lifecycles, fresh canonical Safe, two fee cycles, 80/20 → transfer → 70/30, all claims, and zero approvals. |
| API | Config redaction, chain/head/runtime health, proxy implementation checks, allowed RPC methods, broadcast/batch/origin/body/range rejection, timeout, and upstream failure. |
| Browser | Injected wallet, wrong chain, rejected simulation without write, superseded runtime request rejection, runtime pause before signing, WETH lifecycle, exact USDG allowance reset/revoke/drift rejection, receipt proof, pinned pagination, mobile, and accessibility. |
| Deployment | Chain guard, exact compiler identity, Safe and stack receipt ancestry, source verification, code/readback evidence, canary receipts, hosting SHA, aliases, logs, and firewall. |

## Embedded contract evidence

The isolated OpenZaps contract root was reproduced from standalone source commit
`de269ef73c28aeb508b690e53535986802f29b16`. The following was rerun after the
embed:

- forced Solidity `0.8.28` build succeeded with the pinned optimizer, IR,
  Cancun, and metadata settings;
- `ZapPadLaunchpad` runtime size was 16,026 bytes;
- 66 non-fork Foundry tests passed;
- four stateful invariants each ran 256 sequences and 128,000 handler calls:
  512,000 total calls and zero handler reverts;
- four canonical Robinhood fork tests passed at block `21,955,368` with storage
  caching disabled: WETH lifecycle, USDG lifecycle, fresh Safe v1.4.1, and the
  complete two-cycle canary;
- formatting and diff checks passed;
- Foundry lint completed with inherited informational findings, including
  upstream TickMath division/cast notes and test-only unchecked-transfer
  warnings. These are not an independent security review.

Canonical command set:

```bash
forge fmt --root contracts/zappad --check
forge build --root contracts/zappad --force --sizes
forge test --root contracts/zappad --no-match-path 'test/fork/*' -vv
ROBINHOOD_RPC_URL="https://paid-archive-rpc.example" \
  forge test --root contracts/zappad \
  --match-path 'test/fork/**' \
  --no-storage-caching -vv
```

Robinhood testnet does not carry the canonical mainnet Uniswap v3 stack. A
self-deployed chain-46630 stack can test wallet and finality UX, but it cannot
replace the pinned mainnet fork or low-value mainnet canary.

The public Robinhood RPC has not consistently served the historical account,
storage, and proof data the fork requires. Production certification therefore
uses a dedicated archive endpoint. A public Tenderly gateway reproduced the
four tests on 29 July 2026, but its availability and unauthenticated quota are
engineering evidence, not a Production RPC SLA.

## Standalone reference evidence versus OpenZaps evidence

Before integration, the source reference also reported:

- 158 Vitest tests;
- 15-route production build;
- deterministic fresh-stack Chromium lifecycle;
- WETH two-cycle fee-share transfer and three-claim flow;
- exact six-decimal USDG approval reset, revoke, final-drift rejection, and
  launch;
- desktop/mobile and API negative checks;
- Slither 0.11.5 over 43 compilation units and 63 detectors with no
  high-impact finding after manual review of seven non-high results;
- dependency audit and secret scan.

Those results establish provenance for the imported design. They do **not**
certify the OpenZaps integration. The exact OpenZaps release SHA must rerun the
web unit tests, focused route tests, full TypeScript and ESLint gates,
production build, fresh-stack Chromium flow, mobile/accessibility checks,
dependency audit, secret scan, static analysis, Preview probes, and hosting
identity gate.

The integrated working tree subsequently passed 1,047 Vitest checks, the
26-route production build, the 66-test hermetic ZapPad contract suite, all four
fixed-block canonical fork tests, Slither's fail-high gate, and seven
fresh-stack Chromium checks. The browser matrix includes the complete WETH and
USDG lifecycle plus desktop and mobile route passes with automated WCAG 2.0/2.1
A/AA scanning. These results must still be rerun or confirmed by CI and Preview
against the exact committed release SHA.

## Release interpretation

Keep four evidence classes separate:

1. hermetic unit/fuzz/invariant results;
2. pinned canonical fork results;
3. browser tests on a fresh local deployment;
4. finalized mainnet receipts and exact hosting identity.

An Anvil transaction is not a Robinhood mainnet transaction. A fork result is
not a canary. A source-verified contract is not audited. A healthy Preview is
not Production. A Production alias is not evidence of the Git SHA serving
behind it.
