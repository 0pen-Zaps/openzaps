import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import {
  LAUNCHER_CODE_PROBE_ID,
  OPENZAPS_VERCEL_RELEASE_IDENTITY,
  REQUIRED_IDENTITY_PROBES,
  UNSAFE_RPC_PROBE_ID,
  verifyVercelRelease,
} from "./vercel-release-verification.mjs";

const TEAM_ID = OPENZAPS_VERCEL_RELEASE_IDENTITY.teamId;
const PROJECT_ID = OPENZAPS_VERCEL_RELEASE_IDENTITY.projectId;
const PROJECT_NAME = OPENZAPS_VERCEL_RELEASE_IDENTITY.projectName;
const GIT_ORGANIZATION =
  OPENZAPS_VERCEL_RELEASE_IDENTITY.gitOrganization;
const GIT_REPOSITORY = OPENZAPS_VERCEL_RELEASE_IDENTITY.gitRepository;
const GIT_REPOSITORY_ID =
  OPENZAPS_VERCEL_RELEASE_IDENTITY.gitRepositoryId;
const PRODUCTION_BRANCH =
  OPENZAPS_VERCEL_RELEASE_IDENTITY.productionBranch;
const RELEASE_COMMIT = "a".repeat(40);
const PRODUCTION_ALIAS = "www.0xzaps.com";
const AUTOMATIC_ALIAS = "openzaps.vercel.app";
const DEPLOYMENT_ID = "dpl_Expected123";
const PRODUCTION_ORIGIN =
  OPENZAPS_VERCEL_RELEASE_IDENTITY.productionOrigin;
const LAUNCHER_ADDRESS = "0x1000000000000000000000000000000000000001";
const LAUNCHER_DEPLOY_BLOCK = 123;
const LAUNCHER_CODE = "0x6000600055";
const LAUNCHER_CODE_HASH = keccak256(LAUNCHER_CODE);
const DEPLOYMENT_EVIDENCE_HASH = `0x${"55".repeat(32)}`;

function rateLimitRule({
  id,
  name,
  groups,
  keys = ["ip"],
  limitAction = "rate_limit",
}) {
  return {
    id,
    name,
    active: true,
    valid: true,
    validationErrors: null,
    conditionGroup: groups,
    action: {
      mitigate: {
        action: "rate_limit",
        rateLimit: {
          algo: "fixed_window",
          window: 60,
          limit: 120,
          keys,
          action: limitAction,
        },
      },
    },
  };
}

function endpointGroup(path, method) {
  return {
    conditions: [
      { type: "path", op: "eq", value: path },
      { type: "method", op: "eq", value: method },
      { type: "environment", op: "eq", value: "production" },
    ],
  };
}

function githubMetadata() {
  return {
    githubCommitOrg: GIT_ORGANIZATION,
    githubCommitRepo: GIT_REPOSITORY,
    githubOrg: GIT_ORGANIZATION,
    githubRepo: GIT_REPOSITORY,
    githubRepoId: GIT_REPOSITORY_ID,
    githubCommitRepoId: GIT_REPOSITORY_ID,
    githubCommitSha: RELEASE_COMMIT,
    githubCommitRef: PRODUCTION_BRANCH,
    githubHost: "github.com",
  };
}

