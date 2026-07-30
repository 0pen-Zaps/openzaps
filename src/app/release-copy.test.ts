import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
});
