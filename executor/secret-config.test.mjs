import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ExecutorSecretConfigError,
  loadExecutorSecretConfigFile,
  loadExecutorSecretConfigFromEnv,
  MAX_EXECUTOR_SECRET_CONFIG_BYTES,
} from "./secret-config.mjs";

const SENSITIVE_RPC = "https://rpc-a.example/rpc?apiKey=late-block-secret";
const SENSITIVE_PRIMARY_RPC =
  "https://primary-rpc.example/rpc?apiKey=primary-provider-secret";
const SENSITIVE_RELAY = "https://relay-a.example/rpc?apiKey=relay-url-secret";
const AUTHORIZATION = "Bearer relay-authorization-secret";
const EXECUTOR_DIR = dirname(fileURLToPath(import.meta.url));
const VALID_CONFIG = {
  rpcUrls: [
    SENSITIVE_PRIMARY_RPC,
    "https://fallback-rpc.example/rpc?apiKey=fallback-provider-secret",
  ],
  lateBlockRpcUrls: [
    SENSITIVE_RPC,
    "https://rpc-b.example/rpc",
  ],
  privateRelays: [
    {
      id: "relay-a",
      url: SENSITIVE_RELAY,
      classification: "private-relay",
      operator: "operator-a",
      authorization: AUTHORIZATION,
    },
    {
      id: "relay-b",
      url: "https://relay-b.example/rpc",
      classification: "private-relay",
      operator: "operator-b",
    },
  ],
};

function fixture(t, value = VALID_CONFIG, mode = 0o600) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openzaps-secret-config-"));
  const checkoutRoot = join(root, "checkout");
  const operatorRoot = join(root, "operator");
  mkdirSync(checkoutRoot);
  mkdirSync(operatorRoot);
  const path = join(operatorRoot, "providers.json");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, checkoutRoot, operatorRoot, path };
}

function options(checkoutRoot, expectedUid = process.getuid()) {
  return { checkoutRoot, expectedUid };
}

test("loads a strict 0600 provider file outside the checkout without serializing secrets", (t) => {
  const { checkoutRoot, path } = fixture(t);
  const loaded = loadExecutorSecretConfigFile(path, options(checkoutRoot));

  assert.equal(loaded.rpcUrls.length, 2);
  assert.equal(loaded.rpcUrls[0].url, SENSITIVE_PRIMARY_RPC);
  assert.equal(loaded.lateBlockRpcUrls.length, 2);
  assert.equal(loaded.lateBlockRpcUrls[0].url, SENSITIVE_RPC);
  assert.equal(loaded.privateRelays.length, 2);
  assert.equal(loaded.privateRelays[0].id, "relay-a");
  assert.equal(loaded.privateRelays[0].url, SENSITIVE_RELAY);
  assert.equal(loaded.privateRelays[0].authorization, AUTHORIZATION);

  const serialized = JSON.stringify(loaded);
  assert.ok(!serialized.includes("primary-rpc.example"));
  assert.ok(!serialized.includes("primary-provider-secret"));
  assert.ok(!serialized.includes("rpc-a.example"));
  assert.ok(!serialized.includes("relay-a.example"));
  assert.ok(!serialized.includes("late-block-secret"));
  assert.ok(!serialized.includes("relay-url-secret"));
  assert.ok(!serialized.includes(AUTHORIZATION));
  assert.ok(!serialized.includes("operator-a"));
});

