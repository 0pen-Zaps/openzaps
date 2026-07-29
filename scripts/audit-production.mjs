#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const nextDirectory = join(root, ".next");
const allowedAdvisoryUrl =
  "https://github.com/advisories/GHSA-mh99-v99m-4gvg";
const allowedVulnerabilities = new Set([
  "@oclif/core",
  "@oclif/plugin-help",
  "@swc/cli",
  "@workflow/cli",
  "@workflow/nest",
  "brace-expansion",
  "ejs",
  "filelist",
  "jake",
  "minimatch",
  "workflow",
]);
const forbiddenRuntimeMarkers = [
  "/node_modules/@oclif/",
  "/node_modules/@swc/cli/",
  "/node_modules/@workflow/cli/",
  "/node_modules/@workflow/nest/",
  "/node_modules/ejs/",
  "/node_modules/filelist/",
  "/node_modules/jake/",
  "/node_modules/workflow/node_modules/brace-expansion/",
  "/node_modules/workflow/node_modules/minimatch/",
];

function fail(message) {
  process.stderr.write(`Production dependency audit failed: ${message}\n`);
  process.exit(1);
}

function auditProductionDependencies() {
  const result = spawnSync(
    "npm",
    ["audit", "--omit=dev", "--audit-level=high", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(
      `npm audit did not return valid JSON (exit ${result.status ?? "unknown"}).`,
    );
  }

  const vulnerabilities = report.vulnerabilities ?? {};
  const names = Object.keys(vulnerabilities);
  if (result.status === 0 && names.length === 0) {
    process.stdout.write("Production dependency audit: no findings.\n");
    return;
  }
  if (result.status !== 1) {
    fail(
      `npm audit exited unexpectedly (${result.status ?? "unknown"}): ${result.stderr.trim()}`,
    );
  }

  const unexpected = names.filter((name) => !allowedVulnerabilities.has(name));
  if (unexpected.length > 0) {
    fail(`unreviewed vulnerable packages: ${unexpected.join(", ")}.`);
  }

  const visiting = new Set();
  const reviewed = new Set();
  function reviewFinding(name) {
    if (reviewed.has(name)) return;
    if (visiting.has(name)) fail(`cyclic vulnerability graph at ${name}.`);
    const finding = vulnerabilities[name];
    if (!finding) fail(`missing transitive finding for ${name}.`);
    visiting.add(name);

    const causes = Array.isArray(finding.via) ? finding.via : [];
    if (causes.length === 0) fail(`${name} has no auditable cause.`);
    for (const cause of causes) {
      if (typeof cause === "string") {
        reviewFinding(cause);
        continue;
      }
      if (cause?.url !== allowedAdvisoryUrl) {
        fail(`${name} includes an unreviewed advisory.`);
      }
    }

    visiting.delete(name);
    reviewed.add(name);
  }

  for (const name of names) reviewFinding(name);
  if (!reviewed.has("workflow") || !reviewed.has("brace-expansion")) {
    fail("the finding set no longer matches the reviewed Workflow toolchain.");
  }

  process.stdout.write(
    `Production dependency audit: accepted only ${allowedAdvisoryUrl} in Workflow build/CLI tooling.\n`,
  );
}

function collectTraceFiles(directory, destination) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      collectTraceFiles(path, destination);
    } else if (entry.endsWith(".nft.json")) {
      destination.push(path);
    }
  }
}

function auditRuntimeTraces() {
  try {
    if (!statSync(nextDirectory).isDirectory()) {
      fail("the .next build output is missing.");
    }
  } catch {
    fail("run the production build before this audit.");
  }

  const traceFiles = [];
  collectTraceFiles(nextDirectory, traceFiles);
  if (traceFiles.length === 0) {
    fail("the production build contains no Next.js runtime traces.");
  }

  const violations = [];
  for (const traceFile of traceFiles) {
    const trace = JSON.parse(readFileSync(traceFile, "utf8"));
    const files = Array.isArray(trace.files) ? trace.files : [];
    for (const file of files) {
      const normalized = `/${String(file).split(sep).join("/")}`;
      if (forbiddenRuntimeMarkers.some((marker) => normalized.includes(marker))) {
        violations.push(
          `${relative(root, traceFile)} -> ${String(file).split(sep).join("/")}`,
        );
      }
    }
  }

  if (violations.length > 0) {
    fail(
      `reviewed build/CLI packages entered runtime traces:\n${violations.join("\n")}`,
    );
  }
  process.stdout.write(
    `Runtime trace audit: ${traceFiles.length} traces exclude the reviewed Workflow build/CLI packages.\n`,
  );
}

auditProductionDependencies();
auditRuntimeTraces();
