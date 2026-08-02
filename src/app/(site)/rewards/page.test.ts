import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("0xZAPS fee rewards public surface", () => {
  const page = read("src/app/(site)/rewards/page.tsx");
  const workspace = read("src/app/(site)/rewards/RewardsWorkspace.tsx");
  const shell = read("src/components/AppShell.tsx");
  const seo = read("src/lib/seo.ts");

  it("publishes one canonical route with earn, operate, and proof workspaces", () => {
    expect(page).toContain("STATIC_PAGE_SEO.rewards");
    expect(page).toContain('breadcrumbJsonLd("/rewards"');
    expect(workspace).toContain('id: "earn"');
    expect(workspace).toContain('id: "operate"');
    expect(workspace).toContain('id: "proof"');
    expect(shell).toContain('{ href: "/rewards", label: "Fee rewards"');
    expect(seo).toContain('path: "/rewards"');
  });

  it("keeps the reward source and wallet boundary explicit", () => {
    expect(workspace).toContain("never asks for or spends the sponsor&apos;s WETH");
    expect(workspace).toContain("Stakers supply only 0xZAPS principal and gas");
    expect(workspace).toContain("This UI never asks for wallet WETH");
    expect(workspace).toContain("can also account for WETH already sent directly to it");
    expect(workspace).not.toContain("approve(FEE_REWARDS_MANIFEST.weth");
    expect(workspace).not.toContain("transferFrom(FEE_REWARDS_MANIFEST.weth");
  });

  it("fails closed for writes when the verified snapshot becomes stale", () => {
    expect(workspace).toContain('const writesEnabled = state.status === "ready" && state.staleSince === null');
    expect(workspace).toContain("A fresh verified campaign snapshot is required before any transaction can be prepared");
    expect(workspace).toContain("every transaction is paused until verification recovers");
    expect(workspace).toContain("!props.writesEnabled");
    expect(workspace).toContain("!writesEnabled");
  });

  it("exposes only fixed manifest targets and exact contract methods", () => {
    expect(workspace).toContain("FEE_REWARDS_MANIFEST.campaign.address");
    expect(workspace).toContain("FEE_REWARDS_MANIFEST.vault.address");
    expect(workspace).toContain("FEE_REWARDS_MANIFEST.token");
    expect(workspace).not.toContain("eth_sendTransaction");
    expect(workspace).not.toContain("targetAddress");
    for (const method of [
      'functionName: "stakeWithPermit"',
      'functionName: "stake"',
      'functionName: all ? "exit" : "withdraw"',
      'functionName: "claimFor"',
    ]) {
      expect(workspace).toContain(method);
    }
  });

  it("does not market projected returns or unsupported reward programs", () => {
    expect(workspace).not.toMatch(/\bAPY\s*[:=]/u);
    expect(workspace).not.toContain("projected WETH");
    expect(workspace).toContain("No APY projection");
    expect(workspace).toContain("top-holder bonus");
    expect(workspace).toContain("volume leaderboard");
  });
});
