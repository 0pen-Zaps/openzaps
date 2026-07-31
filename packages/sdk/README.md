# `@openzaps/sdk`

Pure OpenZap policy compilation plus a read-only client for the block-pinned
simulation API.

`@openzaps/sdk@0.1.0` is published with an npm provenance attestation. Verify the
registry version and attestation again before installing it or publishing a
later release.

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
`OPENZAPS_EXACT_POLICY_API_ENABLED=true` and
`OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED=true`. Package publication does not enable that route.
The discovery API is public chain data; this SDK has no credential surface and cannot authorize
execution. Execution requires the capsule owner's EIP-712 signature.

## v1.2 candidate Permit2 owner pull

`buildUnsignedPermit2OwnerPull` prepares the second wallet signature for the source-only v1.2
candidate. It binds the existing OpenZap intent digest as a Permit2 witness, the capsule as spender,
and the frozen policy's exact first-step token and amount. It rejects a mismatched policy, a
different output/funding asset, a deadline beyond the intent, or a window longer than one hour.
The helper remains pure: it does not request either signature, approve Permit2, or submit a
transaction.

This path is not present in the live v1.1 implementation. Do not expose it in an app until a v1.2
factory and implementation have been independently deployed, verified, and pinned.
