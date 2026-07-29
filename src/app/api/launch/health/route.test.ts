import { describe, expect, it, vi } from "vitest";

const { launcherAddress, runtimeCodeHash } = vi.hoisted(() => ({
  launcherAddress: "0x1000000000000000000000000000000000000001",
  runtimeCodeHash: `0x${"11".repeat(32)}`,
}));

vi.mock("@/lib/zappad/server-config", () => ({
  getRuntimeConfig: () => ({ launcherAddress }),
  launchWritesRequested: () => true,
  verifyRuntime: async () => ({
    rpcConfigured: true,
    chainMatches: true,
    chainId: 4_663,
    headBlock: 100,
    headTimestamp: "2026-07-29T00:00:00.000Z",
    headAgeSeconds: 1,
    headRecent: true,
    deployBlockConfigured: true,
    deployBlockVerified: true,
    launcherCodePresent: true,
    launcherRuntimeCodeHash: runtimeCodeHash,
    launcherCodeHashConfigured: true,
    launcherCodeHashMatches: true,
    dependencyCodeHashesVerified: true,
    proxyImplementationsVerified: true,
    requiredDependencyCodePresent: true,
    launcherDependenciesVerified: true,
    factoryBindingsVerified: true,
    launcherIdentityVerified: true,
    launcherReady: true,
  }),
}));

import { GET } from "./route";

describe("runtime health evidence", () => {
  it("exposes the observed launcher hash and dependency-integrity probes", async () => {
    const response = await GET();
    const body = (await response.json()) as {
      launcher: {
        runtimeCodeHash: string;
        dependenciesVerified: boolean;
        dependencyCodeHashesVerified: boolean;
        proxyImplementationsVerified: boolean;
        requiredDependencyCodePresent: boolean;
        identityProbes: string[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.launcher).toMatchObject({
      runtimeCodeHash,
      dependenciesVerified: true,
      dependencyCodeHashesVerified: true,
      proxyImplementationsVerified: true,
      requiredDependencyCodePresent: true,
    });
    expect(body.launcher.identityProbes).toEqual(
      expect.arrayContaining([
        "dependency runtime code hashes",
        "EIP-1967 proxy implementations",
        "treasury and factory code presence",
      ]),
    );
  });
});
