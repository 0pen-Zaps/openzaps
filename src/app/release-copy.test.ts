import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EXACT_POLICY_QUICKSTART_JSON } from "@/lib/policy-exact-example";

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("public release copy", () => {
  it("keeps live, deployed-candidate, and source-ready lineages separate", () => {
    const docs = read("src/app/(site)/docs/page.tsx");
    const llms = read("public/llms.txt");

    expect(docs).toContain("v1.1 / v3 / v3.1");
    expect(docs).toContain("Deployed candidate");
    expect(docs).toContain("Source-ready · not deployed");
    expect(llms).toContain("activation canaries pending");
    expect(llms).toContain("source-ready and undeployed");
  });

  it("exposes the practice, request, and connect entry paths", () => {
    const landing = read("src/app/(landing)/page.tsx");
    const launcher = read("src/app/(site)/zap/ZapLauncher.tsx");
    const shell = read("src/components/AppShell.tsx");
    const llms = read("public/llms.txt");

    for (const source of [landing, launcher, llms]) {
      expect(source).toContain("/virtual-trading");
      expect(source).toContain("/request-a-zap");
    }
    expect(landing).toContain("/zap?view=connect");
    expect(shell).toContain('label: "Practice"');
    expect(shell).toContain('chip: "no wallet"');
    expect(llms).toContain("five surfaces");
  });

  it("does not grant a public agent automatic monitor, alert, or revoke authority", () => {
    const metadata = JSON.parse(read("public/token-metadata.json")) as {
      project: { description: string };
    };

    expect(metadata.project.description).not.toContain("Hermes");
    expect(metadata.project.description).toContain("No agent receives wallet keys");
    expect(metadata.project.description).toContain("automatic revoke right");
  });

  it("publishes a runnable chain-exact policy Quickstart body", () => {
    const docs = read("src/app/(site)/docs/page.tsx");

    expect(docs).toContain("EXACT_POLICY_QUICKSTART_JSON");
    expect(EXACT_POLICY_QUICKSTART_JSON).toContain('"routeId": "robinhood-v4-weth-zaps"');
    expect(EXACT_POLICY_QUICKSTART_JSON).toContain('"owner": "0x0000000000000000000000000000000000000001"');
    expect(EXACT_POLICY_QUICKSTART_JSON).toContain('"amount": "0.01"');
    expect(EXACT_POLICY_QUICKSTART_JSON).toContain('"slippageBps": 150');
    expect(docs).not.toContain('"templateId": "recurring-dca"');
    expect(docs).not.toContain('"authorityModel": "deposit"');
    expect(docs).toContain("Solidity-exact policy hash");
    expect(docs).toContain("one canonical Robinhood Chain block");
    expect(docs).not.toContain("local checksum that tells two drafts apart");
    expect(docs).not.toContain("fixed rates held in this app");
  });

  it("keeps the Base bridge RPC separate from the Robinhood policy RPC", () => {
    const readme = read("README.md");

    expect(readme).toContain("`BASE_RPC_URL`");
    expect(readme).toContain("Base mainnet");
    expect(readme).toContain("`NEXT_PUBLIC_BASE_RPC_URL`");
    expect(readme).toContain("`OPENZAPS_EXACT_POLICY_RPC_URL`");
  });

  it("keeps deployed v3.2 and the current migration packet out of stale source-only checklists", () => {
    const deployments = read("docs/deployments.md");
    const capabilities = read("contracts/BASE_CAPABILITIES.md");
    const marketing = read("docs/marketing-agent.md");
    const sourceOnly = capabilities
      .split("Source-only, absent from live immutable implementations:")[1]
      ?.split("```")[0] ?? "";

    expect(deployments).toContain("[x] Confirm the seven v3.2 addresses are pinned as verified defaults");
    expect(deployments).not.toContain("[ ] Set all seven production build values");
    expect(capabilities).toContain(
      "Robinhood 4663 — deployed candidate, explorer verification and activation canaries pending:",
    );
    expect(sourceOnly).not.toContain("v3.2");
    expect(marketing).toContain("supabase/migrations/20260801143000_marketing_x_mentions.sql");
    expect(marketing).toContain("`public.marketing_x_mention_accounts`");
    expect(marketing).toContain("all eleven public X mention wrappers");
    expect(deployments).toContain(
      "[ ] Verify in a production browser that Automate exposes stacking",
    );
  });

  it("baselines DeFi Tutorials before publishing and documents the strict RSS receipt", () => {
    const marketing = read("docs/marketing-agent.md");
    const substack = marketing.split("### Substack")[1]?.split("## Deploy safely")[0]
      ?? "";
    const baseline = substack.indexOf("**Before clicking Publish**");
    const publish = substack.indexOf(
      "Publish or schedule from the official editor.",
    );

    expect(baseline).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(baseline);
    expect(substack).toContain(
      "the first snapshot must classify it as historical `baseline`",
    );
    expect(substack).toMatch(
      /the `rss_confirmed` manifest\s+branch intentionally excludes draft-only handoff fields/u,
    );
    expect(substack).toMatch(
      /The exact source\/body hashes remain fail-closed evidence in the\s+recorded approval/u,
    );
    expect(substack).not.toContain("title, and hashes; set");
  });
});
