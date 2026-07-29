// Release-approved adapter runtime pins.
//
// A registry allowlist is an emergency/governance control, not a bytecode identity proof. Before
// an intent route reaches simulation, the executor reads the immutable policy from the proven
// capsule, checks every referenced adapter is still allowlisted, and matches its runtime hash to
// this independently supplied release manifest.
import { existsSync, readFileSync } from "node:fs";
import { getAddress, keccak256, zeroAddress } from "viem";

import { adapterRegistryAbi, lotteryPotAbi, openZapV3Abi } from "./abi.mjs";

export const ADAPTER_MANIFEST_VERSION = 1;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_ROUTE_STEPS = 16;

export class AdapterManifestConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterManifestConfigError";
  }
}

export class AdapterManifestVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterManifestVerificationError";
  }
}

function manifestChainId(value) {
  if (
    (typeof value !== "number" && typeof value !== "string")
    || !/^[0-9]+$/.test(String(value))
  ) {
    throw new AdapterManifestConfigError("adapter manifest chainId must be a decimal integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AdapterManifestConfigError("adapter manifest chainId must be a positive safe integer");
  }
  return parsed;
}

/**
 * Parse and normalize an adapter release manifest. Hashes are never inferred from the chain:
 * operators must supply release-approved runtime hashes explicitly.
 */
export function parseAdapterManifest(input, expectedChainId) {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new AdapterManifestConfigError(`adapter manifest is not valid JSON: ${error.message}`);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterManifestConfigError("adapter manifest must be a JSON object");
  }
  if (raw.version !== ADAPTER_MANIFEST_VERSION) {
    throw new AdapterManifestConfigError(
      `adapter manifest version must be ${ADAPTER_MANIFEST_VERSION}`,
    );
  }
  const chainId = manifestChainId(raw.chainId);
  if (Number(expectedChainId) !== chainId) {
    throw new AdapterManifestConfigError(
      `adapter manifest chainId ${chainId} does not match executor chain ${expectedChainId}`,
    );
  }
  if (!Array.isArray(raw.adapters)) {
    throw new AdapterManifestConfigError("adapter manifest adapters must be an array");
  }

  const adapters = Object.create(null);
  for (const [index, entry] of raw.adapters.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AdapterManifestConfigError(`adapter manifest entry ${index} must be an object`);
    }
    if (typeof entry.address !== "string" || !ADDRESS.test(entry.address)) {
      throw new AdapterManifestConfigError(`adapter manifest entry ${index} has a malformed address`);
    }
    if (typeof entry.runtimeCodeHash !== "string" || !HASH.test(entry.runtimeCodeHash)) {
      throw new AdapterManifestConfigError(
        `adapter manifest entry ${index} has a malformed runtimeCodeHash`,
      );
    }
    const address = getAddress(entry.address.toLowerCase());
    const key = address.toLowerCase();
    if (adapters[key]) {
      throw new AdapterManifestConfigError(`adapter manifest contains duplicate address ${address}`);
    }
    adapters[key] = Object.freeze({
      address,
      runtimeCodeHash: entry.runtimeCodeHash.toLowerCase(),
      label: typeof entry.label === "string" ? entry.label : null,
    });
  }

  return Object.freeze({
    version: ADAPTER_MANIFEST_VERSION,
    chainId,
    adapters: Object.freeze(adapters),
  });
}

export function loadAdapterManifestFile(path, expectedChainId) {
  if (!existsSync(path)) {
    return {
      manifest: null,
      error: `adapter manifest not found at ${path}`,
    };
  }
  try {
    return {
      manifest: parseAdapterManifest(readFileSync(path, "utf8"), expectedChainId),
      error: null,
    };
  } catch (error) {
    return {
      manifest: null,
      error: error?.message ?? String(error),
    };
  }
}

function stepAdapter(step, index) {
  const value = step?.adapter ?? step?.[0];
  try {
    return getAddress(String(value).toLowerCase());
  } catch {
    throw new AdapterManifestVerificationError(
      `capsule route step ${index} returned a malformed adapter address`,
    );
  }
}

