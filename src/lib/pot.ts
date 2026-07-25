import { formatUnits, getAddress, type Address, type Hex } from "viem";

import { assetDecimalsFor, assetSymbolFor } from "@/lib/activity";
import { ROBINHOOD_ASSETS } from "@/lib/robinhood";

/**
 * The 0xZAPS lottery pot: what it holds, what it owes, and what it has paid.
 *
 * Everything here is deliberately conservative about what may be CLAIMED, because
 * the pot's own design defers two things the UI would otherwise be tempted to show:
 *
 *  1. Tickets are credited as the raw fee `amount`, summed ACROSS ASSETS with no
 *     normalization (ZapLotteryPot.notifyContribution). One aeWETH and one USDG
 *     credit wildly different counts, so a ticket share is NOT a probability and
 *     must never be rendered as odds.
 *  2. `awardRound` is governance-gated with no schedule — there is no timer, no
 *     auto-close, and therefore no countdown to render.
 *
 * What IS certain: the prize is real 0xZAPS held by the pot for the current round,
 * only 0xZAPS can ever be paid out, and only to an address holding tickets in that
 * round. Those are the claims this module supports.
 */

export const potAbi = [
  { type: "function", name: "currentRound", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "roundPrize", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalTickets", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "tickets",
    inputs: [{ type: "uint256" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    // Permissionless: anyone may push an accrued fee asset into the 0xZAPS prize.
    type: "function",
    name: "buyZaps",
    inputs: [
      { name: "assetIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minZapsOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

export const contributionRecordedEvent = {
  type: "event",
  name: "ContributionRecorded",
  inputs: [
    { name: "round", type: "uint256", indexed: true },
    { name: "player", type: "address", indexed: true },
    { name: "asset", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "zap", type: "address", indexed: true },
  ],
} as const;

export const zapsBoughtEvent = {
  type: "event",
  name: "ZapsBought",
  inputs: [
    { name: "round", type: "uint256", indexed: true },
    { name: "caller", type: "address", indexed: true },
    { name: "assetIn", type: "address", indexed: false },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "zapsOut", type: "uint256", indexed: false },
  ],
} as const;

export const roundAwardedEvent = {
  type: "event",
  name: "RoundAwarded",
  inputs: [
    { name: "round", type: "uint256", indexed: true },
    { name: "winner", type: "address", indexed: true },
    { name: "prize", type: "uint256", indexed: false },
  ],
} as const;

/** A fee asset sitting in the pot that is not yet prize — the open half of the loop. */
export interface PendingFeeAsset {
  asset: Address;
  symbol: string;
  /** Raw balance in the asset's own decimals. */
  balance: string;
  decimals: number;
}

export interface PotConversion {
  round: string;
  caller: Address;
  assetIn: Address;
  symbolIn: string;
  amountIn: string;
  zapsOut: string;
  txHash: Hex;
  blockNumber: string;
}

export interface PotAward {
  round: string;
  winner: Address;
  prize: string;
  txHash: Hex;
  blockNumber: string;
}

export interface PotSnapshot {
  address: Address;
  /** Which stack this pot belongs to, for the UI's own labelling. */
  label: string;
  round: string;
  /** 0xZAPS held for the current round — the only asset that can ever be paid out. */
  prize: string;
  totalTickets: string;
  /** Tickets for the connected wallet, when one is known. */
  yourTickets: string | null;
  /** Non-0xZAPS fee assets awaiting a permissionless buyZaps. */
  pending: PendingFeeAsset[];
  conversions: PotConversion[];
  awards: PotAward[];
}

/**
 * Total 0xZAPS this pot has ever put into a prize — converted plus paid out. Derived
 * from logs rather than a running counter, because the contract keeps none.
 */
export function lifetimeZapsBought(conversions: readonly PotConversion[]): bigint {
  return conversions.reduce((total, entry) => total + BigInt(entry.zapsOut), 0n);
}

export function lifetimeAwarded(awards: readonly PotAward[]): bigint {
  return awards.reduce((total, entry) => total + BigInt(entry.prize), 0n);
}

/**
 * A wallet's SHARE of the round's tickets, as a fraction, or null when it cannot be
 * stated honestly. This is explicitly NOT odds: tickets are raw fee amounts summed
 * across assets of different decimals and prices, so the share describes contribution
 * weight under the current (deferred) draw design and nothing more. Callers must label
 * it as such.
 */
export function ticketShare(yourTickets: string | null, totalTickets: string): number | null {
  if (yourTickets === null) return null;
  const total = BigInt(totalTickets);
  if (total <= 0n) return null;
  const mine = BigInt(yourTickets);
  if (mine <= 0n) return 0;
  // Scaled integer division keeps precision without going through a float on bigints.
  return Number((mine * 1_000_000n) / total) / 1_000_000;
}

/** True when the pot holds fee assets that nobody has converted into prize yet. */
export function hasPendingConversion(pending: readonly PendingFeeAsset[]): boolean {
  return pending.some((entry) => BigInt(entry.balance) > 0n);
}

/**
 * The minimum 0xZAPS a conversion must return, given a quote and a slippage band.
 * `buyZaps` reverts below this, so a caller that passes 0 would accept any output —
 * the UI must always send a real floor.
 */
export function conversionFloor(quotedZapsOut: bigint, slippageBps: number): bigint {
  if (quotedZapsOut <= 0n) return 0n;
  const bps = BigInt(Math.min(Math.max(Math.trunc(slippageBps), 0), 9_999));
  return (quotedZapsOut * (10_000n - bps)) / 10_000n;
}

/** Display helper: pot amounts are always 0xZAPS (18dp) unless an asset is named. */
export function formatPotAmount(raw: string, decimals = 18): string {
  const value = Number(formatUnits(BigInt(raw), decimals));
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (value < 0.000001) return value.toExponential(3);
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** Normalize a raw pending-balance read into the shape the UI renders. */
export function toPendingAsset(asset: Address, balance: bigint): PendingFeeAsset {
  return {
    asset: getAddress(asset),
    symbol: assetSymbolFor(asset),
    balance: balance.toString(),
    decimals: assetDecimalsFor(asset),
  };
}

/**
 * Fee assets the pot can actually turn into prize.
 *
 * `buyZaps` routes through the pot's IMMUTABLE `BUY_ADAPTER`, which on both live pots
 * is the aeWETH/0xZAPS swap adapter (0x04f62dA4…). That adapter reverts
 * `UnsupportedToken` for anything that is not one of its two currencies, and the pot
 * itself rejects 0xZAPS as an input — so aeWETH is the only convertible asset there is.
 */
export const CONVERTIBLE_FEE_ASSETS: readonly Address[] = [ROBINHOOD_ASSETS.weth];

/**
 * Fee assets a pot can RECEIVE but can never convert or release.
 *
 * A capsule settling in USDG (the token allowlist permits it) pays its 20% here, and
 * then: `buyZaps` reverts because the pinned adapter does not take USDG, `awardRound`
 * only ever transfers 0xZAPS, and there is no owner drain. The balance is stranded
 * permanently. The UI must say exactly that rather than offer a button that reverts.
 */
export const STRANDED_FEE_ASSETS: readonly Address[] = [ROBINHOOD_ASSETS.usdg, ROBINHOOD_ASSETS.ozusdg];

/** Every non-prize asset worth reading a balance for, convertible or not. */
export const POT_FEE_ASSETS: readonly Address[] = [...CONVERTIBLE_FEE_ASSETS, ...STRANDED_FEE_ASSETS];

/** True when this asset can be pushed into the prize by anyone calling buyZaps. */
export function isConvertible(asset: Address): boolean {
  return CONVERTIBLE_FEE_ASSETS.some((entry) => entry.toLowerCase() === asset.toLowerCase());
}