test("rejects relative, in-checkout, linked, non-regular, wrong-owner, and non-0600 paths", (t) => {
  const { checkoutRoot, operatorRoot, path } = fixture(t);

  assert.throws(
    () => loadExecutorSecretConfigFile("providers.json", options(checkoutRoot)),
    (error) =>
      error instanceof ExecutorSecretConfigError
      && error.code === "invalid-path",
  );

  const inCheckout = join(checkoutRoot, "providers.json");
  writeFileSync(inCheckout, JSON.stringify(VALID_CONFIG), { mode: 0o600 });
  chmodSync(inCheckout, 0o600);
  assert.throws(
    () => loadExecutorSecretConfigFile(inCheckout, options(checkoutRoot)),
    (error) => error.code === "inside-checkout",
  );

  const link = join(operatorRoot, "providers-link.json");
  symlinkSync(path, link);
  assert.throws(
    () => loadExecutorSecretConfigFile(link, options(checkoutRoot)),
    (error) => error.code === "symlink",
  );

  const parentLink = join(dirname(operatorRoot), "linked-operator");
  symlinkSync(operatorRoot, parentLink);
  assert.throws(
    () =>
      loadExecutorSecretConfigFile(
        join(parentLink, "providers.json"),
        options(checkoutRoot),
      ),
    (error) => error.code === "symlink",
  );

  const hardLink = join(operatorRoot, "providers-hardlink.json");
  linkSync(path, hardLink);
  assert.throws(
    () => loadExecutorSecretConfigFile(path, options(checkoutRoot)),
    (error) => error.code === "hardlink",
  );
  rmSync(hardLink);

  assert.throws(
    () => loadExecutorSecretConfigFile(operatorRoot, options(checkoutRoot)),
    (error) => error.code === "not-regular",
  );
  assert.throws(
    () =>
      loadExecutorSecretConfigFile(
        path,
        options(checkoutRoot, process.getuid() + 1),
      ),
    (error) => error.code === "wrong-owner",
  );

  chmodSync(path, 0o640);
  assert.throws(
    () => loadExecutorSecretConfigFile(path, options(checkoutRoot)),
    (error) => error.code === "wrong-mode",
  );
});

test("rejects provider files inside sibling repositories and linked Git worktrees", (t) => {
  const { root, checkoutRoot } = fixture(t);

  const repositoryCheckout = join(root, "sibling-repository");
  mkdirSync(join(repositoryCheckout, ".git"), { recursive: true });
  const repositoryPath = join(repositoryCheckout, "providers.json");
  writeFileSync(repositoryPath, JSON.stringify(VALID_CONFIG), { mode: 0o600 });
  chmodSync(repositoryPath, 0o600);
  assert.throws(
    () => loadExecutorSecretConfigFile(repositoryPath, options(checkoutRoot)),
    (error) =>
      error instanceof ExecutorSecretConfigError
      && error.code === "inside-git-checkout",
  );

  const linkedWorktree = join(root, "sibling-worktree");
  mkdirSync(linkedWorktree);
  writeFileSync(
    join(linkedWorktree, ".git"),
    "gitdir: ../repository/.git/worktrees/sibling-worktree\n",
  );
  const worktreePath = join(linkedWorktree, "providers.json");
  writeFileSync(worktreePath, JSON.stringify(VALID_CONFIG), { mode: 0o600 });
  chmodSync(worktreePath, 0o600);
  assert.throws(
    () => loadExecutorSecretConfigFile(worktreePath, options(checkoutRoot)),
    (error) =>
      error instanceof ExecutorSecretConfigError
      && error.code === "inside-git-checkout",
  );
});

test("secret-file late-block providers require HTTPS even on loopback", (t) => {
  for (const loopbackUrl of [
    "http://localhost:8545",
    "http://127.0.0.1:8546",
    "http://[::1]:8547",
  ]) {
    const candidate = fixture(t, {
      ...VALID_CONFIG,
      lateBlockRpcUrls: [
        loopbackUrl,
        "https://rpc-b.example/rpc",
      ],
    });
    assert.throws(
      () =>
        loadExecutorSecretConfigFile(
          candidate.path,
          options(candidate.checkoutRoot),
        ),
      (error) => error.code === "invalid-late-block-schema",
    );
  }
});

test("secret-file primary/fallback providers require 2 to 8 distinct HTTPS origins", (t) => {
  for (const rpcUrls of [
    ["https://only-one.example/rpc?key=secret"],
    [
      "http://localhost:8545/rpc?key=secret",
      "https://fallback.example/rpc?key=secret",
    ],
    [
      "https://same-origin.example/primary?key=secret-a",
      "https://same-origin.example/fallback?key=secret-b",
    ],
  ]) {
    const candidate = fixture(t, { ...VALID_CONFIG, rpcUrls });
    assert.throws(
      () =>
        loadExecutorSecretConfigFile(
          candidate.path,
          options(candidate.checkoutRoot),
        ),
      (error) => error.code === "invalid-rpc-schema",
    );
  }
});

test("bounds the provider file before parsing", (t) => {
  const { checkoutRoot, path } = fixture(
    t,
    "x".repeat(MAX_EXECUTOR_SECRET_CONFIG_BYTES + 1),
  );
  assert.throws(
    () => loadExecutorSecretConfigFile(path, options(checkoutRoot)),
    (error) => error.code === "too-large",
  );
});

