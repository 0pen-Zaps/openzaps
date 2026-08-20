import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FEESHARE_INSTRUMENTS,
  FEESHARE_WRAP_MANIFEST,
  feeShareWrapDeployment,
} from "@/lib/feeshare-wrap";

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("fee-share wrapper surface", () => {
  const page = read("src/app/(site)/feeshare/page.tsx");
  const css = read("src/app/(site)/feeshare/feeshare.module.css");
  const shell = read("src/components/AppShell.tsx");
  const seo = read("src/lib/seo.ts");

  it("publishes one canonical route wired into nav, seo, and json-ld", () => {
    expect(page).toContain("STATIC_PAGE_SEO.feeshare");
    expect(page).toContain('breadcrumbJsonLd("/feeshare"');
    expect(seo).toContain('path: "/feeshare"');
    expect(shell).toContain('{ href: "/feeshare", label: "Fee wrappers", icon: "wrap", chip: "soon" }');
  });

  it("fails closed while the wrappers are undeployed", () => {
    // The manifest is the fail-closed switch: no deployed wrapper addresses.
    expect(FEESHARE_WRAP_MANIFEST.termWrap).toBeNull();
    expect(FEESHARE_WRAP_MANIFEST.autoCompounder).toBeNull();
    expect(feeShareWrapDeployment()).toBe("absent");
    // And the surface renders the honest not-live state from that switch.
    expect(page).toContain("feeShareWrapDeployment()");
    expect(page).toContain('deployment === "configured"');
    expect(page).toContain("Not live yet");
    expect(page).toContain("fails closed");
    expect(page).toContain("nothing to sign");
    expect(page).toContain("Source-ready · not deployed");
  });

  it("reads and signs nothing onchain in this version", () => {
    // Informational, fail-closed v1: no wallet writes, no send/broadcast paths.
    expect(page).not.toContain("eth_sendTransaction");
    expect(page).not.toContain("writeContract");
    expect(page).not.toContain('"use client"');
  });

  it("describes both instruments as mechanisms, not returns", () => {
    expect(FEESHARE_INSTRUMENTS.map((i) => i.contract)).toEqual([
      "FeeShareTermWrap",
      "FeeShareAutoCompounder",
    ]);
    for (const inst of FEESHARE_INSTRUMENTS) {
      expect(inst.points.length).toBeGreaterThan(2);
    }
    // The page renders every instrument from the manifest, not hardcoded copy.
    expect(page).toContain("FEESHARE_INSTRUMENTS.map");
    expect(page).toContain("{inst.contract}");
    expect(page).toContain("{point}");
    // The term wrap's two-epoch reward split is the audited invariant; state it.
    const term = FEESHARE_INSTRUMENTS.find((i) => i.id === "term-wrap");
    expect(term?.points.join(" ")).toContain("never to a depositor who already redeemed");
    const auto = FEESHARE_INSTRUMENTS.find((i) => i.id === "auto-compounder");
    expect(auto?.points.join(" ")).toContain("opt-in only");
  });

  it("keeps the no-yield and transaction-risk boundaries explicit", () => {
    expect(page).toContain("No yield or APR.");
    expect(page).toContain("it is not a return");
    expect(page).toContain("holding 0xZAPS earns nothing on its own");
    expect(page).toContain("transactions put funds at risk and are irreversible once confirmed");
    expect(page).toContain("irreversible once confirmed");
    expect(page).not.toMatch(/\bAPY\s*[:=]/u);
    expect(page).not.toContain("projected");
  });

  it("sizes and scales against the shell column, not the viewport", () => {
    expect(css).toContain("container-type: inline-size");
    // Only the reduced-motion query may test the viewport; every layout tier
    // measures the container. This surface uses container queries, so the
    // viewport-@media list is empty.
    const viewportQueries = css.match(/@media[^{]+/gu) ?? [];
    expect(
      viewportQueries
        .map((q) => q.trim())
        .filter((q) => q !== "@media (prefers-reduced-motion: reduce)"),
    ).toEqual([]);
    expect(css).not.toMatch(/font-size:\s*clamp\([^)]*vw/u);
    expect(css).toMatch(/font-size:\s*clamp\([^)]*cqi/u);
  });

  it("reserves the amber identity and never paints text with the brand fill", () => {
    expect(css).toContain("background: var(--warn-wash);\n  color: var(--warn-wash-ink);");
    expect(css).not.toContain("color: var(--zap)");
  });

  it("points at deployed reference addresses without claiming the wrappers are live", () => {
    expect(page).toContain("const MANIFEST = FEESHARE_WRAP_MANIFEST");
    expect(page).toContain("MANIFEST.reward.address");
    expect(page).toContain("MANIFEST.feeShareVault");
    expect(page).toContain('href="/rewards"');
    // The reference block says the wrapper addresses arrive on deploy.
    expect(page).toContain("appear here once deployed");
  });
});
