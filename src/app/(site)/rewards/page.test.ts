import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FEE_REWARDS_MANIFEST, campaignPhaseNote, type FeeRewardsPayload } from "@/lib/rewards";
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
  const countdownHook = read("src/components/useCampaignCountdown.ts");
  const campaignStrip = read("src/app/(landing)/CampaignStrip.tsx");
  const landingPage = read("src/app/(landing)/page.tsx");
  const shell = read("src/components/AppShell.tsx");
  const seo = read("src/lib/seo.ts");
  const tokenPage = read("src/app/(site)/token/page.tsx");
  const tokenPanel = read("src/components/TokenUtilityPanel.tsx");
  const potPage = read("src/app/(site)/pot/page.tsx");
  const solderworksPage = read("src/app/(site)/solderworks/page.tsx");
  const readme = read("README.md");
  const llms = read("public/llms.txt");

  it("publishes one canonical route with earn, stakers, operate, and proof workspaces", () => {
    expect(page).toContain("STATIC_PAGE_SEO.rewards");
    expect(page).toContain('breadcrumbJsonLd("/rewards"');
    expect(workspace).toContain('id: "earn"');
    expect(workspace).toContain('id: "stakers"');
    expect(workspace).toContain('id: "operate"');
    expect(workspace).toContain('id: "proof"');
    expect(page).toContain('candidate === "stakers"');
    expect(shell).toContain('{ href: "/rewards", label: "Fee rewards"');
    expect(seo).toContain('path: "/rewards"');
  });

  it("keeps the staker register complete-or-absent, never partial", () => {
    const stakersLib = read("src/lib/rewards-stakers.ts");
    const stakersServer = read("src/lib/rewards-stakers-server.ts");
    const stakersRoute = read("src/app/api/protocol/rewards/stakers/route.ts");
    // The two accounting invariants are the register's honesty: enumerated
    // balances must sum exactly to the campaign's totalStaked, and a paid
    // claim from outside the enumeration proves the scan is incomplete.
    expect(stakersLib).toContain("balanceSum !== totalStaked");
    expect(stakersLib).toContain("does not reconcile");
    expect(stakersLib).toContain("missing from the staker enumeration");
    // Enumeration past the complete-read bound fails closed, never samples.
    expect(stakersServer).toContain("exceeds this snapshot's complete-read bound");
    expect(stakersServer).toContain("changed during the staker-list read");
    // The route never converts a failed enumeration into an empty list.
    expect(stakersRoute).toContain("unavailable right now");
    expect(stakersRoute).toContain('"cache-control": "no-store, max-age=0"');
    // The UI names the failure state and retries; it never renders zeros.
    expect(workspace).toContain("The staker list is unavailable.");
    expect(workspace).toContain("no partial or zeroed list is shown");
    expect(workspace).toContain("STAKERS_REFRESH_MS = 60_000");
    // The share columns are state at the verified block, not a forecast, and
    // the weight column is named as the figure rewards actually split by.
    expect(workspace).toContain("the share rewards actually split by");
    expect(workspace).toContain("balances reconcile exactly");
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
    expect(workspace).toContain("window.setInterval(() => void load(account), 60_000)");
  });

  it("counts down to verified boundaries without flipping phase from the local clock", () => {
    // The countdown estimates from the verified block timestamp plus a local
    // monotonic delta; at zero it defers to the chain rather than declaring
    // the phase.
    expect(countdownHook).toContain("BigInt(data.blockTimestamp) + elapsed");
    expect(countdownHook).toContain("performance.now()");
    expect(countdownHook).not.toContain("Date.now()");
    expect(workspace).toContain("awaiting the next verified block");
    // Per-second ticking is cinematic-only; calm motion updates by the minute.
    expect(countdownHook).toContain("COUNTDOWN_CALM_TICK_MS = 30_000");
    expect(workspace).toContain('formatCountdown(remaining, reduced ? "minute" : "second")');
  });

  it("keeps boundary polling gated, bounded, and at the reviewed cadence", () => {
    // Pin the gate and the usage, not just declarations: deleting the reached
    // gate or hardcoding a faster interval must fail this test.
    expect(countdownHook).toContain("if (!reached) return;");
    expect(countdownHook).toContain("boundaryPollMs * (0.9 + Math.random() * 0.2)");
    expect(countdownHook).toContain("}, jitteredPollMs);");
    expect(countdownHook).toContain("if (!document.hidden) onResync();");
    expect(countdownHook).toContain("if (polls > COUNTDOWN_FAST_POLL_LIMIT && polls % slowEvery !== 0) return;");
    expect(countdownHook).toContain("if (document.hidden) return;");
    expect(countdownHook).toContain("COUNTDOWN_FAST_POLL_LIMIT = 18");
    expect(countdownHook).toContain("COUNTDOWN_SLOW_POLL_MS = 60_000");
    expect(workspace).toContain("COUNTDOWN_BOUNDARY_POLL_MS = 10_000");
    expect(workspace).toContain("COUNTDOWN_BOUNDARY_POLL_MS,");
  });

  it("fails the landing campaign strip closed and keeps it honest", () => {
    // The landing page is static: the strip renders nothing until a verified
    // snapshot confirms a clock-bound phase, and never invents live claims.
    expect(campaignStrip).toContain("if (!data || !countdown) return null;");
    expect(campaignStrip).toContain('response.status === 200');
    expect(campaignStrip).toContain('href="/rewards');
    expect(campaignStrip).toContain("confirming onchain");
    // The rewards app closes new stakes in claim-only, so the CTA must not
    // advertise staking there.
    expect(campaignStrip).toContain('data.phase === "claim-only" ? "Claim & inspect →" : "Stake & inspect →"');
    expect(landingPage).toContain("<CampaignStrip />");
  });

  it("keeps countdown motion module-scoped, gated, and derived from verified time", () => {
    const rollingCss = read("src/components/RollingDigits.module.css");
    const rewardsCss = read("src/app/(site)/rewards/rewards.module.css");
    // Turbopack scopes animation-name per CSS module: keyframes must live in
    // the same file as the rules that reference them or they silently never
    // apply.
    expect(rollingCss).toContain("@keyframes rollIn");
    expect(rollingCss).toContain("@keyframes rollOut");
    expect(rewardsCss).toContain("@keyframes railFlow");
    // Calm motion never builds the animated stacks at all.
    expect(workspace).toContain("animate={!reduced}");
    expect(campaignStrip).toContain("animate={!reduced}");
    // The rail pulse asserts a live settlement path, so it only runs verified;
    // its keyframes must restate the arrow's centering, which a CSS animation
    // otherwise replaces wholesale.
    expect(workspace).toContain("data-flow={verified || undefined}");
    expect(rewardsCss).toContain("transform: translateY(-50%) translateX(");
    // The timeline fill derives from the same verified-block estimate as the
    // countdown, never the wall clock alone — and animates transform only.
    // The timeline reads the verified block timestamp directly — it is not
    // derived from the countdown, so it survives the phases that have no
    // clock target (settlement-pending, expired) instead of vanishing.
    expect(workspace).toContain("estimatedNow={BigInt(data.blockTimestamp)}");
    expect(workspace).toContain("scaleX(");
    expect(rewardsCss).not.toContain("transition: width");
  });

  it("keeps the odometer's animation out of the document text layer", () => {
    const rolling = read("src/components/RollingDigits.tsx");
    const rollingCss = read("src/components/RollingDigits.module.css");
    // One visually hidden plain-text run is the sole source for screen
    // readers, selection, copy, and find-in-page; the visual cells are
    // aria-hidden, unselectable, and render every glyph as pseudo-element
    // content so stale outgoing digits can never leak into copied text.
    expect(rolling).toContain("styles.srOnly");
    expect(rolling).toContain('aria-hidden="true"');
    expect(rollingCss).toContain("user-select: none");
    expect(rollingCss).toContain("content: attr(data-char)");
    expect(rollingCss).toContain("content: attr(data-prev)");
  });

  it("routes the explainer's scroll through the motion preference", () => {
    // Smooth scrolling is a motion source like any animation: calm mode must
    // jump rather than glide.
    expect(workspace).toContain('behavior: reducedMotion ? "auto" : "smooth"');
  });

  it("states the settlement path once, not twice", () => {
    // The rail diagram and the five-step narration describe the same
    // pipeline; the rail renders inside the explainer rather than as a
    // second stacked card above it.
    expect(workspace).toContain("<SettlementRail data={data} />");
    expect(workspace.match(/<SettlementRail /gu)?.length).toBe(1);
    expect(workspace).not.toContain("THE SETTLEMENT RAIL");
  });

  it("keeps every campaign phase legible and never advertises a closed action", () => {
    // Each phase states what is true and who may act; a phase word alone does
    // not tell a reader whether their funds are stuck.
    for (const phase of [
      "unfunded",
      "upcoming",
      "active",
      "settlement-pending",
      "claim-only",
      "expired",
    ] as const) {
      expect(campaignPhaseNote(phase).length, phase).toBeGreaterThan(20);
    }
    expect(campaignPhaseNote("settlement-pending")).toContain("Anyone can call finalize");
    expect(campaignPhaseNote("expired")).toContain("deadline has passed");
    // The closing cell must not invite staking once the window has closed, or
    // claiming once the deadline has passed.
    expect(workspace).toContain('data.phase === "upcoming" || data.phase === "active"');
    expect(workspace).toContain('label: "Stake & claim"');
    expect(workspace).toContain('label: "Claim & withdraw"');
    expect(workspace).toContain('label: "View your position"');
    // Past the deadline the claim fact reports closure rather than inviting.
    expect(workspace).toContain("Claims closed");
  });

  it("sizes its layout against the shell column, not the viewport", () => {
    // AppShell puts a 264px rail beside this page and caps the column at
    // 1128px, so a viewport query fires ~316px early — the step grid went
    // 3-up inside a 764px box. Only the reduced-motion query may test the
    // viewport; every layout tier measures the container.
    const rewardsCss = read("src/app/(site)/rewards/rewards.module.css");
    expect(rewardsCss).toContain("container-type: inline-size");
    const viewportQueries = rewardsCss.match(/@media[^{]+/gu) ?? [];
    expect(viewportQueries.map((q) => q.trim())).toEqual([
      "@media (prefers-reduced-motion: reduce)",
    ]);
  });

  it("scales type against the column, not the viewport", () => {
    // A vw-scaled clamp inside this container grew the type as its column
    // narrowed: a 47px display serif over six lines in a 253px column.
    const rewardsCss = read("src/app/(site)/rewards/rewards.module.css");
    expect(rewardsCss).not.toMatch(/font-size:\s*clamp\([^)]*vw/u);
    expect(rewardsCss).toMatch(/font-size:\s*clamp\([^)]*cqi/u);
  });

  it("tells the reader why an upkeep control is unavailable", () => {
    // Checkpoint already named its boundary; harvest and sync described an
    // action the contract refuses.
    expect(workspace).toContain("upkeepClosedNote");
    expect(workspace).toContain('"Available at campaign start"');
    expect(workspace).toContain('"Closed with the campaign window"');
  });

  it("keeps risk copy readable and reserves the alarm styling for blocked actions", () => {
    // --warn text on --warn-wash is 4.43:1 on Ivory. Warning copy uses the
    // shared --warn-wash-ink, which keeps the amber identity and clears AA on
    // every theme (enforced app-wide in theme-tokens.test.ts).
    const rewardsCss = read("src/app/(site)/rewards/rewards.module.css");
    expect(rewardsCss).toContain("background: var(--warn-wash);\n  color: var(--warn-wash-ink);");
    expect(rewardsCss).not.toMatch(/background: var\(--warn-wash\);\n\s*color: var\(--warn\);/u);
    expect(rewardsCss).toContain(".openNote {");
    // A positive, open state must not wear the same amber as a closed one.
    expect(workspace).toContain("styles.openNote}>Pre-staking is open");
  });

  it("reports campaign holdings from the live principal, not a latched flag", () => {
    // feeSharesFunded latches true forever; settlement returns the shares.
    expect(workspace).toContain("BigInt(data.campaign.feeSharePrincipal) > 0n");
    expect(workspace).toContain("shares returned to sponsor");
    expect(workspace).toContain('holdsShares ? "50 shares" : "settled"');
    // Before the window opens, harvest reverts — so no zero is reported as a
    // shortfall against an action the contract refuses.
    expect(workspace).toContain("Harvest opens");
  });

  it("never paints text with the brand fill token", () => {
    // --zap is the brand FILL. As a text colour it measures 1.10:1 against
    // --panel on the Ivory and Paper themes — invisible. Accent text uses
    // --link (>=4.5:1 on every theme) or --ink.
    const rewardsCss = read("src/app/(site)/rewards/rewards.module.css");
    expect(rewardsCss).not.toContain("color: var(--zap)");
  });

  it("explains the fee path with evidence-anchored steps and a stated boundary", () => {
    // The explainer may only cite manifest constants or live verified reads,
    // and the boundary block is part of the section, not an optional footnote.
    expect(workspace).toContain("HOW THE FEES REACH A STAKER");
    expect(workspace).toContain("{HOOK_FEE_LABEL}</b> hook fee, read live");
    expect(workspace).toContain("What this campaign does not promise");
    expect(workspace).toContain("No yield or APR.");
    // The terms panel states a fee-capture rate, so the boundary must say
    // explicitly that it is not a return.
    expect(workspace).toContain("not a return");
    expect(workspace).toContain("Holding 0xZAPS earns nothing.");
    // The share readout is a statement about principal, never a forecast.
    expect(workspace).toContain("Share of staked principal");
    expect(workspace).toContain("projectedPrincipalShare");
    expect(workspace).toContain("Rewards are time-weighted");
  });

  it("coalesces concurrent shared-snapshot fills per instance", () => {
    // unstable_cache has no MISS coalescing and the cache key rotates every
    // deploy; without this funnel, landing traffic during a deploy becomes an
    // RPC herd of parallel full-snapshot reads.
    const server = read("src/lib/rewards-server.ts");
    expect(server).toContain("let inflightPublicSnapshot");
    expect(server).toContain("await coalescedPublicFeeRewards()");
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
