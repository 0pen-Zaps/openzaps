import { keccak256 } from "viem";

export const UNSAFE_RPC_PROBE_ID = "zappad-release-verifier";
export const LAUNCHER_CODE_PROBE_ID = "zappad-release-launcher-code";

export const OPENZAPS_VERCEL_RELEASE_IDENTITY = Object.freeze({
  teamId: "team_Qqq9RxkmxK8LefSVmHdVo1jQ",
  projectId: "prj_uXuVv3LW0bPWfd7aHX5CLMEBbj3Q",
  projectName: "openzaps",
  gitProvider: "github",
  gitOrganization: "0pen-Zaps",
  gitRepository: "openzaps",
  gitRepositoryId: "1309390387",
  productionBranch: "main",
  productionOrigin: "https://www.0xzaps.com",
});

export const REQUIRED_PRODUCTION_RUNTIME_GATES = Object.freeze([
  "ZAPPAD_RPC_RELAY_ENABLED",
  "ZAPPAD_RPC_DURABLE_QUOTA_ENABLED",
]);

export const REQUIRED_IDENTITY_PROBES = [
  "runtime code hash",
  "deployment block",
  "ROBINHOOD_CHAIN_ID()",
  "LAUNCH_CONFIG_DOMAIN()",
  "canonical dependencies",
  "factory bindings",
  "dependency runtime code hashes",
  "EIP-1967 proxy implementations",
  "treasury and factory code presence",
];

