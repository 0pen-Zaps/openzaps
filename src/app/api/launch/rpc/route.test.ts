import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

function rpcRequest(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost:3000/api/launch/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function errorFor(body: unknown, headers?: Record<string, string>) {
  const response = await POST(rpcRequest(body, headers));
  return {
    response,
    payload: (await response.json()) as {
      error?: { code: number; message: string };
    },
  };
}

describe("bounded JSON-RPC relay", () => {
  it("rejects batch requests", async () => {
    const { response, payload } = await errorFor([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    ]);
    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe(-32_600);
  });

  it("blocks transaction-broadcast methods", async () => {
    const { response, payload } = await errorFor({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_sendRawTransaction",
      params: ["0x"],
    });
    expect(response.status).toBe(403);
    expect(payload.error?.code).toBe(-32_601);
  });

  it("bounds fee history work", async () => {
    const { response, payload } = await errorFor({
      jsonrpc: "2.0",
      id: 3,
      method: "eth_feeHistory",
      params: ["0x81", "latest", [10, 50, 90]],
    });
    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe(-32_602);
  });

  it("rejects full-transaction block expansion", async () => {
    const { response } = await errorFor({
      jsonrpc: "2.0",
      id: 4,
      method: "eth_getBlockByNumber",
      params: ["latest", true],
    });
    expect(response.status).toBe(400);
  });

  it("bounds simulated gas", async () => {
    const { response } = await errorFor({
      jsonrpc: "2.0",
      id: 5,
      method: "eth_call",
      params: [
        {
          to: "0x1111111111111111111111111111111111111111",
          data: "0x12345678",
          gas: "0x1c9c381",
        },
        "latest",
      ],
    });
    expect(response.status).toBe(400);
  });

  it("bounds log ranges and filter fanout", async () => {
    const { response } = await errorFor({
      jsonrpc: "2.0",
      id: 6,
      method: "eth_getLogs",
      params: [{ fromBlock: "0x1", toBlock: "0x2000" }],
    });
    expect(response.status).toBe(400);
  });

  it("rejects cross-site callers before upstream work", async () => {
    const { response } = await errorFor(
      { jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] },
      { "sec-fetch-site": "cross-site" },
    );
    expect(response.status).toBe(403);
  });

  it("fails closed in production until the durable relay gates are explicit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ZAPPAD_RPC_RELAY_ENABLED", "");
    vi.stubEnv("ZAPPAD_RPC_DURABLE_QUOTA_ENABLED", "");
    vi.stubEnv("ZAPPAD_RPC_URL", "https://rpc.example");

    const { response, payload } = await errorFor({
      jsonrpc: "2.0",
      id: 9,
      method: "eth_chainId",
      params: [],
    });

    expect(response.status).toBe(503);
    expect(payload.error?.code).toBe(-32_603);
  });

  it("returns restrictive API security headers", async () => {
    const { response } = await errorFor({
      jsonrpc: "2.0",
      id: 8,
      method: "eth_sendRawTransaction",
      params: [],
    });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });
});
