import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAddress,
  keccak256,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import {
  getRuntimeConfig,
  getRpcUrl,
  getVerifiedRuntimeConfig,
  rpcRelayEnabled,
  verifyRuntime,
  type RuntimeDependencyExpectations,
} from "./server-config";

const LAUNCHER =
  "0x1000000000000000000000000000000000000001" as Address;
const TREASURY =
  "0x2000000000000000000000000000000000000002" as Address;
const TOKEN_FACTORY =
  "0x3000000000000000000000000000000000000003" as Address;
const FEE_VAULT_FACTORY =
  "0x4000000000000000000000000000000000000004" as Address;
const POSITION_MANAGER =
  "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address;
const V3_FACTORY =
  "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address;
const SWAP_ROUTER =
  "0xCaf681a66D020601342297493863E78C959E5cb2" as Address;
const WETH =
  "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const USDG =
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const WETH_IMPLEMENTATION =
  "0xC6B81b429797E0f555440b70cD99e032D7AE947e" as Address;
const USDG_IMPLEMENTATION =
  "0x68184C449E1a8f34fA18d289737129FD27B66f8F" as Address;
const LAUNCHER_CODE = "0x60006000556001600055" as Hex;
const LAUNCHER_CODE_HASH = keccak256(LAUNCHER_CODE);
const POSITION_MANAGER_CODE = "0x6001600055" as Hex;
const V3_FACTORY_CODE = "0x6002600055" as Hex;
const SWAP_ROUTER_CODE = "0x6003600055" as Hex;
const WETH_CODE = "0x6004600055" as Hex;
const USDG_CODE = "0x6005600055" as Hex;
const WETH_IMPLEMENTATION_CODE = "0x6006600055" as Hex;
const USDG_IMPLEMENTATION_CODE = "0x6007600055" as Hex;
const TEST_RUNTIME_DEPENDENCIES: RuntimeDependencyExpectations = {
  positionManager: {
    address: POSITION_MANAGER,
    codeHash: keccak256(POSITION_MANAGER_CODE),
  },
  v3Factory: {
    address: V3_FACTORY,
    codeHash: keccak256(V3_FACTORY_CODE),
  },
  swapRouter: {
    address: SWAP_ROUTER,
    codeHash: keccak256(SWAP_ROUTER_CODE),
  },
  weth: {
    address: WETH,
    codeHash: keccak256(WETH_CODE),
    implementation: {
      address: WETH_IMPLEMENTATION,
      codeHash: keccak256(WETH_IMPLEMENTATION_CODE),
    },
  },
  usdg: {
    address: USDG,
    codeHash: keccak256(USDG_CODE),
    implementation: {
      address: USDG_IMPLEMENTATION,
      codeHash: keccak256(USDG_IMPLEMENTATION_CODE),
    },
  },
};
const CONFIG_DOMAIN = keccak256(
  new TextEncoder().encode("ZapPadLaunchConfig:v1"),
);
const HEAD_BLOCK = 100;
const DEPLOY_BLOCK = 90;
const HEAD_HASH = `0x${"11".repeat(32)}`;

const selectors = {
  chainId: toFunctionSelector("ROBINHOOD_CHAIN_ID()"),
  configDomain: toFunctionSelector("LAUNCH_CONFIG_DOMAIN()"),
  protocolTreasury: toFunctionSelector("protocolTreasury()"),
  tokenFactory: toFunctionSelector("tokenFactory()"),
  feeVaultFactory: toFunctionSelector("feeVaultFactory()"),
  positionManager: toFunctionSelector("positionManager()"),
  v3Factory: toFunctionSelector("v3Factory()"),
  swapRouter: toFunctionSelector("swapRouter()"),
  weth: toFunctionSelector("weth()"),
  usdg: toFunctionSelector("usdg()"),
  factoryLaunchpad: toFunctionSelector("launchpad()"),
};

