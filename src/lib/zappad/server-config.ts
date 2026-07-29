import {
  getAddress,
  isAddress,
  isHash,
  keccak256,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import {
  EXPLORER_URL,
  OFFICIAL_RPC_URL,
  ROBINHOOD_CHAIN_ID,
  USDG_ADDRESS,
  WETH_ADDRESS,
} from "./chain";
import type { RuntimeConfig } from "./config";

const POSITION_MANAGER_ADDRESS =
  "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address;
const V3_FACTORY_ADDRESS =
  "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address;
const SWAP_ROUTER_ADDRESS =
  "0xCaf681a66D020601342297493863E78C959E5cb2" as Address;
const WETH_IMPLEMENTATION_ADDRESS =
  "0xC6B81b429797E0f555440b70cD99e032D7AE947e" as Address;
const USDG_IMPLEMENTATION_ADDRESS =
  "0x68184C449E1a8f34fA18d289737129FD27B66f8F" as Address;
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LAUNCH_CONFIG_DOMAIN = keccak256(
  new TextEncoder().encode("ZapPadLaunchConfig:v1"),
);

interface RuntimeCodeExpectation {
  address: Address;
  codeHash: Hex;
}

interface RuntimeProxyExpectation extends RuntimeCodeExpectation {
  implementation: RuntimeCodeExpectation;
}

export interface RuntimeDependencyExpectations {
  positionManager: RuntimeCodeExpectation;
  v3Factory: RuntimeCodeExpectation;
  swapRouter: RuntimeCodeExpectation;
  weth: RuntimeProxyExpectation;
  usdg: RuntimeProxyExpectation;
}

export const ROBINHOOD_RUNTIME_DEPENDENCIES: RuntimeDependencyExpectations = {
  positionManager: {
    address: POSITION_MANAGER_ADDRESS,
    codeHash:
      "0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f",
  },
  v3Factory: {
    address: V3_FACTORY_ADDRESS,
    codeHash:
      "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739",
  },
  swapRouter: {
    address: SWAP_ROUTER_ADDRESS,
    codeHash:
      "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc",
  },
  weth: {
    address: WETH_ADDRESS,
    codeHash:
      "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353",
    implementation: {
      address: WETH_IMPLEMENTATION_ADDRESS,
      codeHash:
        "0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650",
    },
  },
  usdg: {
    address: USDG_ADDRESS,
    codeHash:
      "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
    implementation: {
      address: USDG_IMPLEMENTATION_ADDRESS,
      codeHash:
        "0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf",
    },
  },
};

function launcherAddress(): Address | null {
  const value = process.env.ZAPPAD_LAUNCHER_ADDRESS;
  return value && isAddress(value) ? value : null;
}

function deployBlock() {
  const raw = process.env.ZAPPAD_LAUNCHER_DEPLOY_BLOCK ?? "0";
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function launcherCodeHash(): Hex | null {
  const value = process.env.ZAPPAD_LAUNCHER_CODE_HASH;
  return value && isHash(value) ? (value.toLowerCase() as Hex) : null;
}

export function launchWritesRequested() {
  return process.env.ZAPPAD_LAUNCH_WRITES_ENABLED === "true";
}

/**
 * Production RPC reads stay dark until an operator confirms both the feature
 * and a durable quota outside this process. The route's request bounds protect
 * the upstream node from broad methods, but they are not a distributed quota.
 */
export function rpcRelayEnabled(
  env: {
    NODE_ENV?: string;
    ZAPPAD_RPC_RELAY_ENABLED?: string;
    ZAPPAD_RPC_DURABLE_QUOTA_ENABLED?: string;
  } = process.env,
) {
  if (env.NODE_ENV !== "production") {
    return env.ZAPPAD_RPC_RELAY_ENABLED !== "false";
  }
  return (
    env.ZAPPAD_RPC_RELAY_ENABLED === "true"
    && env.ZAPPAD_RPC_DURABLE_QUOTA_ENABLED === "true"
  );
}

export function getRpcUrl() {
  if (!rpcRelayEnabled()) {
    throw new Error(
      "ZapPad RPC reads require the production relay and durable quota gates.",
    );
  }
  const explicit =
    process.env.ZAPPAD_RPC_URL ?? process.env.ROBINHOOD_RPC_URL;
  if (explicit) {
    const parsed = new URL(explicit);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      throw new Error("RPC URL must use HTTP or HTTPS.");
    }
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error("Production RPC URL must use HTTPS.");
    }
    return parsed.toString();
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Set ZAPPAD_RPC_URL or ROBINHOOD_RPC_URL in the production environment.",
    );
  }
  return OFFICIAL_RPC_URL;
}