test("requires exact top-level and nested schemas plus independent private relays", (t) => {
  const unknownTop = fixture(t, { ...VALID_CONFIG, unexpected: true });
  assert.throws(
    () =>
      loadExecutorSecretConfigFile(
        unknownTop.path,
        options(unknownTop.checkoutRoot),
      ),
    (error) => error.code === "invalid-schema",
  );

  const unknownRelayField = fixture(t, {
    ...VALID_CONFIG,
    privateRelays: VALID_CONFIG.privateRelays.map((relay, index) =>
      index === 0 ? { ...relay, extra: "must-not-be-accepted" } : relay),
  });
  assert.throws(
    () =>
      loadExecutorSecretConfigFile(
        unknownRelayField.path,
        options(unknownRelayField.checkoutRoot),
      ),
    (error) => error.code === "invalid-private-relay-schema",
  );

  const publicClassification = fixture(t, {
    ...VALID_CONFIG,
    privateRelays: VALID_CONFIG.privateRelays.map((relay, index) =>
      index === 0 ? { ...relay, classification: "public-rpc" } : relay),
  });
  assert.throws(
    () =>
      loadExecutorSecretConfigFile(
        publicClassification.path,
        options(publicClassification.checkoutRoot),
      ),
    (error) => error.code === "invalid-private-relay-schema",
  );

  const duplicateOrigin = fixture(t, {
    ...VALID_CONFIG,
    privateRelays: [
      VALID_CONFIG.privateRelays[0],
      {
        ...VALID_CONFIG.privateRelays[1],
        url: "https://relay-a.example/second-path",
      },
    ],
  });
  assert.throws(
    () =>
      loadExecutorSecretConfigFile(
        duplicateOrigin.path,
        options(duplicateOrigin.checkoutRoot),
      ),
    (error) => error.code === "duplicate-private-relay",
  );
});

test("invalid JSON and schema diagnostics never echo endpoints, authorization, or raw JSON", (t) => {
  const raw =
    `{"rpcUrls":["${SENSITIVE_PRIMARY_RPC}"],`
    + `"lateBlockRpcUrls":["${SENSITIVE_RPC}"],`
    + `"privateRelays":[{"authorization":"${AUTHORIZATION}"}]`;
  const { checkoutRoot, path } = fixture(t, raw);
  assert.throws(
    () => loadExecutorSecretConfigFile(path, options(checkoutRoot)),
    (error) => {
      const diagnostic = `${error.name}: ${error.message}\n${error.stack}`;
      return (
        error.code === "invalid-json"
        && !diagnostic.includes(SENSITIVE_RPC)
        && !diagnostic.includes(AUTHORIZATION)
        && !diagnostic.includes(raw)
      );
    },
  );
});

test("file and legacy provider environment sources conflict fail closed without echoing values", (t) => {
  const { checkoutRoot, path } = fixture(t);
  const legacyLateBlock = '["https://legacy-sensitive.example/rpc?key=secret"]';
  const legacyPrivateRelays =
    '[{"url":"https://legacy-relay-sensitive.example","authorization":"Bearer secret"}]';

  for (const legacy of [
    { OPENZAPS_LATE_BLOCK_RPC_URLS: legacyLateBlock },
    { OPENZAPS_PRIVATE_RELAYS_JSON: legacyPrivateRelays },
  ]) {
    assert.throws(
      () =>
        loadExecutorSecretConfigFromEnv(
          {
            OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE: path,
            ...legacy,
          },
          options(checkoutRoot),
        ),
      (error) => {
        const diagnostic = `${error.name}: ${error.message}`;
        return (
          error.code === "source-conflict"
          && !diagnostic.includes("legacy-sensitive")
          && !diagnostic.includes("legacy-relay-sensitive")
          && !diagnostic.includes("Bearer secret")
        );
      },
    );
  }

  assert.equal(loadExecutorSecretConfigFromEnv({}, options(checkoutRoot)), null);
});

