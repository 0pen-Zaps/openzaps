/**
 * App-level 0xZAPS holder utilities.
 *
 * These are conveniences the web app unlocks for connected wallets holding
 * 0xZAPS. They are enforced by the app, not the protocol: core workflows
 * (create, fund, execute, recover) are never token-gated, and holding the
 * token grants no governance, staking, revenue, yield, equity, or fee rights.
 */

export type HolderTier = "none" | "holder" | "operator";

/** 100,000 0xZAPS (18 decimals) unlocks Holder utilities. */
export const HOLDER_THRESHOLD = 100_000n * 10n ** 18n;
/** 1,000,000 0xZAPS unlocks Operator utilities. */
export const OPERATOR_THRESHOLD = 1_000_000n * 10n ** 18n;

/** How often Holder-tier live quotes auto-refresh in the app. */
export const QUOTE_AUTO_REFRESH_MS = 20_000;

export function holderTierFor(balance: bigint): HolderTier {
  if (balance >= OPERATOR_THRESHOLD) return "operator";
  if (balance >= HOLDER_THRESHOLD) return "holder";
  return "none";
}

export function tierLabel(tier: HolderTier): string {
  if (tier === "operator") return "0xZAPS Operator";
  if (tier === "holder") return "0xZAPS Holder";
  return "";
}

/** Saved-zap history slots the app keeps per wallet. */
export function savedZapLimitFor(tier: HolderTier): number {
  if (tier === "operator") return 100;
  if (tier === "holder") return 50;
  return 20;
}

/** Confirmed-receipt entries the app retains per wallet. */
export function receiptLimitFor(tier: HolderTier): number {
  return tier === "none" ? 20 : 100;
}

/** Upper bound across all tiers — reads must never truncate below this. */
export const MAX_RECEIPT_RETENTION = 100;

/** Whether receipt JSON export is unlocked. */
export function canExportReceipts(tier: HolderTier): boolean {
  return tier !== "none";
}

/** Whether live quotes auto-refresh while a quote is on screen. */
export function autoRefreshQuotes(tier: HolderTier): boolean {
  return tier !== "none";
}
