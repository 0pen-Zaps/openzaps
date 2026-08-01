import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER } from "./tutorial-handoff-contract";
import {
  createSourceControlledTutorialEditorHandoff,
  listSourceControlledTutorialSelections,
  loadSourceControlledTutorialApprovalBundle,
} from "./tutorial-handoff-source";

const TITLE = "Paper Trade First";
const BODY = `${"Use a virtual route and record its exact boundary. ".repeat(8)}

Pre-audit software. Verify before use.

Read https://www.0xzaps.com/docs before moving from simulation to a capped pilot.
`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function source(body = BODY, title = TITLE): string {
  return `# ${title}

**Publication:** DeFi Tutorials

${SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER}

${body}`;
}

function manifest(sourceText = source(), body = BODY): unknown {
  return {
    version: 1,
    publication: "https://defitutorials.substack.com",
    feed: "https://defitutorials.substack.com/feed",
    statusDefinitions: {
      draft: "Draft",
      approved_handoff: "Approved handoff",
      rss_confirmed: "RSS confirmed",
    },
    tutorials: [
      {
        id: "paper-trade-first",
        title: TITLE,
        subtitle: "A bounded tutorial",
        tags: ["DeFi", "OpenZaps"],
        sourcePath: "docs/tutorials/paper-trade-first.md",
        sourceSha256: sha256(sourceText),
        bodySha256: sha256(body),
        topics: ["protocol", "simulation"],
        disclosures: ["pre_audit"],
        claims: [
          {
            text: "The tutorial uses a virtual route.",
            factKeys: ["product.virtual_trading"],
            treatment: "asserted",
          },
        ],
        status: "draft",
        preparedAt: "2026-08-01",
        canonicalUrl: null,
        publishedAt: null,
      },
    ],
  };
}

function load(
  sourceText = source(),
  rawManifest: unknown = manifest(sourceText),
) {
  return loadSourceControlledTutorialApprovalBundle("paper-trade-first", {
    rootDir: "/worktree",
    manifest: rawManifest,
    readSource: () => Buffer.from(sourceText),
  });
}

describe("source-controlled Substack tutorial handoff", () => {
  it("selects the exact manifest source and returns a hash-bound approval bundle", () => {
    const bundle = load();

    expect(bundle).toMatchObject({
      channel: "substack",
      status: "requires_owner_approval",
      tutorialId: "paper-trade-first",
      sourcePath: "docs/tutorials/paper-trade-first.md",
      title: TITLE,
      subtitle: "A bounded tutorial",
      tags: ["DeFi", "OpenZaps"],
      bodyMarkdown: BODY,
      links: ["https://www.0xzaps.com/docs"],
      modelRewriteAllowed: false,
      apiWriteAttempted: false,
      privateEndpointUsed: false,
      approval: {
        required: true,
        decision: "pending",
        scope: "exact_source_and_body_sha256",
        tutorialId: "paper-trade-first",
      },
    });
    expect(bundle.sourceSha256).toBe(sha256(source()));
    expect(bundle.bodySha256).toBe(sha256(BODY));
    expect(bundle.approval.sourceSha256).toBe(bundle.sourceSha256);
    expect(bundle.approval.bodySha256).toBe(bundle.bodySha256);
  });

  it("lists only byte-verified handoff selections without exposing body copy", () => {
    expect(
      listSourceControlledTutorialSelections({
        rootDir: "/worktree",
        manifest: manifest(),
        readSource: () => Buffer.from(source()),
      }),
    ).toEqual([
      {
        tutorialId: "paper-trade-first",
        title: TITLE,
        manifestStatus: "draft",
        sourcePath: "docs/tutorials/paper-trade-first.md",
        sourceSha256: sha256(source()),
        bodySha256: sha256(BODY),
      },
    ]);
  });

  it("fails closed on source-byte, body, title, marker, and outbound-link drift", () => {
    expect(() => load(`${source()}changed\n`, manifest(source()))).toThrow(
      "source hash does not match",
    );

    const changedBody = `${BODY}One more reviewed sentence.\n`;
    expect(() =>
      load(source(changedBody), manifest(source(changedBody), BODY)),
    ).toThrow("editor body hash does not match");

    const wrongTitle = source(BODY, "Different title");
    expect(() => load(wrongTitle, manifest(wrongTitle))).toThrow(
      "source title does not match",
    );

    const missingMarker = source().replace(
      `${SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER}\n\n`,
      "",
    );
    expect(() => load(missingMarker, manifest(missingMarker))).toThrow(
      "exactly one editor-body marker",
    );

    const externalBody = `${BODY}https://attacker.example/tutorial\n`;
    expect(() =>
      load(
        source(externalBody),
        manifest(source(externalBody), externalBody),
      ),
    ).toThrow("non-canonical outbound link");
  });

  it("requires approval of both exact hashes and revalidates before handoff", () => {
    const bundle = load();
    const approval = {
      decision: "approve" as const,
      approvedBy: "owner",
      tutorialId: bundle.tutorialId,
      sourceSha256: bundle.sourceSha256,
      bodySha256: bundle.bodySha256,
    };

    expect(() =>
      createSourceControlledTutorialEditorHandoff(
        bundle,
        { ...approval, bodySha256: "0".repeat(64) },
        "tutorial:paper-trade-first",
        {
          rootDir: "/worktree",
          manifest: manifest(),
          readSource: () => Buffer.from(source()),
        },
      ),
    ).toThrow("approval does not match");

    expect(() =>
      createSourceControlledTutorialEditorHandoff(
        bundle,
        approval,
        "tutorial:paper-trade-first",
        {
          rootDir: "/worktree",
          manifest: manifest(),
          readSource: () => Buffer.from(`${source()}changed\n`),
        },
      ),
    ).toThrow("source hash does not match");
  });

  it("creates only a copy-ready official-editor package after exact approval", () => {
    const bundle = load();
    const handoff = createSourceControlledTutorialEditorHandoff(
      bundle,
      {
        decision: "approve",
        approvedBy: "owner",
        tutorialId: bundle.tutorialId,
        sourceSha256: bundle.sourceSha256,
        bodySha256: bundle.bodySha256,
      },
      "tutorial:paper-trade-first",
      {
        rootDir: "/worktree",
        manifest: manifest(),
        readSource: () => Buffer.from(source()),
      },
    );

    expect(handoff).toMatchObject({
      status: "requires-human-publish",
      editorUrl: "https://defitutorials.substack.com/publish/post",
      apiWriteAttempted: false,
      privateEndpointUsed: false,
      draft: {
        title: TITLE,
        bodyMarkdown: BODY,
      },
      source: {
        tutorialId: "paper-trade-first",
        sourceSha256: bundle.sourceSha256,
        bodySha256: bundle.bodySha256,
        modelRewriteAllowed: false,
      },
      approval: {
        decision: "approve",
        approvedBy: "owner",
      },
    });
  });

  it("rejects already-published entries instead of preparing duplicates", () => {
    const raw = manifest() as {
      tutorials: Array<Record<string, unknown>>;
    };
    raw.tutorials[0] = {
      id: "paper-trade-first",
      title: TITLE,
      sourcePath: "docs/tutorials/paper-trade-first.md",
      status: "rss_confirmed",
      canonicalUrl: "https://defitutorials.substack.com/p/paper-trade-first",
      publishedAt: "2026-08-01T12:00:00.000Z",
    };

    expect(() => load(source(), raw)).toThrow(
      "RSS-confirmed tutorial cannot be prepared",
    );
  });
});
