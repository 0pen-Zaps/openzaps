import assert from "node:assert/strict";
import { test } from "node:test";

import { createWalletClient, custom, defineChain, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assessPrivateRelaySet,
  createPrivateSubmissionProvider,
  PrivateSubmissionRejectedError,
  PrivateSubmissionUnavailableError,
  privateSubmissionDetail,
} from "./private-submission.mjs";

const RAW = "0x02c001808080808080c0";
const HASH = keccak256(RAW);
const PRIVATE_RELAYS = [
  {
    id: "relay-a",
    url: "https://relay-a.example/rpc",
    classification: "private-relay",
    operator: "operator-a",
  },
  {
    id: "relay-b",
    url: "https://relay-b.example/rpc",
    classification: "private-relay",
    operator: "operator-b",
  },
];

function rpcResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("private relay readiness excludes public RPC and direct-sequencer classifications", () => {
  const assessed = assessPrivateRelaySet([
    ...PRIVATE_RELAYS.slice(0, 1),
    {
      id: "public",
      url: "https://rpc.mainnet.chain.robinhood.com",
      classification: "public-rpc",
      operator: "Robinhood",
    },
    {
      id: "sequencer",
      url: "https://sequencer.example",
      classification: "direct-sequencer",
      operator: "Robinhood",
    },
  ]);
  assert.equal(assessed.ready, false);
  assert.equal(assessed.distinctOrigins, 1);
  assert.deepEqual(
    assessed.excluded.map((endpoint) => endpoint.classification),
    ["public-rpc", "direct-sequencer"],
  );
});

test("private relay readiness requires distinct URL origins and declared operators", () => {
  const duplicateOrigin = assessPrivateRelaySet([
    PRIVATE_RELAYS[0],
    {
      ...PRIVATE_RELAYS[1],
      url: "https://relay-a.example/another-path",
    },
  ]);
  assert.equal(duplicateOrigin.ready, false);
  assert.match(duplicateOrigin.detail, /origin .* duplicated/);

  const duplicateOperator = assessPrivateRelaySet([
    PRIVATE_RELAYS[0],
    {
      ...PRIVATE_RELAYS[1],
      operator: "operator-a",
    },
  ]);
  assert.equal(duplicateOperator.ready, false);
  assert.match(duplicateOperator.detail, /operator .* duplicated/);
});

test("non-send RPC calls use the public read transport while wallet sends are prohibited", async () => {
  const forwarded = [];
  const provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS,
    publicRequest: async (request) => {
      forwarded.push(request);
      return "0x123";
    },
    fetchImpl: async () => {
      throw new Error("must not dispatch");
    },
  });
  assert.equal(await provider.request({ method: "eth_chainId", params: [] }), "0x123");
  assert.deepEqual(forwarded, [{ method: "eth_chainId", params: [] }]);
  await assert.rejects(
    () => provider.request({ method: "eth_sendTransaction", params: [{}] }),
    PrivateSubmissionUnavailableError,
  );
  await assert.rejects(
    () => provider.request({ method: "eth_fillTransaction", params: [{ data: "0x1234" }] }),
    PrivateSubmissionUnavailableError,
  );
  assert.equal(forwarded.length, 1);
});

test("raw transaction fanout returns the local hash and records per-origin health", async () => {
  const requests = [];
  const events = [];
  const provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS,
    publicRequest: async () => {
      throw new Error("public send fallback must never run");
    },
    fetchImpl: async (url, init) => {
      events.push("dispatch");
      requests.push({ url, body: JSON.parse(init.body) });
      return url.includes("relay-a")
        ? rpcResponse({ jsonrpc: "2.0", id: 1, result: HASH })
        : rpcResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "already known" } });
    },
  });
  const hash = await provider.withPreparationHook(
    async ({ hash: preparedHash, serializedTransaction }) => {
      events.push("journal");
      assert.equal(preparedHash, HASH);
      assert.equal(serializedTransaction, RAW);
    },
    () => provider.request({ method: "eth_sendRawTransaction", params: [RAW] }),
  );
  assert.equal(hash, HASH);
  assert.equal(requests.length, 2);
  assert.equal(events[0], "journal");
  assert.deepEqual(events.slice(1), ["dispatch", "dispatch"]);
  assert.ok(requests.every((request) => request.body.method === "eth_sendRawTransaction"));
  const outcome = provider.getOutcome(hash);
  assert.equal(outcome.status, "accepted-quorum");
  assert.equal(outcome.acceptedOrigins, 2);
  assert.ok(privateSubmissionDetail(outcome).includes("2/2 accepted"));
});

