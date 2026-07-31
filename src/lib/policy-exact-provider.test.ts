import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const viemMocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  http: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: viemMocks.createPublicClient,
    http: viemMocks.http,
  };
});

import {
  createExactPolicyChainReader,
  EXACT_POLICY_PUBLIC_RPC_FALLBACK,
  resolveExactPolicyProvider,
} from "@/lib/policy-exact-provider";

describe("exact-policy RPC provider resolution", () => {
  it("requires a dedicated server-only HTTPS RPC in production", () => {
    expect(resolveExactPolicyProvider({ NODE_ENV: "production" })).toEqual({
      ready: false,
      reason: "missing-server-rpc",
    });
    expect(resolveExactPolicyProvider({
      NODE_ENV: "production",
      OPENZAPS_EXACT_POLICY_RPC_URL: "https://account:secret@rpc.example/v1/project",
    })).toEqual({
      ready: true,
      rpcUrl: "https://account:secret@rpc.example/v1/project",
      source: "server-configuration",
    });
  });

  it.each([
    "not a URL",
    "http://rpc.example/v1/project",
    "ftp://rpc.example/v1/project",
  ])("fails closed for a malformed or non-HTTPS server URL: %s", (rpcUrl) => {
    expect(resolveExactPolicyProvider({
      NODE_ENV: "test",
      OPENZAPS_EXACT_POLICY_RPC_URL: rpcUrl,
    })).toEqual({
      ready: false,
      reason: "invalid-server-rpc",
    });
  });

  it("uses only the fixed public fallback locally and ignores NEXT_PUBLIC credentials", () => {
    expect(resolveExactPolicyProvider({
      NODE_ENV: "test",
      NEXT_PUBLIC_ROBINHOOD_RPC_URL: "https://browser-key:browser-secret@rpc.example/private",
    })).toEqual({
      ready: true,
      rpcUrl: EXACT_POLICY_PUBLIC_RPC_FALLBACK,
      source: "local-public-fallback",
    });
  });

  it("constructs the client from the resolved URL with bounded HTTP retries and timeout", () => {
    const provider = resolveExactPolicyProvider({
      NODE_ENV: "production",
      OPENZAPS_EXACT_POLICY_RPC_URL: "https://account:secret@rpc.example/v1/project",
    });
    expect(provider.ready).toBe(true);
    if (!provider.ready) throw new Error("Expected a ready exact-policy provider.");

    const transport = { type: "test-http-transport" };
    const client = { type: "test-public-client" };
    viemMocks.http.mockReturnValueOnce(transport);
    viemMocks.createPublicClient.mockReturnValueOnce(client);

    expect(createExactPolicyChainReader(provider)).toBe(client);
    expect(viemMocks.http).toHaveBeenCalledWith(provider.rpcUrl, {
      retryCount: 2,
      timeout: 15_000,
    });
    expect(viemMocks.createPublicClient).toHaveBeenCalledWith({
      chain: expect.objectContaining({
        id: 4_663,
        rpcUrls: {
          default: { http: [EXACT_POLICY_PUBLIC_RPC_FALLBACK] },
        },
      }),
      transport,
    });
  });
});
