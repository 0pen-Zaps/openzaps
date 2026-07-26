import { getAddress, type Address } from "viem";

/**
 * Parse the first account emitted by an EIP-1193 wallet. Malformed payloads
 * disconnect the app instead of leaving a stale account mounted.
 */
export function accountFromWalletPayload(value: unknown): Address | null {
  if (!Array.isArray(value)) return null;
  const first = value.find((item): item is string => typeof item === "string");
  if (!first) return null;
  try {
    return getAddress(first);
  } catch {
    return null;
  }
}

/** Accept the hex chain id required by EIP-1193 and safe integer test doubles. */
export function chainIdFromWalletPayload(value: unknown): number | null {
  const parsed =
    typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)
      ? Number.parseInt(value, 16)
      : typeof value === "number"
        ? value
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A first connection is additive: keep the route/form the user configured.
 * Once a real owner exists, leaving it must drop every account-scoped view.
 */
export function shouldResetAccountScope(previous: Address | null, next: Address | null): boolean {
  return previous !== null && previous !== next;
}

export type WalletSessionStatus = "checking" | "connected" | "disconnected";