test("authorization and raw bytes never enter readiness or health evidence", async () => {
  const secret = "Bearer relay-secret-value";
  const provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS.map((endpoint) => ({ ...endpoint, authorization: secret })),
    publicRequest: async () => {
      throw new Error("public fallback must never run");
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, secret);
      return rpcResponse({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: `relay at https://secret.example echoed ${secret} and ${RAW}`,
        },
      });
    },
  });
  const readinessJson = JSON.stringify(provider.readiness);
  assert.ok(!readinessJson.includes(secret));
  await assert.rejects(
    () => provider.request({ method: "eth_sendRawTransaction", params: [RAW] }),
    PrivateSubmissionRejectedError,
  );
  const evidenceJson = JSON.stringify(provider.getOutcome(HASH));
  assert.ok(!evidenceJson.includes(secret));
  assert.ok(!evidenceJson.includes(RAW));
  assert.ok(!evidenceJson.includes("secret.example"));
});

test("viem signs locally and exposes only raw transaction bytes to private relays", async () => {
  const dispatched = [];
  let provider;
  provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS,
    publicRequest: async ({ method }) => {
      throw new Error(`unexpected public preparation RPC ${method}`);
    },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      dispatched.push(request);
      return rpcResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: keccak256(request.params[0]),
      });
    },
  });
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  });
  const wallet = createWalletClient({
    account: privateKeyToAccount(`0x${"11".repeat(32)}`),
    chain,
    transport: custom(provider),
  });
  const hash = await wallet.sendTransaction({
    to: "0x0000000000000000000000000000000000000001",
    value: 1n,
    nonce: 0,
    gas: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    type: "eip1559",
  });
  assert.equal(dispatched.length, 2);
  assert.ok(dispatched.every((request) => request.method === "eth_sendRawTransaction"));
  assert.ok(dispatched.every((request) => /^0x02[0-9a-f]+$/i.test(request.params[0])));
  assert.ok(dispatched.every((request) => !request.params[0].includes("11".repeat(32))));
  assert.equal(provider.getOutcome(hash).status, "accepted-quorum");
});

test("no configured private quorum fails closed before dispatch", async () => {
  let requests = 0;
  const provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS.slice(0, 1),
    publicRequest: async () => {
      throw new Error("public send fallback must never run");
    },
    fetchImpl: async () => {
      requests += 1;
      return rpcResponse({ jsonrpc: "2.0", id: 1, result: HASH });
    },
  });
  await assert.rejects(
    () => provider.request({ method: "eth_sendRawTransaction", params: [RAW] }),
    PrivateSubmissionUnavailableError,
  );
  assert.equal(requests, 0);
});

test("an all-timeout fanout is tracked as uncertain rather than retried through public RPC", async () => {
  const provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS,
    timeoutMs: 10,
    publicRequest: async () => {
      throw new Error("public send fallback must never run");
    },
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  assert.equal(
    await provider.request({ method: "eth_sendRawTransaction", params: [RAW] }),
    HASH,
  );
  const outcome = provider.getOutcome(HASH);
  assert.equal(outcome.status, "submission-uncertain");
  assert.equal(outcome.unknownOrigins, 2);
});

test("a 200 response that resets mid-body remains uncertain after raw-tx dispatch", async () => {
  const encoder = new TextEncoder();
  const provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS,
    publicRequest: async () => {
      throw new Error("public send fallback must never run");
    },
    fetchImpl: async () => {
      let started = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!started) {
            started = true;
            controller.enqueue(encoder.encode('{"jsonrpc":"2.0","result":"'));
            return;
          }
          controller.error(new Error("relay response reset after headers"));
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(
    await provider.request({ method: "eth_sendRawTransaction", params: [RAW] }),
    HASH,
  );
  const outcome = provider.getOutcome(HASH);
  assert.equal(outcome.status, "submission-uncertain");
  assert.equal(outcome.unknownOrigins, 2);
  assert.equal(outcome.rejectedOrigins, 0);
});

test("deterministic rejection by every private relay reports failure without public fallback", async () => {
  const provider = createPrivateSubmissionProvider({
    endpoints: PRIVATE_RELAYS,
    publicRequest: async () => {
      throw new Error("public send fallback must never run");
    },
    fetchImpl: async () =>
      rpcResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid raw tx" } }),
  });
  await assert.rejects(
    () => provider.request({ method: "eth_sendRawTransaction", params: [RAW] }),
    (error) =>
      error instanceof PrivateSubmissionRejectedError
      && error.outcome.status === "rejected"
      && error.outcome.rejectedOrigins === 2,
  );
});
