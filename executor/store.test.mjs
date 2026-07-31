import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerExecutorSensitiveValues } from "./redaction.mjs";
import { readState, writeState } from "./store.mjs";

test("writeState fsyncs the temporary file before rename and the parent directory after", () => {
  const calls = [];
  const fsOps = {
    openSync(path, flags, mode) {
      calls.push(["open", path, flags, mode]);
      return path.endsWith(".tmp") ? 10 : 11;
    },
    writeFileSync(fd, body) {
      calls.push(["write", fd, body]);
    },
    fsyncSync(fd) {
      calls.push(["fsync", fd]);
    },
    closeSync(fd) {
      calls.push(["close", fd]);
    },
    renameSync(from, to) {
      calls.push(["rename", from, to]);
    },
    existsSync() {
      return false;
    },
    unlinkSync(path) {
      calls.push(["unlink", path]);
    },
  };

  writeState("/state/executor.json", { receiptOutbox: { hash: { txHash: "hash" } } }, fsOps);

  assert.deepEqual(
    calls.map((entry) => (entry[0] === "write" ? entry.slice(0, 2) : entry)),
    [
      ["open", "/state/executor.json.tmp", "w", 0o600],
      ["write", 10],
      ["fsync", 10],
      ["close", 10],
      ["rename", "/state/executor.json.tmp", "/state/executor.json"],
      ["open", "/state", "r", undefined],
      ["fsync", 11],
      ["close", 11],
    ],
  );
});

test("writeState closes and removes an incomplete temporary file without renaming it", () => {
  const calls = [];
  const fsOps = {
    openSync: () => 10,
    writeFileSync: () => calls.push("write"),
    fsyncSync: () => {
      calls.push("fsync");
      throw new Error("disk sync failed");
    },
    closeSync: () => calls.push("close"),
    renameSync: () => calls.push("rename"),
    existsSync: () => true,
    unlinkSync: () => calls.push("unlink"),
  };

  assert.throws(() => writeState("/state/executor.json", {}, fsOps), /disk sync failed/);
  assert.deepEqual(calls, ["write", "fsync", "close", "unlink"]);
});

test("readState fails closed on corrupt state or an orphaned temporary state file", () => {
  const dir = mkdtempSync(join(tmpdir(), "openzaps-state-corrupt-"));
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, "{ definitely not json");
  assert.throws(() => readState(stateFile), /is corrupt.*reconcile pending wallet transactions/);

  const orphanedDir = mkdtempSync(join(tmpdir(), "openzaps-state-orphaned-"));
  const orphanedState = join(orphanedDir, "state.json");
  writeFileSync(orphanedState, JSON.stringify({ receiptOutbox: {} }));
  writeFileSync(`${orphanedState}.tmp`, "{}");
  assert.throws(() => readState(orphanedState), /unfinished temporary file/);
});

test("durable state round-trips pending receipt evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "openzaps-state-roundtrip-"));
  const stateFile = join(dir, "state.json");
  const state = {
    submissions: {},
    receiptOutbox: {
      hash: {
        txHash: `0x${"12".repeat(32)}`,
        zap: "0x1111111111111111111111111111111111111111",
        kind: "trigger",
        nonce: "7",
      },
    },
  };

  writeState(stateFile, state);
  assert.deepEqual(readState(stateFile), state);
});

test("durable state preserves signed bytes when they collide with a registered credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "openzaps-state-redaction-collision-"));
  const stateFile = join(dir, "state.json");
  const serializedTransaction = "0x02f00dfacecafebabe";
  const txHash = `0x${"f00dface".repeat(8)}`;
  registerExecutorSensitiveValues({
    credentials: ["Bearer f00dface"],
  });
  const state = {
    receiptOutbox: {
      [txHash]: {
        txHash,
        serializedTransaction,
        lastError: "relay rejected Bearer f00dface",
      },
    },
  };

  writeState(stateFile, state);
  const persisted = readState(stateFile);
  assert.equal(persisted.receiptOutbox[txHash].txHash, txHash);
  assert.equal(
    persisted.receiptOutbox[txHash].serializedTransaction,
    serializedTransaction,
  );
  assert.equal(
    persisted.receiptOutbox[txHash].lastError,
    "relay rejected [redacted]",
  );
});
