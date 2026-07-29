# ZapPad deterministic browser E2E

`npm run test:zappad:e2e:fork` owns the complete local lifecycle:

1. A loopback-only proxy forwards an allowlist of read methods to a Robinhood
   archive RPC. Write and signing methods are rejected upstream.
2. Anvil forks canonical block `21,955,368`, uses chain ID `4663` and the
   Cancun hardfork, and exposes only its generated unlocked accounts.
3. A historical-block-locked Foundry test wrapper broadcasts a fresh ZapPad
   stack. Its plain unlocked Anvil test treasury keeps browser claim coverage
   deterministic; the wrapper cannot execute at the current mainnet height.
   The production deployment script has no EOA or boolean treasury bypass,
   while Safe deployment and threshold execution are also covered by the
   Foundry fork suite.
4. The runner moves the fork timestamp to the current time, starts Next.js in
   development mode, requires `/api/launch/health` to return `200`, and runs one
   Chromium worker.
5. The browser receives a deterministic EIP-1193/EIP-6963 provider before page
   load. It never receives an upstream RPC URL or private key. Wallet writes
   are forwarded through a Playwright binding to loopback Anvil only.

The lifecycle also deactivates the server write switch after a successful
pre-flight and proves that no wallet transaction is requested, then restores
the verified runtime and requires a fresh simulation. Its USDG path replaces a
stale allowance with the exact first-buy amount, exercises user revocation,
mutates the allowance after pre-flight, proves final submission fails without a
wallet write, and only launches after a new exact approval and simulation.

The runner sets the scoped `ZAPPAD_LAUNCHER_*` identity variables and both RPC
relay declarations inside the isolated local process. Those local values prove
test wiring only; they are not production deployment or durable-quota
evidence.

The default archive source is Tenderly’s rate-limited public Robinhood gateway.
For a dedicated archive endpoint, set it only in the runner environment:

```bash
ZAPPAD_E2E_ARCHIVE_RPC_URL="https://provider.example/secret" \
  npm run test:zappad:e2e:fork
```

The runner removes that variable before starting Next.js or Playwright and
never prints its value. Install the Chromium binary once if Playwright asks:

```bash
npx playwright install chromium
```

Failure traces, video, and screenshots are written under
`output/playwright/zappad/`, which is ignored by Git.
