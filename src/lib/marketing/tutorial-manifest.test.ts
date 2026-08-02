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
        expect(bundle.hero).toEqual(tutorial.hero);
        expect(
          readFileSync(join(root, tutorial.hero.sourcePath)).byteLength,
        ).toBe(tutorial.hero.byteLength);

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
            campaign: `defitutorials-${tutorial.id}`,
            content: url.searchParams.get("utm_content"),
          });
        }
      }
    }
  });

  it("uses a strict public receipt when a pinned draft becomes RSS-confirmed", () => {
    const root = process.cwd();
    const rawManifest = JSON.parse(
      readFileSync(join(root, "docs", "tutorials", "manifest.json"), "utf8"),
    ) as {
      tutorials: Array<Record<string, unknown>>;
    };
    const draft = rawManifest.tutorials.find(
      (tutorial) => tutorial.status === "draft",
    );
    expect(draft).toBeDefined();

    const publicationReceipt = {
      status: "rss_confirmed",
      canonicalUrl:
        "https://defitutorials.substack.com/p/paper-trade-first-authority-map",
      publishedAt: "2026-08-02T12:00:00.000Z",
    } as const;
    const spreadTransition = {
      ...rawManifest,
      tutorials: rawManifest.tutorials.map((tutorial) =>
        tutorial === draft
          ? { ...tutorial, ...publicationReceipt }
          : tutorial
      ),
    };

    expect(
      SourceControlledTutorialManifestSchema.safeParse(spreadTransition).success,
    ).toBe(false);

    const strictTransition = {
      ...rawManifest,
      tutorials: rawManifest.tutorials.map((tutorial) =>
        tutorial === draft
          ? {
              id: tutorial.id,
              title: tutorial.title,
              sourcePath: tutorial.sourcePath,
              ...publicationReceipt,
            }
          : tutorial
      ),
    };
    const parsed = SourceControlledTutorialManifestSchema.parse(strictTransition);
    const confirmed = parsed.tutorials.find(
      (tutorial) => tutorial.id === draft?.id,
    );

    expect(confirmed).toEqual({
      id: draft?.id,
      title: draft?.title,
      sourcePath: draft?.sourcePath,
      ...publicationReceipt,
    });
  });
});
