/**
 * Which protocols a builder block actually touches when it executes.
 *
 * The catalog in `blocks.ts` speaks in *actions* — swap, supply, add
 * liquidity — and deliberately keeps the venue inside the params, because the
 * lego shapes are about what flows, not where. This module is the other half
 * of that decision: given a block and its current param values, it names the
 * protocols the step would route through, so the builder can badge a card with
 * the marks of what it really calls under the hood.
 *
 * The mapping is editorial, not derived from the adapter registry on purpose.
 * `chains.ts` answers "what is deployed"; this answers "what does this block
 * *mean*" — a supply into Morpho is a Morpho step even in a world where no
 * Morpho adapter exists yet, and the badge should say so rather than go blank
 * the moment an env var is unset. Pure and synchronous, so it can badge a
 * shared link during server render without an RPC in sight.
 */

export type ProtocolId =
  | "uniswap-v4"
  | "uniswap-v3"
  | "aerodrome"
  | "openzaps-vault"
  | "morpho"
  | "aave"
  | "compound"
  | "canonical-bridge"
  | "wrapped-native";

export type ProtocolInfo = { readonly id: ProtocolId; readonly name: string };

/**
 * Display names, and — via `Object.keys` below — the runtime enumeration of
 * the union. A `Record` keyed by `ProtocolId` means adding a protocol without
 * naming it is a type error, not a badge with a hole in it.
 */
const PROTOCOL_NAME: Record<ProtocolId, string> = {
  "uniswap-v4": "Uniswap v4",
  "uniswap-v3": "Uniswap v3",
  aerodrome: "Aerodrome",
  "openzaps-vault": "OpenZaps vault",
  morpho: "Morpho",
  aave: "Aave",
  compound: "Compound",
  "canonical-bridge": "Canonical bridge",
  "wrapped-native": "Wrapped native",
};

/** Every protocol id, in declaration order — the union, but iterable. */
export const PROTOCOL_IDS: readonly ProtocolId[] = Object.keys(PROTOCOL_NAME) as ProtocolId[];

export function protocolName(id: ProtocolId): string {
  return PROTOCOL_NAME[id];
}

function info(id: ProtocolId): ProtocolInfo {
  return { id, name: PROTOCOL_NAME[id] };
}

/**
 * The swap block's `venue` options, verbatim from the catalog. An unknown or
 * missing venue falls back to Uniswap v4 rather than no badge: it is the only
 * venue with a deployed adapter, so it is what an unspecified swap would
 * actually route through.
 */
const SWAP_VENUE: Readonly<Record<string, ProtocolId>> = {
  "Uniswap v4": "uniswap-v4",
  "Uniswap v3": "uniswap-v3",
  Aerodrome: "aerodrome",
};

/** The supply block's `market` options, verbatim from the catalog. */
const SUPPLY_MARKET: Readonly<Record<string, ProtocolId>> = {
  ZapVault: "openzaps-vault",
  Morpho: "morpho",
  "Aave v3": "aave",
  "Compound v3": "compound",
};

/**
 * The protocols a block interacts with, given its current param values.
 *
 * Action blocks (plus `lp-position`, the one source that starts *inside* a
 * protocol — its ozRANGE shares are OpenZaps vault shares) return at least one
 * protocol. Everything else — plain sources, guards, sinks, unknown ids —
 * returns an empty array, which callers read as "no badge": a guard constrains
 * the chain without touching a protocol, and inventing one for it would be a
 * lie in exactly the place this module exists to tell the truth.
 */
export function protocolsForAction(blockId: string, params: Readonly<Record<string, unknown>>): ProtocolInfo[] {
  switch (blockId) {
    case "swap":
      return [info(SWAP_VENUE[String(params.venue ?? "")] ?? "uniswap-v4")];

    // Both marks, deliberately: the ZapRangeVault is an OpenZaps primitive,
    // and the position it manages lives in a Uniswap v4 pool. Showing only
    // one half would hide either the custodian or the venue.
    case "add-liquidity":
    case "remove-liquidity":
      return [info("uniswap-v4"), info("openzaps-vault")];

    case "lp-position":
      return [info("openzaps-vault")];

    case "supply":
      return [info(SUPPLY_MARKET[String(params.market ?? "")] ?? "morpho")];

    // Aave is the only borrow venue the catalog describes, and `draw-debt`
    // realises the line `borrow` opened — same protocol, second step.
    case "borrow":
    case "draw-debt":
      return [info("aave")];

    case "unwrap":
      return [info("wrapped-native")];

    case "bridge":
      return [info("canonical-bridge")];

    // The catalog's gauge and fee sources are v4-adjacent placeholders until
    // a real gauge adapter names something more specific — `split`, which
    // fans a balance ahead of priced v4 steps, rides along for the same
    // reason. Badging them v4 is honest about where the value sits today.
    case "split":
    case "stake":
    case "accrue":
    case "harvest":
      return [info("uniswap-v4")];

    default:
      return [];
  }
}

/**
 * The protocols behind a RESOLVED console route, by adapter kind. Unlike
 * `protocolsForAction`, every kind here is deployed truth from `chains.ts` —
 * a route only exists once its adapter is live, so this mapping can be total
 * without editorialising.
 */
export function protocolsForRouteKind(
  kind: "swap" | "swap-route" | "vault-deposit" | "vault-redeem" | "lp-deposit" | "lp-withdraw",
): ProtocolInfo[] {
  switch (kind) {
    case "swap":
    case "swap-route":
      return [info("uniswap-v4")];
    // The LP legs touch both: the swap half runs in the Uniswap v4 pool, the
    // position is custodied by the OpenZaps range vault.
    case "lp-deposit":
    case "lp-withdraw":
      return [info("uniswap-v4"), info("openzaps-vault")];
    case "vault-deposit":
    case "vault-redeem":
      return [info("openzaps-vault")];
  }
}
