import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const tutorialBase = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    title: z.string().trim().min(1).max(200),
    sourcePath: z
      .string()
      .regex(/^docs\/tutorials\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u),
  })
  .strict();

const tutorialManifestSchema = z
  .object({
    version: z.literal(1),
    publication: z.literal("https://defitutorials.substack.com"),
    feed: z.literal("https://defitutorials.substack.com/feed"),
    statusDefinitions: z
      .object({
        draft: z.string().min(1),
        approved_handoff: z.string().min(1),
        rss_confirmed: z.string().min(1),
      })
      .strict(),
    tutorials: z
      .array(
        z.discriminatedUnion("status", [
          tutorialBase.extend({
            status: z.literal("draft"),
            preparedAt: z.iso.date(),
            canonicalUrl: z.null(),
            publishedAt: z.null(),
          }),
          tutorialBase.extend({
            status: z.literal("approved_handoff"),
            preparedAt: z.iso.date(),
            canonicalUrl: z.null(),
            publishedAt: z.null(),
          }),
          tutorialBase.extend({
            status: z.literal("rss_confirmed"),
            canonicalUrl: z
              .url()
              .regex(
                /^https:\/\/defitutorials\.substack\.com\/p\/[a-z0-9]+(?:-[a-z0-9]+)*$/u,
              ),
            publishedAt: z.iso.datetime(),
          }),
        ]),
      )
      .min(1),
  })
  .strict();

describe("DeFi Tutorials release manifest", () => {
  it("binds unique entries to source-controlled titles and truthful status fields", () => {
    const root = process.cwd();
    const manifestPath = join(root, "docs", "tutorials", "manifest.json");
    const manifest = tutorialManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    const ids = manifest.tutorials.map((tutorial) => tutorial.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const tutorial of manifest.tutorials) {
      expect(tutorial.sourcePath).toBe(`docs/tutorials/${tutorial.id}.md`);
      const sourcePath = join(root, tutorial.sourcePath);
      expect(existsSync(sourcePath), tutorial.sourcePath).toBe(true);

      const source = readFileSync(sourcePath, "utf8");
      const firstHeading = source.match(/^# (.+)$/mu)?.[1]?.trim();
      expect(firstHeading, tutorial.sourcePath).toBe(tutorial.title);
      expect(basename(tutorial.sourcePath, ".md")).toBe(tutorial.id);
    }
  });
});
