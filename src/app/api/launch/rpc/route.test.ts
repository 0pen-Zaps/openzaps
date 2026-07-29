import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

function streamedRpcRequest(
  chunks: Uint8Array[],
  onCancel?: () => void,
) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });

  return new Request("http://localhost:3000/api/launch/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function enabledRpcPayload(id = 10) {
  return { jsonrpc: "2.0", id, method: "eth_chainId", params: [] };
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

  it("cancels a chunked request as soon as it crosses the 32 KiB cap", async () => {
    const encoder = new TextEncoder();
    const cancelled = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      streamedRpcRequest(
        [
          encoder.encode('{"jsonrpc":"2.0","id":10,"method":"eth_chainId","params":[],"padding":"'),
          encoder.encode("x".repeat(32_768)),
          encoder.encode('"}'),
        ],
        cancelled,
      ),
    );
    const payload = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(413);
    expect(payload.error).toEqual({
      code: -32_600,
      message: "Request is too large.",
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels an upstream stream as soon as it crosses the 2 MB cap", async () => {
    vi.stubEnv("ZAPPAD_RPC_URL", "http://rpc.example");
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(2_000_001));
      },
      cancel() {
        cancelled();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const response = await POST(rpcRequest(enabledRpcPayload(11)));
    const payload = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(502);
    expect(payload.error).toEqual({
      code: -32_603,
      message: "RPC response exceeded the size limit.",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("returns a matching bounded upstream JSON-RPC response", async () => {
    vi.stubEnv("ZAPPAD_RPC_URL", "http://rpc.example");
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('{"jsonrpc":"2.0","id":12,'),
      encoder.encode('"result":"0x1237"}'),
    ];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (!chunk) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(chunk);
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(rpcRequest(enabledRpcPayload(12)));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      jsonrpc: "2.0",
      id: 12,
      result: "0x1237",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when the upstream provider rejects", async () => {
    vi.stubEnv("ZAPPAD_RPC_URL", "http://rpc.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    );

    const response = await POST(rpcRequest(enabledRpcPayload(12)));
    const payload = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(502);
    expect(payload.error).toEqual({
      code: -32_603,
      message: "RPC provider is temporarily unavailable.",
    });
  });

  it("aborts an upstream request after the 12 second timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ZAPPAD_RPC_URL", "http://rpc.example");
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          markStarted?.();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = POST(rpcRequest(enabledRpcPayload(13)));
    await started;
    await vi.advanceTimersByTimeAsync(12_000);
    const response = await pending;
    const payload = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(502);
    expect(payload.error).toEqual({
      code: -32_603,
      message: "RPC provider is temporarily unavailable.",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
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
