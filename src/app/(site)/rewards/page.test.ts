import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FEE_REWARDS_MANIFEST, type FeeRewardsPayload } from "@/lib/rewards";
import {
  rewardsBalanceLabel,
  rewardsClaimLifecycle,
  snapshotIncludesBlock,
  sponsoredClaimReady,
} from "./RewardsWorkspace";

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("0xZAPS fee rewards public surface", () => {
  const page = read("src/app/(site)/rewards/page.tsx");
  const workspace = read("src/app/(site)/rewards/RewardsWorkspace.tsx");
  const shell = read("src/components/AppShell.tsx");
  const seo = read("src/lib/seo.ts");
  const tokenPage = read("src/app/(site)/token/page.tsx");
  const tokenPanel = read("src/components/TokenUtilityPanel.tsx");
  const potPage = read("src/app/(site)/pot/page.tsx");
  const solderworksPage = read("src/app/(site)/solderworks/page.tsx");
  const readme = read("README.md");
  const llms = read("public/llms.txt");

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

  it("keeps transaction risk visible beside the Earn actions", () => {
    expect(workspace).toContain("These contracts have not been externally audited");
    expect(workspace).toContain("transactions put funds at risk and are irreversible once confirmed");
    expect(workspace).toContain("Withdrawals are governed by contract state");
    expect(workspace).toContain("Unclaimed rewards expire at the claim deadline");
    expect(workspace).toContain('aria-describedby="rewards-transaction-risk"');
    expect(workspace).not.toContain("Principal stays withdrawable");
  });

  it("labels expired and swept accruals honestly and closes sponsored claims", () => {
    const deadline = FEE_REWARDS_MANIFEST.campaign.claimDeadline;

    expect(rewardsClaimLifecycle(deadline, false)).toBe("open");
    expect(rewardsBalanceLabel("open")).toBe("Claimable now");

    expect(rewardsClaimLifecycle(deadline + 1n, false)).toBe("expired");
    expect(rewardsBalanceLabel("expired")).toBe("Accrued — claim expired");
    expect(sponsoredClaimReady("expired", "expired", 10n ** 30n, true)).toBe(false);

    expect(rewardsClaimLifecycle(deadline, true)).toBe("swept");
    expect(rewardsBalanceLabel("swept")).toBe("Accrued — rewards swept");
    expect(sponsoredClaimReady("swept", "open", 10n ** 30n, true)).toBe(false);
    expect(sponsoredClaimReady("open", "swept", 10n ** 30n, true)).toBe(false);
    expect(sponsoredClaimReady("open", "open", 1n, true)).toBe(true);
  });

  it("refreshes public snapshots once per minute", () => {
    expect(workspace).toContain("60_000");
    expect(workspace).not.toContain("30_000");
  });

  it("retries a transient shared-cache refresh without accepting non-data as a snapshot", () => {
    expect(workspace).toContain("SNAPSHOT_REFRESH_RETRY_ATTEMPTS = 2");
    expect(workspace).toContain("response.status === 202");
    expect(workspace).toContain("response.status !== 200");
  });

  it("keeps writes paused until a post-transaction snapshot reaches the receipt block", () => {
    const snapshot = { headBlock: "101" } as FeeRewardsPayload;
    expect(snapshotIncludesBlock(snapshot, 100n)).toBe(true);
    expect(snapshotIncludesBlock(snapshot, 101n)).toBe(true);
    expect(snapshotIncludesBlock(snapshot, 102n)).toBe(false);
    expect(workspace).toContain("POST_RECEIPT_REFRESH_ATTEMPTS");
    expect(workspace).toContain("receipt.blockNumber");
    expect(workspace).toContain("further writes are paused while it catches up");
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

  it("keeps permanent token surfaces safe across campaign lifecycle phases", () => {
    expect(tokenPanel).toContain("Inspect the first fixed fee campaign");
    expect(tokenPanel).toContain("seven-day Aug 3–10, 2026");
    expect(tokenPage).toContain("first 0xZAPS fee rewards campaign");
    expect(tokenPage).toContain("Check the current phase on /rewards");
    expect(tokenPage).toContain("50 of 100 tokenized Clanker fee shares");
    expect(tokenPanel).not.toContain("Opt into one fixed fee campaign");
    expect(tokenPage).not.toContain("A fixed fee campaign accepts it as stake");
    expect(tokenPage).not.toContain("Every item below is live right now");
    expect(seo).not.toContain("Stake 0xZAPS in a fixed seven-day campaign and claim");
    for (const source of [tokenPanel, tokenPage, potPage, solderworksPage, readme, llms, workspace]) {
      expect(source).not.toMatch(/campaign (?:contract )?holds 50/iu);
      expect(source).not.toMatch(/campaign (?:distributes|benefits|accepts) /iu);
    }
  });
});