function encodeUint(value: bigint | number) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function encodeAddress(value: Address) {
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

interface RpcOverrides {
  configDomain?: Hex;
  positionManager?: Address;
  tokenFactoryBinding?: Address;
  feeVaultFactoryBinding?: Address;
  preDeployCode?: Hex;
  positionManagerCode?: Hex;
  v3FactoryCode?: Hex;
  swapRouterCode?: Hex;
  wethCode?: Hex;
  usdgCode?: Hex;
  wethImplementation?: Address;
  usdgImplementation?: Address;
  wethImplementationCode?: Hex;
  usdgImplementationCode?: Hex;
  treasuryCode?: Hex;
  tokenFactoryCode?: Hex;
  feeVaultFactoryCode?: Hex;
}

function installEnvironment({
  codeHash = LAUNCHER_CODE_HASH,
  deployBlock = String(DEPLOY_BLOCK),
  writes = "",
}: {
  codeHash?: string;
  deployBlock?: string;
  writes?: string;
} = {}) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ROBINHOOD_RPC_URL", "https://rpc.example");
  vi.stubEnv("ZAPPAD_LAUNCHER_ADDRESS", LAUNCHER);
  vi.stubEnv("ZAPPAD_LAUNCHER_DEPLOY_BLOCK", deployBlock);
  vi.stubEnv("ZAPPAD_LAUNCHER_CODE_HASH", codeHash);
  vi.stubEnv("ZAPPAD_LAUNCH_WRITES_ENABLED", writes);
  vi.stubEnv("ZAPPAD_RPC_RELAY_ENABLED", "true");
  vi.stubEnv("ZAPPAD_RPC_DURABLE_QUOTA_ENABLED", "true");
}

function installRpc(overrides: RpcOverrides = {}) {
  const launcherReads = new Map<string, string>([
    [selectors.chainId, encodeUint(4_663)],
    [selectors.configDomain, overrides.configDomain ?? CONFIG_DOMAIN],
    [selectors.protocolTreasury, encodeAddress(TREASURY)],
    [selectors.tokenFactory, encodeAddress(TOKEN_FACTORY)],
    [selectors.feeVaultFactory, encodeAddress(FEE_VAULT_FACTORY)],
    [
      selectors.positionManager,
      encodeAddress(overrides.positionManager ?? POSITION_MANAGER),
    ],
    [selectors.v3Factory, encodeAddress(V3_FACTORY)],
    [selectors.swapRouter, encodeAddress(SWAP_ROUTER)],
    [selectors.weth, encodeAddress(WETH)],
    [selectors.usdg, encodeAddress(USDG)],
  ]);
  const codeByAddress = new Map<string, Hex>([
    [
      POSITION_MANAGER.toLowerCase(),
      overrides.positionManagerCode ?? POSITION_MANAGER_CODE,
    ],
    [V3_FACTORY.toLowerCase(), overrides.v3FactoryCode ?? V3_FACTORY_CODE],
    [SWAP_ROUTER.toLowerCase(), overrides.swapRouterCode ?? SWAP_ROUTER_CODE],
    [WETH.toLowerCase(), overrides.wethCode ?? WETH_CODE],
    [USDG.toLowerCase(), overrides.usdgCode ?? USDG_CODE],
    [
      WETH_IMPLEMENTATION.toLowerCase(),
      overrides.wethImplementationCode ?? WETH_IMPLEMENTATION_CODE,
    ],
    [
      USDG_IMPLEMENTATION.toLowerCase(),
      overrides.usdgImplementationCode ?? USDG_IMPLEMENTATION_CODE,
    ],
    [TREASURY.toLowerCase(), overrides.treasuryCode ?? "0x6001"],
    [TOKEN_FACTORY.toLowerCase(), overrides.tokenFactoryCode ?? "0x6002"],
    [
      FEE_VAULT_FACTORY.toLowerCase(),
      overrides.feeVaultFactoryCode ?? "0x6003",
    ],
  ]);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      let result: unknown;

      if (request.method === "eth_chainId") {
        result = "0x1237";
      } else if (request.method === "eth_blockNumber") {
        result = `0x${HEAD_BLOCK.toString(16)}`;
      } else if (request.method === "eth_getBlockByNumber") {
        result = {
          hash: HEAD_HASH,
          number: request.params[0],
          timestamp: `0x${Math.floor(Date.now() / 1_000).toString(16)}`,
        };
      } else if (request.method === "eth_getCode") {
        const [rawAddress, tag] = request.params as [string, string];
        const address = getAddress(rawAddress);
        if (address === LAUNCHER) {
          result =
            tag === `0x${(DEPLOY_BLOCK - 1).toString(16)}`
              ? (overrides.preDeployCode ?? "0x")
              : LAUNCHER_CODE;
        } else {
          result =
            tag === `0x${HEAD_BLOCK.toString(16)}`
              ? (codeByAddress.get(address.toLowerCase()) ?? "0x")
              : "0x";
        }
      } else if (request.method === "eth_getStorageAt") {
        const [rawAddress, , tag] = request.params as [string, string, string];
        const address = getAddress(rawAddress);
        if (tag === `0x${HEAD_BLOCK.toString(16)}` && address === WETH) {
          result = encodeAddress(
            overrides.wethImplementation ?? WETH_IMPLEMENTATION,
          );
        } else if (
          tag === `0x${HEAD_BLOCK.toString(16)}` &&
          address === USDG
        ) {
          result = encodeAddress(
            overrides.usdgImplementation ?? USDG_IMPLEMENTATION,
          );
        }
      } else if (request.method === "eth_call") {
        const [call] = request.params as [{ to: string; data: string }, string];
        const to = getAddress(call.to);
        if (to === LAUNCHER) {
          result = launcherReads.get(call.data);
        } else if (call.data === selectors.factoryLaunchpad) {
          if (to === TOKEN_FACTORY) {
            result = encodeAddress(
              overrides.tokenFactoryBinding ?? LAUNCHER,
            );
          } else if (to === FEE_VAULT_FACTORY) {
            result = encodeAddress(
              overrides.feeVaultFactoryBinding ?? LAUNCHER,
            );
          }
        }
      }

      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }),
  );
}