export const REQUIRED_FIREWALL_PROTECTIONS = [
  { path: "/api/launch/rpc", method: "POST" },
  { path: "/api/launch/config", method: "GET" },
  { path: "/api/launch/health", method: "GET" },
];

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  requireCondition(isRecord(value), `${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  requireCondition(Array.isArray(value), `${label} must be an array`);
  return value;
}

function normalizedSha(value, label) {
  requireCondition(
    typeof value === "string" && /^[0-9a-f]{40}$/i.test(value),
    `${label} must be a full Git commit`,
  );
  return value.toLowerCase();
}

function normalizedAddress(value, label) {
  requireCondition(
    typeof value === "string" &&
      /^0x[0-9a-f]{40}$/i.test(value) &&
      !/^0x0{40}$/i.test(value),
    `${label} must be a nonzero EVM address`,
  );
  return value.toLowerCase();
}

function normalizedHash(value, label) {
  requireCondition(
    typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value),
    `${label} must be a 32-byte hash`,
  );
  return value.toLowerCase();
}

function normalizedRepositoryId(value, label) {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : value;
  requireCondition(
    typeof normalized === "string" && /^[1-9][0-9]*$/.test(normalized),
    `${label} is invalid`,
  );
  return normalized;
}

function sameCaseInsensitive(value, expected) {
  return (
    typeof value === "string" &&
    value.toLowerCase() === expected.toLowerCase()
  );
}

function normalizedAlias(value, label) {
  requireCondition(typeof value === "string" && value.length > 0, `${label} is invalid`);
  let hostname = value;
  if (value.includes("://")) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail(`${label} is invalid`);
    }
    requireCondition(
      parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.port === "" &&
        parsed.pathname === "/" &&
        parsed.search === "" &&
        parsed.hash === "",
      `${label} must be an HTTPS origin without credentials, path, query, or fragment`,
    );
    hostname = parsed.hostname;
  }
  hostname = hostname.toLowerCase().replace(/\.$/, "");
  requireCondition(
    hostname.length <= 253 &&
      hostname.includes(".") &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname),
    `${label} is invalid`,
  );
  return hostname;
}

function deploymentCommitSha(deployment, label) {
  const record = requireRecord(deployment, label);
  const meta = isRecord(record.meta) ? record.meta : {};
  const gitSource = isRecord(record.gitSource) ? record.gitSource : {};
  const gitMetadata = isRecord(record.gitMetadata) ? record.gitMetadata : {};
  const candidates = [
    meta.githubCommitSha,
    meta.gitCommitSha,
    gitSource.sha,
    gitMetadata.commitSha,
  ].filter((value) => value !== undefined && value !== null && value !== "");
  requireCondition(candidates.length > 0, `${label} has no Git commit provenance`);
  const commits = new Set(
    candidates.map((value, index) =>
      normalizedSha(value, `${label} Git commit provenance ${index + 1}`),
    ),
  );
  requireCondition(
    commits.size === 1,
    `${label} reports conflicting Git commit provenance`,
  );
  return [...commits][0];
}

function verifyGithubMetadata(metaValue, expectations, label) {
  const meta = requireRecord(metaValue, `${label} metadata`);
  for (const [organizationField, repositoryField] of [
    ["githubCommitOrg", "githubCommitRepo"],
    ["githubOrg", "githubRepo"],
  ]) {
    requireCondition(
      sameCaseInsensitive(
        meta[organizationField],
        expectations.gitOrganization,
      ) &&
        sameCaseInsensitive(
          meta[repositoryField],
          expectations.gitRepository,
        ),
      `${label} Git repository mismatch`,
    );
  }
  for (const field of ["githubRepoId", "githubCommitRepoId"]) {
    requireCondition(
      normalizedRepositoryId(meta[field], `${label} ${field}`) ===
        expectations.gitRepositoryId,
      `${label} Git repository ID mismatch`,
    );
  }
  requireCondition(
    meta.githubHost === "github.com",
    `${label} Git host mismatch`,
  );
  requireCondition(
    meta.githubCommitRef === expectations.productionBranch,
    `${label} Git ref mismatch`,
  );
  return {
    provider: expectations.gitProvider,
    organization: expectations.gitOrganization,
    repository: expectations.gitRepository,
    repositoryId: expectations.gitRepositoryId,
    ref: expectations.productionBranch,
  };
}

function verifyProjectGitLink(project, expectations) {
  const link = requireRecord(project.link, "Vercel project Git link");
  requireCondition(
    link.type === expectations.gitProvider,
    "Vercel project Git provider mismatch",
  );
  requireCondition(
    sameCaseInsensitive(link.org, expectations.gitOrganization) &&
      sameCaseInsensitive(link.repo, expectations.gitRepository),
    "Vercel project Git repository mismatch",
  );
  requireCondition(
    normalizedRepositoryId(link.repoId, "Vercel project Git repository ID") ===
      expectations.gitRepositoryId,
    "Vercel project Git repository ID mismatch",
  );
  requireCondition(
    link.productionBranch === expectations.productionBranch,
    "Vercel project production branch mismatch",
  );
}

function verifyDeploymentGitSource(deployment, expectations, expectedCommit) {
  const source = requireRecord(
    deployment.gitSource,
    "Vercel production deployment Git source",
  );
  requireCondition(
    source.type === expectations.gitProvider,
    "Vercel production deployment Git provider mismatch",
  );
  requireCondition(
    source.ref === expectations.productionBranch,
    "Vercel production deployment Git ref mismatch",
  );
  requireCondition(
    normalizedRepositoryId(
      source.repoId,
      "Vercel production deployment Git repository ID",
    ) === expectations.gitRepositoryId,
    "Vercel production deployment Git repository ID mismatch",
  );
  requireCondition(
    normalizedSha(
      source.sha,
      "Vercel production deployment Git source commit",
    ) === expectedCommit,
    "Vercel production deployment Git source commit mismatch",
  );
  requireCondition(
    source.prId === null,
    "Vercel production deployment unexpectedly came from a pull request",
  );
}

function aliases(value, label) {
  return new Set(
    requireArray(value, label).map((entry, index) =>
      normalizedAlias(entry, `${label}[${index}]`),
    ),
  );
}

function verifyAliases(actual, expected, label) {
  const actualAliases = aliases(actual, label);
  for (const expectedAlias of expected) {
    requireCondition(
      actualAliases.has(expectedAlias),
      `${label} is missing expected alias ${expectedAlias}`,
    );
  }
  return [...actualAliases].sort();
}

function verifyProjectAndDeployment(expectations, projectValue, deploymentValue) {
  const project = requireRecord(projectValue, "Vercel project");
  const deployment = requireRecord(deploymentValue, "Vercel production deployment");
  const expectedCommit = normalizedSha(
    expectations.releaseCommit,
    "EXPECTED_RELEASE_COMMIT",
  );
  const expectedAliases = requireArray(
    expectations.productionAliases,
    "Expected production aliases",
  ).map((value, index) =>
    normalizedAlias(value, `Expected production alias ${index + 1}`),
  );
  requireCondition(expectedAliases.length > 0, "At least one production alias is required");

  requireCondition(project.id === expectations.projectId, "Vercel project ID mismatch");
  requireCondition(
    project.accountId === expectations.teamId,
    "Vercel project team mismatch",
  );
  requireCondition(
    project.name === expectations.projectName,
    "Vercel project name mismatch",
  );
  verifyProjectGitLink(project, expectations);

  const targets = requireRecord(project.targets, "Vercel project targets");
  const production = requireRecord(
    targets.production,
    "Vercel project production target",
  );
  requireCondition(
    typeof production.id === "string" && production.id.startsWith("dpl_"),
    "Vercel project has no production deployment ID",
  );
  requireCondition(
    production.id === deployment.id,
    "Vercel production target and deployment ID differ",
  );
  requireCondition(
    production.target === "production" && deployment.target === "production",
    "Vercel deployment is not the production target",
  );
  requireCondition(
    production.readyState === "READY" && deployment.readyState === "READY",
    "Vercel production deployment is not READY",
  );
  requireCondition(
    production.readySubstate === "PROMOTED" &&
      deployment.readySubstate === "PROMOTED",
    "Vercel production deployment is not PROMOTED",
  );
  requireCondition(
    production.aliasError === null,
    "Vercel production target reports an alias error",
  );
  requireCondition(
    deployment.projectId === expectations.projectId,
    "Vercel deployment project mismatch",
  );
  requireCondition(
    deployment.ownerId === expectations.teamId,
    "Vercel deployment team mismatch",
  );
  requireCondition(
    deployment.name === expectations.projectName,
    "Vercel deployment project name mismatch",
  );
  const targetGit = verifyGithubMetadata(
    production.meta,
    expectations,
    "Vercel project production target",
  );
  const deploymentGit = verifyGithubMetadata(
    deployment.meta,
    expectations,
    "Vercel production deployment",
  );
  verifyDeploymentGitSource(deployment, expectations, expectedCommit);

  const targetCommit = deploymentCommitSha(
    production,
    "Vercel project production target",
  );
  const deploymentCommit = deploymentCommitSha(
    deployment,
    "Vercel production deployment",
  );
  requireCondition(
    targetCommit === expectedCommit && deploymentCommit === expectedCommit,
    "Vercel production deployment Git SHA does not match EXPECTED_RELEASE_COMMIT",
  );

  const targetAliases = verifyAliases(
    production.alias,
    expectedAliases,
    "Vercel production target aliases",
  );
  const deploymentAliases = verifyAliases(
    deployment.alias,
    expectedAliases,
    "Vercel production deployment aliases",
  );

  return {
    id: deployment.id,
    gitSha: deploymentCommit,
    readyState: deployment.readyState,
    readySubstate: deployment.readySubstate,
    git: {
      repository: `${expectations.gitOrganization}/${expectations.gitRepository}`,
      repositoryId: expectations.gitRepositoryId,
      ref: expectations.productionBranch,
      target: targetGit,
      deployment: deploymentGit,
    },
    targetAliases,
    deploymentAliases,
  };
}

function requireSameProbeUrl(probe, expectedOrigin, expectedPath, label) {
  requireCondition(typeof probe.finalUrl === "string", `${label} final URL is missing`);
  let finalUrl;
  try {
    finalUrl = new URL(probe.finalUrl);
  } catch {
    fail(`${label} final URL is invalid`);
  }
  requireCondition(
    finalUrl.origin === expectedOrigin &&
      finalUrl.pathname === expectedPath &&
      finalUrl.search === "" &&
      finalUrl.hash === "",
    `${label} redirected away from the expected production endpoint`,
  );
  requireCondition(
    typeof probe.contentType === "string" &&
      probe.contentType.toLowerCase().includes("application/json"),
    `${label} did not return JSON`,
  );
}

function requireBoolean(value, expected, label) {
  requireCondition(typeof value === "boolean", `${label} must be a boolean`);
  requireCondition(value === expected, `${label} did not match the expected value`);
}

function verifyConfigProbe(expectations, probeValue) {
  const probe = requireRecord(probeValue, "/api/launch/config probe");
  requireSameProbeUrl(
    probe,
    expectations.productionOrigin,
    "/api/launch/config",
    "/api/launch/config",
  );
  requireCondition(probe.status === 200, "/api/launch/config did not return HTTP 200");
  const config = requireRecord(probe.body, "/api/launch/config response");
  requireBoolean(
    config.readEnabled,
    expectations.expectedReadEnabled,
    "/api/launch/config readEnabled",
  );
  requireBoolean(
    config.launchEnabled,
    expectations.expectedWriteEnabled,
    "/api/launch/config launchEnabled",
  );
  requireCondition(
    !config.launchEnabled || config.readEnabled,
    "/api/launch/config cannot enable writes while reads are disabled",
  );
  requireCondition(
    normalizedAddress(
      config.launcherAddress,
      "/api/launch/config launcherAddress",
    ) === expectations.launcherAddress,
    "/api/launch/config launcherAddress does not match deployment verification evidence",
  );
  requireCondition(
    Number.isSafeInteger(config.deployBlock) &&
      config.deployBlock === expectations.launcherDeployBlock,
    "/api/launch/config deployBlock does not match deployment verification evidence",
  );
  const chain = requireRecord(config.chain, "/api/launch/config chain");
  requireCondition(chain.id === 4_663, "/api/launch/config chain ID mismatch");
  requireCondition(chain.rpcPath === "/api/launch/rpc", "/api/launch/config RPC path mismatch");
  requireCondition(
    typeof chain.explorerUrl === "string" &&
      new URL(chain.explorerUrl).protocol === "https:",
    "/api/launch/config explorer URL is invalid",
  );
  const pairedAssets = requireArray(config.pairedAssets, "/api/launch/config pairedAssets");
  requireCondition(pairedAssets.length === 2, "/api/launch/config must expose two paired assets");
  for (const [index, assetValue] of pairedAssets.entries()) {
    const asset = requireRecord(assetValue, `/api/launch/config pairedAssets[${index}]`);
    requireCondition(
      typeof asset.address === "string" && /^0x[0-9a-f]{40}$/i.test(asset.address),
      `/api/launch/config pairedAssets[${index}] address is invalid`,
    );
    requireCondition(
      typeof asset.symbol === "string" && asset.symbol.length > 0,
      `/api/launch/config pairedAssets[${index}] symbol is invalid`,
    );
    requireCondition(
      Number.isSafeInteger(asset.decimals) &&
        asset.decimals >= 0 &&
        asset.decimals <= 255,
      `/api/launch/config pairedAssets[${index}] decimals are invalid`,
    );
  }
  return {
    readEnabled: config.readEnabled,
    launchEnabled: config.launchEnabled,
    launcherAddress: expectations.launcherAddress,
    deployBlock: config.deployBlock,
  };
}

function verifyHealthProbe(expectations, probeValue) {
  const probe = requireRecord(probeValue, "/api/launch/health probe");
  requireSameProbeUrl(
    probe,
    expectations.productionOrigin,
    "/api/launch/health",
    "/api/launch/health",
  );
  requireCondition(probe.status === 200, "/api/launch/health did not return HTTP 200");
  const health = requireRecord(probe.body, "/api/launch/health response");
  requireCondition(health.status === "ok", "/api/launch/health status is not ok");
  requireCondition(health.rpcConfigured === true, "/api/launch/health RPC is not configured");

  const chain = requireRecord(health.chain, "/api/launch/health chain");
  requireCondition(chain.id === 4_663, "/api/launch/health chain ID mismatch");
  requireCondition(chain.matches === true, "/api/launch/health chain identity failed");
  requireCondition(chain.recent === true, "/api/launch/health head is stale");
  requireCondition(
    Number.isSafeInteger(chain.headBlock) && chain.headBlock > 0,
    "/api/launch/health head block is invalid",
  );
  requireCondition(
    Number.isSafeInteger(chain.headAgeSeconds) && chain.headAgeSeconds >= 0,
    "/api/launch/health head age is invalid",
  );
  requireCondition(
    typeof chain.headTimestamp === "string" &&
      Number.isFinite(Date.parse(chain.headTimestamp)),
    "/api/launch/health head timestamp is invalid",
  );

  const launcher = requireRecord(health.launcher, "/api/launch/health launcher");
  for (const field of [
    "configured",
    "deployBlockConfigured",
    "deployBlockVerified",
    "bytecodePresent",
    "codeHashConfigured",
    "codeHashMatches",
    "dependenciesVerified",
    "dependencyCodeHashesVerified",
    "proxyImplementationsVerified",
    "requiredDependencyCodePresent",
    "factoryBindingsVerified",
    "identityVerified",
  ]) {
    requireCondition(
      launcher[field] === true,
      `/api/launch/health launcher.${field} is not true`,
    );
  }
  requireCondition(
    normalizedHash(
      launcher.runtimeCodeHash,
      "/api/launch/health launcher.runtimeCodeHash",
    ) === expectations.launcherCodeHash,
    "/api/launch/health launcher.runtimeCodeHash does not match deployment verification evidence",
  );
  const identityProbes = requireArray(
    launcher.identityProbes,
    "/api/launch/health launcher.identityProbes",
  );
  for (const requiredProbe of REQUIRED_IDENTITY_PROBES) {
    requireCondition(
      identityProbes.includes(requiredProbe),
      `/api/launch/health is missing identity probe ${requiredProbe}`,
    );
  }

  const launchWrites = requireRecord(
    health.launchWrites,
    "/api/launch/health launchWrites",
  );
  requireBoolean(
    launchWrites.requested,
    expectations.expectedWriteEnabled,
    "/api/launch/health launchWrites.requested",
  );
  requireBoolean(
    launchWrites.enabled,
    expectations.expectedWriteEnabled,
    "/api/launch/health launchWrites.enabled",
  );
  requireCondition(
    Number.isSafeInteger(health.latencyMs) && health.latencyMs >= 0,
    "/api/launch/health latency is invalid",
  );
  requireCondition(
    typeof health.timestamp === "string" && Number.isFinite(Date.parse(health.timestamp)),
    "/api/launch/health timestamp is invalid",
  );
  return {
    status: health.status,
    headBlock: chain.headBlock,
    identityVerified: launcher.identityVerified,
    runtimeCodeHash: expectations.launcherCodeHash,
    launchWrites: {
      requested: launchWrites.requested,
      enabled: launchWrites.enabled,
    },
  };
}

function verifyUnsafeRpcProbe(expectations, probeValue) {
  const probe = requireRecord(probeValue, "/api/launch/rpc unsafe-method probe");
  requireSameProbeUrl(
    probe,
    expectations.productionOrigin,
    "/api/launch/rpc",
    "/api/launch/rpc unsafe-method probe",
  );
  requireCondition(
    probe.status === 403,
    "/api/launch/rpc did not reject an unsafe method with HTTP 403",
  );
  const body = requireRecord(probe.body, "/api/launch/rpc unsafe-method response");
  requireCondition(body.jsonrpc === "2.0", "/api/launch/rpc rejection is not JSON-RPC 2.0");
  requireCondition(
    body.id === UNSAFE_RPC_PROBE_ID,
    "/api/launch/rpc rejection returned the wrong request ID",
  );
  requireCondition(
    !Object.hasOwn(body, "result"),
    "/api/launch/rpc unsafe-method response unexpectedly contains a result",
  );
  const error = requireRecord(body.error, "/api/launch/rpc unsafe-method error");
  requireCondition(error.code === -32_601, "/api/launch/rpc unsafe-method error code mismatch");
  requireCondition(
    typeof error.message === "string" && error.message.length > 0,
    "/api/launch/rpc unsafe-method error message is missing",
  );
  return {
    rejected: true,
    status: probe.status,
    errorCode: error.code,
  };
}

function verifyLauncherCodeProbe(
  expectations,
  probeValue,
  verifiedHeadBlock,
) {
  const probe = requireRecord(probeValue, "/api/launch/rpc launcher-code probe");
  requireSameProbeUrl(
    probe,
    expectations.productionOrigin,
    "/api/launch/rpc",
    "/api/launch/rpc launcher-code probe",
  );
  requireCondition(
    probe.status === 200,
    "/api/launch/rpc launcher-code probe did not return HTTP 200",
  );
  requireCondition(
    probe.blockNumber === verifiedHeadBlock,
    "/api/launch/rpc launcher-code probe did not use the verified health block",
  );
  const body = requireRecord(
    probe.body,
    "/api/launch/rpc launcher-code response",
  );
  requireCondition(
    body.jsonrpc === "2.0" && body.id === LAUNCHER_CODE_PROBE_ID,
    "/api/launch/rpc launcher-code response identity mismatch",
  );
  requireCondition(
    !Object.hasOwn(body, "error") && Object.hasOwn(body, "result"),
    "/api/launch/rpc launcher-code response is missing its result",
  );
  requireCondition(
    typeof body.result === "string" &&
      /^0x(?:[0-9a-f]{2})+$/i.test(body.result),
    "/api/launch/rpc launcher-code response has invalid bytecode",
  );
  const codeHash = keccak256(body.result);
  requireCondition(
    codeHash.toLowerCase() === expectations.launcherCodeHash,
    "/api/launch/rpc launcher code hash does not match deployment verification evidence",
  );
  return {
    address: expectations.launcherAddress,
    blockNumber: verifiedHeadBlock,
    codeHash: codeHash.toLowerCase(),
  };
}

function productionTargets(entry) {
  if (Array.isArray(entry.target)) return entry.target;
  return typeof entry.target === "string" ? [entry.target] : [];
}

function verifyProductionRuntimeGates(environmentValue, expectations) {
  const environment = requireRecord(
    environmentValue,
    "Vercel project environment response",
  );
  const entries = requireArray(
    environment.envs,
    "Vercel project environment variables",
  );
  const verified = {};

  for (const key of REQUIRED_PRODUCTION_RUNTIME_GATES) {
    const productionEntries = entries.filter(
      (entry) =>
        isRecord(entry) &&
        entry.key === key &&
        productionTargets(entry).includes("production"),
    );
    const branchEntries = productionEntries.filter(
      (entry) => entry.gitBranch === expectations.productionBranch,
    );
    const unscopedEntries = productionEntries.filter(
      (entry) =>
        entry.gitBranch === undefined ||
        entry.gitBranch === null ||
        entry.gitBranch === "",
    );
    const effectiveEntries =
      branchEntries.length > 0 ? branchEntries : unscopedEntries;

    requireCondition(
      effectiveEntries.length > 0,
      `Vercel production environment is missing ${key}`,
    );
    requireCondition(
      effectiveEntries.every((entry) => entry.value === "true"),
      `Vercel production environment ${key} must be exactly true`,
    );
    verified[key] = true;
  }

  return {
    ...verified,
    target: "production",
    branch: expectations.productionBranch,
    durableQuotaEvidence:
      "configuration declaration only; this verifier does not create the external durable quota",
  };
}

function scalarConditionMatches(condition, expected, allowedOperators) {
  if (
    !isRecord(condition) ||
    condition.neg === true ||
    !allowedOperators.includes(condition.op)
  ) {
    return false;
  }
  if (condition.op === "eq") return condition.value === expected;
  if (condition.op === "inc") {
    const values = Array.isArray(condition.value)
      ? condition.value
      : typeof condition.value === "string"
        ? condition.value.split(",").map((value) => value.trim())
        : [];
    return values.includes(expected);
  }
  if (condition.op === "pre") {
    return typeof condition.value === "string" && expected.startsWith(condition.value);
  }
  return false;
}

function conditionGroupCovers(groupValue, protection) {
  if (!isRecord(groupValue) || !Array.isArray(groupValue.conditions)) return false;
  const conditions = groupValue.conditions;
  if (conditions.length === 0) return false;
  const allowedTypes = new Set(["path", "raw_path", "target_path", "method", "environment"]);
  if (
    conditions.some(
      (condition) => !isRecord(condition) || !allowedTypes.has(condition.type),
    )
  ) {
    return false;
  }

  const pathConditions = conditions.filter((condition) =>
    ["path", "raw_path", "target_path", "route"].includes(condition.type),
  );
  const methodConditions = conditions.filter(
    (condition) => condition.type === "method",
  );
  const environmentConditions = conditions.filter(
    (condition) => condition.type === "environment",
  );
  return (
    pathConditions.length > 0 &&
    pathConditions.every((condition) =>
      scalarConditionMatches(condition, protection.path, ["eq", "inc", "pre"]),
    ) &&
    methodConditions.every((condition) =>
      scalarConditionMatches(condition, protection.method, ["eq", "inc"]),
    ) &&
    environmentConditions.every((condition) =>
      scalarConditionMatches(condition, "production", ["eq", "inc"]),
    )
  );
}

function activeRateLimit(ruleValue) {
  if (!isRecord(ruleValue) || ruleValue.active !== true || ruleValue.valid === false) {
    return null;
  }
  if (
    Array.isArray(ruleValue.validationErrors) &&
    ruleValue.validationErrors.length > 0
  ) {
    return null;
  }
  const action = isRecord(ruleValue.action) ? ruleValue.action : {};
  const mitigate = isRecord(action.mitigate) ? action.mitigate : {};
  const rateLimit = isRecord(mitigate.rateLimit) ? mitigate.rateLimit : null;
  if (mitigate.action !== "rate_limit" || !rateLimit) return null;
  if (
    !["fixed_window", "token_bucket"].includes(rateLimit.algo) ||
    !Number.isInteger(rateLimit.window) ||
    rateLimit.window < 10 ||
    rateLimit.window > 3_600 ||
    !Number.isInteger(rateLimit.limit) ||
    rateLimit.limit < 1 ||
    !Array.isArray(rateLimit.keys) ||
    !rateLimit.keys.includes("ip") ||
    !["rate_limit", "deny", "challenge"].includes(rateLimit.action)
  ) {
    return null;
  }
  return rateLimit;
}

function verifyFirewall(expectations, firewallValue) {
  const firewall = requireRecord(firewallValue, "Vercel Firewall response");
  requireCondition(
    Object.hasOwn(firewall, "draft") && firewall.draft === null,
    "Vercel Firewall has unpublished draft changes",
  );
  const active = requireRecord(firewall.active, "Active Vercel Firewall configuration");
  requireCondition(
    active.ownerId === expectations.teamId,
    "Active Vercel Firewall team mismatch",
  );
  requireCondition(
    typeof active.projectKey === "string" &&
      active.projectKey.startsWith(`${expectations.projectId}#`),
    "Active Vercel Firewall project mismatch",
  );
  requireCondition(
    active.firewallEnabled === true,
    "Active Vercel Firewall is not enabled",
  );
  requireCondition(
    typeof active.id === "string" && active.id.length > 0,
    "Active Vercel Firewall configuration ID is missing",
  );
  requireCondition(
    (typeof active.version === "number" && Number.isInteger(active.version)) ||
      (typeof active.version === "string" && active.version.length > 0),
    "Active Vercel Firewall version is missing",
  );
  const rules = requireArray(active.rules, "Active Vercel Firewall rules");

  const protections = REQUIRED_FIREWALL_PROTECTIONS.map((protection) => {
    const match = rules
      .map((rule) => ({ rule, rateLimit: activeRateLimit(rule) }))
      .find(
        ({ rule, rateLimit }) =>
          rateLimit &&
          Array.isArray(rule.conditionGroup) &&
          rule.conditionGroup.some((group) =>
            conditionGroupCovers(group, protection),
          ),
      );
    requireCondition(
      Boolean(match),
      `Active Vercel Firewall lacks a published per-IP rate limit for ${protection.method} ${protection.path}`,
    );
    return {
      path: protection.path,
      method: protection.method,
      ruleId: match.rule.id,
      ruleName: match.rule.name,
      algorithm: match.rateLimit.algo,
      windowSeconds: match.rateLimit.window,
      requestLimit: match.rateLimit.limit,
      limitAction: match.rateLimit.action,
    };
  });

  return {
    id: active.id,
    version: active.version,
    firewallEnabled: active.firewallEnabled,
    noPendingDraft: true,
    protections,
  };
}

