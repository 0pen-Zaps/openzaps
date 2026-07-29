import { ROBINHOOD_CHAIN_ID } from "@/lib/zappad/chain";
import {
  getRuntimeConfig,
  launchWritesRequested,
  verifyRuntime,
} from "@/lib/zappad/server-config";

export const runtime = "nodejs";

export async function GET() {
  const startedAt = Date.now();
  const config = getRuntimeConfig();
  const verification = await verifyRuntime(config);
  const healthy = verification.launcherReady;
  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      rpcConfigured: verification.rpcConfigured,
      chain: {
        id: ROBINHOOD_CHAIN_ID,
        matches: verification.chainMatches,
        headBlock: verification.headBlock,
        headTimestamp: verification.headTimestamp,
        headAgeSeconds: verification.headAgeSeconds,
        recent: verification.headRecent,
      },
      launcher: {
        configured: Boolean(config.launcherAddress),
        deployBlockConfigured: verification.deployBlockConfigured,
        deployBlockVerified: verification.deployBlockVerified,
        bytecodePresent: verification.launcherCodePresent,
        runtimeCodeHash: verification.launcherRuntimeCodeHash,
        codeHashConfigured: verification.launcherCodeHashConfigured,
        codeHashMatches: verification.launcherCodeHashMatches,
        dependenciesVerified: verification.launcherDependenciesVerified,
        dependencyCodeHashesVerified:
          verification.dependencyCodeHashesVerified,
        proxyImplementationsVerified:
          verification.proxyImplementationsVerified,
        requiredDependencyCodePresent:
          verification.requiredDependencyCodePresent,
        factoryBindingsVerified: verification.factoryBindingsVerified,
        identityProbes: [
          "runtime code hash",
          "deployment block",
          "ROBINHOOD_CHAIN_ID()",
          "LAUNCH_CONFIG_DOMAIN()",
          "canonical dependencies",
          "dependency runtime code hashes",
          "EIP-1967 proxy implementations",
          "treasury and factory code presence",
          "factory bindings",
        ],
        identityVerified: verification.launcherIdentityVerified,
      },
      launchWrites: {
        requested: launchWritesRequested(),
        enabled: verification.launcherReady && launchWritesRequested(),
      },
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