test("loadConfig wires the provider file while leaving the signer off and serialization redacted", (t) => {
  const { root, path } = fixture(t);
  const configUrl = pathToFileURL(join(EXECUTOR_DIR, "config.mjs")).href;
  const privateSubmissionUrl =
    pathToFileURL(join(EXECUTOR_DIR, "private-submission.mjs")).href;
  const script = `
    const { loadConfig } = await import(${JSON.stringify(configUrl)});
    const { assessPrivateRelaySet } =
      await import(${JSON.stringify(privateSubmissionUrl)});
    const config = loadConfig();
    process.stdout.write(JSON.stringify({
      watchOnly: config.watchOnly,
      rpcCount: config.rpcUrls.length,
      rpcSource: config.rpcSource,
      lateBlockCount: config.lateBlock.rpcUrls.length,
      relayCount: config.privateSubmission.endpoints.length,
      relayReady: assessPrivateRelaySet(config.privateSubmission.endpoints).ready,
      serializedConfig: JSON.stringify(
        config,
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
      ),
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: process.env.PATH,
        OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE: path,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      watchOnly: output.watchOnly,
      rpcCount: output.rpcCount,
      rpcSource: output.rpcSource,
      lateBlockCount: output.lateBlockCount,
      relayCount: output.relayCount,
      relayReady: output.relayReady,
    },
    {
      watchOnly: true,
      rpcCount: 2,
      rpcSource: "secret-file",
      lateBlockCount: 2,
      relayCount: 2,
      relayReady: true,
    },
  );
  assert.ok(!output.serializedConfig.includes("rpc-a.example"));
  assert.ok(!output.serializedConfig.includes("primary-rpc.example"));
  assert.ok(!output.serializedConfig.includes("relay-a.example"));
  assert.ok(!output.serializedConfig.includes(AUTHORIZATION));
});

test("legacy provider and notification capabilities remain accessible but non-enumerable", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openzaps-legacy-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configUrl = pathToFileURL(join(EXECUTOR_DIR, "config.mjs")).href;
  const markers = [
    "legacy-late-a-secret",
    "legacy-relay-a-secret",
    "legacy-auth-a-secret",
    "legacy-op-a",
    "notification-generic-secret",
    "notification-discord-secret",
    "telegram-token-secret",
    "telegram-chat-secret",
  ];
  const script = `
    const { loadConfig } = await import(${JSON.stringify(configUrl)});
    const config = loadConfig();
    const serialized = JSON.stringify(
      config,
      (_key, value) => typeof value === "bigint" ? value.toString() : value,
    );
    const markers = ${JSON.stringify(markers)};
    process.stdout.write(JSON.stringify({
      lateBlockCount: config.lateBlock.rpcUrls.length,
      relayCount: config.privateSubmission.endpoints.length,
      lateBlockAccessible:
        config.lateBlock.rpcUrls[0].url.includes("legacy-late-a-secret"),
      relayAccessible:
        config.privateSubmission.endpoints[0].url.includes("legacy-relay-a-secret")
        && config.privateSubmission.endpoints[0].authorization.includes("legacy-auth-a-secret"),
      notificationsAccessible:
        config.notificationWebhookUrl.includes("notification-generic-secret")
        && config.discordWebhookUrl.includes("notification-discord-secret")
        && config.telegramBotToken.includes("telegram-token-secret")
        && config.telegramChatId.includes("telegram-chat-secret"),
      enumerableLateBlockKeys: Object.keys(config.lateBlock.rpcUrls[0]).length,
      enumerableRelayKeys: Object.keys(config.privateSubmission.endpoints[0]).length,
      leakedMarkerCount: markers.filter((marker) => serialized.includes(marker)).length,
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: process.env.PATH,
        OPENZAPS_LATE_BLOCK_RPC_URLS: JSON.stringify([
          "https://legacy-rpc-a.example/rpc?key=legacy-late-a-secret",
          "https://legacy-rpc-b.example/rpc?key=legacy-late-b-secret",
        ]),
        OPENZAPS_PRIVATE_RELAYS_JSON: JSON.stringify([
          {
            id: "legacy-a",
            url: "https://legacy-relay-a.example/rpc?key=legacy-relay-a-secret",
            classification: "private-relay",
            operator: "legacy-op-a",
            authorization: "Bearer legacy-auth-a-secret",
          },
          {
            id: "legacy-b",
            url: "https://legacy-relay-b.example/rpc?key=legacy-relay-b-secret",
            classification: "private-relay",
            operator: "legacy-op-b",
            authorization: "Bearer legacy-auth-b-secret",
          },
        ]),
        OPENZAPS_NOTIFICATION_WEBHOOK_URL:
          "https://hooks.example/rpc?key=notification-generic-secret",
        OPENZAPS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/notification-discord-secret",
        OPENZAPS_TELEGRAM_BOT_TOKEN: "123:telegram-token-secret",
        OPENZAPS_TELEGRAM_CHAT_ID: "telegram-chat-secret",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    lateBlockCount: 2,
    relayCount: 2,
    lateBlockAccessible: true,
    relayAccessible: true,
    notificationsAccessible: true,
    enumerableLateBlockKeys: 0,
    enumerableRelayKeys: 0,
    leakedMarkerCount: 0,
  });
});

test("failing credentialed primary RPC cannot reach logs or durable state", (t) => {
  const marker = "primary-runtime-marker-must-not-appear";
  const config = {
    ...VALID_CONFIG,
    rpcUrls: [
      `https://127.0.0.1:1/rpc?apiKey=${marker}`,
      "https://127.0.0.1:2/rpc?apiKey=fallback-runtime-secret",
    ],
  };
  const { root, path } = fixture(t, config);
  const configUrl = pathToFileURL(join(EXECUTOR_DIR, "config.mjs")).href;
  const engineUrl = pathToFileURL(join(EXECUTOR_DIR, "engine.mjs")).href;
  const storeUrl = pathToFileURL(join(EXECUTOR_DIR, "store.mjs")).href;
  const script = `
    const { createPublicClient, http } = await import("viem");
    const { loadConfig } = await import(${JSON.stringify(configUrl)});
    const { log } = await import(${JSON.stringify(engineUrl)});
    const { writeState } = await import(${JSON.stringify(storeUrl)});
    const config = loadConfig();
    const client = createPublicClient({
      transport: http(config.rpcUrl, { retryCount: 0, timeout: 500 }),
    });
    try {
      await client.getChainId();
      throw new Error("expected the credentialed primary RPC to fail");
    } catch (error) {
      log("error", error.stack ?? String(error));
      writeState(config.stateFile, {
        submissions: {
          failed: { detail: error.stack ?? String(error) },
        },
      });
    }
    process.stdout.write("\\nstate=" + config.stateFile);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: join(EXECUTOR_DIR, ".."),
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: process.env.PATH,
        OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE: path,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(!output.includes(marker));
  assert.ok(!output.includes("127.0.0.1:1"));
  const stateFile = join(root, ".openzaps", "executor", "state.json");
  const state = readFileSync(stateFile, "utf8");
  assert.ok(!state.includes(marker));
  assert.ok(!state.includes("127.0.0.1:1"));
  assert.ok(state.includes("[endpoint]") || state.includes("[redacted]"));
});

test("LaunchAgent template makes the validated provider path optional and keeps signer variables absent", () => {
  const template = readFileSync(
    join(EXECUTOR_DIR, "com.openzaps.executor.plist.template"),
    "utf8",
  );
  const installer = readFileSync(join(EXECUTOR_DIR, "install-launchd.sh"), "utf8");

  assert.ok(template.includes("__SECRET_CONFIG_KEY__"));
  assert.ok(template.includes("__SECRET_CONFIG_VALUE__"));
  assert.ok(!template.includes("<key>OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE</key>"));
  assert.ok(!template.includes("OPENZAPS_LATE_BLOCK_RPC_URLS"));
  assert.ok(!template.includes("OPENZAPS_PRIVATE_RELAYS_JSON"));
  assert.ok(!template.includes("OPENZAPS_EXECUTOR_KEYFILE"));
  assert.ok(!template.includes("OPENZAPS_EXECUTOR_PRIVATE_KEY"));
  assert.ok(!template.includes("https://"));
  assert.ok(!template.includes("authorization"));

  const validation = installer.indexOf('"$REPO/executor/secret-config.mjs"');
  const rendering = installer.indexOf('"$TEMPLATE" > "$PLIST"');
  assert.ok(validation >= 0 && rendering > validation);
  assert.ok(installer.includes('SECRET_CONFIG_FILE="${OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE:-}"'));
  assert.ok(installer.includes('if [[ -n "$SECRET_CONFIG_FILE" ]]'));
  assert.ok(installer.includes("s|__SECRET_CONFIG_KEY__|$SECRET_CONFIG_KEY_PLIST|g"));
  assert.ok(installer.includes("s|__SECRET_CONFIG_VALUE__|$SECRET_CONFIG_VALUE_PLIST|g"));
});

function runInstaller(root, extraEnv = {}) {
  const home = mkdtempSync(join(root, "home-"));
  const fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const launchctl = join(fakeBin, "launchctl");
  writeFileSync(launchctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(launchctl, 0o700);
  const result = spawnSync(
    "/bin/bash",
    [join(EXECUTOR_DIR, "install-launchd.sh")],
    {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        ...extraEnv,
      },
    },
  );
  const plist = join(home, "Library", "LaunchAgents", "com.openzaps.executor.plist");
  return {
    result,
    home,
    plist,
    text: result.status === 0 ? readFileSync(plist, "utf8") : "",
  };
}

test("watch-only install succeeds without a provider file and emits no secret or signer variables", (t) => {
  const { root } = fixture(t);
  const installed = runInstaller(root);

  assert.equal(installed.result.status, 0, installed.result.stderr);
  assert.ok(!installed.text.includes("OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE"));
  assert.ok(!installed.text.includes("OPENZAPS_EXECUTOR_KEYFILE"));
  assert.ok(!installed.text.includes("OPENZAPS_EXECUTOR_PRIVATE_KEY"));
  assert.ok(installed.result.stdout.includes("watch-only"));

  const configUrl = pathToFileURL(join(EXECUTOR_DIR, "config.mjs")).href;
  const configCheck = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { loadConfig } = await import(${JSON.stringify(configUrl)});`
        + "const config = loadConfig();"
        + "process.stdout.write(JSON.stringify({"
        + "watchOnly: config.watchOnly,"
        + "lateBlockCount: config.lateBlock.rpcUrls.length,"
        + "relayCount: config.privateSubmission.endpoints.length,"
        + "}));",
    ],
    {
      encoding: "utf8",
      env: {
        HOME: installed.home,
        PATH: process.env.PATH,
      },
    },
  );
  assert.equal(configCheck.status, 0, configCheck.stderr);
  assert.deepEqual(JSON.parse(configCheck.stdout), {
    watchOnly: true,
    lateBlockCount: 0,
    relayCount: 0,
  });
});