function uniqueAddresses(addresses) {
  const seen = new Set();
  return addresses.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Verify every adapter the immutable capsule route can call at one pinned block.
 *
 * A missing/uncovered manifest is the only soft result, and only the caller's explicit watch-only
 * posture may accept it for reporting. Known hash mismatches, missing runtime code, a retired
 * adapter, malformed policy reads, and RPC uncertainty always throw before simulation.
 */
export async function verifyRouteAdapterManifest(client, item, cfg, blockNumber) {
  const zap = getAddress(String(item?.intent?.zap).toLowerCase());
  let stepCountRaw;
  let registry;
  try {
    [stepCountRaw, registry] = await Promise.all([
      client.readContract({
        address: zap,
        abi: openZapV3Abi,
        functionName: "stepCount",
        blockNumber,
      }),
      client.readContract({
        address: zap,
        abi: openZapV3Abi,
        functionName: "ADAPTERS",
        blockNumber,
      }),
    ]);
  } catch (error) {
    throw new AdapterManifestVerificationError(
      `capsule adapter dependencies are unreadable: ${error?.shortMessage ?? error?.message ?? String(error)}`,
    );
  }

  let stepCount;
  try {
    stepCount = BigInt(stepCountRaw);
  } catch {
    throw new AdapterManifestVerificationError("capsule stepCount is malformed");
  }
  if (stepCount <= 0n || stepCount > BigInt(MAX_ROUTE_STEPS)) {
    throw new AdapterManifestVerificationError(
      `capsule stepCount ${stepCount} is outside the supported 1-${MAX_ROUTE_STEPS} range`,
    );
  }

  let registryAddress;
  try {
    registryAddress = getAddress(String(registry).toLowerCase());
  } catch {
    throw new AdapterManifestVerificationError("capsule ADAPTERS registry address is malformed");
  }
  if (registryAddress === zeroAddress) {
    throw new AdapterManifestVerificationError("capsule ADAPTERS registry is the zero address");
  }

  let steps;
  try {
    steps = await Promise.all(
      Array.from({ length: Number(stepCount) }, (_, index) =>
        client.readContract({
          address: zap,
          abi: openZapV3Abi,
          functionName: "step",
          args: [BigInt(index)],
          blockNumber,
        }),
      ),
    );
  } catch (error) {
    throw new AdapterManifestVerificationError(
      `capsule route steps are unreadable: ${error?.shortMessage ?? error?.message ?? String(error)}`,
    );
  }
  const referenced = steps.map(stepAdapter);

  // v3.2 recurring-stack has one additional immutable market dependency after the frozen steps.
  if (item?.kind === "recurring-stack") {
    let zapsAdapter;
    try {
      zapsAdapter = await client.readContract({
        address: zap,
        abi: openZapV3Abi,
        functionName: "ZAPS_ADAPTER",
        blockNumber,
      });
      zapsAdapter = getAddress(String(zapsAdapter).toLowerCase());
    } catch (error) {
      throw new AdapterManifestVerificationError(
        `capsule ZAPS_ADAPTER is unreadable: ${error?.shortMessage ?? error?.message ?? String(error)}`,
      );
    }
    if (zapsAdapter === zeroAddress) {
      throw new AdapterManifestVerificationError("capsule ZAPS_ADAPTER is the zero address");
    }
    referenced.push(zapsAdapter);
  }

  const adapters = uniqueAddresses(referenced);
  const manifest = cfg?.adapterManifest ?? null;
  const missing = adapters.filter(
    (address) => !manifest?.adapters?.[address.toLowerCase()],
  );
  const checks = await Promise.all(
    adapters.map(async (address) => {
      const entry = manifest?.adapters?.[address.toLowerCase()] ?? null;
      let runtime;
      let allowed;
      try {
        [runtime, allowed] = await Promise.all([
          client.getBytecode({ address, blockNumber }),
          client.readContract({
            address: registryAddress,
            abi: adapterRegistryAbi,
            functionName: "isAllowed",
            args: [address],
            blockNumber,
          }),
        ]);
      } catch (error) {
        throw new AdapterManifestVerificationError(
          `adapter ${address} cannot be verified: ${error?.shortMessage ?? error?.message ?? String(error)}`,
        );
      }
      if (!runtime || runtime === "0x") {
        throw new AdapterManifestVerificationError(`adapter ${address} has no runtime code`);
      }
      if (allowed !== true) {
        throw new AdapterManifestVerificationError(
          `adapter ${address} is not currently allowed by registry ${registryAddress}`,
        );
      }
      const observedHash = keccak256(runtime).toLowerCase();
      if (entry && observedHash !== entry.runtimeCodeHash) {
        throw new AdapterManifestVerificationError(
          `adapter ${address} runtime hash ${observedHash} does not match manifest ${entry.runtimeCodeHash}`,
        );
      }
      return {
        address,
        runtimeCodeHash: observedHash,
        manifestRuntimeCodeHash: entry?.runtimeCodeHash ?? null,
      };
    }),
  );

  if (!manifest || missing.length > 0) {
    const reason = cfg?.adapterManifestError
      ? cfg.adapterManifestError
      : missing.length > 0
        ? `manifest has no entry for ${missing.join(", ")}`
        : "adapter manifest is unavailable";
    return {
      verified: false,
      status: "manifest-gap",
      detail: reason,
      blockNumber,
      registry: registryAddress,
      adapters: checks,
      missing,
    };
  }

  return {
    verified: true,
    status: "verified",
    detail: `${checks.length} route adapter(s) match the release manifest`,
    blockNumber,
    registry: registryAddress,
    adapters: checks,
    missing: [],
  };
}

/**
 * Verify the lottery keeper's immutable conversion dependency at one pinned block.
 *
 * Pot conversions are permissionless, but the reference signer must not become a bypass around
 * the route-level manifest discipline. The configured pot must name the expected 0xZAPS token,
 * its immutable BUY_ADAPTER must remain allowlisted, and the adapter runtime must match the same
 * independently reviewed release manifest used for capsule routes.
 */
export async function verifyPotAdapterManifest(client, cfg, blockNumber) {
  let pot;
  let registry;
  let expectedZaps;
  try {
    pot = getAddress(String(cfg?.lotteryPot).toLowerCase());
    registry = getAddress(String(cfg?.adapterRegistry).toLowerCase());
    expectedZaps = getAddress(String(cfg?.zapsToken).toLowerCase());
  } catch {
    throw new AdapterManifestVerificationError(
      "pot, adapter registry, and 0xZAPS token must be configured as EVM addresses",
    );
  }
  if (pot === zeroAddress || registry === zeroAddress || expectedZaps === zeroAddress) {
    throw new AdapterManifestVerificationError(
      "pot, adapter registry, and 0xZAPS token must be nonzero",
    );
  }

  let adapter;
  let potZaps;
  try {
    [adapter, potZaps] = await Promise.all([
      client.readContract({
        address: pot,
        abi: lotteryPotAbi,
        functionName: "BUY_ADAPTER",
        blockNumber,
      }),
      client.readContract({
        address: pot,
        abi: lotteryPotAbi,
        functionName: "ZAPS",
        blockNumber,
      }),
    ]);
    adapter = getAddress(String(adapter).toLowerCase());
    potZaps = getAddress(String(potZaps).toLowerCase());
  } catch (error) {
    throw new AdapterManifestVerificationError(
      `pot conversion dependencies are unreadable: ${error?.shortMessage ?? error?.message ?? String(error)}`,
    );
  }
  if (adapter === zeroAddress) {
    throw new AdapterManifestVerificationError("pot BUY_ADAPTER is the zero address");
  }
  if (potZaps !== expectedZaps) {
    throw new AdapterManifestVerificationError(
      `pot ZAPS ${potZaps} does not match configured token ${expectedZaps}`,
    );
  }

  const entry = cfg?.adapterManifest?.adapters?.[adapter.toLowerCase()] ?? null;
  let runtime;
  let allowed;
  try {
    [runtime, allowed] = await Promise.all([
      client.getBytecode({ address: adapter, blockNumber }),
      client.readContract({
        address: registry,
        abi: adapterRegistryAbi,
        functionName: "isAllowed",
        args: [adapter],
        blockNumber,
      }),
    ]);
  } catch (error) {
    throw new AdapterManifestVerificationError(
      `pot adapter ${adapter} cannot be verified: ${error?.shortMessage ?? error?.message ?? String(error)}`,
    );
  }
  if (!runtime || runtime === "0x") {
    throw new AdapterManifestVerificationError(`pot adapter ${adapter} has no runtime code`);
  }
  if (allowed !== true) {
    throw new AdapterManifestVerificationError(
      `pot adapter ${adapter} is not currently allowed by registry ${registry}`,
    );
  }
  const observedHash = keccak256(runtime).toLowerCase();
  if (entry && observedHash !== entry.runtimeCodeHash) {
    throw new AdapterManifestVerificationError(
      `pot adapter ${adapter} runtime hash ${observedHash} does not match manifest ${entry.runtimeCodeHash}`,
    );
  }
  if (!entry) {
    return {
      verified: false,
      status: "manifest-gap",
      detail: cfg?.adapterManifestError
        ?? `manifest has no entry for pot adapter ${adapter}`,
      blockNumber,
      pot,
      zaps: potZaps,
      registry,
      adapter,
      runtimeCodeHash: observedHash,
      manifestRuntimeCodeHash: null,
    };
  }
  return {
    verified: true,
    status: "verified",
    detail: "pot adapter matches the release manifest",
    blockNumber,
    pot,
    zaps: potZaps,
    registry,
    adapter,
    runtimeCodeHash: observedHash,
    manifestRuntimeCodeHash: entry.runtimeCodeHash,
  };
}