export function verifyVercelRelease({
  expectations,
  project,
  deployment,
  firewall,
  runtimeEnvironment,
  configProbe,
  healthProbe,
  unsafeRpcProbe,
  launcherCodeProbe,
}) {
  const rawExpected = requireRecord(expectations, "Release expectations");
  requireCondition(
    typeof rawExpected.teamId === "string" &&
      /^team_[A-Za-z0-9]+$/.test(rawExpected.teamId),
    "Expected Vercel team ID is invalid",
  );
  requireCondition(
    typeof rawExpected.projectId === "string" &&
      /^prj_[A-Za-z0-9]+$/.test(rawExpected.projectId),
    "Expected Vercel project ID is invalid",
  );
  requireCondition(
    typeof rawExpected.projectName === "string" &&
      rawExpected.projectName.length > 0,
    "Expected Vercel project name is invalid",
  );
  for (const field of ["teamId", "projectId", "projectName", "productionOrigin"]) {
    requireCondition(
      rawExpected[field] === OPENZAPS_VERCEL_RELEASE_IDENTITY[field],
      `${field} must match the canonical OpenZaps Vercel release identity`,
    );
  }
  requireCondition(
    typeof rawExpected.expectedReadEnabled === "boolean",
    "Expected read-enabled value must be a boolean",
  );
  requireCondition(
    typeof rawExpected.expectedWriteEnabled === "boolean",
    "Expected write-enabled value must be a boolean",
  );
  requireCondition(
    Number.isSafeInteger(rawExpected.launcherDeployBlock) &&
      rawExpected.launcherDeployBlock > 0,
    "Deployment-verified launcher block is invalid",
  );
  const expected = {
    ...rawExpected,
    ...OPENZAPS_VERCEL_RELEASE_IDENTITY,
    launcherAddress: normalizedAddress(
      rawExpected.launcherAddress,
      "Deployment-verified launcher address",
    ),
    launcherCodeHash: normalizedHash(
      rawExpected.launcherCodeHash,
      "Deployment-verified launcher code hash",
    ),
    deploymentVerificationEvidenceHash: normalizedHash(
      rawExpected.deploymentVerificationEvidenceHash,
      "Deployment verification evidence hash",
    ),
  };
  let productionUrl;
  try {
    productionUrl = new URL(expected.productionOrigin);
  } catch {
    fail("Expected production origin is invalid");
  }
  requireCondition(
    typeof expected.productionOrigin === "string" &&
      productionUrl.origin === expected.productionOrigin &&
      productionUrl.protocol === "https:",
    "Expected production origin is invalid",
  );
  const expectedAliasHostnames = requireArray(
    expected.productionAliases,
    "Expected production aliases",
  ).map((value, index) =>
    normalizedAlias(value, `Expected production alias ${index + 1}`),
  );
  requireCondition(
    expectedAliasHostnames.includes(productionUrl.hostname.toLowerCase()),
    "Expected production origin is not one of the expected production aliases",
  );

  const deploymentResult = verifyProjectAndDeployment(
    expected,
    project,
    deployment,
  );
  const runtimeGateResult = verifyProductionRuntimeGates(
    runtimeEnvironment,
    expected,
  );
  const configResult = verifyConfigProbe(expected, configProbe);
  const healthResult = verifyHealthProbe(expected, healthProbe);
  requireCondition(
    configResult.readEnabled === true,
    "A release-ready deployment must expose verified reads",
  );
  requireCondition(
    configResult.launchEnabled === healthResult.launchWrites.enabled,
    "/api/launch/config and /api/launch/health disagree about write activation",
  );
  const rpcResult = verifyUnsafeRpcProbe(expected, unsafeRpcProbe);
  const launcherCodeResult = verifyLauncherCodeProbe(
    expected,
    launcherCodeProbe,
    healthResult.headBlock,
  );
  const firewallResult = verifyFirewall(expected, firewall);

  return {
    project: {
      id: expected.projectId,
      name: expected.projectName,
      teamId: expected.teamId,
    },
    deployment: deploymentResult,
    productionOrigin: expected.productionOrigin,
    runtimeGates: runtimeGateResult,
    config: configResult,
    health: healthResult,
    deploymentVerification: {
      evidenceHash: expected.deploymentVerificationEvidenceHash,
      launcherAddress: expected.launcherAddress,
      deployBlock: expected.launcherDeployBlock,
      launcherCodeHash: expected.launcherCodeHash,
    },
    launcherCode: launcherCodeResult,
    unsafeRpc: rpcResult,
    firewall: firewallResult,
  };
}
