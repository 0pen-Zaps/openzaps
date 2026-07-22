import { BLOCKS, RECIPES } from "@/lib/blocks";

/**
 * Copy and constants for the LINES preview.
 *
 * Anything countable is read from the catalog rather than typed, on the same
 * rule the production home page follows: a block added to `BLOCKS` updates the
 * claim about how many blocks there are, so the pitch cannot drift away from
 * the product. This file holds only the words.
 */

/** Rules the hero bolt is sliced into. The intro counts these out loud. */
export const BOLT_LINES = 32;

export const HERO = {
  eyebrow: "Bounded policy capsules for agent-triggered DeFi",
  headline: ["Nobody should hand", "a bot their wallet."],
  body:
    "So don't. Give it one route, bounded before it runs, signed once, with limits the contract enforces and an exit you keep. Everything outside that line is refused by construction — not by trust, and not by a dashboard toggle.",
} as const;

export const STATS = [
  { n: "0", label: "Broad wallet approvals", note: "Exact amounts, reset to zero" },
  { n: String(BLOCKS.length), label: "Typed blocks", note: "They only seat where shapes match" },
  { n: "1", label: "Bounded route live", note: "aeWETH ↔ 0xZAPS" },
  { n: "63/0", label: "Contract tests pass/fail", note: "Pre-audit, stated plainly" },
] as const;

/** What the whole thing refuses to do. The blunt list is the pitch. */
export const BOUNDS = [
  "No arbitrary target plus calldata — fixed adapters only",
  "Exact approvals, reset to zero on every path",
  "Authorization consumed before any external call",
  "Balance deltas measured, not assumed",
  "An owner exit that nothing can gate",
  "Contract wallets sign the same typed policy",
] as const;

export const STEPS = [
  {
    n: "01",
    title: "Compose",
    body: `Drag ${BLOCKS.length} typed blocks, or open one of ${RECIPES.length} blueprints. A block only seats where the shape flowing out matches the shape the next one expects.`,
    tag: "Visual builder",
  },
  {
    n: "02",
    title: "Review",
    body: "Connector fit, block maturity, the governing slippage cap, guard coverage, a gas estimate. Compiled from the chain you drew, before any wallet is asked for anything.",
    tag: "No wallet yet",
  },
  {
    n: "03",
    title: "Deploy",
    body: "Only a design that reduces to the one route the live contracts implement leaves the canvas. You create it, fund it, and sign it. Everything else saves as a design.",
    tag: "One live route",
  },
  {
    n: "04",
    title: "Verify",
    body: "Every capsule gets a page: factory provenance, clone integrity, a policy that rehashes to its committed hash, and every execution its own logs contain.",
    tag: "Per-capsule proof",
  },
] as const;

export const AUTHORITY = [
  {
    n: "01",
    kind: "Deposit",
    title: "Pre-funded immutable zap",
    body: "Assets sit inside a narrow policy capsule. The agent triggers the frozen action graph and nothing else. You keep an unconditional withdraw.",
    who: "Recurring automation",
  },
  {
    n: "02",
    kind: "Signature",
    title: "EIP-712 typed intent",
    body: "One-shot authority binds chain, zap, nonce, deadline, recipient, fee cap, gas and policy hash before a relayer touches it.",
    who: "Infrequent execution",
  },
  {
    n: "03",
    kind: "Wallet-native",
    title: "Safe / ERC-1271 signer",
    body: "Contract wallets sign the same typed policy. The relayer stays a submitter, simulator and monitor — never an operator with discretion.",
    who: "Power users",
  },
] as const;
