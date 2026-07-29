# ZapPad runtime gates

ZapPad's OpenZaps interface is fail closed. The source can be deployed as a
Preview with no launcher address, but it must not claim that reads or launches
are live.

## Canonical server configuration

| Variable | Requirement |
| --- | --- |
| `ZAPPAD_RPC_URL` or `ROBINHOOD_RPC_URL` | Paid HTTPS Robinhood Chain RPC in Production. The URL remains server-only. |
| `ZAPPAD_RPC_RELAY_ENABLED` | Exact lowercase `true` requests ZapPad runtime reads and the bounded relay in Production. |
| `ZAPPAD_RPC_DURABLE_QUOTA_ENABLED` | Exact lowercase `true` records that a separately configured durable edge quota covers the ZapPad endpoints. It does not create or publish that quota. |
| `ZAPPAD_LAUNCHER_ADDRESS` | Exact launcher address from finalized deployment-verification evidence. |
| `ZAPPAD_LAUNCHER_DEPLOY_BLOCK` | Exact deployment block from that same evidence. |
| `ZAPPAD_LAUNCHER_CODE_HASH` | Exact launcher runtime-code hash from that same evidence. |
| `ZAPPAD_LAUNCH_WRITES_ENABLED` | Server-only release switch. Exact lowercase `true` is required; every other value is false. |

No legacy, generic, shared-prefix, or browser-exposed launcher aliases are
accepted. A Production release must use the canonical server-only names above.
The launcher address, block, and code hash must all come from one receipt-bound
evidence artifact for the exact Git SHA. Never take them from a dry-run
manifest, predicted address, browser receipt, or explorer page.

At the current source-ready stage there is no approved launcher address, deploy
block, or code hash. Leave them unset and keep
`ZAPPAD_LAUNCH_WRITES_ENABLED=false`.

In Production, an RPC URL alone never enables the runtime or relay. Both
`ZAPPAD_RPC_RELAY_ENABLED=true` and
`ZAPPAD_RPC_DURABLE_QUOTA_ENABLED=true` are required. If either is absent or
false, config, health, and `/api/launch/rpc` remain fail closed. The durable
quota flag is an assertion about an external Vercel Firewall or equivalent
control; the application cannot create that control itself.

## Canonical external dependencies

These are existing Robinhood Chain dependencies, not ZapPad deployments:

| Dependency | Address | Expected runtime code hash |
| --- | --- | --- |
| Uniswap v3 position manager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | `0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f` |
| Uniswap v3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | `0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739` |
| Swap router | `0xCaf681a66D020601342297493863E78C959E5cb2` | `0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc` |
| WETH proxy | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | `0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353` |
| USDG proxy | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6` |

WETH's pinned implementation is
`0xC6B81b429797E0f555440b70cD99e032D7AE947e` with runtime code hash
`0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650`.
USDG's pinned implementation is
`0x68184C449E1a8f34fA18d289737129FD27B66f8F` with runtime code hash
`0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf`.

## Runtime identity

`/api/launch/health` selects one recent head and requires all of the following
at that stabilized block:

- chain ID `4663` and head age no greater than five minutes;
- launcher code present at the configured deploy block, absent immediately
  before it, and byte-identical at the current head;
- configured launcher runtime-code hash matches;
- `ROBINHOOD_CHAIN_ID()` and `LAUNCH_CONFIG_DOMAIN()` match the reviewed
  constants;
- launcher readbacks match the canonical position manager, v3 factory, swap
  router, WETH, and USDG addresses;
- exact runtime-code hashes match for the position manager, factory, router,
  WETH proxy, and USDG proxy;
- EIP-1967 implementation addresses and implementation-code hashes match for
  both WETH and USDG;
- the protocol Safe and both ZapPad factories have code;
- each factory's irreversible `launchpad()` back-pointer matches the launcher.

Any missing, stale, malformed, reorganized, or mismatched probe returns a
degraded `503` and keeps reads and writes disabled. A healthy `200` authorizes
only the runtime state it reports; it is not a legal, audit, or release
approval.

`/api/launch/config` exposes `readEnabled=true` only when the same identity is
ready. It exposes `launchEnabled=true` only when identity is ready **and** the
server-only write switch requests writes.

## Bounded RPC

`POST /api/launch/rpc` accepts a small read/simulation allowlist, including
chain/head reads, bounded `eth_call`, `eth_estimateGas`, code, balance,
transaction receipt, storage, and log reads. It enforces:

- same-origin requests;
- JSON content type and a 32 KiB request limit;
- no batches and no transaction-broadcast methods;
- bounded calldata, gas, fee-history size, topic fan-out, address fan-out, and
  5,000-block log windows;
- a 12-second upstream timeout and 2 MB response limit;
- matching JSON-RPC IDs and valid upstream JSON.

The in-app RPC endpoint is not a general node and never accepts
`eth_sendRawTransaction`. Wallet submission goes directly through the user's
wallet after the exact transaction is simulated and reviewed.

## Read-only Preview

A source-ready Preview is expected to show:

- `/launch` and its subroutes render normally;
- config reports `readEnabled=false`, `launchEnabled=false`, and a null
  launcher;
- health returns `503 degraded`;
- RPC reads fail closed when no provider is configured, transaction broadcast
  is rejected before any upstream call, and cross-origin/batch/invalid-method
  requests are rejected;
- search and social metadata label ZapPad as an OpenZaps feature, not a
  deployed protocol.

Before a configured Production read-only release, publish and review the
durable edge quota, then set both relay flags. Do not set the flags first and
treat them as proof the quota exists.

This is a correct pre-deployment state. Do not insert placeholder addresses to
make the interface appear ready.

## Operational response

If any identity probe drifts after activation:

1. Keep the write switch false or immediately redeploy the exact serving SHA
   with it false.
2. Preserve health output, provider observations, deployment identity, and
   logs without exposing the RPC credential.
3. Compare the launcher and every canonical dependency at one fixed block
   across independently operated RPC origins.
4. Treat a WETH/USDG proxy implementation change as a new security-review
   event even if direct onchain calls still work.
5. Do not change the expected code hash merely to restore a green health page.
6. Restore reads first only after evidence is reconciled; restore writes only
   through the full activation gate.