export function getRuntimeConfig(): RuntimeConfig {
  const launcher = launcherAddress();
  return {
    launcherAddress: launcher,
    deployBlock: deployBlock(),
    readEnabled: false,
    chain: {
      id: ROBINHOOD_CHAIN_ID,
      name: "Robinhood Chain",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      explorerUrl: EXPLORER_URL,
      rpcPath: "/api/launch/rpc",
    },
    pairedAssets: [
      {
        address: WETH_ADDRESS,
        symbol: "WETH",
        decimals: 18,
        kind: "native",
      },
      {
        address: USDG_ADDRESS,
        symbol: "USDG",
        decimals: 6,
        kind: "erc20",
      },
    ],
    launchEnabled: false,
  };
}

async function rpcResult(
  method: string,
  params: unknown[],
  signal: AbortSignal,
) {
  const response = await fetch(getRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal,
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { result?: unknown };
  return payload.result ?? null;
}

export interface RuntimeVerification {
  rpcConfigured: boolean;
  chainMatches: boolean;
  chainId: number | null;
  headBlock: number | null;
  headTimestamp: string | null;
  headAgeSeconds: number | null;
  headRecent: boolean;
  deployBlockConfigured: boolean;
  deployBlockVerified: boolean;
  launcherCodePresent: boolean;
  launcherRuntimeCodeHash: Hex | null;
  launcherCodeHashConfigured: boolean;
  launcherCodeHashMatches: boolean;
  dependencyCodeHashesVerified: boolean;
  proxyImplementationsVerified: boolean;
  requiredDependencyCodePresent: boolean;
  launcherDependenciesVerified: boolean;
  factoryBindingsVerified: boolean;
  launcherIdentityVerified: boolean;
  launcherReady: boolean;
}

const MAX_HEAD_AGE_SECONDS = 300;
const LAUNCHER_CHAIN_ID_SELECTOR = toFunctionSelector("ROBINHOOD_CHAIN_ID()");
const LAUNCH_CONFIG_DOMAIN_SELECTOR = toFunctionSelector(
  "LAUNCH_CONFIG_DOMAIN()",
);
const FACTORY_LAUNCHPAD_SELECTOR = toFunctionSelector("launchpad()");
const ADDRESS_SELECTORS = {
  protocolTreasury: toFunctionSelector("protocolTreasury()"),
  tokenFactory: toFunctionSelector("tokenFactory()"),
  feeVaultFactory: toFunctionSelector("feeVaultFactory()"),
  positionManager: toFunctionSelector("positionManager()"),
  v3Factory: toFunctionSelector("v3Factory()"),
  swapRouter: toFunctionSelector("swapRouter()"),
  weth: toFunctionSelector("weth()"),
  usdg: toFunctionSelector("usdg()"),
} as const;

function quantity(value: unknown) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function uintResult(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) {
    return null;
  }
  return BigInt(value);
}

function bytes32Result(value: unknown): Hex | null {
  return typeof value === "string" && isHash(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

function addressResult(value: unknown): Address | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) {
    return null;
  }
  try {
    return getAddress(`0x${value.slice(-40)}`);
  } catch {
    return null;
  }
}