test("installer emits only an explicitly validated provider path and rejects insecure or signer-only input", (t) => {
  const valid = fixture(t);
  const installed = runInstaller(valid.root, {
    OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE: valid.path,
  });

  assert.equal(installed.result.status, 0, installed.result.stderr);
  assert.ok(installed.text.includes("<key>OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE</key>"));
  assert.ok(installed.text.includes(`<string>${valid.path}</string>`));
  assert.ok(!installed.text.includes(SENSITIVE_RPC));
  assert.ok(!installed.text.includes(SENSITIVE_RELAY));
  assert.ok(!installed.text.includes(AUTHORIZATION));
  assert.ok(!installed.text.includes("OPENZAPS_EXECUTOR_KEYFILE"));
  assert.ok(!installed.text.includes("OPENZAPS_EXECUTOR_PRIVATE_KEY"));

  chmodSync(valid.path, 0o640);
  const insecure = runInstaller(valid.root, {
    OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE: valid.path,
  });
  assert.equal(insecure.result.status, 1);
  assert.ok(!insecure.result.stderr.includes(valid.path));
  assert.ok(!insecure.result.stderr.includes(AUTHORIZATION));

  const signerOnly = runInstaller(valid.root, {
    OPENZAPS_EXECUTOR_KEYFILE: join(valid.root, "signer-key"),
  });
  assert.equal(signerOnly.result.status, 1);
  assert.ok(signerOnly.result.stderr.includes("refusing signer-related install"));
});

test("installer-facing validator output is value-free for both success and failure", (t) => {
  const secretConfigModule = join(EXECUTOR_DIR, "secret-config.mjs");
  const valid = fixture(t);
  const success = spawnSync(process.execPath, [secretConfigModule], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE: valid.path,
    },
  });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout.trim(), "executor provider secret config: valid");
  assert.ok(!success.stdout.includes("example"));
  assert.ok(!success.stdout.includes(AUTHORIZATION));

  const marker = "raw-json-must-not-appear";
  const invalid = fixture(t, `{"privateRelays":"${marker}"`);
  const failure = spawnSync(process.execPath, [secretConfigModule], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE: invalid.path,
    },
  });
  assert.equal(failure.status, 1);
  assert.ok(!failure.stderr.includes(marker));
  assert.ok(!failure.stderr.includes(invalid.path));
  assert.ok(!failure.stderr.includes("example"));
  assert.ok(!failure.stderr.includes(AUTHORIZATION));
});
