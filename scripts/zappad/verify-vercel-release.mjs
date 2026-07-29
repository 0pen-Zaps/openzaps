import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LAUNCHER_CODE_PROBE_ID,
  OPENZAPS_VERCEL_RELEASE_IDENTITY,
  UNSAFE_RPC_PROBE_ID,
  verifyVercelRelease,
} from "./lib/vercel-release-verification.mjs";
import { parseDeploymentVerificationEvidence } from "./lib/canary-reviewed-plan.mjs";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";

const VERCEL_API_ORIGIN = "https://api.vercel.com";
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function expectedBoolean(name) {
  const value = requiredEnv(name);
  if (!["true", "false"].includes(value)) {
    throw new Error(`${name} must be exactly true or false`);
  }
  return value === "true";
}

function expectedAliases() {
  const values = requiredEnv("EXPECTED_PRODUCTION_ALIASES")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(
      "EXPECTED_PRODUCTION_ALIASES must contain unique comma-separated hostnames",
    );
  }
  for (const value of values) {
    if (
      value.includes("://") ||
      value.includes("/") ||
      !value.includes(".") ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
    ) {
      throw new Error(
        "EXPECTED_PRODUCTION_ALIASES must contain hostnames without schemes or paths",
      );
    }
  }
  return values;
}

function productionOrigin(aliases) {
  const raw = requiredEnv("EXPECTED_PRODUCTION_URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("EXPECTED_PRODUCTION_URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "EXPECTED_PRODUCTION_URL must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  if (!aliases.includes(url.hostname.toLowerCase())) {
    throw new Error(
      "EXPECTED_PRODUCTION_URL hostname must appear in EXPECTED_PRODUCTION_ALIASES",
    );
  }
  return url.origin;
}

function vercelApiUrl(pathname, teamId, projectId) {
  const url = new URL(pathname, VERCEL_API_ORIGIN);
  url.searchParams.set("teamId", teamId);
  if (projectId) url.searchParams.set("projectId", projectId);
  return url;
}

