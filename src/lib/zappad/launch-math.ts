import {
  encodeAbiParameters,
  formatUnits,
  getCreate2Address,
  keccak256,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { FEE_TIERS } from "./chain";

export const TOKEN_SUPPLY_UNITS = 1_000_000_000;
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;

const RECOVERABLE_SALT_ERROR_NAMES = [
  "PoolAlreadyInitialized",
  "TokenAlreadyExists",
  "TokenNotBelowPair",
] as const;
const RECOVERABLE_SALT_ERROR_SELECTORS = RECOVERABLE_SALT_ERROR_NAMES.map(
  (name) => toFunctionSelector(`${name}()`),
);

export function feeTierSpacing(feeTier: number) {
  return FEE_TIERS.find((tier) => tier.fee === feeTier)?.spacing ?? 200;
}

export function alignTickDown(tick: number, spacing: number) {
  let aligned = Math.trunc(tick / spacing) * spacing;
  if (tick < 0 && tick % spacing !== 0) aligned -= spacing;
  return aligned;
}

export function marketCapToFloorTick(
  marketCap: number,
  pairDecimals: number,
  feeTier: number,
) {
  const spacing = feeTierSpacing(feeTier);
  const maxUsable = Math.trunc(MAX_TICK / spacing) * spacing;
  const minUsable = -maxUsable;

  if (!Number.isFinite(marketCap) || marketCap <= 0) {
    return Math.max(minUsable, alignTickDown(-98_400, spacing));
  }

  const pairPerToken = marketCap / TOKEN_SUPPLY_UNITS;
  const rawRatio = pairPerToken * 10 ** (pairDecimals - 18);
  const tick = Math.log(rawRatio) / Math.log(1.0001);
  return Math.max(
    minUsable,
    Math.min(maxUsable - spacing, alignTickDown(tick, spacing)),
  );
}

export function isSortedBelow(token: Address, pairedAsset: Address) {
  return BigInt(token) < BigInt(pairedAsset);
}

export function predictFactoryTokenAddress({
  factory,
  creator,
  userSalt,
  initCodeHash,
}: {
  factory: Address;
  creator: Address;
  userSalt: Hex;
  initCodeHash: Hex;
}) {
  const effectiveSalt = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [creator, userSalt],
    ),
  );
  return getCreate2Address({
    from: factory,
    salt: effectiveSalt,
    bytecodeHash: initCodeHash,
  });
}

export interface ParsedMetadataUri {
  valid: boolean;
  kind: "https" | "ipfs" | "arweave" | "unknown";
  normalized: string;
  error?: string;
}

export function parseMetadataUri(input: string): ParsedMetadataUri {
  const normalized = input.trim();
  if (!normalized) {
    return {
      valid: false,
      kind: "unknown",
      normalized,
      error: "Metadata URI is required.",
    };
  }
  if (normalized.length > 1_024) {
    return {
      valid: false,
      kind: "unknown",
      normalized,
      error: "Metadata URI is too long.",
    };
  }
  if (/^ipfs:\/\/[a-z0-9]+(?:\/.*)?$/i.test(normalized)) {
    return { valid: true, kind: "ipfs", normalized };
  }
  if (/^ar:\/\/[a-z0-9_-]+(?:\/.*)?$/i.test(normalized)) {
    return { valid: true, kind: "arweave", normalized };
  }
  if (/^https:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      if (!url.hostname) throw new Error("missing host");
      return { valid: true, kind: "https", normalized: url.toString() };
    } catch {
      return {
        valid: false,
        kind: "unknown",
        normalized,
        error: "HTTPS metadata URI is invalid.",
      };
    }
  }
  return {
    valid: false,
    kind: "unknown",
    normalized,
    error: "Use an https://, ipfs:// or ar:// metadata URI.",
  };
}

export function shortAddress(value?: string | null, left = 6, right = 4) {
  if (!value) return "—";
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

export function formatTokenAmount(
  amount: bigint | undefined,
  decimals: number,
  maximumFractionDigits = 5,
) {
  if (amount === undefined) return "—";
  const numeric = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(numeric)) return formatUnits(amount, decimals);
  return numeric.toLocaleString(undefined, { maximumFractionDigits });
}

export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function readableError(error: unknown) {
  if (typeof error === "object" && error) {
    const candidate = error as { shortMessage?: string; message?: string };
    const message = candidate.shortMessage ?? candidate.message;
    if (message) return message.replace(/\s+/g, " ").slice(0, 260);
  }
  return "The request could not be completed.";
}

export function isRecoverableLaunchSaltError(error: unknown) {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "string") {
      const currentText = current;
      if (
        RECOVERABLE_SALT_ERROR_NAMES.some((name) => currentText.includes(name)) ||
        RECOVERABLE_SALT_ERROR_SELECTORS.some((selector) =>
          currentText.toLowerCase().includes(selector.toLowerCase()),
        )
      ) {
        return true;
      }
      break;
    }
    if (typeof current !== "object") break;

    const candidate = current as {
      cause?: unknown;
      data?: unknown;
      details?: unknown;
      errorName?: unknown;
      message?: unknown;
      name?: unknown;
      shortMessage?: unknown;
    };
    const fields = [
      candidate.errorName,
      candidate.name,
      candidate.shortMessage,
      candidate.message,
      candidate.details,
      typeof candidate.data === "string" ? candidate.data : undefined,
      typeof candidate.data === "object" && candidate.data
        ? (candidate.data as { errorName?: unknown }).errorName
        : undefined,
    ];
    if (
      fields.some(
        (field) =>
          typeof field === "string" &&
          (RECOVERABLE_SALT_ERROR_NAMES.some((name) => field.includes(name)) ||
            RECOVERABLE_SALT_ERROR_SELECTORS.some((selector) =>
              field.toLowerCase().includes(selector.toLowerCase()),
            )),
      )
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
