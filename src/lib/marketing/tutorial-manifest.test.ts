import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SourceControlledTutorialManifestSchema,
  loadSourceControlledTutorialApprovalBundle,
} from "@/lib/marketing/tutorial-handoff-source";

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
      }
    }
  });
});
