# Hedger → OpenZaps pattern audit

Date: 2026-07-26

## Sources reviewed

- Hedger production application and its public `hedger-amber.vercel.app` surface.
- Vercel deployment snapshots for `hedger`, `hedger-liquid-delta`, and `hedger-landing-groundup` (read through authenticated Vercel CLI access; no credentials copied into this repository).
- Historical Hedger source at commit `79a4a812d882cd35370dcf1354a833f56af22778`.
- Hedger's IL Eliminator contracts, adapters, seven-step SVG scenes, scroll engine, MotionProvider/Calm control, wallet flow, position views, and current forensics result cards.
- The current OpenZaps landing, composer, live Zap console, contracts, tests, and release docs.

The decision rule was not “copy Hedger.” It was: preserve the useful interaction or safety property, re-express it in OpenZaps' immutable policy-capsule model, and reject anything that widens authority or implies unsupported protocol behavior.

## Decision matrix

| Hedger pattern | Decision | OpenZaps application |
| --- | --- | --- |
| Calm / Cinematic motion control | **Adapt** | Added a persisted global motion control. The OS reduced-motion setting remains a hard accessibility floor. CSS animations, WebGL, pointer tracking, scroll parallax, count-ups, custom cursor, and builder previews now consume the same preference. |
| Scroll scenes default to their final static frame | **Adapt** | Preserved OpenZaps' no-JS/static truth and made manual Calm mode activate it immediately. Active JS loops tear down and can restart when Cinematic is restored. |
| One input splitting through several protocol legs | **Reimplement** | OpenZaps already expresses the broader version: `Collapse` turns five manual actions into one signed Zap, `RouteRail` shows protocol hops, and `ZapCore` uses travelling route pulses. Hedger's LP/leverage ratios were not copied. |
| Particle/path motion as explanatory data, not decoration | **Reimplement** | OpenZaps' yellow route pulses and protocol orbit remain tied to deployed/catalog state. The new motion control can stop them without removing the information. |
| Structured verdict/evidence cards | **Adapt** | Added an execution flight recorder to the live Zap console: preflight → wallet review → submitted hash → receipt verification. A hash is exposed while polling, wallet rejection is labelled “not submitted,” and interrupted polling preserves the explorer link as “unknown.” |
| Findings confidence and provenance | **Reimplement** | `ExecutionDemo`, `SecurityPanel`, `/explore`, creation receipts, and the new flight recorder report what was checked and avoid invented output amounts. |
| Wallet connection / network / action phases | **Reimplement** | OpenZaps' shared wallet session already clears account-owned state on account departure and fails closed on chain/account changes. The flight recorder now makes write phases durable in the UI before confirmation. |
| Per-scene color semantics | **Adapt** | Kept OpenZaps' single yellow energy language instead of Hedger's LP/leverage palette; error and unknown receipt states remain red. |
| Hedger payoff curve and IL-specific simulator | **Reject** | Product-specific and potentially misleading for a universal intent composer. OpenZaps shows route structure and enforced bounds rather than synthetic performance. |
| Hedger branding, hedgehog/NFT visuals, red/cyan/violet palette | **Reject** | Brand-specific; not an OpenZaps primitive. |

## Onchain review

### Retain or reimplement

- **Deadlines:** Hedger's top-level deadline guard is useful, but OpenZaps already binds `validAfter` and `deadline` inside EIP-712 intents and checks them before external calls.
- **Slippage:** Hedger's top-level `minAssetOut` is useful, but OpenZaps is stronger for this product: it re-quotes at click time, refuses a fresh quote below the user-reviewed floor, signs `minOut`, measures the run's output delta, and enforces the floor net of fees.
- **Approval hygiene:** exact allowance followed by reset is retained. OpenZaps applies it at the immutable capsule boundary and its adapters refuse arbitrary call targets/selectors.
- **Measured deltas:** both projects contain useful before/after balance measurement. OpenZaps already settles only the current run's measured output delta, preventing dust or donated balances from becoming somebody else's receipt.
- **Reentrancy and checks-effects-interactions:** already present in OpenZaps. Authorization and nonce consumption happen before external adapter calls.
- **Recovery evidence:** Hedger's “custodied vs free” accounting is correct for a shared position instrument. OpenZaps uses one owner-isolated capsule per policy, so unconditional owner-only `emergencyExit` is the correct equivalent.
- **Transaction lifecycle:** the onchain controls were already stronger than Hedger's app presentation. The missing useful piece was UI evidence while a write is pending; that is now implemented without changing contract authority.

### Rejected contract transplants

- **Admin pause / mutable instrument configuration:** conflicts with immutable user-owned policy capsules and would introduce a new control plane.
- **Shared NFT position custody:** not a universal Zap primitive and would turn isolated capsules into pooled custody.
- **Arbitrary adapter `routeData`:** too broad for OpenZaps. OpenZaps adapters are credentials with fixed targets, selectors, assets, and data shapes.
- **Hedger v4 LP adapter's maximum ERC-20 Permit2 approval:** OpenZaps keeps exact approvals and resets them; no reason to widen allowance.
- **Internal AMM calls with zero minimums followed only by a final aggregate floor:** not copied. OpenZaps keeps each supported route bounded by its signed execution floor and allowlisted adapter surface.
- **`block.timestamp` as an immediate downstream AMM deadline:** valid but unnecessarily loose. OpenZaps' owner-signed intent deadline is the authoritative execution window.
- **Hedger-specific leverage, oracle, rebalance, and custody code:** outside OpenZaps' product and threat model.

No Solidity was changed by this audit: every useful generic safety property was already implemented more narrowly in OpenZaps, while the remaining Hedger contract code was product-specific or would weaken the capsule model.

## Files changed

- `src/lib/motion-preference.ts`
- `src/components/useReducedMotionPreference.ts`
- `src/components/MotionControl.tsx`
- `src/app/layout.tsx`
- `src/app/globals.css`
- `src/components/BoltIntro.tsx`
- `src/components/Spotlight.tsx`
- `src/components/CountUp.tsx`
- `src/app/(landing)/motion.ts`
- `src/app/(landing)/Atmosphere.tsx`
- `src/app/(landing)/ZapCore.tsx`
- `src/app/(landing)/Collapse.tsx`
- `src/app/(landing)/VelocityFx.tsx`
- `src/app/(landing)/Cursor.tsx`
- `src/app/(site)/zap/ZapBuilder.tsx`
- `src/lib/transaction-lifecycle.ts`
- `src/app/(site)/zap/TransactionLifecycle.tsx`
- `src/app/(site)/zap/Console.tsx`
- `src/app/(site)/zap/app.module.css`
- Focused tests in `src/lib/motion-preference.test.ts` and `src/lib/transaction-lifecycle.test.ts`.