function verifyTestRuntime() {
  return verifyRuntime(getRuntimeConfig(), TEST_RUNTIME_DEPENDENCIES);
}

function getVerifiedTestRuntimeConfig() {
  return getVerifiedRuntimeConfig(TEST_RUNTIME_DEPENDENCIES);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("production runtime identity and activation", () => {
  it("defaults the production RPC relay off until both operational gates are explicit", () => {
    expect(rpcRelayEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      rpcRelayEnabled({
        NODE_ENV: "production",
        ZAPPAD_RPC_RELAY_ENABLED: "true",
      }),
    ).toBe(false);
    expect(
      rpcRelayEnabled({
        NODE_ENV: "production",
        ZAPPAD_RPC_RELAY_ENABLED: "true",
        ZAPPAD_RPC_DURABLE_QUOTA_ENABLED: "true",
      }),
    ).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ZAPPAD_RPC_RELAY_ENABLED", "");
    vi.stubEnv("ZAPPAD_RPC_DURABLE_QUOTA_ENABLED", "");
    vi.stubEnv("ZAPPAD_RPC_URL", "https://rpc.example");
    expect(() => getRpcUrl()).toThrow(/durable quota gates/);
  });

  it("ignores generic and browser-exposed launcher aliases", () => {
    vi.stubEnv("ZAPPAD_LAUNCHER_ADDRESS", "");
    vi.stubEnv("ZAPPAD_LAUNCHER_DEPLOY_BLOCK", "");
    vi.stubEnv("ZAPPAD_LAUNCHER_CODE_HASH", "");
    vi.stubEnv("ROBINHOOD_LAUNCHPAD_ADDRESS", LAUNCHER);
    vi.stubEnv("LAUNCHER_ADDRESS", LAUNCHER);
    vi.stubEnv("NEXT_PUBLIC_LAUNCHER_ADDRESS", LAUNCHER);
    vi.stubEnv("ROBINHOOD_LAUNCHPAD_DEPLOY_BLOCK", String(DEPLOY_BLOCK));
    vi.stubEnv("LAUNCHER_DEPLOY_BLOCK", String(DEPLOY_BLOCK));
    vi.stubEnv("NEXT_PUBLIC_LAUNCHER_DEPLOY_BLOCK", String(DEPLOY_BLOCK));

    const config = getRuntimeConfig();
    expect(config.launcherAddress).toBeNull();
    expect(config.deployBlock).toBe(0);
    expect(config.readEnabled).toBe(false);
    expect(config.launchEnabled).toBe(false);
  });

  it("keeps writes disabled by default while verified reads remain ready", async () => {
    installEnvironment();
    installRpc();

    const verification = await verifyTestRuntime();
    expect(verification).toMatchObject({
      deployBlockVerified: true,
      launcherRuntimeCodeHash: LAUNCHER_CODE_HASH,
      launcherCodeHashMatches: true,
      dependencyCodeHashesVerified: true,
      proxyImplementationsVerified: true,
      requiredDependencyCodePresent: true,
      launcherDependenciesVerified: true,
      factoryBindingsVerified: true,
      launcherIdentityVerified: true,
      launcherReady: true,
    });

    const config = await getVerifiedTestRuntimeConfig();
    expect(config.readEnabled).toBe(true);
    expect(config.launchEnabled).toBe(false);
    expect(config.launcherAddress).toBe(LAUNCHER);
  });

  it("enables writes only for the exact server-side true value", async () => {
    installEnvironment({ writes: "true" });
    installRpc();

    const enabled = await getVerifiedTestRuntimeConfig();
    expect(enabled.readEnabled).toBe(true);
    expect(enabled.launchEnabled).toBe(true);

    vi.stubEnv("ZAPPAD_LAUNCH_WRITES_ENABLED", "TRUE");
    const notEnabled = await getVerifiedTestRuntimeConfig();
    expect(notEnabled.readEnabled).toBe(true);
    expect(notEnabled.launchEnabled).toBe(false);
  });

  it("rejects a missing or mismatched reviewed launcher code hash", async () => {
    installEnvironment({ codeHash: "" });
    installRpc();
    let verification = await verifyTestRuntime();
    expect(verification.launcherRuntimeCodeHash).toBe(LAUNCHER_CODE_HASH);
    expect(verification.launcherCodeHashConfigured).toBe(false);
    expect(verification.launcherReady).toBe(false);
    let config = await getVerifiedTestRuntimeConfig();
    expect(config.launcherAddress).toBeNull();
    expect(config.deployBlock).toBe(0);
    expect(config.readEnabled).toBe(false);
    expect(config.launchEnabled).toBe(false);

    installEnvironment({ codeHash: `0x${"22".repeat(32)}` });
    verification = await verifyTestRuntime();
    expect(verification.launcherRuntimeCodeHash).toBe(LAUNCHER_CODE_HASH);
    expect(verification.launcherCodeHashMatches).toBe(false);
    expect(verification.launcherReady).toBe(false);
    config = await getVerifiedTestRuntimeConfig();
    expect(config.launcherAddress).toBeNull();
    expect(config.deployBlock).toBe(0);
  });

  it("rejects a launcher that existed before the reviewed deployment block", async () => {
    installEnvironment();
    installRpc({ preDeployCode: "0x6002" });

    const verification = await verifyTestRuntime();
    expect(verification.deployBlockConfigured).toBe(true);
    expect(verification.deployBlockVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);
  });

  it("rejects invalid deployment-block configuration without partial parsing", async () => {
    installEnvironment({ deployBlock: `${DEPLOY_BLOCK}trailing` });
    installRpc();

    expect(getRuntimeConfig().deployBlock).toBe(0);
    const verification = await verifyTestRuntime();
    expect(verification.deployBlockConfigured).toBe(false);
    expect(verification.launcherReady).toBe(false);
  });

  it("rejects the wrong launch domain or canonical dependency", async () => {
    installEnvironment();
    installRpc({ configDomain: `0x${"33".repeat(32)}` });
    let verification = await verifyTestRuntime();
    expect(verification.launcherIdentityVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);

    installRpc({
      positionManager:
        "0x9000000000000000000000000000000000000009" as Address,
    });
    verification = await verifyTestRuntime();
    expect(verification.launcherDependenciesVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);
  });

  it("rejects canonical dependency and proxy runtime-code drift", async () => {
    installEnvironment();
    installRpc({ positionManagerCode: "0x6008600055" });

    let verification = await verifyTestRuntime();
    expect(verification.dependencyCodeHashesVerified).toBe(false);
    expect(verification.launcherDependenciesVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);

    installRpc({ wethCode: "0x6009600055" });
    verification = await verifyTestRuntime();
    expect(verification.dependencyCodeHashesVerified).toBe(false);
    expect(verification.proxyImplementationsVerified).toBe(true);
    expect(verification.launcherDependenciesVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);
  });

  it("rejects proxy implementation-address and implementation-code drift", async () => {
    installEnvironment();
    installRpc({
      wethImplementation:
        "0x9000000000000000000000000000000000000009" as Address,
    });

    let verification = await verifyTestRuntime();
    expect(verification.dependencyCodeHashesVerified).toBe(true);
    expect(verification.proxyImplementationsVerified).toBe(false);
    expect(verification.launcherDependenciesVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);

    installRpc({ usdgImplementationCode: "0x6010600055" });
    verification = await verifyTestRuntime();
    expect(verification.proxyImplementationsVerified).toBe(false);
    expect(verification.launcherDependenciesVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);

    const config = await getVerifiedTestRuntimeConfig();
    expect(config.launcherAddress).toBeNull();
    expect(config.readEnabled).toBe(false);
    expect(config.launchEnabled).toBe(false);
  });

  it("rejects missing Safe treasury or factory runtime code", async () => {
    installEnvironment();
    installRpc({ treasuryCode: "0x" });

    let verification = await verifyTestRuntime();
    expect(verification.requiredDependencyCodePresent).toBe(false);
    expect(verification.launcherDependenciesVerified).toBe(false);
    expect(verification.factoryBindingsVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);

    installRpc({ tokenFactoryCode: "0x" });
    verification = await verifyTestRuntime();
    expect(verification.requiredDependencyCodePresent).toBe(false);
    expect(verification.launcherDependenciesVerified).toBe(false);
    expect(verification.factoryBindingsVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);
  });

  it("reads every dependency-integrity value at the same pinned head block", async () => {
    installEnvironment();
    installRpc();

    const verification = await verifyTestRuntime();
    expect(verification.launcherReady).toBe(true);

    const pinnedAddresses = new Set(
      [
        POSITION_MANAGER,
        V3_FACTORY,
        SWAP_ROUTER,
        WETH,
        USDG,
        WETH_IMPLEMENTATION,
        USDG_IMPLEMENTATION,
        TREASURY,
        TOKEN_FACTORY,
        FEE_VAULT_FACTORY,
      ].map((address) => address.toLowerCase()),
    );
    const requests = vi.mocked(fetch).mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as {
        method: string;
        params: string[] | [{ to: string; data: string }, string];
      },
    );
    const dependencyCodeReads = requests.filter(
      (request) =>
        request.method === "eth_getCode" &&
        pinnedAddresses.has(String(request.params[0]).toLowerCase()),
    );
    const implementationSlotReads = requests.filter(
      (request) => request.method === "eth_getStorageAt",
    );
    const factoryBindingReads = requests.filter(
      (request) =>
        request.method === "eth_call" &&
        typeof request.params[0] === "object" &&
        [TOKEN_FACTORY, FEE_VAULT_FACTORY]
          .map((address) => address.toLowerCase())
          .includes(request.params[0].to.toLowerCase()),
    );
    const exactHeadTag = `0x${HEAD_BLOCK.toString(16)}`;

    expect(dependencyCodeReads).toHaveLength(10);
    expect(implementationSlotReads).toHaveLength(2);
    expect(factoryBindingReads).toHaveLength(2);
    expect(dependencyCodeReads.every((request) => request.params[1] === exactHeadTag)).toBe(
      true,
    );
    expect(
      implementationSlotReads.every(
        (request) => request.params[2] === exactHeadTag,
      ),
    ).toBe(true);
    expect(
      factoryBindingReads.every((request) => request.params[1] === exactHeadTag),
    ).toBe(true);
  });

  it("rejects either factory when its immutable binding points elsewhere", async () => {
    installEnvironment();
    installRpc({
      tokenFactoryBinding:
        "0x9000000000000000000000000000000000000009" as Address,
    });

    const verification = await verifyTestRuntime();
    expect(verification.factoryBindingsVerified).toBe(false);
    expect(verification.launcherReady).toBe(false);
  });
});