function sameAddress(left: Address | null, right: Address | string) {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

function hasCode(value: unknown): value is Hex {
  return (
    typeof value === "string" &&
    /^0x(?:[0-9a-f]{2})+$/i.test(value) &&
    value !== "0x00"
  );
}

function codeHashMatches(value: unknown, expected: Hex) {
  return hasCode(value) && keccak256(value) === expected;
}

function blockTag(block: number) {
  return `0x${block.toString(16)}`;
}

export async function verifyRuntime(
  config = getRuntimeConfig(),
  dependencies = ROBINHOOD_RUNTIME_DEPENDENCIES,
): Promise<RuntimeVerification> {
  const unavailable: RuntimeVerification = {
    rpcConfigured: false,
    chainMatches: false,
    chainId: null,
    headBlock: null,
    headTimestamp: null,
    headAgeSeconds: null,
    headRecent: false,
    deployBlockConfigured: false,
    deployBlockVerified: false,
    launcherCodePresent: false,
    launcherRuntimeCodeHash: null,
    launcherCodeHashConfigured: false,
    launcherCodeHashMatches: false,
    dependencyCodeHashesVerified: false,
    proxyImplementationsVerified: false,
    requiredDependencyCodePresent: false,
    launcherDependenciesVerified: false,
    factoryBindingsVerified: false,
    launcherIdentityVerified: false,
    launcherReady: false,
  };

  let rpcUrl: string;
  try {
    rpcUrl = getRpcUrl();
  } catch {
    return unavailable;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const [chainIdRaw, headRaw] = await Promise.all([
      rpcResult("eth_chainId", [], controller.signal),
      rpcResult("eth_blockNumber", [], controller.signal),
    ]);
    const chainId = quantity(chainIdRaw);
    const headBlock = quantity(headRaw);
    const exactHeadTag = headBlock === null ? null : blockTag(headBlock);
    const block = exactHeadTag
      ? await rpcResult(
          "eth_getBlockByNumber",
          [exactHeadTag, false],
          controller.signal,
        )
      : null;
    const timestampRaw =
      block && typeof block === "object"
        ? (block as { timestamp?: unknown }).timestamp
        : null;
    const timestampSeconds =
      typeof timestampRaw === "string"
        ? Number.parseInt(timestampRaw, 16)
        : null;
    const headAgeSeconds =
      timestampSeconds === null
        ? null
        : Math.max(0, Math.floor(Date.now() / 1_000) - timestampSeconds);
    const headRecent =
      headAgeSeconds !== null && headAgeSeconds <= MAX_HEAD_AGE_SECONDS;
    const chainMatches = chainId === ROBINHOOD_CHAIN_ID;
    const expectedCodeHash = launcherCodeHash();
    const deployBlockConfigured =
      config.deployBlock > 0 &&
      headBlock !== null &&
      config.deployBlock <= headBlock;

    if (
      !config.launcherAddress ||
      !exactHeadTag ||
      !block ||
      typeof block !== "object"
    ) {
      return {
        ...unavailable,
        rpcConfigured: true,
        chainMatches,
        chainId,
        headBlock,
        headTimestamp:
          timestampSeconds === null
            ? null
            : new Date(timestampSeconds * 1_000).toISOString(),
        headAgeSeconds,
        headRecent,
        deployBlockConfigured,
        launcherCodeHashConfigured: expectedCodeHash !== null,
      };
    }

    const addressEntries = Object.entries(ADDRESS_SELECTORS) as Array<
      [keyof typeof ADDRESS_SELECTORS, Hex]
    >;
    const deployTag = deployBlockConfigured
      ? blockTag(config.deployBlock)
      : null;
    const beforeDeployTag =
      deployBlockConfigured && config.deployBlock > 0
        ? blockTag(config.deployBlock - 1)
        : null;
    const [
      launcherCode,
      deployCode,
      beforeDeployCode,
      launcherChainId,
      launchConfigDomain,
      ...addressValues
    ] = await Promise.all([
      rpcResult(
        "eth_getCode",
        [config.launcherAddress, exactHeadTag],
        controller.signal,
      ),
      deployTag
        ? rpcResult(
            "eth_getCode",
            [config.launcherAddress, deployTag],
            controller.signal,
          )
        : Promise.resolve(null),
      beforeDeployTag
        ? rpcResult(
            "eth_getCode",
            [config.launcherAddress, beforeDeployTag],
            controller.signal,
          )
        : Promise.resolve(null),
      rpcResult(
        "eth_call",
        [
          { to: config.launcherAddress, data: LAUNCHER_CHAIN_ID_SELECTOR },
          exactHeadTag,
        ],
        controller.signal,
      ),
      rpcResult(
        "eth_call",
        [
          { to: config.launcherAddress, data: LAUNCH_CONFIG_DOMAIN_SELECTOR },
          exactHeadTag,
        ],
        controller.signal,
      ),
      ...addressEntries.map(([, selector]) =>
        rpcResult(
          "eth_call",
          [{ to: config.launcherAddress, data: selector }, exactHeadTag],
          controller.signal,
        ),
      ),
    ]);

    const launcherCodePresent = hasCode(launcherCode);
    const launcherRuntimeCodeHash = launcherCodePresent
      ? keccak256(launcherCode)
      : null;
    const launcherCodeHashMatches =
      launcherRuntimeCodeHash !== null &&
      expectedCodeHash !== null &&
      launcherRuntimeCodeHash === expectedCodeHash;
    const deployBlockVerified =
      deployBlockConfigured &&
      hasCode(deployCode) &&
      launcherCodePresent &&
      deployCode.toLowerCase() === launcherCode.toLowerCase() &&
      !hasCode(beforeDeployCode);
    const addresses = Object.fromEntries(
      addressEntries.map(([name], index) => [
        name,
        addressResult(addressValues[index]),
      ]),
    ) as Record<keyof typeof ADDRESS_SELECTORS, Address | null>;

    const canonicalDependencyAddressesVerified =
      sameAddress(
        addresses.positionManager,
        dependencies.positionManager.address,
      ) &&
      sameAddress(addresses.v3Factory, dependencies.v3Factory.address) &&
      sameAddress(addresses.swapRouter, dependencies.swapRouter.address) &&
      sameAddress(addresses.weth, dependencies.weth.address) &&
      sameAddress(addresses.usdg, dependencies.usdg.address) &&
      addresses.protocolTreasury !== null &&
      addresses.protocolTreasury.toLowerCase() !== ZERO_ADDRESS &&
      addresses.tokenFactory !== null &&
      addresses.feeVaultFactory !== null;

    let dependencyCodeHashesVerified = false;
    let proxyImplementationsVerified = false;
    let requiredDependencyCodePresent = false;
    let factoryBindingsVerified = false;
    if (
      addresses.protocolTreasury &&
      addresses.tokenFactory &&
      addresses.feeVaultFactory
    ) {
      const [
        positionManagerCode,
        v3FactoryCode,
        swapRouterCode,
        wethCode,
        usdgCode,
        wethImplementationSlot,
        usdgImplementationSlot,
        wethImplementationCode,
        usdgImplementationCode,
        protocolTreasuryCode,
        tokenFactoryCode,
        feeVaultFactoryCode,
        tokenFactoryLaunchpad,
        feeVaultFactoryLaunchpad,
      ] = await Promise.all([
        rpcResult(
          "eth_getCode",
          [dependencies.positionManager.address, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [dependencies.v3Factory.address, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [dependencies.swapRouter.address, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [dependencies.weth.address, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [dependencies.usdg.address, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getStorageAt",
          [
            dependencies.weth.address,
            EIP1967_IMPLEMENTATION_SLOT,
            exactHeadTag,
          ],
          controller.signal,
        ),
        rpcResult(
          "eth_getStorageAt",
          [
            dependencies.usdg.address,
            EIP1967_IMPLEMENTATION_SLOT,
            exactHeadTag,
          ],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [dependencies.weth.implementation.address, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [dependencies.usdg.implementation.address, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [addresses.protocolTreasury, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [addresses.tokenFactory, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_getCode",
          [addresses.feeVaultFactory, exactHeadTag],
          controller.signal,
        ),
        rpcResult(
          "eth_call",
          [
            {
              to: addresses.tokenFactory,
              data: FACTORY_LAUNCHPAD_SELECTOR,
            },
            exactHeadTag,
          ],
          controller.signal,
        ),
        rpcResult(
          "eth_call",
          [
            {
              to: addresses.feeVaultFactory,
              data: FACTORY_LAUNCHPAD_SELECTOR,
            },
            exactHeadTag,
          ],
          controller.signal,
        ),
      ]);
      dependencyCodeHashesVerified =
        codeHashMatches(
          positionManagerCode,
          dependencies.positionManager.codeHash,
        ) &&
        codeHashMatches(v3FactoryCode, dependencies.v3Factory.codeHash) &&
        codeHashMatches(swapRouterCode, dependencies.swapRouter.codeHash) &&
        codeHashMatches(wethCode, dependencies.weth.codeHash) &&
        codeHashMatches(usdgCode, dependencies.usdg.codeHash);
      proxyImplementationsVerified =
        sameAddress(
          addressResult(wethImplementationSlot),
          dependencies.weth.implementation.address,
        ) &&
        sameAddress(
          addressResult(usdgImplementationSlot),
          dependencies.usdg.implementation.address,
        ) &&
        codeHashMatches(
          wethImplementationCode,
          dependencies.weth.implementation.codeHash,
        ) &&
        codeHashMatches(
          usdgImplementationCode,
          dependencies.usdg.implementation.codeHash,
        );
      requiredDependencyCodePresent =
        hasCode(protocolTreasuryCode) &&
        hasCode(tokenFactoryCode) &&
        hasCode(feeVaultFactoryCode);
      factoryBindingsVerified =
        requiredDependencyCodePresent &&
        sameAddress(
          addressResult(tokenFactoryLaunchpad),
          config.launcherAddress,
        ) &&
        sameAddress(
          addressResult(feeVaultFactoryLaunchpad),
          config.launcherAddress,
        );
    }

    const launcherDependenciesVerified =
      canonicalDependencyAddressesVerified &&
      dependencyCodeHashesVerified &&
      proxyImplementationsVerified &&
      requiredDependencyCodePresent;

    const blockReadback = await rpcResult(
      "eth_getBlockByNumber",
      [exactHeadTag, false],
      controller.signal,
    );
    const blockHash =
      "hash" in block && typeof block.hash === "string" ? block.hash : null;
    const blockReadbackHash =
      blockReadback &&
      typeof blockReadback === "object" &&
      "hash" in blockReadback &&
      typeof blockReadback.hash === "string"
        ? blockReadback.hash
        : null;
    const exactBlockStable =
      blockHash !== null &&
      blockReadbackHash !== null &&
      blockHash.toLowerCase() === blockReadbackHash.toLowerCase();
    const launcherIdentityVerified =
      uintResult(launcherChainId) === BigInt(ROBINHOOD_CHAIN_ID) &&
      bytes32Result(launchConfigDomain) === LAUNCH_CONFIG_DOMAIN &&
      launcherCodeHashMatches &&
      deployBlockVerified &&
      launcherDependenciesVerified &&
      factoryBindingsVerified &&
      exactBlockStable;
    const launcherReady =
      chainMatches &&
      headRecent &&
      launcherCodePresent &&
      launcherIdentityVerified;

    return {
      rpcConfigured: Boolean(rpcUrl),
      chainMatches,
      chainId,
      headBlock:
        headBlock !== null && Number.isSafeInteger(headBlock) ? headBlock : null,
      headTimestamp:
        timestampSeconds === null
          ? null
          : new Date(timestampSeconds * 1_000).toISOString(),
      headAgeSeconds,
      headRecent,
      deployBlockConfigured,
      deployBlockVerified,
      launcherCodePresent,
      launcherRuntimeCodeHash,
      launcherCodeHashConfigured: expectedCodeHash !== null,
      launcherCodeHashMatches,
      dependencyCodeHashesVerified,
      proxyImplementationsVerified,
      requiredDependencyCodePresent,
      launcherDependenciesVerified,
      factoryBindingsVerified,
      launcherIdentityVerified,
      launcherReady,
    };
  } catch {
    return { ...unavailable, rpcConfigured: true };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getVerifiedRuntimeConfig(
  dependencies = ROBINHOOD_RUNTIME_DEPENDENCIES,
): Promise<RuntimeConfig> {
  const config = getRuntimeConfig();
  const verification = await verifyRuntime(config, dependencies);
  return {
    ...config,
    launcherAddress: verification.launcherReady
      ? config.launcherAddress
      : null,
    deployBlock: verification.launcherReady ? config.deployBlock : 0,
    readEnabled: verification.launcherReady,
    launchEnabled:
      verification.launcherReady && launchWritesRequested(),
  };
}