function fixture() {
  const production = {
    id: DEPLOYMENT_ID,
    name: PROJECT_NAME,
    target: "production",
    readyState: "READY",
    readySubstate: "PROMOTED",
    aliasError: null,
    alias: [PRODUCTION_ALIAS, AUTOMATIC_ALIAS],
    meta: githubMetadata(),
  };
  const expectations = {
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    releaseCommit: RELEASE_COMMIT,
    productionAliases: [PRODUCTION_ALIAS, AUTOMATIC_ALIAS],
    productionOrigin: PRODUCTION_ORIGIN,
    expectedReadEnabled: true,
    expectedWriteEnabled: false,
    launcherAddress: LAUNCHER_ADDRESS,
    launcherDeployBlock: LAUNCHER_DEPLOY_BLOCK,
    launcherCodeHash: LAUNCHER_CODE_HASH,
    deploymentVerificationEvidenceHash: DEPLOYMENT_EVIDENCE_HASH,
  };
  return {
    expectations,
    project: {
      id: PROJECT_ID,
      accountId: TEAM_ID,
      name: PROJECT_NAME,
      link: {
        type: "github",
        org: GIT_ORGANIZATION,
        repo: GIT_REPOSITORY,
        repoId: Number(GIT_REPOSITORY_ID),
        productionBranch: PRODUCTION_BRANCH,
      },
      targets: { production },
    },
    deployment: {
      id: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      ownerId: TEAM_ID,
      name: PROJECT_NAME,
      target: "production",
      readyState: "READY",
      readySubstate: "PROMOTED",
      alias: [PRODUCTION_ALIAS, AUTOMATIC_ALIAS],
      gitSource: {
        type: "github",
        ref: PRODUCTION_BRANCH,
        repoId: Number(GIT_REPOSITORY_ID),
        sha: RELEASE_COMMIT,
        prId: null,
      },
      meta: githubMetadata(),
    },
    runtimeEnvironment: {
      envs: [
        {
          key: "ZAPPAD_RPC_RELAY_ENABLED",
          value: "true",
          target: ["production"],
        },
        {
          key: "ZAPPAD_RPC_DURABLE_QUOTA_ENABLED",
          value: "true",
          target: ["production"],
        },
      ],
    },
    firewall: {
      active: {
        id: "waf_active",
        version: 7,
        ownerId: TEAM_ID,
        projectKey: `${PROJECT_ID}#active`,
        firewallEnabled: true,
        rules: [
          rateLimitRule({
            id: "rule_rpc",
            name: "Rate limit ZapPad RPC",
            groups: [endpointGroup("/api/launch/rpc", "POST")],
          }),
          rateLimitRule({
            id: "rule_public_reads",
            name: "Rate limit ZapPad public reads",
            groups: [
              endpointGroup("/api/launch/config", "GET"),
              endpointGroup("/api/launch/health", "GET"),
            ],
          }),
        ],
      },
      draft: null,
      versions: [{ version: 6 }],
    },
    configProbe: {
      status: 200,
      contentType: "application/json; charset=utf-8",
      finalUrl: `${PRODUCTION_ORIGIN}/api/launch/config`,
      body: {
        launcherAddress: LAUNCHER_ADDRESS,
        deployBlock: LAUNCHER_DEPLOY_BLOCK,
        readEnabled: true,
        launchEnabled: false,
        chain: {
          id: 4_663,
          explorerUrl: "https://robinhoodchain.blockscout.com",
          rpcPath: "/api/launch/rpc",
        },
        pairedAssets: [
          {
            address: "0x2000000000000000000000000000000000000002",
            symbol: "WETH",
            decimals: 18,
          },
          {
            address: "0x3000000000000000000000000000000000000003",
            symbol: "USDG",
            decimals: 6,
          },
        ],
      },
    },
    healthProbe: {
      status: 200,
      contentType: "application/json; charset=utf-8",
      finalUrl: `${PRODUCTION_ORIGIN}/api/launch/health`,
      body: {
        status: "ok",
        rpcConfigured: true,
        chain: {
          id: 4_663,
          matches: true,
          headBlock: 1_000,
          headTimestamp: "2026-07-28T23:00:00.000Z",
          headAgeSeconds: 5,
          recent: true,
        },
        launcher: {
          configured: true,
          deployBlockConfigured: true,
          deployBlockVerified: true,
          bytecodePresent: true,
          codeHashConfigured: true,
          codeHashMatches: true,
          dependenciesVerified: true,
          dependencyCodeHashesVerified: true,
          proxyImplementationsVerified: true,
          requiredDependencyCodePresent: true,
          factoryBindingsVerified: true,
          runtimeCodeHash: LAUNCHER_CODE_HASH,
          identityProbes: [...REQUIRED_IDENTITY_PROBES],
          identityVerified: true,
        },
        launchWrites: { requested: false, enabled: false },
        latencyMs: 42,
        timestamp: "2026-07-28T23:00:05.000Z",
      },
    },
    unsafeRpcProbe: {
      status: 403,
      contentType: "application/json; charset=utf-8",
      finalUrl: `${PRODUCTION_ORIGIN}/api/launch/rpc`,
      body: {
        jsonrpc: "2.0",
        id: UNSAFE_RPC_PROBE_ID,
        error: { code: -32_601, message: "Method is not available." },
      },
    },
    launcherCodeProbe: {
      status: 200,
      contentType: "application/json; charset=utf-8",
      finalUrl: `${PRODUCTION_ORIGIN}/api/launch/rpc`,
      blockNumber: 1_000,
      body: {
        jsonrpc: "2.0",
        id: LAUNCHER_CODE_PROBE_ID,
        result: LAUNCHER_CODE,
      },
    },
  };
}

function verify(value = fixture()) {
  return verifyVercelRelease(value);
}