async function jsonRequest(label, url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...init,
    });
  } catch {
    throw new Error(`${label} request failed`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the size limit`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    finalUrl: response.url,
    body,
  };
}

async function vercelApiRequest(label, url, token) {
  const response = await jsonRequest(label, url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ZapPad read-only release verifier",
    },
  });
  if (response.status !== 200) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return response.body;
}

function appHeaders(extra = {}) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "ZapPad read-only release verifier",
    ...extra,
  };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
  }
  return headers;
}

async function main() {
  const token = requiredEnv("VERCEL_TOKEN");
  const teamId = requiredEnv("EXPECTED_VERCEL_TEAM_ID");
  const projectId = requiredEnv("EXPECTED_VERCEL_PROJECT_ID");
  const projectName = requiredEnv("EXPECTED_VERCEL_PROJECT_NAME");
  const releaseCommit = requiredEnv("EXPECTED_RELEASE_COMMIT").toLowerCase();
  const productionAliases = expectedAliases();
  const origin = productionOrigin(productionAliases);
  const expectedReadEnabled = expectedBoolean(
    "EXPECTED_CONFIG_READ_ENABLED",
  );
  const expectedWriteEnabled = expectedBoolean(
    "EXPECTED_CONFIG_LAUNCH_ENABLED",
  );
  const evidencePath = resolve(
    requiredEnv("VERCEL_RELEASE_VERIFICATION_EVIDENCE"),
  );

  if (!/^team_[A-Za-z0-9]+$/.test(teamId)) {
    throw new Error("EXPECTED_VERCEL_TEAM_ID is invalid");
  }
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) {
    throw new Error("EXPECTED_VERCEL_PROJECT_ID is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(releaseCommit)) {
    throw new Error("EXPECTED_RELEASE_COMMIT must be a full Git commit");
  }
  if (!expectedReadEnabled) {
    throw new Error(
      "EXPECTED_CONFIG_READ_ENABLED must be true for production release verification",
    );
  }
  for (const [label, actual, expected] of [
    ["EXPECTED_VERCEL_TEAM_ID", teamId, OPENZAPS_VERCEL_RELEASE_IDENTITY.teamId],
    [
      "EXPECTED_VERCEL_PROJECT_ID",
      projectId,
      OPENZAPS_VERCEL_RELEASE_IDENTITY.projectId,
    ],
    [
      "EXPECTED_VERCEL_PROJECT_NAME",
      projectName,
      OPENZAPS_VERCEL_RELEASE_IDENTITY.projectName,
    ],
    [
      "EXPECTED_PRODUCTION_URL",
      origin,
      OPENZAPS_VERCEL_RELEASE_IDENTITY.productionOrigin,
    ],
  ]) {
    if (actual !== expected) {
      throw new Error(`${label} must match the canonical OpenZaps release`);
    }
  }
  await verifyReleaseCheckout(releaseCommit);
  const deploymentVerificationJson = await readFile(
    resolve(requiredEnv("DEPLOYMENT_VERIFICATION_EVIDENCE")),
    "utf8",
  );
  const deploymentVerification = parseDeploymentVerificationEvidence(
    deploymentVerificationJson,
    {
      expectedHash: requiredEnv(
        "EXPECTED_DEPLOYMENT_VERIFICATION_EVIDENCE_HASH",
      ),
      expectedReleaseCommit: releaseCommit,
    },
  );
  const launcherDeployBlock = Number(
    deploymentVerification.deployment.blockNumber,
  );
  if (
    !Number.isSafeInteger(launcherDeployBlock) ||
    launcherDeployBlock <= 0
  ) {
    throw new Error(
      "Deployment verification launcher block is not a safe positive integer",
    );
  }

  const runtimeEnvironmentUrl = vercelApiUrl(
    `/v9/projects/${encodeURIComponent(projectId)}/env`,
    teamId,
  );
  runtimeEnvironmentUrl.searchParams.set("decrypt", "true");
  const [project, firewall, runtimeEnvironment] = await Promise.all([
    vercelApiRequest(
      "Vercel project",
      vercelApiUrl(`/v9/projects/${encodeURIComponent(projectId)}`, teamId),
      token,
    ),
    vercelApiRequest(
      "Vercel Firewall configuration",
      vercelApiUrl(
        "/v1/security/firewall/config",
        teamId,
        projectId,
      ),
      token,
    ),
    vercelApiRequest(
      "Vercel production environment",
      runtimeEnvironmentUrl,
      token,
    ),
  ]);
  const deploymentId = project?.targets?.production?.id;
  if (
    typeof deploymentId !== "string" ||
    !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)
  ) {
    throw new Error("Vercel project has no valid production deployment ID");
  }
  const deployment = await vercelApiRequest(
    "Vercel production deployment",
    vercelApiUrl(
      `/v13/deployments/${encodeURIComponent(deploymentId)}`,
      teamId,
    ),
    token,
  );

  const configProbe = await jsonRequest(
    "Production /api/launch/config",
    new URL("/api/launch/config", origin),
    { method: "GET", headers: appHeaders() },
  );
  const healthProbe = await jsonRequest(
    "Production /api/launch/health",
    new URL("/api/launch/health", origin),
    { method: "GET", headers: appHeaders() },
  );
  const verifiedHeadBlock = healthProbe.body?.chain?.headBlock;
  if (!Number.isSafeInteger(verifiedHeadBlock) || verifiedHeadBlock <= 0) {
    throw new Error(
      "Production /api/launch/health did not provide a valid launcher verification block",
    );
  }
  const launcherCodeProbe = {
    ...(await jsonRequest(
      "Production /api/launch/rpc launcher-code probe",
      new URL("/api/launch/rpc", origin),
      {
        method: "POST",
        headers: appHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: LAUNCHER_CODE_PROBE_ID,
          method: "eth_getCode",
          params: [
            deploymentVerification.launchpad,
            `0x${verifiedHeadBlock.toString(16)}`,
          ],
        }),
      },
    )),
    blockNumber: verifiedHeadBlock,
  };
  const unsafeRpcProbe = await jsonRequest(
    "Production /api/launch/rpc unsafe-method probe",
    new URL("/api/launch/rpc", origin),
    {
      method: "POST",
      headers: appHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: UNSAFE_RPC_PROBE_ID,
        method: "eth_sendRawTransaction",
        params: ["0x00"],
      }),
    },
  );

  const result = verifyVercelRelease({
    expectations: {
      teamId,
      projectId,
      projectName,
      gitProvider: OPENZAPS_VERCEL_RELEASE_IDENTITY.gitProvider,
      gitOrganization:
        OPENZAPS_VERCEL_RELEASE_IDENTITY.gitOrganization,
      gitRepository: OPENZAPS_VERCEL_RELEASE_IDENTITY.gitRepository,
      gitRepositoryId:
        OPENZAPS_VERCEL_RELEASE_IDENTITY.gitRepositoryId,
      productionBranch:
        OPENZAPS_VERCEL_RELEASE_IDENTITY.productionBranch,
      releaseCommit,
      productionAliases,
      productionOrigin: origin,
      expectedReadEnabled,
      expectedWriteEnabled,
      launcherAddress: deploymentVerification.launchpad,
      launcherDeployBlock,
      launcherCodeHash: deploymentVerification.launchpadCodeHash,
      deploymentVerificationEvidenceHash: deploymentVerification.hash,
    },
    project,
    deployment,
    firewall,
    runtimeEnvironment,
    configProbe,
    healthProbe,
    launcherCodeProbe,
    unsafeRpcProbe,
  });
  const evidence = {
    ok: true,
    kind: "zappad-vercel-release-verification",
    verifiedAt: new Date().toISOString(),
    expectedReleaseCommit: releaseCommit,
    ...result,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(evidencePath, json, { flag: "wx", mode: 0o600 });
  process.stdout.write(json);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
