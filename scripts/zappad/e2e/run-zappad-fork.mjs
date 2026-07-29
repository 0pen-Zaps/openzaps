import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const FORK_BLOCK = 21_955_368;
const CHAIN_ID = 4_663;
const DEFAULT_ARCHIVE_RPC =
  "https://robinhood-chain.gateway.tenderly.co";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POSITION_MANAGER = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const SWAP_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const USDG_POOL_WHALE = "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a";
const USDG_FUNDING = 10_000_000n;

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

const UPSTREAM_READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
]);

const SECRET_ENV_NAMES = [
  "ZAPPAD_E2E_ARCHIVE_RPC_URL",
  "ROBINHOOD_ARCHIVE_RPC_URL",
  "ROBINHOOD_RPC_URL",
  "ZAPPAD_RPC_URL",
];

const upstreamUrl =
  process.env.ZAPPAD_E2E_ARCHIVE_RPC_URL ??
  process.env.ROBINHOOD_ARCHIVE_RPC_URL ??
  process.env.ROBINHOOD_RPC_URL ??
  process.env.ZAPPAD_RPC_URL ??
  DEFAULT_ARCHIVE_RPC;

const upstream = new URL(upstreamUrl);
if (
  upstream.protocol !== "https:" &&
  !(
    upstream.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(upstream.hostname)
  )
) {
  throw new Error("Archive RPC must use HTTPS or a loopback HTTP endpoint.");
}

const children = new Set();
let upstreamQueue = Promise.resolve();
let nextUpstreamRequestAt = 0;

function log(message) {
  process.stdout.write(`[zappad-e2e] ${message}\n`);
}

function redact(value) {
  return String(value).split(upstreamUrl).join("<archive-rpc-redacted>");
}

function sanitizedEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of SECRET_ENV_NAMES) delete env[name];
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: "1",
    ...extra,
  };
}

export function buildZapPadNextEnvironment({
  baseUrl,
  deployBlock,
  launcher,
  launcherCodeHash,
  nextDistRelative,
  rpcUrl,
}) {
  return {
    ZAPPAD_NEXT_DIST_DIR: nextDistRelative,
    ZAPPAD_RPC_URL: rpcUrl,
    ROBINHOOD_RPC_URL: rpcUrl,
    ZAPPAD_LAUNCHER_ADDRESS: launcher,
    ZAPPAD_LAUNCHER_DEPLOY_BLOCK: String(deployBlock),
    ZAPPAD_LAUNCHER_CODE_HASH: launcherCodeHash,
    ZAPPAD_LAUNCH_WRITES_ENABLED: "true",
    ZAPPAD_RPC_RELAY_ENABLED: "true",
    ZAPPAD_RPC_DURABLE_QUOTA_ENABLED: "true",
    NEXT_PUBLIC_APP_URL: baseUrl,
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function freePort() {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback port.");
  }
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function upstreamRequest(payload) {
  const execute = async () => {
    const wait = Math.max(0, nextUpstreamRequestAt - Date.now());
    if (wait > 0) await delay(wait);
    nextUpstreamRequestAt = Date.now() + 75;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "ZapPad deterministic read-only fork proxy",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const text = await response.text();
        if ([429, 502, 503, 504].includes(response.status)) {
          if (attempt === 5) {
            return jsonRpcError(
              payload.id,
              -32_005,
              `Archive RPC unavailable after retries (HTTP ${response.status}).`,
            );
          }
          await delay(250 * 2 ** attempt);
          continue;
        }
        if (!response.ok) {
          return jsonRpcError(
            payload.id,
            -32_000,
            `Archive RPC returned HTTP ${response.status}.`,
          );
        }
        try {
          return JSON.parse(text);
        } catch {
          return jsonRpcError(
            payload.id,
            -32_603,
            "Archive RPC returned invalid JSON.",
          );
        }
      } catch (error) {
        if (attempt === 5) {
          return jsonRpcError(
            payload.id,
            -32_000,
            error instanceof Error ? error.message : "Archive RPC failed.",
          );
        }
        await delay(250 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    return jsonRpcError(payload.id, -32_000, "Archive RPC failed.");
  };

  const result = upstreamQueue.then(execute, execute);
  upstreamQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function handleUpstreamPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return jsonRpcError(null, -32_600, "Batch and malformed requests are rejected.");
  }
  const payload = value;
  if (
    payload.jsonrpc !== "2.0" ||
    typeof payload.method !== "string" ||
    !UPSTREAM_READ_METHODS.has(payload.method) ||
    (payload.params !== undefined && !Array.isArray(payload.params))
  ) {
    return jsonRpcError(
      payload.id,
      -32_601,
      "Only allowlisted read methods may reach the archive RPC.",
    );
  }
  return upstreamRequest(payload);
}

async function startReadOnlyProxy() {
  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      !request.socket.remoteAddress?.includes("127.0.0.1")
    ) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(jsonRpcError(null, -32_600, "Loopback POST only.")),
      );
      return;
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1_000_000) {
        response.writeHead(413, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(jsonRpcError(null, -32_600, "Request too large.")),
        );
        return;
      }
      chunks.push(chunk);
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(jsonRpcError(null, -32_700, "Invalid JSON.")),
      );
      return;
    }

    const result = await handleUpstreamPayload(payload);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Read-only proxy did not bind to loopback.");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function startProcess(label, command, args, env, options = {}) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  const capture = (chunk) => {
    output = `${output}${redact(chunk)}`.slice(-100_000);
    if (options.stream) process.stdout.write(redact(chunk));
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", () => children.delete(child));
  return {
    child,
    label,
    output: () => output,
  };
}

