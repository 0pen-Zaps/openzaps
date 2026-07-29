# `@openzaps/sdk`

Pure OpenZap policy compilation plus a read-only client for the block-pinned
simulation API.

This package is prepared for publication but is not yet available from npm. The import below applies
after the `@openzaps/sdk` release has been verified:

```ts
import { OpenZapsClient } from "@openzaps/sdk";

const openzaps = new OpenZapsClient();
const artifact = await openzaps.simulatePolicy({
  routeId: "robinhood-v4-weth-zaps",
  owner: "0xYourAddress",
  amount: "0.01",
  slippageBps: 150
});
```

The response contains the exact ABI-encoded policy hash, live allowlist reads,
adapter runtime code hashes, an exact quote pinned to one block, an unsigned
EIP-712 draft, and an `eth_call` result. It never signs or broadcasts.

The production simulation API is independently gated by
`OPENZAPS_EXACT_POLICY_API_ENABLED=true` and its durable request quota. Package publication does not
enable that route. The discovery API is public chain data; this SDK has no credential surface and
cannot authorize execution. Execution requires the capsule owner's EIP-712 signature.
