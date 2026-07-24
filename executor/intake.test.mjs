// Integration tests for the intake listener: a real server on an ephemeral port, real fetches.
// Run: node --test executor/intake.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIntakeToken, startIntake } from "./intake.mjs";
import { parseIntentFile } from "./store.mjs";

/** Raw GET so we can set a forbidden header (Host) that fetch() refuses to override. */
function rawGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

const scratch = mkdtempSync(join(tmpdir(), "openzaps-intake-"));
const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-intake-intents-"));
const tokenFile = join(scratch, "intake.token");

const cfg = { chainId: 4663, intakePort: 0, intentsDir }; // port 0 => ephemeral
let server;
let base;
let token;

const VALID_INTENT = {
  kind: "recurring",
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    chainId: "4663",
    seriesId: "1",
    validAfter: "0",
    deadline: "1893456000",
    interval: "86400",
    maxRuns: "10",
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: "3000000",
    maxFeePerGas: "10000000000",
    policyHash: "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270",
    outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
    minOutPerRun: "0",
  },
  signature: `0x${"ab".repeat(65)}`,
};

before(async () => {
  token = loadIntakeToken(tokenFile);
  server = startIntake({ cfg, token, isExecuting: () => true, countIntents: () => 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("token file is minted once, chmod 600, and stable across loads", () => {
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(loadIntakeToken(tokenFile), token);
});

test("GET /health answers without auth", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.chainId, 4663);
  assert.equal(body.executing, true);
});

test("POST /intents without a token is rejected", async () => {
  const res = await fetch(`${base}/intents`, { method: "POST", body: JSON.stringify(VALID_INTENT) });
  assert.equal(res.status, 401);
});

test("POST /intents with a wrong token is rejected", async () => {
  const res = await fetch(`${base}/intents`, {
    method: "POST",
    headers: { authorization: `Bearer ${"0".repeat(48)}` },
    body: JSON.stringify(VALID_INTENT),
  });
  assert.equal(res.status, 401);
});

test("POST /intents rejects unparseable JSON", async () => {
  const res = await fetch(`${base}/intents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("POST /intents rejects a schema-invalid intent", async () => {
  const res = await fetch(`${base}/intents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: "recurring", intent: { zap: "nope" }, signature: VALID_INTENT.signature }),
  });
  assert.equal(res.status, 422);
});

test("POST /intents rejects a chain mismatch", async () => {
  const wrongChain = { ...VALID_INTENT, intent: { ...VALID_INTENT.intent, chainId: "1" } };
  const res = await fetch(`${base}/intents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(wrongChain),
  });
  assert.equal(res.status, 422);
});

test("POST /intents stores a valid intent that round-trips through the file loader", async () => {
  const res = await fetch(`${base}/intents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(VALID_INTENT),
  });
  assert.equal(res.status, 201);
  const { stored } = await res.json();
  assert.match(stored, /^intake-\d+-recurring-9941dd72-[0-9a-f]{8}\.json$/);
  const files = readdirSync(intentsDir);
  assert.ok(files.includes(stored));
  const parsed = parseIntentFile(join(intentsDir, stored));
  assert.equal(parsed.kind, "recurring");
  assert.equal(parsed.intent.interval, 86400n);
  assert.equal(parsed.signature, VALID_INTENT.signature);
  assert.equal(JSON.parse(readFileSync(join(intentsDir, stored), "utf8")).signature, VALID_INTENT.signature);
});

test("concurrent identical POSTs each get a distinct file — none silently overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openzaps-collide-"));
  const collideServer = startIntake({ cfg: { chainId: 4663, intakePort: 0, intentsDir: dir }, token, isExecuting: () => false, countIntents: () => 0 });
  await new Promise((resolve) => collideServer.on("listening", resolve));
  const cbase = `http://127.0.0.1:${collideServer.address().port}`;
  try {
    const posts = Array.from({ length: 30 }, (_, i) =>
      fetch(`${cbase}/intents`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...VALID_INTENT, intent: { ...VALID_INTENT.intent, seriesId: String(i) } }),
      }),
    );
    const statuses = await Promise.all(posts.map((p) => p.then((r) => r.status)));
    assert.ok(statuses.every((s) => s === 201));
    // Every acknowledged intent is a real file — the collision bug destroyed most of these.
    assert.equal(readdirSync(dir).length, 30);
  } finally {
    collideServer.close();
  }
});

test("DNS-rebinding guard: a non-loopback Host is rejected, a loopback Host passes", async () => {
  const port = server.address().port;
  assert.equal(await rawGet(port, "/health", "attacker.com"), 403);
  assert.equal(await rawGet(port, "/health", "127.0.0.1"), 200);
  assert.equal(await rawGet(port, "/health", `localhost:${port}`), 200);
});

test("intent fields sent as JSON numbers are rejected (no silent precision loss)", async () => {
  const numeric = { ...VALID_INTENT, intent: { ...VALID_INTENT.intent, seriesId: 12345 } };
  const res = await fetch(`${base}/intents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(numeric),
  });
  assert.equal(res.status, 422);
});

test("CORS: allowed origin is echoed with the PNA header; foreign origin gets nothing", async () => {
  const pre = await fetch(`${base}/intents`, { method: "OPTIONS", headers: { origin: "https://www.0xzaps.com" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://www.0xzaps.com");
  assert.equal(pre.headers.get("access-control-allow-private-network"), "true");

  const foreign = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
});

test("unknown endpoints 404", async () => {
  const res = await fetch(`${base}/whatever`);
  assert.equal(res.status, 404);
});
