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

/**
 * Mirrors the four figures the production home page leads with.
 *
 * A hand-written contract-test count used to sit in the fourth slot. It was
 * removed here when the real page dropped it, and that is the right reason to
 * remove it: the contracts repo gained several thousand lines of new tests in a
 * single merge, so any number typed into this file is wrong shortly after it is
 * typed. The three counted figures all read from the catalog for the same
 * reason.
 */
export const STATS = [
  { n: "0", label: "Broad wallet approvals", note: "Exact amounts, reset to zero" },
  { n: String(BLOCKS.length), label: "Typed blocks in the builder", note: "They only seat where shapes match" },
  { n: String(RECIPES.length), label: "Blueprints to start from", note: "Open one instead of starting blank" },
  { n: "1", label: "Route the live contracts can deploy", note: "aeWETH ↔ 0xZAPS" },
] as const;

/** What the whole thing refuses to do. The blunt list is the pitch. */
/** Kept word-for-word in step with the `security` list on the production home page. */
export const BOUNDS = [
  "Fixed adapters only — no arbitrary target or calldata",
  "Exact approvals, reset to zero on every path",
  "Authorization consumed before any external call",
  "Measured balance-delta postconditions",
  "Unconditional owner emergency exit",
  "ERC-1271 contract-wallet signatures",
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
    who: "One signed step",
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