describe("Vercel release verification", () => {
  it("accepts one exact READY production deployment with healthy reads and published protections", () => {
    const result = verify();

    expect(result.deployment).toMatchObject({
      id: DEPLOYMENT_ID,
      gitSha: RELEASE_COMMIT,
      readyState: "READY",
      readySubstate: "PROMOTED",
      git: {
        repository: "0pen-Zaps/openzaps",
        repositoryId: GIT_REPOSITORY_ID,
        ref: PRODUCTION_BRANCH,
      },
    });
    expect(result.runtimeGates).toMatchObject({
      ZAPPAD_RPC_RELAY_ENABLED: true,
      ZAPPAD_RPC_DURABLE_QUOTA_ENABLED: true,
      target: "production",
      branch: "main",
    });
    expect(result.config).toMatchObject({
      readEnabled: true,
      launchEnabled: false,
    });
    expect(result.health.launchWrites).toEqual({
      requested: false,
      enabled: false,
    });
    expect(result.deploymentVerification).toEqual({
      evidenceHash: DEPLOYMENT_EVIDENCE_HASH,
      launcherAddress: LAUNCHER_ADDRESS.toLowerCase(),
      deployBlock: LAUNCHER_DEPLOY_BLOCK,
      launcherCodeHash: LAUNCHER_CODE_HASH,
    });
    expect(result.launcherCode).toEqual({
      address: LAUNCHER_ADDRESS.toLowerCase(),
      blockNumber: 1_000,
      codeHash: LAUNCHER_CODE_HASH,
    });
    expect(result.unsafeRpc).toEqual({
      rejected: true,
      status: 403,
      errorCode: -32_601,
    });
    expect(result.firewall.noPendingDraft).toBe(true);
    expect(result.firewall.protections).toHaveLength(3);
  });

  it.each([
    [
      "project team",
      (value) => {
        value.project.accountId = "team_Wrong123";
      },
      /project team mismatch/,
    ],
    [
      "production commit",
      (value) => {
        value.deployment.meta.githubCommitSha = "b".repeat(40);
        value.deployment.gitSource.sha = "b".repeat(40);
      },
      /Git (?:SHA does not match|source commit mismatch)/,
    ],
    [
      "deployment status",
      (value) => {
        value.deployment.readyState = "ERROR";
      },
      /not READY/,
    ],
    [
      "promotion state",
      (value) => {
        value.project.targets.production.readySubstate = "STAGED";
      },
      /not PROMOTED/,
    ],
    [
      "production alias",
      (value) => {
        value.deployment.alias = [PRODUCTION_ALIAS];
      },
      /missing expected alias/,
    ],
  ])("rejects a mismatched %s", (_label, mutate, message) => {
    const value = fixture();
    mutate(value);
    expect(() => verify(value)).toThrow(message);
  });

  it("binds the deployment to the canonical OpenZaps Git source", () => {
    let value = fixture();
    value.project.link.repo = "zappad";
    expect(() => verify(value)).toThrow(/project Git repository mismatch/);

    value = fixture();
    value.project.targets.production.meta.githubCommitOrg = "someone-else";
    expect(() => verify(value)).toThrow(/target Git repository mismatch/);

    value = fixture();
    value.deployment.gitSource.repoId += 1;
    expect(() => verify(value)).toThrow(/Git repository ID mismatch/);

    value = fixture();
    value.deployment.gitSource.ref = "preview";
    expect(() => verify(value)).toThrow(/Git ref mismatch/);
  });

  it("requires both production relay declarations without claiming to create them", () => {
    let value = fixture();
    value.runtimeEnvironment.envs = value.runtimeEnvironment.envs.filter(
      (entry) => entry.key !== "ZAPPAD_RPC_DURABLE_QUOTA_ENABLED",
    );
    expect(() => verify(value)).toThrow(
      /missing ZAPPAD_RPC_DURABLE_QUOTA_ENABLED/,
    );

    value = fixture();
    value.runtimeEnvironment.envs[0].value = "false";
    expect(() => verify(value)).toThrow(
      /ZAPPAD_RPC_RELAY_ENABLED must be exactly true/,
    );

    const result = verify();
    expect(result.runtimeGates.durableQuotaEvidence).toMatch(
      /does not create the external durable quota/,
    );
  });

  it("rejects runtime configuration and health drift", () => {
    let value = fixture();
    value.configProbe.body.launchEnabled = true;
    expect(() => verify(value)).toThrow(/launchEnabled did not match/);

    value = fixture();
    value.healthProbe.body.launcher.codeHashMatches = false;
    expect(() => verify(value)).toThrow(/codeHashMatches is not true/);

    value = fixture();
    value.healthProbe.body.launcher.runtimeCodeHash = `0x${"99".repeat(32)}`;
    expect(() => verify(value)).toThrow(
      /runtimeCodeHash does not match deployment verification evidence/,
    );

    value = fixture();
    value.healthProbe.body.launcher.identityProbes =
      REQUIRED_IDENTITY_PROBES.slice(1);
    expect(() => verify(value)).toThrow(/missing identity probe runtime code hash/);

    value = fixture();
    value.healthProbe.body.launchWrites.requested = true;
    expect(() => verify(value)).toThrow(/launchWrites.requested did not match/);
  });

  it.each([
    "dependencyCodeHashesVerified",
    "proxyImplementationsVerified",
    "requiredDependencyCodePresent",
  ])("requires health launcher.%s", (field) => {
    const value = fixture();
    value.healthProbe.body.launcher[field] = false;

    expect(() => verify(value)).toThrow(
      new RegExp(`launcher\\.${field} is not true`),
    );
  });

  it("requires every dependency identity probe", () => {
    const value = fixture();
    value.healthProbe.body.launcher.identityProbes =
      REQUIRED_IDENTITY_PROBES.filter(
        (probe) => probe !== "dependency runtime code hashes",
      );

    expect(() => verify(value)).toThrow(
      /missing identity probe dependency runtime code hashes/,
    );
  });

  it("binds runtime configuration and bytecode to deployment verification evidence", () => {
    let value = fixture();
    value.configProbe.body.launcherAddress =
      "0x9999999999999999999999999999999999999999";
    expect(() => verify(value)).toThrow(
      /launcherAddress does not match deployment verification evidence/,
    );

    value = fixture();
    value.configProbe.body.deployBlock += 1;
    expect(() => verify(value)).toThrow(
      /deployBlock does not match deployment verification evidence/,
    );

    value = fixture();
    value.launcherCodeProbe.body.result = "0x6001";
    expect(() => verify(value)).toThrow(
      /launcher code hash does not match deployment verification evidence/,
    );

    value = fixture();
    value.launcherCodeProbe.blockNumber += 1;
    expect(() => verify(value)).toThrow(/did not use the verified health block/);
  });

  it("rejects redirects and an RPC relay that accepts an unsafe method", () => {
    let value = fixture();
    value.configProbe.finalUrl = "https://login.example/api/launch/config";
    expect(() => verify(value)).toThrow(/redirected away/);

    value = fixture();
    value.unsafeRpcProbe.status = 200;
    value.unsafeRpcProbe.body = {
      jsonrpc: "2.0",
      id: UNSAFE_RPC_PROBE_ID,
      result: "0xtransaction",
    };
    expect(() => verify(value)).toThrow(/did not reject an unsafe method/);
  });

  it("requires the probed production origin to be an expected deployment alias", () => {
    const value = fixture();
    value.expectations.productionOrigin = "https://unlisted.example";

    expect(() => verify(value)).toThrow(
      /canonical OpenZaps Vercel release identity/,
    );
  });

  it("rejects missing, disabled, draft, log-only, or non-IP firewall coverage", () => {
    let value = fixture();
    value.firewall.active = null;
    expect(() => verify(value)).toThrow(/Active Vercel Firewall configuration/);

    value = fixture();
    value.firewall.draft = { id: "waf_pending" };
    expect(() => verify(value)).toThrow(/unpublished draft changes/);

    value = fixture();
    value.firewall.active.firewallEnabled = false;
    expect(() => verify(value)).toThrow(/Firewall is not enabled/);

    value = fixture();
    value.firewall.active.rules[0].action.mitigate.action = "log";
    value.firewall.active.rules[0].action.mitigate.rateLimit = null;
    expect(() => verify(value)).toThrow(/POST \/api\/launch\/rpc/);

    value = fixture();
    value.firewall.active.rules[1].action.mitigate.rateLimit.keys = ["ja4"];
    expect(() => verify(value)).toThrow(/GET \/api\/launch\/config/);
  });

  it("does not treat a conditionally restricted rate limit as full route coverage", () => {
    const value = fixture();
    value.firewall.active.rules[0].conditionGroup[0].conditions.push({
      type: "geo_country",
      op: "eq",
      value: "US",
    });

    expect(() => verify(value)).toThrow(/POST \/api\/launch\/rpc/);
  });

  it("allows an explicitly activated write-ready production release", () => {
    const value = fixture();
    value.expectations.expectedWriteEnabled = true;
    value.configProbe.body.launchEnabled = true;
    value.healthProbe.body.launchWrites = { requested: true, enabled: true };

    const result = verify(value);
    expect(result.config.launchEnabled).toBe(true);
    expect(result.health.launchWrites.enabled).toBe(true);
  });

  it("rejects a degraded configuration even when readEnabled=false was expected", () => {
    const value = fixture();
    value.expectations.expectedReadEnabled = false;
    value.configProbe.body.readEnabled = false;

    expect(() => verify(value)).toThrow(/must expose verified reads/);
  });
});