async function runProcess(label, command, args, env, options = {}) {
  const processState = startProcess(label, command, args, env, options);
  const [code, signal] = await once(processState.child, "exit");
  if (code !== 0) {
    throw new Error(
      `${label} failed (${signal ?? code}).\n${processState.output()}`,
    );
  }
  return processState.output();
}

async function rpc(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${method}: ${payload.error.message}`);
  }
  return payload.result;
}

async function waitForRpc(rpcUrl, processState, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      throw new Error(
        `${processState.label} exited before readiness.\n${processState.output()}`,
      );
    }
    try {
      const chainId = await rpc(rpcUrl, "eth_chainId");
      if (Number.parseInt(chainId, 16) === CHAIN_ID) return;
    } catch {
      // The child is still starting.
    }
    await delay(250);
  }
  throw new Error(`${processState.label} did not become ready.`);
}

async function waitForHealth(baseUrl, processState, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      throw new Error(
        `${processState.label} exited before health was ready.\n${processState.output()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/launch/health`, {
        headers: { Accept: "application/json" },
      });
      if (response.status === 200) {
        const body = await response.json();
        if (
          body.status === "ok" &&
          body.chain?.id === CHAIN_ID &&
          body.launcher?.deployBlockVerified === true &&
          body.launcher?.codeHashConfigured === true &&
          body.launcher?.codeHashMatches === true &&
          body.launcher?.dependenciesVerified === true &&
          body.launcher?.factoryBindingsVerified === true &&
          body.launcher?.identityVerified === true &&
          body.launchWrites?.requested === true &&
          body.launchWrites?.enabled === true
        ) {
          return body;
        }
      }
    } catch {
      // Next is compiling.
    }
    await delay(500);
  }
  throw new Error(
    `Next health did not become ready.\n${processState.output()}`,
  );
}

async function waitForReceipt(rpcUrl, hash) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new Error(`Local transaction reverted: ${hash}`);
      }
      return receipt;
    }
    await delay(250);
  }
  throw new Error(`Local transaction receipt timed out: ${hash}`);
}

async function fundUsdg(rpcUrl, creator) {
  await rpc(rpcUrl, "anvil_setBalance", [
    USDG_POOL_WHALE,
    "0x56bc75e2d63100000",
  ]);
  await rpc(rpcUrl, "anvil_impersonateAccount", [USDG_POOL_WHALE]);
  try {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [creator, USDG_FUNDING],
    });
    const hash = await rpc(rpcUrl, "eth_sendTransaction", [
      {
        from: USDG_POOL_WHALE,
        to: USDG,
        data,
        gas: "0x7a120",
      },
    ]);
    await waitForReceipt(rpcUrl, hash);
  } finally {
    await rpc(rpcUrl, "anvil_stopImpersonatingAccount", [USDG_POOL_WHALE]);
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  const result = await rpc(rpcUrl, "eth_call", [
    { to: USDG, data },
    "latest",
  ]);
  const balance = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "balanceOf",
    data: result,
  });
  if (balance < USDG_FUNDING) {
    throw new Error("Canonical USDG pool transfer did not fund the creator.");
  }
  return balance;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const finished = Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => null),
  ]);
  const result = await finished;
  if (result === null && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), "zappad-e2e-"));
  if (!basename(temporary).startsWith("zappad-e2e-")) {
    throw new Error("Refusing to use an unexpected temporary directory.");
  }
  const statePath = join(temporary, "run-state.json");
  const manifestName = `e2e-${process.pid}.local.json`;
  const manifestPath = resolve(
    REPO_ROOT,
    "deployments",
    "zappad",
    manifestName,
  );
  const manifestForForge = `../../deployments/zappad/${manifestName}`;
  const nextDistRelative = `output/playwright/zappad/next-dev-${process.pid}`;
  const nextDistPath = resolve(REPO_ROOT, nextDistRelative);
  const protectedPaths = [
    resolve(REPO_ROOT, "next-env.d.ts"),
    resolve(REPO_ROOT, "tsconfig.json"),
  ];
  const protectedContents = await Promise.all(
    protectedPaths.map((path) => readFile(path, "utf8")),
  );
  let proxy;
  let anvil;
  let next;
  let nextStarted = false;

  try {
    log(
      upstreamUrl === DEFAULT_ARCHIVE_RPC
        ? "using Tenderly public archive gateway for test-only reads"
        : "using configured archive gateway (URL redacted)",
    );
    proxy = await startReadOnlyProxy();
    const anvilPort = await freePort();
    const anvilUrl = `http://127.0.0.1:${anvilPort}`;
    anvil = startProcess(
      "Anvil",
      "anvil",
      [
        "--fork-url",
        proxy.url,
        "--fork-block-number",
        String(FORK_BLOCK),
        "--chain-id",
        String(CHAIN_ID),
        "--hardfork",
        "cancun",
        "--host",
        "127.0.0.1",
        "--port",
        String(anvilPort),
        "--no-rate-limit",
        "--quiet",
      ],
      sanitizedEnv(),
    );
    await waitForRpc(anvilUrl, anvil);
    const accounts = await rpc(anvilUrl, "eth_accounts");
    if (!Array.isArray(accounts) || accounts.length < 4) {
      throw new Error("Anvil did not expose four unlocked loopback accounts.");
    }
    const [creator, recipient, treasury, trader] = accounts;
    log(`fork ready at block ${FORK_BLOCK}; deploying a fresh ZapPad stack`);

    const releaseCommit = (
      await runProcess(
        "Git release commit",
        "git",
        ["rev-parse", "HEAD"],
        sanitizedEnv(),
      )
    ).trim();
    if (!/^[0-9a-f]{40}$/i.test(releaseCommit)) {
      throw new Error("Could not resolve the full E2E release commit.");
    }
    const deploymentArguments = [
      "script",
      "--root",
      "contracts/zappad",
      "contracts/zappad/script/test/DeployZapPadLocalForkE2E.s.sol:DeployZapPadLocalForkE2E",
      "--rpc-url",
      anvilUrl,
      "--sender",
      creator,
      "--unlocked",
    ];
    const deploymentEnvironment = {
      PROTOCOL_TREASURY: treasury,
      DEPLOYER_ADDRESS: creator,
      DEPLOYMENT_SIMULATION_MANIFEST: manifestForForge,
      EXPECTED_RELEASE_COMMIT: releaseCommit,
    };
    await runProcess(
      "Foundry deployment dry run",
      "forge",
      deploymentArguments,
      sanitizedEnv(deploymentEnvironment),
    );
    const reviewedManifestJson = await readFile(manifestPath, "utf8");
    const reviewedManifestHash = keccak256(
      new TextEncoder().encode(reviewedManifestJson),
    );
    await runProcess(
      "Foundry reviewed deployment broadcast",
      "forge",
      [...deploymentArguments, "--broadcast", "--slow"],
      sanitizedEnv({
        ...deploymentEnvironment,
        EXPECTED_DEPLOYMENT_SIMULATION_MANIFEST_HASH: reviewedManifestHash,
      }),
    );
    if ((await readFile(manifestPath, "utf8")) !== reviewedManifestJson) {
      throw new Error("Reviewed deployment manifest changed during broadcast.");
    }

    const manifest = JSON.parse(reviewedManifestJson);
    const launcher = manifest.launchpad;
    if (
      typeof launcher !== "string" ||
      String(manifest.protocolTreasury).toLowerCase() !== treasury.toLowerCase()
    ) {
      throw new Error("Fresh deployment manifest did not match the E2E accounts.");
    }
    const deployBlock = Number.parseInt(
      await rpc(anvilUrl, "eth_blockNumber"),
      16,
    );
    const launcherCode = await rpc(anvilUrl, "eth_getCode", [
      launcher,
      "latest",
    ]);
    if (
      typeof launcherCode !== "string" ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(launcherCode) ||
      launcherCode === "0x00"
    ) {
      throw new Error("Fresh launcher deployment has no runtime bytecode.");
    }
    const launcherCodeHash = keccak256(launcherCode);
    const fundedUsdg = await fundUsdg(anvilUrl, creator);

    const currentBlock = await rpc(anvilUrl, "eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const timestamp = Math.max(
      Math.floor(Date.now() / 1_000),
      Number.parseInt(currentBlock.timestamp, 16) + 1,
    );
    await rpc(anvilUrl, "evm_setNextBlockTimestamp", [timestamp]);
    await rpc(anvilUrl, "evm_mine");

    const nextPort = await freePort();
    const healthUrl = `http://127.0.0.1:${nextPort}`;
    // Next reconstructs Request.url with localhost in development, so the
    // browser must use that same loopback origin for the RPC relay guard.
    const baseUrl = `http://localhost:${nextPort}`;
    const state = {
      baseUrl,
      rpcUrl: anvilUrl,
      chainId: CHAIN_ID,
      forkBlock: FORK_BLOCK,
      deployBlock,
      launcher,
      launcherCodeHash,
      accounts: { creator, recipient, treasury, trader },
      contracts: {
        weth: WETH,
        usdg: USDG,
        positionManager: POSITION_MANAGER,
        swapRouter: SWAP_ROUTER,
      },
      fundedUsdg: String(fundedUsdg),
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });

    next = startProcess(
      "Next.js",
      process.execPath,
      [
        resolve(REPO_ROOT, "node_modules/next/dist/bin/next"),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(nextPort),
      ],
      sanitizedEnv(
        buildZapPadNextEnvironment({
          baseUrl,
          deployBlock,
          launcher,
          launcherCodeHash,
          nextDistRelative,
          rpcUrl: anvilUrl,
        }),
      ),
    );
    nextStarted = true;
    const health = await waitForHealth(healthUrl, next);
    log(
      `Next health is ok at local block ${health.chain.headBlock}; starting Chromium`,
    );

    const playwrightCli = resolve(
      REPO_ROOT,
      "node_modules/@playwright/test/cli.js",
    );
    const chromiumExecutable = (
      await import("@playwright/test")
    ).chromium.executablePath();
    try {
      await access(chromiumExecutable);
    } catch {
      log("installing the pinned Playwright Chromium binary");
      await runProcess(
        "Playwright Chromium install",
        process.execPath,
        [playwrightCli, "install", "chromium"],
        sanitizedEnv(),
        { stream: true },
      );
    }

    await runProcess(
      "Playwright",
      process.execPath,
      [playwrightCli, "test", "--config", "playwright.zappad.config.ts"],
      sanitizedEnv({
        ZAPPAD_E2E_BASE_URL: baseUrl,
        ZAPPAD_E2E_RUN_STATE: statePath,
      }),
      { stream: true },
    );
    log("deterministic browser lifecycle passed");
  } finally {
    await stopChild(next?.child);
    if (nextStarted) {
      await Promise.all(
        protectedPaths.map((path, index) =>
          writeFile(path, protectedContents[index]),
        ),
      );
    }
    await stopChild(anvil?.child);
    if (proxy?.server.listening) {
      proxy.server.close();
      await once(proxy.server, "close");
    }
    await unlink(manifestPath).catch(() => undefined);
    await rm(nextDistPath, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `[zappad-e2e] FAILED\n${redact(error instanceof Error ? error.stack : error)}\n`,
    );
    process.exitCode = 1;
  });
}
