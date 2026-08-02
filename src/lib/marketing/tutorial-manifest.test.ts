import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SourceControlledTutorialManifestSchema,
  loadSourceControlledTutorialApprovalBundle,
} from "@/lib/marketing/tutorial-handoff-source";
import { sanitizeAnalyticsPayload } from "@/lib/analytics";

describe("DeFi Tutorials release manifest", () => {
  it("binds unique entries to source-controlled titles and truthful status fields", () => {
    const root = process.cwd();
    const manifestPath = join(root, "docs", "tutorials", "manifest.json");
    const manifest = SourceControlledTutorialManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    const ids = manifest.tutorials.map((tutorial) => tutorial.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const tutorial of manifest.tutorials) {
      expect(tutorial.sourcePath).toBe(`docs/tutorials/${tutorial.id}.md`);
      const source = readFileSync(join(root, tutorial.sourcePath), "utf8");
      const firstHeading = source.match(/^# (.+)$/mu)?.[1]?.trim();
      expect(firstHeading, tutorial.sourcePath).toBe(tutorial.title);
      if (tutorial.status !== "rss_confirmed") {
        const bundle = loadSourceControlledTutorialApprovalBundle(tutorial.id);
        expect(bundle.sourcePath).toBe(tutorial.sourcePath);
        expect(bundle.title).toBe(tutorial.title);
        expect(bundle.modelRewriteAllowed).toBe(false);

        const openZapsLinks = bundle.links
          .map((link) => new URL(link))
          .filter((url) =>
            ["0xzaps.com", "www.0xzaps.com"].includes(url.hostname),
          );
        expect(openZapsLinks.length, tutorial.sourcePath).toBeGreaterThan(0);
        for (const url of openZapsLinks) {
          expect(url.searchParams.get("utm_source"), url.toString()).toBe(
            "substack",
          );
          expect(url.searchParams.get("utm_medium"), url.toString()).toBe(
            "email",
          );
          expect(url.searchParams.get("utm_campaign"), url.toString()).toBe(
            `defitutorials-${tutorial.id}`,
          );
          expect([...url.searchParams.keys()].sort(), url.toString()).toEqual([
            "utm_campaign",
            "utm_content",
            "utm_medium",
            "utm_source",
          ]);
          expect(
            sanitizeAnalyticsPayload({
              source: url.searchParams.get("utm_source") ?? undefined,
              medium: url.searchParams.get("utm_medium") ?? undefined,
              campaign: url.searchParams.get("utm_campaign") ?? undefined,
              content: url.searchParams.get("utm_content") ?? undefined,
            }),
            url.toString(),
          ).toEqual({
            source: "substack",
            medium: "email",
            campaign: "tutorial_update",
            content: url.searchParams.get("utm_content"),
          });
        }
      }
    }
  });
});
